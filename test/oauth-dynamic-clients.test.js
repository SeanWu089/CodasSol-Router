import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  OAuthDynamicClients, normalizePublicClientMetadata
} from "../src/ingress/oauth-dynamic-clients.js";
import { PublicOAuthPkceGrants } from "../src/ingress/public-oauth-pkce.js";
import { OAuthApprovalCodes } from "../src/ingress/oauth-approval-codes.js";
import { LocalRefreshAuthority } from "../src/ingress/local-refresh-authority.js";
import { RefreshTokenRotation } from "../src/ingress/refresh-token-rotation.js";
import { createPublicMcpAccess } from "../src/ingress/public-mcp-access.js";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";

const issuer = "https://fixed-codas.example.test";
const callback = "https://chatgpt.com/oauth/callback";
const resource = issuer + "/mcp";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

test("DCR metadata rejects unsafe callbacks and confidential clients", () => {
  const valid = {
    client_name: "ChatGPT",
    redirect_uris: [callback],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none"
  };
  assert.deepEqual(normalizePublicClientMetadata(valid).redirect_uris, [callback]);
  for (const invalid of [
    { ...valid, redirect_uris: ["http://attacker.example.test/cb"] },
    { ...valid, redirect_uris: ["https://u:p@attacker.example.test/cb"] },
    { ...valid, redirect_uris: [callback + "#fragment"] },
    { ...valid, redirect_uris: [callback, callback] },
    { ...valid, token_endpoint_auth_method: "client_secret_basic" },
    { ...valid, grant_types: ["password"] },
    { ...valid, grant_types: ["refresh_token"] },
    { ...valid, response_types: ["token"] },
    { ...valid, response_types: [] },
    { ...valid, client_name: "<unsafe>\n" }
  ]) {
    assert.throws(() => normalizePublicClientMetadata(invalid),
      { code: "invalid_client_metadata" });
  }
});

test("dynamic registered client persists and is discoverable by independent Router on same test state", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codas-oauth-dcr-"));
  const backend = http.createServer((_req, res) => res.end("ok"));
  const backendPort = await listen(backend);
  let router;
  try {
    const keys = generateKeyPairSync("ed25519");
    const clients = new OAuthDynamicClients({ stateDir: temp });
    const config = {
      listenHost: "127.0.0.1", listenPort: 0,
      backendHost: "127.0.0.1", backendPort, backendTimeoutMs: 1000,
      stateDir: path.join(temp, "router"),
      localDeviceId: "mac", localDeviceLabel: "mac", localRoots: ["/tmp"]
    };
    const runtime = await createRouterRuntime(config, {
      publicAuth: createPublicMcpAccess({
        issuer, trustedKeys: new Map([["issuer-key:v1", keys.publicKey]]),
        revocationsUpdatedAt: Date.now()
      })
    });
    runtime.publicOauth = new PublicOAuthPkceGrants({
      issuer, keyId: "issuer-key:v1", privateKey: keys.privateKey,
      registeredClients: new Map(),
      dynamicClientRegistry: clients,
      refreshRotation: new RefreshTokenRotation({
        authority: new LocalRefreshAuthority({
          filePath: path.join(temp, "refresh.json")
        })
      })
    });
    runtime.publicOauthApproval = new OAuthApprovalCodes({ stateDir: temp });
    router = createRouterServer(config, runtime);
    const port = await listen(router);
    const base = `http://127.0.0.1:${port}`;
    const discovery = await fetch(base + "/.well-known/oauth-authorization-server");
    assert.equal((await discovery.json()).registration_endpoint,
      issuer + "/register");
    const metadata = {
      client_name: "ChatGPT",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    };
    const registration = await fetch(base + "/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(metadata)
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json();
    assert.ok(registered.client_id.startsWith("codassol-"));
    assert.equal(registered.client_secret, undefined);
    assert.deepEqual(registered.redirect_uris, [callback]);
    assert.equal((await fetch(base + "/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(metadata)
    })).status, 429, "persisted admission control");

    // A second registry instance reads the same (single-machine) durable
    // file. This does NOT prove physical cross-host synchronization.
    const recovered = new OAuthDynamicClients({ stateDir: temp });
    assert.equal((await recovered.snapshot())[0].clientId, registered.client_id);

    const verifier = "A".repeat(60);
    const params = new URLSearchParams({
      client_id: registered.client_id, redirect_uri: callback,
      response_type: "code", scope: "mcp:invoke",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource, state: "opaque-client-state"
    });
    assert.equal((await fetch(base + "/authorize?" + params)).status, 200);
    const ownerCode = await runtime.publicOauthApproval.issue();
    const consent = await fetch(base + "/authorize", {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...Object.fromEntries(params), owner_code: ownerCode,
        decision: "approve"
      })
    });
    assert.equal(consent.status, 303);
    const code = new URL(consent.headers.get("location")).searchParams.get("code");
    const exchange = await fetch(base + "/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registered.client_id, redirect_uri: callback,
        code, code_verifier: verifier, resource
      })
    });
    assert.equal(exchange.status, 200);
    const tokens = await exchange.json();
    assert.equal(runtime.publicAuth.authenticate(tokens.access_token).subject,
      "owner");
    assert.equal(tokens.refresh_token.length, 64);
  } finally {
    if (router) {
      router.closeAllConnections();
      await new Promise((resolve) => router.close(resolve));
    }
    await new Promise((resolve) => backend.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
