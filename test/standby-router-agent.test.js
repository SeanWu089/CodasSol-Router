import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentConfigStore } from "../src/agent-config.js";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";
import {
  pairStandbyRouterAgent, runStandbyRouterAgent
} from "../src/standby-router-agent.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

test("independent Windows Router executes Mac-ingress SSE job without any inbound peer/VPN", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codassol-dual-router-sse-"));
  const received = [];
  const backend = http.createServer(async (req, res) => {
    received.push({
      path: req.url,
      method: req.method,
      authorization: req.headers.authorization
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ executedOn: "windows-devspace" }));
  });
  const backendPort = await listen(backend);
  const routers = [];
  let stopped = false;
  let standby;
  try {
    async function makeNode(name) {
      const config = {
        listenHost: "127.0.0.1", listenPort: 0,
        backendHost: "127.0.0.1", backendPort,
        backendTimeoutMs: 1500,
        stateDir: path.join(temp, name),
        localDeviceId: name,
        localDeviceLabel: name,
        localRoots: [name === "windows" ? "C:\\Projects" : "/tmp/mac"]
      };
      const runtime = await createRouterRuntime(config);
      const server = createRouterServer(config, runtime);
      routers.push(server);
      return { config, runtime, port: await listen(server) };
    }
    const mac = await makeNode("mac");
    const win = await makeNode("windows");
    assert.equal(mac.runtime.peerMesh.peers.size, 0);
    assert.equal(win.runtime.peerMesh.peers.size, 0);
    const ingressUrl = `http://127.0.0.1:${mac.port}`;
    const store = new AgentConfigStore(path.join(temp, "standby-agent.json"));
    const paired = await pairStandbyRouterAgent({
      runtime: win.runtime, routerConfig: win.config,
      ingressUrl, pairingToken: mac.runtime.privateState.pairingToken,
      configStore: store, allowLoopbackHttp: true
    });
    assert.equal(paired.device.id, "windows");
    assert.equal(paired.device.installationId,
      win.runtime.privateState.installationId);
    assert.equal(paired.agentToken.length >= 32, true);
    assert.equal(mac.runtime.devices.get("windows").online, true);

    // The mocked DevSpace accepts a LOCAL token; the remote ingress never
    // receives this token. It is not a production authorization shortcut.
    paired.devspace.oauth = {
      accessToken: "test-local-token",
      accessExpiresAt: Date.now() + 120_000
    };
    await store.save(paired);
    standby = runStandbyRouterAgent({
      runtime: win.runtime, routerConfig: win.config,
      ingressUrl, configStore: store,
      allowLoopbackHttp: true,
      stopSignal: () => stopped
    });
    const result = await mac.runtime.agentHub.enqueue("windows", {
      type: "devspace-http",
      request: {
        method: "POST", path: "/mcp",
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({
          jsonrpc: "2.0", method: "tools/call",
          params: { name: "open_workspace", arguments: { path: "C:\\Projects" } }
        })).toString("base64")
      }
    }, { timeoutMs: 3000 });
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(Buffer.from(result.bodyBase64, "base64").toString())
      .executedOn, "windows-devspace");
    assert.deepEqual(received, [{
      path: "/mcp", method: "POST", authorization: "Bearer test-local-token"
    }]);
    assert.equal(mac.runtime.peerMesh.peers.size, 0,
      "SSE requires neither inbound peer network nor Tailscale");
  } finally {
    stopped = true;
    if (standby) await standby;
    for (const server of routers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await new Promise((resolve) => backend.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test("standby mode refuses wrong host, mismatched DevSpace, active leader and HTTP Internet", async () => {
  const origin = "https://fixed.example.test";
  const config = {
    localDeviceId: "windows", localDeviceLabel: "Windows",
    localRoots: ["C:\\Projects"], backendHost: "127.0.0.1", backendPort: 7676
  };
  const runtime = {
    localDeviceId: "windows",
    privateState: { installationId: "fixed-windows-install-id" },
    ingressOwnerProof: { matches: () => true }
  };
  const enrolled = {
    routerUrl: origin,
    device: {
      id: "windows", installationId: "fixed-windows-install-id",
      roots: ["C:\\Projects"]
    },
    devspace: { baseUrl: "http://127.0.0.1:7676", oauth: {} },
    agentToken: "test-only"
  };
  let started = 0;
  const agentRunner = async () => { started++; };
  const wrap = (value, overrides = {}) => runStandbyRouterAgent({
    runtime, routerConfig: config, ingressUrl: origin,
    configStore: { load: async () => value },
    ownerProbe: async () => ({ verified: false }), agentRunner,
    ...overrides
  });
  await assert.rejects(wrap({
    ...enrolled, device: { ...enrolled.device, id: "mac" }
  }), /does not belong/);
  await assert.rejects(wrap({
    ...enrolled, devspace: { baseUrl: "http://127.0.0.1:9999" }
  }), /local backend/);
  await assert.rejects(wrap(enrolled, { isIngressOwner: () => true }), /Active ingress/);
  await assert.rejects(wrap(enrolled, {
    ownerProbe: async () => ({ verified: true })
  }), /already served/);
  await assert.rejects(wrap(enrolled, {
    ingressUrl: "http://example.com"
  }), /bare HTTPS origin/);
  assert.equal(started, 0);
  await wrap(enrolled);
  assert.equal(started, 1);
});
