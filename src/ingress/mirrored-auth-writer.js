import {
  sealAuthCheckpoint, sealAuthCommit,
  sendAuthReplicaCheckpoint, sendAuthReplicaCommit
} from "./auth-replica-checkpoint.js";

const NAMESPACES = new Set(["refreshGrants", "oauthClients", "revocations"]);
const empty = () => ({ records: {} });

function unavailable(reason) {
  const error = new Error(reason);
  error.code = "AUTH_STATE_UNAVAILABLE";
  return error;
}

/**
 * A single writer coordinating a local durable transaction with a passive
 * peer checkpoint. A grant is not returned to the OAuth caller before the
 * standby has durably acknowledged its complete proposed state.
 *
 * The checkpoint is deliberately persisted on the PASSIVE node first.
 * If the source crashes before committing locally, the passive state might
 * be ahead. On recovery the source will hit a chain mismatch and MUST stop
 * issuing new tokens until an authorized reconciliation. No rollback.
 *
 * This is a tested synchronously mirrored WRITE BUILDING BLOCK, not a
 * distributed consensus/fencing implementation. A verified external
 * exclusive lease and a conservative promotion protocol are prerequisites
 * for live use. No automatic retry of ambiguous writes is permitted.
 */
export class MirroredAuthWriter {
  #serialized = Promise.resolve();
  constructor({
    localAuthority, agentHub, standbyDeviceId,
    issuer, source, target, signingKey, recipientKey,
    epoch, verifyFence, clock = () => Date.now(),
    witness = null, currentClaim = null,
    commitPublisher = null, requireExternalCommit = false,
    timeoutMs = 10_000
  } = {}) {
    if (typeof localAuthority?.transact !== "function" ||
        typeof agentHub?.enqueue !== "function" ||
        typeof verifyFence !== "function" ||
        typeof standbyDeviceId !== "string" || !standbyDeviceId ||
        !Number.isSafeInteger(epoch) || epoch < 1 ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 ||
        timeoutMs > 60_000 ||
        (witness !== null && (
          typeof witness.publishCommitted !== "function" ||
          typeof witness.confirmLatestCommitted !== "function" ||
          typeof currentClaim !== "function")) ||
        (witness === null && currentClaim !== null) ||
        (commitPublisher !== null &&
          typeof commitPublisher !== "function") ||
        (witness !== null && commitPublisher !== null) ||
        typeof requireExternalCommit !== "boolean" ||
        (requireExternalCommit && witness === null &&
          commitPublisher === null)) {
      throw new TypeError("Mirrored auth needs durable local state, pinned peer and fencing");
    }
    Object.assign(this, {
      localAuthority, agentHub, standbyDeviceId,
      issuer, source, target, signingKey, recipientKey,
      epoch, verifyFence, clock, timeoutMs, witness, currentClaim,
      commitPublisher, requireExternalCommit
    });
    // A caller cannot treat mirroring alone as distributed consensus.
    this.distributedSafe = false;
  }

  namespace(name) {
    if (!NAMESPACES.has(name)) throw new TypeError("Invalid OAuth namespace");
    return {
      distributedSafe: false,
      transact: (change) => this.transact(name, change)
    };
  }

  /**
   * Refresh authorization-state liveness even when no grant has changed.
   * Call through an explicitly configured service scheduler, never by
   * blindly changing updatedAt on the standby. It performs a full fenced,
   * durably acknowledged checkpoint and therefore consumes an SSE task
   * result POST; it must be quota-budgeted.
   */
  async attestUnchangedState() {
    return this.transact("revocations", () => ({ attested: true }));
  }

  transact(namespace, change) {
    if (!NAMESPACES.has(namespace) || typeof change !== "function") {
      throw new TypeError("Valid OAuth namespace and mutation required");
    }
    // Serialization spans BOTH the prepare and signed commit phases. A
    // local file lock alone is too short: it is released before the peer
    // can confirm the commit and mark the leader's ACK durable.
    const pending = this.#serialized.then(() => this.#transact(namespace, change));
    this.#serialized = pending.catch(() => {});
    return pending;
  }

  async #transact(namespace, change) {
    const prepared = await this.localAuthority.transact(async (local) => {
      if (await this.verifyFence(this.epoch) !== true) {
        throw unavailable("No externally verified exclusive ingress writer");
      }
      // Do not silently discard grants from an older single-host store.
      // Upgrades require explicit, audited, fenced state migration.
      if ((local.authRevision == null &&
          Object.keys(local.records || {}).length > 0) ||
          (local.authRevision != null && (
            !Number.isSafeInteger(local.authRevision) ||
            local.authRevision < 1 ||
            !local.namespaces || !local.lastReplicaDigest))) {
        throw unavailable("Auth state migration or repair required");
      }
      if (local.authRevision && local.authCommitAckRevision !== local.authRevision) {
        throw unavailable("A previous replica commit remains unconfirmed");
      }
      const priorRevision = local.authRevision ?? 0;
      const previousDigest = local.lastReplicaDigest ?? null;
      const revision = priorRevision + 1;
      const namespaces = structuredClone(local.namespaces || {
        refreshGrants: empty(), oauthClients: empty(), revocations: empty()
      });
      for (const name of NAMESPACES) namespaces[name] ||= empty();
      const result = await change(namespaces[namespace]);
      const checkpoint = sealAuthCheckpoint({
        issuer: this.issuer, source: this.source, target: this.target,
        signingKey: this.signingKey, recipientKey: this.recipientKey,
        epoch: this.epoch, revision,
        previous: previousDigest,
        state: { version: 1, namespaces },
        clock: this.clock
      });
      let ack;
      try {
        ack = await sendAuthReplicaCheckpoint({
          agentHub: this.agentHub, deviceId: this.standbyDeviceId,
          checkpoint, timeoutMs: this.timeoutMs
        });
      } catch {
        // ACK may have been lost after the replica persisted. Never
        // retry here or save the unacknowledged leader-side mutation.
        throw unavailable("Replica commit acknowledgement missing or ambiguous");
      }
      if (await this.verifyFence(this.epoch) !== true) {
        throw unavailable("Writer lost external fencing before local commit");
      }
      local.namespaces = namespaces;
      local.authRevision = revision;
      local.lastReplicaDigest = ack.digest;
      // Do not report this as acknowledged/servable yet. The passive
      // snapshot is only PREPARED until a post-commit certificate arrives.
      return { result, revision, digest: ack.digest, previousDigest };
    });
    if (await this.verifyFence(this.epoch) !== true) {
      throw unavailable("Writer lost external fencing after local commit");
    }
    // This signature cannot exist until the local durable transaction
    // above has returned. A standby MUST NOT promote mere prepared data.
    const certificate = sealAuthCommit({
      issuer: this.issuer, source: this.source, target: this.target,
      epoch: this.epoch, revision: prepared.revision,
      digest: prepared.digest, signingKey: this.signingKey,
      clock: this.clock
    });
    try {
      await sendAuthReplicaCommit({
        agentHub: this.agentHub, deviceId: this.standbyDeviceId,
        certificate, timeoutMs: this.timeoutMs
      });
      if (await this.verifyFence(this.epoch) !== true) {
        throw unavailable("Writer lost external fencing before commit acknowledgment");
      }
      // Optional external latest-commit witness. This is intentionally
      // published ONLY after the standby has durably committed the signed
      // checkpoint. A lost witness ACK is ambiguous and must freeze writes.
      if (this.witness) {
        const claim = await this.currentClaim();
        if (!claim || claim.ownerId !== this.source ||
            claim.epoch !== this.epoch) {
          throw unavailable("Writer has no matching external witness claim");
        }
        const published = await this.witness.publishCommitted({
          claim, checkpoint: {
            revision: prepared.revision, digest: prepared.digest,
            previous: prepared.previousDigest
          }
        });
        if (published !== true) {
          throw unavailable("Witness refused committed revision");
        }
        if (await this.witness.confirmLatestCommitted({
          claim, installationId: this.source,
          checkpoint: {
            revision: prepared.revision, digest: prepared.digest
          }
        }) !== true) {
          throw unavailable("Latest committed witness proof missing");
        }
        if (await this.verifyFence(this.epoch) !== true) {
          throw unavailable("Writer lost external fencing after witness publication");
        }
      }
      // The witness records an AUTHORITATIVE latest committed digest only
      // after the standby has independently verified the signed COMMIT.
      // An absent/ambiguous witness response never returns a refresh token.
      if (this.commitPublisher) {
        const published = await this.commitPublisher({
          epoch: this.epoch, revision: prepared.revision,
          digest: prepared.digest, previous: prepared.previousDigest
        });
        if (published !== true) {
          throw unavailable("External latest-commit publication was refused");
        }
        if (await this.verifyFence(this.epoch) !== true) {
          throw unavailable("Writer lost fencing after witness publication");
        }
      }
      await this.localAuthority.transact((local) => {
        if (local.authRevision !== prepared.revision ||
            local.lastReplicaDigest !== prepared.digest ||
            local.authCommitAckRevision >= prepared.revision) {
          throw unavailable("Source commit acknowledgement state conflicts");
        }
        local.authCommitAckRevision = prepared.revision;
        local.lastReplicaAckAt = this.clock();
      });
    } catch {
      // Commit may have arrived but ACK was lost. Never retry blindly and
      // never return a refresh token from an uncertain transaction.
      throw unavailable("Replica commit phase is uncertain; recovery required");
    }
    return prepared.result;
  }
}
