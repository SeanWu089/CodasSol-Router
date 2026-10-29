import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireInstance, backendReady } from '../scripts/windows/standalone/runtime/single-instance.mjs';
import { consumeAgentEvents } from '../src/agent-sse.js';
test('duplicate supervisors fail closed and OS lock is reusable after close', async () => {
 const a = await acquireInstance(0); const port = a.address().port;
 try { await assert.rejects(acquireInstance(port), {code:'EADDRINUSE'}); }
 finally { await new Promise(resolve => a.close(resolve)); }
 const b = await acquireInstance(port); await new Promise(resolve => b.close(resolve));
});
test('backend presence and wrong service are not readiness', () => {
 assert.equal(backendReady({ok:true},'router'),false);
 assert.equal(backendReady({ok:true,backendReachable:false},'router'),false);
 assert.equal(backendReady({ok:true,backendReachable:true},'router'),true);
 assert.equal(backendReady({ok:true,name:'other'},'devspace'),false);
 assert.equal(backendReady({ok:true,name:'devspace'},'devspace'),true);
});
test('reconnect requests lease and only exact prior stream replacement', async () => {
 let headers;
 await assert.rejects(consumeAgentEvents({url:'https://router.example.com',token:'test-only',previousStreamId:'stream-old',onJob(){},fetchImpl:async (_,o)=>{
 headers=o.headers;return new Response('event: ready\ndata: {"streamId":"new","protocol":1}\n\n',{headers:{'content-type':'text/event-stream'}});
 }}),/stream closed/);
 assert.equal(headers['x-codas-stream-lease'],'1');
 assert.equal(headers['x-codas-previous-stream'],'stream-old');
});
test('silent handshake is aborted rather than waiting forever', async () => {
 const hold = setTimeout(()=>{},1000);
 try { await assert.rejects(consumeAgentEvents({url:'https://router.example.com',token:'test',onJob(){},idleTimeoutMs:10,
 fetchImpl:(_, {signal}) => new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}),/timeout/); }
 finally {clearTimeout(hold);}
});
