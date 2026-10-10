/** Router-local MCP metadata and discovery. Never includes credentials or peer URLs. */
const DEVICE_TOOL = {
  name: "codassol_list_devices",
  description: "Discover the user's registered CodasSol devices and their current routing readiness. Use this before choosing a computer when the user has not specified one; ask the user when more than one candidate fits. Device presence alone does not guarantee command execution.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
};

export function addRouterTools(message) {
  if (!Array.isArray(message?.result?.tools)) return message;
  const tools = message.result.tools.map((tool) => {
    if (tool.name !== "open_workspace") return tool;
    return {
      ...tool,
      description: `${tool.description || "Open a DevSpace workspace."} For CodasSol routing, optionally specify device_id from codassol_list_devices to open the path on a particular computer.`,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema?.properties,
          device_id: {
            type: "string",
            description: "Optional target CodasSol device ID. For ambiguous paths choose a device first. This is routing metadata and is not sent to DevSpace."
          }
        }
      }
    };
  });
  if (!tools.some((tool) => tool.name === DEVICE_TOOL.name)) tools.push(DEVICE_TOOL);
  return { ...message, result: { ...message.result, tools } };
}

export function deviceSnapshot(runtime, localBackendReachable) {
  const devices = runtime.catalog.list().map((entry) => {
    const routing = runtime.devices.get(entry.id);
    const local = entry.id === runtime.localDeviceId;
    const peer = runtime.peerMesh?.peers.has(entry.id);
    const peerHealth = peer ? runtime.peerMesh.peerHealth.get(entry.id) : null;
    const backendReachable = local ? localBackendReachable
      : peer ? peerHealth?.backendReachable === true : null;
    const status = local ? (localBackendReachable ? "online" : "degraded")
      : peer && peerHealth?.reachable && !peerHealth.backendReachable ? "degraded"
        : routing?.online ? "online" : routing || peer || entry.kind === "agent" ? "offline" : "unknown";
    return {
      id: entry.id,
      name: entry.name,
      platform: entry.platform,
      kind: entry.kind,
      isThisDevice: local,
      status,
      backendReachable,
      authorizedRoots: routing?.roots || [],
      // Agent heartbeat does not validate DevSpace's command backend.
      // Real open_workspace + follow-up command verification is separate from
      // the health/heartbeat data available to this directory.
      executionVerified: null
    };
  });
  devices.sort((a, b) => Number(b.isThisDevice) - Number(a.isThisDevice) || a.name.localeCompare(b.name, "en"));
  return { version: 1, localDeviceId: runtime.localDeviceId, devices };
}
