export class McpRoutingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "McpRoutingError";
    this.code = code;
    this.details = details;
  }
}

function asMessages(payload) {
  return Array.isArray(payload) ? payload : [payload];
}

function toolCallInfo(message) {
  if (!message || typeof message !== "object" || message.method !== "tools/call") {
    return null;
  }
  return {
    id: message.id,
    name: message.params?.name,
    arguments: message.params?.arguments || {}
  };
}

export function decideMcpRoute(payload, runtime) {
  const decisions = [];
  const openWorkspaceCalls = [];

  for (const message of asMessages(payload)) {
    const call = toolCallInfo(message);
    if (!call) {
      decisions.push(runtime.localDeviceId);
      continue;
    }

    if (call.name === "open_workspace") {
      const device = runtime.routing.resolveOpenWorkspace({
        path: call.arguments.path,
        deviceId: call.arguments.device_id || null
      });
      decisions.push(device.id);
      openWorkspaceCalls.push({
        requestId: call.id,
        deviceId: device.id
      });
      continue;
    }

    if (typeof call.arguments.workspace_id === "string") {
      const resolved = runtime.routing.resolveWorkspace(call.arguments.workspace_id);
      decisions.push(resolved.device.id);
      continue;
    }

    decisions.push(runtime.localDeviceId);
  }

  const unique = [...new Set(decisions)];
  if (unique.length > 1) {
    throw new McpRoutingError(
      "CROSS_DEVICE_BATCH",
      "One MCP HTTP request cannot contain calls for multiple devices",
      { deviceIds: unique }
    );
  }

  return {
    deviceId: unique[0] || runtime.localDeviceId,
    openWorkspaceCalls
  };
}

function responseMessages(payload) {
  return Array.isArray(payload) ? payload : [payload];
}

export function parseMcpResponseBody(contentType, body) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
  if (String(contentType || "").includes("application/json")) {
    return JSON.parse(text);
  }
  if (String(contentType || "").includes("text/event-stream")) {
    const messages = [];
    const events = text.split(/\r?\n\r?\n/);
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      messages.push(JSON.parse(data));
    }
    if (messages.length === 1) return messages[0];
    return messages;
  }
  throw new McpRoutingError(
    "UNSUPPORTED_MCP_RESPONSE",
    `Unsupported MCP response content type: ${contentType || "unknown"}`
  );
}

export async function bindOpenWorkspaceResponses(responsePayload, decision, runtime) {
  if (!decision.openWorkspaceCalls.length) return;
  const byId = new Map(
    decision.openWorkspaceCalls.map((call) => [String(call.requestId), call])
  );
  for (const message of responseMessages(responsePayload)) {
    const call = byId.get(String(message?.id));
    const structured = message?.result?.structuredContent;
    if (!call || typeof structured?.workspace_id !== "string") continue;
    await runtime.routing.bindWorkspace({
      workspaceId: structured.workspace_id,
      deviceId: call.deviceId,
      root: typeof structured.root === "string" ? structured.root : null,
      mode: typeof structured.mode === "string" ? structured.mode : null
    });
  }
}

