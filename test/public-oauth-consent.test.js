import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";
import { createPublicMcpAccess } from "../src/ingress/public-mcp-access.js";
import { LocalRefreshAuthority } from "../src/ingress/local-refresh-authority.js";
import { OAuthApprovalCodes } from "../src/ingress/oauth-approval-codes.js";
import { PublicOAuthPkceGrants } from "../src/ingress/public-oauth-pkce.js";
import { RefreshTokenRotation } from "../src/ingress/refresh-token-rotation.js";

const issuer = "https://fixed-codas.example.test";
const resource = issuer + "/mcp";
const clientId = "registered-chatgpt-client";
const callback = "https://chatgpt.com/oauth/callback";
const keyId = "mac-oauth-key:v1";
const verifier = "A".repeat(60);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function parameters(redirectUri = callback) {
  return new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri,
    response_type: "code", scope: "mcp:invoke",
    code_challenge: createHash("sha256")
      .update(verifier).digest("base64url"),
    code_challenge_method: "S256", resource,
    state: "client-generated-csrf-nonce"
  });
}

test("one-time local owner approval → HTTP code → PKCE token → refresh works", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codas-oauth-consent-"));
  const backend = http.createServer((_req, res) => res.end("ok"));
  const backendPort = await listen(backend);
  let router;
  try {
    const pair = generateKeyPairSync("ed25519");
    const config = {
      listenHost: "127.0.0.1", listenPort: 0,
      backendHost: "127.0.0.1", backendPort, backendTimeoutMs: 1000,
      stateDir: path.join(temp, "router"),
      localDeviceId: "mac", localDeviceLabel: "mac", localRoots: ["/tmp"]
    };
    const runtime = await createRouterRuntime(config, {
      publicAuth: createPublicMcpAccess({
        issuer, trustedKeys: new Map([[keyId, pair.publicKey]]),
        revocationsUpdatedAt: Date.now()
      })
    });
    runtime.publicOauth = new PublicOAuthPkceGrants({
      issuer, keyId, privateKey: pair.privateKey,
      registeredClients: new Map([[clientId, [callback]]]),
      refreshRotation: new RefreshTokenRotation({
        authority: new LocalRefreshAuthority({
          filePath: path.join(temp, "oauth-refresh-grants.json")
        })
      })
    });
    runtime.publicOauthApproval = new OAuthApprovalCodes({
      stateDir: config.stateDir, subject: "owner"
    });
    router = createRouterServer(config, runtime);
    const port = await listen(router);
    const base = `http://127.0.0.1:${port}`;
    const discovery = await fetch(base + "/.well-known/oauth-authorization-server");
    assert.equal(discovery.status, 200);
    const metadata = await discovery.json();
    assert.equal(metadata.issuer, issuer);
    assert.equal(metadata.authorization_endpoint, issuer + "/authorize");
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.equal(metadata.registration_endpoint, undefined);
    const params = parameters();
    const page = await fetch(base + "/authorize?" + params);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.ok(page.headers.get("content-security-policy").includes("form-action 'self'"));
    const html = await page.text();
    assert.ok(html.includes(clientId));
    assert.ok(html.includes(callback));
    assert.ok(!html.includes("owner-approval-code"));

    const code = await runtime.publicOauthApproval.issue();
    const approvalState = await readFile(
      path.join(config.stateDir, "oauth-approval-codes.json"), "utf8"
    );
    assert.ok(!approvalState.includes(code), "approval code stored only as hash");
    const forged = await fetch(base + "/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...Object.fromEntries(params),
        decision: "approve", owner_code: "invalid"
      })
    });
    assert.equal(forged.status, 403);
    const approved = await fetch(base + "/authorize", {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...Object.fromEntries(params),
        decision: "approve", owner_code: code
      })
    });
    assert.equal(approved.status, 303);
    const redirect = new URL(approved.headers.get("location"));
    assert.equal(redirect.origin, "https://chatgpt.com");
    assert.equal(redirect.searchParams.get("state"),
      "client-generated-csrf-nonce");
    const authCode = redirect.searchParams.get("code");
    assert.ok(authCode?.length === 43);

    const submit = async (values) => {
      const result = await fetch(base + "/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(values)
      });
      return { status: result.status, body: await result.json() };
    };
    const access = await submit({
      grant_type: "authorization_code", client_id: clientId,
      redirect_uri: callback, code: authCode,
      code_verifier: verifier, resource
    });
    assert.equal(access.status, 200);
    assert.equal(runtime.publicAuth.authenticate(
      access.body.access_token).subject, "owner");
    const refreshed = await submit({
      grant_type: "refresh_token", client_id: clientId,
      resource, refresh_token: access.body.refresh_token
    });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.body.refresh_token, access.body.refresh_token);

    const replayApproval = await fetch(base + "/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...Object.fromEntries(params),
        decision: "approve", owner_code: code
      })
    });
    assert.equal(replayApproval.status, 403);

    // Unregistered callbacks are checked before approval secret consumption.
    const differentCode = await runtime.publicOauthApproval.issue();
    const invalid = await fetch(base + "/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...Object.fromEntries(parameters("https://attacker.example.test/callback")),
        decision: "approve", owner_code: differentCode
      })
    });
    assert.equal(invalid.status, 400);
    const legitimate = await fetch(base + "/authorize", {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...Object.fromEntries(params),
        decision: "approve", owner_code: differentCode
      })
    });
    assert.equal(legitimate.status, 303,
      "invalid callback must not burn the user's one-time code");
  } finally {
    if (router) {
      router.closeAllConnections();
      await new Promise((resolve) => router.close(resolve));
    }
    await new Promise((resolve) => backend.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test("local approval secrets expire and cannot be replayed", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codas-approval-expiry-"));
  try {
    let now = 1_000_000;
    const codes = new OAuthApprovalCodes({
      stateDir: temp, clock: () => now
    });
    const first = await codes.issue();
    const second = await codes.issue();
    assert.equal(await codes.consume(first), false);
    assert.equal(await codes.consume(second), true);
    assert.equal(await codes.consume(second), false);
    const third = await codes.issue();
    now += 5 * 60_000 + 1;
    assert.equal(await codes.consume(third), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
