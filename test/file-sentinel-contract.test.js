import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Windows File Sentinel is independent and never performs remote or repair operations", async () => {
  const script = await read("../components/file-sentinel/windows/watch.ps1");
  assert.match(script, /System\.IO\.FileSystemWatcher/);
  assert.match(script, /Get-FileHash.*SHA256/);
  assert.match(script, /changes-/);
  assert.match(script, /events\.jsonl/);
  assert.match(script, /baseline\.json/);
  assert.match(script, /function Compare-SentinelSnapshots\(/);
  assert.doesNotMatch(script, /function Compare\(/);
  assert.match(script, /FileSystemWatcher.*not.*process|Process identity unavailable/i);
  assert.match(script, /ScanSeconds = 10/);
  assert.doesNotMatch(script, /Remove-Item|Stop-Process|Set-MpPreference|Invoke-RestMethod|Invoke-WebRequest|curl(?:\.exe)?/i);
});

test("Sentinel installer is an opt-in, user-owned, independently removable component", async () => {
  const installer = await read("../components/file-sentinel/windows/install.ps1");
  const main = await read("../scripts/windows/standalone/install.ps1");
  const packager = await read("../scripts/package-windows-standalone-node.sh");
  assert.match(installer, /\[switch\]\$Uninstall/);
  assert.match(installer, /RunLevel Limited/);
  assert.match(installer, /LogonType Interactive/);
  assert.match(installer, /Unregister-ScheduledTask.*-Confirm:\$false/);
  assert.match(installer, /ownership differs/);
  assert.doesNotMatch(installer, /CodasSol Outbound SSE|Stop-Process|Set-MpPreference/);
  assert.match(main, /\[switch\]\$InstallFileSentinel/);
  assert.match(main, /\[switch\]\$SkipSentinelPrompt/);
  assert.match(main, /System\.Windows\.Forms\.CheckBox/);
  assert.match(main, /\$box\.Checked = \$false/);
  assert.match(main, /components\\file-sentinel\\windows\\install\.ps1/);
  assert.match(packager, /components\/file-sentinel\/windows/);
  assert.match(packager, /standalone-rc\.1/);
});
