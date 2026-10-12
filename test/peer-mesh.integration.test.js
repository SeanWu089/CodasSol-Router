import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRouterRuntime } from "../src/runtime.js";
import { startRouter } from "../src/server.js";
import { PeerMesh } from "../src/peer-mesh.js";
import { DeviceRegistry } from "../src/device-registry.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
async function close(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
async function createBackend(label) {
  const calls = [];
  const backend = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk.toString();
    const message = JSON.parse(data);
    calls.push({ label, message });
    const name = message.params?.name;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      jsonrpc: "2.0", id: message.id,
      result: name === "open_workspace"
        ? { structuredContent: {
          workspace_id: "ws_owned_by_windows", root: "C:\\Projects\\Demo", mode: "checkout"
        } }
        : { structuredContent: { source: label, operation: name } }
    }));
  });
  return { backend, port: await listen(backend), calls };
}
async function request(port, endpoint, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, options);
  return { status: response.status, body: await response.json() };
}
function mcpCall(id, name, args) {
  return {
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name, arguments: args }
  };
}
function config(id, stateDir, backendPort) {
  return {
    listenHost: "127.0.0.1", listenPort: 0,
    backendHost: "127.0.0.1", backendPort, backendTimeoutMs: 1000,
    stateDir, localDeviceId: id,
    localDeviceLabel: id, localRoots: id === "windows"
      ? ["C:\\Projects"] : ["/Users/example"],
    peerProbeIntervalMs: 1000
  };
}

test("Mac Router offline: Windows continues to serve a workspace opened through Mac", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codassol-mesh-"));
  const macBackend = await createBackend("mac");
  const winBackend = await createBackend("windows");
  const servers = [macBackend.backend, winBackend.backend];
  t.after(async () => {
    await Promise.all(servers.map(close));
    await rm(root, { recursive: true, force: true });
  });
  const winConfig = config("windows", path.join(root, "windows"), winBackend.port);
  const winRuntime = await createRouterRuntime(winConfig);
  // Real DevSpace OAuth is exercised by its own tests; this integration
  // isolates peer transport and owner-side bindings from OAuth internals.
  winRuntime.peerOAuth.authorizedFetch = async (_path, options) => {
    assert.notEqual(options.headers.authorization, "Bearer mac-client-secret");
    const body = JSON.parse(options.body.toString());
    const result = body.params.name === "open_workspace"
      ? { workspace_id: "ws_owned_by_windows", root: "C:\\Projects\\Demo", mode: "checkout" }
      : { source: "windows", operation: body.params.name };
    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: body.id, result: { structuredContent: result }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const winRouter = await startRouter(winConfig, winRuntime);
  servers.push(winRouter);
  const winPort = winRouter.address().port;
  const missingAuth = await request(winPort, "/_codassol/peer/info");
  assert.equal(missingAuth.status, 401, "peer metadata must not be public");
  const missingExecuteAuth = await request(winPort, "/_codassol/peer/execute", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  assert.equal(missingExecuteAuth.status, 401, "execution must not be public");

  const macConfig = config("mac", path.join(root, "mac"), macBackend.port);
  await mkdir(macConfig.stateDir, { recursive: true });
  await writeFile(path.join(root, "mac", "peers.json"), JSON.stringify([{
    id: "windows", url: `http://127.0.0.1:${winPort}`,
    token: winRuntime.privateState.peerToken, platform: "win32",
    roots: ["C:\\Projects"]
  }]));
  const macRuntime = await createRouterRuntime(macConfig);
  const macRouter = await startRouter(macConfig, macRuntime);
  servers.push(macRouter);
  const macPort = macRouter.address().port;
  assert.equal(macRuntime.devices.get("windows").online, true);
  const runRemote = macRuntime.peerMesh.execute.bind(macRuntime.peerMesh);
  macRuntime.peerMesh.execute = async (id, job) => {
    assert.equal(job.request.headers.authorization, undefined,
      "do not transmit the initiating client's DevSpace bearer across nodes");
    return runRemote(id, job);
  };

  const opened = await request(macPort, "/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer mac-client-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify(mcpCall(1, "open_workspace", {
      path: "C:\\Projects\\Demo"
    }))
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.result.structuredContent.workspace_id, "ws_owned_by_windows");
  assert.equal(macRuntime.bindings.get("ws_owned_by_windows").deviceId, "windows");
  assert.equal(winRuntime.bindings.get("ws_owned_by_windows").deviceId, "windows");

  await close(macRouter); // Mac is now offline.
  const read = await request(winPort, "/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(mcpCall(2, "read", {
      workspace_id: "ws_owned_by_windows", path: "README.md"
    }))
  });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.result.structuredContent.source, "windows");
  assert.ok(winBackend.calls.some((call) => call.message.params?.name === "read"));

  // A third Router that never saw the open_workspace call can discover its
  // owner from Windows, without reaching the original Mac Router.
  const laptopBackend = await createBackend("laptop");
  servers.push(laptopBackend.backend);
  const laptopConfig = config("laptop", path.join(root, "laptop"), laptopBackend.port);
  await mkdir(laptopConfig.stateDir, { recursive: true });
  await writeFile(path.join(laptopConfig.stateDir, "peers.json"), JSON.stringify([{
    id: "windows", url: `http://127.0.0.1:${winPort}`,
    token: winRuntime.privateState.peerToken, platform: "win32",
    roots: ["C:\\Projects"]
  }]));
  const laptopRuntime = await createRouterRuntime(laptopConfig);
  const laptopRouter = await startRouter(laptopConfig, laptopRuntime);
  servers.push(laptopRouter);
  const recovered = await request(laptopRouter.address().port, "/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer laptop-client" },
    body: JSON.stringify(mcpCall(3, "read", {
      workspace_id: "ws_owned_by_windows", path: "README.md"
    }))
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.result.structuredContent.source, "windows");
  assert.equal(laptopRuntime.bindings.get("ws_owned_by_windows").deviceId, "windows");

  // A dead execution backend must not trigger a guess/replay on the laptop.
  await close(winBackend.backend);
  await laptopRuntime.peerMesh.refresh();
  assert.equal(laptopRuntime.devices.get("windows").online, false);
  const offline = await request(laptopRouter.address().port, "/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(mcpCall(4, "open_workspace", {
      path: "C:\\Projects\\Demo"
    }))
  });
  assert.equal(offline.status, 502);
  assert.equal(offline.body.error, "DEVICE_OFFLINE");
});

test("Peer configuration fails closed for insecure transport, colliding IDs and short tokens", () => {
  const runtime = {
    localDeviceId: "mac",
    devices: {
      get: () => null,
      register: () => {}
    }
  };
  const base = { id: "windows", platform: "win32", roots: ["C:\\Projects"],
    token: "a".repeat(40), url: "http://192.168.1.50:17676" };
  assert.throws(() => new PeerMesh({ runtime, peers: [base] }), /requires HTTPS/);
  assert.throws(() => new PeerMesh({ runtime, peers: [
    { ...base, url: "http://127.0.0.1:17676", token: "short" }
  ] }), /at least 32/);
  assert.throws(() => new PeerMesh({ runtime, peers: [
    { ...base, id: "mac", url: "http://127.0.0.1:17676" }
  ] }), /different from the local/);
});

test("Peer health allows slow but authenticated tailnet HTTPS without falsely marking a node offline", async () => {
  const devices = new DeviceRegistry();
  const runtime = {
    localDeviceId: "mac",
    devices,
    catalog: {
      observe: async () => {},
      get: () => null
    }
  };
  const peer = {
    id: "windows-router",
    url: "https://windows-router.example.test",
    token: "a".repeat(40),
    platform: "win32",
    roots: ["C:\\Users\\Tester"]
  };
  const fetchFn = async (_url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({
      protocol: 2, id: peer.id, label: "Windows", platform: "win32",
      roots: peer.roots, backendReachable: true
    }), { status: 200, headers: { "content-type": "application/json" } })), 2800);
    options.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(options.signal.reason);
    }, { once: true });
  });
  const mesh = new PeerMesh({ runtime, peers: [peer], fetchFn });
  await mesh.refresh();
  assert.equal(mesh.peerHealth.get(peer.id).reachable, true);
  assert.equal(mesh.peerHealth.get(peer.id).backendReachable, true);
  assert.equal(devices.get(peer.id).online, true);
});
