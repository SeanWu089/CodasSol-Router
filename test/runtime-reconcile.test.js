import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentHub } from "../src/agent-hub.js";
import { DeviceRegistry } from "../src/device-registry.js";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";
import { AGENT_SSE_PRESENCE_TTL_MS } from "../src/agent-timing.js";

test("expired jobs cannot replay and active consumers cannot be replaced", async () => {
 const hub = new AgentHub();
 await Promise.all([assert.rejects(hub.enqueue("phone", {}, {timeoutMs:5}), {code:"AGENT_JOB_TIMEOUT"}), new Promise(r=>setTimeout(r,20))]);
 const jobs=[]; const stop=hub.subscribe("phone", j=>{jobs.push(j);return true;});
 await Promise.resolve(); assert.equal(jobs.length,0);
 assert.throws(()=>hub.subscribe("phone",()=>true),{code:"AGENT_CONSUMER_ACTIVE"});
 await assert.rejects(hub.poll("phone"),{code:"AGENT_CONSUMER_ACTIVE"});
 const pending=hub.enqueue("phone",{operation:"info"});
 assert.equal(jobs.length,1);
 assert.equal(hub.complete("wrong-phone",jobs[0].id,{}),false);
 assert.equal(hub.complete("phone",jobs[0].id,{ok:true}),true);
 assert.deepEqual(await pending,{ok:true});stop();
});

test("SSE TTL is scoped and disconnection never fabricates a heartbeat",()=>{
 let now=0;const d=new DeviceRegistry({clock:()=>now});
 d.register({id:"sse",heartbeatTtlMs:AGENT_SSE_PRESENCE_TTL_MS});d.register({id:"legacy"});
 now=16*60_000;assert.equal(d.get("sse").online,true);assert.equal(d.get("legacy").online,false);
 d.setHeartbeatTtl("sse",30_000);assert.equal(d.get("sse").lastSeenAt,0);assert.equal(d.get("sse").online,false);
});

test("authenticated phone SSE round-trip preserves device identity and task affinity", async(t)=>{
 const stateDir=await mkdtemp(path.join(tmpdir(),"codas-phone-protocol-"));
 const config={stateDir,localDeviceId:"local",localRoots:["/tmp"],backendHost:"127.0.0.1",backendPort:1};
 const runtime=await createRouterRuntime(config);const server=createRouterServer(config,runtime);
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 t.after(async()=>{runtime.agentHub.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(stateDir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}/_codassol/agent`;
 const post=async(route,token,body)=>fetch(base+route,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});
 await runtime.catalog.observe({id:"retained",kind:"router",installationId:"retained-installation",platform:"win32",defaultName:"Retained"});
 assert.equal((await post("/enroll",runtime.privateState.pairingToken,{id:"retained",installationId:"wrong"})).status,409);
 assert.equal((await post("/enroll",runtime.privateState.pairingToken,{id:"retained",installationId:"retained-installation"})).status,201);
 const enrolled=await post("/enroll",runtime.privateState.pairingToken,{id:"phone-test",platform:"android",roots:["/codas/android"],capabilities:["devspace-http"]});
 assert.equal(enrolled.status,201);const {agentToken}=await enrolled.json();
 assert.equal((await fetch(base+"/events")).status,401);
 const stream=await fetch(base+"/events",{headers:{authorization:`Bearer ${agentToken}`}});
 assert.equal(stream.status,200);const reader=stream.body.getReader();const decoder=new TextDecoder();
 assert.match(decoder.decode((await reader.read()).value),/event: ready/);
 assert.equal((await fetch(base+"/events",{headers:{authorization:`Bearer ${agentToken}`}})).status,409);
 assert.equal((await post("/poll",agentToken,{})).status,409);
 const pending=runtime.agentHub.enqueue("phone-test",{type:"devspace-http",request:{path:"/mcp"}},{timeoutMs:2000});
 const event=decoder.decode((await reader.read()).value);
 const {job}=JSON.parse(event.split("data: ")[1].trim());
 assert.ok(job.expiresAt>Date.now());
 assert.equal((await post("/result",agentToken,{jobId:job.id,ok:true,result:{phone:"verified"}})).status,200);
 assert.deepEqual(await pending,{phone:"verified"});
 await reader.cancel();
});


test("leased phone HTTP handshake and heartbeat are bound to one stream", async(t)=>{
 const stateDir=await mkdtemp(path.join(tmpdir(),"codas-phone-lease-"));
 const config={stateDir,localDeviceId:"local",localRoots:["/tmp"],backendHost:"127.0.0.1",backendPort:1};
 const runtime=await createRouterRuntime(config);const server=createRouterServer(config,runtime);
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 t.after(async()=>{runtime.agentHub.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(stateDir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}/_codassol/agent`;
 const post=(route,token,body)=>fetch(base+route,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});
 const enrolled=await post("/enroll",runtime.privateState.pairingToken,{id:"lease-phone",platform:"android",roots:["/codas/android"]});
 const {agentToken}=await enrolled.json();
 const stream=await fetch(base+"/events",{headers:{authorization:`Bearer ${agentToken}`,"x-codas-stream-lease":"1"}});
 const reader=stream.body.getReader();const event=new TextDecoder().decode((await reader.read()).value);
 const ready=JSON.parse(event.split("data: ")[1].trim());
 assert.equal(ready.leaseMs,90_000);assert.equal(ready.heartbeatIntervalMs,20_000);assert.ok(ready.serverTime<=Date.now());
 assert.equal((await post("/heartbeat",agentToken,{streamId:"wrong"})).status,409);
 assert.equal((await post("/heartbeat",agentToken,{streamId:ready.streamId})).status,200);
 assert.equal(runtime.devices.get("lease-phone").heartbeatTtlMs,90_000);
 await reader.cancel();
});
