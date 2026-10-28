import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CATEGORY_IDS = new Set(['mcp', 'heartbeat', 'device_stream', 'device_poll', 'device_results', 'health', 'discovery', 'peer_sync', 'enrollment', 'other', 'historical']);
const bucket = () => ({ requests: 0, receivedBytes: 0, sentBytes: 0 });
export function requestCategory(req) {
  const route = String(req.url || '').split('?')[0];
  if (route === '/mcp' || route.startsWith('/mcp/')) return 'mcp';
  if (route === '/_codassol/health' || route === '/healthz') return 'health';
  if (route === '/_codassol/agent/heartbeat') return 'heartbeat';
  if (route === '/_codassol/agent/events') return 'device_stream';
  if (route === '/_codassol/agent/poll') return 'device_poll';
  if (route === '/_codassol/agent/result') return 'device_results';
  if (route === '/_codassol/agent/enroll') return 'enrollment';
  if (route === '/_codassol/devices' || route.startsWith('/_codassol/devices/')) return 'discovery';
  if (route.startsWith('/_codassol/peer/')) return 'peer_sync';
  return 'other';
}
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const size = (chunk, encoding) => chunk == null || typeof chunk === 'function' ? 0 :
  typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk.byteLength;

/** Stores aggregate counts and at most 100 sanitized category/status records.
 * Never stores paths, headers, credentials or bodies.
 * Counts HTTPS forwarded by the local ingress, including heartbeat and health traffic.
 * HTTP headers, TLS overhead and edge-rejected requests never reach this meter.
 */
export class TrafficUsage {
  constructor({ stateDir = path.join(homedir(), '.codassol'), persist = true } = {}) {
    this.file = persist ? path.join(stateDir, 'traffic-usage.json') : null;
    this.state = { version: 1, since: Date.now(), httpsRequests: 0, receivedBytes: 0, sentBytes: 0,
      classifiedSince: Date.now(), categories: {}, recentRequests: [] };
    const initialState = structuredClone(this.state);
    this.dirty = false;
    this.persistenceError = false;
    if (this.file) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8'));
        if (saved.version !== 1 || !['since','httpsRequests','receivedBytes','sentBytes'].every(k => Number.isSafeInteger(saved[k]) && saved[k] >= 0)) throw new Error('Invalid usage state');
        this.state = saved;
        const categorized = saved.categories && typeof saved.categories === 'object' && !Array.isArray(saved.categories);
        if (categorized) {
          for (const [id, value] of Object.entries(saved.categories)) {
            if (!CATEGORY_IDS.has(id) || !['requests','receivedBytes','sentBytes'].every(k => Number.isSafeInteger(value?.[k]) && value[k] >= 0)) throw new Error('Invalid category state');
          }
          for (const [field,total] of [['requests','httpsRequests'],['receivedBytes','receivedBytes'],['sentBytes','sentBytes']]) {
            if (Object.values(saved.categories).reduce((sum,c) => sum+c[field],0) !== saved[total]) throw new Error('Category totals do not reconcile');
          }
        } else {
          this.state.categories = { historical: { requests: saved.httpsRequests, receivedBytes: saved.receivedBytes, sentBytes: saved.sentBytes } };
          this.state.classifiedSince = Date.now();
          this.dirty = true;
        }
        if (!Number.isFinite(this.state.classifiedSince)) this.state.classifiedSince = Date.now();
        // Reconstruct only the fixed log fields; never pass stored arbitrary fields to clients.
        this.state.recentRequests = (Array.isArray(saved.recentRequests) ? saved.recentRequests : []).slice(-100).flatMap(r =>
          Number.isSafeInteger(r.id) && CATEGORY_IDS.has(r.category) && Number.isFinite(r.startedAt) ? [{
            id:r.id, category:r.category, startedAt:r.startedAt,
            method:['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(r.method) ? r.method : 'OTHER',
            receivedBytes:Number.isSafeInteger(r.receivedBytes) && r.receivedBytes >= 0 ? r.receivedBytes : 0,
            sentBytes:Number.isSafeInteger(r.sentBytes) && r.sentBytes >= 0 ? r.sentBytes : 0,
            statusCode:Number.isInteger(r.statusCode) && r.statusCode >= 100 && r.statusCode < 600 ? r.statusCode : null,
            durationMs:Number.isFinite(r.durationMs) && r.durationMs >= 0 ? r.durationMs : null,
            outcome:r.outcome === 'complete' || r.outcome === 'aborted' ? r.outcome : 'interrupted'
          }] : []);
      } catch (error) {
        if (error.code !== 'ENOENT') { this.state = initialState; this.persistenceError = true; this.file = null; }
      }
    }
    this.timer = setInterval(() => this.flush(), 5000);
    this.timer.unref();
  }
  snapshot() {
    return { ...this.state,
      categories: Object.entries(this.state.categories).map(([id, c]) => ({ id, ...c })).sort((a,b) => b.requests-a.requests),
      recentRequests: this.state.recentRequests.slice().reverse(),
      sampledAt: Date.now(), persistenceError: this.persistenceError };
  }
  track(req, res) {
    if (!loopback(req.socket.remoteAddress) || req.headers['x-forwarded-proto'] !== 'https') return;
    this.state.httpsRequests++; this.dirty = true;
    const category = requestCategory(req);
    const totals = this.state.categories[category] ??= bucket();
    totals.requests++;
    const record = { id:this.state.httpsRequests, startedAt:Date.now(), category,
      method:['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(req.method) ? req.method : 'OTHER',
      receivedBytes:0, sentBytes:0, statusCode:null, durationMs:null, outcome:'active' };
    this.state.recentRequests.push(record);
    if (this.state.recentRequests.length > 100) this.state.recentRequests.shift();
    const add = (direction, bytes) => {
      this.state[direction] += bytes; totals[direction] += bytes; record[direction] += bytes; this.dirty = true;
    };
    add('receivedBytes', req.readableLength);
    let finished = false;
    const finish = outcome => {
      if (finished) return;
      finished = true;
      record.statusCode = res.headersSent ? res.statusCode : null;
      record.durationMs = Date.now()-record.startedAt;
      record.outcome = outcome; this.dirty = true;
    };
    res.once('finish', () => finish('complete'));
    res.once('close', () => finish('aborted'));
    // Intercept push without adding a data listener (which would prematurely
    // consume request bodies while auth/routing awaits). Preserve stream behavior.
    const push = req.push;
    req.push = (chunk, encoding) => {
      add('receivedBytes', size(chunk, encoding));
      return push.call(req, chunk, encoding);
    };
    const write = res.write, end = res.end;
    res.write = (chunk, encoding, callback) => {
      add('sentBytes', size(chunk, encoding));
      return write.call(res, chunk, encoding, callback);
    };
    res.end = (chunk, encoding, callback) => {
      add('sentBytes', size(chunk, encoding));
      return end.call(res, chunk, encoding, callback);
    };
  }
  flush() {
    if (!this.file || !this.dirty) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file + '.tmp', JSON.stringify(this.state) + '\n', { mode: 0o600 });
      renameSync(this.file + '.tmp', this.file);
      this.dirty = false; this.persistenceError = false;
    } catch { this.persistenceError = true; }
  }
  close() { clearInterval(this.timer); this.flush(); }
}

export function handleUsageRoute(req, res, runtime, usage) {
  if (req.url !== '/_codassol/usage') return false;
  // Public ingress requests must never expose the owner's counters.
  const local = loopback(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-proto'];
  const token = typeof req.headers.authorization === 'string' ? req.headers.authorization.replace(/^Bearer /, '') : '';
  if (!local || !runtime?.privateState.verifyAdminToken(token)) {
    res.writeHead(403, { 'cache-control': 'no-store' }); res.end(); return true;
  }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return true; }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(usage.snapshot())); return true;
}
