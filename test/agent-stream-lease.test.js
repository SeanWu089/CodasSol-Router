import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentHub } from '../src/agent-hub.js';

test('leased stale SSE releases its consumer; old acknowledgements cannot renew its replacement', async () => {
  let now = 0; const hub = new AgentHub({ clock: () => now }); let closed = 0;
  const stop = hub.subscribe('phone', () => true, () => closed++, { leaseMs: 90 });
  assert.ok(stop.streamId);
  assert.throws(() => hub.subscribe('phone', () => true), { code: 'AGENT_CONSUMER_ACTIVE' });
  now = 60; assert.equal(hub.renewStream('phone', stop.streamId), true);
  now = 120; assert.equal(hub.expireStream('phone'), false);
  assert.equal(hub.renewStream('other', stop.streamId), false);
  now = 151; assert.equal(hub.expireStream('phone'), true); assert.equal(closed, 1);
  const fresh = hub.subscribe('phone', () => true, () => closed++, { leaseMs: 90 });
  assert.equal(hub.renewStream('phone', stop.streamId), false);
  stop(); assert.throws(() => hub.subscribe('phone', () => true), { code: 'AGENT_CONSUMER_ACTIVE' });
  now = 242;
  const next = hub.subscribe('phone', () => true, () => closed++, { leaseMs: 90 });
  assert.equal(closed, 2); fresh(); next();
});

test('legacy stream remains exclusive without opting in to leases', () => {
  let now = 0; const hub = new AgentHub({ clock: () => now });
  const stop = hub.subscribe('legacy', () => true);
  now = 1e9; assert.equal(hub.expireStream('legacy'), false);
  assert.equal(hub.renewStream('legacy', stop.streamId), false);
  assert.throws(() => hub.subscribe('legacy', () => true), { code: 'AGENT_CONSUMER_ACTIVE' }); stop();
});

test('exact leased stream replacement recovers a dead downstream despite recent heartbeat', () => {
  const hub = new AgentHub(); let closed = 0;
  const old = hub.subscribe('phone', () => true, () => closed++, { leaseMs: 90_000 });
  assert.equal(hub.renewStream('phone', old.streamId), true);
  assert.throws(() => hub.subscribe('phone', () => true, () => {}, { leaseMs: 90_000, previousStreamId: 'wrong' }), { code: 'AGENT_CONSUMER_ACTIVE' });
  const fresh = hub.subscribe('phone', () => true, () => {}, { leaseMs: 90_000, previousStreamId: old.streamId });
  assert.equal(closed, 1);
  assert.equal(hub.renewStream('phone', old.streamId), false);
  old();
  assert.throws(() => hub.subscribe('phone', () => true, () => {}, { leaseMs: 90_000, previousStreamId: old.streamId }), { code: 'AGENT_CONSUMER_ACTIVE' });
  assert.equal(hub.renewStream('phone', fresh.streamId), true);
  const legacy = hub.subscribe('legacy', () => true);
  assert.throws(() => hub.subscribe('legacy', () => true, () => {}, { leaseMs: 90_000, previousStreamId: legacy.streamId }), { code: 'AGENT_CONSUMER_ACTIVE' });
});
