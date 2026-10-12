import os from "node:os";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { AgentConfigStore } from "./agent-config.js";
import { DevSpaceLocalOAuth } from "./devspace-local-auth.js";
import { consumeAgentEvents, reconnectDelayMs, SseUnavailableError } from "./agent-sse.js";
import { AGENT_SSE_HEARTBEAT_INTERVAL_MS } from "./agent-timing.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanRouterUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }
  return { command, options };
}

function splitRoots(value) {
  if (!value) return [];
  return String(value)
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function routerJson(url, { token, method = "POST", body, timeoutMs = 35_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(parsed.message || parsed.error || `HTTP ${response.status}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function enrollAgent({
  routerUrl,
  pairingToken,
  deviceId = os.hostname(),
  label = os.hostname(),
  roots = [],
  devspaceBaseUrl = "http://127.0.0.1:7676",
  configStore = new AgentConfigStore()
}) {
  const base = cleanRouterUrl(routerUrl);
  const result = await routerJson(`${base}/_codassol/agent/enroll`, {
    token: pairingToken,
    body: {
      id: deviceId,
      label,
      platform: process.platform,
      roots,
      capabilities: ["devspace-http"]
    }
  });
  if (typeof result.agentToken !== "string") {
    throw new Error("Router enrollment returned no Agent token");
  }
  return configStore.save({
    routerUrl: base,
    device: {
      id: deviceId,
      label,
      platform: process.platform,
      roots,
      capabilities: ["devspace-http"]
    },
    agentToken: result.agentToken,
    devspace: {
      baseUrl: devspaceBaseUrl,
      oauth: {}
    }
  });
}

function forwardedHeaders(headers = {}) {
  const result = {};
  const blocked = new Set([
    "authorization",
    "host",
    "connection",
    "content-length",
    "transfer-encoding"
  ]);
  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.has(key.toLowerCase()) && value !== undefined) {
      result[key] = String(value);
    }
  }
  return result;
}

async function executeHttpJob(configStore, config, payload) {
  if (payload?.type !== "devspace-http") {
    throw Object.assign(new Error("Unsupported Agent job type"), {
      code: "UNSUPPORTED_JOB_TYPE"
    });
  }
  const oauth = new DevSpaceLocalOAuth({
    baseUrl: config.devspace.baseUrl,
    oauthState: config.devspace.oauth || {},
    saveOAuthState: async (oauthState) => {
      config.devspace.oauth = oauthState;
      await configStore.save(config);
    }
  });
  const request = payload.request || {};
  const response = await oauth.authorizedFetch(request.path || "/mcp", {
    method: request.method || "POST",
    headers: forwardedHeaders(request.headers),
    body: request.bodyBase64
      ? Buffer.from(request.bodyBase64, "base64")
      : undefined
  });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    bodyBase64: body.toString("base64")
  };
}

export function isExpiredAgentJob(job, now = Date.now()) {
  // Legacy v0.1/v0.2 Routers did not send a deadline. Retain compatibility
  // during rolling upgrades; new Routers always attach expiresAt.
  return job && Object.hasOwn(job, "expiresAt") &&
    (!Number.isSafeInteger(job.expiresAt) || now >= job.expiresAt);
}

export async function runAgent({
  configStore = new AgentConfigStore(),
  stopSignal = () => false,
  replicaReceiver = null,
  transport = process.env.CODASSOL_AGENT_TRANSPORT === "poll" ? "poll" : "sse"
} = {}) {
  const config = await configStore.load();
  const heartbeat = () => routerJson(`${config.routerUrl}/_codassol/agent/heartbeat`, {
    token: config.agentToken,
    body: {
      roots: config.device.roots,
      capabilities: config.device.capabilities
    },
    timeoutMs: 10_000
  });
  const reportJob = async (job) => {
    if (isExpiredAgentJob(job)) {
      // The Router has already rejected the caller's request, so there is
      // nothing to acknowledge. Never run a late file mutation or command.
      process.stderr.write("CodasSol Agent discarded expired job before execution\n");
      return;
    }
    let body;
    try {
      let result;
      if (job.payload?.type === "auth-replica-checkpoint" ||
          job.payload?.type === "auth-replica-commit") {
        const commit = job.payload.type === "auth-replica-commit";
        const handler = commit ? replicaReceiver?.commit : replicaReceiver?.receive;
        if (typeof handler !== "function") {
          throw Object.assign(new Error("Replica receiver not configured"), {
            code: "AUTH_REPLICA_DISABLED"
          });
        }
        // Replica jobs can never be forwarded to the local DevSpace. The
        // receiver pins signer, recipient, installation and ordered state.
        result = await handler.call(replicaReceiver,
          commit ? job.payload.certificate : job.payload.checkpoint);
      } else {
        result = await executeHttpJob(configStore, config, job.payload);
      }
      body = { jobId: job.id, ok: true, result };
    } catch (error) {
      body = {
        jobId: job.id,
        ok: false,
        error: {
          code: error?.code || "AGENT_JOB_FAILED",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
    await routerJson(`${config.routerUrl}/_codassol/agent/result`, {
      token: config.agentToken, body, timeoutMs: 10_000
    });
  };
  const logError = (error) => process.stderr.write(
    `CodasSol Agent connection error: ${error instanceof Error ? error.message : String(error)}\n`
  );
  // 60-second HTTP heartbeats would cost 43,200 requests per 30-day month
  // PER device. Keep one-way SSE framing cheap and positively confirm
  // Agent liveness at a quota-friendly interval instead.
  const positiveHeartbeatIntervalMs = AGENT_SSE_HEARTBEAT_INTERVAL_MS;
  let heartbeatAt = 0;
  let sseFailures = 0;
  let sseUnavailable = transport === "poll";

  while (!stopSignal()) {
    try {
      if (Date.now() >= heartbeatAt) {
        await heartbeat();
        // ~2,880 authenticated heartbeat POSTs per 30 days per online node.
        heartbeatAt = Date.now() + positiveHeartbeatIntervalMs;
      }

      if (!sseUnavailable) {
        const controller = new AbortController();
        const stopTimer = setInterval(() => {
          if (stopSignal()) controller.abort();
        }, 1_000);
        stopTimer.unref?.();
        let heartbeatInFlight = false;
        const heartbeatTimer = setInterval(async () => {
          if (heartbeatInFlight || Date.now() < heartbeatAt) return;
          heartbeatInFlight = true;
          try {
            await heartbeat();
            heartbeatAt = Date.now() + positiveHeartbeatIntervalMs;
          } catch (error) {
            heartbeatAt = Date.now() + 60_000;
            logError(error);
          } finally {
            heartbeatInFlight = false;
          }
        }, 5_000);
        heartbeatTimer.unref?.();
        const connectedAt = Date.now();
        try {
          await consumeAgentEvents({
            url: `${config.routerUrl}/_codassol/agent/events`,
            token: config.agentToken,
            signal: controller.signal,
            onJob: reportJob
          });
          if (stopSignal()) break;
          throw new Error("SSE connection ended unexpectedly");
        } catch (error) {
          if (stopSignal()) break;
          if (error instanceof SseUnavailableError) {
            sseUnavailable = true;
          } else {
            logError(error);
            sseFailures = Date.now() - connectedAt > 60_000
              ? 1 : sseFailures + 1;
            // A few failed SSE attempts may indicate an intermediary that
            // cannot stream. Try one legacy poll, then retry SSE.
            if (sseFailures >= 3 && ![401, 403, 409].includes(error.status)) {
              const polled = await routerJson(`${config.routerUrl}/_codassol/agent/poll`, {
                token: config.agentToken, body: {}, timeoutMs: 32_000
              });
              if (polled.job) await reportJob(polled.job);
            }
            await sleep(reconnectDelayMs(sseFailures));
          }
          continue;
        } finally {
          controller.abort();
          clearInterval(stopTimer);
          clearInterval(heartbeatTimer);
        }
      }

      const polled = await routerJson(`${config.routerUrl}/_codassol/agent/poll`, {
        token: config.agentToken,
        body: {},
        timeoutMs: 32_000
      });
      if (!polled.job) continue;
      await reportJob(polled.job);
    } catch (error) {
      logError(error);
      await sleep(2_000);
    }
  }
}

function usage() {
  return [
    "CodasSol Agent",
    "",
    "Enroll:",
    "  node src/agent.js enroll --router <url> --pairing-token <token> [--device-id <id>] [--label <label>] [--roots <root1|root2>]",
    "",
    "Run:",
    "  node src/agent.js run"
  ].join("\n");
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "enroll") {
    if (!options.router || !options["pairing-token"]) {
      throw new Error(usage());
    }
    await enrollAgent({
      routerUrl: options.router,
      pairingToken: options["pairing-token"],
      deviceId: options["device-id"] || os.hostname(),
      label: options.label || os.hostname(),
      roots: splitRoots(options.roots),
      devspaceBaseUrl: options["devspace-url"] || "http://127.0.0.1:7676"
    });
    console.log("CodasSol Agent enrolled. Pairing token was not stored.");
  } else if (command === "run") {
    await runAgent();
  } else {
    console.log(usage());
  }
}

