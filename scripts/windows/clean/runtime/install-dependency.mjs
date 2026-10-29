import path from 'node:path';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
// Bound this specific npm child. Do not scan or terminate unrelated Node processes.
const child=spawn(process.execPath,[path.join(root,'node','node_modules','npm','bin','npm-cli.js'),'install','--prefix',path.join(root,'devspace'),'--no-audit','--no-fund','--registry=https://registry.npmjs.org','--fetch-retries=1','--fetch-timeout=60000','@waishnav/devspace@1.1.0-beta.4'],{cwd:root,stdio:'inherit',windowsHide:true});
const progress=setInterval(()=>console.log('[dependencies] installing pinned DevSpace; maximum 600 seconds'),10000);
const timeout=setTimeout(()=>{console.error('DEPENDENCY_TIMEOUT: stopping this npm child only. Possible install-script children are preserved; no service tasks will be created.');child.kill();process.exitCode=1;},600000);
child.on('error',()=>{clearInterval(progress);clearTimeout(timeout);process.exitCode=1;});
child.on('exit',code=>{clearInterval(progress);clearTimeout(timeout);process.exitCode=process.exitCode||(code===0?0:1);});
