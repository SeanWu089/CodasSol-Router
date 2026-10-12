import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PublicRequestFence, createCommittedAuthStateReader,
  createFollowerCommittedAuthStateReader
} from "../src/ingress/public-request-fence.js";
import {
  AuthReplicaStore, createAuthReplicaReceiver,
  sealAuthCheckpoint, sealAuthCommit, openAuthCheckpoint
} from "../src/ingress/auth-replica-checkpoint.js";
import { LocalRefreshAuthority } from "../src/ingress/local-refresh-authority.js";
import { createPublicMcpAccess } from "../src/ingress/public-mcp-access.js";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";

const issuer = "https://stable-codas.example.test";
const mac = "mac-installation-12345";
const windows = "windows-installation-12345";
const commitDigest = "A".repeat(43);
const now = () => Date.now();

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

test("two running Routers fail-close stale ngrok owner on every public MCP and OAuth request", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codas-request-fence-"));
  const backend = http.createServer((_req, res) => res.end("ok"));
  const backendPort = await listen(backend);
  const servers = [];
  let active = mac;
  let offline = false;
  let remoteDigest = commitDigest;
  let remoteRevision = 1;
  const keys = generateKeyPairSync("ed25519");
  const header = Buffer.from(JSON.stringify({
    alg: "EdDSA", typ: "at+jwt", kid: "public-key:v1"
  })).toString("base64url");
  const seconds = Math.floor(now() / 1000);
  const body = Buffer.from(JSON.stringify({
    iss: issuer, aud: issuer + "/mcp", sub: "owner",
    jti: randomBytes(18).toString("base64url"),
    iat: seconds, nbf: seconds, exp: seconds + 600,
    scope: "mcp:invoke"
  })).toString("base64url");
  const unsigned = header + "." + body;
  const validToken = unsigned + "." +
    sign(null, Buffer.from(unsigned), keys.privateKey).toString("base64url");
  const counters = new Map([[mac, 0], [windows, 0]]);
  const claim = (node) => ({
    ownerId: node, epoch: node === mac ? 1 : 2,
    expiresAt: now() + 60_000, fencingToken: "valid-fencing-secret-1234"
  });
  const witness = {
    async verify(c) {
      if (offline) throw new Error("Witness offline");
      return c.ownerId === active;
    },
    async confirmLatestCommitted({ checkpoint, claim: c }) {
      if (offline) throw new Error("Witness offline");
      return c.ownerId === active &&
        checkpoint.revision === remoteRevision &&
        checkpoint.digest === remoteDigest;
    }
  };
  const nodes = [];
  try {
    for (const id of [mac, windows]) {
      const config = {
        listenHost: "127.0.0.1", listenPort: 0,
        backendHost: "127.0.0.1", backendPort,
        backendTimeoutMs: 1000,
        stateDir: path.join(dir, id), localDeviceId: id,
        localDeviceLabel: id, localRoots: ["/tmp"]
      };
      const authority = new LocalRefreshAuthority({
        filePath: path.join(dir, id + "-auth.json")
      });
      await authority.transact((state) => {
        state.authRevision = 1;
        state.authCommitAckRevision = 1;
        state.lastReplicaDigest = commitDigest;
        state.lastReplicaAckAt = now();
      });
      const runtime = await createRouterRuntime(config, {
        publicAuth: createPublicMcpAccess({
          issuer, trustedKeys: new Map([["public-key:v1", keys.publicKey]]),
          revocationsUpdatedAt: now()
        })
      });
      runtime.publicIngressRequestGuard = new PublicRequestFence({
        authority: witness, installationId: id,
        publicDomain: issuer,
        currentClaim: () => claim(id),
        committedState: createCommittedAuthStateReader(authority)
      });
      runtime.peerOAuth.authorizedFetch = async () => {
        counters.set(id, counters.get(id) + 1);
        return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
      };
      const server = createRouterServer(config, runtime);
      servers.push(server);
      nodes.push({ id, base: `http://127.0.0.1:${await listen(server)}`,
        authority });
    }
    const attempt = async (node, bearer = null) => {
      const response = await fetch(node.base + "/mcp", {
        method: "POST", headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: "Bearer " + bearer } : {})
        },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "tools/list", id: 1
        })
      });
      return { status: response.status, body: await response.json() };
    };
    const first = await attempt(nodes[0]);
    assert.equal(first.status, 401, "Active Mac reached the JWT verifier");
    assert.equal((await attempt(nodes[0], validToken)).status, 200,
      "Valid bearer reaches the previously active Mac");
    assert.equal((await attempt(nodes[1])).status, 503,
      "Idle Windows cannot service even an unauthenticated MCP request");
    assert.equal(counters.get(mac), 1);
    assert.equal(counters.get(windows), 0);
    // Cloudflare winner switches while BOTH Router HTTP processes still run.
    active = windows;
    assert.deepEqual(await attempt(nodes[0], validToken), {
      status: 503, body: { error: "public_ingress_fenced" }
    });
    assert.equal((await attempt(nodes[1])).status, 401);
    assert.equal((await attempt(nodes[1], validToken)).status, 200,
      "Same public OAuth bearer still works on new owner");

    for (const endpoint of [
      "/authorize?client_id=registered", "/token", "/register",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server"
    ]) {
      const response = await fetch(nodes[0].base + endpoint);
      assert.equal(response.status, 503, endpoint + " bypassed request fence");
      assert.equal((await response.json()).error, "public_ingress_fenced");
    }

    remoteDigest = "B".repeat(43);
    assert.equal((await attempt(nodes[1])).status, 503,
      "Local commit must match the authoritative latest witness digest");
    remoteDigest = commitDigest;
    remoteRevision = 2;
    assert.equal((await attempt(nodes[1])).status, 503,
      "An unseen revision must fail closed");
    remoteRevision = 1;
    offline = true;
    assert.equal((await attempt(nodes[1])).status, 503,
      "Witness outage must never authorize stale Router service");
    assert.equal(counters.get(mac), 1,
      "Old Mac was not invoked again after it lost the witness lease");
    assert.equal(counters.get(windows), 1,
      "New Windows node was invoked exactly once");
    const contents = await readFile(nodes[1].authority.filePath, "utf8");
    const unchanged = await nodes[1].authority.snapshot();
    assert.equal(contents, await readFile(nodes[1].authority.filePath, "utf8"));
    assert.equal(unchanged.authRevision, 1);
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await new Promise((resolve) => backend.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("per-request fence checks race, local confirmation, lease expiry and rejects missing provision", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codas-request-fence-errors-"));
  try {
    const authority = new LocalRefreshAuthority({
      filePath: path.join(dir, "state.json")
    });
    const initial = {
      authRevision: 1, authCommitAckRevision: 1,
      lastReplicaDigest: commitDigest, lastReplicaAckAt: now()
    };
    await authority.transact((state) => Object.assign(state, initial));
    const read = createCommittedAuthStateReader(authority);
    const claim = {
      ownerId: mac, epoch: 1, expiresAt: now() + 60_000,
      fencingToken: "valid-fencing-secret-1234"
    };
    const stub = {
      async verify() { return true; },
      async confirmLatestCommitted() { return true; }
    };
    const guard = new PublicRequestFence({
      authority: stub, publicDomain: issuer,
      installationId: mac, currentClaim: () => claim,
      committedState: read
    });
    assert.equal(await guard.authorizeRequest(), true);
    await authority.transact((state) => {
      state.authRevision += 1;
      // Intentional missing post-commit ACK.
    });
    await assert.rejects(guard.authorizeRequest(), { code: "INGRESS_FENCED" });
    await authority.transact((state) => {
      state.authCommitAckRevision = state.authRevision;
      state.lastReplicaDigest = "B".repeat(43);
      state.lastReplicaAckAt = now() - 400_000;
    });
    await assert.rejects(guard.authorizeRequest(), { code: "INGRESS_FENCED" });
    await authority.transact((state) => {
      state.lastReplicaAckAt = now();
    });
    const racing = new PublicRequestFence({
      authority: {
        verify: async () => true,
        confirmLatestCommitted: async () => {
          await authority.transact((state) => {
            state.authRevision += 1;
          });
          return true;
        }
      },
      installationId: mac, publicDomain: issuer,
      currentClaim: () => claim, committedState: read
    });
    await assert.rejects(racing.authorizeRequest(), {
      code: "INGRESS_FENCED"
    });
    claim.expiresAt = now() - 1;
    await assert.rejects(guard.authorizeRequest(), { code: "INGRESS_FENCED" });
    await rm(authority.filePath);
    await assert.rejects(guard.authorizeRequest(), { code: "INGRESS_FENCED" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("follower public request fencing only trusts committed, non-pending signed snapshots", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codas-follower-fence-"));
  try {
    const signing = generateKeyPairSync("ed25519");
    const recipient = generateKeyPairSync("x25519");
    const store = new AuthReplicaStore({
      filePath: path.join(dir, "standby-auth.json")
    });
    const receiver = createAuthReplicaReceiver({
      issuer, expectedSource: mac, localInstallationId: windows,
      trustedSigningKey: signing.publicKey,
      recipientPrivateKey: recipient.privateKey,
      store
    });
    const checkpoint = (revision, previous = null) =>
      sealAuthCheckpoint({
        issuer, source: mac, target: windows,
        epoch: 1, revision, previous,
        state: { version: 1, namespaces: {
          refreshGrants: { records: {} },
          oauthClients: { records: {} },
          revocations: { records: {} }
        } },
        signingKey: signing.privateKey,
        recipientKey: recipient.publicKey
      });
    const opened = (sealed) => openAuthCheckpoint({
      checkpoint: sealed, issuer, expectedSource: mac,
      localInstallationId: windows,
      trustedSigningKey: signing.publicKey,
      recipientPrivateKey: recipient.privateKey
    });
    const reader = createFollowerCommittedAuthStateReader(store);
    let externalDigest = null;
    const guard = new PublicRequestFence({
      authority: {
        verify: async () => true,
        confirmLatestCommitted: async ({ checkpoint: candidate }) =>
          candidate.digest === externalDigest
      },
      publicDomain: issuer, installationId: windows,
      currentClaim: () => ({
        ownerId: windows, epoch: 2,
        expiresAt: now() + 60_000,
        fencingToken: "pinned-fencing-token"
      }),
      committedState: reader
    });
    const sealed = checkpoint(1);
    const entry = opened(sealed);
    await receiver.receive(sealed);
    externalDigest = entry.digest;
    await assert.rejects(guard.authorizeRequest(), { code: "INGRESS_FENCED" },
      "signed PREPARED alone must not authorize public ingress");
    await receiver.commit(sealAuthCommit({
      issuer, source: mac, target: windows,
      epoch: 1, revision: 1, digest: entry.digest,
      signingKey: signing.privateKey
    }));
    assert.equal(await guard.authorizeRequest(), true);
    const second = checkpoint(2, entry.digest);
    await receiver.receive(second);
    await assert.rejects(guard.authorizeRequest(), { code: "INGRESS_FENCED" },
      "pending second version blocks service even when earlier revision committed");
    assert.equal((await reader()).revision, 1,
      "uncommitted second revision must stay separate from the last committed one");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit public ingress fencing mode refuses to start without OAuth and guard", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codas-guard-provision-"));
  const backend = http.createServer((_req, res) => res.end("ok"));
  const backendPort = await listen(backend);
  try {
    const config = {
      listenHost: "127.0.0.1", listenPort: 0,
      backendHost: "127.0.0.1", backendPort,
      stateDir: dir, localDeviceId: "mac", localRoots: ["/tmp"],
      requirePublicIngressFence: true
    };
    const publicKey = generateKeyPairSync("ed25519").publicKey;
    const runtime = await createRouterRuntime(config, {
      publicAuth: createPublicMcpAccess({
        issuer, trustedKeys: new Map([["pinned-public-key:v1", publicKey]]),
        revocationsUpdatedAt: now()
      })
    });
    assert.throws(() => createRouterServer(config, runtime),
      /requires public OAuth and a live request guard/);
    runtime.publicIngressRequestGuard = {
      async authorizeRequest() { throw new Error("no external witness"); }
    };
    const router = createRouterServer(config, runtime);
    try {
      const base = `http://127.0.0.1:${await listen(router)}`;
      const result = await fetch(base + "/mcp", { method: "POST" });
      assert.equal(result.status, 503);
      assert.equal((await result.json()).error, "public_ingress_fenced");
    } finally {
      router.closeAllConnections();
      await new Promise((resolve) => router.close(resolve));
    }
  } finally {
    await new Promise((resolve) => backend.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
