// User-scoped, PowerShell-free supervisor for Windows standalone services.
import fs from 'node:fs';
import { acquireInstance, backendReady } from './single-instance.mjs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const mode = process.argv[2];
export const root = path.resolve(import.meta.dirname, '..');
const node = path.join(root, 'node', 'node.exe');
const state = path.join(root, 'state');
const logs = path.join(root, 'logs');
process.env.DEVSPACE_CONFIG_DIR = path.join(root, 'devspace-config');
process.env.CODASSOL_DEVSPACE_AUTH_FILE = path.join(root, 'devspace-config', 'auth.json');
process.env.CODASSOL_STATE_DIR = state;
delete process.env.DEVSPACE_OAUTH_OWNER_TOKEN;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthy(url, serviceName) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const value = await response.json();
    return response.ok && backendReady(value, serviceName);
  } catch { return false; }
}

function note(name, message) {
  fs.mkdirSync(logs, { recursive: true });
  fs.appendFileSync(path.join(logs, `${name}-supervisor.log`),
    `${new Date().toISOString()} ${message}\n`);
}

function streamOutput(child, name) {
  const stream = fs.createWriteStream(path.join(logs, `${name}.log`), { flags: 'a' });
  child.stdout?.pipe(stream, { end: false });
  child.stderr?.pipe(stream, { end: false });
  child.once('close', () => stream.end());
}

export function prepare(modeName) {
  if (modeName === 'devspace') {
    const cli = path.join(root, 'devspace', 'node_modules', '@waishnav', 'devspace', 'dist', 'cli.js');
    if (!fs.existsSync(cli)) throw Error('Missing Node or DevSpace CLI; check file integrity and security logs.');
    return {
      url: 'http://127.0.0.1:7676/healthz', name: 'devspace',
      args: ['--import', path.join(root, 'runtime', 'devspace-session-preload.mjs'), cli, 'serve'],
      cwd: root, env: { ...process.env, PATH: `${path.join(root, 'node')}${path.delimiter}${process.env.PATH || ''}` }
    };
  }
  if (modeName === 'outbound') {
    return { args: [path.join(root, 'runtime', 'enrollment.mjs'), 'run'], cwd: root, env: process.env };
  }
  if (modeName === 'router') {
    const id = fs.readFileSync(path.join(state, 'device-id.txt'), 'utf8').trim();
    const roots = fs.readFileSync(path.join(state, 'roots.txt'), 'utf8').trim();
    if (!/^device-[0-9a-f-]{36}$/i.test(id) || !roots) throw Error('Missing or invalid identity/allowed roots; refusing to overwrite state.');
    return {
      url: 'http://127.0.0.1:17678/_codassol/health',
      args: [path.join(root, 'app', 'server.js')], cwd: path.join(root, 'app'),
      env: { ...process.env, CODASSOL_STATE_DIR: state, CODASSOL_LOCAL_DEVICE_LABEL: os.hostname(),
        CODASSOL_LOCAL_DEVICE_ID: id, CODASSOL_LOCAL_ROOTS: roots,
        CODASSOL_LISTEN_HOST: '127.0.0.1', CODASSOL_LISTEN_PORT: '17678',
        CODASSOL_BACKEND_HOST: '127.0.0.1', CODASSOL_BACKEND_PORT: '7676',
        CODASSOL_OUTBOUND_ONLY: '1' }
    };
  }
  throw Error(`Unsupported supervisor mode: ${modeName}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (!['router', 'devspace', 'outbound'].includes(mode)) { console.error('Usage: supervisor.mjs <router|devspace|outbound>'); process.exitCode = 2; }
  else {
    await acquireInstance({devspace:17679, router:17680, outbound:17681}[mode]);
    fs.mkdirSync(logs, { recursive: true });
    // Do not kill unrelated processes; adopt an already healthy listener.
    while (true) {
      try {
        const service = prepare(mode);
        if (service.url && await healthy(service.url, service.name)) { await sleep(5000); continue; }
        const child = spawn(node, service.args, { cwd: service.cwd, env: service.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        streamOutput(child, mode);
        const outcome = await new Promise((resolve) => {
          child.once('error', (error) => resolve(`spawn failed: ${error.message}`));
          child.once('exit', (code, signal) => {
            if (code === 78) { note(mode, 'Configuration/authentication rejected; manual review required.'); process.exit(78); }
            resolve(`exited ${code ?? signal}`);
          });
        });
        note(mode, `${outcome}; retrying after cooldown.`);
      } catch (error) { note(mode, `${error.message}; retrying without changing state.`); }
      await sleep(5000);
    }
  }
}
