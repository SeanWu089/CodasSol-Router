// Minimal authenticated SSE client; avoids a mandatory WebSocket dependency.
// Only an explicit "job" event may cause execution. Keepalive/ready events
// never authorize work and never indicate successful execution.

export class SseUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = "SSE_UNAVAILABLE";
  }
}

export function reconnectDelayMs(attempt, random = Math.random) {
  const base = Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempt, 10));
  return Math.round(base * (0.75 + 0.5 * random()));
}

export async function consumeAgentEvents({
  url, token, signal, onJob, onReady = () => {}, fetchImpl = fetch
}) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "text/event-stream",
      "cache-control": "no-cache"
    },
    signal
  });
  if ([404, 405, 406, 501].includes(response.status)) {
    await response.body?.cancel();
    throw new SseUnavailableError(`Router does not support SSE (HTTP ${response.status})`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`SSE connection rejected (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ||
      !response.body) {
    await response.body?.cancel();
    throw new SseUnavailableError("Router returned no SSE event stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let eventType = "";
  let eventData = [];
  const processLine = async (line) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "") {
      const data = eventData.join("\n");
      const type = eventType;
      eventData = [];
      eventType = "";
      if (type === "ready") onReady(JSON.parse(data));
      if (type === "job") {
        const parsed = JSON.parse(data);
        if (!parsed?.job?.id || !parsed.job.payload) {
          throw new Error("Invalid SSE job envelope");
        }
        await onJob(parsed.job);
      }
    } else if (line.startsWith("event:")) {
      eventType = line.slice(6).trimStart();
    } else if (line.startsWith("data:")) {
      eventData.push(line.slice(5).trimStart());
    }
    // All other fields, including SSE comments, are intentionally ignored.
  };

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 1_048_576) throw new Error("SSE event exceeds 1 MiB");
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        await processLine(line);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!signal?.aborted) throw new Error("SSE stream closed");
}
