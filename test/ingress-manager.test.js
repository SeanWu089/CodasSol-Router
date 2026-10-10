import assert from "node:assert/strict";
import test from "node:test";
import { ingressEligibility, preferredIngressCandidate } from "../src/ingress/eligibility.js";
import { IngressManager, IngressState } from "../src/ingress/ingress-manager.js";

const domain = "https://codassol.example.test";

function eligibleNode(installationId, overrides = {}) {
  return {
    installationId, platform: "win32", priority: 10,
    userEnabled: true, identityVerified: true,
    routerReady: true, backendReady: true, networkReady: true,
    adapterAvailable: true, durableService: true,
    credentialsProvisioned: true, clientAuthReady: true,
    ...overrides
  };
}

function coordinator(now = () => 1000) {
  let claim = null;
  let lastEpoch = 0;
  return {
    async acquire({ ownerId }) {
      if (claim && claim.expiresAt > now()) return null;
      claim = {
        ownerId, epoch: ++lastEpoch, expiresAt: now() + 30_000,
        fencingToken: "fence-proof-longer-than-16-" + lastEpoch
      };
      return { ...claim };
    },
    async verify(candidate) {
      return !!claim && claim.ownerId === candidate.ownerId &&
        claim.epoch === candidate.epoch &&
        claim.fencingToken === candidate.fencingToken &&
        claim.expiresAt > now();
    },
    async renew(candidate) {
      if (!await this.verify(candidate)) return null;
      claim.expiresAt = now() + 30_000;
      return { ...claim };
    },
    async release(candidate) {
      if (!await this.verify(candidate)) return false;
      claim = null;
      return true;
    },
    revoke() { claim = null; },
    activeOwner() { return claim?.ownerId || null; }
  };
}

function adapter(lease) {
  return {
    fencedActivation: true,
    active: false, starts: 0, stops: 0,
    async start({ claim }) {
      assert.equal(await lease.verify(claim), true,
        "data-plane adapter must not accept an unverified claim");
      this.starts += 1;
      this.active = true;
    },
    async stop() { this.stops += 1; this.active = false; }
  };
}

test("eligibility is based on real capabilities, not a hostname or heartbeat", () => {
  assert.deepEqual(ingressEligibility(null),
    { eligible: false, failures: ["missing_node"] });
  assert.equal(ingressEligibility(eligibleNode("mac")).eligible, true);
  const phone = eligibleNode("android", {
    platform: "android", durableService: false, clientAuthReady: false
  });
  assert.deepEqual(ingressEligibility(phone).failures,
    ["runtime_not_durable", "public_auth_not_ready"]);
  assert.equal(ingressEligibility(eligibleNode("windows",
    { identityVerified: false })).eligible, false);
  assert.equal(ingressEligibility(eligibleNode("ios", {
    platform: "ios", durableService: false
  })).eligible, false);
  // Android with an actually supported durable service is allowed.
  assert.equal(ingressEligibility(eligibleNode("android",
    { platform: "android" })).eligible, true);
});

test("candidate ordering is deterministic and only gives permission to TRY a lease", () => {
  const mac = eligibleNode("mac", { priority: 1 });
  const windows = eligibleNode("windows", { priority: 2 });
  assert.equal(preferredIngressCandidate([mac, windows]), "windows");
  assert.equal(preferredIngressCandidate([windows, mac], {
    incumbentId: "mac"
  }), "mac");
  assert.equal(preferredIngressCandidate([mac, windows], {
    incumbentId: "mac-disabled"
  }), "windows");
  assert.equal(preferredIngressCandidate([mac, eligibleNode("bad", {
    userEnabled: false, priority: 99
  })]), "mac");
  assert.equal(preferredIngressCandidate([eligibleNode("a", {
    networkReady: false
  })]), null);
});

test("manager refuses implicit activation and requires a fenced provider", async () => {
  const lease = coordinator();
  const winAdapter = adapter(lease);
  const node = eligibleNode("windows");
  assert.throws(() => new IngressManager({
    installationId: node.installationId, domain, lease,
    adapter: { start() {}, stop() {} }
  }), /fenced activation/);
  const manager = new IngressManager({
    installationId: node.installationId, domain, lease, adapter: winAdapter
  });
  assert.equal((await manager.reconcile({ local: node })).state, IngressState.DISABLED);
  assert.equal(winAdapter.starts, 0);
  assert.equal(lease.activeOwner(), null);
  assert.ok(!JSON.stringify(manager.snapshot()).includes("fence-proof"));
});

test("two qualified hosts cannot activate the same fixed URL", async () => {
  const lease = coordinator();
  const macAdapter = adapter(lease);
  const winAdapter = adapter(lease);
  const mac = new IngressManager({
    installationId: "mac", domain, lease, adapter: macAdapter, enabled: true,
    clock: () => 1000
  });
  const windows = new IngressManager({
    installationId: "windows", domain, lease, adapter: winAdapter, enabled: true,
    clock: () => 1000
  });
  const macNode = eligibleNode("mac", { priority: 20 });
  const winNode = eligibleNode("windows", { priority: 10 });
  assert.equal((await mac.reconcile({ local: macNode, peers: [winNode] })).state,
    IngressState.ACTIVE);
  assert.equal((await windows.reconcile({ local: winNode, peers: [] })).state,
    IngressState.STANDBY);
  assert.equal(lease.activeOwner(), "mac");
  assert.equal(macAdapter.starts, 1);
  assert.equal(winAdapter.starts, 0);

  // Active incumbent renews without restarting its public listener.
  assert.equal((await mac.reconcile({ local: macNode })).state, IngressState.ACTIVE);
  assert.equal(macAdapter.starts, 1);

  // Mac intentionally drains; Windows can then independently take over.
  mac.enabled = false;
  assert.equal((await mac.reconcile({ local: macNode })).state, IngressState.DISABLED);
  assert.equal(macAdapter.active, false);
  assert.equal(lease.activeOwner(), null);
  assert.equal((await windows.reconcile({ local: winNode })).state, IngressState.ACTIVE);
  assert.equal(lease.activeOwner(), "windows");
  assert.equal(winAdapter.active, true);
});

test("unconfirmed identity or invalid lease proof NEVER starts an adapter", async () => {
  const faultyLease = {
    acquire: async () => ({
      ownerId: "wrong-node", epoch: 1, expiresAt: 31000,
      fencingToken: "fake-proof-long-enough"
    }),
    verify: async () => true,
    renew: async () => null,
    release: async () => true
  };
  const winAdapter = adapter(faultyLease);
  const manager = new IngressManager({
    installationId: "windows", domain, lease: faultyLease,
    adapter: winAdapter, enabled: true, clock: () => 1000
  });
  const result = await manager.reconcile({ local: eligibleNode("windows") });
  assert.equal(result.state, IngressState.FENCED);
  assert.equal(winAdapter.starts, 0);
  assert.equal(result.reason, "activation_failed_or_unfenced");
});

test("lost external ownership stops the old ingress and requires recovery", async () => {
  const lease = coordinator();
  const oldAdapter = adapter(lease);
  const manager = new IngressManager({
    installationId: "mac", domain, lease,
    adapter: oldAdapter, enabled: true, clock: () => 1000
  });
  await manager.reconcile({ local: eligibleNode("mac") });
  lease.revoke(); // provider-side fencing, e.g. old ngrok endpoint revoked
  const snapshot = await manager.reconcile({ local: eligibleNode("mac") });
  assert.equal(snapshot.state, IngressState.FENCED);
  assert.equal(snapshot.reason, "lease_renewal_failed");
  assert.equal(oldAdapter.active, false);
  assert.equal(oldAdapter.stops, 1);
  assert.equal((await manager.reconcile({ local: eligibleNode("mac") })).state,
    IngressState.FENCED);
});

test("failed startup is cleaned up and cannot be reported as online", async () => {
  const lease = coordinator();
  const a = adapter(lease);
  a.start = async () => { a.starts++; a.active = true; throw new Error("port busy"); };
  const manager = new IngressManager({
    installationId: "mac", domain, lease, adapter: a, enabled: true,
    clock: () => 1000
  });
  const result = await manager.reconcile({ local: eligibleNode("mac") });
  assert.equal(result.state, IngressState.FENCED);
  assert.equal(a.active, false);
  assert.equal(lease.activeOwner(), null);
});

test("cannot release an exclusive lease if stopping our listener fails", async () => {
  const lease = coordinator();
  const a = adapter(lease);
  const manager = new IngressManager({
    installationId: "mac", domain, lease, adapter: a, enabled: true,
    clock: () => 1000
  });
  await manager.reconcile({ local: eligibleNode("mac") });
  a.stop = async () => { throw new Error("listener still running"); };
  manager.enabled = false;
  const result = await manager.reconcile({ local: eligibleNode("mac") });
  assert.equal(result.state, IngressState.FENCED);
  assert.equal(result.reason, "could_not_stop_listener");
  assert.equal(lease.activeOwner(), "mac", "must not release while active");
});

test("disabled state cannot conceal a claim that failed to release", async () => {
  const lease = coordinator();
  const a = adapter(lease);
  const manager = new IngressManager({
    installationId: "mac", domain, lease, adapter: a, enabled: true,
    clock: () => 1000
  });
  await manager.reconcile({ local: eligibleNode("mac") });
  const normalRelease = lease.release.bind(lease);
  lease.release = async () => { throw new Error("lease service disconnected"); };
  manager.enabled = false;
  const first = await manager.reconcile({ local: eligibleNode("mac") });
  assert.equal(first.state, IngressState.FENCED);
  assert.equal(first.reason, "could_not_release_lease");
  assert.equal(a.active, false);
  assert.equal(lease.activeOwner(), "mac");
  lease.release = normalRelease;
  const second = await manager.reconcile({ local: eligibleNode("mac") });
  assert.equal(second.state, IngressState.DISABLED);
  assert.equal(lease.activeOwner(), null);
});

test("concurrent health ticks serialize; neither duplicates listener creation", async () => {
  const lease = coordinator();
  const a = adapter(lease);
  const manager = new IngressManager({
    installationId: "mac", domain, lease, adapter: a, enabled: true,
    clock: () => 1000
  });
  const result = await Promise.all(Array.from({ length: 12 }, () =>
    manager.reconcile({ local: eligibleNode("mac") })));
  assert.equal(result.at(-1).state, IngressState.ACTIVE);
  assert.equal(a.starts, 1);
  assert.equal(lease.activeOwner(), "mac");
});
