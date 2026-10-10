import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(`scripts/windows/standalone/${name}`, 'utf8');

test('standalone node is installed into an isolated prefix and credentials are preserved', async () => {
  const install = await read('install.ps1');
  assert.match(install, /NodeV02Standalone/);
  assert.match(install, /\.codassol-node-v02/);
  assert.match(install, /\$Roots = \$env:USERPROFILE/);
  assert.match(install, /Copy-Item -LiteralPath \$devspaceConfig -Destination \$backup/);
  assert.doesNotMatch(install, /Remove-Item[^\n]*\bAgent\b|Stop-ScheduledTask|Set-ExecutionPolicy|-ExecutionPolicy Bypass/i);
  assert.match(install, /DevSpace dist\/cli\.js is absent after installing/);
  assert.match(install, /organization-managed security restriction/);
  assert.match(install, /NewGuid\(\)/);
});

test('standalone Router is Mac independent, identity pinned, loopback only', async () => {
  const router = await read('runtime/start-router.ps1');
  assert.match(router, /CODASSOL_LISTEN_PORT = '17678'/);
  assert.match(router, /CODASSOL_LISTEN_HOST = '127\.0\.0\.1'/);
  assert.match(router, /CODASSOL_STATE_DIR/);
  assert.match(router, /device-id\.txt/);
  assert.match(router, /CODASSOL_LOCAL_ROOTS/);
  assert.doesNotMatch(router, /ngrok|RemoteRouter|MacAddress/);
});

test('supervisor uses published CLI, monitors backend health, and does not evade endpoint protection', async () => {
  const supervisor = await read('runtime/start-devspace.ps1');
  assert.match(supervisor, /dist\\cli\.js/);
  assert.match(supervisor, /Invoke-RestMethod/);
  assert.match(supervisor, /while \(\$true\)/);
  assert.match(supervisor, /Missing Node or DevSpace CLI/);
  assert.doesNotMatch(supervisor, /\\\.bin\\devspace\.cmd|Stop-Service|Set-MpPreference|Add-MpPreference/);
});

test('cleanup is opt-in and preserves disabled task definitions and directories', async () => {
  const cleanup = await read('cleanup-old.ps1');
  const install = await read('install.ps1');
  assert.match(cleanup, /LegacyBackup-/);
  assert.match(cleanup, /Export-ScheduledTask/);
  assert.match(cleanup, /Disable-ScheduledTask/);
  assert.match(cleanup, /backendReachable/);
  assert.match(cleanup, /info\.id -ne \$id/);
  assert.doesNotMatch(cleanup, /Remove-Item|Set-ExecutionPolicy|Add-MpPreference/);
  assert.doesNotMatch(install, /cleanup-old\.ps1/);
});

test('packaging verifies private Node against upstream checksum and does not embed secrets', async () => {
  const packager = await readFile('scripts/package-windows-standalone-node.sh', 'utf8');
  const readme = await read('README-WINDOWS.txt');
  const verify = await read('verify.ps1');
  assert.match(packager, /SHASUMS256\.txt/);
  assert.match(packager, /expected.*actual/);
  assert.match(packager, /scripts\/windows\/standalone/);
  assert.match(packager, /\.sha256/);
  assert.match(verify, /_codassol\/peer\/info/);
  assert.match(verify, /backendReachable/);
  assert.match(readme, /NOT accessible from other PCs/);
  assert.match(readme, /until independently authorized HTTPS ingress is configured/i);
  assert.doesNotMatch(packager, /ngrok-free\.dev|github_pat_|ghp_/);
});
