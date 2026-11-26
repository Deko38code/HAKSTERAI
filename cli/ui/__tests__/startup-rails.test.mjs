/* The start card's checklist carries memory and MCP counts (§40, §46).
 *
 * Owner, 2026-11-26: "add memory bank check to startup list to and mcp count".
 *
 * Pinned here:
 *   1. the two new rails exist and are named in the card;
 *   2. memory-bank reads ~/.hakster/memories/banks — the store the TUI header
 *      reads — and its note is the real entry count, never a guess;
 *   3. an unreadable bank escalates to a scored failure (it silently kills
 *      recall, §40), while missing or empty banks stay an optional grey note;
 *   4. mcp counts the configured servers deduped by name across the config
 *      dirs, exactly as loadMcpServers() does (§46.1), and an unparseable
 *      mcp.json escalates;
 *   5. the card renders the count beside the rail, and the header says
 *      "required" when optional rails are listed but not scored.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = require.resolve('../../src/guardrail-check.js');
const LOGO = path.join(here, '..', '..', 'logo.js');
const REPO_MCP = path.join(here, '..', '..', '..', '.hakster', 'mcp.json');

/** Load a fresh copy of the check module with HOME pointed at `home`.
 *  HOME is captured when the module loads, so the cache is cleared each time
 *  and the real home is restored immediately afterwards. */
function loadWithHome(home) {
  const prev = process.env.HOME;
  process.env.HOME = home;
  let mod;
  try {
    delete require.cache[GUARD];
    mod = require(GUARD);
  } finally {
    process.env.HOME = prev;
  }
  return mod;
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-rails-' + tag + '-'));
}

function writeBank(home, name, entries) {
  const dir = path.join(home, '.hakster', 'memories', 'banks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(entries));
  return dir;
}

const byId = (items, id) => items.find((i) => i.id === id);

test('both new rails are registered and named', () => {
  const home = tmpdir('ids');
  const { runGuardrailCheck, CHECKS } = loadWithHome(home);
  const ids = CHECKS.map((c) => c.id);
  assert.ok(ids.includes('memory-bank'), 'memory-bank rail registered');
  assert.ok(ids.includes('mcp'), 'mcp rail registered');
  const result = runGuardrailCheck({ only: ['memory-bank', 'mcp'] });
  assert.deepEqual(result.items.map((i) => i.label), ['memory bank', 'mcp belt']);
});

test('memory-bank reports the real entry count from the header store', () => {
  const home = tmpdir('mem');
  writeBank(home, 'project-facts', [
    { observation: 'one', tags: ['a'] },
    { observation: 'two', tags: ['a'] },
  ]);
  writeBank(home, 'patterns', [{ observation: 'three' }]);
  const { runGuardrailCheck } = loadWithHome(home);
  const item = byId(runGuardrailCheck({ only: ['memory-bank'] }).items, 'memory-bank');
  assert.equal(item.ok, true);
  assert.equal(item.note, '3 notes');
  assert.match(item.detail, /2 banks · 3 notes/);
  assert.equal(item.optional, true, 'an absent rail never alarms a fresh install');
});

test('memory-bank escalates when a bank will not parse', () => {
  const home = tmpdir('mem-bad');
  const dir = writeBank(home, 'project-facts', [{ observation: 'ok' }]);
  fs.writeFileSync(path.join(dir, 'patterns.json'), '{not json');
  const { runGuardrailCheck } = loadWithHome(home);
  const item = byId(runGuardrailCheck({ only: ['memory-bank'] }).items, 'memory-bank');
  assert.equal(item.ok, false);
  assert.equal(item.optional, false, 'corrupt store is a fault, not a missing component');
  assert.match(item.detail, /unreadable/);
  assert.match(item.detail, /patterns\.json/);
});

test('memory-bank with no banks yet is a grey note, not a failure', () => {
  const home = tmpdir('mem-empty');
  const { runGuardrailCheck } = loadWithHome(home);
  const item = byId(runGuardrailCheck({ only: ['memory-bank'] }).items, 'memory-bank');
  assert.equal(item.ok, false);
  assert.equal(item.optional, true);
  assert.match(item.detail, /no banks yet/);
});

test('mcp counts configured servers deduped by name across config dirs', () => {
  const realNames = fs.existsSync(REPO_MCP)
    ? Object.keys(JSON.parse(fs.readFileSync(REPO_MCP, 'utf8')).mcpServers || {})
    : [];
  const home = tmpdir('mcp');
  fs.mkdirSync(path.join(home, '.hakster'), { recursive: true });
  // A name the repo config already carries must not be counted twice (the
  // same dedupe loadMcpServers() applies), and one new name must add one.
  const shared = realNames[0] || 'filesystem';
  fs.writeFileSync(
    path.join(home, '.hakster', 'mcp.json'),
    JSON.stringify({ mcpServers: { [shared]: { command: 'x' }, 'railtest-only': { command: 'y' } } }),
  );
  const prevCwd = process.cwd();
  const emptyCwd = tmpdir('mcp-cwd');
  let item;
  try {
    process.chdir(emptyCwd);
    const { runGuardrailCheck } = loadWithHome(home);
    item = byId(runGuardrailCheck({ only: ['mcp'] }).items, 'mcp');
  } finally {
    process.chdir(prevCwd);
  }
  const expected = new Set([...realNames, shared, 'railtest-only']).size;
  assert.equal(item.ok, true);
  assert.equal(item.note, expected + ' servers');
});

test('mcp escalates when a config will not parse', () => {
  const home = tmpdir('mcp-bad');
  fs.mkdirSync(path.join(home, '.hakster'), { recursive: true });
  fs.writeFileSync(path.join(home, '.hakster', 'mcp.json'), '{oops');
  const { runGuardrailCheck } = loadWithHome(home);
  const item = byId(runGuardrailCheck({ only: ['mcp'] }).items, 'mcp');
  assert.equal(item.ok, false);
  assert.equal(item.optional, false);
  assert.match(item.detail, /unreadable/);
});

test('the card renders the count beside the rail: the whole belt when all are up', () => {
  // Owner, 2026-11-26: "the gaurdrail check in cli on dell is not passing all
  // 8/8" — eight green ticks under a "5/5 required" header. Every rail that
  // measured OK is counted now, so a clean belt reads 8/8 and a missing
  // optional rail still drops back to the scored figure (§10, §50).
  const logo = require(LOGO);
  const rails = {
    ok: true,
    pass: 1,
    total: 1,
    ms: 3,
    items: [
      { id: 'a', label: 'model lock', ok: true, optional: false, note: '', detail: '' },
      { id: 'b', label: 'memory bank', ok: true, optional: true, note: '386 notes', detail: '' },
      { id: 'c', label: 'mcp belt', ok: true, optional: true, note: '21 servers', detail: '' },
    ],
  };
  const text = logo.railsChecklist(rails).join('\n');
  assert.match(text, /386 notes/, 'the measured memory count is on the rail');
  assert.match(text, /21 servers/, 'the measured MCP count is on the rail');
  assert.match(text, /3\/3 rails active/, 'a clean belt counts every measured rail');
  assert.ok(!/3\/3 required/.test(text), 'a clean belt never says "required"');
  assert.ok(!/1\/1 required/.test(text), 'the header is not the scored-only figure');
  // No wrapping: every rendered row stays inside a sane terminal width.
  for (const line of logo.railsChecklist(rails)) {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '').length;
    assert.ok(visible <= 120, 'rail row stays within the card: ' + visible + ' cols');
  }

  // One optional rail off: the header must not claim the whole belt.
  const optOff = JSON.parse(JSON.stringify(rails));
  optOff.items[2].ok = false;
  optOff.ok = true;
  const offText = logo.railsChecklist(optOff).join('\n');
  assert.match(offText, /1\/1 required/, 'an optional rail off drops back to the scored figure');
  assert.ok(!/3\/3 rails active/.test(offText), 'the header never claims 3 of 3 with one rail off');
  assert.match(offText, /optional off: mcp belt/, 'the rail that is off is named');
});

/* The band reads green, and a green tick never hides a broken rail (§10, §50).
 *
 * Owner, 2026-11-26: "make the text green with all in checklist on startup".
 */
test('a clean band is green throughout — and a failure is never painted green', () => {
  const logo = require(LOGO);
  const GREEN = '\x1b[38;5;46m';
  const RED = '\x1b[38;5;196m';
  const RESET = '\x1b[0m';
  const allPass = {
    ok: true,
    pass: 3,
    total: 3,
    ms: 3,
    items: [
      { id: 'a', label: 'model lock', ok: true, note: '3 paths' },
      { id: 'b', label: 'memory bank', ok: true, note: '386 notes' },
      { id: 'c', label: 'mcp belt', ok: true, note: '21 servers' },
    ],
  };
  const text = logo.railsChecklist(allPass).join('\n');
  assert.ok(text.includes(GREEN + 'CHECKLIST'), 'the band header is green');
  assert.ok(text.includes(GREEN + '3/3 rails active'), 'the count is green when every rail passes');
  for (const i of allPass.items) {
    assert.ok(text.includes(GREEN + i.label + RESET), i.label + ' label is green');
  }
  assert.ok(!text.includes(RED), 'an all-pass band prints no red');

  const withFail = JSON.parse(JSON.stringify(allPass));
  Object.assign(withFail, { ok: false, pass: 2 });
  withFail.items[2].ok = false;
  withFail.items[2].detail = 'codex not installed';
  const failText = logo.railsChecklist(withFail).join('\n');
  assert.ok(!failText.includes(GREEN + 'mcp belt'), 'a failed rail is never labelled green');
  assert.ok(failText.includes(RED + '✗'), 'a failed rail still gets its red tick');
  assert.ok(failText.includes('2/3 rails active'), 'the count drops to the measured figure');
  assert.ok(failText.includes('codex not installed'), 'the failure names its reason');
});
