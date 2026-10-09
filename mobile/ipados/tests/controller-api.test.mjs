import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleControllerRoute, createControllerListener } from "../router-addon/controller-api.js";

function createDeviceHub() {
  const devices = new Map();
  return {
    get: (id) => devices.get(id) || null,
    register: (device) => {
      const saved = { ...device, online: true, lastSeenAt: Date.now() };
      devices.set(device.id, saved);
      return saved;
    },
    heartbeat: (id, patch) => {
      const next = { ...devices.get(id), ...patch, online: true, lastSeenAt: Date.now() };
      devices.set(id, next);
      return next;
    },
    list: () => [...devices.values()]
  };
}

async function withServer(fn) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "codassol-controller-test-"));
  const devices = createDeviceHub();
  devices.register({ id: "mac", label: "Mac Studio", platform: "darwin", roots: [], online: true });
  const runtime = {
    stateDir, localDeviceId: "mac", devices,
    privateState: {
      verifyPairingToken: (token) => token === "test-pair-secret",
      listAgents: () => [{ id: "windows", label: "Windows 11", platform: "win32" }]
    }
  };
  const server = http.createServer(async (req, res) => {
    if (!await handleControllerRoute(req, res, {}, runtime, async () => true)) {
      res.writeHead(404); res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, stateDir, runtime);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}

const ID = "controller-123e4567-e89b-12d3-a456-426614174000";

function enroll(base, secret = "test-pair-secret", deviceId = ID) {
  return fetch(`${base}/_codassol/controller/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ deviceId, label: "Sean's iPad" })
  });
}

test("enrollment requires pairing credentials and validates controller IDs", async () => {
  await withServer(async (base) => {
    assert.equal((await enroll(base, "wrong")).status, 401);
    assert.equal((await enroll(base, "test-pair-secret", "mac")).status, 400);
    const result = await enroll(base);
    assert.equal(result.status, 201);
    const parsed = await result.json();
    assert.equal(parsed.deviceId, ID);
    assert.ok(parsed.controllerToken.length >= 40);
  });
});

test("controller token is hashed on disk and does not leak into device listings", async () => {
  await withServer(async (base, dir) => {
    const { controllerToken } = await (await enroll(base)).json();
    const saved = await readFile(path.join(dir, "controllers.json"), "utf8");
    assert.ok(!saved.includes(controllerToken));
    assert.ok(!saved.includes("test-pair-secret"));
    assert.equal((await fetch(base + "/_codassol/controller/devices")).status, 401);
    const response = await fetch(base + "/_codassol/controller/devices", {
      headers: { authorization: `Bearer ${controllerToken}` }
    });
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.protocol, 1);
    assert.equal(snapshot.routerDeviceId, "mac");
    assert.equal(snapshot.devices.find((d) => d.id === "mac").backendReachable, true);
    assert.equal(snapshot.devices.find((d) => d.id === "windows").online, false);
    assert.equal(snapshot.devices.find((d) => d.id === ID).kind, "controller");
    assert.ok(!JSON.stringify(snapshot).includes(controllerToken));
    assert.ok(!JSON.stringify(snapshot).includes("roots"));
  });
});

test("re-enrollment rotates tokens and invalidates previous credential", async () => {
  await withServer(async (base) => {
    const first = await (await enroll(base)).json();
    const second = await (await enroll(base)).json();
    assert.notEqual(first.controllerToken, second.controllerToken);
    const oldStatus = await fetch(base + "/_codassol/controller/devices", {
      headers: { authorization: `Bearer ${first.controllerToken}` }
    });
    assert.equal(oldStatus.status, 401);
    const newStatus = await fetch(base + "/_codassol/controller/devices", {
      headers: { authorization: `Bearer ${second.controllerToken}` }
    });
    assert.equal(newStatus.status, 200);
  });
});

test("dedicated iPad listener does not expose the MCP proxy", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "codassol-controller-only-"));
  const runtime = {
    stateDir, localDeviceId: "mac", devices: createDeviceHub(),
    privateState: { verifyPairingToken: () => false, listAgents: () => [] }
  };
  const server = createControllerListener({}, runtime, async () => true);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + "/mcp", { method: "POST" });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "not_found");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});
