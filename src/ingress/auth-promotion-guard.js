/**
 * Bridges committed OAuth state verification to the IngressManager's
 * pre-activation gate. Both callbacks MUST consult the authoritative,
 * externally fenced control plane, not peer heartbeats or local disk.
 *
 * This does NOT implement a distributed lease or prove ngrok uniqueness.
 * Without those real implementations, keep production activation disabled.
 */
export function createAuthPromotionGuard({
  replicaStore, authority, clock = () => Date.now(),
  maxAgeMs = 300_000
} = {}) {
  if (typeof replicaStore?.preflightPromotion !== "function" ||
      typeof authority?.verify !== "function" ||
      typeof authority?.confirmLatestCommitted !== "function") {
    throw new TypeError("Promotion requires replica store and independent external authority");
  }
  return async ({ claim, domain, installationId }) => {
    if (!claim || claim.ownerId !== installationId ||
        typeof domain !== "string" || !domain.startsWith("https://")) {
      return false;
    }
    try {
      await replicaStore.preflightPromotion({
        clock, maxAgeMs,
        verifyFencedClaim: () => authority.verify(claim),
        confirmLatestCommitted: (checkpoint) =>
          authority.confirmLatestCommitted({
            claim, domain, installationId, checkpoint
          })
      });
      return true;
    } catch {
      return false;
    }
  };
}
