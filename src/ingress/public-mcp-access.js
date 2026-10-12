import { createPublicKey, verify as verifySignature } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLocalRevocationReader } from "./live-revocations.js";

const PUBLIC_SCOPE = "mcp:invoke";
const B64 = /^[A-Za-z0-9_-]+$/;
const KEY_ID = /^[a-zA-Z0-9:_-]{8,160}$/;

function badToken() {
  const error = new Error("Public MCP access token is invalid or expired");
  error.code = "invalid_token";
  return error;
}

function normalizeIssuer(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("Public issuer must be a bare HTTPS origin");
  }
  return url.origin;
}

function decodePart(value) {
  if (!B64.test(value)) throw badToken();
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

/**
 * Accepts ONLY pinned Ed25519 public keys installed out-of-band on each
 * trusted Router. No fetch of JWKS URLs or acceptance of caller key material.
 * Not itself an OAuth authorization server. Existing Mac DevSpace tokens
 * are deliberately rejected in this mode.
 */
export function createPublicMcpAccess({
  issuer, trustedKeys, revokedJtis = new Set(),
  now = () => Date.now(), maxRevocationAgeMs = 5 * 60_000,
  revocationsUpdatedAt = null, revocationReader = null
} = {}) {
  const origin = normalizeIssuer(issuer);
  if (!(trustedKeys instanceof Map) || trustedKeys.size < 1 ||
      !(revokedJtis instanceof Set)) {
    throw new TypeError("Explicit pinned keys and revocation set are required");
  }
  const pinned = new Map();
  for (const [kid, pem] of trustedKeys) {
    if (!KEY_ID.test(kid)) throw new TypeError("Invalid pinned key ID");
    const key = typeof pem === "string" ? createPublicKey(pem) : pem;
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new TypeError("Only Ed25519 public signing keys are trusted");
    }
    pinned.set(kid, key);
  }
  if (!Number.isSafeInteger(maxRevocationAgeMs) || maxRevocationAgeMs < 1000 ||
      (revocationReader !== null && typeof revocationReader !== "function") ||
      (!Number.isFinite(revocationsUpdatedAt) && !revocationReader)) {
    throw new TypeError("Fresh, authoritative revocation snapshot is required");
  }
  const verifyAgainst = (token, snapshot) => {
      if (!snapshot || !(snapshot.revokedJtis instanceof Set) ||
          !Number.isSafeInteger(snapshot.updatedAt) ||
          now() - snapshot.updatedAt > maxRevocationAgeMs ||
          snapshot.updatedAt - now() > 10_000) {
        throw Object.assign(new Error("Public MCP revocation data is stale"), {
          code: "revocation_state_stale"
        });
      }
      if (typeof token !== "string" || token.length > 8192) throw badToken();
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((item) => !B64.test(item))) throw badToken();
      let head, body;
      try {
        head = decodePart(parts[0]);
        body = decodePart(parts[1]);
      } catch {
        throw badToken();
      }
      if (head?.alg !== "EdDSA" || head?.typ !== "at+jwt" ||
          !pinned.has(head?.kid) || body?.iss !== origin ||
          body?.aud !== origin + "/mcp" ||
          typeof body?.sub !== "string" || !body.sub.trim() ||
          typeof body?.jti !== "string" || body.jti.length < 20 ||
          !Number.isSafeInteger(body?.iat) || !Number.isSafeInteger(body?.nbf) ||
          !Number.isSafeInteger(body?.exp) ||
          body.exp - body.iat > 3600 || body.exp <= body.iat ||
          typeof body.scope !== "string" ||
          body.scope.length > 1024 ||
          !body.scope.split(" ").includes(PUBLIC_SCOPE) ||
          snapshot.revokedJtis.has(body.jti)) throw badToken();
      const seconds = Math.floor(now() / 1000);
      if (body.iat > seconds + 5 || body.nbf > seconds + 5 ||
          body.exp <= seconds) throw badToken();
      const signature = Buffer.from(parts[2], "base64url");
      if (signature.length !== 64 ||
          !verifySignature(null,
            Buffer.from(parts[0] + "." + parts[1]),
            pinned.get(head.kid), signature)) throw badToken();
      return { subject: body.sub, keyId: head.kid, tokenId: body.jti };
  };
  const auth = {
    issuer: origin,
    resource: origin + "/mcp",
    /** Fail closed when the installed revocation list is stale. */
    authenticate(token) {
      // A dynamically configured store must not accidentally fall back to
      // the initial static snapshot, which could miss recent revocations.
      if (revocationReader !== null) {
        throw Object.assign(new Error("Use async live authorization"), {
          code: "revocation_store_unavailable"
        });
      }
      return verifyAgainst(token, {
        revokedJtis, updatedAt: revocationsUpdatedAt
      });
    },
    async authorize(token) {
      if (revocationReader === null) return auth.authenticate(token);
      let fresh;
      try {
        const data = await revocationReader();
        if (!Array.isArray(data?.revokedJtis) ||
            data.revokedJtis.length > 50_000) throw new Error("Invalid revocations");
        fresh = {
          revokedJtis: new Set(data.revokedJtis),
          updatedAt: data.updatedAt
        };
      } catch {
        throw Object.assign(new Error("Live revocation source failed"), {
          code: "revocation_store_unavailable"
        });
      }
      return verifyAgainst(token, fresh);
    },
    metadata() {
      return {
        resource: origin + "/mcp",
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        scopes_supported: [PUBLIC_SCOPE]
      };
    },
    unauthorizedHeaders() {
      return {
        "www-authenticate":
          `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
      };
    }
  };
  return Object.freeze(auth);
}

/**
 * No implicit issuer/key discovery or production auto-enable: a managed
 * provisioning workflow must explicitly supply pinned keys and a FRESH
 * revocation snapshot. Experimental opt-in only.
 */
export async function loadPublicMcpAccessFromFile(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new TypeError("Public auth config must be an absolute file path");
  }
  const data = JSON.parse(await readFile(filePath, "utf8"));
  if (!data || data.version !== 1 || !Array.isArray(data.keys) ||
      (data.revokedJtis != null && !Array.isArray(data.revokedJtis)) ||
      (!data.liveRevocationStateFile &&
       (!Array.isArray(data.revokedJtis) ||
        !Number.isFinite(data.revocationsUpdatedAt)))) {
    throw new Error("Incomplete public MCP auth provisioning");
  }
  return createPublicMcpAccess({
    issuer: data.issuer,
    trustedKeys: new Map(data.keys.map((entry) => [entry.id, entry.publicKeyPem])),
    revokedJtis: new Set(data.revokedJtis || []),
    revocationsUpdatedAt: data.revocationsUpdatedAt,
    revocationReader: data.liveRevocationStateFile
      ? createLocalRevocationReader({ filePath: data.liveRevocationStateFile })
      : null,
    maxRevocationAgeMs: data.maxRevocationAgeMs ?? 5 * 60_000
  });
}
