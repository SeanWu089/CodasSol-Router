import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = 1;
const MAX_DEVICES = 500;

function text(value, name, max = 100) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max ||
      /[\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError(`${name} must be a nonempty printable string <= ${max} characters`);
  }
  return value.trim();
}

function revision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isSafeInteger(value.counter) || value.counter < 0 ||
      value.counter > Number.MAX_SAFE_INTEGER - 1) {
    throw new TypeError("Invalid rename revision counter");
  }
  return { counter: value.counter, origin: text(value.origin, "revision.origin", 128) };
}

function compareRevision(a, b) {
  return a.counter - b.counter || (a.origin === b.origin ? 0 : a.origin > b.origin ? 1 : -1);
}

function validateRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Device catalog record must be an object");
  }
  const result = {
    id: text(input.id, "device.id", 128),
    installationId: input.installationId
      ? text(input.installationId, "device.installationId", 128) : null,
    defaultName: text(input.defaultName, "device.defaultName", 80),
    platform: text(input.platform || "unknown", "device.platform", 50),
    kind: text(input.kind || "discovered", "device.kind", 32),
    rename: null
  };
  if (!["router", "agent", "discovered"].includes(result.kind)) {
    throw new TypeError("Invalid device.kind");
  }
  if (input.rename !== null && input.rename !== undefined) {
    result.rename = {
      name: text(input.rename.name, "rename.name", 80),
      revision: revision(input.rename.revision)
    };
  }
  return result;
}

/** Durable, non-routing device names. Only bearer-authenticated peers exchange these records. */
export class DeviceCatalog {
  #records = new Map();
  #counter = 0;
  #filePath;
  #origin;
  #writeChain = Promise.resolve();

  constructor({ stateDir, origin }) {
    if (typeof stateDir !== "string" || !stateDir) throw new TypeError("stateDir required");
    this.#filePath = path.join(stateDir, "devices.json");
    this.#origin = text(origin, "local device ID", 128);
  }

  async load() {
    let saved;
    try {
      saved = JSON.parse(await readFile(this.#filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return this;
      throw error;
    }
    if (saved?.version !== VERSION || !Array.isArray(saved.devices) ||
        saved.devices.length > MAX_DEVICES || !Number.isSafeInteger(saved.counter) ||
        saved.counter < 0) {
      throw new Error("Unsupported or invalid Device Catalog v1 state");
    }
    this.#counter = saved.counter;
    for (const entry of saved.devices) {
      const record = validateRecord(entry);
      if (this.#records.has(record.id)) throw new Error("Duplicate device identity in catalog");
      this.#records.set(record.id, record);
      if (record.rename) this.#counter = Math.max(this.#counter, record.rename.revision.counter);
    }
    return this;
  }

  #queueWrite() {
    const data = JSON.stringify({ version: VERSION, counter: this.#counter, devices: [...this.#records.values()] }, null, 2) + "\n";
    const filename = this.#filePath;
    this.#writeChain = this.#writeChain.catch(() => {}).then(async () => {
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temp = `${filename}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, filename);
    });
    return this.#writeChain;
  }

  get(id) {
    const record = this.#records.get(id);
    if (!record) return null;
    const copy = structuredClone(record);
    return { ...copy, name: copy.rename?.name || copy.defaultName };
  }

  list() {
    return [...this.#records.keys()].map((id) => this.get(id));
  }

  async observe(input) {
    const next = validateRecord({ ...input, rename: null });
    const old = this.#records.get(next.id);
    if (old) {
      // Never accept remote observations that silently replace identity details.
      // An authoritative direct probe may promote discovered -> router/agent,
      // but cannot change the identity's existing known platform.
      if (old.platform !== "unknown" && next.platform !== "unknown" &&
          old.platform !== next.platform) {
        throw new Error(`DEVICE_ID_COLLISION: ${next.id} changes platform`);
      }
      if (old.installationId && next.installationId && old.installationId !== next.installationId) {
        throw new Error(`DEVICE_ID_COLLISION: ${next.id} changes installation identity`);
      }
      const updated = {
        ...old,
        installationId: old.installationId || next.installationId,
        platform: old.platform === "unknown" ? next.platform : old.platform,
        kind: old.kind === "discovered" ? next.kind : old.kind,
        defaultName: old.defaultName === old.id ? next.defaultName : old.defaultName
      };
      if (JSON.stringify(updated) === JSON.stringify(old)) return this.get(next.id);
      this.#records.set(next.id, updated);
    } else {
      if (this.#records.size >= MAX_DEVICES) throw new Error("Device catalog is full");
      this.#records.set(next.id, next);
    }
    await this.#queueWrite();
    return this.get(next.id);
  }

  async rename(id, name) {
    const key = text(id, "device.id", 128);
    const record = this.#records.get(key);
    if (!record) return null;
    const nextName = text(name, "device.name", 80);
    if (record.rename?.name === nextName) return this.get(key);
    if (this.#counter >= Number.MAX_SAFE_INTEGER - 1) throw new Error("Catalog revision exhausted");
    this.#counter += 1;
    record.rename = { name: nextName, revision: { counter: this.#counter, origin: this.#origin } };
    await this.#queueWrite();
    return this.get(key);
  }

  snapshot() {
    return { version: VERSION, devices: [...this.#records.values()].map((v) => structuredClone(v)) };
  }

  async merge(snapshot) {
    if (!snapshot || snapshot.version !== VERSION || !Array.isArray(snapshot.devices) ||
        snapshot.devices.length > MAX_DEVICES) throw new TypeError("Invalid peer catalog snapshot");
    // Fully validate before touching persistent state.
    const incoming = snapshot.devices.map(validateRecord);
    const seen = new Set();
    for (const entry of incoming) {
      if (seen.has(entry.id)) throw new Error(`Duplicate device identity in snapshot: ${entry.id}`);
      seen.add(entry.id);
      const existing = this.#records.get(entry.id);
      if (existing?.installationId && entry.installationId &&
          existing.installationId !== entry.installationId) {
        throw new Error(`DEVICE_ID_COLLISION: ${entry.id} has multiple installation identities`);
      }
      if (existing && existing.platform !== "unknown" && entry.platform !== "unknown" &&
          existing.platform !== entry.platform) {
        throw new Error(`DEVICE_ID_COLLISION: ${entry.id} has conflicting platforms`);
      }
    }
    if ([...seen].filter((id) => !this.#records.has(id)).length + this.#records.size > MAX_DEVICES) {
      throw new Error("Device catalog is full");
    }
    const counterBeforeMerge = this.#counter;
    let changed = false;
    for (const entry of incoming) {
      this.#counter = Math.max(this.#counter, entry.rename?.revision.counter || 0);
      const old = this.#records.get(entry.id);
      if (!old) {
        if (this.#records.size >= MAX_DEVICES) throw new Error("Device catalog is full");
        this.#records.set(entry.id, { ...entry, kind: "discovered" });
        changed = true;
        continue;
      }
      if (!old.installationId && entry.installationId) {
        old.installationId = entry.installationId;
        changed = true;
      }
      if (old.platform === "unknown" && entry.platform !== "unknown") {
        old.platform = entry.platform;
        changed = true;
      }
      // A record from another Router may describe the same name, but MUST
      // NOT overwrite an existing platform, kind or local default name.
      if (entry.rename && (!old.rename ||
          compareRevision(entry.rename.revision, old.rename.revision) > 0 ||
          (compareRevision(entry.rename.revision, old.rename.revision) === 0 &&
            entry.rename.name > old.rename.name))) {
        old.rename = entry.rename;
        changed = true;
      }
    }
    // Even a snapshot that loses every rename conflict may advance our Lamport
    // clock, which must survive a restart before the next local rename.
    if (changed || this.#counter !== counterBeforeMerge) await this.#queueWrite();
    return changed;
  }
}
