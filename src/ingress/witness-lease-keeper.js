import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, lstat, rename, unlink } from "node:fs/promises";
import path from "node:path";

function unavailable(message) {
  const error = new Error(message);
  error.code = "WITNESS_LEASE_UNAVAILABLE";
  return error;
}

const validClaim = (claim, installationId) =>
  claim?.ownerId === installationId &&
  Number.isSafeInteger(claim.epoch) && claim.epoch > 0 &&
  Number.isSafeInteger(claim.expiresAt) &&
  typeof claim.fencingToken === "string" &&
  claim.fencingToken.length >= 32 &&
  claim.fencingToken.length <= 256;

/**
 * One-machine, explicit lease lifecycle. This does NOT open a tunnel, start
 * a Router, switch ingress, or prove ngrok's data-plane exclusivity.
 *
 * Calls must be scheduled by a separate supervised process. No automatic
 * reacquisition after an ambiguous response; operators must reconcile
 * the existing lease before reattempting.
 */
export class WitnessLeaseKeeper {
  constructor({
    authority, installationId, domain, claimFile,
    clock = () => Date.now()
  } = {}) {
    if (typeof authority?.acquire !== "function" ||
        typeof authority?.renew !== "function" ||
        typeof authority?.release !== "function" ||
        !/^[A-Za-z0-9:_-]{12,128}$/.test(installationId ?? "") ||
        typeof domain !== "string" || !domain.startsWith("https://") ||
        typeof claimFile !== "string" || !path.isAbsolute(claimFile) ||
        typeof clock !== "function") {
      throw new TypeError("Lease keeper needs a pinned witness, immutable installation ID and private file");
    }
    Object.assign(this, { authority, installationId, domain, claimFile, clock });
    this.lockFile = claimFile + ".lock";
  }

  async #withLock(action) {
    await mkdir(path.dirname(this.claimFile), { mode: 0o700, recursive: true });
    // Refuse an uncertain/stale lock rather than silently overriding a
    // potentially concurrent or crashed claimant.
    let lock;
    try {
      lock = await open(this.lockFile, "wx", 0o600);
    } catch {
      throw unavailable("Lease management already active or requires recovery");
    }
    try { return await action(); }
    finally {
      await lock.close();
      await unlink(this.lockFile);
    }
  }

  async #readClaim() {
    try {
      const st = await lstat(this.claimFile);
      if (!st.isFile() || st.size > 2048 || st.size < 30 ||
          (process.platform !== "win32" && (st.mode & 0o077) !== 0)) {
        throw unavailable("Unsafe private claim file");
      }
      const data = JSON.parse(await readFile(this.claimFile, "utf8"));
      if (!validClaim(data, this.installationId)) {
        throw unavailable("Claim identity or token malformed");
      }
      return data;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw unavailable("Local lease claim unavailable");
    }
  }

  async #saveClaim(claim) {
    if (!validClaim(claim, this.installationId) ||
        claim.expiresAt <= this.clock()) {
      throw unavailable("Witness returned invalid or expired claim");
    }
    const tmp = this.claimFile + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      const file = await open(tmp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(claim) + "\n");
        await file.sync();
      } finally { await file.close(); }
      await rename(tmp, this.claimFile);
      try {
        const dir = await open(path.dirname(this.claimFile), "r");
        try { await dir.sync(); } finally { await dir.close(); }
      } catch { /* best effort on platforms without directory fsync */ }
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  async #invalidate() {
    // A revoked/unknown claim must never be left active locally.
    await unlink(this.claimFile).catch((error) => {
      if (error.code !== "ENOENT") throw unavailable("Could not invalidate local claim");
    });
    // The claim is security-sensitive: try to durably record its deletion
    // so a power loss does not restore a previously valid local bearer.
    try {
      const dir = await open(path.dirname(this.claimFile), "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { /* directory fsync is unavailable on some platforms */ }
  }

  async acquireOnce() {
    return this.#withLock(async () => {
      // Existing claim, EVEN EXPIRED, requires explicit reconciliation.
      // Never silently overwrite an uncertain lease epoch after a crash.
      if (await this.#readClaim()) throw unavailable("Existing lease requires reconciliation");
      let claim;
      try {
        claim = await this.authority.acquire({
          ownerId: this.installationId, domain: this.domain
        });
      } catch {
        throw unavailable("External witness unavailable or acquisition ambiguous");
      }
      if (!claim) return null; // another owner has the exclusive claim
      await this.#saveClaim(claim);
      return { epoch: claim.epoch, expiresAt: claim.expiresAt };
    });
  }

  async renewOnce() {
    return this.#withLock(async () => {
      const previous = await this.#readClaim();
      if (!previous || previous.expiresAt <= this.clock()) {
        await this.#invalidate();
        throw unavailable("Cannot renew an absent or expired lease");
      }
      let next;
      try {
        next = await this.authority.renew(previous);
      } catch {
        await this.#invalidate();
        throw unavailable("External renewal uncertain; local lease invalidated");
      }
      if (!next || !validClaim(next, this.installationId) ||
          next.epoch !== previous.epoch ||
          next.fencingToken !== previous.fencingToken ||
          next.expiresAt <= previous.expiresAt) {
        await this.#invalidate();
        throw unavailable("External lease was lost or renewal identity changed");
      }
      try {
        await this.#saveClaim(next);
      } catch {
        await this.#invalidate();
        throw unavailable("Renewed claim could not be committed locally");
      }
      return { epoch: next.epoch, expiresAt: next.expiresAt };
    });
  }

  async releaseOnce() {
    return this.#withLock(async () => {
      const claim = await this.#readClaim();
      if (!claim) return false;
      // Fail locally FIRST. The public request fence will immediately
      // reject even if the external release call fails.
      await this.#invalidate();
      try {
        await this.authority.release(claim);
      } catch {
        throw unavailable("Local claim invalidated; external release uncertain");
      }
      return true;
    });
  }
}
