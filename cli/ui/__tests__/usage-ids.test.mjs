/* The per-key usage ids are locked in our CLI config.
 *
 * Owner (2026-11-26): "lock the usage in our config in cli per user usage ids
 * etc just like u did and make keys for our codex from admin to make with ids".
 *
 * Why this file exists: an id is the name historical usage is filed under. If a
 * future edit renames `key-haksterai-codex` or moves the `codex-cli` lane onto a
 * different id, every measured row would keep its old name while new rows land
 * somewhere else — the split would silently break with nothing failing. So the
 * ids, the account each sits on and the lane→id map are pinned here, exactly as
 * the wire model is pinned by self-config-lock.test.mjs (CLAUDE.md §22.4 shape,
 * §29 one key per paid plan, §51 per-key accounting).
 *
 * These are literals on purpose: changing one is a deliberate edit to this file
 * and to cli/src/usage-ids.js, which the self-config guard refuses to let a tool
 * write (§38.1). Nothing here holds a key value — ids and env-var NAMES only
 * (§9, §23, §31).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const idsPath = path.join(here, '..', '..', 'src', 'usage-ids.js');
const idsSource = fs.readFileSync(idsPath, 'utf8');
const usageViewSource = fs.readFileSync(path.join(here, '..', 'src', 'components', 'UsageView.jsx'), 'utf8');

const { LOCKED_USAGE_IDS, LANE_USAGE_ID, usageIdFor, listUsageIds, ownUsageIds, accountTags } = require(idsPath);

/* The locked ids, value for value. Codex gets its own two ids so Codex usage is
 * measured per key like every other lane instead of vanishing into "other". */
const EXPECTED_IDS = [
  { id: 'key-haksterai-1', account: 'ollama-cloud-2', envVar: 'OLLAMA_CLOUD_KEY_2', lanes: ['deepseek-key2'] },
  { id: 'key-haksterai-relay', account: '', envVar: 'DEEPSEEK_BASE_URL', lanes: ['ollama', 'deepseek', 'claude-cli'] },
  { id: 'key-haksterai-codex', account: 'codex-pro', envVar: 'CODEX_AUTH_JSON (~/.codex/auth.json)', lanes: ['codex-cli'] },
  { id: 'key-haksterai-codex-api', account: 'codex-api', envVar: 'CODEX_API_KEY', lanes: ['codex'] },
  { id: 'key-junkalot-1', account: 'ollama-cloud-2', envVar: 'OLLAMA_CLOUD_KEY_2', lanes: [] },
];

test('every locked usage id is present, with its account and env-var name', () => {
  assert.equal(LOCKED_USAGE_IDS.length, EXPECTED_IDS.length);
  for (const want of EXPECTED_IDS) {
    const got = LOCKED_USAGE_IDS.find((k) => k.id === want.id);
    assert.ok(got, `missing locked id ${want.id}`);
    assert.equal(got.account, want.account, `${want.id} account moved`);
    assert.equal(got.envVar, want.envVar, `${want.id} env-var name moved`);
    assert.deepEqual([...got.lanes], want.lanes, `${want.id} lanes moved`);
  }
});

test('no locked id or label carries a key value', () => {
  // Names only: an env-var NAME, a label, a client. A long base64/hex blob would
  // mean a value leaked into the config (§9, §23, §31).
  for (const k of LOCKED_USAGE_IDS) {
    for (const field of ['id', 'label', 'client', 'account', 'envVar', 'provider']) {
      const v = String(k[field] || '');
      assert.ok(!/[A-Za-z0-9_\-]{32,}/.test(v), `${k.id}.${field} looks like a secret`);
      assert.ok(!/^(sk-|ghp_|xox|AKIA)/.test(v), `${k.id}.${field} looks like a key prefix`);
    }
  }
});

test('the lane → usage id map is exactly what we state', () => {
  assert.deepEqual({ ...LANE_USAGE_ID }, {
    'deepseek-key2': 'key-haksterai-1',
    ollama: 'key-haksterai-relay',
    deepseek: 'key-haksterai-relay',
    'claude-cli': 'key-haksterai-relay',
    'codex-cli': 'key-haksterai-codex',
    codex: 'key-haksterai-codex-api',
  });
});

test('usageIdFor attributes known lanes and refuses to guess the rest', () => {
  assert.equal(usageIdFor('codex-cli'), 'key-haksterai-codex');
  assert.equal(usageIdFor('codex'), 'key-haksterai-codex-api');
  assert.equal(usageIdFor('deepseek-key2'), 'key-haksterai-1');
  assert.equal(usageIdFor('ollama'), 'key-haksterai-relay');
  assert.equal(usageIdFor('claude-cli'), 'key-haksterai-relay');
  // An unknown lane is unattributed — never mapped onto a neighbour (§51.6).
  assert.equal(usageIdFor('groq6'), null);
  assert.equal(usageIdFor(''), null);
  assert.equal(usageIdFor(null), null);
});

test('our ids exclude the client key, and shared accounts are tagged', () => {
  const own = ownUsageIds();
  assert.ok(own.every((k) => k.client !== 'junkalot.co'), 'a client key leaked into our list');
  assert.ok(own.some((k) => k.id === 'key-haksterai-codex'), 'codex id missing from ours');
  // Both our key and Junkalot's live on ollama-cloud-2, so that account is
  // printed on the rows that share it and only on those.
  const tags = accountTags(LOCKED_USAGE_IDS);
  assert.equal(tags.get('key-haksterai-1'), 'ollama-cloud-2');
  assert.equal(tags.get('key-junkalot-1'), 'ollama-cloud-2');
  assert.equal(tags.get('key-haksterai-codex'), undefined);
  assert.equal(tags.get('key-haksterai-codex-api'), undefined);
});

test('a registry id added later is merged on top, and never renames a locked one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ids-'));
  const file = path.join(dir, 'provider-keys.json');
  fs.writeFileSync(file, JSON.stringify({
    keys: [
      // A later key added from admin: appears as data (§26.5).
      { id: 'key-haksterai-codex-2', label: 'Codex Pro · account 2', client: 'haksterai.com', account: 'codex-pro-2', envVar: 'CODEX_AUTH_JSON_2', lanes: ['codex-cli-2'] },
      // A row that tries to rename a locked id: the lock wins.
      { id: 'key-haksterai-codex', label: 'RENAMED', client: 'elsewhere', account: 'other', lanes: [] },
    ],
  }));
  const prev = process.env.PROVIDER_KEYS_FILE;
  process.env.PROVIDER_KEYS_FILE = file;
  try {
    // The module reads the registry path at load, so re-require a fresh copy.
    const cached = require.cache[idsPath];
    delete require.cache[idsPath];
    const fresh = require(idsPath);
    const all = fresh.listUsageIds();
    const added = all.find((k) => k.id === 'key-haksterai-codex-2');
    assert.ok(added, 'an admin-added id was dropped');
    assert.equal(added.locked, false);
    assert.equal(added.source, 'server registry');
    const locked = all.find((k) => k.id === 'key-haksterai-codex');
    assert.equal(locked.label, 'HAKSTERAI-FLASH · Codex Pro (ours)', 'a registry row renamed a locked id');
    assert.equal(locked.locked, true);
    require.cache[idsPath] = cached;
  } finally {
    if (prev == null) delete process.env.PROVIDER_KEYS_FILE;
    else process.env.PROVIDER_KEYS_FILE = prev;
    delete require.cache[idsPath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the config is bundle-safe: no bare __dirname', () => {
  // The TUI bundle is ESM, where a bare __dirname is not a binding and would
  // throw on load — the usage page would crash before showing anything. So any
  // line that mentions __dirname in CODE must be guarded by `typeof __dirname`,
  // which is the only form that cannot throw when the binding is absent.
  assert.match(idsSource, /typeof __dirname/, 'the __dirname check was removed');
  // Strip comments (block and line) first: a comment may name __dirname freely,
  // only code matters. A block comment is removed whole, including its `*` lines.
  const code = idsSource.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '').trim());
  const offenders = code
    .filter((line) => line.includes('__dirname'))
    .filter((line) => !line.includes('typeof __dirname'));
  assert.deepEqual(offenders, [], 'a bare __dirname survived outside its guard');
});

test('the self-config guard refuses a write to the usage ids', () => {
  const { guardSelfConfig } = require(path.join(here, '..', '..', 'src', 'self-config-guard.js'));
  const refusal = guardSelfConfig('write_file', { path: idsPath }, path.dirname(idsPath));
  assert.ok(refusal && /usage ids/i.test(refusal), 'a tool write to the locked ids was allowed');
  // Reading is untouched: a different file in the same directory is allowed.
  assert.equal(guardSelfConfig('write_file', { path: path.join(path.dirname(idsPath), 'prefs-notes.txt') }, path.dirname(idsPath)), null);
});

test('/usage renders the locked ids and attributes recent calls per id', () => {
  assert.match(usageViewSource, /from '\.\.\/\.\.\/\.\.\/src\/usage-ids\.js'/, 'UsageView no longer reads the locked ids');
  // The billing block renders the locked floor through listUsageIds() (every id,
  // grouped per user), so pin that call — a view that stopped reading the locked
  // config would silently fall back to whatever the server happened to serve.
  assert.match(usageViewSource, /listUsageIds\(\)/, 'the locked floor is unused');
  assert.match(usageViewSource, /usageIdFor\(/, 'recent calls are no longer attributed to an id');
  assert.match(usageViewSource, /ids locked in CLI config/, 'the billing block stopped saying the ids are locked');
});
