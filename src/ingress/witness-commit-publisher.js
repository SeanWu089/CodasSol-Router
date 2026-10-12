/**
 * Adapt a separately hosted witness to MirroredAuthWriter's post-commit
 * callback. The witness MUST NOT be used as ngrok data-plane fencing.
 *
 * Caller must inject its current, externally verifiable claim. No implicit
 * fallback to a local process lease, peer heartbeat or stale cached claim.
 */
export function createWitnessCommitPublisher({
  witness, getClaim, installationId
} = {}) {
  if (typeof witness?.publishCommitted !== "function" ||
      typeof witness?.confirmLatestCommitted !== "function" ||
      typeof witness?.verify !== "function" ||
      typeof getClaim !== "function" ||
      typeof installationId !== "string" || !installationId) {
    throw new TypeError("External witness and current fenced claim are required");
  }
  return async ({ epoch, revision, digest, previous }) => {
    const claim = await getClaim();
    if (claim?.ownerId !== installationId ||
        claim.epoch !== epoch ||
        await witness.verify(claim) !== true) return false;
    const checkpoint = { revision, digest, previous };
    // The witness must confirm the exact committed revision. A transport
    // error is AMBIGUOUS and must not trigger automatic re-publish.
    if (await witness.publishCommitted({ claim, checkpoint }) !== true) {
      return false;
    }
    if (await witness.verify(claim) !== true) return false;
    return await witness.confirmLatestCommitted({
      claim, installationId, checkpoint
    }) === true;
  };
}
