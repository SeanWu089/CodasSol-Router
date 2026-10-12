import { readFile } from "node:fs/promises";
import path from "node:path";

function unavailable() {
  const error = new Error("Fresh authorization revocation state is unavailable");
  error.code = "revocation_store_unavailable";
  return error;
}

/**
 * Read from one atomic local auth-state file on EACH authorization attempt.
 * Both the mirrored writer and passive receiver replace the entire file,
 * so concurrent reads see one complete revision, never a partial write.
 *
 * A local file is NOT an authoritative distributed revocation provider.
 * This reader must fail closed if no recent trusted replication receipt
 * exists. Refreshing timestamps independently of authenticated replication
 * would silently weaken revocation guarantees.
 */
export function createLocalRevocationReader({ filePath, maxBytes = 4_000_000 } = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 ||
      maxBytes > 12_000_000) {
    throw new TypeError("Absolute, bounded OAuth state file is required");
  }
  return async () => {
    try {
      const raw = await readFile(filePath);
      if (raw.length > maxBytes) throw unavailable();
      const parsed = JSON.parse(raw.toString("utf8"));
      const records = parsed?.namespaces?.revocations?.records;
      const updatedAt = parsed?.lastReplicaAckAt;
      if (!Number.isSafeInteger(updatedAt) ||
          !records || typeof records !== "object" || Array.isArray(records)) {
        throw unavailable();
      }
      const revokedJtis = [];
      for (const [jti, value] of Object.entries(records)) {
        if (typeof jti !== "string" || jti.length < 20 ||
            value == null || typeof value !== "object" ||
            !Number.isSafeInteger(value.revokedAt)) throw unavailable();
        revokedJtis.push(jti);
      }
      return { revokedJtis, updatedAt };
    } catch {
      throw unavailable();
    }
  };
}
