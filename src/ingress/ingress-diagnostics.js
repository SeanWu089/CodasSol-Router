/**
 * Diagnostics are deliberately read-only and credential-free. The ngrok
 * Agent log can include session/network metadata; return only aggregate
 * categories and times, never raw lines or connection URLs with query data.
 */
export function classifyNgrokLog(line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (!event || typeof event !== "object") return null;
  const details = String(event.err || "").toLowerCase();
  const message = String(event.msg || "").toLowerCase();
  let category = null;
  if (message.includes("heartbeat timeout")) category = "heartbeat_timeout";
  else if (details.includes("no such host") || details.includes("lookup ") ||
           details.includes("dns")) category = "dns_failure";
  else if (details.includes("connection reset")) category = "connection_reset";
  else if (details.includes("eof")) category = "connection_eof";
  else if (message.includes("session closed") ||
           message.includes("failed to reconnect")) category = "session_reconnect";
  else if (message.includes("client session established")) category = "session_established";
  else if (event.lvl === "eror" || event.lvl === "crit") category = "other_error";
  if (!category) return null;
  const at = Date.parse(event.t || "");
  return { category, at: Number.isFinite(at) ? new Date(at).toISOString() : null };
}

export function summarizeNgrokLog(text, { now = Date.now(), windowMs = 60 * 60_000 } = {}) {
  if (typeof text !== "string" || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError("Invalid agent log or window");
  }
  const counts = {};
  let latestFailureAt = null;
  for (const line of text.split(/\r?\n/)) {
    const record = classifyNgrokLog(line);
    if (!record?.at) continue;
    const at = Date.parse(record.at);
    if (at < now - windowMs || at > now + 60_000) continue;
    counts[record.category] = (counts[record.category] || 0) + 1;
    if (record.category !== "session_established" &&
        (!latestFailureAt || at > Date.parse(latestFailureAt))) {
      latestFailureAt = record.at;
    }
  }
  return { windowMinutes: Math.round(windowMs / 60_000), counts, latestFailureAt };
}

function withinLoopback(url) {
  return url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    url.username === "" && url.password === "" && url.search === "" &&
    url.hash === "" && url.pathname === "/";
}

export function validateIngressProbeOptions({ publicUrl, localRouterUrl, agentApiUrl }) {
  const publicOrigin = new URL(publicUrl);
  const localOrigin = new URL(localRouterUrl);
  const apiOrigin = new URL(agentApiUrl);
  if (publicOrigin.protocol !== "https:" || publicOrigin.username ||
      publicOrigin.password || publicOrigin.pathname !== "/" ||
      publicOrigin.search || publicOrigin.hash) {
    throw new TypeError("Public ingress must be an HTTPS origin without credentials");
  }
  if (!withinLoopback(localOrigin) || !withinLoopback(apiOrigin)) {
    throw new TypeError("Local Router and Agent API must remain on loopback");
  }
  return { publicOrigin: publicOrigin.origin, localOrigin: localOrigin.origin,
    agentOrigin: apiOrigin.origin };
}

async function boundedRequest(fetchFn, url, options, timeoutMs, validateBody) {
  try {
    const res = await fetchFn(url, {
      ...options, redirect: "error", signal: AbortSignal.timeout(timeoutMs)
    });
    let contentValid = undefined;
    if (res.status === 200 && validateBody) {
      try { contentValid = validateBody(await res.json()); } catch { contentValid = false; }
    }
    return { http: res.status, ...(validateBody ? { contentValid } : {}) };
  } catch (error) {
    const name = error?.name === "TimeoutError" || error?.name === "AbortError"
      ? "timeout" : "network_error";
    return { http: null, error: name };
  }
}

/** These checks do NOT establish authenticated MCP execution continuity. */
export async function probeIngress({
  publicUrl, localRouterUrl = "http://127.0.0.1:17676",
  agentApiUrl = "http://127.0.0.1:4040",
  fetchFn = fetch, timeoutMs = 5000
}) {
  const origins = validateIngressProbeOptions({ publicUrl, localRouterUrl, agentApiUrl });
  const [local, publicHealth, publicMcp, agent] = await Promise.all([
    boundedRequest(fetchFn, origins.localOrigin + "/_codassol/health", {}, timeoutMs,
      (data) => data?.ok === true && data.backendReachable === true),
    boundedRequest(fetchFn, origins.publicOrigin + "/_codassol/health", {}, timeoutMs,
      (data) => data?.ok === true && data.backendReachable === true),
    boundedRequest(fetchFn, origins.publicOrigin + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    }, timeoutMs),
    boundedRequest(fetchFn, origins.agentOrigin + "/api/tunnels", {}, timeoutMs,
      (data) => Array.isArray(data?.tunnels) &&
        data.tunnels.some((t) => t.public_url === origins.publicOrigin))
  ]);
  return {
    checks: {
      localRouter: { ...local, healthy: local.http === 200 && local.contentValid === true },
      publicRouter: {
        ...publicHealth, healthy: publicHealth.http === 200 && publicHealth.contentValid === true
      },
      // Missing-token 401 proves auth is REQUIRED, not that tokens will
      // remain valid after leader failover.
      publicMcpAuthBoundary: { ...publicMcp, healthy: publicMcp.http === 401 },
      localNgrokAgentApi: {
        ...agent, healthy: agent.http === 200 && agent.contentValid === true
      }
    },
    fullyHealthy: local.http === 200 && local.contentValid === true &&
      publicHealth.http === 200 && publicHealth.contentValid === true &&
      publicMcp.http === 401 && agent.http === 200 && agent.contentValid === true,
    authenticatedExecutionVerified: false
  };
}
