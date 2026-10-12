import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INGRESS_OWNER_PROOF_ROUTE,
  createIngressOwnerProof,
  verifyPublicIngressOwner
} from "../src/ingress/public-owner-proof.js";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";

const domain = "https://stable-codas.example.test";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

test("public challenge HMAC proves an instance, not another instance or a replay", () => {
  const local = createIngressOwnerProof();
  const other = createIngressOwnerProof();
  const nonce = Buffer.alloc(24, 7).toString("base64url");
  const differentNonce = Buffer.alloc(24, 9).toString("base64url");
  const answer = local.respond(nonce);
  assert.equal(local.matches(nonce, answer), true);
  assert.equal(other.matches(nonce, answer), false);
  assert.equal(local.matches(differentNonce, answer), false);
  assert.equal(local.matches(nonce, { ...answer, proof: answer.proof.slice(1) }), false);
  assert.throws(() => local.respond("invalid"), /challenge/);
  assert.equal(JSON.stringify(answer).includes("installationId"), false);
});

test("real local Routers prove which instance serves a public URL, no domain switch needed", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "codassol-proof-"));
  const backend = http.createServer((_req, res) => res.end("ok"));
  const backendPort = await listen(backend);
  const servers = [];
  try {
    const nodes = [];
    for (const name of ["mac", "windows"]) {
      const config = {
        listenHost: "127.0.0.1", listenPort: 0,
        backendHost: "127.0.0.1", backendPort, backendTimeoutMs: 1_000,
        stateDir: path.join(stateDir, name),
        localDeviceId: name, localDeviceLabel: name, localRoots: ["/tmp"]
      };
      const runtime = await createRouterRuntime(config);
      const server = createRouterServer(config, runtime);
      servers.push(server);
      const port = await listen(server);
      nodes.push({ runtime, port });
    }
    const publicFetch = (target) => (url, options) => {
      assert.equal(url, domain + INGRESS_OWNER_PROOF_ROUTE);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.authorization, undefined,
        "do not send admin/OAuth credentials to a potentially wrong endpoint");
      return fetch(`http://127.0.0.1:${target.port}${INGRESS_OWNER_PROOF_ROUTE}`, options);
    };
    const verifiedMac = await verifyPublicIngressOwner({
      publicUrl: domain, ownerProof: nodes[0].runtime.ingressOwnerProof,
      fetchFn: publicFetch(nodes[0])
    });
    assert.deepEqual(verifiedMac, { verified: true });
    const misrouted = await verifyPublicIngressOwner({
      publicUrl: domain, ownerProof: nodes[1].runtime.ingressOwnerProof,
      fetchFn: publicFetch(nodes[0])
    });
    assert.deepEqual(misrouted,
      { verified: false, reason: "different_router_instance" });
    const invalidChallenge = await fetch(
      `http://127.0.0.1:${nodes[0].port}${INGRESS_OWNER_PROOF_ROUTE}`,
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: "bad" }) }
    );
    assert.equal(invalidChallenge.status, 400);
    assert.equal((await invalidChallenge.text()).includes("proof"), false);
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await new Promise((resolve) => backend.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("public proof fails closed on wrong scheme, malformed JSON, oversized content or outage", async () => {
  const proof = createIngressOwnerProof();
  const badFetches = [
    async () => new Response("ngrok interstitial", {
      status: 200, headers: { "content-type": "text/plain" }
    }),
    async () => new Response("{broken", {
      status: 200, headers: { "content-type": "application/json" }
    }),
    async () => new Response("X".repeat(1100), {
      status: 200, headers: { "content-type": "application/json" }
    }),
    async () => { throw new Error("connection refused"); }
  ];
  const reasons = [
    "unexpected_response", "invalid_body", "oversized_response", "unreachable"
  ];
  for (const [index, fetchFn] of badFetches.entries()) {
    assert.equal((await verifyPublicIngressOwner({
      publicUrl: domain, ownerProof: proof, fetchFn
    })).reason, reasons[index]);
  }
  await assert.rejects(verifyPublicIngressOwner({
    publicUrl: "http://127.0.0.1:17676", ownerProof: proof
  }), /HTTPS/);
  await assert.rejects(verifyPublicIngressOwner({
    publicUrl: domain + "/unsafe-path", ownerProof: proof
  }), /HTTPS/);
});
