import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
const BLOCK = 2 ** 20;
const INITIAL = 2 ** 32;
// Reserve before spawning a daemon. Never reset or silently repair this ledger.
export function reserveSessionRange(stateDir) {
 mkdirSync(stateDir,{recursive:true});
 const lock=path.join(stateDir,'session-generation.lock');
 mkdirSync(lock); // An abandoned lock deliberately requires operator review.
 try {
  const file=path.join(stateDir,'session-generation.json');
  let next=INITIAL;
  try {
   const state=JSON.parse(readFileSync(file,'utf8'));
   if(state.version!==1 || !Number.isSafeInteger(state.next) || state.next<INITIAL)throw Error('Invalid session generation ledger');
   next=state.next;
  }catch(error){
   if(error.code!=='ENOENT')throw error;
   // A missing ledger after first initialization cannot safely be recreated.
   const marker=openSync(path.join(stateDir,'session-generation.initialized'),'wx',0o600);
   try{writeFileSync(marker,'1');fsyncSync(marker);}finally{closeSync(marker);}
  }
  if(!Number.isSafeInteger(next+BLOCK))throw Error('Session generation space exhausted');
  const temp=file+'.pending';
  const fd=openSync(temp,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify({version:1,next:next+BLOCK}));fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temp,file);
  return {start:next,end:next+BLOCK};
 }finally{rmSync(lock,{recursive:true});}
}
export function installSessionRange(Manager, range) {
 const original=Manager?.prototype?.createSession;
 if(typeof original!=='function')throw Error('Unsupported DevSpace process-session API');
 let next=range.start;
 Manager.prototype.createSession=function(input){
  if(next>=range.end)throw Error('Session generation space exhausted; restart the supervised backend');
  const allocated=next++;
  this.nextSessionId=allocated;
  const session=original.call(this,input);
  if(session?.id!==allocated || this.nextSessionId!==allocated+1)throw Error('Unsupported DevSpace session allocation contract');
  return session;
 };
}
