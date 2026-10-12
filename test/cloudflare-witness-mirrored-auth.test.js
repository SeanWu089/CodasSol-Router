import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CloudflareWitnessAuthority } from "../src/ingress/cloudflare-witness-authority.js";
import {
  emptyWitnessState, applyWitnessAction
} from "../src/ingress/cloudflare-witness-core.js";
import {
  AuthReplicaStore, createAuthReplicaReceiver
} from "../src/ingress/auth-replica-checkpoint.js";
import { LocalRefreshAuthority } from "../src/ingress/local-refresh-authority.js";
import { MirroredAuthWriter } from "../src/ingress/mirrored-auth-writer.js";
import { RefreshTokenRotation } from "../src/ingress/refresh-token-rotation.js";
import { createWitnessCommitPublisher } from "../src/ingress/witness-commit-publisher.js";

const issuer = "https://fixed-codas.example.test";
const source = "mac-installation-12345";
const target = "windows-installation-12345";
const token = "a".repeat(64);
const leaseSecret = "b".repeat(64);
const hash = (s) => createHash("sha256").update(s).digest("hex");

async function fixture(check, { witnessFailure = null, publisherMode = false } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codas-witness-mirror-"));
  let state = emptyWitnessState();
  const signing = generateKeyPairSync("ed25519");
  const recipient = generateKeyPairSync("x25519");
  const sourceFile = path.join(temp, "leader.json");
  const standbyFile = path.join(temp, "follower.json");
  const receiver = createAuthReplicaReceiver({
    issuer, expectedSource: source, localInstallationId: target,
    trustedSigningKey: signing.publicKey,
    recipientPrivateKey: recipient.privateKey,
    store: new AuthReplicaStore({ filePath: standbyFile })
  });
  const requests = [];
  const fakeFetch = async (url, options) => {
    const action = url.split("/").at(-1);
    const payload = JSON.parse(options.body);
    requests.push(action);
    if (action === "publish") {
      const follower = JSON.parse(await readFile(standbyFile, "utf8"));
      assert.equal(follower.checkpoint?.revision, payload.checkpoint.revision,
        "witness must publish only after standby durable COMMIT");
      if (witnessFailure === "before") throw new Error("witness offline");
    }
    const result = applyWitnessAction({
      state, action, actor: source, payload,
      now: Date.now(), ttlMs: 30_000,
      newToken: leaseSecret, newTokenHash: hash(leaseSecret),
      presentedTokenHash: payload.claim ? hash(payload.claim.fencingToken) : undefined
    });
    if (result.changed) state = result.state;
    if (action === "publish" && witnessFailure === "after") {
      throw new Error("witness published, ACK lost");
    }
    return Response.json({ result: result.result });
  };
  const witness = new CloudflareWitnessAuthority({
    endpoint: "https://coordination.example.workers.dev",
    publicDomain: issuer, installationId: source, secret: token,
    fetchImpl: fakeFetch
  });
  const claim = await witness.acquire({ ownerId: source, domain: issuer });
  const writer = new MirroredAuthWriter({
    localAuthority: new LocalRefreshAuthority({ filePath: sourceFile }),
    agentHub: {
      enqueue: async (_id, job) => {
        if (job.type === "auth-replica-checkpoint") {
          return receiver.receive(job.checkpoint);
        }
        if (job.type === "auth-replica-commit") {
          return receiver.commit(job.certificate);
        }
        throw new Error("Unknown Agent job");
      }
    },
    standbyDeviceId: "windows",
    issuer, source, target,
    signingKey: signing.privateKey,
    recipientKey: recipient.publicKey,
    epoch: claim.epoch,
    verifyFence: () => witness.verify(claim),
    ...(publisherMode ? {
      commitPublisher: createWitnessCommitPublisher({
        witness, getClaim: () => claim, installationId: source
      })
    } : { witness, currentClaim: () => claim })
  });
  const refresh = new RefreshTokenRotation({
    authority: writer.namespace("refreshGrants")
  });
  try {
    return await check({
      refresh, writer, witness, requests,
      sourceFile, standbyFile, getState: () => state
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("published checkpoint follows standby commit and precedes OAuth grant success", async () => {
  await fixture(async ({ refresh, sourceFile, standbyFile, witness, requests }) => {
    const initial = await refresh.issue({
      subject: "owner", clientId: "chatgpt-client", resource: issuer + "/mcp"
    });
    const rotated = await refresh.rotate({
      refreshToken: initial.refresh_token,
      clientId: "chatgpt-client", resource: issuer + "/mcp"
    });
    assert.equal(rotated.subject, "owner");
    const sourceState = JSON.parse(await readFile(sourceFile, "utf8"));
    const standbyState = JSON.parse(await readFile(standbyFile, "utf8"));
    const status = await witness.status();
    assert.equal(sourceState.authCommitAckRevision, 2);
    assert.equal(standbyState.checkpoint.revision, 2);
    assert.equal(status.latestCommitted.revision, 2);
    assert.equal(status.latestCommitted.digest, standbyState.checkpoint.digest);
    assert.equal(requests.filter((op) => op === "publish").length, 2);
    assert.equal(await witness.confirmLatestCommitted({
      claim: await witness.renew({
        ownerId: source, epoch: 1, expiresAt: status.leaseExpiresAt,
        fencingToken: leaseSecret
      }),
      installationId: source,
      checkpoint: standbyState.checkpoint
    }), true);
  });
});

for (const failure of ["before", "after"]) {
  test(`witness publish ${failure} commit uncertainty blocks further OAuth writes`, async () => {
    await fixture(async ({
      refresh, sourceFile, standbyFile, getState
    }) => {
      const grant = {
        subject: "owner", clientId: "chatgpt-client", resource: issuer + "/mcp"
      };
      await assert.rejects(refresh.issue(grant), {
        code: "AUTH_STATE_UNAVAILABLE"
      });
      const leader = JSON.parse(await readFile(sourceFile, "utf8"));
      const follower = JSON.parse(await readFile(standbyFile, "utf8"));
      assert.equal(leader.authRevision, 1);
      assert.equal(leader.authCommitAckRevision, undefined,
        "caller cannot treat uncertain external witness as success");
      assert.equal(follower.checkpoint.revision, 1);
      assert.equal(getState().latest?.revision ?? 0,
        failure === "after" ? 1 : 0);
      await assert.rejects(refresh.issue(grant), {
        code: "AUTH_STATE_UNAVAILABLE"
      });
    }, { witnessFailure: failure });
  });
}

test("callback-based witness publisher is not silently ignored or double-published", async () => {
  await fixture(async ({ refresh, witness, requests, sourceFile }) => {
    const issued = await refresh.issue({
      subject: "owner", clientId: "chatgpt-client", resource: issuer + "/mcp"
    });
    assert.equal(issued.refresh_token.length, 64);
    assert.equal(requests.filter((action) => action === "publish").length, 1);
    assert.equal((await witness.status()).latestCommitted.revision, 1);
    const stored = JSON.parse(await readFile(sourceFile, "utf8"));
    assert.equal(stored.authCommitAckRevision, 1);
  }, { publisherMode: true });
});
