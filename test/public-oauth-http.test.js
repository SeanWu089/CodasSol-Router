import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";
import { LocalRefreshAuthority } from "../src/ingress/local-refresh-authority.js";
import { RefreshTokenRotation } from "../src/ingress/refresh-token-rotation.js";
import { PublicOAuthPkceGrants } from "../src/ingress/public-oauth-pkce.js";
import { createPublicMcpAccess } from "../src/ingress/public-mcp-access.js";

const issuer = "https://fixed-codas.example.test";
const clientId = "registered-chatgpt-client";
const redirectUri = "https://chatgpt.com/oauth/callback";
const resource = issuer + "/mcp";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function tokenRequest(port, values, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(values).toString()
  });
  return {
    status: response.status,
    cache: response.headers.get("cache-control"),
    body: await response.json()
  };
}

test("HTTP token exchange rotates across two isolated Routers with same atomic local test state", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codas-oauth-http-"));
  const backend = http.createServer((_req, res) => res.end("ok"));
  const backendPort = await listen(backend);
  const servers = [];
  try {
    const macKey = generateKeyPairSync("ed25519");
    const winKey = generateKeyPairSync("ed25519");
    const keys = new Map([
      ["mac-key:v1", macKey.publicKey],
      ["windows-key:v1", winKey.publicKey]
    ]);
    const nodes = [];
    for (const [id, keyId, key] of [
      ["mac", "mac-key:v1", macKey],
      ["windows", "windows-key:v1", winKey]
    ]) {
      const config = {
        listenHost: "127.0.0.1", listenPort: 0,
        backendHost: "127.0.0.1", backendPort, backendTimeoutMs: 1000,
        stateDir: path.join(temp, id),
        localDeviceId: id, localDeviceLabel: id, localRoots: ["/tmp"]
      };
      const runtime = await createRouterRuntime(config, {
        publicAuth: createPublicMcpAccess({
          issuer, trustedKeys: keys, revocationsUpdatedAt: Date.now()
        })
      });
      runtime.publicOauth = new PublicOAuthPkceGrants({
        issuer, keyId, privateKey: key.privateKey,
        registeredClients: new Map([[clientId, [redirectUri]]]),
        refreshRotation: new RefreshTokenRotation({
          authority: new LocalRefreshAuthority({
            // Both test Routers are on one filesystem; real Mac/Windows
            // must use a provider-backed distributed atomic authority.
            filePath: path.join(temp, "single-machine-shared-grants.json")
          })
        })
      });
      const server = createRouterServer(config, runtime);
      servers.push(server);
      nodes.push({ id, runtime, port: await listen(server) });
    }
    const verifier = "A".repeat(60);
    const code = nodes[0].runtime.publicOauth.issueCode({
      ownerApproved: true, subject: "owner", clientId, redirectUri, resource,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256"
    });
    const authorized = await tokenRequest(nodes[0].port, {
      grant_type: "authorization_code", client_id: clientId,
      redirect_uri: redirectUri, code, code_verifier: verifier, resource
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.cache, "no-store");
    assert.equal(authorized.body.refresh_token.length, 64);
    assert.equal(nodes[0].runtime.publicAuth.authenticate(
      authorized.body.access_token).subject, "owner");

    const cutover = await tokenRequest(nodes[1].port, {
      grant_type: "refresh_token", client_id: clientId,
      refresh_token: authorized.body.refresh_token, resource
    });
    assert.equal(cutover.status, 200);
    assert.notEqual(cutover.body.refresh_token, authorized.body.refresh_token);
    assert.equal(nodes[0].runtime.publicAuth.authenticate(
      cutover.body.access_token).subject, "owner");
    assert.equal(nodes[1].runtime.publicAuth.authenticate(
      cutover.body.access_token).subject, "owner");

    // Refresh-token replay on old Mac invalidates the new Windows family.
    const replay = await tokenRequest(nodes[0].port, {
      grant_type: "refresh_token", client_id: clientId,
      refresh_token: authorized.body.refresh_token, resource
    });
    assert.deepEqual([replay.status, replay.body.error], [400, "invalid_grant"]);
    const revoked = await tokenRequest(nodes[1].port, {
      grant_type: "refresh_token", client_id: clientId,
      refresh_token: cutover.body.refresh_token, resource
    });
    assert.deepEqual([revoked.status, revoked.body.error], [400, "invalid_grant"]);

    const malformed = await tokenRequest(nodes[1].port, {
      grant_type: "refresh_token", client_id: clientId,
      refresh_token: "bad", resource
    });
    assert.equal(malformed.status, 400);
    const unsupported = await tokenRequest(nodes[1].port, {
      grant_type: "client_credentials"
    });
    assert.equal(unsupported.body.error, "unsupported_grant_type");
    const duplicate = await fetch(`http://127.0.0.1:${nodes[1].port}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&grant_type=authorization_code"
    });
    assert.equal(duplicate.status, 400);
    const issuerDiscovery = await fetch(
      `http://127.0.0.1:${nodes[1].port}/.well-known/oauth-authorization-server`
    );
    assert.equal(issuerDiscovery.status, 503,
      "must not advertise an OAuth issuer without login/consent implemented");
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await new Promise((resolve) => backend.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
