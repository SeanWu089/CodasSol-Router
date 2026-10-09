import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const PREFIX = "/_codassol/controller/";
const MAX_BODY = 16_384;

function sendJson(response, code, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": payload.length,
    "x-content-type-options": "nosniff"
  });
  response.end(payload);
}

function bearerToken(request) {
  const value = request.headers.authorization;
  return typeof value === "string" ? /^Bearer\s+([^\s]+)$/i.exec(value)?.[1] : null;
}

async function jsonBody(request) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function hashToken(value) {
  return createHash("sha256").update(value).digest();
}

function safeEqualHash(first, second) {
  const left = Buffer.from(first, "base64url");
  const right = hashToken(second);
  return left.length === right.length && timingSafeEqual(left, right);
}

class ControllerRegistry {
  constructor(filename) {
    this.filename = filename;
    this.records = {};
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filename, "utf8"));
      if (parsed?.version !== 1 || !parsed.controllers || Array.isArray(parsed.controllers)) {
        throw new Error("Unsupported controller registry format");
      }
      this.records = parsed.controllers;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }

  findByToken(token) {
    if (!token || typeof token !== "string") return null;
    for (const [id, record] of Object.entries(this.records)) {
      if (typeof record.tokenHash === "string" && safeEqualHash(record.tokenHash, token)) {
        return { id, label: record.label, platform: "ipados" };
      }
    }
    return null;
  }

  async enroll(id, label) {
    const token = randomBytes(32).toString("base64url");
    this.records[id] = {
      label, platform: "ipados",
      tokenHash: hashToken(token).toString("base64url"),
      createdAt: this.records[id]?.createdAt || Date.now(),
      rotatedAt: Date.now()
    };
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temp = `${this.filename}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, controllers: this.records }, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, this.filename);
    return token;
  }

  list() {
    return Object.entries(this.records).map(([id, record]) => ({
      id, label: record.label, platform: "ipados"
    }));
  }
}

async function registryFor(runtime) {
  if (!runtime.controllerRegistryPromise) {
    runtime.controllerRegistryPromise = new ControllerRegistry(
      path.join(runtime.stateDir, "controllers.json")
    ).load().catch((error) => {
      runtime.controllerRegistryPromise = null;
      throw error;
    });
  }
  return runtime.controllerRegistryPromise;
}

function liveController(runtime, id, label) {
  if (!runtime.devices.get(id)) {
    runtime.devices.register({
      id, label, platform: "ipados", presence: "heartbeat", roots: [],
      capabilities: ["control-only"]
    });
  } else {
    runtime.devices.heartbeat(id, { label, enabled: true });
  }
}

function viewOf(device, runtime, backendReachable) {
  const local = device.id === runtime.localDeviceId;
  const controller = device.id.startsWith("controller-");
  return {
    id: device.id,
    label: device.label,
    platform: device.platform,
    kind: local ? "router" : controller ? "controller" : "node",
    online: local ? backendReachable : device.online,
    connectionOnline: local ? true : device.online,
    backendReachable: local ? backendReachable : null,
    lastSeenAt: Number.isFinite(device.lastSeenAt) ? device.lastSeenAt : null
  };
}

function validId(value) {
  return typeof value === "string" && /^controller-[A-Za-z0-9_-]{8,96}$/.test(value);
}

function validLabel(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80;
}

/**
 * Minimal, read-only iPad control endpoint. No DevSpace operations are exposed.
 * Bearer tokens never enter the public repository or response device snapshots.
 * Return true iff a /controller/ route was handled.
 */
export async function handleControllerRoute(req, res, config, runtime, probeBackend) {
  if (!runtime || !req.url?.startsWith(PREFIX)) return false;
  try {
    const registry = await registryFor(runtime);
    if (req.method === "POST" && req.url === `${PREFIX}enroll`) {
      if (!runtime.privateState.verifyPairingToken(bearerToken(req))) {
        sendJson(res, 401, { error: "invalid_pairing_token" });
        return true;
      }
      const body = await jsonBody(req);
      if (!validId(body.deviceId) || !validLabel(body.label)) {
        sendJson(res, 400, { error: "invalid_controller_identity" });
        return true;
      }
      const existing = runtime.devices.get(body.deviceId);
      if (existing && existing.platform !== "ipados") {
        sendJson(res, 409, { error: "device_id_collision" });
        return true;
      }
      const token = await registry.enroll(body.deviceId, body.label.trim());
      liveController(runtime, body.deviceId, body.label.trim());
      sendJson(res, 201, { deviceId: body.deviceId, controllerToken: token, pollIntervalSeconds: 10 });
      return true;
    }

    if (req.method === "GET" && req.url === `${PREFIX}devices`) {
      const controller = registry.findByToken(bearerToken(req));
      if (!controller) {
        sendJson(res, 401, { error: "invalid_controller_token" });
        return true;
      }
      liveController(runtime, controller.id, controller.label);
      const healthy = await probeBackend(config);
      const devices = new Map(runtime.devices.list().map((device) => [
        device.id, viewOf(device, runtime, healthy)
      ]));
      // Registered Agents can disappear from the in-memory presence registry
      // after a Router restart. Report them as offline, never as live.
      for (const agent of runtime.privateState.listAgents()) {
        if (!devices.has(agent.id)) {
          devices.set(agent.id, {
            id: agent.id, label: agent.label, platform: agent.platform,
            kind: "node", online: false, connectionOnline: false,
            backendReachable: null, lastSeenAt: null
          });
        }
      }
      for (const saved of registry.list()) {
        if (!devices.has(saved.id)) {
          devices.set(saved.id, {
            ...saved, kind: "controller", online: false,
            connectionOnline: false, backendReachable: null, lastSeenAt: null
          });
        }
      }
      sendJson(res, 200, {
        protocol: 1, routerDeviceId: runtime.localDeviceId,
        observedAt: Date.now(), devices: [...devices.values()]
      });
      return true;
    }
    sendJson(res, 404, { error: "controller_route_not_found" });
    return true;
  } catch (error) {
    const badInput = error instanceof SyntaxError || error?.message === "request_too_large";
    sendJson(res, badInput ? 400 : 500, {
      error: badInput ? "invalid_controller_request" : "controller_internal_error"
    });
    return true;
  }
}

/**
 * Dedicated mobile-facing listener. The regular MCP proxy is deliberately
 * NOT reachable through this listener: only authenticated controller routes.
 * To enable, set CODASSOL_CONTROLLER_PORT on the Router process.
 */
export function createControllerListener(config, runtime, probeBackend) {
  return http.createServer(async (req, res) => {
    if (!await handleControllerRoute(req, res, config, runtime, probeBackend)) {
      sendJson(res, 404, { error: "not_found" });
    }
  });
}
