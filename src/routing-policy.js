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
      return explicit;
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
      return best[0].device;
    }

    const onlineDevices = this.devices.list({ onlineOnly: true });
    if (onlineDevices.length === 1) return onlineDevices[0];
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

