import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeviceCatalog } from "../src/device-catalog.js";
import { RouterPrivateState } from "../src/private-state.js";
import { createRouterRuntime } from "../src/runtime.js";
import { startRouter } from "../src/server.js";

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codassol-catalog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("Device Catalog persists a renamed identity, without changing its route key", async (t) => {
  const dir = await tmp(t);
  const a = await new DeviceCatalog({ stateDir: dir, origin: "mac" }).load();
  await a.observe({ id: "windows-01", defaultName: "Office PC", platform: "win32", kind: "router" });
  const before = a.get("windows-01");
  assert.equal(before.name, "Office PC");
  await a.rename("windows-01", "Home GPU");
  const b = await new DeviceCatalog({ stateDir: dir, origin: "mac" }).load();
  assert.equal(b.get("windows-01").name, "Home GPU");
  assert.equal(b.get("windows-01").id, before.id);
  assert.equal(b.get("windows-01").platform, "win32");
  assert.equal(await b.rename("not-registered", "Unknown"), null);
  assert.rejects(() => b.rename("windows-01", "  \n  "), /printable/);
  assert.rejects(() => b.observe({ id: "windows-01", defaultName: "Mac?", platform: "darwin" }), /DEVICE_ID_COLLISION/);
});

test("concurrent offline rename conflict converges independent of merge order", async (t) => {
  const root = await tmp(t);
  const a = await new DeviceCatalog({ stateDir: path.join(root, "a"), origin: "mac" }).load();
  const b = await new DeviceCatalog({ stateDir: path.join(root, "b"), origin: "win" }).load();
  for (const c of [a, b]) {
    await c.observe({ id: "device-id-1", defaultName: "Desktop", platform: "win32", kind: "router" });
  }
  await a.rename("device-id-1", "From Mac");
  await b.rename("device-id-1", "From Windows");
  // Both have logical revision 1, so origin lexical order is deterministic.
  await a.merge(b.snapshot());
  await b.merge(a.snapshot());
  assert.equal(a.get("device-id-1").name, "From Windows");
  assert.equal(b.get("device-id-1").name, "From Windows");
  await a.rename("device-id-1", "Newest Name");
  await b.merge(a.snapshot());
  assert.equal(b.get("device-id-1").name, "Newest Name");
  const reload = await new DeviceCatalog({ stateDir: path.join(root, "b"), origin: "win" }).load();
  assert.equal(reload.get("device-id-1").name, "Newest Name");
});

test("peer snapshot cannot mutate a known device platform or routing roots", async (t) => {
  const dir = await tmp(t);
  const catalog = await new DeviceCatalog({ stateDir: dir, origin: "mac" }).load();
  await catalog.observe({ id: "win", defaultName: "Win", platform: "win32", kind: "router" });
  await assert.rejects(catalog.merge({ version: 1, devices: [{
    id: "win", defaultName: "Spoofed", platform: "darwin", kind: "agent",
    rename: { name: "My PC", revision: { counter: 1, origin: "win" } }
  }] }), /DEVICE_ID_COLLISION/);
  await catalog.merge({ version: 1, devices: [{
    id: "win", defaultName: "Spoofed", platform: "win32", kind: "agent",
    rename: { name: "My PC", revision: { counter: 1, origin: "win" } }
  }] });
  assert.equal(catalog.get("win").name, "My PC");
  assert.equal(catalog.get("win").platform, "win32");
  assert.equal(catalog.get("win").kind, "router");
  assert.equal("roots" in catalog.get("win"), false);
  await assert.rejects(catalog.merge({ version: 1, devices: [
    { id: "malicious", defaultName: "X", rename: { name: "X", revision: { counter: -1, origin: "other" } } }
  ] }), /revision counter/);
});

test("pinned installation identities reject accidental legacy-ID collisions", async (t) => {
  const dir = await tmp(t);
  const catalog = await new DeviceCatalog({ stateDir: dir, origin: "mac" }).load();
  await catalog.observe({
    id: "shared-hostname", installationId: "installation-A-1234567890",
    defaultName: "First PC", platform: "darwin", kind: "router"
  });
  await assert.rejects(catalog.observe({
    id: "shared-hostname", installationId: "installation-B-1234567890",
    defaultName: "Second PC", platform: "darwin", kind: "router"
  }), /DEVICE_ID_COLLISION/);
  await assert.rejects(catalog.merge({ version: 1, devices: [{
    id: "shared-hostname", installationId: "installation-B-1234567890",
    defaultName: "Second PC", platform: "darwin", kind: "router",
    rename: { name: "Other machine", revision: { counter: 300, origin: "other" } }
  }] }), /DEVICE_ID_COLLISION/);
  assert.equal(catalog.get("shared-hostname").installationId, "installation-A-1234567890");
  assert.equal(catalog.get("shared-hostname").name, "First PC");
});

test("installation ID and admin token persist without rotating on Router restarts", async (t) => {
  const dir = await tmp(t);
  const first = await new RouterPrivateState({ stateDir: dir }).init();
  const second = await new RouterPrivateState({ stateDir: dir }).init();
  assert.equal(first.installationId, second.installationId);
  assert.equal(first.adminToken, second.adminToken);
  assert.notEqual(first.adminToken, first.peerToken);
  assert.notEqual(first.adminToken, first.pairingToken);
  assert.equal(second.verifyAdminToken(first.adminToken), true);
  assert.equal(second.verifyAdminToken(first.peerToken), false);
});

async function backend(t) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

function config(id, dir, backendPort) {
  return { stateDir: dir, localDeviceId: id, localDeviceLabel: `${id}-default`,
    localRoots: id === "windows" ? ["C:\\Users\\Demo"] : ["/Users/demo"],
    listenHost: "127.0.0.1", listenPort: 0, backendHost: "127.0.0.1",
    backendPort, backendTimeoutMs: 1000, peerProbeIntervalMs: 1000 };
}

async function fetchJson(port, endpoint, { token, method = "GET", body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    }, body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

test("two independent routers: authorized rename, peer sync, persist, Mac offline", async (t) => {
  const dir = await tmp(t);
  const winConfig = config("windows", path.join(dir, "windows"), await backend(t));
  const winRuntime = await createRouterRuntime(winConfig);
  const winRouter = await startRouter(winConfig, winRuntime);
  t.after(() => new Promise((resolve) => winRouter.listening ? winRouter.close(resolve) : resolve()));
  const winPort = winRouter.address().port;

  const macConfig = config("mac", path.join(dir, "mac"), await backend(t));
  const macInit = await new RouterPrivateState({ stateDir: macConfig.stateDir }).init();
  await writeFile(path.join(dir, "mac", "peers.json"), JSON.stringify([{
    id: "windows", url: `http://127.0.0.1:${winPort}`,
    token: winRuntime.privateState.peerToken, platform: "win32", roots: ["C:\\Users\\Demo"]
  }]));
  const macRuntime = await createRouterRuntime(macConfig);
  const macRouter = await startRouter(macConfig, macRuntime);
  t.after(() => new Promise((resolve) => macRouter.listening ? macRouter.close(resolve) : resolve()));
  const macPort = macRouter.address().port;

  const unauthorized = await fetchJson(macPort, "/_codassol/devices");
  assert.equal(unauthorized.status, 401);
  const pairingNotAdmin = await fetchJson(macPort, "/_codassol/devices", { token: macInit.pairingToken });
  assert.equal(pairingNotAdmin.status, 401);
  const allowed = await fetchJson(macPort, "/_codassol/devices", { token: macRuntime.privateState.adminToken });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.devices[0].id, "mac");
  assert.equal(allowed.body.devices.find((d) => d.id === "windows").status, "online");
  assert.equal(allowed.body.devices.find((d) => d.id === "windows").isThisDevice, false);
  assert.equal(allowed.body.devices[0].backendReachable, true);
  const peerUnauth = await fetchJson(macPort, "/_codassol/peer/catalog");
  assert.equal(peerUnauth.status, 401);

  const changed = await fetchJson(macPort, "/_codassol/devices/windows", {
    token: macRuntime.privateState.adminToken, method: "PATCH", body: { name: "GPU Tower" }
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.sync.delivered, 1);
  const onWindows = await fetchJson(winPort, "/_codassol/devices", { token: winRuntime.privateState.adminToken });
  assert.equal(onWindows.body.devices[0].name, "GPU Tower");
  assert.equal(onWindows.body.devices[0].isThisDevice, true);
  assert.equal(onWindows.body.devices.find((d) => d.id === "mac").status, "unknown");

  // Reverse rename from Windows works despite Mac being the only node with a
  // configured peer; its next authenticated anti-entropy pull converges.
  const reverse = await fetchJson(winPort, "/_codassol/devices/mac", {
    token: winRuntime.privateState.adminToken, method: "PATCH", body: { name: "Sean Mac" }
  });
  assert.equal(reverse.status, 200);
  await macRuntime.peerMesh.refresh();
  assert.equal(macRuntime.catalog.get("mac").name, "Sean Mac");
  assert.equal(macRuntime.localDeviceId, "mac");

  // Reopen persisted metadata while Mac Router is gone; Windows still lists
  // the previously discovered Mac and can serve its own directory locally.
  await new Promise((resolve) => macRouter.close(resolve));
  const reload = await new DeviceCatalog({ stateDir: winConfig.stateDir, origin: "windows" }).load();
  assert.equal(reload.get("mac").name, "Sean Mac");
  const offlineMac = await fetchJson(winPort, "/_codassol/devices", { token: winRuntime.privateState.adminToken });
  assert.equal(offlineMac.status, 200);
  assert.equal(offlineMac.body.devices.find((d) => d.id === "windows").status, "online");
});

test("multi-hop peer snapshots propagate a rename without a central Mac", async (t) => {
  const dir = await tmp(t);
  const cConfig = config("c", path.join(dir, "c"), await backend(t));
  const cRuntime = await createRouterRuntime(cConfig);
  const cServer = await startRouter(cConfig, cRuntime);
  t.after(() => new Promise((resolve) => cServer.listening ? cServer.close(resolve) : resolve()));
  const bConfig = config("b", path.join(dir, "b"), await backend(t));
  const bInit = await new RouterPrivateState({ stateDir: bConfig.stateDir }).init();
  await writeFile(path.join(bConfig.stateDir, "peers.json"), JSON.stringify([{
    id: "c", url: `http://127.0.0.1:${cServer.address().port}`,
    token: cRuntime.privateState.peerToken, platform: "unknown", roots: []
  }]));
  const bRuntime = await createRouterRuntime(bConfig);
  const bServer = await startRouter(bConfig, bRuntime);
  t.after(() => new Promise((resolve) => bServer.listening ? bServer.close(resolve) : resolve()));
  const aConfig = config("a", path.join(dir, "a"), await backend(t));
  await new RouterPrivateState({ stateDir: aConfig.stateDir }).init();
  await writeFile(path.join(aConfig.stateDir, "peers.json"), JSON.stringify([{
    id: "b", url: `http://127.0.0.1:${bServer.address().port}`,
    token: bInit.peerToken, platform: "unknown", roots: []
  }]));
  const aRuntime = await createRouterRuntime(aConfig);
  const aServer = await startRouter(aConfig, aRuntime);
  t.after(() => new Promise((resolve) => aServer.listening ? aServer.close(resolve) : resolve()));

  assert.ok(aRuntime.catalog.get("c"), "A must know C through authenticated B");
  const renamed = await fetchJson(aServer.address().port, "/_codassol/devices/c", {
    method: "PATCH", token: aRuntime.privateState.adminToken,
    body: { name: "Remote Third Device" }
  });
  assert.equal(renamed.status, 200);
  assert.equal(bRuntime.catalog.get("c").name, "Remote Third Device");
  await bRuntime.peerMesh.refresh();
  assert.equal(cRuntime.catalog.get("c").name, "Remote Third Device");
  assert.equal(cRuntime.localDeviceId, "c", "name replication must not alter Router identity");
});

test("device status separates a live Router from a degraded local backend", async (t) => {
  const dir = await tmp(t);
  const localConfig = config("solo", path.join(dir, "solo"), 1);
  const state = await new RouterPrivateState({ stateDir: localConfig.stateDir }).init();
  await state.enrollAgent({ id: "android-one", label: "RedMagic", platform: "android", roots: [] });
  const runtime = await createRouterRuntime(localConfig);
  const router = await startRouter(localConfig, runtime);
  t.after(() => new Promise((resolve) => router.close(resolve)));
  const list = await fetchJson(router.address().port, "/_codassol/devices", {
    token: state.adminToken
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.devices[0].id, "solo");
  assert.equal(list.body.devices[0].status, "degraded");
  assert.equal(list.body.devices.find((d) => d.id === "android-one").status, "offline");
  assert.equal(list.body.devices.find((d) => d.id === "android-one").name, "RedMagic");
  assert.equal(list.body.devices[0].backendReachable, false);
});
