import { readBody, sendJson } from "../http-utils.js";

function tokenResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    pragma: "no-cache"
  });
  res.end(data);
}

/**
 * Opt-in token endpoint ONLY for a fully provisioned, owner-approved grant
 * authority. This does not implement a user-facing /authorize consent flow.
 * The Router must not expose this before configuring the issuer deliberately.
 */
export async function handlePublicOAuthTokenRequest(req, res, oauth) {
  if (!oauth || typeof oauth.redeemCodeWithRefresh !== "function" ||
      typeof oauth.exchangeRefreshToken !== "function") {
    throw new TypeError("Complete public OAuth grant core required");
  }
  if (req.url !== "/token") return false;
  if (req.method !== "POST") {
    tokenResponse(res, 405, { error: "invalid_request" });
    return true;
  }
  if (!req.headers["content-type"]?.startsWith(
    "application/x-www-form-urlencoded"
  )) {
    tokenResponse(res, 415, { error: "invalid_request" });
    return true;
  }
  let params;
  try {
    const raw = await readBody(req, { maxBytes: 8192 });
    params = new URLSearchParams(raw.toString("utf8"));
    // Reject duplicate query keys to avoid request smuggling/ambiguity.
    const seen = new Set();
    for (const key of params.keys()) {
      if (seen.has(key)) throw new Error("duplicate_param");
      seen.add(key);
    }
    if ([...params.entries()].some(([key, value]) =>
      key.length > 64 || value.length > 2048)) throw new Error("oversized_param");
  } catch {
    tokenResponse(res, 400, { error: "invalid_request" });
    return true;
  }
  const grantType = params.get("grant_type");
  try {
    await oauth.refreshRegisteredClients();
    let result;
    if (grantType === "authorization_code") {
      result = await oauth.redeemCodeWithRefresh({
        code: params.get("code"),
        clientId: params.get("client_id"),
        redirectUri: params.get("redirect_uri"),
        codeVerifier: params.get("code_verifier"),
        resource: params.get("resource")
      });
    } else if (grantType === "refresh_token") {
      result = await oauth.exchangeRefreshToken({
        refreshToken: params.get("refresh_token"),
        clientId: params.get("client_id"),
        resource: params.get("resource")
      });
    } else {
      tokenResponse(res, 400, { error: "unsupported_grant_type" });
      return true;
    }
    tokenResponse(res, 200, result);
  } catch (error) {
    // Store or authority unavailable != invalid client grant. Return a 503
    // without retrying the refresh internally (a mutation might have
    // committed before the connection failed).
    if (error?.code !== "invalid_grant") {
      tokenResponse(res, 503, { error: "temporarily_unavailable" });
    } else {
      tokenResponse(res, 400, { error: "invalid_grant" });
    }
  }
  return true;
}
