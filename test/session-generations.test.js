import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { reserveSessionRange, installSessionRange } from '../scripts/windows/standalone/runtime/session-generations.mjs';
test('backend generations reject old handles even when workspace survives', () => {
 const dir=mkdtempSync(path.join(os.tmpdir(),'codassol-epochs-'));
 try {
  class Manager { nextSessionId=1; sessions=new Map(); createSession(input){return {id:this.nextSessionId++,workspaceId:input.workspaceId};} start(input){const s=this.createSession(input);this.sessions.set(s.id,s);return s.id;} write(id,workspace){const s=this.sessions.get(id);if(!s||s.workspaceId!==workspace)throw Error('Unknown session');return s.id;} }
  const first=reserveSessionRange(dir);installSessionRange(Manager,first);
  const old=new Manager().start({workspaceId:'persistent'});
  class Restarted {nextSessionId=1;createSession(input){return {id:this.nextSessionId++,workspaceId:input.workspaceId};}}
  const second=reserveSessionRange(dir);installSessionRange(Restarted,second);
  const newer=new Restarted().createSession({workspaceId:'persistent'});
  assert.notEqual(newer.id,old);assert.ok(old>=2**32);assert.ok(newer.id>=first.end);
  const manager=new Manager();assert.throws(()=>manager.write(old,'persistent'),/Unknown/);
  const a=manager.start({workspaceId:'a'});const b=new Manager().start({workspaceId:'b'});assert.notEqual(a,b);
  assert.throws(()=>manager.write(a,'b'),/Unknown/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('corrupt, exhausted and locked generation state fail closed',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'codassol-epochs-'));
 try {
  reserveSessionRange(dir);
  mkdirSync(path.join(dir,'session-generation.lock'));
  assert.throws(()=>reserveSessionRange(dir),/EEXIST/);
  rmSync(path.join(dir,'session-generation.lock'),{recursive:true});
  rmSync(path.join(dir,'session-generation.json'));
  assert.throws(()=>reserveSessionRange(dir),/EEXIST/);
  writeFileSync(path.join(dir,'session-generation.json'),'bad');
  assert.throws(()=>reserveSessionRange(dir));
  writeFileSync(path.join(dir,'session-generation.json'),JSON.stringify({version:1,next:Number.MAX_SAFE_INTEGER}));
  assert.throws(()=>reserveSessionRange(dir),/exhaust/);
  class Manager{createSession(){return {id:this.nextSessionId++};}}
  installSessionRange(Manager,{start:10,end:11});
  assert.equal(new Manager().createSession({}).id,10);
  assert.throws(()=>new Manager().createSession({}),/exhaust/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('separate processes reserve disjoint ranges; contention never falls back',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'codassol-concurrent-'));
 try{
  const url=new URL('../scripts/windows/standalone/runtime/session-generations.mjs',import.meta.url).href;
  const script=`import {reserveSessionRange} from ${JSON.stringify(url)};console.log(JSON.stringify(reserveSessionRange(process.argv[1])));`;
  const outcomes=await Promise.allSettled(Array.from({length:8},()=>promisify(execFile)(process.execPath,['--input-type=module','-e',script,dir])));
  const ranges=outcomes.filter(x=>x.status==='fulfilled').map(x=>JSON.parse(x.value.stdout));
  assert.ok(ranges.length>0);
  assert.equal(new Set(ranges.map(x=>x.start)).size,ranges.length);
  for(const x of outcomes.filter(x=>x.status==='rejected'))assert.match(x.reason.stderr,/EEXIST/);
  const latest=reserveSessionRange(dir);assert.ok(ranges.every(x=>x.end<=latest.start));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
