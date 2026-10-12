import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AuthReplicaStore, createAuthReplicaReceiver
} from "../src/ingress/auth-replica-checkpoint.js";
import { MirroredAuthWriter } from "../src/ingress/mirrored-auth-writer.js";
import { LocalRefreshAuthority } from "../src/ingress/local-refresh-authority.js";
import { RefreshTokenRotation } from "../src/ingress/refresh-token-rotation.js";
import { OAuthDynamicClients } from "../src/ingress/oauth-dynamic-clients.js";

const issuer = "https://fixed.ngrok-free.app";
const mac = "mac-installation-12345";
const windows = "windows-installation-12345";
const signer = generateKeyPairSync("ed25519");
const recipient = generateKeyPairSync("x25519");

async function fixture(testFn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codas-sync-auth-"));
  try {
    const sourceFile = path.join(dir, "mac-auth.json");
    const standbyFile = path.join(dir, "windows-auth.json");
    const standby = new AuthReplicaStore({ filePath: standbyFile });
    const receiver = createAuthReplicaReceiver({
      issuer, expectedSource: mac,
      localInstallationId: windows,
      trustedSigningKey: signer.publicKey,
      recipientPrivateKey: recipient.privateKey, store: standby
    });
    const createWriter = ({
      agentHub = { enqueue: (_id, task) => task.type === "auth-replica-commit"
        ? receiver.commit(task.certificate)
        : receiver.receive(task.checkpoint) },
      verifyFence = async () => true,
      commitPublisher = null, requireExternalCommit = false
    } = {}) => new MirroredAuthWriter({
      localAuthority: new LocalRefreshAuthority({ filePath: sourceFile }),
      agentHub, standbyDeviceId: "windows",
      issuer, source: mac, target: windows,
      signingKey: signer.privateKey, recipientKey: recipient.publicKey,
      epoch: 4, verifyFence, commitPublisher, requireExternalCommit
    });
    await testFn({ sourceFile, standbyFile, createWriter, receiver });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("OAuth refresh and client registration are mirrored before a grant is returned", async () => {
  await fixture(async ({ sourceFile, standbyFile, createWriter }) => {
    const writer = createWriter();
    const grants = new RefreshTokenRotation({
      authority: writer.namespace("refreshGrants")
    });
    const clients = new OAuthDynamicClients({
      authority: writer.namespace("oauthClients")
    });
    const initial = await grants.issue({
      subject: "owner", clientId: "chatgpt-client",
      resource: issuer + "/mcp"
    });
    const registered = await clients.register({
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/oauth/callback"]
    });
    const rotated = await grants.rotate({
      refreshToken: initial.refresh_token,
      clientId: "chatgpt-client", resource: issuer + "/mcp"
    });
    assert.ok(rotated.refresh_token);
    const source = JSON.parse(await readFile(sourceFile, "utf8"));
    const backup = JSON.parse(await readFile(standbyFile, "utf8"));
    assert.equal(source.authRevision, 3);
    assert.equal(backup.checkpoint.revision, 3);
    assert.equal(backup.pending, null);
    assert.equal(source.lastReplicaDigest, backup.checkpoint.digest);
    assert.equal(source.authCommitAckRevision, 3);
    assert.deepEqual(source.namespaces, backup.namespaces);
    assert.equal(Object.keys(backup.namespaces.refreshGrants.records).length, 2);
    assert.equal(backup.namespaces.oauthClients.records[registered.client_id].client_name,
      "ChatGPT");
    assert.ok(!JSON.stringify(backup).includes(initial.refresh_token));
    assert.ok(!JSON.stringify(backup).includes(rotated.refresh_token));
    assert.equal(writer.distributedSafe, false,
      "mirroring does not grant external consensus/fencing");
  });
});

test("a standby outage rejects issuance without committing a local grant", async () => {
  await fixture(async ({ sourceFile, createWriter }) => {
    const writer = createWriter({
      agentHub: { enqueue: async () => { throw new Error("Agent offline"); } }
    });
    const grants = new RefreshTokenRotation({
      authority: writer.namespace("refreshGrants")
    });
    await assert.rejects(grants.issue({
      subject: "owner", clientId: "chatgpt-client",
      resource: issuer + "/mcp"
    }), { code: "AUTH_STATE_UNAVAILABLE" });
    await assert.rejects(readFile(sourceFile, "utf8"),
      { code: "ENOENT" });
  });
});

test("lost ACK after durable standby write enters a fail-closed uncertainty state", async () => {
  await fixture(async ({ sourceFile, standbyFile, createWriter, receiver }) => {
    let sent = 0;
    const writer = createWriter({
      agentHub: { enqueue: async (_id, job) => {
        ++sent;
        // Transport failed AFTER the follower committed the checkpoint.
        await receiver.receive(job.checkpoint);
        throw new Error("ACK lost");
      } }
    });
    const grants = new RefreshTokenRotation({
      authority: writer.namespace("refreshGrants")
    });
    await assert.rejects(grants.issue({
      subject: "owner", clientId: "chatgpt-client",
      resource: issuer + "/mcp"
    }), { code: "AUTH_STATE_UNAVAILABLE" });
    assert.equal(sent, 1);
    await assert.rejects(readFile(sourceFile, "utf8"), { code: "ENOENT" });
    const follower = JSON.parse(await readFile(standbyFile, "utf8"));
    assert.equal(follower.pending.revision, 1);
    assert.equal(follower.checkpoint, undefined);
    assert.equal(follower.namespaces, undefined,
      "an unsigned/uncommitted pending state must not authorize tokens");
    // The next attempt cannot overwrite the standby's higher revision. This
    // requires manual/authoritative reconciliation before resuming writes.
    await assert.rejects(grants.issue({
      subject: "owner", clientId: "chatgpt-client",
      resource: issuer + "/mcp"
    }), { code: "AUTH_STATE_UNAVAILABLE" });
  });
});

test("losing external lease prevents a write, including loss after standby ACK", async () => {
  await fixture(async ({ createWriter, standbyFile }) => {
    let checks = 0;
    const writer = createWriter({
      verifyFence: async () => ++checks === 1
    });
    const grant = new RefreshTokenRotation({
      authority: writer.namespace("refreshGrants")
    });
    await assert.rejects(grant.issue({
      subject: "owner", clientId: "chatgpt-client", resource: issuer + "/mcp"
    }), { code: "AUTH_STATE_UNAVAILABLE" });
    assert.equal(checks, 2);
    assert.equal(JSON.parse(await readFile(standbyFile, "utf8"))
      .pending.revision, 1);
  });
});

test("two concurrent grant mutations serialize to consecutive, validated snapshots", async () => {
  await fixture(async ({ createWriter, standbyFile }) => {
    const writer = createWriter();
    const grants = new RefreshTokenRotation({
      authority: writer.namespace("refreshGrants")
    });
    const issued = await Promise.all([
      grants.issue({ subject: "owner-1", clientId: "chatgpt-client", resource: issuer + "/mcp" }),
      grants.issue({ subject: "owner-2", clientId: "chatgpt-client", resource: issuer + "/mcp" })
    ]);
    assert.notEqual(issued[0].refresh_token, issued[1].refresh_token);
    assert.equal(JSON.parse(await readFile(standbyFile, "utf8"))
      .checkpoint.revision, 2);
  });
});

test("mirrored writer refuses to silently replace existing single-host OAuth grants", async () => {
  await fixture(async ({ sourceFile, createWriter }) => {
    const legacy = new LocalRefreshAuthority({ filePath: sourceFile });
    await legacy.transact((state) => {
      state.records["existing-grant"] = {
        subject: "owner", status: "active"
      };
    });
    const writer = createWriter();
    const rotation = new RefreshTokenRotation({
      authority: writer.namespace("refreshGrants")
    });
    await assert.rejects(rotation.issue({
      subject: "owner", clientId: "chatgpt-client",
      resource: issuer + "/mcp"
    }), { code: "AUTH_STATE_UNAVAILABLE" });
    assert.ok(JSON.parse(await readFile(sourceFile, "utf8"))
      .records["existing-grant"], "legacy grant must remain untouched");
  });
});

test("unchanged OAuth state receives a new, durable acknowledgement without fabricated revocations", async () => {
  await fixture(async ({ createWriter, sourceFile, standbyFile }) => {
    const writer = createWriter();
    assert.deepEqual(await writer.attestUnchangedState(), { attested: true });
    assert.deepEqual(await writer.attestUnchangedState(), { attested: true });
    const source = JSON.parse(await readFile(sourceFile, "utf8"));
    const backup = JSON.parse(await readFile(standbyFile, "utf8"));
    assert.equal(source.authRevision, 2);
    assert.equal(backup.checkpoint.revision, 2);
    assert.equal(source.lastReplicaDigest, backup.checkpoint.digest);
    assert.deepEqual(source.namespaces.revocations.records, {});
    assert.deepEqual(backup.namespaces.revocations.records, {});
    assert.ok(Date.now() - backup.lastReplicaAckAt < 3_000);
  });
});

test("crash after local durable write but before commit certificate cannot promote prepared grant", async () => {
  await fixture(async ({ createWriter, sourceFile, standbyFile }) => {
    let fences = 0;
    const writer = createWriter({
      verifyFence: async () => ++fences <= 2
    });
    const grants = new RefreshTokenRotation({
      authority: writer.namespace("refreshGrants")
    });
    await assert.rejects(grants.issue({
      subject: "owner", clientId: "chatgpt-client",
      resource: issuer + "/mcp"
    }), { code: "AUTH_STATE_UNAVAILABLE" });
    const source = JSON.parse(await readFile(sourceFile, "utf8"));
    const standby = JSON.parse(await readFile(standbyFile, "utf8"));
    assert.equal(source.authRevision, 1);
    assert.equal(source.authCommitAckRevision, undefined);
    assert.equal(standby.pending.revision, 1);
    assert.equal(standby.checkpoint, undefined);
    await assert.rejects(writer.attestUnchangedState(), {
      code: "AUTH_STATE_UNAVAILABLE"
    });
  });
});

test("lost COMMIT receipt is fail-closed even if standby already committed", async () => {
  await fixture(async ({ createWriter, sourceFile, standbyFile, receiver }) => {
    const writer = createWriter({
      agentHub: { enqueue: async (_id, job) => {
        if (job.type === "auth-replica-checkpoint") {
          return receiver.receive(job.checkpoint);
        }
        await receiver.commit(job.certificate);
        throw new Error("commit ACK lost");
      } }
    });
    const grants = new RefreshTokenRotation({
      authority: writer.namespace("refreshGrants")
    });
    await assert.rejects(grants.issue({
      subject: "owner", clientId: "chatgpt-client",
      resource: issuer + "/mcp"
    }), { code: "AUTH_STATE_UNAVAILABLE" });
    const source = JSON.parse(await readFile(sourceFile, "utf8"));
    const follower = JSON.parse(await readFile(standbyFile, "utf8"));
    assert.equal(source.authRevision, 1);
    assert.equal(source.authCommitAckRevision, undefined);
    assert.equal(follower.checkpoint.revision, 1);
    assert.equal(follower.pending, null);
    // Subsequent writes do not continue until an authorized reconciliation.
    await assert.rejects(grants.issue({
      subject: "owner", clientId: "chatgpt-client",
      resource: issuer + "/mcp"
    }), { code: "AUTH_STATE_UNAVAILABLE" });
  });
});

test("external witness publication follows standby COMMIT and precedes successful OAuth return", async () => {
  await fixture(async ({ sourceFile, standbyFile, createWriter }) => {
    const observed = [];
    const writer = createWriter({
      requireExternalCommit: true,
      commitPublisher: async (revision) => {
        const leader = JSON.parse(await readFile(sourceFile, "utf8"));
        const standby = JSON.parse(await readFile(standbyFile, "utf8"));
        assert.equal(standby.pending, null);
        assert.equal(standby.checkpoint.revision, revision.revision);
        assert.equal(leader.authRevision, revision.revision);
        assert.equal(leader.authCommitAckRevision, undefined);
        assert.equal(revision.digest, standby.checkpoint.digest);
        assert.equal(revision.previous, null);
        observed.push(revision.revision);
        return true;
      }
    });
    const grant = new RefreshTokenRotation({
      authority: writer.namespace("refreshGrants")
    });
    const issued = await grant.issue({
      subject: "owner", clientId: "chatgpt-client", resource: issuer + "/mcp"
    });
    assert.equal(issued.refresh_token.length, 64);
    assert.deepEqual(observed, [1]);
    assert.equal(JSON.parse(await readFile(sourceFile, "utf8"))
      .authCommitAckRevision, 1);
  });
});

test("external witness outage stops issuance after durable standby COMMIT without auto-retry", async () => {
  await fixture(async ({ sourceFile, standbyFile, createWriter }) => {
    let requests = 0;
    const writer = createWriter({
      requireExternalCommit: true,
      commitPublisher: async () => { requests++; return false; }
    });
    const grants = new RefreshTokenRotation({
      authority: writer.namespace("refreshGrants")
    });
    await assert.rejects(grants.issue({
      subject: "owner", clientId: "chatgpt-client",
      resource: issuer + "/mcp"
    }), { code: "AUTH_STATE_UNAVAILABLE" });
    assert.equal(requests, 1);
    assert.equal(JSON.parse(await readFile(sourceFile, "utf8")).authRevision, 1);
    assert.equal(JSON.parse(await readFile(sourceFile, "utf8"))
      .authCommitAckRevision, undefined);
    assert.equal(JSON.parse(await readFile(standbyFile, "utf8"))
      .checkpoint.revision, 1);
    await assert.rejects(grants.issue({
      subject: "owner", clientId: "chatgpt-client",
      resource: issuer + "/mcp"
    }), { code: "AUTH_STATE_UNAVAILABLE" });
    assert.equal(requests, 1, "uncertain publication must not be replayed");
  });
});

test("requiring an external witness rejects missing publisher at construction", async () => {
  await fixture(async ({ createWriter }) => {
    assert.throws(() => createWriter({
      requireExternalCommit: true, commitPublisher: null
    }), /durable local state/);
  });
});
