import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentConfigStore } from './app/agent-config.js';
import { enrollAgent, runAgent } from './app/agent.js';
const state=path.join(process.env.USERPROFILE,'.codassol-node-v02');
const router=JSON.parse(fs.readFileSync(path.join(state,'router.json'),'utf8'));
const routerId=fs.readFileSync(path.join(state,'device-id.txt'),'utf8').trim();
if(!routerId || !router.installationId)throw Error('Independent Router identity missing');
const origin=new URL(JSON.parse(fs.readFileSync(new URL('./target.json',import.meta.url),'utf8')).ingressUrl);
if(origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash || origin.hostname.endsWith('.ts.net'))throw Error('A non-Tailscale public HTTPS ingress is required');
const store=new AgentConfigStore(path.join(state,'outbound-agent.json'));
const local=await fetch('http://127.0.0.1:7676/healthz',{signal:AbortSignal.timeout(5000)});
const h=await local.json();
if(!local.ok || !h.ok || h.name!=='devspace')throw Error('Local DevSpace is unavailable');
if(process.argv.includes('--enroll')){
 if(fs.existsSync(store.filePath))throw Error('Outbound config already exists; use Start-Bridge.ps1 to resume');
 let token='';for await(const chunk of process.stdin)token+=chunk;
 token=token.trim();if(token.length<32)throw Error('Pairing token is missing');
 const config=await enrollAgent({routerUrl:origin.origin,pairingToken:token,
  deviceId:routerId,installationId:router.installationId,label:'Windows outbound',
  roots:[path.join(process.env.USERPROFILE,'Desktop')],devspaceBaseUrl:'http://127.0.0.1:7676',configStore:store});
 token='';
 config.device.installationId=router.installationId;await store.save(config);
 const peers=path.join(state,'peers.json');
 if(fs.existsSync(peers)){
  const previous=JSON.parse(fs.readFileSync(peers,'utf8'));
  const keep=previous.filter(p=>!new URL(p.url).hostname.endsWith('.ts.net'));
  if(keep.length!==previous.length){
   fs.copyFileSync(peers,peers+'.before-outbound-'+Date.now(),fs.constants.COPYFILE_EXCL);
   const temp=peers+'.outbound-pending';fs.writeFileSync(temp,JSON.stringify(keep,null,2),{flag:'wx',mode:0o600});fs.renameSync(temp,peers);
   fs.writeFileSync(path.join(state,'outbound-router-reload-required'),'1',{mode:0o600});
  }
 }
 console.log('ENROLLED: independent Router unchanged; Desktop-only outbound channel configured.');
}else{
 const config=await store.load();
 if(config.device.id!==routerId || config.device.installationId!==router.installationId || config.routerUrl!==origin.origin || config.devspace.baseUrl!=='http://127.0.0.1:7676' || config.device.roots.length!==1 || config.device.roots[0]!==path.join(process.env.USERPROFILE,'Desktop'))throw Error('Outbound configuration identity or roots mismatch');
 console.log('Connecting through public HTTPS/SSE. Keep this terminal open. No VPN path is used by this channel.');
 await runAgent({configStore:store,transport:'sse'});
}
