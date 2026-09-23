import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function formBody(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return body;
}

async function responseJson(response, context) {
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = null;
  }
  if (!response.ok || !parsed) {
    throw new Error(`${context} failed with HTTP ${response.status}`);
  }
  return parsed;
}

export class DevSpaceLocalOAuth {
  constructor({
    baseUrl = "http://127.0.0.1:7676",
    oauthState = {},
    saveOAuthState = async () => {},
    ownerTokenPath = path.join(os.homedir(), ".devspace", "auth.json"),
    fetchFn = fetch
  } = {}) {
    this.baseUrl = new URL(baseUrl);
    this.oauthState = { ...oauthState };
    this.saveOAuthState = saveOAuthState;
    this.ownerTokenPath = ownerTokenPath;
    this.fetchFn = fetchFn;
  }

  async accessToken() {
    const now = Date.now();
    if (
      this.oauthState.accessToken &&
      Number(this.oauthState.accessExpiresAt || 0) > now + 30_000
    ) {
      return this.oauthState.accessToken;
    }
    if (this.oauthState.refreshToken && this.oauthState.clientId) {
      try {
        await this.#refresh();
        return this.oauthState.accessToken;
      } catch {
        this.oauthState = {
          clientId: this.oauthState.clientId,
          resource: this.oauthState.resource
        };
        await this.saveOAuthState(this.oauthState);
      }
    }
    await this.#authorize();
    return this.oauthState.accessToken;
  }

  async authorizedFetch(pathname, options = {}) {
    const token = await this.accessToken();
    const headers = new Headers(options.headers || {});
    headers.set("authorization", `Bearer ${token}`);
    let response = await this.fetchFn(new URL(pathname, this.baseUrl), {
      ...options,
      headers
    });
    if (response.status !== 401) return response;

    // A 401 is rejected before DevSpace executes MCP tools, so refreshing and
    // retrying this one request cannot duplicate a successful mutation.
    this.oauthState.accessToken = null;
    this.oauthState.accessExpiresAt = 0;
    const freshToken = await this.accessToken();
    headers.set("authorization", `Bearer ${freshToken}`);
    response = await this.fetchFn(new URL(pathname, this.baseUrl), {
      ...options,
      headers
    });
    return response;
  }

  async #ownerToken() {
    const parsed = JSON.parse(await readFile(this.ownerTokenPath, "utf8"));
    if (typeof parsed.ownerToken !== "string" || parsed.ownerToken === "") {
      throw new Error("DevSpace owner token is missing from the local auth file");
    }
    return parsed.ownerToken;
  }

  async #resource() {
    if (this.oauthState.resource) return this.oauthState.resource;
    const metadata = await responseJson(
      await this.fetchFn(
        new URL("/.well-known/oauth-protected-resource/mcp", this.baseUrl)
      ),
      "DevSpace protected-resource discovery"
    );
    if (typeof metadata.resource !== "string") {
      throw new Error("DevSpace protected-resource metadata has no resource URL");
    }
    this.oauthState.resource = metadata.resource;
    await this.saveOAuthState(this.oauthState);
    return metadata.resource;
  }

  async #registerClient() {
    const redirectUri = "http://127.0.0.1:17677/callback";
    const client = await responseJson(
      await this.fetchFn(new URL("/register", this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "CodasSol Agent",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none"
        })
      }),
      "DevSpace OAuth client registration"
    );
    if (typeof client.client_id !== "string") {
      throw new Error("DevSpace OAuth registration returned no client_id");
    }
    this.oauthState.clientId = client.client_id;
    this.oauthState.redirectUri = redirectUri;
    await this.saveOAuthState(this.oauthState);
  }

  async #authorize() {
    const resource = await this.#resource();
    if (!this.oauthState.clientId) await this.#registerClient();

    const verifier = base64url(randomBytes(48));
    const challenge = base64url(
      createHash("sha256").update(verifier).digest()
    );
    const state = base64url(randomBytes(24));
    const authorizeUrl = new URL("/authorize", this.baseUrl);

    const authorization = await this.fetchFn(authorizeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        response_type: "code",
        client_id: this.oauthState.clientId,
        redirect_uri: this.oauthState.redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "devspace",
        state,
        resource,
        owner_token: await this.#ownerToken()
      }),
      redirect: "manual"
    });
    if (authorization.status !== 302 && authorization.status !== 303) {
      throw new Error(
        `DevSpace local authorization failed with HTTP ${authorization.status}`
      );
    }
    const location = authorization.headers.get("location");
    if (!location) throw new Error("DevSpace authorization returned no redirect");
    const redirected = new URL(location);
    if (redirected.searchParams.get("state") !== state) {
      throw new Error("DevSpace authorization state mismatch");
    }
    const code = redirected.searchParams.get("code");
    if (!code) throw new Error("DevSpace authorization returned no code");

    const tokens = await responseJson(
      await this.fetchFn(new URL("/token", this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody({
          grant_type: "authorization_code",
          client_id: this.oauthState.clientId,
          code,
          code_verifier: verifier,
          redirect_uri: this.oauthState.redirectUri,
          resource
        })
      }),
      "DevSpace OAuth token exchange"
    );
    await this.#storeTokens(tokens);
  }

  async #refresh() {
    const resource = await this.#resource();
    const tokens = await responseJson(
      await this.fetchFn(new URL("/token", this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody({
          grant_type: "refresh_token",
          client_id: this.oauthState.clientId,
          refresh_token: this.oauthState.refreshToken,
          scope: "devspace",
          resource
        })
      }),
      "DevSpace OAuth refresh"
    );
    await this.#storeTokens(tokens);
  }

  async #storeTokens(tokens) {
    if (typeof tokens.access_token !== "string") {
      throw new Error("DevSpace OAuth response has no access token");
    }
    this.oauthState.accessToken = tokens.access_token;
    this.oauthState.refreshToken = tokens.refresh_token || this.oauthState.refreshToken;
    this.oauthState.accessExpiresAt =
      Date.now() + Number(tokens.expires_in || 3600) * 1000;
    await this.saveOAuthState(this.oauthState);
  }
}

