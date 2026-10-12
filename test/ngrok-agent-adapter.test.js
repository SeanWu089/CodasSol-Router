import assert from "node:assert/strict";
import test from "node:test";
import { NgrokAgentIngressAdapter } from "../src/ingress/ngrok-agent-adapter.js";
import { IngressManager, IngressState } from "../src/ingress/ingress-manager.js";

const domain = "https://fixed.ngrok-free.dev";

const node = {
  installationId: "windows-uuid",
  userEnabled: true, identityVerified: true, routerReady: true,
  backendReady: true, networkReady: true, adapterAvailable: true,
  durableService: true, credentialsProvisioned: true, clientAuthReady: true
};

function stubProvider() {
  let claim = null;
  let epoch = 0;
  return {
    enforcesExternalFencing: true, // simulated ONLY, never a production lock
    async acquire({ ownerId }) {
      if (claim) return null;
      claim = { ownerId, epoch: ++epoch, expiresAt: 30000,
        fencingToken: "long-fencing-token-" + epoch };
      return { ...claim };
    },
    async verify(probe) {
      return !!claim && claim.ownerId === probe.ownerId &&
        claim.epoch === probe.epoch && claim.fencingToken === probe.fencingToken;
    },
    async renew(probe) { return await this.verify(probe) ? { ...claim } : null; },
    async release(probe) {
      if (!await this.verify(probe)) return false;
      claim = null;
      return true;
    },
    get owner() { return claim?.ownerId || null; }
  };
}

function stubLauncher() {
  const processes = [];
  return {
    fencingAware: true,
    processes,
    async startOwned({ domain: url, target, claim }) {
      const process = { domain: url, target, claim, running: true };
      processes.push(process);
      return process;
    },
    async inspectOwned(process) { return process; },
    async stopOwned(process) { process.running = false; }
  };
}

const ownerProof = { matches: () => true };
const publicProbe = async () => ({ verified: true });

test("adapter cannot run with only peer voting, a normal launcher, or a public backend", () => {
  const l = stubLauncher();
  const a = stubProvider();
  const args = {
    installationId: "windows-uuid",
    fixedDomain: domain, localRouterUrl: "http://127.0.0.1:17678",
    launcher: l, authority: a, ownerProof, publicProbe
  };
  assert.throws(() => new NgrokAgentIngressAdapter({
    ...args, authority: { verify() { return true; } }
  }), /Provider-enforced/);
  assert.throws(() => new NgrokAgentIngressAdapter({
    ...args, launcher: { ...l, fencingAware: false }
  }), /enforce fencing/);
  assert.throws(() => new NgrokAgentIngressAdapter({
    ...args, localRouterUrl: "http://0.0.0.0:17678"
  }), /loopback/);
  assert.throws(() => new NgrokAgentIngressAdapter({
    ...args, fixedDomain: "https://fixed.ngrok-free.dev/other"
  }), /bare HTTPS/);
});

test("manager and injected fenced ngrok adapter cooperate without stopping foreign agents", async () => {
  const lease = stubProvider(), launcher = stubLauncher();
  const foreignProcess = { running: true, domain: "https://another.example.test" };
  const adapter = new NgrokAgentIngressAdapter({
    installationId: node.installationId,
    fixedDomain: domain,
    localRouterUrl: "http://127.0.0.1:17678",
    authority: lease, launcher, ownerProof, publicProbe
  });
  const manager = new IngressManager({
    installationId: node.installationId, domain, lease, adapter, enabled: true,
    clock: () => 1000
  });
  const active = await manager.reconcile({ local: node });
  assert.equal(active.state, IngressState.ACTIVE);
  assert.equal(launcher.processes.length, 1);
  assert.equal(adapter.hasOwnedListener, true);
  assert.equal(lease.owner, node.installationId);

  manager.enabled = false;
  const disabled = await manager.reconcile({ local: node });
  assert.equal(disabled.state, IngressState.DISABLED);
  assert.equal(launcher.processes[0].running, false);
  assert.equal(adapter.hasOwnedListener, false);
  assert.equal(foreignProcess.running, true);
  assert.equal(lease.owner, null);
});

test("a wrong target never replaces a healthy agent and cannot be declared ACTIVE", async () => {
  const lease = stubProvider(), launcher = stubLauncher();
  launcher.inspectOwned = async (handle) => ({
    ...handle, target: "http://127.0.0.1:9"
  });
  const adapter = new NgrokAgentIngressAdapter({
    installationId: node.installationId,
    fixedDomain: domain,
    localRouterUrl: "http://127.0.0.1:17678",
    authority: lease, launcher, ownerProof, publicProbe
  });
  const manager = new IngressManager({
    installationId: node.installationId, domain, lease, adapter,
    enabled: true, clock: () => 1000
  });
  const snapshot = await manager.reconcile({ local: node });
  assert.equal(snapshot.state, IngressState.FENCED);
  assert.equal(launcher.processes[0].running, false);
  assert.equal(lease.owner, null);
});

test("adapter refuses ACTIVE if the public domain resolves to a different Router", async () => {
  const lease = stubProvider(), launcher = stubLauncher();
  const adapter = new NgrokAgentIngressAdapter({
    installationId: node.installationId, fixedDomain: domain,
    localRouterUrl: "http://127.0.0.1:17678",
    authority: lease, launcher, ownerProof,
    publicProbe: async () => ({ verified: false, reason: "different_router_instance" })
  });
  const manager = new IngressManager({
    installationId: node.installationId, domain, lease, adapter, enabled: true,
    clock: () => 1000
  });
  const result = await manager.reconcile({ local: node });
  assert.equal(result.state, IngressState.FENCED);
  assert.equal(launcher.processes.length, 1);
  assert.equal(launcher.processes[0].running, false);
  assert.equal(lease.owner, null);
});
