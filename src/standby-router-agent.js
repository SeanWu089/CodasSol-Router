import { AgentConfigStore } from "./agent-config.js";
import { enrollAgent, runAgent } from "./agent.js";
import { verifyPublicIngressOwner } from "./ingress/public-owner-proof.js";

function normalizedOrigin(value, { allowLoopbackHttp = false } = {}) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      !(url.protocol === "https:" || (allowLoopbackHttp &&
        url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new TypeError("Standby ingress requires a bare HTTPS origin");
  }
  return url.origin;
}

function assertLocalStandbyConfig({ runtime, routerConfig, agentConfig, ingressUrl }) {
  if (!runtime?.privateState?.installationId ||
      !routerConfig || !agentConfig?.device) {
    throw new TypeError("A local independent Router and enrolled Agent are required");
  }
  if (agentConfig.device.id !== routerConfig.localDeviceId ||
      runtime.localDeviceId !== routerConfig.localDeviceId ||
      agentConfig.device.installationId !== runtime.privateState.installationId) {
    throw new Error("Standby Agent identity does not belong to this Router installation");
  }
  if (agentConfig.routerUrl !== ingressUrl) {
    throw new Error("Standby Agent is paired to a different ingress URL");
  }
  const intendedBackend = `http://${routerConfig.backendHost}:${routerConfig.backendPort}`;
  if (routerConfig.backendHost !== "127.0.0.1" &&
      routerConfig.backendHost !== "localhost") {
    throw new Error("Standby Router must use its own loopback DevSpace");
  }
  if (agentConfig.devspace?.baseUrl !== intendedBackend) {
    throw new Error("Standby Agent DevSpace is not this Router's local backend");
  }
  if (!Array.isArray(agentConfig.device.roots) ||
      agentConfig.device.roots.some((root) => !routerConfig.localRoots.includes(root))) {
    throw new Error("Standby Agent roots must be within this Router's approved roots");
  }
}

/**
 * One-time pairing to the current ingress via the existing Agent protocol.
 * The receiving Router's pairing token is used transiently and NOT saved.
 * Independent Router identity is pinned locally to avoid wrong-host reuse.
 */
export async function pairStandbyRouterAgent({
  runtime, routerConfig, ingressUrl, pairingToken,
  configStore = new AgentConfigStore(), allowLoopbackHttp = false
} = {}) {
  const origin = normalizedOrigin(ingressUrl, { allowLoopbackHttp });
  if (!runtime?.privateState?.installationId ||
      runtime.localDeviceId !== routerConfig?.localDeviceId ||
      !Array.isArray(routerConfig?.localRoots) || !routerConfig.localRoots.length ||
      !["127.0.0.1", "localhost"].includes(routerConfig?.backendHost)) {
    throw new Error("Local Router identity, allowed roots and loopback backend are required");
  }
  const result = await enrollAgent({
    routerUrl: origin, pairingToken,
    deviceId: runtime.localDeviceId,
    label: routerConfig.localDeviceLabel,
    roots: routerConfig.localRoots,
    devspaceBaseUrl: `http://${routerConfig.backendHost}:${routerConfig.backendPort}`,
    configStore
  });
  result.device.installationId = runtime.privateState.installationId;
  return configStore.save(result);
}

/**
 * A separate Router can reuse the existing authenticated outbound SSE Agent
 * channel to execute its own DevSpace jobs without inbound peer reachability.
 * This is opt-in; leader state, token replication and automatic re-pairing
 * on takeover are intentionally not implemented by this wrapper.
 */
export async function runStandbyRouterAgent({
  runtime, routerConfig, ingressUrl,
  configStore = new AgentConfigStore(),
  allowLoopbackHttp = false, stopSignal = () => false,
  isIngressOwner = () => false,
  ownerProbe = verifyPublicIngressOwner,
  agentRunner = runAgent
} = {}) {
  const origin = normalizedOrigin(ingressUrl, { allowLoopbackHttp });
  const config = await configStore.load();
  assertLocalStandbyConfig({ runtime, routerConfig, agentConfig: config, ingressUrl: origin });
  if (isIngressOwner()) throw new Error("Active ingress cannot start an outbound standby Agent");
  if (!allowLoopbackHttp) {
    const verdict = await ownerProbe({
      publicUrl: origin, ownerProof: runtime.ingressOwnerProof
    });
    if (verdict?.verified === true) {
      throw new Error("Public MCP domain is already served by this Router instance");
    }
  }
  return agentRunner({
    configStore,
    transport: "sse",
    stopSignal: () => stopSignal() || isIngressOwner()
  });
}
