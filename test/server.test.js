import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRouterServer } from "../src/server.js";

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

function request(port, options = {}, body = "") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method || "GET",
        path: options.path || "/",
        headers: options.headers || {}
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString()
        }));
      }
    );
    req.once("error", reject);
    req.end(body);
  });
}

test("forwards method, path, query, headers and body", async () => {
  let seen;
  const backend = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen = {
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString(),
        marker: req.headers["x-test-marker"]
      };
      res.writeHead(201, { "x-backend": "yes" });
      res.end("forwarded");
    });
  });
  const backendPort = await listen(backend);
  const router = createRouterServer({
    backendHost: "127.0.0.1",
    backendPort,
    backendTimeoutMs: 2000
  });
  const routerPort = await listen(router);

  const response = await request(routerPort, {
    method: "POST",
    path: "/mcp?x=1",
    headers: {
      "content-type": "application/json",
      "x-test-marker": "abc"
    }
  }, '{"hello":"world"}');

  assert.equal(response.statusCode, 201);
  assert.equal(response.headers["x-backend"], "yes");
  assert.equal(response.body, "forwarded");
  assert.deepEqual(seen, {
    method: "POST",
    url: "/mcp?x=1",
    body: '{"hello":"world"}',
    marker: "abc"
  });

  await close(router);
  await close(backend);
});

test("streams backend response chunks", async () => {
  const backend = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("one");
    setTimeout(() => res.end("two"), 20);
  });
  const backendPort = await listen(backend);
  const router = createRouterServer({
    backendHost: "127.0.0.1",
    backendPort,
    backendTimeoutMs: 2000
  });
  const routerPort = await listen(router);
  const response = await request(routerPort);
  assert.equal(response.body, "onetwo");
  await close(router);
  await close(backend);
});

test("backend failure returns 502 and does not retry mutation", async () => {
  const temp = http.createServer();
  const deadPort = await listen(temp);
  await close(temp);

  const router = createRouterServer({
    backendHost: "127.0.0.1",
    backendPort: deadPort,
    backendTimeoutMs: 300
  });
  const routerPort = await listen(router);
  const response = await request(routerPort, {
    method: "POST",
    path: "/mcp",
    headers: { "content-type": "application/json" }
  }, "{}");
  assert.equal(response.statusCode, 502);
  assert.match(response.body, /No retry was attempted/);
  await close(router);
});

test("health endpoint reports backend reachability", async () => {
  const backend = http.createServer((_req, res) => res.end("ok"));
  const backendPort = await listen(backend);
  const router = createRouterServer({
    backendHost: "127.0.0.1",
    backendPort,
    backendTimeoutMs: 2000
  });
  const routerPort = await listen(router);
  const response = await request(routerPort, { path: "/_codassol/health" });
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.backend.reachable, true);
  await close(router);
  await close(backend);
});
