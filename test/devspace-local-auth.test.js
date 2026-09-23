import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DevSpaceLocalOAuth } from "../src/devspace-local-auth.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test("local DevSpace OAuth uses PKCE and keeps authorization local", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codassol-oauth-"));
  const ownerTokenPath = path.join(directory, "auth.json");
  await writeFile(ownerTokenPath, JSON.stringify({ ownerToken: "owner-secret" }));

  let baseUrl;
  let authorizationSawOwnerToken = false;
  let tokenExchangeSawVerifier = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ resource: `${baseUrl}/mcp` }));
      return;
    }
    if (url.pathname === "/register") {
      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        client_id: "client-1",
        token_endpoint_auth_method: "none"
      }));
      return;
    }
    if (url.pathname === "/authorize") {
      const body = new URLSearchParams(await readBody(req));
      authorizationSawOwnerToken = body.get("owner_token") === "owner-secret";
      if (
        !body.get("client_id") ||
        !body.get("redirect_uri") ||
        body.get("response_type") !== "code" ||
        body.get("code_challenge_method") !== "S256" ||
        !body.get("code_challenge") ||
        !body.get("resource")
      ) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "invalid_request" }));
        return;
      }
      const redirect = new URL(body.get("redirect_uri"));
      redirect.searchParams.set("code", "code-1");
      redirect.searchParams.set("state", body.get("state"));
      res.statusCode = 302;
      res.setHeader("location", redirect.href);
      res.end();
      return;
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(await readBody(req));
      tokenExchangeSawVerifier = Boolean(body.get("code_verifier"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        access_token: "access-1",
        refresh_token: "refresh-1",
        token_type: "bearer",
        expires_in: 3600
      }));
      return;
    }
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== "Bearer access-1") {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const port = await listen(server);
  baseUrl = `http://127.0.0.1:${port}`;
  let savedState = {};
  try {
    const oauth = new DevSpaceLocalOAuth({
      baseUrl,
      ownerTokenPath,
      oauthState: {},
      saveOAuthState: async (state) => {
        savedState = structuredClone(state);
      }
    });
    const response = await oauth.authorizedFetch("/mcp", { method: "GET" });
    assert.equal(response.status, 200);
    assert.equal(authorizationSawOwnerToken, true);
    assert.equal(tokenExchangeSawVerifier, true);
    assert.equal(savedState.refreshToken, "refresh-1");
    assert.equal(savedState.accessToken, "access-1");
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

