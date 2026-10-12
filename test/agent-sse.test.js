import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { AgentHub } from "../src/agent-hub.js";
import { consumeAgentEvents, reconnectDelayMs, SseUnavailableError } from "../src/agent-sse.js";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function postJson(url, token, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test("SSE client parses chunk-split jobs and ignores comments and unknown events", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    ': keepalive\n\nevent: ready\ndata: {"protocol":1}\n\nevent: oth',
    'er\ndata: {"not":"a job"}\n\nevent: job\ndata: {"job":{"id":"one",',
    '"payload":{"type":"devspace-http"}}}\n\n'
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  const seen = [];
  const fetchImpl = async () => ({
    status: 200, ok: true,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: stream
  });
  await assert.rejects(
    consumeAgentEvents({
      url: "http://localhost", token: "private", onReady: (value) => seen.push(value),
      onJob: async (job) => seen.push(job), fetchImpl
    }),
    /stream closed/
  );
  assert.deepEqual(seen, [
    { protocol: 1 },
    { id: "one", payload: { type: "devspace-http" } }
  ]);
});

test("SSE unsupported response uses legacy fallback without retrying authorization failures", async () => {
  await assert.rejects(
    consumeAgentEvents({
      url: "http://localhost", token: "token", onJob: () => {},
      fetchImpl: async () => ({ status: 404, body: null })
    }),
    SseUnavailableError
  );
  await assert.rejects(
    consumeAgentEvents({
      url: "http://localhost", token: "token", onJob: () => {},
      fetchImpl: async () => ({ status: 401, ok: false, body: null })
    }),
    (error) => error.status === 401
  );
  assert.ok(reconnectDelayMs(10, () => 0) >= 20_000);
  assert.ok(reconnectDelayMs(10, () => 1) <= 40_000);
});

test("AgentHub never replaces an active consumer or duplicates an already-delivered job", async () => {
  const hub = new AgentHub();
  const queued = hub.enqueue("win", { type: "devspace-http" }, { timeoutMs: 1_000 });
  const jobs = [];
  const unsubscribe = hub.subscribe("win", (job) => { jobs.push(job); return true; });
  assert.throws(() => hub.subscribe("win", () => true), { code: "AGENT_CONSUMER_ACTIVE" });
  await assert.rejects(hub.poll("win"), { code: "AGENT_CONSUMER_ACTIVE" });
  await Promise.resolve();
  assert.equal(jobs.length, 1);
  unsubscribe();
  assert.equal(hub.complete("win", jobs[0].id, { statusCode: 200 }), true);
  assert.equal((await queued).statusCode, 200);
  assert.equal(await hub.poll("win", { timeoutMs: 5 }), null);
});

test("Timed-out offline jobs are removed and never executed after SSE reconnect", async () => {
  const hub = new AgentHub();
  const expired = hub.enqueue("win", { type: "mutating-command" }, { timeoutMs: 5 });
  // The production timeout intentionally uses unref(), so keep this isolated
  // test's event loop alive long enough to observe it.
  await Promise.all([
    assert.rejects(expired, { code: "AGENT_JOB_TIMEOUT" }),
    new Promise((resolve) => setTimeout(resolve, 20))
  ]);
  const jobs = [];
  const unsubscribe = hub.subscribe("win", (job) => { jobs.push(job); return true; });
  await Promise.resolve();
  assert.equal(jobs.length, 0);
  unsubscribe();
});

test("AgentHub shutdown closes only the live SSE consumers", async () => {
  const hub = new AgentHub();
  let closed = 0;
  hub.subscribe("win", () => true, () => { closed += 1; });
  hub.closeStreams();
  assert.equal(closed, 1);
  const unsubscribe = hub.subscribe("win", () => true);
  unsubscribe();
});

test("Router SSE authenticates Agent, delivers scoped jobs, accepts result POST and releases subscriber", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "codassol-sse-"));
  const backend = http.createServer((_req, res) => res.end("ok"));
  const backendPort = await listen(backend);
  const config = {
    listenHost: "127.0.0.1", listenPort: 0,
    backendHost: "127.0.0.1", backendPort,
    backendTimeoutMs: 1_000, stateDir,
    localDeviceId: "mac", localDeviceLabel: "Mac", localRoots: ["/tmp"]
  };
  let router;
  const controller = new AbortController();
  try {
    const runtime = await createRouterRuntime(config);
    router = createRouterServer(config, runtime);
    const port = await listen(router);
    const base = `http://127.0.0.1:${port}/_codassol/agent`;
    const enrollment = await postJson(`${base}/enroll`, runtime.privateState.pairingToken, {
      id: "windows", label: "Windows", platform: "win32",
      roots: ["C:\\Projects"], capabilities: ["devspace-http"]
    });
    assert.equal(enrollment.status, 201);
    const token = enrollment.body.agentToken;
    const denied = await fetch(`${base}/events`, {
      headers: { authorization: "Bearer invalid" }
    });
    assert.equal(denied.status, 401);

    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    const results = [];
    const consumer = consumeAgentEvents({
      url: `${base}/events`, token, signal: controller.signal,
      onReady: markReady,
      onJob: async (job) => {
        results.push(job);
        const result = await postJson(`${base}/result`, token, {
          jobId: job.id, ok: true, result: { statusCode: 200, bodyBase64: "" }
        });
        assert.equal(result.status, 200);
        controller.abort();
      }
    });
    await ready;
    assert.equal(runtime.devices.get("windows").online, true);
    const duplicate = await fetch(`${base}/events`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(duplicate.status, 409);
    const blockedPoll = await postJson(`${base}/poll`, token);
    assert.equal(blockedPoll.status, 409);
    const complete = runtime.agentHub.enqueue(
      "windows",
      { type: "devspace-http", request: { path: "/mcp" } },
      { timeoutMs: 2_000 }
    );
    assert.equal((await complete).statusCode, 200);
    await consumer;
    assert.equal(results.length, 1);
    assert.equal(results[0].payload.request.path, "/mcp");

    // The production Agent client itself must establish SSE and POST an
    // execution failure once, rather than require a separate poll consumer.
    const second = await postJson(`${base}/enroll`, runtime.privateState.pairingToken, {
      id: "test-agent-2", label: "Test Agent 2", platform: "win32",
      roots: ["C:\\Projects"], capabilities: ["devspace-http"]
    });
    assert.equal(second.status, 201);
    let stopped = false;
    const agent = runAgent({
      configStore: {
        load: async () => ({
          routerUrl: base.replace(/\/_codassol\/agent$/, ""),
          agentToken: second.body.agentToken,
          device: { roots: ["C:\\Projects"], capabilities: ["devspace-http"] },
          devspace: { baseUrl: `http://127.0.0.1:${backendPort}`, oauth: {} }
        })
      },
      stopSignal: () => stopped
    });
    try {
      await assert.rejects(
        runtime.agentHub.enqueue(
          "test-agent-2", { type: "intentionally-unsupported-job" },
          { timeoutMs: 3_000 }
        ),
        { code: "UNSUPPORTED_JOB_TYPE" }
      );
    } finally {
      stopped = true;
      await agent;
    }
  } finally {
    controller.abort();
    if (router) {
      router.closeAllConnections();
      await new Promise((resolve) => router.close(resolve));
    }
    await new Promise((resolve) => backend.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});
