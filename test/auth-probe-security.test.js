import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRouterServer} from '../src/server.js';
for(const backendStatus of [200,400,401,403,429,500,503]){
 test(`remote MCP dispatch requires successful auth probe: ${backendStatus}`,async()=>{
  const stateDir=await mkdtemp(join(tmpdir(),'codas-auth-regression-'));
  const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
  const close=s=>new Promise(r=>s.close(r));
  const backend=http.createServer((req,res)=>{assert.equal(req.headers['mcp-protocol-version'],'2025-03-26');let body='';req.on('data',c=>body+=c);req.on('end',()=>{assert.equal(JSON.parse(body).method,'ping');res.writeHead(backendStatus,{'content-type':'application/json'});res.end('{}');});});await listen(backend);
  let dispatched=0;
  const runtime={localDeviceId:'local',peerMesh:{recoverBindings:async()=>{},peers:new Map()},routing:{resolveWorkspace:()=>({device:{id:'mock-remote'}})},agentHub:{enqueue:async()=>{dispatched++;return {statusCode:200,headers:{'content-type':'application/json'},bodyBase64:'e30='};}}};
  const router=createRouterServer({backendHost:'127.0.0.1',backendPort:backend.address().port,backendTimeoutMs:1000,stateDir},runtime);await listen(router);
  try{
   const r=await fetch(`http://127.0.0.1:${router.address().port}/mcp`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture-token','mcp-protocol-version':'2026-03-26'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'exec_command',arguments:{workspace_id:'fixture',cmd:'not-executed'}}})});await r.text();
   assert.equal(dispatched,backendStatus===200?1:0);assert.equal(r.status,backendStatus===200?200:[401,403].includes(backendStatus)?401:502);
  }finally{await close(router);await close(backend);await rm(stateDir,{recursive:true,force:true});}
 });
}
