import { readFile } from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { createPinnedPeerFetch } from "./peer-transport.js";
import { RoutingDecisionError } from "./routing-policy.js";

const PROTOCOL = 2;

function validatePeer(input, localDeviceId, allowInsecurePeers) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Each peer must be an object");
  }
  const { id, token, platform, roots = [] } = input;
  if (typeof id !== "string" || !id.trim() || id === localDeviceId) {
    throw new Error("Peer must have a unique ID different from the local device");
  }
  if (typeof token !== "string" || token.length < 32) {
    throw new Error(`Peer ${id} must have a private bearer token of at least 32 characters`);
  }
  if (input.installationId !== undefined &&
      (typeof input.installationId !== "string" || !input.installationId.trim() ||
       input.installationId.length > 128)) {
    throw new Error(`Peer ${id} has an invalid installationId`);
  }
  if (!Array.isArray(roots) || !roots.every((root) => typeof root === "string" && root.trim())) {
    throw new Error(`Peer ${id} has invalid roots`);
  }
  const url = new URL(input.url);
  if (input.connectAddress !== undefined &&
      (typeof input.connectAddress !== "string" || !isIP(input.connectAddress) || url.protocol !== "https:")) {
    throw new Error(`Peer ${id} connectAddress must be an IP address with HTTPS`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" &&
    !(url.protocol === "http:" && (loopback || allowInsecurePeers))) {
    throw new Error(`Peer ${id} requires HTTPS (or an explicitly enabled trusted-network HTTP transport)`);
  }
  if (url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`Peer ${id} URL must be an origin without credentials, path or query`);
  }
  return {
    id, token, url: url.origin, connectAddress: input.connectAddress || null,
    installationId: input.installationId || null,
    platform: platform || "unknown",
    label: input.label || id,
    roots: [...new Set(roots)]
  };
}

async function peerRequest(peer, endpoint, {
  method = "GET", payload, fetchFn = fetch, timeoutMs = 2500
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const transport = peer.connectAddress && fetchFn === fetch
      ? createPinnedPeerFetch(peer.connectAddress) : fetchFn;
    const response = await transport(`${peer.url}${endpoint}`, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${peer.token}`,
        ...(payload ? { "content-type": "application/json" } : {})
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Peer ${peer.id} responded HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export class PeerMesh {
  constructor({ runtime, peers = [], allowInsecurePeers = false,
    probeIntervalMs = 10000, fetchFn = fetch } = {}) {
    if (!runtime) throw new Error("PeerMesh requires a Router runtime");
    if (!Number.isFinite(probeIntervalMs) || probeIntervalMs < 1000) {
      throw new Error("Peer probe interval must be at least 1000 ms");
    }
    this.runtime = runtime;
    this.fetchFn = fetchFn;
    this.probeIntervalMs = probeIntervalMs;
    this.peers = new Map();
    this.peerHealth = new Map();
    this.timer = null;
    this.refreshPending = null;
    for (const input of peers) {
      const peer = validatePeer(input, runtime.localDeviceId, allowInsecurePeers);
      if (this.peers.has(peer.id) || runtime.devices.get(peer.id)) {
        throw new Error(`Duplicate peer device ID: ${peer.id}`);
      }
      this.peers.set(peer.id, peer);
      runtime.devices.register({
        id: peer.id, label: peer.label, platform: peer.platform,
        roots: peer.roots, enabled: false, presence: "heartbeat",
        capabilities: ["devspace-http"]
      });
    }
  }

  static async load(runtime, config, options = {}) {
    const filename = config.peersFile || path.join(runtime.stateDir, "peers.json");
    let peers = [];
    try {
      const parsed = JSON.parse(await readFile(filename, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Peer config must be a JSON array");
      peers = parsed;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return new PeerMesh({
      runtime, peers, allowInsecurePeers: config.allowInsecurePeers,
      probeIntervalMs: config.peerProbeIntervalMs || 10000,
      ...options
    });
  }

  async refresh() {
    if (this.refreshPending) return this.refreshPending;
    const pending = Promise.all([...this.peers.values()].map(async (peer) => {
      try {
        const info = await peerRequest(peer, "/_codassol/peer/info", {
          // Tailnet TLS handshakes can take longer than the 2.5s used for
          // ordinary metadata calls. Do not mark a healthy execution host
          // offline merely because this identity/health probe needed 3-5s.
          // A genuinely unreachable node still fails closed after 8s.
          fetchFn: this.fetchFn, timeoutMs: 8000
        });
        if (info.protocol !== PROTOCOL || info.id !== peer.id ||
            !Array.isArray(info.roots) || typeof info.platform !== "string") {
          throw new Error(`Peer identity or protocol mismatch for ${peer.id}`);
        }
        if (peer.installationId && peer.installationId !== info.installationId) {
          throw new Error(`Peer installation identity mismatch for ${peer.id}`);
        }
        await this.runtime.catalog.observe({
          id: peer.id, defaultName: info.label || peer.id,
          platform: info.platform, kind: "router",
          installationId: info.installationId
        });
        this.peerHealth.set(peer.id, {
          reachable: true,
          backendReachable: info.backendReachable === true,
          lastOnlineAt: Date.now(),
          checkedAt: Date.now()
        });
        this.runtime.devices.register({
          id: peer.id, platform: info.platform,
          label: this.runtime.catalog.get(peer.id)?.name || info.label || peer.id,
          roots: info.roots, presence: "heartbeat",
          enabled: info.backendReachable === true,
          capabilities: ["devspace-http"]
        });
        // Catalog replication is non-critical to routing. A metadata sync
        // failure must never change a successfully probed execution route.
        if (info.catalogVersion === 1) {
          try {
            const snapshot = await peerRequest(peer, "/_codassol/peer/catalog", {
              fetchFn: this.fetchFn
            });
            await this.runtime.catalog.merge(snapshot);
            // Bidirectional anti-entropy: one-way peer configuration still
            // converges, and updates can transit across trusted peer hops.
            await peerRequest(peer, "/_codassol/peer/catalog", {
              method: "POST", payload: this.runtime.catalog.snapshot(),
              fetchFn: this.fetchFn
            });
          } catch { /* retry next probe; routing remains available */ }
        }
      } catch {
        const previousHealth = this.peerHealth.get(peer.id);
        this.peerHealth.set(peer.id, {
          reachable: false, backendReachable: false,
          lastOnlineAt: previousHealth?.lastOnlineAt ?? null,
          checkedAt: Date.now()
        });
        const previous = this.runtime.devices.get(peer.id);
        if (previous) this.runtime.devices.heartbeat(peer.id, { enabled: false });
      }
    }));
    this.refreshPending = pending;
    try {
      await pending;
    } finally {
      if (this.refreshPending === pending) this.refreshPending = null;
    }
  }

  /** Best-effort immediate metadata propagation; periodic refresh heals misses. */
  async publishCatalog() {
    const snapshot = this.runtime.catalog.snapshot();
    const results = await Promise.all([...this.peers.values()].map(async (peer) => {
      try {
        await peerRequest(peer, "/_codassol/peer/catalog", {
          method: "POST", payload: snapshot, fetchFn: this.fetchFn
        });
        return true;
      } catch { return false; }
    }));
    return { attempted: results.length, delivered: results.filter(Boolean).length };
  }

  start() {
    if (this.timer || this.peers.size === 0) return;
    this.timer = setInterval(() => void this.refresh(), this.probeIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async execute(deviceId, request) {
    const peer = this.peers.get(deviceId);
    if (!peer || !this.runtime.devices.isOnline(deviceId)) {
      throw new RoutingDecisionError("DEVICE_OFFLINE", `Peer ${deviceId} is unavailable`);
    }
    try {
      return await peerRequest(peer, "/_codassol/peer/execute", {
        method: "POST", payload: request, fetchFn: this.fetchFn,
        timeoutMs: 65000
      });
    } catch (error) {
      this.runtime.devices.heartbeat(peer.id, { enabled: false });
      throw new RoutingDecisionError("PEER_EXECUTION_FAILED",
        `Peer ${deviceId} execution failed; request was NOT retried: ${error.message}`);
    }
  }

  async recoverBindings(payload) {
    const messages = Array.isArray(payload) ? payload : [payload];
    for (const message of messages) {
      const workspaceId = message?.method === "tools/call"
        ? message.params?.arguments?.workspace_id : null;
      if (typeof workspaceId !== "string" ||
          this.runtime.bindings.get(workspaceId)) continue;

      const owners = await Promise.all(
        [...this.peers.values()]
          .filter((peer) => this.runtime.devices.isOnline(peer.id))
          .map(async (peer) => {
            try {
              const info = await peerRequest(peer,
                `/_codassol/peer/binding?workspace_id=${encodeURIComponent(workspaceId)}`,
                { fetchFn: this.fetchFn });
              return info.found === true && info.deviceId === peer.id
                ? { ...info, deviceId: peer.id } : null;
            } catch { return null; }
          })
      );
      const matches = owners.filter(Boolean);
      if (matches.length > 1) {
        throw new RoutingDecisionError("AMBIGUOUS_WORKSPACE_OWNER",
          `Multiple peers claim workspace ${workspaceId}`);
      }
      if (matches.length === 1) {
        await this.runtime.routing.bindWorkspace({
          workspaceId, deviceId: matches[0].deviceId,
          root: matches[0].root, mode: matches[0].mode
        });
      }
    }
  }
}
