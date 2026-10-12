import { DurableObject } from "cloudflare:workers";
import {
  applyWitnessAction, emptyWitnessState
} from "../../src/ingress/cloudflare-witness-core.js";

const ACTIONS = new Set([
  "acquire", "verify", "renew", "release", "publish", "confirm", "status"
]);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store" }
});

async function digestHex(text) {
  const bytes = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16)
    .padStart(2, "0")).join("");
}

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function boundedBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  let total = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 4096) throw new Error("Request too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// One durable, strongly consistent object for this CodasSol installation.
// All changes are synchronous KV operations INSIDE SQLite transactionSync.
export class CodasSolWitness extends DurableObject {
  async fetch(request) {
    const data = await request.json();
    const { action, actor, payload, newToken, newTokenHash,
      presentedTokenHash } = data;
    try {
      const result = this.ctx.storage.transactionSync(() => {
        const stored = this.ctx.storage.kv.get("state") ?? emptyWitnessState();
        const transition = applyWitnessAction({
          state: stored, action, actor, payload,
          now: Date.now(), ttlMs: 30_000, newToken, newTokenHash,
          presentedTokenHash
        });
        if (transition.changed) this.ctx.storage.kv.put("state", transition.state);
        return transition.result;
      });
      return json({ result });
    } catch {
      return json({ error: "witness_operation_rejected" }, 400);
    }
  }
}

export default {
  async fetch(request, env) {
    // Only a small, authenticated API is public. It cannot proxy traffic
    // to either Router and does not replace the public MCP/ngrok endpoint.
    const url = new URL(request.url);
    const action = url.pathname.startsWith("/v1/") ?
      url.pathname.slice(4) : "";
    if (request.method !== "POST" || !ACTIONS.has(action) ||
        url.search || url.hash) return json({ error: "not_found" }, 404);

    const actor = request.headers.get("x-codassol-installation-id");
    const provided = request.headers.get("authorization") ?? "";
    if (!actor || !/^Bearer [a-f0-9]{64}$/i.test(provided)) {
      return json({ error: "unauthorized" }, 401);
    }
    // CODASSOL_NODE_TOKENS is a WRANGLER SECRET, never in Git.
    // Every physical installation gets a separate random 256-bit token.
    let secrets;
    try { secrets = JSON.parse(env.CODASSOL_NODE_TOKENS); }
    catch { return json({ error: "unavailable" }, 503); }
    const expected = secrets?.[actor];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/i.test(expected)) {
      return json({ error: "unauthorized" }, 401);
    }
    const left = await digestHex(provided.slice(7).toLowerCase());
    const right = await digestHex(expected.toLowerCase());
    let difference = 0;
    for (let i = 0; i < left.length; i++) {
      difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
    }
    if (difference !== 0) return json({ error: "unauthorized" }, 401);

    let payload;
    try { payload = await boundedBody(request); }
    catch { return json({ error: "invalid_request" }, 400); }
    if (payload == null || typeof payload !== "object" ||
        Array.isArray(payload)) return json({ error: "invalid_request" }, 400);

    // A single fixed Durable Object name prevents different installations
    // from independently initializing conflicting witness instances.
    if (!env.WITNESS || typeof env.WITNESS.getByName !== "function") {
      return json({ error: "unavailable" }, 503);
    }
    const newToken = action === "acquire" ? randomSecret() : undefined;
    const newTokenHash = newToken ? await digestHex(newToken) : undefined;
    const presentedTokenHash = payload.claim?.fencingToken ?
      await digestHex(payload.claim.fencingToken) : undefined;
    try {
      const stub = env.WITNESS.getByName("codassol-v03-primary");
      return await stub.fetch(new Request("https://witness.internal/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, actor, payload,
          newToken, newTokenHash, presentedTokenHash })
      }));
    } catch { return json({ error: "unavailable" }, 503); }
  }
};
