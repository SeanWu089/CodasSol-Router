import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";
import {
  createPublicMcpAccess, loadPublicMcpAccessFromFile
} from "../src/ingress/public-mcp-access.js";
import { createLocalRevocationReader } from "../src/ingress/live-revocations.js";
import { LocalRefreshAuthority } from "../src/ingress/local-refresh-authority.js";

const issuer = "https://stable-codassol.example.test";
const kid = "codassol-public-key:v1";
const pair = generateKeyPairSync("ed25519");
const toB64 = (input) => Buffer.from(JSON.stringify(input)).toString("base64url");
const current = () => Date.now();

function mint({
  aud = issuer + "/mcp", iss = issuer, scope = "mcp:invoke",
  exp = Math.floor(current() / 1000) + 600,
  subject = "user-001", key = pair.privateKey
} = {}) {
  const now = Math.floor(current() / 1000);
  const head = toB64({ alg: "EdDSA", typ: "at+jwt", kid });
  const body = toB64({
    iss, aud, sub: subject, jti: randomBytes(18).toString("base64url"),
    iat: now, nbf: now, exp, scope
  });
  const data = head + "." + body;
  return data + "." + sign(null, Buffer.from(data), key).toString("base64url");
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function post(base, token, data) {
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: "Bearer " + token } : {})
    },
    body: JSON.stringify(data)
  });
  return { response, data: await response.json() };
}

function makeAccess(overrides = {}) {
  return createPublicMcpAccess({
    issuer,
    trustedKeys: new Map([[kid, pair.publicKey]]),
    revokedJtis: new Set(),
    revocationsUpdatedAt: current(),
    ...overrides
  });
}

test("Mac and Windows accept the SAME stable public token using independent local DevSpace credentials", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codassol-public-auth-"));
  const backend = http.createServer((_req, res) => res.end("healthy"));
  const backendPort = await listen(backend);
  const routers = [];
  try {
    const nodes = [];
    for (const name of ["mac", "windows"]) {
      const config = {
        listenHost: "127.0.0.1", listenPort: 0,
        backendHost: "127.0.0.1", backendPort,
        backendTimeoutMs: 500,
        stateDir: path.join(temp, name),
        localDeviceId: name, localDeviceLabel: name,
        localRoots: [name === "mac" ? "/tmp/project" : "C:\\Projects"]
      };
      const runtime = await createRouterRuntime(config, {
        publicAuth: makeAccess()
      });
      let count = 0;
      runtime.peerOAuth.authorizedFetch = async (uri, options) => {
        count += 1;
        assert.equal(uri, "/mcp");
        assert.equal(options.headers.authorization, undefined,
          "never forward a ChatGPT public token to local DevSpace");
        const body = JSON.parse(Buffer.from(options.body).toString("utf8"));
        assert.equal(body.method, "tools/list");
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: { tools: [{ name: "open_workspace",
            inputSchema: { type: "object", properties: {} } }] }
        });
      };
      const server = createRouterServer(config, runtime);
      routers.push(server);
      const port = await listen(server);
      nodes.push({ name, runtime, port, calls: () => count });
    }
    const token = mint();
    for (const node of nodes) {
      const origin = `http://127.0.0.1:${node.port}`;
      const discovery = await fetch(origin + "/.well-known/oauth-protected-resource");
      assert.equal(discovery.status, 200);
      assert.deepEqual((await discovery.json()).authorization_servers, [issuer]);
      const denied = await post(origin, null, {
        jsonrpc: "2.0", id: 1, method: "tools/list"
      });
      assert.equal(denied.response.status, 401);
      assert.equal(denied.response.headers.get("www-authenticate"),
        `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`);
      for (const wrongBearer of [mint({ aud: issuer }), "old-devspace-token"]) {
        const invalid = await post(origin, wrongBearer, {
          jsonrpc: "2.0", id: 1, method: "tools/list"
        });
        assert.equal(invalid.response.status, 401);
      }
      const allowed = await post(origin, token, {
        jsonrpc: "2.0", id: 2, method: "tools/list"
      });
      assert.equal(allowed.response.status, 200);
      assert.equal(allowed.data.result.tools.some(
        (tool) => tool.name === "codassol_list_devices"), true);
      assert.equal(node.calls(), 1);
      const deviceList = await post(origin, token, {
        jsonrpc: "2.0", id: 3,
        method: "tools/call", params: { name: "codassol_list_devices" }
      });
      assert.equal(deviceList.response.status, 200);
      assert.equal(deviceList.data.result.structuredContent.localDeviceId, node.name);
      assert.equal(node.calls(), 1);

      const invalidJson = await fetch(origin + "/mcp", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
        body: "{malformed"
      });
      assert.equal(invalidJson.status, 400);
      assert.equal((await invalidJson.json()).error, "invalid_mcp_json");
      for (const method of ["GET", "DELETE"]) {
        const unsupported = await fetch(origin + "/mcp", {
          method, headers: { authorization: "Bearer " + token }
        });
        assert.equal(unsupported.status, 405);
      }
      const bypass = await fetch(origin + "/mcp?trick=true", {
        method: "POST",
        headers: { authorization: "Bearer " + token }
      });
      assert.equal(bypass.status, 404);
      const issuerNotReady = await fetch(origin + "/token", { method: "POST" });
      assert.equal(issuerNotReady.status, 503);
      assert.equal((await issuerNotReady.json()).error,
        "public_oauth_issuer_not_deployed");
      const noRawProxy = await fetch(origin + "/register?redirect=https://example.com", {
        headers: { authorization: "Bearer " + token }
      });
      assert.equal(noRawProxy.status, 404);
      assert.equal(node.calls(), 1, "no denied request reaches DevSpace");
    }
  } finally {
    for (const server of routers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await new Promise((resolve) => backend.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test("public bearer rejected on invalid signature, wrong audience, wrong scope and expiry", () => {
  const access = makeAccess();
  const second = generateKeyPairSync("ed25519");
  for (const candidate of [
    mint({ aud: issuer }),
    mint({ iss: "https://attacker.example.test" }),
    mint({ scope: "mcp:admin" }),
    mint({ exp: Math.floor(current() / 1000) - 20 }),
    mint({ key: second.privateKey }),
    "old-mac-devspace-bearer"
  ]) {
    assert.throws(() => access.authenticate(candidate), {
      code: "invalid_token"
    });
  }
  assert.equal(access.authenticate(mint()).subject, "user-001");
});

test("CodasSol public token authorizes remote routing without leaking bearer into Agent jobs", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codassol-public-agent-"));
  const backend = http.createServer((_req, res) => res.end("ok"));
  const backendPort = await listen(backend);
  let router;
  try {
    const config = {
      listenHost: "127.0.0.1", listenPort: 0,
      backendHost: "127.0.0.1", backendPort, backendTimeoutMs: 1000,
      stateDir: temp, localDeviceId: "mac", localDeviceLabel: "mac",
      localRoots: ["/tmp/project"]
    };
    const runtime = await createRouterRuntime(config, { publicAuth: makeAccess() });
    runtime.devices.register({
      id: "windows", platform: "win32", roots: ["C:\\Projects"],
      presence: "heartbeat"
    });
    await runtime.catalog.observe({
      id: "windows", defaultName: "Windows", platform: "win32", kind: "agent"
    });
    router = createRouterServer(config, runtime);
    const port = await listen(router);
    const queued = runtime.agentHub.poll("windows", { timeoutMs: 1500 });
    const responsePromise = post(`http://127.0.0.1:${port}`, mint(), {
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "open_workspace", arguments: {
        path: "C:\\Projects", device_id: "windows"
      } }
    });
    const job = await queued;
    assert.equal(job.payload.type, "devspace-http");
    assert.equal(job.payload.request.headers.authorization, undefined);
    const forwarded = JSON.parse(Buffer.from(job.payload.request.bodyBase64, "base64"));
    assert.equal(forwarded.params.arguments.device_id, undefined);
    assert.equal(forwarded.params.arguments.path, "C:\\Projects");
    runtime.agentHub.complete("windows", job.id, {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from(JSON.stringify({
        jsonrpc: "2.0", id: 10,
        result: { structuredContent: {
          workspace_id: "ws_remote_public",
          root: "C:\\Projects", mode: "checkout"
        } }
      })).toString("base64")
    });
    const response = await responsePromise;
    assert.equal(response.response.status, 200);
    assert.equal(runtime.bindings.get("ws_remote_public").deviceId, "windows");
  } finally {
    if (router) {
      router.closeAllConnections();
      await new Promise((resolve) => router.close(resolve));
    }
    await new Promise((resolve) => backend.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test("stale or forged revocation state fails closed, and denied access cannot fall back to DevSpace", async () => {
  const auth = makeAccess({ revocationsUpdatedAt: current() - 6 * 60_000 });
  assert.throws(() => auth.authenticate(mint()), { code: "revocation_state_stale" });
  const first = mint();
  const parsed = JSON.parse(Buffer.from(first.split(".")[1], "base64url").toString());
  const revoked = makeAccess({ revokedJtis: new Set([parsed.jti]) });
  assert.throws(() => revoked.authenticate(first), { code: "invalid_token" });
});

test("external public-auth provisioning loads pinned PEM only and refuses invalid states", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codassol-public-auth-json-"));
  const filename = path.join(temp, "public-mcp-auth.json");
  try {
    const data = {
      version: 1, issuer,
      keys: [{
        id: kid, publicKeyPem: pair.publicKey.export({
          format: "pem", type: "spki"
        })
      }],
      revokedJtis: [],
      revocationsUpdatedAt: current()
    };
    await writeFile(filename, JSON.stringify(data), { mode: 0o600 });
    assert.equal((await loadPublicMcpAccessFromFile(filename))
      .authenticate(mint()).subject, "user-001");
    await writeFile(filename, JSON.stringify({ version: 1, issuer, keys: [] }));
    await assert.rejects(loadPublicMcpAccessFromFile(filename), /Incomplete/);
    await assert.rejects(loadPublicMcpAccessFromFile("./relative"), /absolute/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("fresh live revocation file updates authorization without restarting either Router", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codas-live-revocations-"));
  const stateFile = path.join(temp, "mirrored-auth.json");
  try {
    const state = new LocalRefreshAuthority({ filePath: stateFile });
    const token = mint();
    const tokenId = JSON.parse(Buffer.from(token.split(".")[1],
      "base64url").toString("utf8")).jti;
    await state.transact((data) => {
      data.namespaces = { revocations: { records: {} } };
      data.lastReplicaAckAt = Date.now();
    });
    const auth = makeAccess({
      revocationReader: createLocalRevocationReader({ filePath: stateFile })
    });
    const mac = auth;
    const windows = makeAccess({
      revocationReader: createLocalRevocationReader({ filePath: stateFile })
    });
    assert.equal((await mac.authorize(token)).subject, "user-001");
    assert.equal((await windows.authorize(token)).subject, "user-001");
    assert.throws(() => auth.authenticate(token), {
      code: "revocation_store_unavailable"
    });
    await state.transact((data) => {
      data.namespaces.revocations.records[tokenId] = {
        revokedAt: Date.now()
      };
      data.lastReplicaAckAt = Date.now();
    });
    await assert.rejects(mac.authorize(token), { code: "invalid_token" });
    await assert.rejects(windows.authorize(token), { code: "invalid_token" });
    await state.transact((data) => {
      data.lastReplicaAckAt = Date.now() - 6 * 60_000;
    });
    await assert.rejects(mac.authorize(mint()), {
      code: "revocation_state_stale"
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("public MCP returns 503 for unavailable live revocations and 401 for invalid token", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codas-revocation-http-"));
  const stateFile = path.join(temp, "revocations.json");
  const backend = http.createServer((_req, res) => res.end("ok"));
  const backendPort = await listen(backend);
  let router;
  try {
    const store = new LocalRefreshAuthority({ filePath: stateFile });
    await store.transact((data) => {
      data.namespaces = { revocations: { records: {} } };
      data.lastReplicaAckAt = Date.now();
    });
    const config = {
      listenHost: "127.0.0.1", listenPort: 0,
      backendHost: "127.0.0.1", backendPort,
      backendTimeoutMs: 1000, stateDir: path.join(temp, "router"),
      localDeviceId: "mac", localDeviceLabel: "Mac", localRoots: ["/tmp"]
    };
    const runtime = await createRouterRuntime(config, {
      publicAuth: makeAccess({
        revocationReader: createLocalRevocationReader({ filePath: stateFile })
      })
    });
    let executed = 0;
    runtime.peerOAuth.authorizedFetch = async () => {
      ++executed;
      return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    };
    router = createRouterServer(config, runtime);
    const base = `http://127.0.0.1:${await listen(router)}`;
    const payload = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    assert.equal((await post(base, mint(), payload)).response.status, 200);
    assert.equal(executed, 1);
    const invalid = await post(base, "mac-devspace-not-public", payload);
    assert.equal(invalid.response.status, 401);
    assert.equal(executed, 1);
    await store.transact((data) => {
      data.lastReplicaAckAt = Date.now() - 10 * 60_000;
    });
    const unavailable = await post(base, mint(), payload);
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.data.error, "authorization_state_unavailable");
    assert.equal(unavailable.response.headers.get("www-authenticate"), null,
      "temporary state failure should not force a ChatGPT re-login");
    assert.equal(executed, 1);
  } finally {
    if (router) {
      router.closeAllConnections();
      await new Promise((resolve) => router.close(resolve));
    }
    await new Promise((resolve) => backend.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test("public auth config may require live revocation state without trusting boot-time snapshot", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codas-config-live-auth-"));
  const filePath = path.join(temp, "auth.json");
  const mirror = path.join(temp, "mirrored-state.json");
  try {
    const store = new LocalRefreshAuthority({ filePath: mirror });
    await store.transact((data) => {
      data.namespaces = { revocations: { records: {} } };
      data.lastReplicaAckAt = Date.now();
    });
    await writeFile(filePath, JSON.stringify({
      version: 1, issuer,
      keys: [{ id: kid, publicKeyPem: pair.publicKey.export({
        type: "spki", format: "pem"
      }) }],
      liveRevocationStateFile: mirror
    }));
    const verifier = await loadPublicMcpAccessFromFile(filePath);
    await assert.doesNotReject(verifier.authorize(mint()));
    assert.throws(() => verifier.authenticate(mint()),
      { code: "revocation_store_unavailable" });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
