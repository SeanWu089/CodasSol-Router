import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const endpoint = "http://127.0.0.1:18787";
const domain = "https://fixed-codas.example.test";
const mac = "mac-installation-12345";
const windows = "windows-installation-12345";
const tokens = { [mac]: "a".repeat(64), [windows]: "b".repeat(64) };
const subprocess = spawn("npx", [
  "--yes", "wrangler@4", "dev",
  "--config", "deploy/cloudflare-witness/wrangler.jsonc",
  "--local", "--port", "18787",
  "--show-interactive-dev-session=false",
  "--var", `CODASSOL_PUBLIC_DOMAIN:${domain}`,
  "--var", `CODASSOL_NODE_TOKENS:${JSON.stringify(tokens)}`
], {
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" }
});
let output = "";
for (const stream of [subprocess.stdout, subprocess.stderr]) {
  stream.on("data", (chunk) => {
    output += chunk.toString();
    if (output.length > 20_000) output = output.slice(-20_000);
  });
}
let exited = false;
subprocess.once("exit", () => { exited = true; });

async function call(action, actor, body = {}, authorized = true) {
  const response = await fetch(`${endpoint}/v1/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codassol-installation-id": actor,
      authorization: "Bearer " + (
        authorized ? tokens[actor] : "f".repeat(64))
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000)
  });
  return { status: response.status, data: await response.json() };
}

try {
  // Negative authorization response proves the Worker has reached its
  // running state without causing any Durable Object mutation.
  let ready = false;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error("Wrangler exited: " + output);
    try {
      const probe = await call("status", mac, {}, false);
      if (probe.status === 401) { ready = true; break; }
    } catch { /* dev server has not bound its socket yet */ }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  assert.equal(ready, true, "Worker not ready: " + output);

  const deny = await call("acquire", mac, { ownerId: mac, domain }, false);
  assert.equal(deny.status, 401);

  const before = await call("status", mac);
  const first = await call("acquire", mac, { ownerId: mac, domain });
  assert.equal(first.status, 200);
  assert.equal(first.data.result?.epoch, 1, "first acquisition: " + JSON.stringify(first));
  const macClaim = first.data.result;
  assert.ok(macClaim.fencingToken.length >= 32);

  const other = await call("acquire", windows, {
    ownerId: windows, domain
  });
  assert.equal(other.data.result, null, "second Router cannot acquire an active lease");

  const committed = await call("publish", mac, {
    claim: macClaim, checkpoint: {
      revision: 1, digest: "A".repeat(43), previous: null
    }
  });
  assert.equal(committed.data.result, true);
  assert.equal((await call("confirm", mac, {
    claim: macClaim, checkpoint: {
      revision: 1, digest: "A".repeat(43)
    }
  })).data.result, true);

  const wrongOwner = await call("verify", windows, { claim: macClaim });
  assert.equal(wrongOwner.data.result, false);
  assert.equal((await call("release", mac, { claim: macClaim })).data.result, true);

  const takeover = await call("acquire", windows, {
    ownerId: windows, domain
  });
  assert.equal(takeover.data.result.epoch, 2);
  assert.equal((await call("publish", windows, {
    claim: takeover.data.result,
    checkpoint: { revision: 1, digest: "B".repeat(43), previous: null }
  })).data.result, false, "new epoch must not reset previous committed revision");

  const status = await call("status", windows);
  assert.equal(status.data.result.latestCommitted.revision, 1);
  assert.equal(status.data.result.epoch, 2);
  assert.equal(JSON.stringify(status.data).includes(macClaim.fencingToken),
    false, "status must never reveal lease secrets");

  console.log("Cloudflare workerd runtime HTTP integration passed.");
} finally {
  if (process.platform === "win32") subprocess.kill("SIGTERM");
  else {
    try { process.kill(-subprocess.pid, "SIGTERM"); }
    catch { subprocess.kill("SIGTERM"); }
  }
}
