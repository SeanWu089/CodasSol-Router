import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WitnessLeaseKeeper } from "../src/ingress/witness-lease-keeper.js";
import { CloudflareWitnessAuthority } from "../src/ingress/cloudflare-witness-authority.js";
import {
  emptyWitnessState, applyWitnessAction
} from "../src/ingress/cloudflare-witness-core.js";

const domain = "https://fixed-codas.example.test";
const installationId = "mac-installation-12345";
const secret = "a".repeat(64);
const fencing = "strong-private-opaque-fencing-token-1234567890";

async function fixture(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codas-witness-keeper-"));
  let current = emptyWitnessState();
  let now = 1_800_000_000_000;
  let offline = false;
  const fetchImpl = async (url, options) => {
    if (offline) throw new Error("Witness disconnected");
    assert.equal(options.headers.authorization, "Bearer " + secret);
    const action = url.split("/").at(-1);
    const payload = JSON.parse(options.body);
    const response = applyWitnessAction({
      state: current, action, actor: installationId, payload, now,
      ttlMs: 30_000, newToken: fencing, newTokenHash: "f".repeat(64),
      presentedTokenHash: payload.claim?.fencingToken === fencing
        ? "f".repeat(64) : undefined
    });
    if (response.changed) current = response.state;
    return Response.json({ result: response.result });
  };
  const witness = new CloudflareWitnessAuthority({
    endpoint: "https://coordination.example.workers.dev",
    publicDomain: domain, installationId, secret, fetchImpl
  });
  const filePath = path.join(dir, "private-claim.json");
  const keeper = new WitnessLeaseKeeper({
    authority: witness, installationId, domain,
    claimFile: filePath, clock: () => now
  });
  try {
    await fn({
      keeper, filePath, dir, witness,
      advance: (delta) => { now += delta; },
      setOffline: (value) => { offline = value; },
      current: () => current
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("one-time acquire, durable owner claim, renewal and release do not touch ngrok", async () => {
  await fixture(async ({ keeper, filePath, witness, advance }) => {
    const initial = await keeper.acquireOnce();
    assert.equal(initial.epoch, 1);
    assert.equal((await witness.status()).ownerId, installationId);
    const before = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(before.fencingToken, fencing);
    assert.equal(before.expiresAt, initial.expiresAt);
    await assert.rejects(keeper.acquireOnce(), {
      code: "WITNESS_LEASE_UNAVAILABLE"
    }, "existing lease must not silently be replaced");
    advance(10_000);
    const renewed = await keeper.renewOnce();
    assert.equal(renewed.epoch, initial.epoch);
    assert.ok(renewed.expiresAt > initial.expiresAt);
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).fencingToken,
      fencing, "renewal must not rotate the epoch or token");
    assert.equal(await keeper.releaseOnce(), true);
    assert.equal((await witness.status()).ownerId, null);
    await assert.rejects(readFile(filePath), { code: "ENOENT" });
    assert.equal(await keeper.releaseOnce(), false);
  });
});

test("network loss at renewal invalidates locally even if external lease remains active", async () => {
  await fixture(async ({ keeper, filePath, setOffline, current }) => {
    await keeper.acquireOnce();
    setOffline(true);
    await assert.rejects(keeper.renewOnce(), {
      code: "WITNESS_LEASE_UNAVAILABLE"
    });
    await assert.rejects(readFile(filePath), { code: "ENOENT" });
    assert.equal(current().lease?.ownerId, installationId);
    // The external claim may still be valid. Nothing automatically starts
    // ngrok or attempts unsafe re-acquisition.
    setOffline(false);
    await assert.rejects(keeper.renewOnce(), {
      code: "WITNESS_LEASE_UNAVAILABLE"
    });
  });
});

test("expired claim and uncertain lock both fail closed until manual reconciliation", async () => {
  await fixture(async ({ keeper, filePath, advance }) => {
    await keeper.acquireOnce();
    await writeFile(filePath + ".lock", "uncertain", { flag: "wx" });
    await assert.rejects(keeper.renewOnce(), {
      code: "WITNESS_LEASE_UNAVAILABLE"
    });
    await rm(filePath + ".lock");
    advance(31_000);
    await assert.rejects(keeper.renewOnce(), {
      code: "WITNESS_LEASE_UNAVAILABLE"
    });
    await assert.rejects(readFile(filePath), { code: "ENOENT" });
  });
});

test("external release failure still clears the local claim immediately", async () => {
  await fixture(async ({ keeper, filePath, setOffline }) => {
    await keeper.acquireOnce();
    setOffline(true);
    await assert.rejects(keeper.releaseOnce(), {
      code: "WITNESS_LEASE_UNAVAILABLE"
    });
    await assert.rejects(readFile(filePath), { code: "ENOENT" });
  });
});
