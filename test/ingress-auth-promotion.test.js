import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AuthReplicaStore, createAuthReplicaReceiver,
  sealAuthCheckpoint, sealAuthCommit, openAuthCheckpoint
} from "../src/ingress/auth-replica-checkpoint.js";
import { createAuthPromotionGuard } from "../src/ingress/auth-promotion-guard.js";
import { IngressManager, IngressState } from "../src/ingress/ingress-manager.js";

const domain = "https://stable-codas.example.test";
const source = "mac-installation-12345";
const target = "windows-installation-12345";
const key = generateKeyPairSync("ed25519");
const receiverKey = generateKeyPairSync("x25519");

function externalAuthority() {
  let claim = null;
  let latest = null;
  return {
    async acquire({ ownerId }) {
      if (claim) return null;
      claim = {
        ownerId, epoch: 11, expiresAt: Date.now() + 60_000,
        fencingToken: "simulated-exclusive-lease-token"
      };
      return { ...claim };
    },
    async verify(value) {
      return !!claim && value?.ownerId === claim.ownerId &&
        value?.fencingToken === claim.fencingToken;
    },
    async renew(value) { return this.verify(value) ? { ...claim } : null; },
    async release(value) {
      if (!await this.verify(value)) throw new Error("Wrong owner");
      claim = null;
    },
    async confirmLatestCommitted({ checkpoint, claim: value }) {
      return await this.verify(value) &&
        checkpoint.digest === latest?.digest &&
        checkpoint.revision === latest?.revision;
    },
    publishCommitted(checkpoint) { latest = checkpoint; },
    get owner() { return claim?.ownerId ?? null; }
  };
}

const candidate = () => ({
  installationId: target, userEnabled: true,
  identityVerified: true, routerReady: true, backendReady: true,
  networkReady: true, adapterAvailable: true,
  durableService: true, credentialsProvisioned: true, clientAuthReady: true
});

test("Ingress activation rejects PREPARED OAuth state and accepts ONLY externally confirmed COMMITTED state", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codas-auth-activation-"));
  try {
    const store = new AuthReplicaStore({ filePath: path.join(temp, "state.json") });
    const receiver = createAuthReplicaReceiver({
      issuer: domain, expectedSource: source, localInstallationId: target,
      trustedSigningKey: key.publicKey,
      recipientPrivateKey: receiverKey.privateKey, store
    });
    const snapshot = sealAuthCheckpoint({
      issuer: domain, source, target, epoch: 11, revision: 1,
      state: { version: 1, namespaces: {
        refreshGrants: { records: {} },
        oauthClients: { records: {} },
        revocations: { records: {} }
      } }, signingKey: key.privateKey, recipientKey: receiverKey.publicKey
    });
    const opened = openAuthCheckpoint({
      checkpoint: snapshot, issuer: domain, expectedSource: source,
      localInstallationId: target, trustedSigningKey: key.publicKey,
      recipientPrivateKey: receiverKey.privateKey
    });
    await receiver.receive(snapshot);
    const lease = externalAuthority();
    let starts = 0;
    const adapter = {
      fencedActivation: true,
      async start() { starts++; },
      async stop() {}
    };
    const guard = createAuthPromotionGuard({ replicaStore: store, authority: lease });
    const manager = () => new IngressManager({
      installationId: target, domain, lease, adapter,
      activationPreflight: guard, enabled: true
    });

    const preparedOnly = await manager().reconcile({ local: candidate() });
    assert.equal(preparedOnly.state, IngressState.FENCED);
    assert.equal(starts, 0);
    assert.equal(lease.owner, null);

    const certificate = sealAuthCommit({
      issuer: domain, source, target, epoch: 11, revision: 1,
      digest: opened.digest, signingKey: key.privateKey
    });
    await receiver.commit(certificate);
    const noLatestProof = await manager().reconcile({ local: candidate() });
    assert.equal(noLatestProof.state, IngressState.FENCED);
    assert.equal(starts, 0);
    assert.equal(lease.owner, null);

    lease.publishCommitted({
      digest: opened.digest, revision: opened.revision
    });
    const activeManager = manager();
    const ready = await activeManager.reconcile({ local: candidate() });
    assert.equal(ready.state, IngressState.ACTIVE);
    assert.equal(starts, 1);
    assert.equal(lease.owner, target);
    activeManager.enabled = false;
    assert.equal((await activeManager.reconcile({ local: candidate() })).state,
      IngressState.DISABLED);
    assert.equal(lease.owner, null);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("auth promotion guard cannot be constructed with a local-only replica", () => {
  assert.throws(() => createAuthPromotionGuard({
    replicaStore: { preflightPromotion: async () => true },
    authority: { verify: async () => true }
  }), /independent external authority/);
});
