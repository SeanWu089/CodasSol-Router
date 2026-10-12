import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const NONCE = /^[A-Za-z0-9_-]{32}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;
const ROUTE = "/_codassol/ingress/proof";

function originOf(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username ||
      url.password || url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("Public ownership target must be a bare HTTPS origin");
  }
  return url.origin;
}

/**
 * A process-local, ephemeral key proves that the public URL actually reaches
 * this exact Router instance. It does NOT grant or fence ngrok ownership.
 * Never print, persist, replicate, or publish the HMAC secret.
 */
export function createIngressOwnerProof({ secret = randomBytes(32) } = {}) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) {
    throw new TypeError("Ingress owner proof requires an ephemeral 32-byte secret");
  }
  const key = Buffer.from(secret);
  const mac = (nonce) => createHmac("sha256", key)
    .update("codassol-ingress-proof:v1:")
    .update(nonce)
    .digest();
  return Object.freeze({
    respond(nonce) {
      if (typeof nonce !== "string" || !NONCE.test(nonce)) {
        throw new TypeError("Invalid ingress challenge");
      }
      return { version: 1, challenge: nonce, proof: mac(nonce).toString("base64url") };
    },
    matches(nonce, result) {
      if (typeof nonce !== "string" || !NONCE.test(nonce) ||
          result?.version !== 1 || result.challenge !== nonce ||
          typeof result.proof !== "string" || !MAC.test(result.proof)) {
        return false;
      }
      const candidate = Buffer.from(result.proof, "base64url");
      return candidate.length === 32 && timingSafeEqual(mac(nonce), candidate);
    }
  });
}

/**
 * Called after a candidate endpoint is activated, not as an election/lease.
 * A 200 OK from /health cannot prove which physical host ngrok selected.
 */
export async function verifyPublicIngressOwner({
  publicUrl, ownerProof, fetchFn = fetch, timeoutMs = 5_000
} = {}) {
  const origin = originOf(publicUrl);
  if (!ownerProof || typeof ownerProof.matches !== "function") {
    throw new TypeError("Expected this Router's private owner-proof verifier");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new RangeError("Public ingress verification timeout must be 100-30000ms");
  }
  const challenge = randomBytes(24).toString("base64url");
  try {
    const response = await fetchFn(origin + ROUTE, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ challenge }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      return { verified: false, reason: "unexpected_response" };
    }
    // Bound the untrusted public response so a misrouted endpoint cannot
    // consume arbitrary memory with an unlimited response body.
    const reader = response.body?.getReader();
    if (!reader) return { verified: false, reason: "invalid_body" };
    let size = 0;
    const parts = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024) return { verified: false, reason: "oversized_response" };
        parts.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      return { verified: false, reason: "invalid_body" };
    }
    return ownerProof.matches(challenge, data)
      ? { verified: true }
      : { verified: false, reason: "different_router_instance" };
  } catch {
    return { verified: false, reason: "unreachable" };
  }
}

export { ROUTE as INGRESS_OWNER_PROOF_ROUTE };
