/**
 * Per-request public MCP / OAuth authorization fence. ngrok can continue
 * routing traffic to an expired physical Agent after the other Router wins
 * a witness lease. This defense makes the old Router reject requests even
 * while its tunnel is still open.
 *
 * A per-request check is NOT a substitute for ngrok provider-side ownership:
 * it cannot force traffic onto the healthy backend and does not fence an
 * already-running request that began before the lease changed.
 *
 * This is deliberately opt-in. The v0.2 production Router uses its own
 * legacy OAuth and must never be silently upgraded by this file.
 */
function refuse(reason) {
  const error = new Error(reason);
  error.code = "INGRESS_FENCED";
  return error;
}

function freshCommit(snapshot, now, maxAgeMs) {
  return snapshot &&
    !snapshot.pending &&
    Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0 &&
    /^[A-Za-z0-9_-]{43}$/.test(snapshot.digest ?? "") &&
    Number.isSafeInteger(snapshot.confirmedAt) &&
    snapshot.confirmedAt <= now + 5_000 &&
    now - snapshot.confirmedAt <= maxAgeMs;
}

export class PublicRequestFence {
  constructor({
    authority, installationId, publicDomain,
    currentClaim, committedState, clock = () => Date.now(),
    maxAgeMs = 5 * 60_000
  } = {}) {
    const origin = new URL(publicDomain);
    if (!/^[A-Za-z0-9:_-]{12,128}$/.test(installationId ?? "") ||
        origin.protocol !== "https:" || origin.pathname !== "/" ||
        origin.search || origin.hash || origin.username || origin.password ||
        typeof authority?.verify !== "function" ||
        typeof authority?.confirmLatestCommitted !== "function" ||
        typeof currentClaim !== "function" ||
        typeof committedState !== "function" ||
        typeof clock !== "function" ||
        !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000 ||
        maxAgeMs > 300_000) {
      throw new TypeError("Public request fencing needs pinned identity, HTTPS origin and live witness/state readers");
    }
    Object.assign(this, {
      authority, installationId, publicDomain: origin.origin,
      currentClaim, committedState, clock, maxAgeMs
    });
  }

  async authorizeRequest() {
    try {
      const claim = await this.currentClaim();
      const now = this.clock();
      if (claim?.ownerId !== this.installationId ||
          !Number.isSafeInteger(claim.epoch) || claim.epoch <= 0 ||
          !Number.isSafeInteger(claim.expiresAt) ||
          claim.expiresAt <= now ||
          typeof claim.fencingToken !== "string" ||
          claim.fencingToken.length < 16) throw refuse("Invalid active lease");
      const first = await this.committedState();
      if (!freshCommit(first, this.clock(), this.maxAgeMs)) {
        throw refuse("Missing or unconfirmed local committed state");
      }
      // A local commit signature or cached heartbeat is insufficient.
      if (await this.authority.verify(claim) !== true ||
          await this.authority.confirmLatestCommitted({
            claim, installationId: this.installationId,
            checkpoint: { revision: first.revision, digest: first.digest }
          }) !== true ||
          await this.authority.verify(claim) !== true) {
        throw refuse("External witness refused public request");
      }
      // An in-flight local prepare or new commit may have begun while the
      // remote calls ran. No authorization based on a stale local snapshot.
      const second = await this.committedState();
      if (!freshCommit(second, this.clock(), this.maxAgeMs) ||
          second.revision !== first.revision ||
          second.digest !== first.digest ||
          this.clock() >= claim.expiresAt) {
        throw refuse("Auth state changed during witness check");
      }
      return true;
    } catch {
      // Transport timeouts, malformed authority responses, stale state,
      // witness outages and old-owner claims all fail closed.
      throw refuse("Public ingress lease or committed state unavailable");
    }
  }
}

/**
 * Read the leader's durable acknowledged state, not merely a PREPARED
 * replica revision. The local authority's atomic read guarantees the
 * snapshot has not been partially written.
 */
export function createCommittedAuthStateReader(localAuthority) {
  if (typeof localAuthority?.snapshot !== "function") {
    throw new TypeError("A durable, read-only atomic state snapshot is required");
  }
  return async () => {
    const local = await localAuthority.snapshot();
    return {
      revision: local.authRevision,
      digest: local.lastReplicaDigest,
      confirmedAt: local.lastReplicaAckAt,
      pending: local.authCommitAckRevision !== local.authRevision
    };
  };
}

/**
 * Follower-side read adapter. Unlike the active Router, a standby stores
 * signed COMMITTED state in AuthReplicaStore.checkpoint and may still have
 * a PREPARED proposal that has not been published to the external witness.
 * Never accept the standby's pending proposal for public authorization.
 */
export function createFollowerCommittedAuthStateReader(replicaStore) {
  if (typeof replicaStore?.authority?.snapshot !== "function") {
    throw new TypeError("An atomic follower replica snapshot reader is required");
  }
  return async () => {
    const state = await replicaStore.authority.snapshot();
    return {
      revision: state.checkpoint?.revision,
      digest: state.checkpoint?.digest,
      confirmedAt: state.lastReplicaAckAt,
      pending: Boolean(state.pending)
    };
  };
}
