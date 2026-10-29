import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
export function ingress(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('Use your explicitly selected HTTPS Router origin without credentials, path, query or fragment.');
  return url.origin;
}
export function validate(config, id, installationId) {
  if (config.device?.id !== id || config.device?.installationId !== installationId || config.devspace?.baseUrl !== 'http://127.0.0.1:7676')
    throw Error('Existing outbound identity mismatch; credentials were preserved.');
  ingress(config.routerUrl);
}
export async function main(mode, options = {}) {
  const root = options.root || path.resolve(import.meta.dirname, '..');
  const state = options.state || path.join(root, 'state');
  const { AgentConfigStore } = await import(pathToFileURL(path.join(root, 'app', 'agent-config.js')));
  const { enrollAgent, runAgent } = await import(pathToFileURL(path.join(root, 'app', 'agent.js')));
  const id = fs.readFileSync(path.join(state, 'device-id.txt'), 'utf8').trim();
  const router = JSON.parse(fs.readFileSync(path.join(state, 'router.json'), 'utf8'));
  if (!router.installationId || !/^device-[0-9a-f-]{36}$/i.test(id)) throw Error('Local Router identity missing.');
  const store = new AgentConfigStore(path.join(state, 'outbound-agent.json'));
  if (mode === 'enroll') {
    if (fs.existsSync(store.filePath)) {
      validate(await store.load(), id, router.installationId);
      console.log('Existing authorized registration preserved.'); return;
    }
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input); input = '';
    const url = ingress(request.routerUrl);
    if (typeof request.pairingToken !== 'string' || request.pairingToken.trim().length < 32) throw Error('Pairing token required.');
    const roots = fs.readFileSync(path.join(state, 'roots.txt'), 'utf8').trim().split('|');
    const config = await enrollAgent({routerUrl:url, pairingToken:request.pairingToken.trim(), deviceId:id,
      installationId:router.installationId, label:os.hostname(), roots, configStore:store});
    request.pairingToken = ''; config.device.installationId = router.installationId;
    await store.save(config); console.log('REGISTERED: remote Router accepted this device.');
  } else if (mode === 'run') {
    validate(await store.load(), id, router.installationId);
    await runAgent({configStore:store, transport:'sse'});
  } else if (mode === 'verify') {
    const config = await store.load(); validate(config, id, router.installationId);
    const response = await fetch(`${config.routerUrl}/_codassol/agent/heartbeat`, {
      method:'POST', headers:{authorization:`Bearer ${config.agentToken}`, 'content-type':'application/json'},
      body:JSON.stringify({roots:config.device.roots, capabilities:config.device.capabilities}), signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw Error(`Registration verification rejected: HTTP ${response.status}`);
    console.log('PASS: remote Router acknowledged authenticated registration (execution still requires a remote tool test).');
  } else throw Error('Use enroll, run or verify.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = error.code === 'SSE_UNAVAILABLE' || [401,403,409].includes(error.status) ? 78 : 1; });
}
