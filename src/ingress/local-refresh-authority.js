import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Single-machine disk authority ONLY. Lock file is deliberately NOT
 * force-removed when stale: crash ambiguity must fail closed.
 * This is not a distributed lock, even on a network-mounted filesystem.
 */
export class LocalRefreshAuthority {
  constructor({ filePath, lockWaitMs = 1500 } = {}) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath) ||
        !Number.isInteger(lockWaitMs) || lockWaitMs < 0 ||
        lockWaitMs > 10_000) {
      throw new TypeError("Absolute state file and bounded lock timeout required");
    }
    this.filePath = filePath;
    this.lockFile = filePath + ".lock";
    this.lockWaitMs = lockWaitMs;
    this.distributedSafe = false;
  }

  async transact(change) {
    if (typeof change !== "function") throw new TypeError("Mutation function required");
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const start = Date.now();
    let lock;
    for (;;) {
      try {
        lock = await open(this.lockFile, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() - start >= this.lockWaitMs) {
          throw Object.assign(new Error("Refresh authority lock unavailable"), {
            code: "grant_store_unavailable"
          });
        }
        await pause(15);
      }
    }
    let tempFile = null;
    try {
      let state;
      try {
        const raw = await readFile(this.filePath, "utf8");
        if (Buffer.byteLength(raw) > 12_000_000) {
          throw new Error("Refresh authority state exceeds size limit");
        }
        state = JSON.parse(raw);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        state = { version: 1, records: {} };
      }
      if (state?.version !== 1 || !state.records ||
          typeof state.records !== "object" || Array.isArray(state.records)) {
        throw new Error("Unsupported refresh authority state");
      }
      const result = await change(state);
      // Commit all rotations/revocations before returning any new secret.
      const output = JSON.stringify(state);
      if (Buffer.byteLength(output) > 12_000_000) {
        throw new Error("Refresh authority state exceeds size limit");
      }
      tempFile = this.filePath + "." + randomBytes(8).toString("hex") + ".tmp";
      const file = await open(tempFile, "wx", 0o600);
      try {
        await file.writeFile(output + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tempFile, this.filePath);
      tempFile = null;
      // Best effort directory fsync on platforms supporting it; the state
      // file itself has been synced before atomic rename.
      try {
        const directory = await open(path.dirname(this.filePath), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch { /* not supported by all filesystems, especially Windows */ }
      return result;
    } finally {
      if (tempFile) await unlink(tempFile).catch(() => {});
      await lock.close();
      await unlink(this.lockFile);
    }
  }
}
