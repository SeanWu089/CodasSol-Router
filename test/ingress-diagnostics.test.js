import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyNgrokLog, summarizeNgrokLog, probeIngress,
  validateIngressProbeOptions
} from "../src/ingress/ingress-diagnostics.js";

test("ngrok Agent errors produce scrubbed categories, never raw IPs or secrets", () => {
  const when = "2026-10-10T16:52:53+08:00";
  const lines = [
    JSON.stringify({ t: when, lvl: "eror", msg: "heartbeat timeout, terminating session" }),
    JSON.stringify({ t: when, lvl: "eror", msg: "session closed, starting reconnect loop",
      err: "read tcp 192.168.0.55:3333->1.2.3.4:443: connection reset by peer" }),
    JSON.stringify({ t: when, lvl: "eror", msg: "failed to reconnect session",
      err: "lookup connect.ngrok-agent.com: no such host" }),
    JSON.stringify({ t: when, lvl: "info", msg: "client session established" }),
    "{not-json}"
  ];
  assert.equal(classifyNgrokLog(lines[0]).category, "heartbeat_timeout");
  const summary = summarizeNgrokLog(lines.join("\n"), {
    now: Date.parse(when), windowMs: 60_000
  });
  assert.deepEqual(summary.counts, {
    heartbeat_timeout: 1, connection_reset: 1, dns_failure: 1,
    session_established: 1
  });
  assert.ok(!JSON.stringify(summary).includes("192.168"));
  assert.deepEqual(summarizeNgrokLog(lines.join("\n"), {
    now: Date.parse(when) + 1000 * 120,
    windowMs: 60_000
  }).counts, {});
});

test("probe rejects non-HTTPS public targets and nonloopback admin API", () => {
  const opts = {
    publicUrl: "https://node.example.test",
    localRouterUrl: "http://127.0.0.1:17676",
    agentApiUrl: "http://127.0.0.1:4040"
  };
  assert.equal(validateIngressProbeOptions(opts).publicOrigin,
    "https://node.example.test");
  assert.throws(() => validateIngressProbeOptions({
    ...opts, agentApiUrl: "http://0.0.0.0:4040"
  }), /loopback/);
  assert.throws(() => validateIngressProbeOptions({
    ...opts, publicUrl: "http://node.example.test"
  }), /HTTPS/);
  assert.throws(() => validateIngressProbeOptions({
    ...opts, publicUrl: "https://node.example.test?key=secret"
  }), /HTTPS/);
});

test("401 MCP is a healthy authentication boundary, never a proof of execution", async () => {
  const seen = [];
  const result = await probeIngress({
    publicUrl: "https://node.example.test",
    fetchFn: async (url, options) => {
      seen.push([url, options.method]);
      if (url.endsWith("/mcp")) return new Response(null, { status: 401 });
      const content = url.endsWith("/api/tunnels")
        ? { tunnels: [{ public_url: "https://node.example.test" }] }
        : { ok: true, backendReachable: true };
      return Response.json(content);
    }
  });
  assert.equal(result.fullyHealthy, true);
  assert.equal(result.authenticatedExecutionVerified, false);
  assert.equal(result.checks.publicMcpAuthBoundary.http, 401);
  assert.equal(result.checks.publicRouter.contentValid, true);
  assert.equal(seen.length, 4);
  assert.ok(!seen.some(([url]) => url.includes("token=")));
});

test("invalid MCP response or public outage must fail health", async () => {
  const result = await probeIngress({
    publicUrl: "https://node.example.test",
    fetchFn: async (url) => {
      if (url.endsWith("/_codassol/health") && url.startsWith("https:")) {
        throw new Error("connection reset by peer");
      }
      if (url.endsWith("/mcp")) return new Response(null, { status: 404 });
      return Response.json(url.endsWith("/api/tunnels")
        ? { tunnels: [{ public_url: "https://node.example.test" }] }
        : { ok: true, backendReachable: true });
    }
  });
  assert.equal(result.fullyHealthy, false);
  assert.equal(result.checks.publicRouter.error, "network_error");
  assert.equal(result.checks.publicMcpAuthBoundary.healthy, false);
});

test("HTTP 200 warning page, backend-down JSON and wrong Agent tunnel are NOT healthy", async () => {
  const result = await probeIngress({
    publicUrl: "https://node.example.test",
    fetchFn: async (url) => {
      if (url.endsWith("/mcp")) return new Response(null, { status: 401 });
      if (url.endsWith("/api/tunnels")) return Response.json({
        tunnels: [{ public_url: "https://something-else.example.test" }]
      });
      if (url.startsWith("https:")) return new Response("Visit ngrok warning", {
        status: 200, headers: { "content-type": "text/plain" }
      });
      return Response.json({ ok: true, backendReachable: false });
    }
  });
  assert.equal(result.fullyHealthy, false);
  assert.equal(result.checks.localRouter.healthy, false);
  assert.equal(result.checks.publicRouter.healthy, false);
  assert.equal(result.checks.localNgrokAgentApi.healthy, false);
});
