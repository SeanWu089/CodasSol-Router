import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AuthReplicaStore, createAuthReplicaReceiver,
  openAuthCheckpoint, sealAuthCheckpoint, sendAuthReplicaCheckpoint
} from "../src/ingress/auth-replica-checkpoint.js";
import { runAgent } from "../src/agent.js";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";

const issuer = "https://example.ngrok-free.app";
const mac = "mac-installation-12345";
const windows = "windows-installation-12345";
const macSign = generateKeyPairSync("ed25519");
const windowsSign = generateKeyPairSync("ed25519");
const winEnc = generateKeyPairSync("x25519");
const otherEnc = generateKeyPairSync("x25519");
let now = 1_800_000_000_000;
const state = {
  version: 1,
  namespaces: {
    refreshGrants: { records: {
      aa: { familyId: "family1", subject: "private-owner",
        status: "active", expiresAt: 2_000_000_000_000 }
    } },
    oauthClients: { records: {
      "client-12345": { redirect_uris: ["https://chatgpt.com/callback"] }
    } },
    revocations: { records: {} }
  }
};

function make(revision = 1, previous = null, overrides = {}) {
  return sealAuthCheckpoint({
    issuer, source: mac, target: windows,
    epoch: 4, revision, previous,
    state, signingKey: macSign.privateKey,
    recipientKey: winEnc.publicKey, clock: () => now,
    ...overrides
  });
}

function open(checkpoint, overrides = {}) {
  return openAuthCheckpoint({
    checkpoint, issuer, expectedSource: mac,
    localInstallationId: windows,
    trustedSigningKey: macSign.publicKey,
    recipientPrivateKey: winEnc.privateKey,
    clock: () => now, ...overrides
  });
}

test("checkpoint encrypts state for ONE target and pins Mac signer", () => {
  const ciphertext = make();
  assert.equal(JSON.stringify(ciphertext).includes("private-owner"), false);
  assert.equal(JSON.stringify(ciphertext).includes("family1"), false);
  const result = open(ciphertext);
  assert.deepEqual(result.state, state);
  assert.equal(result.epoch, 4);
  assert.equal(result.revision, 1);
  assert.equal(result.previous, null);
  assert.match(result.digest, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => open(ciphertext, {
    recipientPrivateKey: otherEnc.privateKey
  }), { code: "AUTH_REPLICA_REJECTED" });
  assert.throws(() => open(ciphertext, {
    trustedSigningKey: windowsSign.publicKey
  }), { code: "AUTH_REPLICA_REJECTED" });
  assert.throws(() => open(ciphertext, {
    expectedSource: "unknown-installation-12"
  }), { code: "AUTH_REPLICA_REJECTED" });
  assert.throws(() => open(ciphertext, {
    issuer: "https://other.ngrok-free.app"
  }), { code: "AUTH_REPLICA_REJECTED" });
});

test("tamper, wrong target, expiry, malformed payload and oversized states fail closed", () => {
  const good = make();
  for (const changed of [
    { ...good, ciphertext: good.ciphertext.slice(0, -3) + "AAA" },
    { ...good, revision: 2 },
    { ...good, target: "other-installation-1234" },
    { ...good, signature: (good.signature[0] === "A" ? "B" : "A") +
      good.signature.slice(1) },
    { ...good, tag: good.tag.slice(1) }
  ]) {
    assert.throws(() => open(changed), {
      code: "AUTH_REPLICA_REJECTED"
    });
  }
  assert.throws(() => open(good, { clock: () => now + 60_001 }), {
    code: "AUTH_REPLICA_REJECTED"
  });
  assert.throws(() => make(1, null, {
    state: { version: 1, namespaces: { malicious: { records: {} } } }
  }), { code: "AUTH_REPLICA_REJECTED" });
  assert.throws(() => make(1, null, {
    state: { version: 1, namespaces: {
      refreshGrants: { records: { a: { huge: "X".repeat(4_100_000) } } }
    } }
  }), { code: "AUTH_REPLICA_REJECTED" });
});

test("persistent replica accepts only a monotonic single-epoch authenticated chain", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codas-replica-"));
  const file = path.join(temp, "follower-checkpoint.json");
  try {
    const store = new AuthReplicaStore({ filePath: file });
    const first = open(make());
    await store.receive(first);
    assert.equal((await readFile(file, "utf8")).includes("private-owner"), true,
      "follower local state is private and must be protected by OS permissions");
    const second = open(make(2, first.digest));
    const ack = await store.receive(second);
    assert.equal(ack.revision, 2);
    const rebooted = new AuthReplicaStore({ filePath: file });
    await assert.rejects(rebooted.receive(first), {
      code: "AUTH_REPLICA_REJECTED"
    });
    await assert.rejects(rebooted.receive(open(make(4, second.digest))), {
      code: "AUTH_REPLICA_REJECTED"
    });
    await assert.rejects(rebooted.receive(open(make(3, first.digest))), {
      code: "AUTH_REPLICA_REJECTED"
    });
    await assert.rejects(rebooted.receive(open(make(3, second.digest, { epoch: 5 }))), {
      code: "AUTH_REPLICA_REJECTED"
    });
    assert.equal((await rebooted.receive(open(make(3, second.digest)))).revision, 3);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

test("two Router loopback SSE replicates encrypted OAuth checkpoint with durable receipt", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codas-sse-replica-"));
  const backend = http.createServer((_req, res) => res.end("ok"));
  const backendPort = await listen(backend);
  let router;
  let stopAgent = false;
  let agent;
  try {
    const config = {
      listenHost: "127.0.0.1", listenPort: 0,
      backendHost: "127.0.0.1", backendPort, backendTimeoutMs: 1000,
      stateDir: path.join(temp, "mac"), localDeviceId: "mac",
      localDeviceLabel: "Mac", localRoots: ["/tmp"]
    };
    const runtime = await createRouterRuntime(config);
    router = createRouterServer(config, runtime);
    const port = await listen(router);
    const base = `http://127.0.0.1:${port}`;
    const enrollmentResponse = await fetch(base + "/_codassol/agent/enroll", {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.privateState.pairingToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        id: "windows", label: "Windows", platform: "win32",
        roots: ["C:\\Projects"],
        capabilities: ["devspace-http", "auth-replica-v1"]
      })
    });
    assert.equal(enrollmentResponse.status, 201);
    const enrollment = await enrollmentResponse.json();
    const follower = new AuthReplicaStore({
      filePath: path.join(temp, "windows", "private-auth-replica.json")
    });
    const receiver = createAuthReplicaReceiver({
      issuer, expectedSource: mac,
      localInstallationId: windows,
      trustedSigningKey: macSign.publicKey,
      recipientPrivateKey: winEnc.privateKey,
      store: follower, clock: () => now
    });
    agent = runAgent({
      configStore: { load: async () => ({
        routerUrl: base, agentToken: enrollment.agentToken,
        device: { roots: ["C:\\Projects"],
          capabilities: ["devspace-http", "auth-replica-v1"] },
        devspace: { baseUrl: `http://127.0.0.1:${backendPort}`, oauth: {} }
      }) },
      stopSignal: () => stopAgent,
      replicaReceiver: receiver
    });
    const first = make();
    const received = await sendAuthReplicaCheckpoint({
      agentHub: runtime.agentHub, deviceId: "windows",
      checkpoint: first, timeoutMs: 3_000
    });
    assert.deepEqual(received, {
      replicated: true, epoch: 4, revision: 1,
      digest: open(first).digest
    });
    const second = make(2, received.digest);
    assert.equal((await sendAuthReplicaCheckpoint({
      agentHub: runtime.agentHub, deviceId: "windows",
      checkpoint: second, timeoutMs: 3_000
    })).revision, 2);
    await assert.rejects(sendAuthReplicaCheckpoint({
      agentHub: runtime.agentHub, deviceId: "windows",
      checkpoint: first, timeoutMs: 3_000
    }), { code: "AUTH_REPLICA_REJECTED" });
    assert.equal(JSON.parse(await readFile(follower.authority.filePath, "utf8"))
      .checkpoint.revision, 2);
  } finally {
    stopAgent = true;
    if (agent) await agent;
    if (router) {
      router.closeAllConnections();
      await new Promise((resolve) => router.close(resolve));
    }
    await new Promise((resolve) => backend.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
