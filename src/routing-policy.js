import pathModule from "node:path";

function homeFromRoot(root, platform) {
  const normalized = root.replaceAll("\\", "/");
  if (platform === "win32") {
    const match = normalized.match(/^([A-Za-z]:\/Users\/[^/]+)(?:\/|$)/i);
    return match ? match[1].replaceAll("/", "\\") : null;
  }
  const match = normalized.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/);
  return match?.[1] || null;
}

function expandHome(requestedPath, device) {
  if (!requestedPath.startsWith("~/") && requestedPath !== "~") return requestedPath;
  const homes = [...new Set(device.roots.map((root) => homeFromRoot(root, device.platform)).filter(Boolean))];
  if (homes.length !== 1) {
    // Legacy Agents may not advertise their home. Keep ~ scoped to the chosen
    // device and let *its* DevSpace expand it and enforce allowedRoots.
    return requestedPath;
  }
  const suffix = requestedPath === "~" ? "" : requestedPath.slice(2);
  return device.platform === "win32"
    ? pathModule.win32.join(homes[0], suffix)
    : pathModule.posix.join(homes[0], suffix);
}

function wrongPlatformPath(requestedPath, platform) {
  if (requestedPath === "~" || requestedPath.startsWith("~/")) return false;
  if (platform === "win32") return requestedPath.startsWith("/");
  if (platform === "darwin" || platform === "linux") {
    return /^[a-z]:[\\/]/i.test(requestedPath) || requestedPath.startsWith("\\\\");
  }
  return false;
}

export class RoutingDecisionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RoutingDecisionError";
    this.code = code;
    this.details = details;
  }
}

export class RoutingPolicy {
  constructor({ devices, bindings }) {
    if (!devices || !bindings) {
      throw new TypeError("devices and bindings are required");
    }
    this.devices = devices;
    this.bindings = bindings;
  }

  resolveOpenWorkspace({ path, deviceId = null }) {
    if (typeof path !== "string" || !path.trim()) {
      throw new RoutingDecisionError("INVALID_WORKSPACE_PATH", "A workspace path is required");
    }
    const shorthand = path === "~" || path.startsWith("~/");
    if (deviceId) {
      const explicit = this.devices.get(deviceId);
      if (!explicit) {
        throw new RoutingDecisionError(
          "DEVICE_NOT_FOUND",
          `Requested device ${deviceId} is not registered`,
          { deviceId }
        );
      }
      if (!explicit.online) {
        throw new RoutingDecisionError(
          "DEVICE_OFFLINE",
          `Requested device ${deviceId} is offline`,
          { deviceId }
        );
      }
      const resolvedPath = expandHome(path, explicit);
      if (wrongPlatformPath(resolvedPath, explicit.platform)) {
        throw new RoutingDecisionError(
          "PATH_NOT_ON_DEVICE", "Workspace path syntax is incompatible with the selected device",
          { deviceId, path: resolvedPath, platform: explicit.platform }
        );
      }
      return { ...explicit, path: resolvedPath };
    }

    if (shorthand) {
      const online = this.devices.list({ onlineOnly: true });
      if (online.length === 0) {
        throw new RoutingDecisionError("NO_ONLINE_DEVICE", "No online devices are available", { path });
      }
      if (online.length > 1) {
        throw new RoutingDecisionError("AMBIGUOUS_DEVICE", "Home path belongs to multiple devices; select one",
          { path, deviceIds: online.map((item) => item.id) });
      }
      const device = online[0];
      const resolvedPath = expandHome(path, device);
      return { ...device, path: resolvedPath };
    }

    const matches = this.devices.matchPath(path);
    if (matches.length) {
      // An offline *more specific* root cannot be silently replaced by an
      // online broader root (or an equally specific other machine).
      // Ownership is determined before health, never the other way round.
      const best = matches.filter((match) => match.specificity === matches[0].specificity);
      const deviceIds = [...new Set(best.map((match) => match.device.id))];
      if (deviceIds.length > 1) {
        throw new RoutingDecisionError(
          "AMBIGUOUS_DEVICE",
          "Multiple devices claim this workspace root, including offline nodes",
          { deviceIds, path }
        );
      }
      if (!best[0].device.online) {
        throw new RoutingDecisionError(
          "DEVICE_OFFLINE", "The owning device is offline",
          { deviceIds, path }
        );
      }
      return { ...best[0].device, path };
    }

    // Keep the production-only v0.2 recovery route for the legacy Windows
    // Agent, which still reports roots=[]. Constrain it to prior D:/E: data
    // drives on one unique online Windows Agent; DevSpace still checks its
    // actual allowedRoots. Never infer that an unmatched C: path is on Mac.
    const legacy = this.devices.get("SEANSWPC");
    const windowsOnline = this.devices.list({ onlineOnly: true })
      .filter((device) => device.platform === "win32");
    if (/^[de]:[\\/]/i.test(path) && legacy?.online && legacy.platform === "win32" &&
        legacy.roots.length === 0 && windowsOnline.length === 1 &&
        windowsOnline[0].id === legacy.id) {
      return { ...legacy, path };
    }

    const onlineDevices = this.devices.list({ onlineOnly: true });
    if (onlineDevices.length === 0) {
      throw new RoutingDecisionError(
        "NO_ONLINE_DEVICE",
        "No online devices are available",
        { path }
      );
    }
    throw new RoutingDecisionError(
      "NO_DEVICE_MATCH",
      "No unique device can be selected for this workspace path",
      { path, deviceIds: onlineDevices.map((device) => device.id) }
    );
  }

  async bindWorkspace({ workspaceId, deviceId, root = null, mode = null }) {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new RoutingDecisionError(
        "DEVICE_NOT_FOUND",
        `Cannot bind workspace to unknown device ${deviceId}`,
        { deviceId, workspaceId }
      );
    }
    return this.bindings.bind({ workspaceId, deviceId, root, mode });
  }

  resolveWorkspace(workspaceId) {
    const binding = this.bindings.get(workspaceId);
    if (!binding) {
      throw new RoutingDecisionError(
        "WORKSPACE_NOT_BOUND",
        `Workspace ${workspaceId} has no device binding`,
        { workspaceId }
      );
    }
    const device = this.devices.get(binding.deviceId);
    if (!device) {
      throw new RoutingDecisionError(
        "DEVICE_NOT_FOUND",
        `Bound device ${binding.deviceId} is not registered`,
        { workspaceId, deviceId: binding.deviceId }
      );
    }
    if (!device.online) {
      throw new RoutingDecisionError(
        "DEVICE_OFFLINE",
        `Bound device ${binding.deviceId} is offline`,
        { workspaceId, deviceId: binding.deviceId }
      );
    }
    return { device, binding };
  }
}

