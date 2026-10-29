import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ingress, validate } from '../scripts/windows/standalone/runtime/enrollment.mjs';
test('enrollment accepts explicit HTTPS origins for Cloudflare or legacy ngrok', () => {
  assert.equal(ingress('https://sample.ngrok-free.dev/'), 'https://sample.ngrok-free.dev');
  assert.equal(ingress('https://router.example.com/'), 'https://router.example.com');
  for (const value of ['http://sample.ngrok-free.dev', 'https://a:b@sample.ngrok-free.dev', 'https://sample.ngrok-free.dev/path', 'https://sample.ngrok-free.dev?token=secret']) assert.throws(() => ingress(value));
});
test('resuming fails closed on identity changes and preserves valid credentials', () => {
  const config = {device:{id:'device-a',installationId:'installation-a'},routerUrl:'https://sample.ngrok-free.dev',devspace:{baseUrl:'http://127.0.0.1:7676'}};
  validate(config, 'device-a', 'installation-a');
  assert.throws(() => validate(config, 'device-b', 'installation-a'));
  assert.throws(() => validate(config, 'device-a', 'installation-b'));
  assert.equal(config.device.id, 'device-a');
});
test('default installation verifies remote authorization and tasks run Node directly', async () => {
  const installer = await readFile('scripts/windows/standalone/install.ps1', 'utf8');
  for (const name of ['devspaceAction','routerAction','outboundAction']) assert.match(installer, new RegExp('\\$'+name+' = New-ScheduledTaskAction -Execute \\$node'));
  assert.match(installer, /if \(-not \$LocalOnly\)/);
  assert.match(installer, /\$enrollment verify/);
  assert.match(installer, /Read-Host 'Router pairing token \(hidden\)' -AsSecureString/);
  const packager = await readFile('scripts/package-windows-standalone-node.sh', 'utf8');
  assert.match(packager, /runtime\/.*mjs/);
});

test('existing installation resumes without reenrollment and verifies an authenticated remote acknowledgement', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os'); const path = await import('node:path');
  const { main } = await import('../scripts/windows/standalone/runtime/enrollment.mjs');
  const state = await mkdtemp(path.join(os.tmpdir(), 'codassol-onboarding-test-'));
  const root = path.resolve('.');
  // Staged application files sit under app in production.
  const stage = await mkdtemp(path.join(os.tmpdir(), 'codassol-app-test-'));
  const { symlink } = await import('node:fs/promises');
  await symlink(path.join(root, 'src'), path.join(stage, 'app'));
  const originalFetch = globalThis.fetch;
  try {
    const config = {version:1, device:{id:'device-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',installationId:'installation-a',roots:['C:/Users/test'],capabilities:['devspace-http']},routerUrl:'https://sample.ngrok-free.dev',agentToken:'test-only-credential',devspace:{baseUrl:'http://127.0.0.1:7676'}};
    await writeFile(path.join(state,'device-id.txt'), config.device.id);
    await writeFile(path.join(state,'router.json'), JSON.stringify({installationId:'installation-a'}));
    await writeFile(path.join(state,'outbound-agent.json'), JSON.stringify(config));
    globalThis.fetch = () => { throw Error('Resume must not reenroll'); };
    await main('enroll',{root:stage,state});
    let requests = 0;
    globalThis.fetch = async (url, options) => {
      requests++; assert.equal(url, 'https://sample.ngrok-free.dev/_codassol/agent/heartbeat');
      assert.equal(options.headers.authorization, 'Bearer test-only-credential');
      return new Response('{"ok":true}', {status:200});
    };
    await main('verify',{root:stage,state}); assert.equal(requests,1);
    globalThis.fetch = async () => new Response('{}', {status:403});
    await assert.rejects(main('verify',{root:stage,state}), /HTTP 403/);
  } finally { globalThis.fetch = originalFetch; await rm(state,{recursive:true,force:true}); await rm(stage,{recursive:true,force:true}); }
});
