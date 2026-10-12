import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalRefreshAuthority } from "../src/ingress/local-refresh-authority.js";
import { RefreshTokenRotation } from "../src/ingress/refresh-token-rotation.js";
import { PublicOAuthPkceGrants } from "../src/ingress/public-oauth-pkce.js";
import { createPublicMcpAccess } from "../src/ingress/public-mcp-access.js";
import { createHash } from "node:crypto";

const issuer = "https://fixed-codassol.example.test";
const resource = issuer + "/mcp";
const clientId = "registered-chatgpt-client";
const redirectUri = "https://chatgpt.com/oauth/callback";

class SimulatedSharedAtomicAuthority {
  #data = { version: 1, records: {} };
  #queue = Promise.resolve();
  async transact(fn) {
    const run = this.#queue.then(async () => {
      const draft = structuredClone(this.#data);
      const result = await fn(draft);
      this.#data = draft;
      return result;
    });
    this.#queue = run.catch(() => {});
    return run;
  }
  get persisted() { return structuredClone(this.#data); }
}

test("new refresh token survives local process restart; only token hashes are stored", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codassol-refresh-"));
  const file = path.join(temp, "grants.json");
  try {
    const first = new RefreshTokenRotation({
      authority: new LocalRefreshAuthority({ filePath: file })
    });
    const issued = await first.issue({
      subject: "owner", clientId, resource
    });
    assert.equal(issued.refresh_token.length, 64);
    const disk = await readFile(file, "utf8");
    assert.equal(disk.includes(issued.refresh_token), false);
    assert.equal(disk.includes("owner"), true);
    const second = new RefreshTokenRotation({
      authority: new LocalRefreshAuthority({ filePath: file })
    });
    const rotated = await second.rotate({
      refreshToken: issued.refresh_token, clientId, resource
    });
    assert.notEqual(rotated.refresh_token, issued.refresh_token);
    assert.equal(rotated.subject, "owner");
    const third = new RefreshTokenRotation({
      authority: new LocalRefreshAuthority({ filePath: file })
    });
    const next = await third.rotate({
      refreshToken: rotated.refresh_token, clientId, resource
    });
    assert.equal(next.subject, "owner");
    assert.equal((await readFile(file, "utf8")).includes(next.refresh_token), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("old-token replay revokes all descendants even after rotation on another Router", async () => {
  const authority = new SimulatedSharedAtomicAuthority();
  const mac = new RefreshTokenRotation({ authority });
  const windows = new RefreshTokenRotation({ authority });
  const issued = await mac.issue({ subject: "owner", clientId, resource });
  const win = await windows.rotate({
    refreshToken: issued.refresh_token, clientId, resource
  });
  await assert.rejects(mac.rotate({
    refreshToken: issued.refresh_token, clientId, resource
  }), { code: "invalid_grant" });
  await assert.rejects(windows.rotate({
    refreshToken: win.refresh_token, clientId, resource
  }), { code: "invalid_grant" });
  assert.ok(Object.values(authority.persisted.records)
    .every((record) => record.status === "revoked"));
});

test("simultaneous cross-node refresh is serialized and detects token reuse", async () => {
  const authority = new SimulatedSharedAtomicAuthority();
  const mac = new RefreshTokenRotation({ authority });
  const win = new RefreshTokenRotation({ authority });
  const issued = await mac.issue({ subject: "owner", clientId, resource });
  const result = await Promise.allSettled([
    mac.rotate({ refreshToken: issued.refresh_token, clientId, resource }),
    win.rotate({ refreshToken: issued.refresh_token, clientId, resource })
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(result.filter((r) => r.status === "rejected").length, 1);
  // The winning successor is revoked once the other concurrent request is
  // detected. The successful response must not imply the family is still good.
  const winner = result.find((r) => r.status === "fulfilled").value;
  await assert.rejects(mac.rotate({
    refreshToken: winner.refresh_token, clientId, resource
  }), { code: "invalid_grant" });
});

test("wrong client/resource or explicit grant revocation fails closed", async () => {
  const authority = new SimulatedSharedAtomicAuthority();
  const store = new RefreshTokenRotation({ authority });
  const issued = await store.issue({ subject: "owner", clientId, resource });
  await assert.rejects(store.rotate({
    refreshToken: issued.refresh_token, clientId: "attacker", resource
  }), { code: "invalid_grant" });
  await assert.rejects(store.rotate({
    refreshToken: issued.refresh_token, clientId, resource: issuer + "/other"
  }), { code: "invalid_grant" });
  assert.equal(await store.revoke({
    refreshToken: issued.refresh_token, clientId
  }), true);
  await assert.rejects(store.rotate({
    refreshToken: issued.refresh_token, clientId, resource
  }), { code: "invalid_grant" });
});

test("stale local lock fails closed and never deletes someone else's lock", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codassol-refresh-lock-"));
  const file = path.join(temp, "grants.json");
  try {
    await writeFile(file + ".lock", "owned-by-another-process");
    const authority = new LocalRefreshAuthority({ filePath: file, lockWaitMs: 20 });
    await assert.rejects(authority.transact(() => undefined),
      { code: "grant_store_unavailable" });
    assert.equal(await readFile(file + ".lock", "utf8"),
      "owned-by-another-process");
    assert.equal(authority.distributedSafe, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("PKCE grant can issue rotating refresh tokens and switch signer after takeover", async () => {
  const authority = new SimulatedSharedAtomicAuthority();
  const rotationMac = new RefreshTokenRotation({ authority });
  const rotationWin = new RefreshTokenRotation({ authority });
  const macKeys = generateKeyPairSync("ed25519");
  const winKeys = generateKeyPairSync("ed25519");
  const now = Date.now();
  const opts = {
    issuer, registeredClients: new Map([[clientId, [redirectUri]]]),
    clock: () => now
  };
  const mac = new PublicOAuthPkceGrants({
    ...opts, keyId: "mac-key:v1", privateKey: macKeys.privateKey,
    refreshRotation: rotationMac
  });
  const windows = new PublicOAuthPkceGrants({
    ...opts, keyId: "windows-key:v1", privateKey: winKeys.privateKey,
    refreshRotation: rotationWin
  });
  const verifier = "A".repeat(60);
  const code = mac.issueCode({
    ownerApproved: true, subject: "owner", clientId, redirectUri,
    resource,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    codeChallengeMethod: "S256"
  });
  const initial = await mac.redeemCodeWithRefresh({
    code, clientId, redirectUri, codeVerifier: verifier, resource
  });
  const afterFailover = await windows.exchangeRefreshToken({
    clientId, refreshToken: initial.refresh_token, resource
  });
  assert.notEqual(initial.refresh_token, afterFailover.refresh_token);
  assert.ok(!initial.access_token.includes(initial.refresh_token));
  const verified = createPublicMcpAccess({
    issuer, now: () => now, revocationsUpdatedAt: now,
    trustedKeys: new Map([
      ["mac-key:v1", macKeys.publicKey],
      ["windows-key:v1", winKeys.publicKey]
    ])
  });
  assert.equal(verified.authenticate(initial.access_token).subject, "owner");
  assert.equal(verified.authenticate(afterFailover.access_token).subject, "owner");
  await assert.rejects(mac.exchangeRefreshToken({
    clientId, refreshToken: initial.refresh_token, resource
  }), { code: "invalid_grant" });
  await assert.rejects(windows.exchangeRefreshToken({
    clientId, refreshToken: afterFailover.refresh_token, resource
  }), { code: "invalid_grant" });
});
