import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  applyWitnessAction, emptyWitnessState
} from "../src/ingress/cloudflare-witness-core.js";
import { CloudflareWitnessAuthority } from "../src/ingress/cloudflare-witness-authority.js";

const mac = "mac-installation-12345";
const windows = "windows-installation-12345";
const checksum = (s) => createHash("sha256").update(s).digest("hex");
const digestA = "A".repeat(43);
const digestB = "B".repeat(43);
const publicDomain = "https://stable-codas.example.test";

function witness() {
  let state = emptyWitnessState();
  let now = 1_000_000;
  return {
    operate(action, actor, payload = {}, extras = {}) {
      const result = applyWitnessAction({
        state, action, actor, payload, now,
        ttlMs: 30_000, ...extras
      });
      if (result.changed) state = result.state;
      return result.result;
    },
    now(value) { now = value; },
    state() { return structuredClone(state); }
  };
}

test("exclusive claim, expiry and monotonic epochs survive owner changes", () => {
  const w = witness();
  const firstToken = "a".repeat(64);
  const secondToken = "b".repeat(64);
  const claim = w.operate("acquire", mac, { ownerId: mac, domain: publicDomain }, {
    newToken: firstToken, newTokenHash: checksum(firstToken)
  });
  assert.equal(claim.epoch, 1);
  assert.equal(w.operate("acquire", windows, { ownerId: windows, domain: publicDomain }, {
    newToken: secondToken, newTokenHash: checksum(secondToken)
  }), null);
  assert.equal(w.operate("verify", mac, { claim }, {
    presentedTokenHash: checksum(firstToken)
  }), true);
  assert.equal(w.operate("verify", mac, { claim }, {
    presentedTokenHash: checksum("forged-token")
  }), false);
  assert.equal(w.operate("verify", windows, { claim }, {
    presentedTokenHash: checksum(firstToken)
  }), false);
  w.now(1_040_000);
  assert.equal(w.operate("verify", mac, { claim }, {
    presentedTokenHash: checksum(firstToken)
  }), false);
  const next = w.operate("acquire", windows, { ownerId: windows, domain: publicDomain }, {
    newToken: secondToken, newTokenHash: checksum(secondToken)
  });
  assert.equal(next.epoch, 2);
  assert.equal(w.operate("renew", mac, { claim }, {
    presentedTokenHash: checksum(firstToken)
  }), null);
});

test("latest authorization digest never jumps, forks or resets across lease changes", () => {
  const w = witness();
  const t1 = "a".repeat(64), t2 = "b".repeat(64);
  const c1 = w.operate("acquire", mac, { ownerId: mac, domain: publicDomain }, {
    newToken: t1, newTokenHash: checksum(t1)
  });
  const act = (action, actor, claim, checkpoint, token) =>
    w.operate(action, actor, { claim, checkpoint }, {
      presentedTokenHash: checksum(token)
    });
  assert.equal(act("publish", mac, c1, {
    revision: 2, digest: digestA, previous: null
  }, t1), false);
  assert.equal(act("publish", mac, c1, {
    revision: 1, digest: digestA, previous: null
  }, t1), true);
  assert.equal(act("publish", mac, c1, {
    revision: 1, digest: digestB, previous: null
  }, t1), false);
  assert.equal(act("confirm", mac, c1, {
    revision: 1, digest: digestA
  }, t1), true);
  assert.equal(act("confirm", mac, c1, {
    revision: 1, digest: digestB
  }, t1), false);
  assert.equal(w.operate("release", mac, { claim: c1 }, {
    presentedTokenHash: checksum(t1)
  }), true);
  const c2 = w.operate("acquire", windows, { ownerId: windows, domain: publicDomain }, {
    newToken: t2, newTokenHash: checksum(t2)
  });
  assert.equal(c2.epoch, 2);
  assert.equal(act("publish", windows, c2, {
    revision: 1, digest: digestA, previous: null
  }, t2), false);
  assert.equal(act("publish", windows, c2, {
    revision: 2, digest: digestB, previous: digestA
  }, t2), true);
  const status = w.operate("status", windows);
  assert.deepEqual({ revision: status.latestCommitted.revision,
    digest: status.latestCommitted.digest }, {
    revision: 2, digest: digestB
  });
  assert.equal(JSON.stringify(status).includes(t2), false,
    "witness status must never expose a fencing secret");
});

test("HTTP client works with an independent witness and fails closed on outage", async () => {
  const state = witness();
  const secret = "c".repeat(64), fencing = "d".repeat(64);
  let outage = false;
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, ...options });
    if (outage) throw new Error("witness network offline");
    assert.equal(options.headers.authorization, "Bearer " + secret);
    assert.equal(options.headers["x-codassol-installation-id"], windows);
    assert.equal(options.redirect, "error");
    const action = url.split("/").at(-1);
    const payload = JSON.parse(options.body);
    const result = state.operate(action, windows, payload, {
      newToken: fencing, newTokenHash: checksum(fencing),
      presentedTokenHash: payload.claim ?
        checksum(payload.claim.fencingToken) : undefined
    });
    return Response.json({ result });
  };
  const client = new CloudflareWitnessAuthority({
    endpoint: "https://witness.example.workers.dev",
    publicDomain,
    installationId: windows, secret, fetchImpl: fakeFetch
  });
  assert.equal(client.enforcesExternalFencing, false,
    "control-plane lease alone cannot fence ngrok's data plane");
  const claim = await client.acquire({ ownerId: windows, domain: publicDomain });
  assert.equal(await client.verify(claim), true);
  assert.equal(await client.publishCommitted({ claim, checkpoint: {
    revision: 1, digest: digestA, previous: null
  } }), true);
  assert.equal(await client.confirmLatestCommitted({
    claim, installationId: windows,
    checkpoint: { revision: 1, digest: digestA }
  }), true);
  await client.release(claim);
  assert.equal(await client.verify(claim), false);
  outage = true;
  await assert.rejects(client.status(), /offline/);
  assert.equal(requests.length, 7);
});
