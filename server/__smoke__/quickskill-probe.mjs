#!/usr/bin/env node
/* quickskill probe — a captured skill is measured, never invented.
 *
 * Owner, 2026-11-26: "add skills playbook were we can make qickskill from what
 * we learn". The invariant this pins:
 *
 *   1. with nothing learned (no recap under the id, no operator note) the write
 *      is REFUSED instead of filing an empty skill;
 *   2. a recap's own mistakes and lessons land in the file — mistakes under
 *      "Mistakes not to repeat", everything else under "What worked";
 *   3. the captured file carries no invented confidence score;
 *   4. capturing the same name twice APPENDS a dated section and keeps the
 *      first capture's text (one skill per name, history intact);
 *   5. the name is slugged, so a name that looks like a path cannot escape the
 *      skill bank;
 *   6. the bank's index.json gains one honest row for the capture.
 *
 * The handler is sliced out of the real `server/src/index.js` and given stubs
 * for memory + a temp skills dir, so deleting the refusal or overwriting an
 * existing skill fails here instead of silently filing bad data.
 *
 * Run: node server/__smoke__/quickskill-probe.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(here, '../src/index.js'), 'utf8');

const start = src.indexOf("// ── `POST /api/agent/quickskill`");
if (start === -1) throw new Error('the quickskill endpoint is missing from server/src/index.js');
const endAnchor = "app.put('/api/memory/:key', (req, res) => {";
const end = src.indexOf(endAnchor, start);
if (end === -1) throw new Error('could not find the end of the quickskill endpoint');
const block = src.slice(start, end);

let handler = null;
const app = { post: (u, fn) => { if (u === '/api/agent/quickskill') handler = fn; } };
const sandbox = new Function('app', 'getMemory', 'autolearn', 'fs', 'console', 'require', `${block}\nreturn true;`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quickskill-'));
const recap = '#a3f9k2';
const autolearn = {
  SKILLS_DIR: tmp,
  MEMORY_SECTIONS: ['patterns'],
  readRawMemories: () => ([
    { type: 'error', tags: [recap], observation: 'probed the router door on :3579 and got a 401' },
    { type: 'lesson', tags: [recap], observation: 'probe the app on :3580 with the API key' },
    { type: 'error', tags: ['#other'], observation: 'unrelated run — must not leak in' },
  ]),
  readBank: (_cwd, section) => (section === 'patterns'
    ? [{ type: 'pattern', tags: [recap], observation: 'the door pins /api/ to the primary slot' }]
    : []),
};
const getMemory = (key) => (key === `recap${recap}` ? { value: 'recap #a3f9k2 · 4 tools · 2 learned' } : null);

sandbox(app, getMemory, autolearn, fs, console, require);
if (typeof handler !== 'function') throw new Error('the endpoint was not registered on the app');

let passed = 0;
const ok = (m) => { console.log(`✓ ${m}`); passed++; };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const call = (body) => {
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return this; },
    json(v) { out.body = v; return this; },
  };
  handler({ body }, res);
  return out;
};

// 1. A nameless capture is refused.
let r = call({ notes: 'x' });
if (r.status !== 400 || !/name is required/.test(r.body.error)) fail('a nameless capture was accepted');
ok('refuses a capture with no name');

// 2. Nothing learned is refused, not filed empty.
r = call({ name: 'empty skill' });
if (r.status !== 400 || !/nothing learned to capture/.test(r.body.error)) fail(`an empty capture was filed: ${JSON.stringify(r.body)}`);
if (fs.readdirSync(tmp).some((f) => f.endsWith('.md'))) fail('an empty capture wrote a file anyway');
ok('refuses a capture with nothing learned');

// 3. A real capture writes what the run actually learned.
r = call({ name: 'Door probe on the right port', recap, steps: ['curl the app port', 'not the router door'] });
if (r.status !== 200 || r.body.ok !== true) fail(`capture failed: ${JSON.stringify(r.body)}`);
if (r.body.name !== 'door-probe-on-the-right-port') fail(`name was not slugged: ${r.body.name}`);
if (r.body.appended !== false) fail('the first capture reported itself as an append');
const file = path.join(tmp, 'door-probe-on-the-right-port.md');
if (fs.existsSync(file) === false) fail('the skill file was not written');
const md = fs.readFileSync(file, 'utf8');
if (!md.startsWith('# Door probe on the right port')) fail('the file does not start with the title');
if (!/probed the router door on :3579 and got a 401/.test(md)) fail('the recap\'s mistake was not filed');
if (!/probe the app on :3580 with the API key/.test(md)) fail('the recap\'s lesson was not filed');
if (!/the door pins \/api\/ to the primary slot/.test(md)) fail('the banked pattern was not filed');
if (/unrelated run/.test(md)) fail('a memory from another recap leaked into this skill');
if (!/## Steps/.test(md) || !/1\. curl the app port/.test(md)) fail('the operator steps were not filed');
if (/## Confidence|confidence:?\s*[0-9]/i.test(md)) fail('the capture invented a confidence score');
if (!new RegExp(`recap ${recap}`).test(md)) fail('the capture does not name the recap it came from');
if (r.body.mistakes !== 1 || r.body.learned !== 2) fail(`counts are wrong (${r.body.mistakes}/${r.body.learned})`);
ok('writes the recap\'s mistakes, lessons and banked pattern, with no invented confidence');

// 4. The same name appends — the earlier capture survives.
const before = fs.readFileSync(file, 'utf8');
r = call({ name: 'Door probe on the right port', notes: 'second pass: pass the key in a header' });
if (r.status !== 200 || r.body.appended !== true) fail('a second capture with the same name did not report an append');
const after = fs.readFileSync(file, 'utf8');
if (!after.startsWith(before.trimEnd())) fail('appending the same skill rewrote the earlier capture');
if (!/second pass: pass the key in a header/.test(after)) fail('the appended note is missing');
if ((after.match(/^## Description$/gm) || []).length !== 2) fail('the append did not add its own dated section');
ok('appends a second capture instead of overwriting the first');

// 5. A path-shaped name cannot escape the bank.
r = call({ name: '../../etc/passwd', notes: 'path escape attempt' });
if (r.status !== 200) fail('the path-shaped name was rejected instead of slugged');
if (path.dirname(r.body.path) !== tmp) fail(`the capture escaped the skill bank: ${r.body.path}`);
if (fs.existsSync('/etc/passwd.md')) fail('the capture wrote outside the bank');
ok('slugs a path-shaped name so it stays inside the skill bank');

// 6. The bank index carries one honest row.
const index = JSON.parse(fs.readFileSync(path.join(tmp, 'index.json'), 'utf8'));
const row = index.skills.find((s) => s.name === 'door-probe-on-the-right-port');
if (!row) fail('the capture was not indexed');
if (row.source !== 'quickskill' || row.recap !== recap) fail(`the index row is not honest: ${JSON.stringify(row)}`);
if ('confidence' in row) fail('the index row invented a confidence score');
const dupes = index.skills.filter((s) => s.name === 'door-probe-on-the-right-port');
if (dupes.length !== 1) fail(`the index holds ${dupes.length} rows for one skill`);
ok('indexes one honest row per captured skill');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
