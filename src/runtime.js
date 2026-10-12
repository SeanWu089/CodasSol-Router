import os from "node:os";
import path from "node:path";
import { AgentHub } from "./agent-hub.js";
import { DeviceRegistry } from "./device-registry.js";
import { DeviceCatalog } from "./device-catalog.js";
import { defaultStateDir, RouterPrivateState } from "./private-state.js";
import { RoutingPolicy } from "./routing-policy.js";
import { WorkspaceBindingStore } from "./workspace-bindings.js";
import { PeerMesh } from "./peer-mesh.js";
import { createRouterPeerOAuth } from "./router-peer-oauth.js";
import { createIngressOwnerProof } from "./ingress/public-owner-proof.js";
import { loadPublicMcpAccessFromFile } from "./ingress/public-mcp-access.js";
import { loadPublicRequestFenceFromFile } from "./ingress/public-request-fence-provisioning.js";

export async function createRouterRuntime(config, {
  clock = () => Date.now(),
  heartbeatTtlMs = 30_000,
  publicAuth = null
} = {}) {
  const stateDir = config.stateDir || defaultStateDir();
  const privateState = new RouterPrivateState({ stateDir });
  await privateState.init();

  const devices = new DeviceRegistry({ clock, heartbeatTtlMs });
  const catalog = await new DeviceCatalog({
    stateDir,
    origin: config.localDeviceId || "local"
  }).load();
  await catalog.observe({
    id: config.localDeviceId || "local",
    installationId: privateState.installationId,
    defaultName: config.localDeviceLabel || os.hostname(),
    platform: process.platform,
    kind: "router"
  });
  for (const agent of privateState.listAgents()) {
    await catalog.observe({
      id: agent.id,
      defaultName: agent.label,
      platform: agent.platform,
      kind: "agent"
    });
  }
  devices.register({
    id: config.localDeviceId || "local",
    label: config.localDeviceLabel || os.hostname(),
    platform: process.platform,
    presence: "static",
    roots: config.localRoots?.length ? config.localRoots : [os.homedir()],
    transport: {
      type: "local-http",
      host: config.backendHost,
      port: config.backendPort
    },
    capabilities: ["devspace-http"]
  });

  const bindings = new WorkspaceBindingStore({
    filePath: path.join(stateDir, "bindings.json"),
    clock
  });
  await bindings.load();

  const runtime = {
    stateDir,
    privateState,
    catalog,
    devices,
    bindings,
    routing: new RoutingPolicy({ devices, bindings }),
    agentHub: new AgentHub(),
    ingressOwnerProof: createIngressOwnerProof(),
    localDeviceId: config.localDeviceId || "local",
    peerOAuth: await createRouterPeerOAuth(config, stateDir)
  };
  // A missing/invalid provisioning file fails startup, never silently falls
  // back to DevSpace tokens when public auth mode was requested.
  runtime.publicAuth = publicAuth || (config.publicAuthFile
    ? await loadPublicMcpAccessFromFile(config.publicAuthFile) : null);
  if (config.publicIngressFenceFile) {
    if (!runtime.publicAuth) {
      throw new TypeError("External ingress fence requires provisioned public OAuth");
    }
    runtime.publicIngressRequestGuard = await loadPublicRequestFenceFromFile({
      filePath: config.publicIngressFenceFile,
      installationId: privateState.installationId,
      publicIssuer: runtime.publicAuth.issuer
    });
  }
  runtime.peerMesh = await PeerMesh.load(runtime, config);
  for (const peer of runtime.peerMesh.peers.values()) {
    await catalog.observe({
      id: peer.id,
      defaultName: peer.label,
      // Peer configuration is a hint; platform becomes authoritative only
      // after authenticating the peer's own /peer/info response.
      platform: "unknown",
      kind: "router"
    });
  }
  return runtime;
}

