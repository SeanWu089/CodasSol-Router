import http from "node:http";
import { TrafficUsage, handleUsageRoute } from "./traffic-usage.js";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { bearerToken, readBody, readJsonBody, sendJson } from "./http-utils.js";
import {
  bindOpenWorkspaceResponses,
  decideMcpRoute,
  parseMcpResponseBody,
  rewriteMcpRequest
} from "./mcp-routing.js";
import { createRouterRuntime } from "./runtime.js";
import { addRouterTools, deviceSnapshot } from "./mcp-device-tools.js";
import { peerConnectivity } from "./peer-diagnostics.js";
import { AGENT_SSE_PRESENCE_TTL_MS } from "./agent-timing.js";

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

function peerForwardedHeaders(headers = {}) {
  const forwarded = {};
  for (const key of ["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "mcp-method", "mcp-name"]) {
    if (typeof headers[key] === "string") forwarded[key] = headers[key];
  }
  return forwarded;
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
    method: "ping"
  }));
  const probeRequest = {
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: request.headers.authorization,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      // Authentication is independent of the caller's protocol negotiation.
      "mcp-protocol-version": "2025-03-26"
    }
  };
  const response = await bufferedRequest(config, probeRequest, body);
  if (response.statusCode === 401 || response.statusCode === 403) return false;
  if (response.statusCode !== 200) {
    // Fail closed without misreporting an outage/rate limit as expired login.
    throw Object.assign(new Error("Authorization verification unavailable"), {
      code: "AUTH_CHECK_UNAVAILABLE"
    });
  }
  return true;
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

  const deviceToolCall = !Array.isArray(payload) && payload?.method === "tools/call" &&
    payload.params?.name === "codassol_list_devices";
  if (deviceToolCall) {
    if (!await validateOuterAuthorization(config, req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const data = deviceSnapshot(runtime, await probeBackend(config));
    sendJson(res, 200, {
      jsonrpc: "2.0", id: payload.id,
      result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data }
    });
    return true;
  }

  await runtime.peerMesh?.recoverBindings(payload);

  const decision = decideMcpRoute(payload, runtime);
  const routedPayload = rewriteMcpRequest(payload, decision);
  const forwardedBody = routedPayload === payload ? body : Buffer.from(JSON.stringify(routedPayload));
  let response;
  if (decision.deviceId === runtime.localDeviceId) {
    response = await bufferedRequest(config, req, forwardedBody);
  } else {
    const authorized = await validateOuterAuthorization(config, req);
    if (!authorized) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const job = {
        type: "devspace-http",
        request: {
          method: req.method,
          path: req.url,
          // The caller's local DevSpace OAuth bearer must never leave its
          // Router. The executing node obtains its own local credential.
          headers: peerForwardedHeaders(req.headers),
          bodyBase64: forwardedBody.toString("base64")
        }
      };
    const remote = runtime.peerMesh?.peers.has(decision.deviceId)
      ? await runtime.peerMesh.execute(decision.deviceId, job)
      : await runtime.agentHub.enqueue(
          decision.deviceId, job,
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

  if (decision.openWorkspaceCalls.length && response.statusCode >= 200 && response.statusCode < 300) {
    const responsePayload = parseMcpResponseBody(
      response.headers["content-type"],
      response.body
    );
    await bindOpenWorkspaceResponses(responsePayload, decision, runtime);
  }
  if (!Array.isArray(payload) && payload?.method === "tools/list" &&
      response.statusCode >= 200 && response.statusCode < 300) {
    const parsed = parseMcpResponseBody(response.headers["content-type"], response.body);
    const enriched = addRouterTools(parsed);
    if (enriched !== parsed) {
      response = {
        ...response,
        headers: { ...response.headers, "content-type": "application/json; charset=utf-8" },
        body: Buffer.from(JSON.stringify(enriched))
      };
      delete response.headers["content-length"];
    }
  }
  writeBufferedResponse(res, response);
  return true;
}

async function handlePeerRoute(req, res, config, runtime) {
  if (!runtime || !req.url?.startsWith("/_codassol/peer/")) return false;
  if (!runtime.privateState.verifyPeerToken(bearerToken(req))) {
    sendJson(res, 401, { error: "invalid_peer_token" });
    return true;
  }
  if (req.url === "/_codassol/peer/info" && req.method === "GET") {
    const local = runtime.devices.get(runtime.localDeviceId);
    sendJson(res, 200, {
      protocol: 2, catalogVersion: 1, id: runtime.localDeviceId,
      installationId: runtime.privateState.installationId,
      label: runtime.catalog.get(runtime.localDeviceId)?.name || local.label,
      platform: local.platform, roots: local.roots,
      backendReachable: await probeBackend(config)
    });
    return true;
  }
  if (req.url === "/_codassol/peer/catalog") {
    if (req.method === "GET") {
      sendJson(res, 200, runtime.catalog.snapshot());
      return true;
    }
    if (req.method === "POST") {
      const snapshot = await readJsonBody(req, { maxBytes: 512_000 });
      const changed = await runtime.catalog.merge(snapshot);
      sendJson(res, 200, { ok: true, changed });
      return true;
    }
  }
  if (req.url.startsWith("/_codassol/peer/binding?") && req.method === "GET") {
    const id = new URL(req.url, "http://localhost").searchParams.get("workspace_id");
    const binding = id ? runtime.bindings.get(id) : null;
    const localBinding = binding?.deviceId === runtime.localDeviceId ? binding : null;
    sendJson(res, 200, localBinding
      ? { found: true, deviceId: localBinding.deviceId, root: localBinding.root, mode: localBinding.mode }
      : { found: false });
    return true;
  }
  if (req.url === "/_codassol/peer/execute" && req.method === "POST") {
    const job = await readJsonBody(req, { maxBytes: 40_000_000 });
    const request = job?.request;
    if (job?.type !== "devspace-http" || request?.method !== "POST" ||
        request?.path !== "/mcp" || typeof request.bodyBase64 !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.bodyBase64)) {
      sendJson(res, 400, { error: "invalid_peer_request" });
      return true;
    }
    const body = Buffer.from(request.bodyBase64, "base64");
    if (body.length > 20_000_000) {
      sendJson(res, 413, { error: "peer_request_too_large" });
      return true;
    }
    const parsed = JSON.parse(body.toString("utf8"));
    const response = await runtime.peerOAuth.authorizedFetch("/mcp", {
      method: "POST", headers: peerForwardedHeaders(request.headers), body
    });
    const resultBody = Buffer.from(await response.arrayBuffer());
    const responseHeaders = Object.fromEntries(response.headers.entries());
    if (response.ok) {
      const calls = (Array.isArray(parsed) ? parsed : [parsed])
        .filter((message) => message?.method === "tools/call" && message.params?.name === "open_workspace")
        .map((message) => ({ requestId: message.id, deviceId: runtime.localDeviceId }));
      if (calls.length) {
        const responsePayload = parseMcpResponseBody(response.headers.get("content-type"), resultBody);
        await bindOpenWorkspaceResponses(responsePayload, { openWorkspaceCalls: calls }, runtime);
      }
    }
    sendJson(res, 200, {
      statusCode: response.status,
      headers: filteredHeaders(responseHeaders),
      bodyBase64: resultBody.toString("base64")
    });
    return true;
  }
  sendJson(res, 404, { error: "peer_route_not_found" });
  return true;
}

async function handleDeviceRoute(req, res, config, runtime) {
  if (!runtime || !req.url?.startsWith("/_codassol/devices")) return false;
  if (!runtime.privateState.verifyAdminToken(bearerToken(req))) {
    sendJson(res, 401, { error: "invalid_admin_token" });
    return true;
  }
  if (req.url === "/_codassol/devices" && req.method === "GET") {
    const localBackend = await probeBackend(config);
    const devices = runtime.catalog.list().map((entry) => {
      const routing = runtime.devices.get(entry.id);
      const local = entry.id === runtime.localDeviceId;
      const peer = runtime.peerMesh?.peers.has(entry.id);
      const health = peer ? runtime.peerMesh.peerHealth.get(entry.id) : null;
      const status = local
        ? (localBackend ? "online" : "degraded")
        : peer && health?.reachable && !health.backendReachable
          ? "degraded"
          : routing?.online ? "online"
            : routing || peer || entry.kind === "agent" ? "offline" : "unknown";
      return {
        id: entry.id,
        installationId: entry.installationId,
        name: entry.name,
        platform: entry.platform,
        kind: entry.kind,
        isThisDevice: local,
        status,
        online: status === "online",
        // Agent heartbeat only proves control-plane reachability. The legacy
        // Agent may poll successfully while its local DevSpace is down.
        // Reserve backendReachable for an independently checked backend.
        backendReachable: local ? localBackend : peer ? (health?.reachable ? health.backendReachable === true : null)
          : null,
        // A health probe is not equivalent to open_workspace + command execution.
        // No current Registry writer supplies a fresh end-to-end proof.
        executionVerified: null,
        connectivity: peer ? peerConnectivity(health) : null,
        lastSeenAt: local ? Date.now() : peer ? (health?.lastOnlineAt ?? null)
          : routing?.lastSeenAt ?? null,
        revision: entry.rename?.revision ?? null
      };
    });
    devices.sort((a, b) => Number(b.isThisDevice) - Number(a.isThisDevice) ||
      a.name.localeCompare(b.name, "en"));
    sendJson(res, 200, { version: 1, localDeviceId: runtime.localDeviceId, devices });
    return true;
  }

  if (req.url.startsWith("/_codassol/devices/") && req.method === "PATCH") {
    const suffix = req.url.slice("/_codassol/devices/".length);
    if (!suffix || suffix.includes("/") || suffix.includes("?") || suffix.includes("#")) {
      sendJson(res, 400, { error: "invalid_device_id" });
      return true;
    }
    const id = decodeURIComponent(suffix);
    const body = await readJsonBody(req, { maxBytes: 2048 });
    const device = await runtime.catalog.rename(id, body?.name);
    if (!device) {
      sendJson(res, 404, { error: "device_not_registered" });
      return true;
    }
    const sync = await runtime.peerMesh?.publishCatalog() || { attempted: 0, delivered: 0 };
    sendJson(res, 200, { ok: true, device: { id: device.id, name: device.name }, sync });
    return true;
  }
  sendJson(res, 405, { error: "device_route_not_found" });
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
      capabilities: patch.capabilities ?? identity.capabilities ?? [],
      ...(patch.heartbeatTtlMs ? { heartbeatTtlMs: patch.heartbeatTtlMs } : {})
    });
  }
  return runtime.devices.heartbeat(identity.id, {
    roots: patch.roots ?? existing.roots,
    capabilities: patch.capabilities ?? existing.capabilities,
    ...(patch.heartbeatTtlMs ? { heartbeatTtlMs: patch.heartbeatTtlMs } : {})
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
    const knownDevice = runtime.catalog.get(body.id);
    const sameRouterInstallation = knownDevice?.kind === "router" &&
      typeof knownDevice.installationId === "string" &&
      body.installationId === knownDevice.installationId;
    if (body.id === runtime.localDeviceId || runtime.peerMesh?.peers.has(body.id) ||
        (knownDevice?.kind === "router" && !sameRouterInstallation) ||
        (knownDevice && !runtime.privateState.getAgent(body.id) && !sameRouterInstallation)) {
      sendJson(res, 409, { error: "device_id_reserved_by_router_node" });
      return true;
    }
    const enrolled = await runtime.privateState.enrollAgent(body);
    await runtime.catalog.observe({
      id: enrolled.agent.id,
      defaultName: enrolled.agent.label,
      platform: enrolled.agent.platform,
      kind: sameRouterInstallation ? "router" : "agent",
      ...(sameRouterInstallation ? { installationId: knownDevice.installationId } : {})
    });
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
  if (identity.id === runtime.localDeviceId || runtime.peerMesh?.peers.has(identity.id)) {
    sendJson(res, 409, { error: "device_id_reserved_by_router_node" });
    return true;
  }

  if (req.url === "/_codassol/agent/heartbeat" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.streamId !== undefined && !runtime.agentHub.renewStream(identity.id, body.streamId)) {
      sendJson(res, 409, { error: "stream_lease_expired" });
      return true;
    }
    const device = ensureRegisteredDevice(runtime, identity, body.streamId ? { ...body, heartbeatTtlMs: 90_000 } : body);
    sendJson(res, 200, { ok: true, deviceId: device.id, online: device.online });
    return true;
  }

  if (req.url === "/_codassol/agent/events" && req.method === "GET") {
    // SSE is downstream-only. Agent results and positive liveness reports
    // continue to use authenticated POSTs. Keepalive comments are not ACKs.
    const sendEvent = (name, data) => {
      if (res.destroyed || res.writableEnded) return false;
      if (res.writableLength > 256_000) {
        res.destroy();
        return false;
      }
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    };
    const leased = req.headers["x-codas-stream-lease"] === "1";
    const leaseMs = leased ? 90_000 : 0;
    let unsubscribe;
    try {
      // Reserve the sole consumer before sending response headers.
      unsubscribe = runtime.agentHub.subscribe(
        identity.id, (job) => sendEvent("job", { job }),
        () => { if (!res.destroyed) res.destroy(); },
        { leaseMs, previousStreamId: leased ? req.headers["x-codas-previous-stream"] : undefined }
      );
    } catch (error) {
      sendJson(res, 409, { error: error.code || "agent_consumer_active" });
      return true;
    }
    ensureRegisteredDevice(runtime, identity, { heartbeatTtlMs: leaseMs || AGENT_SSE_PRESENCE_TTL_MS });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "connection": "keep-alive"
    });
    res.flushHeaders();
    sendEvent("ready", { deviceId: identity.id, protocol: 1, serverTime: Date.now(),
      ...(leased ? { streamId: unsubscribe.streamId, leaseMs, heartbeatIntervalMs: 20_000 } : {}) });
    const keepalive = setInterval(() => {
      if (leased && runtime.agentHub.expireStream(identity.id)) return;
      if (!res.destroyed && !res.writableEnded) {
        if (res.writableLength > 256_000) {
          res.destroy();
          return;
        }
        res.write(": keepalive\n\n");
      }
    }, 20_000);
    keepalive.unref?.();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(keepalive);
      const owned = unsubscribe();
      // Drop back to the legacy timeout only when a stream really closes;
      // a GET request finishing by itself is not an SSE disconnection.
      const device = runtime.devices.get(identity.id);
      if (owned && device?.heartbeatTtlMs === AGENT_SSE_PRESENCE_TTL_MS) {
        runtime.devices.setHeartbeatTtl(identity.id, 30_000);
      }
    };
    res.once("close", cleanup);
    req.once("close", () => {
      // A finished GET request does not mean the response stream closed.
      if (res.destroyed) cleanup();
    });
    return true;
  }

  if (req.url === "/_codassol/agent/poll" && req.method === "POST") {
    ensureRegisteredDevice(runtime, identity);
    let job;
    try {
      job = await runtime.agentHub.poll(identity.id);
    } catch (error) {
      if (error.code !== "AGENT_CONSUMER_ACTIVE") throw error;
      sendJson(res, 409, { error: "agent_consumer_active" });
      return true;
    }
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
  const usage = new TrafficUsage({ stateDir: runtime?.stateDir || config.stateDir, persist: Boolean(runtime?.stateDir || config.stateDir) });
  const server = http.createServer(async (req, res) => {
    if (handleUsageRoute(req, res, runtime, usage)) return;
    usage.track(req, res);
    try {
      if (await handlePeerRoute(req, res, config, runtime)) return;
    } catch (error) {
      sendJson(res, 502, {
        error: "peer_request_failed",
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    try {
      if (await handleDeviceRoute(req, res, config, runtime)) return;
    } catch (error) {
      sendJson(res, 400, {
        error: "device_request_failed",
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }
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
  server.once("close", () => usage.close());
  return server;
}

export async function startRouter(config = loadConfig(), runtime = null) {
  const activeRuntime = runtime || await createRouterRuntime(config);
  const server = createRouterServer(config, activeRuntime);
  server.codassolRuntime = activeRuntime;
  server.on("close", () => activeRuntime.peerMesh?.stop());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listenPort, config.listenHost, resolve);
  });
  await activeRuntime.peerMesh?.refresh();
  activeRuntime.peerMesh?.start();
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
  const shutdown = () => {
    server.codassolRuntime.agentHub.closeStreams();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
