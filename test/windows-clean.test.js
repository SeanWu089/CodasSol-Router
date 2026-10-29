import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {DevSpaceLocalOAuth} from '../src/devspace-local-auth.js';
test('clean auth override never falls back to previous shared owner credentials',async()=>{
 const previous=process.env.CODASSOL_DEVSPACE_AUTH_FILE;
 try{
  process.env.CODASSOL_DEVSPACE_AUTH_FILE=path.join(os.tmpdir(),'codas-nonexistent-clean-auth','auth.json');
  const client=new DevSpaceLocalOAuth();
  assert.equal(client.ownerTokenPath,process.env.CODASSOL_DEVSPACE_AUTH_FILE);
  const {readFile}=await import('node:fs/promises');
  await assert.rejects(readFile(client.ownerTokenPath),{code:'ENOENT'});
  delete process.env.CODASSOL_DEVSPACE_AUTH_FILE;
  assert.equal(new DevSpaceLocalOAuth().ownerTokenPath,path.join(os.homedir(),'.devspace','auth.json'));
 }finally{if(previous===undefined)delete process.env.CODASSOL_DEVSPACE_AUTH_FILE;else process.env.CODASSOL_DEVSPACE_AUTH_FILE=previous;}
});
