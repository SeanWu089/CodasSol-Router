import { createHash, randomBytes } from "node:crypto";

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{64}$/;
const MAX_FAMILY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const hash = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(48).toString("base64url");
const randomId = () => randomBytes(18).toString("base64url");

function denied() {
  const error = new Error("Invalid OAuth refresh grant");
  error.code = "invalid_grant";
  return error;
}

/**
 * Refresh grant records hold token HASHES only. The authority is required to
 * provide a SERIALIZABLE, durable transaction across every ingress host.
 *
 * Local file authorities are single-host only; a real failover integration
 * MUST provide a provider-backed transactor with exclusive writes/fencing.
 */
export class RefreshTokenRotation {
  constructor({
    authority, clock = () => Date.now(),
    ttlMs = MAX_FAMILY_LIFETIME_MS
  } = {}) {
    if (typeof authority?.transact !== "function" ||
        !Number.isInteger(ttlMs) || ttlMs < 60_000 ||
        ttlMs > MAX_FAMILY_LIFETIME_MS) {
      throw new TypeError("Durable atomic refresh authority and valid lifetime required");
    }
    this.authority = authority;
    this.clock = clock;
    this.ttlMs = ttlMs;
  }

  async issue({ subject, clientId, resource } = {}) {
    if (typeof subject !== "string" || !subject.trim() ||
        subject.length > 256 || typeof clientId !== "string" ||
        !clientId.trim() || clientId.length > 256 ||
        typeof resource !== "string" || !resource.startsWith("https://")) {
      throw denied();
    }
    const issued = token();
    const digest = hash(issued);
    const familyId = randomId();
    const expiresAt = this.clock() + this.ttlMs;
    await this.authority.transact((state) => {
      const entries = state.records;
      // Expired families can be garbage-collected; active and spent tokens
      // remain until expiry so replay is detected.
      for (const [key, record] of Object.entries(entries)) {
        if (record.expiresAt <= this.clock()) delete entries[key];
      }
      if (Object.keys(entries).length >= 10_000) {
        throw Object.assign(new Error("Refresh grant capacity reached"), {
          code: "grant_capacity"
        });
      }
      entries[digest] = {
        familyId, subject, clientId, resource,
        expiresAt, status: "active", generation: 0
      };
    });
    return { refresh_token: issued, expiresAt };
  }

  async rotate({ refreshToken, clientId, resource } = {}) {
    if (typeof refreshToken !== "string" || !TOKEN_FORMAT.test(refreshToken) ||
        typeof clientId !== "string" || typeof resource !== "string") throw denied();
    const previous = hash(refreshToken);
    const next = token();
    const nextDigest = hash(next);
    const outcome = await this.authority.transact((state) => {
      const record = state.records[previous];
      if (!record || record.expiresAt <= this.clock() ||
          record.clientId !== clientId || record.resource !== resource) {
        return { ok: false };
      }
      if (record.status !== "active") {
        // A second use of an old token may indicate theft. Revoke the entire
        // family, INCLUDING a freshly rotated descendant, atomically.
        for (const sibling of Object.values(state.records)) {
          if (sibling.familyId === record.familyId) sibling.status = "revoked";
        }
        return { ok: false };
      }
      record.status = "spent";
      state.records[nextDigest] = {
        ...record, generation: record.generation + 1, status: "active"
      };
      return {
        ok: true, subject: record.subject, familyId: record.familyId,
        expiresAt: record.expiresAt
      };
    });
    if (!outcome.ok) throw denied();
    return {
      refresh_token: next,
      subject: outcome.subject,
      expiresAt: outcome.expiresAt
    };
  }

  async revoke({ refreshToken, clientId } = {}) {
    if (typeof refreshToken !== "string" || !TOKEN_FORMAT.test(refreshToken) ||
        typeof clientId !== "string") return false;
    const digest = hash(refreshToken);
    return this.authority.transact((state) => {
      const record = state.records[digest];
      if (!record || record.clientId !== clientId) return false;
      for (const entry of Object.values(state.records)) {
        if (entry.familyId === record.familyId) entry.status = "revoked";
      }
      return true;
    });
  }
}
