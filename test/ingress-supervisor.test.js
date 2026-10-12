import assert from "node:assert/strict";
import test from "node:test";
import { IngressManager, IngressState } from "../src/ingress/ingress-manager.js";
import { IngressSupervisor } from "../src/ingress/ingress-supervisor.js";

const domain = "https://stable-codas.example.test";
const validNode = (installationId) => ({
  installationId, platform: "darwin", priority: 10,
  userEnabled: true, identityVerified: true,
  routerReady: true, backendReady: true, networkReady: true,
  adapterAvailable: true, durableService: true,
  credentialsProvisioned: true, clientAuthReady: true
});

function fakeAuthority() {
  let held = null;
  let epoch = 0;
  return {
    async acquire({ ownerId }) {
      if (held) return null;
      held = { ownerId, epoch: ++epoch, expiresAt: 60_000,
        fencingToken: "test-only-fence-token-value" + epoch };
      return { ...held };
    },
    async verify(value) {
      return held?.ownerId === value?.ownerId &&
        held?.fencingToken === value?.fencingToken;
    },
    async renew(value) { return await this.verify(value) ? { ...held } : null; },
    async release(value) {
      if (!await this.verify(value)) throw new Error("not owner");
      held = null;
    },
    get owner() { return held?.ownerId ?? null; }
  };
}

function fakeAdapter(lease) {
  return {
    fencedActivation: true, starts: 0, stops: 0, active: false,
    async start({ claim }) {
      assert.equal(await lease.verify(claim), true);
      this.starts++;
      this.active = true;
    },
    async stop() { this.stops++; this.active = false; }
  };
}

function nodeSupervisor(id, authority, source = async () => ({
  local: validNode(id)
})) {
  const adapter = fakeAdapter(authority);
  const manager = new IngressManager({
    installationId: id, domain, lease: authority,
    adapter, enabled: true, clock: () => 1_000
  });
  return { manager, adapter, supervisor: new IngressSupervisor({
    manager, candidateSnapshot: source, intervalMs: 5000
  }) };
}

test("supervisor starts one ingress, renews without restarting, then drains on stop", async () => {
  const lease = fakeAuthority();
  const { adapter, supervisor } = nodeSupervisor("mac", lease);
  assert.equal(supervisor.running, false);
  assert.equal((await supervisor.start()).state, IngressState.ACTIVE);
  assert.equal(supervisor.running, true);
  await Promise.all(Array.from({ length: 10 }, () => supervisor.tick()));
  assert.equal(adapter.starts, 1);
  assert.equal(adapter.stops, 0);
  assert.equal((await supervisor.stop()).state, IngressState.DISABLED);
  assert.equal(lease.owner, null);
  assert.equal(adapter.stops, 1);
  assert.equal(supervisor.running, false);
});

test("missing network health snapshot drains a previously active endpoint", async () => {
  const lease = fakeAuthority();
  let broken = false;
  const events = [];
  const { manager, adapter } = nodeSupervisor("mac", lease);
  const supervisor = new IngressSupervisor({
    manager,
    candidateSnapshot: async () => {
      if (broken) throw new Error("probe timeout");
      return { local: validNode("mac") };
    },
    onError: (error) => events.push(error.message)
  });
  assert.equal((await supervisor.start()).state, IngressState.ACTIVE);
  broken = true;
  assert.equal((await supervisor.tick()).state, IngressState.STANDBY);
  assert.equal(lease.owner, null);
  assert.equal(adapter.active, false);
  assert.deepEqual(events, ["probe timeout"]);
  await supervisor.stop();
});

test("candidate discovery deadline drains ACTIVE and avoids an indefinite stop", async () => {
  const lease = fakeAuthority();
  let unresponsive = false;
  const { manager, adapter } = nodeSupervisor("mac", lease);
  const failures = [];
  const supervisor = new IngressSupervisor({
    manager, snapshotTimeoutMs: 100,
    candidateSnapshot: async () => unresponsive
      ? new Promise(() => {}) : { local: validNode("mac") },
    onError: (error) => failures.push(error.message)
  });
  assert.equal((await supervisor.start()).state, IngressState.ACTIVE);
  unresponsive = true;
  const started = Date.now();
  assert.equal((await supervisor.tick()).state, IngressState.STANDBY);
  assert.ok(Date.now() - started < 750);
  assert.equal(adapter.active, false);
  assert.equal(lease.owner, null);
  assert.deepEqual(failures, ["candidate_snapshot_timeout"]);
  await supervisor.stop();
});

test("two supervisors do not both acquire ingress, follower takes over after clean release", async () => {
  const lease = fakeAuthority();
  const mac = nodeSupervisor("mac", lease);
  const windows = nodeSupervisor("windows", lease);
  await Promise.all([mac.supervisor.start(), windows.supervisor.start()]);
  assert.equal(Number(mac.adapter.active) + Number(windows.adapter.active), 1);
  const leader = mac.adapter.active ? mac : windows;
  const standby = mac.adapter.active ? windows : mac;
  await leader.supervisor.stop();
  assert.equal((await standby.supervisor.tick()).state, IngressState.ACTIVE);
  assert.equal(standby.adapter.starts, 1);
  assert.equal(lease.owner, standby.manager.installationId);
  assert.equal((await leader.supervisor.tick()).state, IngressState.DISABLED);
  await standby.supervisor.stop();
});

test("stop waits for a pending candidate probe and cannot leave an active listener", async () => {
  const lease = fakeAuthority();
  let releaseProbe;
  const ready = new Promise((resolve) => { releaseProbe = resolve; });
  const { manager, adapter } = nodeSupervisor("mac", lease);
  const supervisor = new IngressSupervisor({
    manager, candidateSnapshot: async () => {
      await ready;
      return { local: validNode("mac") };
    }
  });
  const starting = supervisor.start();
  const stopping = supervisor.stop();
  releaseProbe();
  await starting;
  assert.equal((await stopping).state, IngressState.DISABLED);
  assert.equal(adapter.active, false);
  assert.equal(lease.owner, null);
});
