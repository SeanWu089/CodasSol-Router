import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function hashSecret(secret) {
  return createHash("sha256").update(secret).digest("base64url");
}

function equalSecretHashes(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function safeString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export function defaultStateDir() {
  return process.env.CODASSOL_STATE_DIR || path.join(os.homedir(), ".codassol");
}

export class RouterPrivateState {
  #filePath;
  #state = null;

  constructor({ stateDir = defaultStateDir() } = {}) {
    this.#filePath = path.join(stateDir, "router.json");
  }

  async init() {
    if (this.#state) return this;
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8"));
      if (parsed?.version !== 1 || typeof parsed.pairingToken !== "string") {
        throw new Error("Unsupported CodasSol router private-state format");
      }
      this.#state = {
        version: 1,
        pairingToken: parsed.pairingToken,
        agents: parsed.agents && typeof parsed.agents === "object" ? parsed.agents : {}
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#state = {
        version: 1,
        pairingToken: randomSecret(),
        agents: {}
      };
      await this.#persist();
    }
    return this;
  }

  get pairingToken() {
    if (!this.#state) throw new Error("RouterPrivateState.init() must be called first");
    return this.#state.pairingToken;
  }

  listAgents() {
    if (!this.#state) throw new Error("RouterPrivateState.init() must be called first");
    return Object.entries(this.#state.agents).map(([id, record]) => ({
      id,
      ...structuredClone(record),
      tokenHash: undefined
    }));
  }

  getAgent(id) {
    if (!this.#state) throw new Error("RouterPrivateState.init() must be called first");
    const record = this.#state.agents[safeString(id, "device id")];
    if (!record) return null;
    return {
      id,
      ...structuredClone(record),
      tokenHash: undefined
    };
  }

  verifyPairingToken(token) {
    if (!this.#state) throw new Error("RouterPrivateState.init() must be called first");
    return equalSecretHashes(
      hashSecret(String(token ?? "")),
      hashSecret(this.#state.pairingToken)
    );
  }

  authenticateAgent(token) {
    if (!this.#state || typeof token !== "string" || token === "") return null;
    const tokenHash = hashSecret(token);
    for (const [id, record] of Object.entries(this.#state.agents)) {
      if (equalSecretHashes(record.tokenHash, tokenHash)) {
        return {
          id,
          ...structuredClone(record),
          tokenHash: undefined
        };
      }
    }
    return null;
  }

  async enrollAgent(metadata) {
    if (!this.#state) throw new Error("RouterPrivateState.init() must be called first");
    const id = safeString(metadata.id, "device id");
    const token = randomSecret();
    const now = Date.now();
    this.#state.agents[id] = {
      label: safeString(metadata.label || id, "device label"),
      platform: safeString(metadata.platform || "unknown", "platform"),
      roots: Array.isArray(metadata.roots) ? metadata.roots.map(String) : [],
      capabilities: Array.isArray(metadata.capabilities)
        ? metadata.capabilities.map(String)
        : [],
      tokenHash: hashSecret(token),
      createdAt: this.#state.agents[id]?.createdAt ?? now,
      rotatedAt: now
    };
    await this.#persist();
    return { token, agent: this.getAgent(id) };
  }

  async #persist() {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temp = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.#filePath);
  }
}

