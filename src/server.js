import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { bearerToken, readBody, readJsonBody, sendJson } from "./http-utils.js";
import {
  bindOpenWorkspaceResponses,
  decideMcpRoute,
  parseMcpResponseBody
} from "./mcp-routing.js";
import { createRouterRuntime } from "./runtime.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade"
]);

function filteredHeaders(headers) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function bufferedRequest(config, request, body, {
  host = config.backendHost,
  port = config.backendPort,
  path = request.url
} = {}) {
  return new Promise((resolve, reject) => {
    const upstream = http.request({
      host,
      port,
      method: request.method,
      path,
      headers: {
        ...filteredHeaders(request.headers),
        host: `${host}:${port}`,
        "content-length": body.length
      },
      timeout: config.backendTimeoutMs
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode || 502,
        statusMessage: response.statusMessage,
        headers: filteredHeaders(response.headers),
        body: Buffer.concat(chunks)
      }));
    });
    upstream.once("timeout", () => upstream.destroy(new Error("backend timeout")));
    upstream.once("error", reject);
    upstream.end(body);
  });
}

async function validateOuterAuthorization(config, request) {
  if (!request.headers.authorization) return false;
  const body = Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    id: "codassol-auth-probe",
    method: "codassol/auth-probe"
  }));
  const probeRequest = {
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: request.headers.authorization,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(request.headers["mcp-protocol-version"]
        ? { "mcp-protocol-version": request.headers["mcp-protocol-version"] }
        : {})
    }
  };
  const response = await bufferedRequest(config, probeRequest, body);
  return response.statusCode !== 401 && response.statusCode !== 403;
}

function writeBufferedResponse(res, response) {
  res.writeHead(
    response.statusCode,
    response.statusMessage,
    filteredHeaders(response.headers)
  );
  res.end(response.body);
}

async function routeMcpRequest(req, res, config, runtime) {
  if (!runtime || req.method !== "POST" || req.url !== "/mcp") return false;
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return false;
  }

  const decision = decideMcpRoute(payload, runtime);
  let response;
  if (decision.deviceId === runtime.localDeviceId) {
    response = await bufferedRequest(config, req, body);
  } else {
    const authorized = await validateOuterAuthorization(config, req);
    if (!authorized) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const remote = await runtime.agentHub.enqueue(
      decision.deviceId,
      {
        type: "devspace-http",
        request: {
          method: req.method,
          path: req.url,
          headers: filteredHeaders(req.headers),
          bodyBase64: body.toString("base64")
        }
      },
      { timeoutMs: Math.max(config.backendTimeoutMs, 60_000) }
    );
    response = {
      statusCode: remote.statusCode,
      headers: remote.statusCode === 401
        ? { "content-type": "application/json; charset=utf-8" }
        : filteredHeaders(remote.headers || {}),
      body: remote.statusCode === 401
        ? Buffer.from(JSON.stringify({
          error: "remote_devspace_authorization_failed"
        }))
        : Buffer.from(remote.bodyBase64 || "", "base64")
    };
  }

  if (decision.openWorkspaceCalls.length) {
    const responsePayload = parseMcpResponseBody(
      response.headers["content-type"],
      response.body
    );
    await bindOpenWorkspaceResponses(responsePayload, decision, runtime);
  }
  writeBufferedResponse(res, response);
  return true;
}

export function probeBackend(config, timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: config.backendHost,
      port: config.backendPort
    });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function agentIdentity(runtime, req) {
  if (!runtime) return null;
  return runtime.privateState.authenticateAgent(bearerToken(req));
}

function ensureRegisteredDevice(runtime, identity, patch = {}) {
  const existing = runtime.devices.get(identity.id);
  if (!existing) {
    return runtime.devices.register({
      id: identity.id,
      label: identity.label,
      platform: identity.platform,
      presence: "heartbeat",
      roots: patch.roots ?? identity.roots ?? [],
      capabilities: patch.capabilities ?? identity.capabilities ?? []
    });
  }
  return runtime.devices.heartbeat(identity.id, {
    roots: patch.roots ?? existing.roots,
    capabilities: patch.capabilities ?? existing.capabilities
  });
}

async function handleAgentRoute(req, res, runtime) {
  if (!runtime || !req.url?.startsWith("/_codassol/agent/")) return false;

  if (req.url === "/_codassol/agent/enroll" && req.method === "POST") {
    if (!runtime.privateState.verifyPairingToken(bearerToken(req))) {
      sendJson(res, 401, { error: "invalid_pairing_token" });
      return true;
    }
    const body = await readJsonBody(req);
    const enrolled = await runtime.privateState.enrollAgent(body);
    runtime.devices.register({
      id: enrolled.agent.id,
      label: enrolled.agent.label,
      platform: enrolled.agent.platform,
      presence: "heartbeat",
      roots: enrolled.agent.roots,
      capabilities: enrolled.agent.capabilities
    });
    sendJson(res, 201, {
      ok: true,
      deviceId: enrolled.agent.id,
      agentToken: enrolled.token,
      heartbeatIntervalMs: 10_000
    });
    return true;
  }

  const identity = agentIdentity(runtime, req);
  if (!identity) {
    sendJson(res, 401, { error: "invalid_agent_token" });
    return true;
  }

  if (req.url === "/_codassol/agent/heartbeat" && req.method === "POST") {
    const body = await readJsonBody(req);
    const device = ensureRegisteredDevice(runtime, identity, body);
    sendJson(res, 200, { ok: true, deviceId: device.id, online: device.online });
    return true;
  }

  if (req.url === "/_codassol/agent/poll" && req.method === "POST") {
    ensureRegisteredDevice(runtime, identity);
    const job = await runtime.agentHub.poll(identity.id);
    sendJson(res, 200, { ok: true, job });
    return true;
  }

  if (req.url === "/_codassol/agent/result" && req.method === "POST") {
    ensureRegisteredDevice(runtime, identity);
    const body = await readJsonBody(req);
    const accepted = body.ok
      ? runtime.agentHub.complete(identity.id, body.jobId, body.result)
      : runtime.agentHub.fail(identity.id, body.jobId, body.error);
    if (!accepted) {
      sendJson(res, 409, { error: "unknown_or_mismatched_job" });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 404, { error: "agent_route_not_found" });
  return true;
}

export function createRouterServer(config = loadConfig(), runtime = null) {
  return http.createServer(async (req, res) => {
    try {
      if (await handleAgentRoute(req, res, runtime)) return;
    } catch (error) {
      sendJson(res, 400, {
        error: "agent_request_failed",
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    try {
      if (await routeMcpRequest(req, res, config, runtime)) return;
    } catch (error) {
      sendJson(res, 502, {
        error: error?.code || "mcp_routing_failed",
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    if (req.url === "/_codassol/health" && req.method === "GET") {
      const backendReachable = await probeBackend(config);
      const payload = JSON.stringify({
        ok: true,
        backendReachable
      });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store"
      });
      res.end(payload);
      return;
    }

    const upstream = http.request(
      {
        host: config.backendHost,
        port: config.backendPort,
        method: req.method,
        path: req.url,
        headers: {
          ...filteredHeaders(req.headers),
          host: `${config.backendHost}:${config.backendPort}`
        },
        timeout: config.backendTimeoutMs
      },
      (upstreamRes) => {
        res.writeHead(
          upstreamRes.statusCode || 502,
          upstreamRes.statusMessage,
          filteredHeaders(upstreamRes.headers)
        );
        upstreamRes.pipe(res);
      }
    );

    upstream.once("timeout", () => {
      upstream.destroy(new Error("backend timeout"));
    });

    upstream.once("error", (error) => {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      const payload = JSON.stringify({
        error: "backend_unavailable",
        message: "CodasSol Router could not reach the selected backend. No retry was attempted."
      });
      res.writeHead(502, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store"
      });
      res.end(payload);
    });

    req.once("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });
}

export async function startRouter(config = loadConfig(), runtime = null) {
  const activeRuntime = runtime || await createRouterRuntime(config);
  const server = createRouterServer(config, activeRuntime);
  server.codassolRuntime = activeRuntime;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listenPort, config.listenHost, resolve);
  });
  return server;
}

const isMain = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const config = loadConfig();
  const server = await startRouter(config);
  console.log(
    `CodasSol Router listening on http://${config.listenHost}:${config.listenPort} -> http://${config.backendHost}:${config.backendPort}`
  );
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
