import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { LocalRefreshAuthority } from "../src/ingress/local-refresh-authority.js";
import {
  loadPublicRequestFenceFromFile
} from "../src/ingress/public-request-fence-provisioning.js";
import { createPublicMcpAccess } from "../src/ingress/public-mcp-access.js";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";

const issuer = "https://fixed-codas.example.test";
const installationId = "mac-installation-12345";
const digest = "A".repeat(43);
const secret = "a".repeat(64);
const claim = () => ({
  ownerId: installationId,
  epoch: 4,
  expiresAt: Date.now() + 60_000,
  fencingToken: "pinned-local-fencing-secret-value-1234"
});

async function setup(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codas-ingress-config-"));
  const filePath = path.join(dir, "ingress-config.json");
  const claimFile = path.join(dir, "claim.json");
  const authStateFile = path.join(dir, "auth-state.json");
  const config = {
    version: 1, installationId, publicDomain: issuer,
    role: "leader",
    witness: {
      endpoint: "https://independent-witness.example.workers.dev",
      secret
    },
    claimFile, authStateFile
  };
  const save = async (file, data, mode = 0o600) => {
    await writeFile(file, JSON.stringify(data), { mode });
    await chmod(file, mode);
  };
  const state = new LocalRefreshAuthority({ filePath: authStateFile });
  await state.transact((s) => {
    s.authRevision = 1;
    s.authCommitAckRevision = 1;
    s.lastReplicaDigest = digest;
    s.lastReplicaAckAt = Date.now();
  });
  await save(claimFile, claim());
  await save(filePath, config);
  try {
    await fn({ dir, filePath, claimFile, authStateFile, config, save, state });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeWitness() {
  const events = [];
  const fetchImpl = async (url, request) => {
    events.push({ url, request });
    assert.equal(request.headers.authorization, "Bearer " + secret);
    assert.equal(request.headers["x-codassol-installation-id"], installationId);
    const action = url.split("/").at(-1);
    const payload = JSON.parse(request.body);
    if (action === "verify") {
      return Response.json({ result: payload.claim.epoch === 4 });
    }
    if (action === "confirm") {
      return Response.json({ result:
        payload.checkpoint.revision === 1 &&
        payload.checkpoint.digest === digest });
    }
    return Response.json({ result: false });
  };
  return { fetchImpl, events };
}

test("private staging config binds issuer, device, current claim and committed state to witness", async () => {
  await setup(async ({ filePath, claimFile, state, save }) => {
    const witness = fakeWitness();
    const guard = await loadPublicRequestFenceFromFile({
      filePath, installationId, publicIssuer: issuer,
      fetchImpl: witness.fetchImpl
    });
    assert.equal(await guard.authorizeRequest(), true);
    assert.deepEqual(witness.events.map((e) => e.url.split("/").at(-1)),
      ["verify", "confirm", "verify"]);

    await save(claimFile, { ...claim(), ownerId: "windows-installation-12345" });
    await assert.rejects(guard.authorizeRequest(), { code: "INGRESS_FENCED" });
    assert.equal(witness.events.length, 3, "wrong local owner must not call witness");
    await save(claimFile, claim());
    await state.transact((s) => {
      s.authRevision += 1;
    });
    await assert.rejects(guard.authorizeRequest(), { code: "INGRESS_FENCED" },
      "incomplete local two-phase commit must fail closed");
    assert.equal(witness.events.length, 3);
  });
});

test("private provisioning rejects unsafe permissions, symlinks, identity, and secrets", async () => {
  await setup(async ({ dir, filePath, config, save }) => {
    const attempt = () => loadPublicRequestFenceFromFile({
      filePath, installationId, publicIssuer: issuer
    });
    await assert.rejects(loadPublicRequestFenceFromFile({
      filePath, installationId: "windows-installation-12345",
      publicIssuer: issuer
    }), { code: "PUBLIC_INGRESS_PROVISIONING_INVALID" });
    await assert.rejects(loadPublicRequestFenceFromFile({
      filePath, installationId, publicIssuer: "https://wrong.example.test"
    }), { code: "PUBLIC_INGRESS_PROVISIONING_INVALID" });
    await save(filePath, { ...config, witness: { ...config.witness,
      secret: "not-a-256-bit-secret" } });
    await assert.rejects(attempt(), { code: "PUBLIC_INGRESS_PROVISIONING_INVALID" });
    await save(filePath, config, 0o644);
    if (process.platform !== "win32") {
      await assert.rejects(attempt(), { code: "PUBLIC_INGRESS_PROVISIONING_INVALID" });
    }
    const symlinkPath = path.join(dir, "config-link.json");
    await symlink(filePath, symlinkPath);
    await assert.rejects(loadPublicRequestFenceFromFile({
      filePath: symlinkPath, installationId, publicIssuer: issuer
    }), { code: "PUBLIC_INGRESS_PROVISIONING_INVALID" });
  });
});

test("claim read permissions fail closed without leaking witness secret", async () => {
  await setup(async ({ filePath, claimFile, save }) => {
    const fake = fakeWitness();
    const guard = await loadPublicRequestFenceFromFile({
      filePath, installationId, publicIssuer: issuer, fetchImpl: fake.fetchImpl
    });
    await save(claimFile, claim(), 0o644);
    if (process.platform !== "win32") {
      await assert.rejects(guard.authorizeRequest(), { code: "INGRESS_FENCED" });
    }
    assert.equal(fake.events.length, 0);
    assert.equal((await readFile(filePath, "utf8")).includes(secret), true,
      "The staged configuration is secret-bearing and must be kept private");
  });
});

test("local staging preflight is read-only, redacts secrets and distinguishes incomplete claims", async () => {
  await setup(async ({ filePath, claimFile, save, state }) => {
    const inspect = () => spawnSync(process.execPath, [
      new URL("../scripts/check-public-ingress.mjs", import.meta.url).pathname,
      filePath, installationId, issuer
    ], { encoding: "utf8", timeout: 5000 });
    const ready = inspect();
    assert.equal(ready.status, 0, ready.stderr);
    assert.match(ready.stdout, /locally-committed/);
    assert.match(ready.stdout, /locally-present/);
    assert.match(ready.stdout, /NOT contacted/);
    assert.equal(ready.stdout.includes(secret), false);
    assert.equal(ready.stderr.includes(secret), false);

    await save(claimFile, { ...claim(), expiresAt: Date.now() - 1000 });
    const stale = inspect();
    assert.equal(stale.status, 2);
    assert.match(stale.stdout, /expired/);
    assert.equal(stale.stdout.includes(secret), false);

    await state.transact((s) => {
      s.authRevision += 1;
    });
    const uncommitted = inspect();
    assert.equal(uncommitted.status, 2);
    assert.match(uncommitted.stdout, /unconfirmed/);
    assert.equal(uncommitted.stdout.includes(secret), false);

    await chmod(filePath, 0o644);
    if (process.platform !== "win32") {
      const insecure = inspect();
      assert.equal(insecure.status, 1);
      assert.equal(insecure.stdout.includes(secret), false);
      assert.equal(insecure.stderr.includes(secret), false);
    }
  });
});

test("Router runtime opts into file-backed fence and refuses an incomplete startup", async () => {
  await setup(async ({ dir, filePath, config, save }) => {
    const backend = http.createServer((_req, res) => res.end("ok"));
    await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
    try {
      const startup = {
        listenHost: "127.0.0.1", listenPort: 0,
        backendHost: "127.0.0.1",
        backendPort: backend.address().port,
        stateDir: path.join(dir, "private-router"),
        localDeviceId: "mac", localDeviceLabel: "Mac", localRoots: ["/tmp"]
      };
      const baseRuntime = await createRouterRuntime(startup);
      const privateId = baseRuntime.privateState.installationId;
      await save(filePath, { ...config, installationId: privateId });
      const keys = generateKeyPairSync("ed25519");
      const publicAuth = createPublicMcpAccess({
        issuer, trustedKeys: new Map([["pinned-public-key:v1", keys.publicKey]]),
        revocationsUpdatedAt: Date.now()
      });
      const configured = { ...startup, publicIngressFenceFile: filePath };
      assert.equal(loadConfig({
        CODASSOL_PUBLIC_INGRESS_FENCE_FILE: filePath
      }).publicIngressFenceFile, filePath);
      await assert.rejects(createRouterRuntime(configured),
        /requires provisioned public OAuth/);
      const runtime = await createRouterRuntime(configured, { publicAuth });
      assert.equal(typeof runtime.publicIngressRequestGuard.authorizeRequest,
        "function");
      const router = createRouterServer(configured, runtime);
      try {
        await new Promise((resolve) => router.listen(0, "127.0.0.1", resolve));
        const response = await fetch(
          `http://127.0.0.1:${router.address().port}/mcp`,
          { method: "POST" }
        );
        assert.equal(response.status, 503,
          "Absent real Cloudflare witness must fail closed");
        assert.equal((await response.json()).error, "public_ingress_fenced");
      } finally {
        router.closeAllConnections();
        await new Promise((resolve) => router.close(resolve));
      }
    } finally {
      backend.closeAllConnections();
      await new Promise((resolve) => backend.close(resolve));
    }
  });
});
