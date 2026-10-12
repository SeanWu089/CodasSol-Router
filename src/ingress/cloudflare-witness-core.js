/**
 * Transaction-only state machine for an independent ingress/OAuth witness.
 *
 * Caller MUST authenticate the installation identity and persist the returned
 * state atomically. Neither this module nor the witness fences ngrok traffic.
 * Never use a local-process or eventually consistent store for this state.
 */
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9:_-]{12,128}$/;
const ACTIONS = new Set(["acquire", "verify", "renew", "release", "publish", "confirm", "status"]);

export function emptyWitnessState() {
  return { version: 1, epoch: 0, lease: null, latest: null, domain: null };
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_WITNESS_REQUEST" });
}

function validClaim(state, actor, claim, tokenHash, now) {
  const current = state.lease;
  return !!current && current.ownerId === actor &&
    claim?.ownerId === actor && claim?.epoch === current.epoch &&
    typeof tokenHash === "string" && tokenHash === current.tokenHash &&
    current.expiresAt > now;
}

export function applyWitnessAction({
  state, action, actor, payload = {}, now, ttlMs = 30_000,
  newToken, newTokenHash, presentedTokenHash
}) {
  if (!ACTIONS.has(action) || !ID.test(actor ?? "") ||
      !Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) ||
      ttlMs < 5_000 || ttlMs > 60_000 ||
      !state || state.version !== 1 ||
      !Number.isSafeInteger(state.epoch) || state.epoch < 0) {
    throw invalid("Invalid action, actor, clock or witness state");
  }
  const unchanged = (result) => ({ state, result, changed: false });
  if (action === "status") {
    return unchanged({
      epoch: state.epoch,
      ownerId: state.lease?.ownerId ?? null,
      leaseExpiresAt: state.lease?.expiresAt ?? null,
      latestCommitted: state.latest ?? null
    });
  }
  if (action === "acquire") {
    if (payload.ownerId !== actor) throw invalid("Wrong installation");
    if (typeof payload.domain !== "string" ||
        !/^https:\/\/[a-z0-9.-]+(?::443)?$/.test(payload.domain) ||
        (state.domain !== null && state.domain !== payload.domain)) {
      throw invalid("Witness domain is not the pinned public origin");
    }
    if (state.lease?.expiresAt > now) return unchanged(null);
    if (!Number.isSafeInteger(state.epoch + 1) ||
        typeof newToken !== "string" || newToken.length < 32 ||
        !HASH.test(newTokenHash ?? "")) throw invalid("Invalid lease token");
    const epoch = state.epoch + 1;
    const expiresAt = now + ttlMs;
    return {
      state: { ...state, domain: payload.domain, epoch, lease: {
        ownerId: actor, epoch, expiresAt, tokenHash: newTokenHash
      } },
      result: { ownerId: actor, epoch, expiresAt, fencingToken: newToken },
      changed: true
    };
  }
  const claim = payload.claim;
  const valid = validClaim(state, actor, claim, presentedTokenHash, now);
  if (action === "verify") return unchanged(valid);
  if (action === "confirm") {
    const checkpoint = payload.checkpoint;
    return unchanged(valid && Number.isSafeInteger(checkpoint?.revision) &&
      checkpoint?.revision === state.latest?.revision &&
      checkpoint?.digest === state.latest?.digest);
  }
  if (!valid) {
    if (action === "renew") return unchanged(null);
    return unchanged(false);
  }
  if (action === "renew") {
    const lease = { ...state.lease, expiresAt: now + ttlMs };
    return {
      state: { ...state, lease }, changed: true,
      result: { ownerId: actor, epoch: lease.epoch,
        expiresAt: lease.expiresAt, fencingToken: claim.fencingToken }
    };
  }
  if (action === "release") {
    return { state: { ...state, lease: null }, changed: true, result: true };
  }
  if (action === "publish") {
    const checkpoint = payload.checkpoint;
    const previous = state.latest;
    if (!Number.isSafeInteger(checkpoint?.revision) ||
        checkpoint.revision < 1 || !DIGEST.test(checkpoint?.digest ?? "") ||
        checkpoint.previous !== (previous?.digest ?? null) ||
        checkpoint.revision !== (previous?.revision ?? 0) + 1) {
      return unchanged(false);
    }
    // The revision chain is global: changing the lease epoch never resets it.
    return {
      state: { ...state, latest: {
        revision: checkpoint.revision, digest: checkpoint.digest,
        epoch: state.lease.epoch, updatedAt: now
      } }, changed: true, result: true
    };
  }
  throw invalid("Unsupported witness action");
}
