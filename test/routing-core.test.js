import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeviceRegistry } from "../src/device-registry.js";
import { RoutingDecisionError, RoutingPolicy } from "../src/routing-policy.js";
import {
  WorkspaceBindingConflictError,
  WorkspaceBindingStore
} from "../src/workspace-bindings.js";

function makePolicy({ now = 1_000, ttl = 1_000, filePath = null } = {}) {
  let current = now;
  const clock = () => current;
  const devices = new DeviceRegistry({ clock, heartbeatTtlMs: ttl });
  const bindings = new WorkspaceBindingStore({ filePath, clock });
  const policy = new RoutingPolicy({ devices, bindings });
  return {
    devices,
    bindings,
    policy,
    advance(ms) {
      current += ms;
    }
  };
}

test("resolves Windows paths using Windows semantics on any router OS", () => {
  const { devices, policy } = makePolicy();
  devices.register({
    id: "mac",
    platform: "darwin",
    presence: "static",
    roots: ["/Users/example/Projects"]
  });
  devices.register({
    id: "windows",
    platform: "win32",
    presence: "static",
    roots: ["C:\\Users\\Example\\Projects"]
  });
  const selected = policy.resolveOpenWorkspace({
    path: "c:\\users\\example\\projects\\Demo"
  });
  assert.equal(selected.id, "windows");
});

test("most specific project root wins", () => {
  const { devices, policy } = makePolicy();
  devices.register({
    id: "general",
    platform: "darwin",
    presence: "static",
    roots: ["/work"]
  });
  devices.register({
    id: "special",
    platform: "darwin",
    presence: "static",
    roots: ["/work/special"]
  });
  assert.equal(
    policy.resolveOpenWorkspace({ path: "/work/special/project" }).id,
    "special"
  );
});

test("equal path matches fail closed as ambiguous", () => {
  const { devices, policy } = makePolicy();
  for (const id of ["one", "two"]) {
    devices.register({
      id,
      platform: "linux",
      presence: "static",
      roots: ["/projects"]
    });
  }
  assert.throws(
    () => policy.resolveOpenWorkspace({ path: "/projects/demo" }),
    (error) => error instanceof RoutingDecisionError && error.code === "AMBIGUOUS_DEVICE"
  );
});

test("matching heartbeat device fails closed after it goes offline", () => {
  const fixture = makePolicy({ ttl: 500 });
  fixture.devices.register({
    id: "remote",
    platform: "win32",
    presence: "heartbeat",
    roots: ["D:\\Projects"]
  });
  fixture.advance(501);
  assert.throws(
    () => fixture.policy.resolveOpenWorkspace({ path: "D:\\Projects\\Demo" }),
    (error) => error instanceof RoutingDecisionError && error.code === "DEVICE_OFFLINE"
  );
});

test("single online device remains a backward-compatible fallback", () => {
  const { devices, policy } = makePolicy();
  devices.register({
    id: "local",
    platform: "darwin",
    presence: "static",
    roots: []
  });
  assert.equal(policy.resolveOpenWorkspace({ path: "/any/project" }).id, "local");
});

test("workspace binding is sticky and routes to the original device", async () => {
  const { devices, bindings, policy } = makePolicy();
  devices.register({ id: "mac", platform: "darwin", presence: "static" });
  devices.register({ id: "windows", platform: "win32", presence: "static" });
  await bindings.load();
  await policy.bindWorkspace({
    workspaceId: "ws_demo",
    deviceId: "windows",
    root: "C:\\Projects\\Demo",
    mode: "checkout"
  });
  const resolved = policy.resolveWorkspace("ws_demo");
  assert.equal(resolved.device.id, "windows");
  assert.equal(resolved.binding.root, "C:\\Projects\\Demo");
});

test("workspace cannot silently move between devices", async () => {
  const { devices, bindings, policy } = makePolicy();
  devices.register({ id: "mac", platform: "darwin", presence: "static" });
  devices.register({ id: "windows", platform: "win32", presence: "static" });
  await bindings.load();
  await policy.bindWorkspace({ workspaceId: "ws_demo", deviceId: "mac" });
  await assert.rejects(
    policy.bindWorkspace({ workspaceId: "ws_demo", deviceId: "windows" }),
    WorkspaceBindingConflictError
  );
});

test("bindings persist atomically outside the repository", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codassol-bindings-"));
  const filePath = path.join(directory, "bindings.json");
  try {
    const first = new WorkspaceBindingStore({ filePath, clock: () => 100 });
    await first.load();
    await first.bind({
      workspaceId: "ws_persisted",
      deviceId: "device-a",
      root: "/project",
      mode: "checkout"
    });

    const raw = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.bindings.length, 1);

    const second = new WorkspaceBindingStore({ filePath, clock: () => 200 });
    await second.load();
    assert.equal(second.get("ws_persisted").deviceId, "device-a");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

