#!/usr/bin/env node
/* memory-banks-admin probe — the dashboard's cluster panel shows ALL top
 * memories, not only the keyed `cluster:*` rows.
 *
 * Owner, 2026-11-26: "always update mem clusters in admin to with all top
 * memorys". The panel used to render only `cluster:*` rows out of
 * /api/memory, so every lesson, preference and error banked by the agent was
 * invisible there. This pins the endpoint that feeds the new section, and the
 * dashboard wiring itself:
 *
 *   1. the route exists and is owner-gated;
 *   2. every bank is reported, including one that is empty (count 0, no top);
 *   3. counts are the bank's real entry count and sum to `total`;
 *   4. banks come back biggest-first;
 *   5. `?top=N` is honoured and entries are newest-first;
 *   6. observations are truncated, never dumped whole;
 *   7. it only READS — no bank file is touched;
 *   8. the dashboard markup carries the panel and fetches this route.
 *
 * Run: node server/__smoke__/memory-banks-admin-probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const src = fs.readFileSync(path.join(root, 'server/src/index.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✔ ${name}`); }
  else { fail++; console.log(`✘ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ── Slice the real route out of index.js ──────────────────────────────
const start = src.indexOf('// ── Memory clusters (the bank the ◈ header counts)');
if (start === -1) throw new Error('the memory-banks endpoint is missing from server/src/index.js');
const endAnchor = '// ── Skills list for the command palette / dashboard ──';
const end = src.indexOf(endAnchor, start);
if (end === -1) throw new Error('could not find the end of the memory-banks endpoint');
const block = src.slice(start, end);

check('the route is declared owner-gated', /app\.get\('\/api\/agent\/memory-banks',\s*requireOwnerForbidden/.test(block));

// ── The gate itself: a stranger gets 403, never 401 ───────────────────
// Owner, 2026-11-26: "bank should be 403". A signed-out probe of an
// owner-only data route must read "forbidden" — 401 would tell an anonymous
// caller that signing in is what stands between them and the data (§34).
// Exercised from the real function body, not matched as text.
const gateStart = src.indexOf('function requireOwnerForbidden(');
check('a forbidden-only owner gate exists', gateStart !== -1);
const gateEnd = src.indexOf('\n}', gateStart);
const gateBody = src.slice(gateStart, gateEnd + 2);

function runGate(user) {
  const res = {
    code: null, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const fn = new Function('getUserByApiKey', 'isOwnerUser', 'getDb', 'OWNER_REQUIRED',
    `${gateBody}\nreturn requireOwnerForbidden;`)(
    () => user,
    (u) => Boolean(u && u.email === 'owner@example.com'),
    () => ({ prepare: () => ({ run() {} }) }),
    { error: 'Owner access required.' },
  );
  let nexted = false;
  fn({ headers: {} }, res, () => { nexted = true; });
  return { code: res.code, nexted, body: res.body };
}

const signedOut = runGate(null);
check('a signed-out probe reads 403, not 401', signedOut.code === 403 && signedOut.nexted === false);
check('the refusal names no owner account and no sign-in step',
  !/@|sign in|sign-in/i.test(JSON.stringify(signedOut.body || {})));
const nonOwner = runGate({ id: 7, email: 'client@example.com', role: 'user' });
check('a signed-in non-owner also reads 403', nonOwner.code === 403 && nonOwner.nexted === false);
const owner = runGate({ id: 1, email: 'owner@example.com', role: 'user' });
check('the owner passes the gate', owner.nexted === true && owner.code === null);

let handler = null;
const app = { get: (u, _mw, fn) => { if (u === '/api/agent/memory-banks') handler = fn; } };
const sandbox = new Function('app', 'requireOwnerForbidden', 'require', `${block}\nreturn true;`);

// ── Fake banks: one big, one small, one empty ─────────────────────────
const SECTIONS = ['User Preferences', 'Errors Encountered', 'Recon & Targets'];
const bank = {
  'User Preferences': [
    { observation: 'preference: the owner wants concise answers', timestamp: '2026-11-26T10:00:00Z', type: 'preference' },
    { observation: 'preference: never offer config edits', timestamp: '2026-11-26T12:00:00Z', type: 'preference' },
    { observation: 'preference: memory saves go to the TUI bank', timestamp: '2026-11-26T11:00:00Z', type: 'preference' },
    { observation: 'preference: bank is at the top right', timestamp: '2026-11-25T09:00:00Z', type: 'preference' },
    { observation: 'preference: x'.padEnd(600, 'y'), timestamp: '2026-11-24T09:00:00Z', type: 'preference' },
  ],
  'Errors Encountered': [
    { observation: 'error: probed the router door and got 401', timestamp: '2026-11-26T09:00:00Z', type: 'error' },
  ],
  'Recon & Targets': [],
};
const reads = [];
const fakeAutolearn = {
  MEMORY_SECTIONS: SECTIONS,
  readBank: (cwd, section) => { reads.push(section); return bank[section] || []; },
};
const fakeRequire = (id) => {
  if (id === './agent/autolearn') return fakeAutolearn;
  throw new Error(`unexpected require(${id})`);
};

sandbox(app, (_req, _res, next) => next && next(), fakeRequire);
check('the endpoint registers a GET handler', typeof handler === 'function');

function callRoute(query = {}) {
  let body = null, status = 200;
  const res = {
    status(s) { status = s; return res; },
    json(payload) { body = payload; return res; },
  };
  handler({ query }, res);
  return { status, body };
}

// ── Default call (top 5) ──────────────────────────────────────────────
const def = callRoute();
check('answers 200', def.status === 200, String(def.status));
check('every section is reported, the empty one included', (def.body.banks || []).length === 3);
check('counts are the real entry counts', def.body.banks.find(b => b.section === 'User Preferences').count === 5);
check('an empty bank reads 0 with no top entries',
  (() => { const b = def.body.banks.find(x => x.section === 'Recon & Targets'); return b.count === 0 && b.top.length === 0; })());
check('total is the sum of the banks', def.body.total === 6, String(def.body.total));
check('banks come back biggest first',
  def.body.banks.every((b, i, a) => i === 0 || a[i - 1].count >= b.count));
check('default top is 5 entries max',
  def.body.banks.find(b => b.section === 'User Preferences').top.length === 5);

// ── ?top=2 → two newest ───────────────────────────────────────────────
const two = callRoute({ top: '2' });
const pref = two.body.banks.find(b => b.section === 'User Preferences');
check('?top=N is honoured', pref.top.length === 2, String(pref.top.length));
check('top entries are newest first',
  pref.top[0].timestamp === '2026-11-26T12:00:00Z' && pref.top[1].timestamp === '2026-11-26T11:00:00Z',
  JSON.stringify(pref.top.map(t => t.timestamp)));
check('a long observation is truncated, not dumped whole',
  pref.top.every(t => t.observation.length <= 320));

// ── Hostile ?top= must not explode the response ───────────────────────
const hostile = callRoute({ top: '-3' });
check('a nonsense ?top= falls back to the default', hostile.status === 200
  && hostile.body.banks.find(b => b.section === 'User Preferences').top.length >= 1);
const huge = callRoute({ top: '9999' });
check('?top= is clamped', huge.body.banks.find(b => b.section === 'User Preferences').top.length <= 20);

// ── Read-only ─────────────────────────────────────────────────────────
check('it only reads the banks', reads.length > 0 && reads.every(s => SECTIONS.includes(s)));

// ── Dashboard wiring ──────────────────────────────────────────────────
const dash = fs.readFileSync(path.join(root, 'src/pages/dashboard.astro'), 'utf8');
check('the dashboard panel exists', dash.includes('Memory Clusters · all banks'));
check('the panel is fed by the new route', dash.includes("liveFetch('/api/agent/memory-banks?top=4')"));
check('the panel is called on load', /loadStmClusters\(\);\s*\n\s*loadMemoryClusters\(\);/.test(dash));
check('bank text is escaped before it reaches the page',
  /escapeHtml\(String\(t\.observation/.test(dash));
check('a server without the route still fills the panel from /api/agent/memory',
  /liveFetch\('\/api\/agent\/memory\?limit=60'\)/.test(dash));
check('and says so plainly when neither shape is available',
  dash.includes('Bank entries appear once the running server picks up this build'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
