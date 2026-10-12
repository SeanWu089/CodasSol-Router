import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPinnedPeerFetch } from "../src/peer-transport.js";
import { PeerMesh } from "../src/peer-mesh.js";
import { DeviceRegistry } from "../src/device-registry.js";

test("address pins retain certificate hostname, Host, bearer, body and reject redirects/aborts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codassol-peer-tls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem"),
    "-days", "1", "-subj", "/CN=peer.example.test", "-addext", "subjectAltName=DNS:peer.example.test"], { stdio: "ignore" });
  const cert = await readFile(path.join(root, "cert.pem"));
  const calls = [];
  const server = https.createServer({ key: await readFile(path.join(root, "key.pem")), cert }, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ host: req.headers.host, bearer: req.headers.authorization, body, sni: req.socket.servername });
    if (req.url === "/redirect") { res.writeHead(302, { location: "https://other.example.test" }); res.end(); }
    else if (req.url === "/wait") { /* aborted by caller */ }
    else { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const trustedRequest = (url, options, callback) => https.request(url, { ...options, ca: cert }, callback);
  const transport = createPinnedPeerFetch("127.0.0.1", trustedRequest);
  const origin = `https://peer.example.test:${server.address().port}`;
  const reply = await transport(origin + "/execute", { method: "POST", headers: { authorization: "Bearer private-test-token" }, body: '{"operation":"read"}' });
  assert.deepEqual(await reply.json(), { ok: true });
  assert.deepEqual(calls[0], { host: `peer.example.test:${server.address().port}`, bearer: "Bearer private-test-token", body: '{"operation":"read"}', sni: "peer.example.test" });
  await assert.rejects(transport(origin.replace("peer.example.test", "wrong.example.test")), /Hostname\/IP does not match/);
  await assert.rejects(createPinnedPeerFetch("127.0.0.1")(origin), /self-signed certificate/);
  await assert.rejects(transport(origin + "/redirect"), /redirects are forbidden/);
  await assert.rejects(transport(origin + "/wait", { signal: AbortSignal.timeout(50) }), /aborted/);
  assert.throws(() => createPinnedPeerFetch("not-an-ip"), /IP address/);
  await assert.rejects(transport("http://peer.example.test"), /require HTTPS/);
});

test("peer configuration rejects invalid or insecure connection pins", () => {
  const runtime = { localDeviceId: "mac", devices: new DeviceRegistry() };
  const peer = { id: "windows", token: "a".repeat(40), url: "https://peer.example.test", roots: [] };
  for (const connectAddress of ["name.example", "127.0.0.1:443", 12]) {
    assert.throws(() => new PeerMesh({ runtime, peers: [{ ...peer, connectAddress }] }), /connectAddress/);
  }
  assert.throws(() => new PeerMesh({ runtime, peers: [{ ...peer, url: "http://127.0.0.1", connectAddress: "127.0.0.1" }] }), /connectAddress/);
});
