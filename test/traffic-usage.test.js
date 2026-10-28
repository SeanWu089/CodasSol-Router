import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TrafficUsage } from '../src/traffic-usage.js';

test('HTTPS counters count streamed UTF-8 payloads, exclude local probes, persist across restart', async () => {
 const dir = mkdtempSync(path.join(tmpdir(), 'codassol-usage-'));
 const usage = new TrafficUsage({ stateDir: dir });
 const server = http.createServer(async (req,res) => {
   usage.track(req,res);
   // Delayed body consumer must not lose data to the meter.
   await new Promise(r=>setTimeout(r,15));
   let body=''; for await (const chunk of req) body += chunk;
   assert.equal(body,'你好');
   res.write('data: 一\n\n'); res.end('done');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/mcp`;
 try {
   await (await fetch(url,{method:'POST',body:'你好',headers:{'x-forwarded-proto':'https'}})).text();
   const counted=usage.snapshot();
   assert.equal(counted.httpsRequests,1);
   assert.equal(counted.receivedBytes,6);
   assert.equal(counted.sentBytes,Buffer.byteLength('data: 一\n\ndone'));
   await (await fetch(url,{method:'POST',body:'你好'})).text();
   assert.equal(usage.snapshot().httpsRequests,1);
   usage.close();
   const restored = new TrafficUsage({stateDir:dir});
   assert.deepEqual(restored.snapshot().httpsRequests,1);
   assert.equal(restored.snapshot().receivedBytes,6);
   assert.equal(restored.snapshot().since,counted.since);
   restored.close();
 } finally { usage.close(); await new Promise(r=>server.close(r)); rmSync(dir,{recursive:true}); }
});

test('usage endpoint is admin-only and rejects public forwarding, without counting its own polls', async () => {
 const { handleUsageRoute } = await import('../src/traffic-usage.js');
 const usage = new TrafficUsage({persist:false});
 const runtime={privateState:{verifyAdminToken:token=>token==='owner-only'}};
 const server=http.createServer((req,res)=> {
   if(handleUsageRoute(req,res,runtime,usage)) return;
   usage.track(req,res); res.end('ok');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/_codassol/usage`;
 try {
   assert.equal((await fetch(url)).status,403);
   assert.equal((await fetch(url,{headers:{authorization:'Bearer owner-only','x-forwarded-proto':'https'}})).status,403);
   const reply=await fetch(url,{headers:{authorization:'Bearer owner-only'}});
   assert.equal(reply.status,200);
   assert.equal((await reply.json()).httpsRequests,0);
 } finally { usage.close(); await new Promise(r=>server.close(r)); }
});


test('migrates old totals to historical, preserves counts, bounds logs and omits secrets', async () => {
 const { EventEmitter } = await import('node:events');
 const dir=mkdtempSync(path.join(tmpdir(),'codassol-categories-'));
 writeFileSync(path.join(dir,'traffic-usage.json'),JSON.stringify({version:1,since:1000,httpsRequests:51,receivedBytes:100,sentBytes:200}));
 const usage=new TrafficUsage({stateDir:dir});
 try {
  assert.equal(usage.snapshot().categories.find(c=>c.id==='historical').requests,51);
  for(let i=0;i<105;i++) {
   const req={socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-proto':'https',authorization:'secret-credential'},url:i%2 ? '/mcp?token=secret-credential' : '/_codassol/health',method:'POST',readableLength:0,push:()=>true};
   const res=Object.assign(new EventEmitter(),{write:()=>true,end:()=>{},headersSent:true,statusCode:200});
   usage.track(req,res);req.push(Buffer.from('private-body'));res.write('private-result');res.emit('finish');
  }
  const snap=usage.snapshot();
  assert.equal(snap.httpsRequests,156);
  assert.equal(snap.categories.reduce((a,c)=>a+c.requests,0),snap.httpsRequests);
  assert.equal(snap.categories.reduce((a,c)=>a+c.receivedBytes,0),snap.receivedBytes);
  assert.equal(snap.categories.reduce((a,c)=>a+c.sentBytes,0),snap.sentBytes);
  assert.equal(snap.recentRequests.length,100);
  assert.equal(snap.recentRequests[0].outcome,'complete');
  assert.equal(snap.recentRequests[0].statusCode,200);
  const serialized=JSON.stringify(snap);
  for(const secret of ['secret-credential','private-body','private-result','token=','authorization']) assert(!serialized.includes(secret));
  usage.close();
  const restored=new TrafficUsage({stateDir:dir});
  assert.equal(restored.snapshot().httpsRequests,156);
  assert.equal(restored.snapshot().categories.find(c=>c.id==='historical').requests,51);
  assert.equal(restored.snapshot().recentRequests.length,100);
  restored.close();
 } finally { usage.close();rmSync(dir,{recursive:true}); }
});

test('classifies system requests without recording variable paths or query data', async () => {
 const {requestCategory}=await import('../src/traffic-usage.js');
 const cases={mcp:'/mcp',heartbeat:'/_codassol/agent/heartbeat',device_stream:'/_codassol/agent/events',device_poll:'/_codassol/agent/poll',device_results:'/_codassol/agent/result',health:'/_codassol/health',discovery:'/_codassol/devices/a-private-id',peer_sync:'/_codassol/peer/info',enrollment:'/_codassol/agent/enroll',other:'/unrecognized-private-path'};
 for(const [category,url] of Object.entries(cases)) assert.equal(requestCategory({url:url+'?credential=private'}),category);
});
