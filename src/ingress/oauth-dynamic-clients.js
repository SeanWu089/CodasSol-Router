import { randomBytes } from "node:crypto";
import path from "node:path";
import { LocalRefreshAuthority } from "./local-refresh-authority.js";

function invalidClient() {
  const error = new Error("Invalid public OAuth client registration");
  error.code = "invalid_client_metadata";
  return error;
}

export function normalizePublicClientMetadata(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidClient();
  }
  const { client_name: name, redirect_uris: redirects } = input;
  if (typeof name !== "string" || !name.trim() || name.length > 120 ||
      /[\x00-\x1f\x7f]/.test(name) ||
      !Array.isArray(redirects) || redirects.length < 1 || redirects.length > 10 ||
      !redirects.every((uri) => {
        if (typeof uri !== "string" || uri.length > 2048) return false;
        try {
          const url = new URL(uri);
          return !url.username && !url.password && !url.hash &&
            (url.protocol === "https:" || (url.protocol === "http:" &&
             ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
        } catch { return false; }
      }) ||
      new Set(redirects).size !== redirects.length ||
      input.token_endpoint_auth_method != null &&
        input.token_endpoint_auth_method !== "none" ||
      input.grant_types != null &&
        (!Array.isArray(input.grant_types) ||
         input.grant_types.length === 0 ||
         !input.grant_types.includes("authorization_code") ||
         input.grant_types.some((item) => !["authorization_code", "refresh_token"].includes(item))) ||
      input.response_types != null &&
        (!Array.isArray(input.response_types) ||
         !input.response_types.includes("code") ||
         input.response_types.some((item) => item !== "code"))) {
    throw invalidClient();
  }
  return {
    client_name: name.trim(),
    redirect_uris: [...redirects],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  };
}

/**
 * RFC7591 subset: public, secretless authorization-code clients only. No
 * untrusted metadata URLs are fetched (no Client ID Metadata SSRF exposure).
 * Authority must be durable and serializable across all ingress hosts.
 * LocalRefreshAuthority is safe for a single Router only, not two machines.
 */
export class OAuthDynamicClients {
  constructor({
    stateDir, authority = null,
    clock = () => Date.now()
  } = {}) {
    if (!authority && (typeof stateDir !== "string" || !path.isAbsolute(stateDir))) {
      throw new TypeError("OAuth client registry requires absolute state dir");
    }
    this.authority = authority || new LocalRefreshAuthority({
      filePath: path.join(stateDir, "oauth-registered-clients.json")
    });
    this.clock = clock;
  }

  async register(input) {
    const metadata = normalizePublicClientMetadata(input);
    const registered = {
      client_id: "codassol-" + randomBytes(24).toString("base64url"),
      client_id_issued_at: Math.floor(this.clock() / 1000),
      client_secret_expires_at: 0,
      ...metadata
    };
    await this.authority.transact((state) => {
      if (Object.keys(state.records).length >= 512) {
        throw Object.assign(new Error("OAuth client capacity reached"), {
          code: "client_registration_limited"
        });
      }
      // Persist coarse, global admission control to avoid exposing
      // unlimited anonymous writes to the registration API.
      if (Number.isFinite(state.lastRegistrationAt) &&
          this.clock() - state.lastRegistrationAt < 3_000) {
        throw Object.assign(new Error("OAuth registration rate limited"), {
          code: "client_registration_limited"
        });
      }
      state.lastRegistrationAt = this.clock();
      state.records[registered.client_id] = registered;
    });
    return registered;
  }

  async snapshot() {
    return this.authority.transact((state) =>
      Object.values(state.records).map((client) => ({
        clientId: client.client_id,
        redirectUris: [...client.redirect_uris]
      }))
    );
  }
}
