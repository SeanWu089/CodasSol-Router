import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AuthReplicaStore, createAuthReplicaReceiver,
  sealAuthCheckpoint, sealAuthCommit, openAuthCheckpoint
} from "../src/ingress/auth-replica-checkpoint.js";
import { createAuthPromotionGuard } from "../src/ingress/auth-promotion-guard.js";
import { CloudflareWitnessAuthority } from "../src/ingress/cloudflare-witness-authority.js";
import {
  applyWitnessAction, emptyWitnessState
} from "../src/ingress/cloudflare-witness-core.js";
import { IngressManager, IngressState } from "../src/ingress/ingress-manager.js";

const domain = "https://fixed-codas.example.test";
const source = "mac-installation-12345";
const standby = "windows-installation-12345";
const sourceSigning = generateKeyPairSync("ed25519");
const standbyEncryption = generateKeyPairSync("x25519");
const tokenHash = (text) => createHash("sha256").update(text).digest("hex");

async function setup(fn) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codas-cloudflare-promotion-"));
  let control = emptyWitnessState();
  let available = true;
  let tick = Date.now();
  const secrets = new Map([[source, "a".repeat(64)], [standby, "b".repeat(64)]]);
  const fetchImpl = async (url, request) => {
    if (!available) throw new Error("Cloudflare witness unreachable");
    const actor = request.headers["x-codassol-installation-id"];
    if (request.headers.authorization !== "Bearer " + secrets.get(actor)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const action = url.split("/").at(-1);
    const payload = JSON.parse(request.body);
    const newToken = "token-for-" + actor + "-epoch-" + (control.epoch + 1);
    const result = applyWitnessAction({
      state: control, action, actor, payload, now: tick,
      newToken, newTokenHash: tokenHash(newToken),
      presentedTokenHash: payload.claim
        ? tokenHash(payload.claim.fencingToken)
        : undefined
    });
    if (result.changed) control = result.state;
    return Response.json({ result: result.result });
  };
  const authority = (installationId) => new CloudflareWitnessAuthority({
    endpoint: "https://codassol-witness.example.workers.dev",
    publicDomain: domain, installationId,
    secret: secrets.get(installationId), fetchImpl
  });
  const mac = authority(source);
  const windows = authority(standby);
  const store = new AuthReplicaStore({
    filePath: path.join(temp, "windows-auth-replica.json")
  });
  const receiver = createAuthReplicaReceiver({
    issuer: domain, expectedSource: source,
    localInstallationId: standby, trustedSigningKey: sourceSigning.publicKey,
    recipientPrivateKey: standbyEncryption.privateKey, store
  });
  const checkpoint = ({ epoch, revision, previous }) =>
    sealAuthCheckpoint({
      issuer: domain, source, target: standby, epoch, revision,
      previous, signingKey: sourceSigning.privateKey,
      recipientKey: standbyEncryption.publicKey,
      state: { version: 1, namespaces: {
        refreshGrants: { records: {} },
        oauthClients: { records: {} },
        revocations: { records: {} }
      } }
    });
  const decoded = (sealed) => openAuthCheckpoint({
    checkpoint: sealed, issuer: domain,
    expectedSource: source, localInstallationId: standby,
    trustedSigningKey: sourceSigning.publicKey,
    recipientPrivateKey: standbyEncryption.privateKey
  });
  const commit = (opened) => sealAuthCommit({
    issuer: domain, source, target: standby,
    epoch: opened.epoch, revision: opened.revision,
    digest: opened.digest, signingKey: sourceSigning.privateKey
  });
  let starts = 0;
  const adapter = {
    fencedActivation: true,
    async start() { starts++; },
    async stop() {}
  };
  const candidate = {
    installationId: standby, userEnabled: true,
    identityVerified: true, routerReady: true, backendReady: true,
    networkReady: true, adapterAvailable: true, durableService: true,
    credentialsProvisioned: true, clientAuthReady: true
  };
  const manager = () => new IngressManager({
    installationId: standby, domain, lease: windows,
    adapter, enabled: true,
    activationPreflight: createAuthPromotionGuard({
      replicaStore: store, authority: windows
    }),
    clock: () => tick
  });
  try {
    await fn({
      mac, windows, store, receiver, checkpoint, decoded, commit,
      manager, candidate,
      get starts() { return starts; },
      setAvailable(value) { available = value; },
      advance(ms) { tick += ms; }
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("two independently authenticated Cloudflare clients cannot promote a prepared-only standby", async () => {
  await setup(async (x) => {
    const macClaim = await x.mac.acquire({ ownerId: source, domain });
    const sealed = x.checkpoint({
      epoch: macClaim.epoch, revision: 1, previous: null
    });
    await x.receiver.receive(sealed);
    await x.mac.release(macClaim);
    const blocked = await x.manager().reconcile({ local: x.candidate });
    assert.equal(blocked.state, IngressState.FENCED);
    assert.equal(x.starts, 0);
    assert.equal((await x.windows.status()).ownerId, null);
  });
});

test("a signed COMMITTED checkpoint plus external latest proof permits simulated standby ingress", async () => {
  await setup(async (x) => {
    const macClaim = await x.mac.acquire({ ownerId: source, domain });
    const sealed = x.checkpoint({
      epoch: macClaim.epoch, revision: 1, previous: null
    });
    const opened = x.decoded(sealed);
    await x.receiver.receive(sealed);
    await x.receiver.commit(x.commit(opened));
    await x.mac.release(macClaim);

    const missingLatest = await x.manager().reconcile({ local: x.candidate });
    assert.equal(missingLatest.state, IngressState.FENCED);
    assert.equal(x.starts, 0);

    const reacquired = await x.mac.acquire({ ownerId: source, domain });
    assert.equal(await x.mac.publishCommitted({
      claim: reacquired,
      checkpoint: { revision: opened.revision, digest: opened.digest, previous: null }
    }), true);
    await x.mac.release(reacquired);

    const readyManager = x.manager();
    const ready = await readyManager.reconcile({ local: x.candidate });
    assert.equal(ready.state, IngressState.ACTIVE);
    assert.equal(x.starts, 1);
    assert.equal((await x.windows.status()).latestCommitted.digest, opened.digest);
    readyManager.enabled = false;
    assert.equal((await readyManager.reconcile({ local: x.candidate })).state,
      IngressState.DISABLED);
  });
});

test("outage of external witness rejects ingress even when local replica is fully committed", async () => {
  await setup(async (x) => {
    const macClaim = await x.mac.acquire({ ownerId: source, domain });
    const sealed = x.checkpoint({
      epoch: macClaim.epoch, revision: 1, previous: null
    });
    const opened = x.decoded(sealed);
    await x.receiver.receive(sealed);
    await x.receiver.commit(x.commit(opened));
    await x.mac.publishCommitted({
      claim: macClaim,
      checkpoint: { revision: 1, digest: opened.digest, previous: null }
    });
    await x.mac.release(macClaim);
    x.setAvailable(false);
    const blocked = await x.manager().reconcile({ local: x.candidate });
    assert.equal(blocked.state, IngressState.FENCED);
    assert.equal(x.starts, 0);
  });
});
