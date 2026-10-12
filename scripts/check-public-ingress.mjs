#!/usr/bin/env node
/**
 * Read-only LOCAL v0.3 staging preflight. Never contacts Cloudflare,
 * acquires a lease, prints credentials or modifies a production process.
 *
 * Usage: node scripts/check-public-ingress.mjs CONFIG ID ISSUER
 */
import { loadPublicRequestFenceFromFile } from "../src/ingress/public-request-fence-provisioning.js";

const [filePath, installationId, publicIssuer] = process.argv.slice(2);
if (!filePath || !installationId || !publicIssuer ||
    process.argv.length !== 5) {
  console.error("Usage: node scripts/check-public-ingress.mjs PRIVATE_CONFIG_FILE INSTALLATION_ID HTTPS_ISSUER");
  process.exitCode = 64;
} else {
  try {
    const guard = await loadPublicRequestFenceFromFile({
      filePath, installationId, publicIssuer
    });
    let state = "unavailable";
    try {
      const s = await guard.committedState();
      if (Number.isSafeInteger(s?.revision) && s.revision > 0 &&
          s.pending === false &&
          Number.isSafeInteger(s.confirmedAt) &&
          Date.now() - s.confirmedAt <= 300_000 &&
          s.confirmedAt <= Date.now() + 5_000) {
        state = "locally-committed";
      } else {
        state = "unconfirmed";
      }
    } catch { /* report unavailable, not the private filename */ }
    let claim = "unavailable";
    try {
      const c = await guard.currentClaim();
      claim = c.ownerId === installationId &&
        c.expiresAt > Date.now() ? "locally-present" : "expired";
    } catch { /* no claim is normal for a passive standby */ }
    console.log("CodasSol v0.3 private configuration: valid");
    console.log("Local committed authorization state: " + state);
    console.log("Local lease claim: " + claim);
    console.log("External witness: NOT contacted; real authority and ngrok ownership remain UNVERIFIED");
    if (state !== "locally-committed" || claim !== "locally-present") {
      process.exitCode = 2;
    }
  } catch {
    console.error("CodasSol v0.3 ingress provisioning: invalid or unavailable (no secrets shown)");
    process.exitCode = 1;
  }
}
