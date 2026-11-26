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

test('the card renders the count beside the rail and counts only scored rails', () => {
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
  assert.match(text, /1\/1 required/, 'optional rails are listed but not scored');
  assert.ok(!/1\/1 rails active/.test(text), 'the header never claims 3 ticks as 1 rail');
  // No wrapping: every rendered row stays inside a sane terminal width.
  for (const line of logo.railsChecklist(rails)) {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '').length;
    assert.ok(visible <= 120, 'rail row stays within the card: ' + visible + ' cols');
  }
});
