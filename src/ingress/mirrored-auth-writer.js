import { sealAuthCheckpoint, sendAuthReplicaCheckpoint } from "./auth-replica-checkpoint.js";

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
  constructor({
    localAuthority, agentHub, standbyDeviceId,
    issuer, source, target, signingKey, recipientKey,
    epoch, verifyFence, clock = () => Date.now(),
    timeoutMs = 10_000
  } = {}) {
    if (typeof localAuthority?.transact !== "function" ||
        typeof agentHub?.enqueue !== "function" ||
        typeof verifyFence !== "function" ||
        typeof standbyDeviceId !== "string" || !standbyDeviceId ||
        !Number.isSafeInteger(epoch) || epoch < 1 ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 ||
        timeoutMs > 60_000) {
      throw new TypeError("Mirrored auth needs durable local state, pinned peer and fencing");
    }
    Object.assign(this, {
      localAuthority, agentHub, standbyDeviceId,
      issuer, source, target, signingKey, recipientKey,
      epoch, verifyFence, clock, timeoutMs
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

  async transact(namespace, change) {
    if (!NAMESPACES.has(namespace) || typeof change !== "function") {
      throw new TypeError("Valid OAuth namespace and mutation required");
    }
    return this.localAuthority.transact(async (local) => {
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
      const priorRevision = local.authRevision ?? 0;
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
        previous: local.lastReplicaDigest ?? null,
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
      local.lastReplicaAckAt = this.clock();
      return result;
    });
  }
}
