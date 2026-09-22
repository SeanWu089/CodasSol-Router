import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export class WorkspaceBindingConflictError extends Error {
  constructor(workspaceId, currentDeviceId, requestedDeviceId) {
    super(
      `Workspace ${workspaceId} is already bound to ${currentDeviceId}; refusing to move it to ${requestedDeviceId}`
    );
    this.name = "WorkspaceBindingConflictError";
    this.code = "WORKSPACE_BINDING_CONFLICT";
    this.workspaceId = workspaceId;
    this.currentDeviceId = currentDeviceId;
    this.requestedDeviceId = requestedDeviceId;
  }
}

export class WorkspaceBindingStore {
  #filePath;
  #clock;
  #bindings = new Map();
  #loaded = false;

  constructor({ filePath = null, clock = () => Date.now() } = {}) {
    this.#filePath = filePath;
    this.#clock = clock;
  }

  async load() {
    if (this.#loaded) return this;
    this.#loaded = true;
    if (!this.#filePath) return this;
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.bindings)) {
        throw new Error("Unsupported workspace binding state format");
      }
      for (const item of parsed.bindings) {
        const workspaceId = requireNonEmptyString(item.workspaceId, "workspaceId");
        const deviceId = requireNonEmptyString(item.deviceId, "deviceId");
        this.#bindings.set(workspaceId, {
          workspaceId,
          deviceId,
          root: typeof item.root === "string" ? item.root : null,
          mode: typeof item.mode === "string" ? item.mode : null,
          createdAt: Number.isFinite(item.createdAt) ? item.createdAt : this.#clock(),
          updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : this.#clock()
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this;
  }

  get(workspaceId) {
    const value = this.#bindings.get(requireNonEmptyString(workspaceId, "workspaceId"));
    return value ? structuredClone(value) : null;
  }

  list() {
    return [...this.#bindings.values()].map((item) => structuredClone(item));
  }

  async bind({ workspaceId, deviceId, root = null, mode = null }) {
    await this.load();
    const normalizedWorkspaceId = requireNonEmptyString(workspaceId, "workspaceId");
    const normalizedDeviceId = requireNonEmptyString(deviceId, "deviceId");
    const existing = this.#bindings.get(normalizedWorkspaceId);
    if (existing && existing.deviceId !== normalizedDeviceId) {
      throw new WorkspaceBindingConflictError(
        normalizedWorkspaceId,
        existing.deviceId,
        normalizedDeviceId
      );
    }
    const now = this.#clock();
    const next = {
      workspaceId: normalizedWorkspaceId,
      deviceId: normalizedDeviceId,
      root: typeof root === "string" ? root : existing?.root ?? null,
      mode: typeof mode === "string" ? mode : existing?.mode ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.#bindings.set(normalizedWorkspaceId, next);
    await this.#persist();
    return structuredClone(next);
  }

  async delete(workspaceId) {
    await this.load();
    const deleted = this.#bindings.delete(requireNonEmptyString(workspaceId, "workspaceId"));
    if (deleted) await this.#persist();
    return deleted;
  }

  async #persist() {
    if (!this.#filePath) return;
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const payload = JSON.stringify({
      version: 1,
      bindings: this.list()
    }, null, 2);
    const tempPath = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${payload}\n`, { mode: 0o600 });
    await rename(tempPath, this.#filePath);
  }
}

