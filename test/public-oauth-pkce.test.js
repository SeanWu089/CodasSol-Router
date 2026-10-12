import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { PublicOAuthPkceGrants } from "../src/ingress/public-oauth-pkce.js";
import { createPublicMcpAccess } from "../src/ingress/public-mcp-access.js";

const issuer = "https://stable-codassol.example.test";
const pair = generateKeyPairSync("ed25519");
const keyId = "codassol-public-key:v1";
const redirectUri = "https://chatgpt.com/oauth/callback";
const clientId = "registered-chatgpt-client";
const verifier = "A".repeat(60);
const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
let now = 1_800_000;

function grants() {
  return new PublicOAuthPkceGrants({
    issuer, keyId, privateKey: pair.privateKey,
    registeredClients: new Map([[clientId, [redirectUri]]]),
    clock: () => now,
    codeTtlMs: 90_000
  });
}

const options = {
  subject: "owner-opaque-id",
  clientId, redirectUri,
  codeChallenge, codeChallengeMethod: "S256",
  resource: issuer + "/mcp", ownerApproved: true
};

test("approved S256 authorization code mints a cross-node-verifiable scoped access token", () => {
  now = 1_800_000;
  const issuerServer = grants();
  const code = issuerServer.issueCode(options);
  const tokenResponse = issuerServer.redeemCode({
    code, clientId, redirectUri, codeVerifier: verifier,
    resource: issuer + "/mcp"
  });
  assert.equal(tokenResponse.token_type, "Bearer");
  assert.equal(tokenResponse.expires_in, 600);
  assert.equal("refresh_token" in tokenResponse, false);
  const windowsVerifier = createPublicMcpAccess({
    issuer, trustedKeys: new Map([[keyId, pair.publicKey]]),
    revokedJtis: new Set(), revocationsUpdatedAt: now, now: () => now
  });
  assert.equal(windowsVerifier.authenticate(tokenResponse.access_token).subject,
    options.subject);
  now += 601_000;
  assert.throws(() => windowsVerifier.authenticate(tokenResponse.access_token),
    { code: "revocation_state_stale" });
});

test("owner consent, registered redirect, resource and S256 are mandatory", () => {
  now = 1_800_000;
  const authority = grants();
  for (const invalid of [
    { ownerApproved: false },
    { clientId: "unknown-client" },
    { redirectUri: "https://attacker.example.test/oauth/callback" },
    { resource: issuer + "/other-service" },
    { codeChallengeMethod: "plain" },
    { codeChallenge: "invalid-short" }
  ]) {
    assert.throws(() => authority.issueCode({ ...options, ...invalid }),
      { code: "invalid_grant" });
  }
});

test("authorization codes are one-time; failed PKCE redemption consumes the grant", () => {
  now = 1_800_000;
  const authority = grants();
  const code = authority.issueCode(options);
  assert.throws(() => authority.redeemCode({
    code, clientId, redirectUri, resource: issuer + "/mcp",
    codeVerifier: "B".repeat(60)
  }), { code: "invalid_grant" });
  assert.throws(() => authority.redeemCode({
    code, clientId, redirectUri, resource: issuer + "/mcp",
    codeVerifier: verifier
  }), { code: "invalid_grant" });
});

test("expired codes and cross-client or wrong-resource redemption fail closed", () => {
  now = 1_800_000;
  const authority = grants();
  const code = authority.issueCode(options);
  now += 100_000;
  assert.throws(() => authority.redeemCode({
    code, clientId, redirectUri, codeVerifier: verifier,
    resource: issuer + "/mcp"
  }), { code: "invalid_grant" });
  now = 1_800_000;
  const another = grants();
  const wrongTarget = another.issueCode(options);
  assert.throws(() => another.redeemCode({
    code: wrongTarget, clientId, redirectUri, codeVerifier: verifier,
    resource: issuer + "/not-mcp"
  }), { code: "invalid_grant" });
});
