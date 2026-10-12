// Node --import adapter: preserve the published CLI and dependency files.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reserveSessionRange, installSessionRange } from './session-generations.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if(!process.env.USERPROFILE)throw Error('Windows USERPROFILE required');
const modulePath=path.join(root,'devspace','node_modules','@waishnav','devspace','dist','process-sessions.js');
const {ProcessSessionManager}=await import(pathToFileURL(modulePath).href);
const range=reserveSessionRange(path.join(process.env.USERPROFILE,'.codassol-node-v02'));
installSessionRange(ProcessSessionManager,range);
