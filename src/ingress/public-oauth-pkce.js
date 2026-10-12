import { createHash, randomBytes, sign as signJwt, timingSafeEqual } from "node:crypto";

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/;
const base64 = (input) => Buffer.from(input).toString("base64url");

function deny(message = "Invalid OAuth authorization grant") {
  const error = new Error(message);
  error.code = "invalid_grant";
  return error;
}

function normalizedIssuer(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("OAuth issuer must be a bare HTTPS origin");
  }
  return url.origin;
}

function challengeFor(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * OAuth 2.1 authorization-code + mandatory S256 PKCE building block.
 * This deliberately has no unauthenticated HTTP endpoint or approval UI.
 * The caller MUST authenticate the owner and obtain affirmative consent.
 *
 * One-time codes reside only in memory; switching leader while the code is
 * being redeemed requires a new approval. Long-term refresh continuity
 * needs separate, durable and safely replicated grant/revocation state.
 */
export class PublicOAuthPkceGrants {
  #codes = new Map();
  #clients;

  constructor({
    issuer, keyId, privateKey, registeredClients,
    clock = () => Date.now(), codeTtlMs = 90_000,
    accessTtlSeconds = 600
  } = {}) {
    this.issuer = normalizedIssuer(issuer);
    if (typeof keyId !== "string" || !/^[a-zA-Z0-9:_-]{8,160}$/.test(keyId) ||
        privateKey?.type !== "private" || privateKey.asymmetricKeyType !== "ed25519" ||
        !(registeredClients instanceof Map) ||
        ![...registeredClients.keys()].every((id) =>
          typeof id === "string" && id.length >= 8 && id.length <= 256) ||
        ![...registeredClients.values()].every((uris) =>
          Array.isArray(uris) && uris.length > 0 && uris.every((uri) => {
            try {
              const url = new URL(uri);
              return !url.username && !url.password && !url.hash &&
                (url.protocol === "https:" ||
                 (url.protocol === "http:" &&
                  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
            } catch { return false; }
          })) ||
        !Number.isInteger(codeTtlMs) || codeTtlMs < 1000 || codeTtlMs > 300000 ||
        !Number.isInteger(accessTtlSeconds) || accessTtlSeconds < 60 ||
        accessTtlSeconds > 3600) {
      throw new TypeError("Invalid pinned OAuth issuer, signing key or client registry");
    }
    this.keyId = keyId;
    this.privateKey = privateKey;
    this.#clients = new Map([...registeredClients].map(
      ([id, uris]) => [id, [...uris]]
    ));
    this.clock = clock;
    this.codeTtlMs = codeTtlMs;
    this.accessTtlSeconds = accessTtlSeconds;
  }

  #checkClient(clientId, redirectUri) {
    if (typeof clientId !== "string" ||
        !this.#clients.get(clientId)?.includes(redirectUri)) throw deny();
  }

  issueCode({
    ownerApproved, subject, clientId, redirectUri,
    codeChallenge, codeChallengeMethod, resource
  } = {}) {
    if (ownerApproved !== true) throw deny("Owner approval required");
    this.#checkClient(clientId, redirectUri);
    if (typeof subject !== "string" || !subject.trim() || subject.length > 256 ||
        !CHALLENGE.test(codeChallenge) || codeChallengeMethod !== "S256" ||
        resource !== this.issuer + "/mcp") throw deny();
    // Limit the number of outstanding short-lived grants per service.
    const now = this.clock();
    for (const [hash, grant] of this.#codes) {
      if (grant.expiresAt <= now) this.#codes.delete(hash);
    }
    if (this.#codes.size >= 256) throw deny("Authorization grant capacity reached");
    const code = base64(randomBytes(32));
    this.#codes.set(createHash("sha256").update(code).digest("hex"), {
      subject, clientId, redirectUri, codeChallenge, resource,
      expiresAt: now + this.codeTtlMs
    });
    return code;
  }

  redeemCode({
    code, clientId, redirectUri, codeVerifier, resource
  } = {}) {
    this.#checkClient(clientId, redirectUri);
    if (typeof code !== "string" || !CODE.test(code) ||
        typeof codeVerifier !== "string" || !VERIFIER.test(codeVerifier)) {
      throw deny();
    }
    const digest = createHash("sha256").update(code).digest("hex");
    const grant = this.#codes.get(digest);
    this.#codes.delete(digest);
    if (!grant || grant.expiresAt <= this.clock() ||
        grant.clientId !== clientId || grant.redirectUri !== redirectUri ||
        grant.resource !== resource) throw deny();
    const candidate = Buffer.from(challengeFor(codeVerifier));
    const expected = Buffer.from(grant.codeChallenge);
    if (candidate.length !== expected.length ||
        !timingSafeEqual(candidate, expected)) throw deny();
    const issuedAt = Math.floor(this.clock() / 1000);
    const header = base64(JSON.stringify({
      alg: "EdDSA", typ: "at+jwt", kid: this.keyId
    }));
    const payload = base64(JSON.stringify({
      iss: this.issuer, aud: grant.resource, sub: grant.subject,
      scope: "mcp:invoke", iat: issuedAt, nbf: issuedAt,
      exp: issuedAt + this.accessTtlSeconds,
      jti: base64(randomBytes(18))
    }));
    const message = header + "." + payload;
    return {
      access_token: message + "." + base64(signJwt(null,
        Buffer.from(message), this.privateKey)),
      token_type: "Bearer",
      expires_in: this.accessTtlSeconds,
      scope: "mcp:invoke"
      // No refresh_token until a durable cross-node replay-resistant store
      // and a revocation synchronization protocol are implemented.
    };
  }
}
