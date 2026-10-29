import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'devspace-config');
if (process.env.DEVSPACE_CONFIG_DIR !== dir) throw Error('CONFIG_ISOLATION_REQUIRED');
const mod = await import(pathToFileURL(path.join(root,'devspace','node_modules','@waishnav','devspace','dist','user-config.js')));
const rootsFile=path.join(root,'state','roots.txt');
const roots=fs.readFileSync(rootsFile,'utf8').trim().split('|');
if (!roots.length || roots.some(r=>!path.isAbsolute(r)||!fs.existsSync(r))) throw Error('EXPLICIT_EXISTING_ROOTS_REQUIRED');
mod.setDevspaceConfigValues([
 {path:['workspaces','allowedRoots'],value:roots},
 {path:['workspaces','worktreeRoot'],value:path.join(root,'worktrees')},
 {path:['storage','stateDir'],value:path.join(root,'devspace-state')},
 {path:['skills','paths'],value:[]},
 {path:['skills','agentDir'],value:path.join(root,'agents')},
 {path:['server','host'],value:'127.0.0.1'},
 {path:['server','port'],value:7676}
],process.env);
const cfg=mod.loadDevspaceFiles(process.env);
if (cfg.dir!==dir || cfg.config.storage.stateDir!==path.join(root,'devspace-state')) throw Error('ISOLATION_CHECK_FAILED');
console.log('PASS: new private config, authentication and storage locations selected.');
