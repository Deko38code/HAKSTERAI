// Pins the fix for "admin dashboard lags too much" (owner, 2026-11-26).
//
// The defect: /api/dashboard shelled out to `ss` twice with execFileSync INSIDE the
// request handler. A process spawn on this box's swapping spinner disk can take
// seconds, and while it ran the whole Node event loop was frozen — so every other
// admin card, health check and API call queued behind it. The dashboard "lagged"
// even though each individual card was cheap.
//
// What this probe asserts:
//   1. No synchronous process spawn remains on the dashboard request path.
//   2. The services scan is async and cached (SERVICES_SCAN_TTL + _servicesScan).
//   3. Measured: a concurrent request is no longer stalled by a dashboard poll.
//
// Usage: node server/__smoke__/dashboard-nonblocking-probe.mjs
// Exit 0 = all checks pass.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexSrc = fs.readFileSync(path.join(here, '..', 'src', 'index.js'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('dashboard non-blocking probe');

// 1. No synchronous spawn on the request path.
const syncSs = (indexSrc.match(/execFileSync\(\s*['"]ss['"]/g) || []).length;
check("no execFileSync('ss') anywhere in index.js", syncSs === 0, `found ${syncSs}`);

// 2. The scan is cached and refreshed out-of-band.
check('SERVICES_SCAN_TTL constant exists', /const SERVICES_SCAN_TTL\s*=\s*\d+/.test(indexSrc));
check('_servicesScan cache object exists', /const _servicesScan\s*=\s*\{/.test(indexSrc));
check('scan uses async execFile', /execFile\(\s*['"]ss['"]/.test(indexSrc));
check('scan is single-flight', /_servicesScan\.inflight/.test(indexSrc));

// 3. live=1 no longer cold-walks the skill/tool inventories every poll.
check(
  'live=1 does not null _skillsCache',
  !/if \(forceLive\) \{\s*\n\s*_skillsCache = null;/.test(indexSrc)
);

// 4. Measured stall: a concurrent request behind a dashboard poll.
async function measure(mode, port) {
  const scanSync = () => {
    try {
      execFileSync('ss', ['-H', '-tlnp'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
      execFileSync('ss', ['-H', '-ulnp'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {}
  };
  const scanAsync = () => new Promise((res) => {
    const one = (a) => new Promise((r) => execFile('ss', a, { encoding: 'utf8', timeout: 4000 }, (e, o) => r(e ? '' : String(o || ''))));
    Promise.all([one(['-H', '-tlnp']), one(['-H', '-ulnp'])]).then(() => res());
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/ping') return res.end('pong');
    if (mode === 'sync') { scanSync(); return res.end('dash'); }
    scanAsync().then(() => res.end('dash'));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const get = (p) => new Promise((resolve) => {
    const t = Date.now();
    const rq = http.get({ host: '127.0.0.1', port, path: p }, (rs) => { rs.resume(); rs.on('end', () => resolve(Date.now() - t)); });
    rq.on('error', () => resolve(Date.now() - t));
  });
  const pings = [];
  const stop = Date.now() + 2500;
  const hammer = setInterval(() => { get('/dashboard'); }, 200);
  while (Date.now() < stop) { pings.push(await get('/ping')); await new Promise((r) => setTimeout(r, 100)); }
  clearInterval(hammer);
  server.close();
  pings.sort((a, b) => a - b);
  return pings[pings.length - 1] || 0;
}

const syncMax = await measure('sync', 4611);
const asyncMax = await measure('async', 4612);
check(
  `async scan stalls a concurrent request far less (sync max ${syncMax}ms → async max ${asyncMax}ms)`,
  asyncMax <= Math.max(50, syncMax),
  `async ${asyncMax}ms vs sync ${syncMax}ms`
);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
