import { readBody, sendJson } from "../http-utils.js";

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
const FIELDS = [
  "client_id", "redirect_uri", "response_type", "scope",
  "code_challenge", "code_challenge_method", "resource", "state"
];

function escaped(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[character]);
}

function allowedParams(params) {
  const keys = new Set();
  for (const [key, value] of params) {
    if (!FIELDS.includes(key) || keys.has(key) || value.length > 2048) {
      throw new Error("Invalid OAuth authorization request");
    }
    keys.add(key);
  }
  return params;
}

function sendHtml(res, html) {
  res.writeHead(200, {
    ...HTML_HEADERS,
    "content-length": Buffer.byteLength(html)
  });
  res.end(html);
}

function parseAuthorization(params, oauth) {
  allowedParams(params);
  const value = (name) => params.get(name);
  if (!value("state") || value("state").length > 256 ||
      !/^[\x21-\x7e]+$/.test(value("state"))) {
    throw new Error("Missing or unsafe OAuth state");
  }
  return {
    ...oauth.validateAuthorizationRequest({
      clientId: value("client_id"),
      redirectUri: value("redirect_uri"),
      responseType: value("response_type"),
      scope: value("scope"),
      codeChallenge: value("code_challenge"),
      codeChallengeMethod: value("code_challenge_method"),
      resource: value("resource")
    }),
    state: value("state")
  };
}

/**
 * Experimental, strictly opt-in owner consent page for PRE-REGISTERED OAuth
 * clients. No cookie is set; a 256-bit one-use local code proves approval.
 * No unsigned/unknown redirect is ever honored.
 */
export async function handlePublicOAuthConsent(req, res, {
  oauth, approvalCodes
} = {}) {
  if (typeof oauth?.validateAuthorizationRequest !== "function" ||
      typeof oauth?.issueCode !== "function" ||
      typeof approvalCodes?.consume !== "function") {
    throw new TypeError("Consent requires provisioned OAuth and owner proof");
  }
  const route = new URL(req.url, "http://127.0.0.1");
  if (route.pathname !== "/authorize") return false;
  let params;
  let decision = null;
  let ownerCode = null;
  try {
    if (req.url.length > 8192) throw new Error("Authorization request too large");
    if (req.method === "GET") {
      params = route.searchParams;
    } else if (req.method === "POST" &&
        req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
      const raw = await readBody(req, { maxBytes: 8192 });
      const form = new URLSearchParams(raw.toString("utf8"));
      decision = form.get("decision");
      ownerCode = form.get("owner_code");
      if (form.getAll("decision").length !== 1 ||
          form.getAll("owner_code").length !== 1) {
        throw new Error("Ambiguous approval fields");
      }
      form.delete("decision");
      form.delete("owner_code");
      params = form;
    } else {
      sendJson(res, 405, { error: "invalid_method" });
      return true;
    }
    await oauth.refreshRegisteredClients();
    const approved = parseAuthorization(params, oauth);
    if (req.method === "GET") {
      const hidden = FIELDS.map((field) =>
        `<input type="hidden" name="${field}" value="${escaped(params.get(field) || "")}">`
      ).join("");
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodasSol · Authorize</title></head><body>
<main style="max-width:32rem;margin:10vh auto;font:16px system-ui;padding:1rem">
<h1>Authorize CodasSol access</h1>
<p>Client: <strong>${escaped(approved.clientId)}</strong></p>
<p>Callback: <code>${escaped(approved.redirectUri)}</code></p>
<p>Permission: <strong>Access your approved CodasSol workspaces</strong></p>
<form action="/authorize" method="post" autocomplete="off">
${hidden}
<label>One-time approval code from your own CodasSol computer<br>
<input name="owner_code" type="password" minlength="43" maxlength="43" required
 autocomplete="off"></label>
<p><button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button></p>
</form></main></body></html>`;
      sendHtml(res, html);
      return true;
    }
    if (decision === "deny") {
      const callback = new URL(approved.redirectUri);
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("state", approved.state);
      res.writeHead(303, { location: callback.href, "cache-control": "no-store" });
      res.end();
      return true;
    }
    if (decision !== "approve" ||
        !await approvalCodes.consume(ownerCode)) {
      sendJson(res, 403, { error: "owner_approval_required" });
      return true;
    }
    const code = oauth.issueCode({
      ownerApproved: true,
      subject: approvalCodes.subject,
      ...approved
    });
    const callback = new URL(approved.redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", approved.state);
    res.writeHead(303, { location: callback.href, "cache-control": "no-store" });
    res.end();
    return true;
  } catch (error) {
    const isGrantError = error?.code === "invalid_grant" ||
      error?.message === "Invalid OAuth authorization request" ||
      error?.message === "Missing or unsafe OAuth state" ||
      error?.message === "Authorization request too large" ||
      error?.message === "Ambiguous approval fields";
    sendJson(res, isGrantError ? 400 : 503, {
      error: isGrantError ? "invalid_authorization_request" : "temporarily_unavailable"
    });
    return true;
  }
}

/** Advertise only capabilities backed by an explicitly enabled owner consent
 * flow and token service; neither DCR nor Client ID Metadata is advertised.
 */
export function authorizationServerMetadata(oauth) {
  const origin = oauth?.issuer;
  if (typeof origin !== "string" || !origin.startsWith("https://")) {
    throw new TypeError("Configured HTTPS OAuth issuer required");
  }
  return {
    issuer: origin,
    authorization_endpoint: origin + "/authorize",
    token_endpoint: origin + "/token",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp:invoke"],
    ...(oauth.dynamicClientRegistry
      ? { registration_endpoint: origin + "/register" } : {})
  };
}
