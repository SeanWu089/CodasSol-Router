import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RouterPrivateState } from "../src/private-state.js";

test("legacy state generates and persists a separate peer token", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "codassol-v2-peer-token-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await writeFile(path.join(stateDir, "router.json"), JSON.stringify({
    version: 1, pairingToken: "legacy-pairing-token", agents: {}
  }));
  const first = await new RouterPrivateState({ stateDir }).init();
  assert.ok(first.peerToken.length >= 32);
  assert.notEqual(first.peerToken, first.pairingToken);
  assert.equal(first.verifyPeerToken(first.peerToken), true);
  assert.equal(first.verifyPeerToken(first.pairingToken), false);
  const second = await new RouterPrivateState({ stateDir }).init();
  assert.equal(second.peerToken, first.peerToken);
  assert.equal(JSON.parse(await readFile(path.join(stateDir, "router.json"), "utf8")).peerToken,
    first.peerToken);
});
