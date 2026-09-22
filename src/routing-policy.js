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
    const onlineMatches = matches.filter((match) => match.device.online);
    if (onlineMatches.length > 0) {
      const bestSpecificity = onlineMatches[0].specificity;
      const best = onlineMatches.filter((match) => match.specificity === bestSpecificity);
      const deviceIds = [...new Set(best.map((match) => match.device.id))];
      if (deviceIds.length === 1) {
        return best[0].device;
      }
      throw new RoutingDecisionError(
        "AMBIGUOUS_DEVICE",
        "Multiple online devices match this workspace path",
        { deviceIds, path }
      );
    }

    const offlineMatches = matches.filter((match) => !match.device.online);
    if (offlineMatches.length > 0) {
      throw new RoutingDecisionError(
        "DEVICE_OFFLINE",
        "The matching device is offline",
        {
          deviceIds: [...new Set(offlineMatches.map((match) => match.device.id))],
          path
        }
      );
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

