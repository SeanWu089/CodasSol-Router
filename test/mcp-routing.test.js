import assert from "node:assert/strict";
import test from "node:test";
import { DeviceRegistry } from "../src/device-registry.js";
import {
  bindOpenWorkspaceResponses,
  decideMcpRoute,
  McpRoutingError,
  parseMcpResponseBody,
  rewriteMcpRequest
} from "../src/mcp-routing.js";
import { RoutingPolicy } from "../src/routing-policy.js";
import { WorkspaceBindingStore } from "../src/workspace-bindings.js";

function runtimeFixture() {
  const devices = new DeviceRegistry();
  devices.register({
    id: "local",
    platform: "darwin",
    presence: "static",
    roots: ["/Users/example"]
  });
  devices.register({
    id: "windows",
    platform: "win32",
    presence: "static",
    roots: ["C:\\Users\\Example"]
  });
  const bindings = new WorkspaceBindingStore();
  return {
    localDeviceId: "local",
    devices,
    bindings,
    routing: new RoutingPolicy({ devices, bindings })
  };
}

function toolCall(id, name, args) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args }
  };
}

test("open_workspace routes by path and binds the returned workspace", async () => {
  const runtime = runtimeFixture();
  await runtime.bindings.load();
  const request = toolCall(1, "open_workspace", {
    path: "C:\\Users\\Example\\MAMA"
  });
  const decision = decideMcpRoute(request, runtime);
  assert.equal(decision.deviceId, "windows");

  await bindOpenWorkspaceResponses({
    jsonrpc: "2.0",
    id: 1,
    result: {
      structuredContent: {
        workspace_id: "ws_windows",
        root: "C:\\Users\\Example\\MAMA",
        mode: "checkout"
      }
    }
  }, decision, runtime);

  const next = decideMcpRoute(
    toolCall(2, "read", {
      workspace_id: "ws_windows",
      path: "README.md"
    }),
    runtime
  );
  assert.equal(next.deviceId, "windows");
});

test("workspace route ignores unrelated conversational context and follows binding", async () => {
  const runtime = runtimeFixture();
  await runtime.bindings.load();
  await runtime.routing.bindWorkspace({
    workspaceId: "ws_mac",
    deviceId: "local",
    root: "/Users/example/project"
  });
  const decision = decideMcpRoute(
    toolCall(3, "exec_command", {
      workspace_id: "ws_mac",
      cmd: "echo Windows"
    }),
    runtime
  );
  assert.equal(decision.deviceId, "local");
});

test("cross-device MCP batches fail closed", async () => {
  const runtime = runtimeFixture();
  await runtime.bindings.load();
  await runtime.routing.bindWorkspace({
    workspaceId: "ws_mac",
    deviceId: "local"
  });
  await runtime.routing.bindWorkspace({
    workspaceId: "ws_windows",
    deviceId: "windows"
  });
  assert.throws(
    () => decideMcpRoute([
      toolCall(1, "read", { workspace_id: "ws_mac", path: "a" }),
      toolCall(2, "read", { workspace_id: "ws_windows", path: "b" })
    ], runtime),
    (error) => error instanceof McpRoutingError &&
      error.code === "CROSS_DEVICE_BATCH"
  );
});

test("SSE DevSpace response can be parsed for workspace binding", async () => {
  const runtime = runtimeFixture();
  await runtime.bindings.load();
  const decision = decideMcpRoute(
    toolCall(11, "open_workspace", {
      path: "C:\\Users\\Example\\MAMA"
    }),
    runtime
  );
  const sse = [
    "event: message",
    'data: {"result":{"structuredContent":{"workspace_id":"ws_sse","root":"C:\\\\Users\\\\Example\\\\MAMA","mode":"checkout"}},"jsonrpc":"2.0","id":11}',
    "",
    ""
  ].join("\n");
  const parsed = parseMcpResponseBody("text/event-stream", Buffer.from(sse));
  await bindOpenWorkspaceResponses(parsed, decision, runtime);
  assert.equal(runtime.bindings.get("ws_sse").deviceId, "windows");
});

test("home expansion is forwarded to DevSpace as a real Mac path", () => {
  const runtime = runtimeFixture();
  runtime.devices.unregister("windows");
  const original = toolCall(60, "open_workspace", { path: "~/Desktop/MyProject" });
  const selected = decideMcpRoute(original, runtime);
  assert.equal(selected.deviceId, "local");
  const forwarded = rewriteMcpRequest(original, selected);
  assert.equal(forwarded.params.arguments.path, "/Users/example/Desktop/MyProject");
  assert.equal(original.params.arguments.path, "~/Desktop/MyProject");
});

test("explicit Windows device metadata is stripped before forwarding", () => {
  const runtime = runtimeFixture();
  const original = toolCall(61, "open_workspace", {
    path: "~/Desktop", device_id: "windows"
  });
  const selected = decideMcpRoute(original, runtime);
  assert.equal(selected.deviceId, "windows");
  assert.deepEqual(rewriteMcpRequest(original, selected).params.arguments,
    { path: "C:\\Users\\Example\\Desktop" });
});

test("unroutable requests are rejected before DevSpace sees them", () => {
  const runtime = runtimeFixture();
  assert.throws(
    () => decideMcpRoute(toolCall(62, "open_workspace", { path: "D:\\Secret" }), runtime),
    (error) => error.code === "NO_DEVICE_MATCH"
  );
});

