import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PeerMesh } from '../src/peer-mesh.js';
import { DeviceRegistry } from '../src/device-registry.js';
import { createRouterRuntime } from '../src/runtime.js';
import { startRouter } from '../src/server.js';
import { deviceSnapshot } from '../src/mcp-device-tools.js';

const peer = { id: 'windows', url: 'https://private.example.test', token: 'secret-'.repeat(8), platform: 'win32', roots: ['C:\\Projects'], installationId: 'installation-windows' };
const info = { id: peer.id, protocol: 2, installationId: peer.installationId, platform: 'win32', roots: peer.roots, backendReachable: true };
function mesh(fetchFn) {
  return new PeerMesh({ runtime: { localDeviceId: 'mac', devices: new DeviceRegistry(), catalog: { observe: async () => {}, get: () => null } }, peers: [peer], fetchFn });
}

test('product transport refuses Tailscale peer endpoints before registering a route', () => {
  const runtime = { localDeviceId: 'mac', devices: new DeviceRegistry() };
  assert.throws(() => new PeerMesh({ runtime, peers: [{ ...peer, url: 'https://windows.example.ts.net' }] }), /does not permit Tailscale/);
  assert.equal(runtime.devices.get('windows'), null);
});

test('outbound-only mode never loads or probes legacy peer configuration', async () => {
  let requests = 0;
  const runtime = { localDeviceId: 'mac', devices: new DeviceRegistry() };
  const m = await PeerMesh.load(runtime, { outboundOnly: true, peersFile: '/unreadable/legacy-peers.json' }, {
    fetchFn: async () => { requests++; throw new Error('Unexpected HTTP request'); }
  });
  m.start();
  await m.refresh();
  assert.equal(m.peers.size, 0);
  assert.equal(m.timer, null);
  assert.equal(requests, 0);
});

test('peer failure diagnostics distinguish causes, remain fail-closed and exclude raw secrets', async (t) => {
  const cases = [
    ['DNS_FAILED', () => { throw Object.assign(new Error(peer.token), { cause: { code: 'ENOTFOUND' } }); }],
    ['TIMEOUT', () => { throw Object.assign(new Error(peer.token), { code: 'ABORT_ERR' }); }],
    ['TLS_FAILED', () => { throw Object.assign(new Error(peer.token), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }); }],
    ['CONNECTION_REFUSED', () => { throw Object.assign(new Error(peer.token), { code: 'ECONNREFUSED' }); }],
    ['CONNECTION_LOST', () => { throw Object.assign(new Error(peer.token), { code: 'ECONNRESET' }); }],
    ['AUTH_REJECTED', () => new Response(peer.token, { status: 401 })],
    ['HTTP_ERROR', () => new Response(peer.token, { status: 503 })],
    ['INVALID_RESPONSE', () => new Response(peer.token)],
    ['PROTOCOL_MISMATCH', () => Response.json({ ...info, protocol: 1 })],
    ['IDENTITY_MISMATCH', () => Response.json({ ...info, id: 'wrong' })],
    ['IDENTITY_MISMATCH', () => Response.json({ ...info, installationId: 'wrong' })],
    ['UNAVAILABLE', () => { throw new Error(peer.token); }]
  ];
  for (const [code, fetchFn] of cases) await t.test(code, async () => {
    const m = mesh(fetchFn);
    await m.refresh();
    const health = m.peerHealth.get(peer.id);
    assert.equal(health.failureCode, code);
    assert.equal(health.reachable, false);
    assert.equal(m.runtime.devices.isOnline(peer.id), false);
    assert.equal(health.consecutiveFailures, 1);
    assert.ok(health.checkedAt > 0);
    assert.ok(health.durationMs >= 0);
    assert.ok(!JSON.stringify(health).includes(peer.token));
    assert.ok(!JSON.stringify(health).includes(peer.url));
  });
});

test('probe recovery clears failure counts; failed probes preserve last verified contact', async () => {
  let fail = false;
  const m = mesh(() => { if (fail) throw Object.assign(new Error('down'), { code: 'ETIMEDOUT' }); return Response.json(info); });
  await m.refresh();
  const seen = m.peerHealth.get(peer.id).lastOnlineAt;
  fail = true;
  await m.refresh(); await m.refresh();
  assert.equal(m.peerHealth.get(peer.id).lastOnlineAt, seen);
  assert.equal(m.peerHealth.get(peer.id).consecutiveFailures, 2);
  fail = false; await m.refresh();
  assert.equal(m.peerHealth.get(peer.id).failureCode, null);
  assert.equal(m.peerHealth.get(peer.id).consecutiveFailures, 0);
  assert.equal(m.runtime.devices.isOnline(peer.id), true);
});

test('authenticated device API and MCP snapshots expose only safe probe diagnostics', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codassol-diagnostics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { stateDir: dir, localDeviceId: 'mac', localDeviceLabel: 'Mac', localRoots: ['/Users/demo'], listenHost: '127.0.0.1', listenPort: 0, backendHost: '127.0.0.1', backendPort: 1, peerProbeIntervalMs: 1000 };
  const runtime = await createRouterRuntime(config);
  await runtime.catalog.observe({ id: peer.id, installationId: peer.installationId, defaultName: 'Windows', kind: 'router', platform: 'win32' });
  runtime.peerMesh = new PeerMesh({ runtime, peers: [peer], fetchFn: () => { throw Object.assign(new Error(peer.token), { code: 'ECONNREFUSED' }); } });
  const server = await startRouter(config, runtime);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/_codassol/devices`;
  assert.equal((await fetch(url)).status, 401);
  const reply = await fetch(url, { headers: { authorization: `Bearer ${runtime.privateState.adminToken}` } });
  const body = await reply.json();
  const device = body.devices.find(d => d.id === peer.id);
  assert.equal(device.status, 'offline');
  assert.equal(device.backendReachable, null);
  assert.equal(device.executionVerified, null);
  assert.equal(device.connectivity.failureCode, 'CONNECTION_REFUSED');
  assert.equal(deviceSnapshot(runtime, false).devices.find(d => d.id === peer.id).connectivity.failureCode, 'CONNECTION_REFUSED');
  assert.equal(deviceSnapshot(runtime, false).devices.find(d => d.id === peer.id).backendReachable, null);
  assert.ok(!JSON.stringify(body).includes(peer.token));
  assert.ok(!JSON.stringify(body).includes(peer.url));
});

test('backend degradation is measured separately from transport failure; catalog rejection is diagnostic', async () => {
  const m = mesh(() => Response.json({ ...info, backendReachable: false }));
  await m.refresh();
  assert.equal(m.peerHealth.get(peer.id).reachable, true);
  assert.equal(m.peerHealth.get(peer.id).backendReachable, false);
  assert.equal(m.peerHealth.get(peer.id).failureCode, null);
  assert.equal(m.peerHealth.get(peer.id).consecutiveFailures, 0);
  assert.equal(m.runtime.devices.isOnline(peer.id), false);
  m.runtime.catalog.observe = async () => { throw new Error(peer.token); };
  await m.refresh();
  assert.equal(m.peerHealth.get(peer.id).failureCode, 'CATALOG_REJECTED');
  assert.ok(!JSON.stringify(m.peerHealth.get(peer.id)).includes(peer.token));
});
