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

test("offline specific project root cannot fall back to another machine's broader root", () => {
  const fixture = makePolicy({ ttl: 500 });
  fixture.devices.register({
    id: "windows-local", platform: "win32", presence: "static", roots: ["C:\\Users"]
  });
  fixture.devices.register({
    id: "windows-away", platform: "win32", presence: "heartbeat",
    roots: ["C:\\Users\\Example\\Project"]
  });
  fixture.advance(501);
  assert.throws(
    () => fixture.policy.resolveOpenWorkspace({ path: "C:\\Users\\Example\\Project\\src" }),
    (error) => error.code === "DEVICE_OFFLINE"
  );
});

test("an unmatched Windows path never falls back to the only Mac", () => {
  const { devices, policy } = makePolicy();
  devices.register({
    id: "local",
    platform: "darwin",
    presence: "static",
    roots: ["/Users/example"]
  });
  assert.throws(
    () => policy.resolveOpenWorkspace({ path: "C:/Users/ASUS/Desktop" }),
    (error) => error.code === "NO_DEVICE_MATCH" && error.details.deviceIds.includes("local")
  );
});

test("home shorthand is resolved against a matching device root, not router OS guesses", () => {
  const { devices, policy } = makePolicy();
  devices.register({ id: "mac", platform: "darwin", presence: "static", roots: ["/Users/example"] });
  devices.register({ id: "windows", platform: "win32", presence: "static", roots: ["C:\\Users\\Example"] });
  assert.deepEqual(policy.resolveOpenWorkspace({ path: "~/Desktop", deviceId: "mac" }).path,
    "/Users/example/Desktop");
  assert.deepEqual(policy.resolveOpenWorkspace({ path: "~/Desktop", deviceId: "windows" }).path,
    "C:\\Users\\Example\\Desktop");
});

test("unqualified home shorthand with multiple devices asks for target", () => {
  const { devices, policy } = makePolicy();
  devices.register({ id: "mac", platform: "darwin", presence: "static", roots: ["/Users/example"] });
  devices.register({ id: "windows", platform: "win32", presence: "static", roots: ["C:\\Users\\Example"] });
  assert.throws(
    () => policy.resolveOpenWorkspace({ path: "~/Desktop" }),
    (error) => error.code === "AMBIGUOUS_DEVICE" && error.details.deviceIds.length === 2
  );
});

test("explicit device selection preserves paths and never silently switches devices", () => {
  const { devices, policy } = makePolicy();
  devices.register({ id: "mac", platform: "darwin", presence: "static", roots: ["/Users/example"] });
  devices.register({ id: "windows", platform: "win32", presence: "static", roots: ["C:\\Users\\Example"] });
  assert.equal(policy.resolveOpenWorkspace({ path: "C:/Users/Example/Desktop", deviceId: "windows" }).id, "windows");
  assert.throws(
    () => policy.resolveOpenWorkspace({ path: "/Users/example/Desktop", deviceId: "windows" }),
    (error) => error.code === "PATH_NOT_ON_DEVICE"
  );
});

test("legacy rootless Windows Agent can be explicitly selected without broadening permissions", () => {
  const { devices, policy } = makePolicy();
  devices.register({ id: "old-win", platform: "win32", presence: "static", roots: [] });
  assert.equal(policy.resolveOpenWorkspace({ path: "~/Desktop", deviceId: "old-win" }).path, "~/Desktop");
  assert.equal(policy.resolveOpenWorkspace({ path: "D:\\Projects", deviceId: "old-win" }).id, "old-win");
  assert.throws(() => policy.resolveOpenWorkspace({ path: "/Users/sean", deviceId: "old-win" }),
    (error) => error.code === "PATH_NOT_ON_DEVICE");
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

