'use strict';

/**
 * Provider key ledger — one id per model key, usage measured per key.
 *
 * Owner (2026-11-26): "we will gie each ollama key id so we know how many
 * reqeuest usage tokens per token … can we make another key for junkalot in our
 * admin hakster for junkalots billing and put data there … make junkalot key to
 * works off ares but for billing usage wired back to our admin profit meter in
 * haksterai never display our profits in junkalot.co admin".
 *
 * What this module is:
 *   1. a REGISTRY (`data/provider-keys.json`) of key ids — an id, a label, the
 *      client it serves, the env var it lives in and the lanes that use it. It
 *      never holds a key value: the fingerprint is a SHA-256 prefix used only to
 *      tell two keys apart (§9, §23, §31).
 *   2. a USAGE LEDGER (`data/key-usage.jsonl`), append-only, one line per
 *      recorded call: key id, client, lane, model, requests, tokens, and whether
 *      the figure came from our own lane or from a client's recorded usage read
 *      over SSH read-only.
 *
 * Rules it follows:
 *   - recording is accounting, never billing (§19, §24): nothing here charges,
 *     changes a plan, a model or a route;
 *   - a figure is only reported from rows that exist. A key with no rows reads
 *     zero requests, and the row says which source it came from — never an
 *     estimate dressed as a measurement (§10, §13);
 *   - owner-only (§25): the caller must gate it. Nothing here writes into
 *     Junkalot or any other project (§16, §36).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REGISTRY_FILE = process.env.PROVIDER_KEYS_FILE || path.join(DATA_DIR, 'provider-keys.json');
const LEDGER_FILE = process.env.KEY_USAGE_FILE || path.join(DATA_DIR, 'key-usage.jsonl');

// Seeded ids. A key added later is data, not a code change (§26.5): add it with
// `node scripts/provider-key-add.cjs` or by editing the registry by hand.
const DEFAULT_REGISTRY = {
  version: 1,
  note: 'One id per model key. Values are never stored here — only the env var name and a SHA-256 prefix used to tell two keys apart. Owner-only accounting (§19, §25, §29).',
  keys: [
    {
      id: 'key-haksterai-1',
      label: 'HAKSTERAI-FLASH (ours)',
      client: 'haksterai.com',
      provider: 'ollama-cloud',
      envVar: 'OLLAMA_CLOUD_KEY_2',
      lanes: ['deepseek-key2'],
      basis: 'lane-attributed',
      note: 'The keyed lane this server answers on (ollama.com, called directly). Every recorded call on that lane is counted here.',
      createdAt: '2026-11-26',
    },
    {
      id: 'key-haksterai-relay',
      label: 'HAKSTERAI-FLASH · relay (ours)',
      client: 'haksterai.com',
      provider: 'relay',
      envVar: 'DEEPSEEK_BASE_URL',
      lanes: ['ollama', 'deepseek', 'claude-cli'],
      basis: 'relay-account',
      note: 'Our own relay stack (127.0.0.1:11434) — the same backend the owner\'s Claude CLI runs. The upstream key behind the relay is not visible from this box, so these calls are counted as one account, not split per key.',
      createdAt: '2026-11-26',
    },
    {
      id: 'key-junkalot-1',
      label: 'Junkalot Coach',
      client: 'junkalot.co',
      provider: 'ollama-cloud',
      envVar: 'OLLAMA_CLOUD_KEY_2',
      envOwner: 'parrot',
      lanes: [],
      basis: 'recorded-lane',
      usageSource: 'junkalot data/mred-usage.jsonl (read only, over ssh)',
      note: "Junkalot's own key, held on Parrot as OLLAMA_CLOUD_KEY_2 (plus its _PRIMARY variant) — the same variable name as ours but a different account. Its billing usage is read back here; nothing is written into that project.",
      createdAt: '2026-11-26',
    },
    {
      id: 'key-ollama-cloud2',
      label: 'Ollama Cloud 2 · spare',
      client: 'haksterai.com',
      provider: 'ollama-cloud',
      envVar: 'OLLAMA_CLOUD2_API_KEY',
      lanes: ['ollama-cloud2'],
      basis: 'lane-attributed',
      createdAt: '2026-11-26',
    },
    {
      id: 'key-ollama-cloud3',
      label: 'Ollama Cloud 3 · spare',
      client: 'haksterai.com',
      provider: 'ollama-cloud',
      envVar: 'OLLAMA_CLOUD3_API_KEY',
      lanes: ['ollama-cloud3'],
      basis: 'lane-attributed',
      createdAt: '2026-11-26',
    },
  ],
};

function readJson(file, fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch {
    return fallback;
  }
}

/** The registry as it is on disk; a missing file reads the seed, never a crash. */
function loadRegistry() {
  const raw = readJson(REGISTRY_FILE, null);
  if (!raw || !Array.isArray(raw.keys) || !raw.keys.length) return JSON.parse(JSON.stringify(DEFAULT_REGISTRY));
  // Seeds added later appear in a registry written before them: a missing default
  // id is appended (merge by name, never overwrite), so a new seeded key is a
  // fallback entry rather than a code change only the owner can make (§26.5).
  const known = new Set(raw.keys.map((k) => k && k.id).filter(Boolean));
  const merged = raw.keys.slice();
  for (const seed of DEFAULT_REGISTRY.keys) {
    if (!known.has(seed.id)) merged.push(seed);
  }
  return {
    version: Number(raw.version) || 1,
    note: typeof raw.note === 'string' ? raw.note : DEFAULT_REGISTRY.note,
    keys: merged.filter((k) => k && typeof k.id === 'string' && k.id.trim()).map((k) => ({
      id: String(k.id).trim(),
      label: String(k.label || k.id).slice(0, 80),
      client: String(k.client || '').slice(0, 80),
      provider: String(k.provider || '').slice(0, 60),
      envVar: String(k.envVar || '').slice(0, 80),
      envOwner: String(k.envOwner || 'dell').slice(0, 40),
      lanes: Array.isArray(k.lanes) ? k.lanes.map(String).slice(0, 20) : [],
      basis: String(k.basis || 'lane-attributed').slice(0, 40),
      usageSource: String(k.usageSource || '').slice(0, 160),
      note: String(k.note || '').slice(0, 300),
      fingerprint: typeof k.fingerprint === 'string' ? k.fingerprint.slice(0, 32) : '',
      createdAt: String(k.createdAt || '').slice(0, 20),
    })),
  };
}

function saveRegistry(registry) {
  const out = {
    version: 1,
    note: registry.note || DEFAULT_REGISTRY.note,
    keys: Array.isArray(registry.keys) ? registry.keys : [],
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${REGISTRY_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, REGISTRY_FILE);
  return out;
}

/**
 * A key's identity, never its value. Two keys on one account can be told apart
 * by this and nothing else; the hash is one-way and is never printed in full.
 */
function fingerprintKey(value) {
  const text = String(value == null ? '' : value).trim();
  if (text.length < 8) return '';
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** The registry, masked for display: a 6-character fingerprint prefix at most. */
function listKeys() {
  const reg = loadRegistry();
  return reg.keys.map((k) => ({
    id: k.id,
    label: k.label,
    client: k.client,
    provider: k.provider,
    envVar: k.envVar,
    envOwner: k.envOwner,
    lanes: k.lanes,
    basis: k.basis,
    usageSource: k.usageSource,
    note: k.note,
    fp: k.fingerprint ? k.fingerprint.slice(0, 6) : null,
    createdAt: k.createdAt,
  }));
}

/** Which key id a lane belongs to, or null when the lane has no key recorded. */
function keyIdByLane(lane) {
  if (!lane) return null;
  const reg = loadRegistry();
  const hit = reg.keys.find((k) => k.lanes.includes(String(lane)));
  return hit ? hit.id : null;
}

/** Append one measured row. Never rewrites, never trims (§20.5 analogy). */
function recordKeyUsage(row) {
  try {
    const clean = {
      at: new Date(row && row.at ? row.at : Date.now()).toISOString(),
      keyId: String((row && row.keyId) || '').slice(0, 64) || null,
      client: String((row && row.client) || '').slice(0, 80) || null,
      provider: String((row && row.provider) || '').slice(0, 60) || null,
      model: String((row && row.model) || '').slice(0, 80) || null,
      lane: String((row && row.lane) || '').slice(0, 60) || null,
      requests: Math.max(0, Math.round(Number(row && row.requests) || 0)),
      inTokens: Math.max(0, Math.round(Number(row && row.inTokens) || 0)),
      outTokens: Math.max(0, Math.round(Number(row && row.outTokens) || 0)),
      source: String((row && row.source) || 'haksterai lane').slice(0, 120),
    };
    if (!clean.keyId && !clean.lane) return null;
    if (!clean.keyId) clean.keyId = keyIdByLane(clean.lane);
    if (!clean.keyId) return null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LEDGER_FILE, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
    return clean;
  } catch (err) {
    // Accounting must never break a served call (§11): a ledger failure is
    // reported to the server log and the request carries on.
    console.warn('[providerKeys] ledger append failed:', err.message);
    return null;
  }
}

function readLedger() {
  let text = '';
  try {
    text = fs.readFileSync(LEDGER_FILE, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (!row || typeof row.at !== 'string' || Number.isNaN(new Date(row.at).getTime())) continue;
      rows.push(row);
    } catch { /* a torn line is skipped, never repaired */ }
  }
  return rows;
}

const DAY_MS = 86400000;

/**
 * Per-key totals from the ledger: today, 7 days, 30 days and all time. Every
 * figure is a sum of recorded rows; a key with none reads zero and says so.
 */
function summarize(now = Date.now()) {
  const reg = loadRegistry();
  const rows = readLedger();
  const buckets = new Map();
  const bucketFor = (id) => {
    if (!buckets.has(id)) {
      buckets.set(id, {
        today: { requests: 0, inTokens: 0, outTokens: 0 },
        week: { requests: 0, inTokens: 0, outTokens: 0 },
        month: { requests: 0, inTokens: 0, outTokens: 0 },
        all: { requests: 0, inTokens: 0, outTokens: 0, firstAt: null, lastAt: null },
        lanes: new Map(),
      });
    }
    return buckets.get(id);
  };
  const add = (target, row) => {
    target.requests += Number(row.requests) || 0;
    target.inTokens += Number(row.inTokens) || 0;
    target.outTokens += Number(row.outTokens) || 0;
  };
  const dayStart = now - DAY_MS;
  const weekStart = now - 7 * DAY_MS;
  const monthStart = now - 30 * DAY_MS;
  for (const row of rows) {
    const id = row.keyId;
    if (!id) continue;
    // Only ids the registry knows are reported; an orphan row is not folded into
    // another key's total.
    if (!reg.keys.some((k) => k.id === id)) continue;
    const at = new Date(row.at).getTime();
    const b = bucketFor(id);
    add(b.all, row);
    if (!b.all.firstAt || row.at < b.all.firstAt) b.all.firstAt = row.at;
    if (!b.all.lastAt || row.at > b.all.lastAt) b.all.lastAt = row.at;
    if (at >= monthStart) add(b.month, row);
    if (at >= weekStart) add(b.week, row);
    if (at >= dayStart) add(b.today, row);
    const lane = String(row.lane || row.provider || 'unknown');
    const laneRow = b.lanes.get(lane) || { lane, requests: 0, tokens: 0 };
    laneRow.requests += Number(row.requests) || 0;
    laneRow.tokens += (Number(row.inTokens) || 0) + (Number(row.outTokens) || 0);
    b.lanes.set(lane, laneRow);
  }
  const empty = () => ({ requests: 0, inTokens: 0, outTokens: 0 });
  return {
    keys: reg.keys.map((k) => {
      const b = buckets.get(k.id);
      return {
        id: k.id,
        label: k.label,
        client: k.client,
        provider: k.provider,
        envVar: k.envVar,
        envOwner: k.envOwner,
        lanes: k.lanes,
        basis: k.basis,
        usageSource: k.usageSource,
        fp: k.fingerprint ? k.fingerprint.slice(0, 6) : null,
        today: b ? b.today : empty(),
        week: b ? b.week : empty(),
        month: b ? b.month : empty(),
        all: b ? b.all : { ...empty(), firstAt: null, lastAt: null },
        lanes: b ? [...b.lanes.values()].sort((x, y) => y.tokens - x.tokens) : [],
        measured: Boolean(b && b.all.requests),
      };
    }),
    rows: rows.length,
    ledger: LEDGER_FILE,
    note: 'Requests and tokens recorded per key on this box. A key with no rows reads zero; nothing here is estimated (§10) and nothing is billed (§19).',
  };
}

/**
 * Junkalot's own recorded turns, folded onto its key id.
 *
 * The rows come from `data/mred-usage.jsonl` on Parrot, read read-only over SSH
 * by the server. Each row is one Coach turn; its provider field names the lane
 * that served it. That is an attribution from a recorded row, never an estimate,
 * and it is reported as such (§10). Returns null when there are no rows.
 */
function summarizeJunkalotRows(text, keyId = 'key-junkalot-1', now = Date.now()) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (!row || typeof row.at !== 'string' || Number.isNaN(new Date(row.at).getTime())) continue;
      rows.push(row);
    } catch { /* torn line skipped */ }
  }
  if (!rows.length) return null;
  const bucket = () => ({ requests: 0, inTokens: 0, outTokens: 0 });
  const today = bucket();
  const week = bucket();
  const month = bucket();
  const all = bucket();
  const providers = new Map();
  let firstAt = null;
  let lastAt = null;
  for (const row of rows) {
    const at = new Date(row.at).getTime();
    const inTokens = Math.max(0, Math.round(Number(row.inTokens) || 0));
    const outTokens = Math.max(0, Math.round(Number(row.outTokens) || 0));
    const add = (b) => { b.requests += 1; b.inTokens += inTokens; b.outTokens += outTokens; };
    add(all);
    if (at >= now - 30 * DAY_MS) add(month);
    if (at >= now - 7 * DAY_MS) add(week);
    if (at >= now - DAY_MS) add(today);
    const lane = String(row.provider || 'unknown');
    const p = providers.get(lane) || { provider: lane, turns: 0, inTokens: 0, outTokens: 0 };
    p.turns += 1;
    p.inTokens += inTokens;
    p.outTokens += outTokens;
    providers.set(lane, p);
    if (!firstAt || row.at < firstAt) firstAt = row.at;
    if (!lastAt || row.at > lastAt) lastAt = row.at;
  }
  all.firstAt = firstAt;
  all.lastAt = lastAt;
  return {
    keyId,
    basis: 'recorded-lane',
    source: 'junkalot data/mred-usage.jsonl (read only, over ssh)',
    today,
    week,
    month,
    all,
    providers: [...providers.values()].sort((x, y) => (y.inTokens + y.outTokens) - (x.inTokens + x.outTokens)),
    measured: true,
    note: 'Each Coach turn is one recorded row. Requests and tokens are read from that row; nothing is estimated and nothing is written back into Junkalot.',
  };
}

module.exports = {
  REGISTRY_FILE,
  LEDGER_FILE,
  DEFAULT_REGISTRY,
  loadRegistry,
  saveRegistry,
  fingerprintKey,
  listKeys,
  keyIdByLane,
  recordKeyUsage,
  readLedger,
  summarize,
  summarizeJunkalotRows,
};
