import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentHub } from "../src/agent-hub.js";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function postJson(url, token, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const parsed = await response.json();
  return { response, parsed };
}

test("AgentHub delivers a job and resolves its result", async () => {
  const hub = new AgentHub();
  const polled = hub.poll("windows", { timeoutMs: 1_000 });
  const resultPromise = hub.enqueue(
    "windows",
    { type: "devspace-http", request: { path: "/mcp" } },
    { timeoutMs: 1_000 }
  );
  const job = await polled;
  assert.equal(job.payload.type, "devspace-http");
  assert.equal(hub.complete("windows", job.id, { statusCode: 200 }), true);
  assert.deepEqual(await resultPromise, { statusCode: 200 });
});

test("Router enrollment issues a per-device token and supports heartbeat/job/result", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "codassol-router-state-"));
  const backend = http.createServer((_req, res) => res.end("ok"));
  const backendPort = await listen(backend);
  try {
    const config = {
      listenHost: "127.0.0.1",
      listenPort: 0,
      backendHost: "127.0.0.1",
      backendPort,
      backendTimeoutMs: 1_000,
      stateDir,
      localDeviceId: "local",
      localDeviceLabel: "Local",
      localRoots: ["/local"]
    };
    const runtime = await createRouterRuntime(config);
    const router = createRouterServer(config, runtime);
    const port = await listen(router);
    const base = `http://127.0.0.1:${port}`;

    const enrollment = await postJson(
      `${base}/_codassol/agent/enroll`,
      runtime.privateState.pairingToken,
      {
        id: "windows",
        label: "Windows",
        platform: "win32",
        roots: ["C:\\Projects"],
        capabilities: ["devspace-http"]
      }
    );
    assert.equal(enrollment.response.status, 201);
    assert.equal(typeof enrollment.parsed.agentToken, "string");
    assert.notEqual(
      enrollment.parsed.agentToken,
      runtime.privateState.pairingToken
    );

    const heartbeat = await postJson(
      `${base}/_codassol/agent/heartbeat`,
      enrollment.parsed.agentToken,
      { roots: ["C:\\Projects"] }
    );
    assert.equal(heartbeat.response.status, 200);
    assert.equal(runtime.devices.get("windows").online, true);

    const pollPromise = postJson(
      `${base}/_codassol/agent/poll`,
      enrollment.parsed.agentToken,
      {}
    );
    const resultPromise = runtime.agentHub.enqueue(
      "windows",
      { type: "devspace-http", request: { path: "/mcp" } },
      { timeoutMs: 2_000 }
    );
    const poll = await pollPromise;
    assert.equal(poll.response.status, 200);
    assert.equal(poll.parsed.job.payload.type, "devspace-http");

    const submitted = await postJson(
      `${base}/_codassol/agent/result`,
      enrollment.parsed.agentToken,
      {
        jobId: poll.parsed.job.id,
        ok: true,
        result: { statusCode: 200, bodyBase64: "" }
      }
    );
    assert.equal(submitted.response.status, 200);
    assert.equal((await resultPromise).statusCode, 200);

    await close(router);
  } finally {
    await close(backend);
    await rm(stateDir, { recursive: true, force: true });
  }
});

