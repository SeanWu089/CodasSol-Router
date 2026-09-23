import os from "node:os";
import path from "node:path";
import { AgentHub } from "./agent-hub.js";
import { DeviceRegistry } from "./device-registry.js";
import { defaultStateDir, RouterPrivateState } from "./private-state.js";
import { RoutingPolicy } from "./routing-policy.js";
import { WorkspaceBindingStore } from "./workspace-bindings.js";

export async function createRouterRuntime(config, {
  clock = () => Date.now(),
  heartbeatTtlMs = 30_000
} = {}) {
  const stateDir = config.stateDir || defaultStateDir();
  const privateState = new RouterPrivateState({ stateDir });
  await privateState.init();

  const devices = new DeviceRegistry({ clock, heartbeatTtlMs });
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

  return {
    stateDir,
    privateState,
    devices,
    bindings,
    routing: new RoutingPolicy({ devices, bindings }),
    agentHub: new AgentHub(),
    localDeviceId: config.localDeviceId || "local"
  };
}

