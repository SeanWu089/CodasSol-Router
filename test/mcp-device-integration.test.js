import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { DeviceRegistry } from "../src/device-registry.js";
import { RoutingPolicy } from "../src/routing-policy.js";
import { WorkspaceBindingStore } from "../src/workspace-bindings.js";
import { createRouterServer } from "../src/server.js";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

test("MCP client discovers devices and routes a home path without leaking routing metadata", async (t) => {
  const seen = [];
  const backend = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer authorized-client") {
      res.writeHead(401).end("unauthorized");
      return;
    }
    let input = "";
    for await (const chunk of req) input += chunk;
    const message = JSON.parse(input);
    seen.push(message);
    const result = message.method === "tools/list"
      ? { tools: [{ name: "open_workspace", inputSchema: {
        type: "object", required: ["path"], properties: { path: { type: "string" } }
      } }] }
      : { structuredContent: { workspace_id: "ws_mac", root: "/Users/Tester/Desktop", mode: "checkout" } };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const backendPort = await listen(backend);
  const devices = new DeviceRegistry();
  devices.register({ id: "local", label: "Mac", platform: "darwin", presence: "static", roots: ["/Users/Tester"] });
  const bindings = await new WorkspaceBindingStore().load();
  const runtime = {
    localDeviceId: "local", devices, bindings,
    routing: new RoutingPolicy({ devices, bindings }),
    catalog: { list: () => [{ id: "local", name: "Mac", platform: "darwin", kind: "router" }] }
  };
  const router = createRouterServer({ backendHost: "127.0.0.1", backendPort,
    backendTimeoutMs: 2000 }, runtime);
  const port = await listen(router);
  t.after(async () => { await close(router); await close(backend); });
  const invoke = async (message, authorized = true) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": authorized ? "Bearer authorized-client" : "Bearer invalid" },
      body: JSON.stringify(message)
    });
    return { status: response.status, body: await response.json() };
  };
  const list = await invoke({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.result.tools.map((tool) => tool.name), ["open_workspace", "codassol_list_devices"]);
  const devicesRequest = { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "codassol_list_devices", arguments: {}
  } };
  assert.equal((await invoke(devicesRequest, false)).status, 401);
  const listing = await invoke(devicesRequest);
  assert.equal(listing.status, 200);
  assert.equal(listing.body.result.structuredContent.devices[0].name, "Mac");
  assert.equal(seen.filter((message) => message.params?.name === "codassol_list_devices").length, 0);

  const opened = await invoke({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
    name: "open_workspace", arguments: { path: "~/Desktop", device_id: "local" }
  } });
  assert.equal(opened.status, 200);
  assert.deepEqual(seen.at(-1).params.arguments, { path: "/Users/Tester/Desktop" });
  assert.equal(bindings.get("ws_mac").deviceId, "local");
  const callsBefore = seen.length;
  const invalid = await invoke({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
    name: "open_workspace", arguments: { path: "C:\\Users\\ASUS\\Desktop" }
  } });
  assert.equal(invalid.status, 502);
  assert.equal(invalid.body.error, "NO_DEVICE_MATCH");
  assert.equal(seen.length, callsBefore, "incorrect-device paths must never execute on the Mac backend");
});

test("remote MCP forwarding retains production-compatible method and tool headers", async (t) => {
  const backend = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer authorized-client") {
      res.writeHead(401).end("unauthorized");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  });
  const backendPort = await listen(backend);
  const devices = new DeviceRegistry();
  devices.register({ id: "local", platform: "darwin", presence: "static", roots: ["/Users/Tester"] });
  devices.register({ id: "windows", platform: "win32", presence: "static", roots: ["C:\\Users\\Tester"] });
  const bindings = await new WorkspaceBindingStore().load();
  let forwarded;
  const runtime = {
    localDeviceId: "local", devices, bindings,
    routing: new RoutingPolicy({ devices, bindings }),
    peerMesh: {
      peers: new Map([["windows", {}]]),
      recoverBindings: async () => {},
      execute: async (_id, job) => {
        forwarded = job.request.headers;
        return {
          statusCode: 200, headers: { "content-type": "application/json" },
          bodyBase64: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 10, result: {
            structuredContent: { workspace_id: "ws_remote", root: "C:\\Users\\Tester", mode: "checkout" }
          } })).toString("base64")
        };
      }
    }
  };
  const router = createRouterServer({ backendHost: "127.0.0.1", backendPort,
    backendTimeoutMs: 2000 }, runtime);
  const port = await listen(router);
  t.after(async () => { await close(router); await close(backend); });
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST", headers: {
      authorization: "Bearer authorized-client", "content-type": "application/json",
      "mcp-method": "tools/call", "mcp-name": "open_workspace"
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "open_workspace", arguments: { path: "C:\\Users\\Tester", device_id: "windows" } } })
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(forwarded["mcp-method"], "tools/call");
  assert.equal(forwarded["mcp-name"], "open_workspace");
  assert.equal(bindings.get("ws_remote").deviceId, "windows");
});
