#!/usr/bin/env node
/* peer-memory probe — Parrot's memory shown in our clusters, never merged into it.
 *
 * Owner, 2026-11-26: "add parrot to clusters will help". The panel counted only
 * the banks on this box, so memories the agent banked while working on Parrot
 * were invisible on the one screen meant to show all top memories.
 *
 * This pins the whole path:
 *   1. both peer shapes parse (older single store + newer per-section banks);
 *   2. the section mapping matches autolearn's, so a card is named the same;
 *   3. the word index is counted as keywords, never as memories;
 *   4. an empty peer reads zero, and an unreachable one says so — never invented;
 *   5. the remote command is READ ONLY (cat/echo/test only, no write anywhere);
 *   6. the endpoint adds `peers` and leaves the local `total` untouched;
 *   7. the panel draws a peer as its own card and keeps its count out of the
 *      total line.
 * A live read of the real peer is attempted last; unreachable is reported as
 * skipped, never as passed.
 *
 * Run: node server/__smoke__/peer-memory-probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const peerMemory = require(path.join(root, 'server/src/peerMemory.js'));

let pass = 0, fail = 0, skipped = 0;
const ok = (name) => { pass++; console.log(`✔ ${name}`); };
const bad = (name, detail) => { fail++; console.log(`✘ ${name}${detail ? ` — ${detail}` : ''}`); };
const check = (name, cond, detail) => (cond ? ok(name) : bad(name, detail));
const skip = (name, why) => { skipped++; console.log(`~ ${name} — ${why}`); };

const PEER = { host: 'parrot', sshAlias: 'parrot', label: 'Parrot', address: '10.0.0.251', role: 'junkalot + phantomide' };
const SPLIT = '__HAKSTER_SPLIT__';

// ── 1. the older shape: one store, a flat memories array (Parrot today) ──────
const store = {
  version: 2,
  createdAt: '2026-11-04T01:54:26.845Z',
  memories: [
    { id: 'm1', timestamp: '2026-11-04T01:54:26.846Z', type: 'fact', observation: 'Junk-A-Lot billing context' },
    { id: 'm2', timestamp: '2026-11-04T02:10:00.000Z', type: 'fact', observation: 'Newer fact about phantomide' },
    { id: 'm3', timestamp: '2026-11-03T09:00:00.000Z', type: 'pattern', observation: 'A pattern seen twice' },
  ],
};
const index = { index: { junkalot: [1], billing: [2], context: [3], from: [4] }, lastUpdated: '2026-11-04T01:55:24.209Z' };
const legacyText = [JSON.stringify(store, null, 2), SPLIT, JSON.stringify(index), SPLIT].join('');

const legacy = peerMemory.summarizePeerMemory(PEER, legacyText, { topN: 4 });
check('the older single-store shape is understood', legacy.shape === 'legacy-store', legacy.shape);
check('every stored memory is counted', legacy.memories === 3, String(legacy.memories));
check('it is reported reachable', legacy.reachable === true);
check('a fact lands in the Project Facts card', legacy.banks.some((b) => b.section === 'Project Facts'), JSON.stringify(legacy.banks.map((b) => b.section)));
check('a pattern lands in the Patterns card', legacy.banks.some((b) => b.section === 'Patterns'));
const facts = legacy.banks.find((b) => b.section === 'Project Facts');
check('cards carry their own count', facts && facts.count === 2, String(facts && facts.count));
check('top entries are newest first', facts && facts.top[0].observation.startsWith('Newer fact'), facts && facts.top[0].observation);
check('banks come back biggest first', legacy.banks[0].count >= legacy.banks[legacy.banks.length - 1].count);
check('the word index is counted as keywords, not memories', legacy.indexKeys === 4 && legacy.memories === 3, `${legacy.indexKeys}/${legacy.memories}`);
check('the index never inflates the memory count', legacy.memories === 3);
check('lastUpdated comes from the index', legacy.lastUpdated === '2026-11-04T01:55:24.209Z');
check('the source names the host and says read only', /read only/.test(legacy.source) && legacy.source.includes('parrot'), legacy.source);

// ── 2. the newer shape: per-section bank files ──────────────────────────────
const bankFile = (name, entries) => `__BANK__ ${name}\n${JSON.stringify(entries)}\n${SPLIT}`;
const banksText = [
  JSON.stringify({ memories: [] }), SPLIT,                       // no legacy store
  JSON.stringify({ index: {} }), SPLIT,
  bankFile('project-facts.json', [
    { timestamp: '2026-11-26T10:00:00Z', type: 'fact', observation: 'banked fact A' },
    { timestamp: '2026-11-25T10:00:00Z', type: 'fact', observation: 'banked fact B' },
  ]),
  bankFile('errors-encountered.json', [
    { timestamp: '2026-11-26T11:00:00Z', type: 'error', observation: 'banked error A' },
  ]),
].join('');
const banksShape = peerMemory.summarizePeerMemory(PEER, banksText, {});
check('the newer per-section bank shape is understood', banksShape.shape === 'banks', banksShape.shape);
check('a bank file name becomes its card name', banksShape.banks.some((b) => b.section === 'Project Facts'), JSON.stringify(banksShape.banks.map((b) => b.section)));
check('every bank entry is counted once', banksShape.memories === 3, String(banksShape.memories));

// ── 3. honest zero and honest failure ──────────────────────────────────────
const empty = peerMemory.summarizePeerMemory(PEER, `${SPLIT}${SPLIT}`, {});
check('an empty peer reads zero, not an error', empty.reachable === true && empty.memories === 0 && empty.shape === 'empty', `${empty.reachable}/${empty.memories}/${empty.shape}`);
check('an empty peer still carries its identity', empty.label === 'Parrot' && empty.address === '10.0.0.251');

const down = peerMemory.summarizePeerMemory(PEER, '', { error: 'ssh: connect to host 10.0.0.251 port 22: No route to host' });
check('an unreachable peer says unreachable', down.reachable === false && down.memories === 0);
check('an unreachable peer names why, bounded', typeof down.error === 'string' && down.error.length > 0 && down.error.length <= 160);
check('an unreachable peer invents no banks', Array.isArray(down.banks) && down.banks.length === 0);
check('an unreachable peer is never rendered as zero memories of data', down.reachable === false);

// ── 4. the remote command only reads ───────────────────────────────────────
const cmd = peerMemory.REMOTE_CMD;
check('the remote command cats the store', cmd.includes('memory_store.json'));
check('the remote command cats the index', cmd.includes('memory_index.json'));
check('the remote command covers bank files', cmd.includes('memories/banks/*.json'));
check('the remote command writes nothing', !/>|>>|\bmkdir\b|\brm\b|\bmv\b|\bcp\b|\btee\b|\btouch\b|\bsed -i\b/.test(cmd), cmd);
check('it sends nothing but read-only shell built-ins', !/\b(scp|rsync|curl|wget|git|npm|systemctl|pm2)\b/.test(cmd));

// ── 5. the endpoint adds peers and leaves our total alone ──────────────────
const src = fs.readFileSync(path.join(root, 'server/src/index.js'), 'utf8');
const routeStart = src.indexOf("app.get('/api/agent/memory-banks'");
check('the route is still declared owner-gated', src.slice(routeStart, routeStart + 90).includes('requireOwner'));
check('the route became async for the peer read', src.slice(routeStart, routeStart + 90).includes('async'));
const routeBody = src.slice(routeStart, src.indexOf('// ── Skills list for the command palette', routeStart));
check('the route reports peers', /peers\s*=\s*await require\('\.\/peerMemory'\)/.test(routeBody), 'no peer read in route');
check('the route reports whether a peer is still warming', routeBody.includes('peersPending'));
check('the peer read is bounded so the page never waits', /budgetMs:\s*\d+/.test(routeBody));
check('a peer failure cannot break our own banks', /try \{ peers = await/.test(routeBody) && routeBody.includes('catch { peers = []; }'));
check('our own total is still computed from our banks only', /total \+= entries\.length/.test(routeBody));
check('the response keeps our total as its own field', /res\.json\(\{ total, cap: 300, banks, peers, peersPending \}\)/.test(routeBody));

// ── 6. the panel draws the peer separately ─────────────────────────────────
const page = fs.readFileSync(path.join(root, 'src/pages/dashboard.astro'), 'utf8');
check('the panel has a peer renderer', page.includes('const renderPeer ='));
check('the peer card is labelled with its host', /🖥 \$\{escapeHtml\(p\.label \|\| p\.host\)\}/.test(page));
check('the peer card is visually distinct from our banks', page.includes('border-[#00bfff]/25'));
check('peers are passed into the renderer', /render\(data\.banks \|\| \[\], data\.total, data\.cap, data\.peers \|\| \[\]\)/.test(page));
check('a peer count never joins our total', /\+\s*\(peerNote \?/.test(page), 'peer figure missing from the total line composition');
check('the peer card is escaped before it reaches the page', page.includes('${escapeHtml(p.address || \'\')}'));
check('a warming peer is retried once, not polled', page.includes('_peerRetried'));

// ── 7. a live read of the real peer (reported honestly) ────────────────────
try {
  const live = await peerMemory.readPeer({ ...PEER, host: 'parrot' }, { budgetMs: 12000, topN: 4 });
  if (live.pending) {
    skip('live read of parrot', 'still warming inside the budget');
  } else if (live.reachable === false) {
    skip('live read of parrot', `unreachable: ${live.error}`);
  } else {
    ok(`live read of parrot — ${live.memories} memories, ${live.indexKeys} index keywords, shape ${live.shape}`);
    console.log(`  ${live.banks.map((b) => `${b.section}:${b.count}`).join(' · ') || '(no cards)'}`);
  }
} catch (err) {
  skip('live read of parrot', err && err.message);
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
