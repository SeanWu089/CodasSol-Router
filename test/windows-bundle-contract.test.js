import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Windows package includes an independent Router and offline setup option", async () => {
  const packageScript = await readFile("scripts/package-windows-agent.sh", "utf8");
  const installer = await readFile("scripts/windows/bundle/install.ps1", "utf8");
  const autostart = await readFile("scripts/windows/bundle/install-autostart.ps1", "utf8");
  const startup = await readFile("scripts/windows/runtime/start-router.ps1", "utf8");

  assert.match(packageScript, /src\/\*\.js/);
  assert.match(packageScript, /runtime\/start-router\.ps1/);
  assert.match(installer, /\[switch\]\$SkipEnrollment/);
  assert.match(installer, /Connect to another Router now/);
  assert.match(installer, /127\.0\.0\.1:17676/);
  assert.match(installer, /_codassol\/peer\/info/);
  assert.match(installer, /\(\[string\]\$prefill\)\.Trim\(\)/,
    "empty private Router URL files must not crash the Windows installer");
  assert.match(autostart, /TaskName "CodasSol Router"/);
  assert.match(startup, /CODASSOL_LOCAL_DEVICE_ID/);
  assert.match(startup, /CODASSOL_LOCAL_ROOTS/);
  assert.match(startup, /"127\.0\.0\.1"/);
});
