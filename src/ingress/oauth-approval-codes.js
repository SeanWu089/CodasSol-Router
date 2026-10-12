import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { LocalRefreshAuthority } from "./local-refresh-authority.js";

const FORMAT = /^[A-Za-z0-9_-]{43}$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Owner types a one-time approval code displayed ONLY on their trusted
 * local machine. Never send a durable Router admin or pairing bearer through
 * the browser. Local code state is not intended to replicate across nodes.
 */
export class OAuthApprovalCodes {
  constructor({
    stateDir, authority = null, clock = () => Date.now(), subject = "owner"
  } = {}) {
    if ((!authority && (typeof stateDir !== "string" || !path.isAbsolute(stateDir))) ||
        typeof subject !== "string" || !subject.trim() || subject.length > 256) {
      throw new TypeError("Owner approval requires a local state directory and subject");
    }
    this.authority = authority || new LocalRefreshAuthority({
      filePath: path.join(stateDir, "oauth-approval-codes.json")
    });
    this.clock = clock;
    this.subject = subject;
  }

  async issue() {
    const secret = randomBytes(32).toString("base64url");
    const hash = digest(secret);
    await this.authority.transact((state) => {
      // Only one live code: requesting a new code invalidates the previous.
      state.records = {
        [hash]: { expiresAt: this.clock() + 5 * 60_000 }
      };
    });
    return secret;
  }

  async consume(secret) {
    if (typeof secret !== "string" || !FORMAT.test(secret)) return false;
    return this.authority.transact((state) => {
      const key = digest(secret);
      const match = state.records[key];
      if (!match || match.expiresAt <= this.clock()) return false;
      delete state.records[key];
      return true;
    });
  }
}
