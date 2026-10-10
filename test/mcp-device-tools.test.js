import assert from "node:assert/strict";
import test from "node:test";
import { addRouterTools, deviceSnapshot } from "../src/mcp-device-tools.js";
import { DeviceRegistry } from "../src/device-registry.js";

test("tools/list adds read-only device discovery and safe device selector to open_workspace", () => {
  const message = { jsonrpc: "2.0", id: 1, result: {
    tools: [{ name: "open_workspace", description: "Open a directory", inputSchema: {
      type: "object", required: ["path"], properties: { path: { type: "string" } }
    } }, { name: "read", inputSchema: { type: "object" } }]
  } };
  const augmented = addRouterTools(message);
  assert.equal(message.result.tools.length, 2, "do not mutate backend tool list");
  assert.equal(augmented.result.tools.length, 3);
  assert.equal(augmented.result.tools[0].inputSchema.properties.device_id.type, "string");
  assert.deepEqual(augmented.result.tools[0].inputSchema.required, ["path"]);
  assert.equal(augmented.result.tools[2].name, "codassol_list_devices");
  assert.equal(augmented.result.tools[2].annotations.readOnlyHint, true);
  assert.equal(addRouterTools(augmented).result.tools.length, 3);
});

test("device discovery distinguishes local reachability, unknown agent backend and offline peers", () => {
  const devices = new DeviceRegistry();
  devices.register({ id: "local", platform: "darwin", presence: "static", roots: ["/Users/Sean"] });
  devices.register({ id: "wins", platform: "win32", presence: "static", roots: [] });
  devices.register({ id: "peer", platform: "win32", presence: "static", enabled: false });
  const entries = [
    { id: "local", name: "Mac", platform: "darwin", kind: "router" },
    { id: "wins", name: "Windows", platform: "win32", kind: "agent" },
    { id: "peer", name: "PC Router", platform: "win32", kind: "router" }
  ];
  const runtime = {
    localDeviceId: "local", devices,
    catalog: { list: () => entries },
    peerMesh: { peers: new Map([["peer", {}]]), peerHealth: new Map() }
  };
  const result = deviceSnapshot(runtime, true);
  assert.equal(result.devices.length, 3);
  assert.equal(result.devices[0].name, "Mac");
  assert.equal(result.devices[0].backendReachable, true);
  const agent = result.devices.find((device) => device.id === "wins");
  const peer = result.devices.find((device) => device.id === "peer");
  assert.equal(agent.backendReachable, null);
  assert.equal(agent.executionVerified, null);
  assert.equal(peer.status, "offline");
  assert.ok(!JSON.stringify(result).includes("token"));
});
