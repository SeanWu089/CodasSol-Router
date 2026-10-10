import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Windows package includes an independent Router and offline setup option", async () => {
  const packageScript = await readFile("scripts/package-windows-agent.sh", "utf8");
  const installer = await readFile("scripts/windows/bundle/install.ps1", "utf8");
  const autostart = await readFile("scripts/windows/bundle/install-autostart.ps1", "utf8");
  const startup = await readFile("scripts/windows/runtime/start-router.ps1", "utf8");
  const devspaceStartup = await readFile("scripts/windows/runtime/start-devspace.ps1", "utf8");

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
  for (const script of [installer, devspaceStartup]) {
    assert.match(script, /@waishnav\\devspace\\dist\\cli\.js/,
      "both installer and autostart must use DevSpace's published dist entrypoint");
    assert.doesNotMatch(script, /\\\.bin\\devspace\.cmd/,
      "npm-generated command shim is not a reliable Windows entrypoint");
    assert.match(script, /& \$NodeExe \$DevSpaceCli/);
  }
  assert.match(installer, /& \$NodeExe \$DevSpaceCli init/);
  assert.match(devspaceStartup, /& \$NodeExe \$DevSpaceCli serve/);
  assert.match(installer, /Stop-ScheduledTask -TaskName \$taskName/,
    "upgrade must stop old scheduled tasks before replacing the private runtime");
  assert.match(installer, /\.ExecutablePath -eq \$NodeExe/,
    "upgrade must only stop Node processes belonging to the private installation");
  assert.match(startup, /\(\[string\]\(Get-Content \$RootsFile -Raw\)\)\.Trim\(\)/,
    "empty roots files should fail with an actionable error, not a null-method exception");
});

test("Windows DevSpace recovery survives healthy startup and backend crashes", async () => {
  const startup = await readFile("scripts/windows/runtime/start-devspace.ps1", "utf8");
  const autostart = await readFile("scripts/windows/bundle/install-autostart.ps1", "utf8");

  assert.match(startup, /while\s*\(\$true\)/i,
    "a healthy backend must leave a supervisor running for later failures");
  assert.match(startup, /\$health\.ok\s+-eq\s+\$true/,
    "a TCP listener alone does not prove the DevSpace backend is healthy");
  assert.match(startup, /\$health\.name\s+-eq\s+"devspace"/,
    "an unrelated service on port 7676 must not masquerade as DevSpace");
  assert.match(startup, /&\s+\$NodeExe\s+\$DevSpaceCli\s+serve/,
    "DevSpace must restart using the published CLI rather than a missing shim");
  assert.match(startup, /Start-Sleep\s+-Seconds\s+5/,
    "a failed local service should be retried with a bounded backoff");
  assert.doesNotMatch(startup, /exit\s+0/i,
    "exiting when DevSpace is healthy would eliminate the crash supervisor");
  assert.match(autostart, /-RestartCount\s+3/,
    "Windows Scheduled Tasks must restart the supervisor after failure");
  assert.match(autostart, /-StartWhenAvailable/,
    "missed starts should be retried by Windows Task Scheduler");
});
