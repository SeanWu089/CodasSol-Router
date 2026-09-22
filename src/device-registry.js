function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function normalizePlatform(platform) {
  const value = requireNonEmptyString(platform, "platform").toLowerCase();
  if (value === "win32" || value === "windows") return "win32";
  if (value === "darwin" || value === "macos" || value === "mac") return "darwin";
  return value;
}

function normalizePath(value, platform) {
  let normalized = requireNonEmptyString(value, "path").replaceAll("\\", "/");
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (platform === "win32") normalized = normalized.toLowerCase();
  return normalized;
}

function pathMatchesRoot(candidatePath, root, platform) {
  const candidate = normalizePath(candidatePath, platform);
  const normalizedRoot = normalizePath(root, platform);
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

function sanitizeDevice(input, now) {
  if (!input || typeof input !== "object") {
    throw new TypeError("device must be an object");
  }
  const id = requireNonEmptyString(input.id, "device.id");
  const platform = normalizePlatform(input.platform || "unknown");
  const presence = input.presence || "heartbeat";
  if (presence !== "static" && presence !== "heartbeat") {
    throw new TypeError("device.presence must be static or heartbeat");
  }
  const roots = Array.isArray(input.roots)
    ? input.roots.map((root) => requireNonEmptyString(root, "device.roots[]"))
    : [];
  return {
    id,
    label: input.label ? requireNonEmptyString(input.label, "device.label") : id,
    platform,
    presence,
    roots,
    transport: input.transport && typeof input.transport === "object"
      ? structuredClone(input.transport)
      : null,
    capabilities: Array.isArray(input.capabilities)
      ? [...new Set(input.capabilities.map((item) => requireNonEmptyString(item, "device.capabilities[]")))]
      : [],
    enabled: input.enabled !== false,
    lastSeenAt: now
  };
}

export class DeviceRegistry {
  #clock;
  #heartbeatTtlMs;
  #devices = new Map();

  constructor({ clock = () => Date.now(), heartbeatTtlMs = 30_000 } = {}) {
    if (!Number.isFinite(heartbeatTtlMs) || heartbeatTtlMs <= 0) {
      throw new TypeError("heartbeatTtlMs must be a positive number");
    }
    this.#clock = clock;
    this.#heartbeatTtlMs = heartbeatTtlMs;
  }

  register(input) {
    const now = this.#clock();
    const next = sanitizeDevice(input, now);
    const existing = this.#devices.get(next.id);
    if (existing) {
      next.lastSeenAt = now;
    }
    this.#devices.set(next.id, next);
    return this.get(next.id);
  }

  heartbeat(id, patch = {}) {
    const deviceId = requireNonEmptyString(id, "device id");
    const existing = this.#devices.get(deviceId);
    if (!existing) return null;
    const now = this.#clock();
    const merged = {
      ...existing,
      ...patch,
      id: existing.id,
      lastSeenAt: now
    };
    const next = sanitizeDevice(merged, now);
    next.lastSeenAt = now;
    this.#devices.set(deviceId, next);
    return this.get(deviceId);
  }

  unregister(id) {
    return this.#devices.delete(requireNonEmptyString(id, "device id"));
  }

  get(id) {
    const device = this.#devices.get(requireNonEmptyString(id, "device id"));
    if (!device) return null;
    return {
      ...structuredClone(device),
      online: this.isOnline(device.id)
    };
  }

  list({ onlineOnly = false } = {}) {
    return [...this.#devices.keys()]
      .map((id) => this.get(id))
      .filter((device) => !onlineOnly || device.online);
  }

  isOnline(id) {
    const device = this.#devices.get(requireNonEmptyString(id, "device id"));
    if (!device || !device.enabled) return false;
    if (device.presence === "static") return true;
    return this.#clock() - device.lastSeenAt <= this.#heartbeatTtlMs;
  }

  matchPath(candidatePath) {
    requireNonEmptyString(candidatePath, "path");
    const matches = [];
    for (const device of this.#devices.values()) {
      for (const root of device.roots) {
        if (pathMatchesRoot(candidatePath, root, device.platform)) {
          matches.push({
            device: this.get(device.id),
            root,
            specificity: normalizePath(root, device.platform).length
          });
        }
      }
    }
    return matches.sort((a, b) => b.specificity - a.specificity);
  }
}

