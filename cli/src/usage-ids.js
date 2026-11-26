'use strict';
/* ════════════════════════════════════════════════════════════════════════
 * Per-user usage ids — one id per model key, locked in the CLI config.
 *
 * Owner (2026-11-26): "lock the usage in our config in cli per user usage ids
 * etc just like u did and make keys for our codex from admin to make with ids".
 *
 * What this file is:
 *   The CLI's own copy of the key-id namespace. Every model key has an id, and
 *   that id is the usage id: a measured call is attributed to the key that ran
 *   it, so a client's usage is provable per key instead of guessed off one
 *   shared account (CLAUDE.md §29, §51).
 *
 * Why a literal here as well as the server registry:
 *   The server's registry (`server/data/provider-keys.json`) is the live source,
 *   but the CLI must be able to show the ids even when the server has not
 *   restarted onto code that serves them (§45 — an update never forces a bounce).
 *   The literals below are the floor: they are always present, and a registry
 *   entry added later (from the admin page, with an id) is merged on top.
 *
 * Locked, not editable:
 *   `cli/src/self-config-guard.js` refuses any tool write to this file, and
 *   `cli/ui/__tests__/usage-ids.test.mjs` pins every id and lane below. Changing
 *   an id is a separate, explicit owner decision (§22.4 shape) — the same way
 *   the wire model is locked, because a re-ID would silently move historical
 *   usage onto a different name.
 *
 * It holds no key value and no secret: an id, a label, the account it sits on,
 * the lanes that use it and the env-var NAME the value lives in (§9, §23, §31).
 * It records and displays; it never bills and changes no route (§19, §24, §26).
 * ════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || os.homedir() || '/home/ghost';

/**
 * The repo root, computed so this file works BOTH as a CommonJS module
 * (`require('cli/src/usage-ids.js')`, where `__dirname` exists) and inside the
 * TUI bundle, which esbuild emits as ESM and where a bare `__dirname` is not a
 * binding at all. `typeof` is the only safe test: reading a missing binding
 * throws, checking its type does not. When neither answers, the registry is not
 * read and the locked ids below still render — the same honest fallback.
 */
const REPO = (() => {
  try {
    if (typeof __dirname === 'string' && __dirname) return path.resolve(__dirname, '..', '..');
  } catch { /* no __dirname (bundled ESM) — fall through */ }
  const base = process.env.HAKSTER_REPO || process.cwd() || '';
  return base ? path.resolve(base) : '';
})();

/** The live registry the server reads. Read-only here — never written. */
const REGISTRY_FILE = process.env.PROVIDER_KEYS_FILE
  || (REPO ? path.join(REPO, 'server', 'data', 'provider-keys.json') : '');

/**
 * LOCKED — who a key's usage belongs to, in display order. Usage is read and
 * shown per user first, then per key: our own lanes and a client's key never
 * fold into one figure, even when two keys sit on the same account (§29.6).
 */
const USERS = Object.freeze({
  owner: Object.freeze({ user: 'owner', label: 'Owner' }),
  junkalot: Object.freeze({ user: 'junkalot', label: 'Junkalot · client' }),
});

const USER_ORDER = Object.freeze(['owner', 'junkalot']);

/**
 * LOCKED — our usage ids, one per model key, each owned by one user. Every
 * entry mirrors the server seed; the codex lanes are here so Codex usage is
 * measured per key too.
 */
const LOCKED_USAGE_IDS = Object.freeze([
  Object.freeze({
    id: 'key-haksterai-1',
    label: 'HAKSTERAI-FLASH (ours)',
    user: 'owner',
    userLabel: 'Owner',
    client: 'haksterai.com',
    account: 'ollama-cloud-2',
    envVar: 'OLLAMA_CLOUD_KEY_2',
    lanes: Object.freeze(['deepseek-key2']),
  }),
  Object.freeze({
    id: 'key-haksterai-relay',
    label: 'HAKSTERAI-FLASH · relay (ours)',
    user: 'owner',
    userLabel: 'Owner',
    client: 'haksterai.com',
    account: '',
    envVar: 'DEEPSEEK_BASE_URL',
    lanes: Object.freeze(['ollama', 'deepseek', 'claude-cli']),
  }),
  Object.freeze({
    id: 'key-haksterai-codex',
    label: 'HAKSTERAI-FLASH · Codex Pro (ours)',
    user: 'owner',
    userLabel: 'Owner',
    client: 'haksterai.com',
    account: 'codex-pro',
    envVar: 'CODEX_AUTH_JSON (~/.codex/auth.json)',
    lanes: Object.freeze(['codex-cli']),
  }),
  Object.freeze({
    id: 'key-haksterai-codex-api',
    label: 'Codex API · Nous (ours)',
    user: 'owner',
    userLabel: 'Owner',
    client: 'haksterai.com',
    account: 'codex-api',
    envVar: 'CODEX_API_KEY',
    lanes: Object.freeze(['codex']),
  }),
  Object.freeze({
    id: 'key-junkalot-1',
    label: 'Junkalot Coach',
    user: 'junkalot',
    userLabel: 'Junkalot · client',
    client: 'junkalot.co',
    account: 'ollama-cloud-2',
    envVar: 'OLLAMA_CLOUD_KEY_2',
    lanes: Object.freeze([]),
  }),
]);

/**
 * LOCKED — lane → usage id. This is the attribution the CLI states, so a lane
 * is never counted under a neighbour's name by guesswork (§51.6): our relay
 * lanes are one account bucket because the relay's upstream key is not visible
 * from this box, and a lane with no id is reported as unattributed.
 */
const LANE_USAGE_ID = Object.freeze({
  'deepseek-key2': 'key-haksterai-1',
  ollama: 'key-haksterai-relay',
  deepseek: 'key-haksterai-relay',
  'claude-cli': 'key-haksterai-relay',
  'codex-cli': 'key-haksterai-codex',
  codex: 'key-haksterai-codex-api',
});

/** The usage id a lane counts against, or null when it has none (honest). */
function usageIdFor(lane) {
  const key = String(lane == null ? '' : lane).trim();
  if (!key) return null;
  return LANE_USAGE_ID[key] || null;
}

function readRegistryKeys() {
  if (!REGISTRY_FILE) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    return raw && Array.isArray(raw.keys) ? raw.keys : [];
  } catch {
    return [];
  }
}

/**
 * The usage ids the CLI shows: the locked literals first (always present, never
 * dropped by a registry that has not been updated), then any id added later from
 * the admin page. A registry entry never overrides a locked label or client, so
 * a rewritten file cannot rename historical usage (§22.4 shape).
 */
function listUsageIds() {
  const out = LOCKED_USAGE_IDS.map((k) => ({
    id: k.id,
    label: k.label,
    user: k.user,
    userLabel: k.userLabel,
    client: k.client,
    account: k.account,
    envVar: k.envVar,
    lanes: [...k.lanes],
    locked: true,
    source: 'cli config',
  }));
  const known = new Set(out.map((k) => k.id));
  for (const k of readRegistryKeys()) {
    const id = String((k && k.id) || '').trim();
    if (!id || known.has(id) || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) continue;
    known.add(id);
    const client = String(k.client || '');
    // A registry row added later names its user; when it does not, the client is
    // the only honest signal — a Junkalot key is a client's, everything else ours.
    const user = String(k.user || (client === 'junkalot.co' ? 'junkalot' : 'owner'));
    out.push({
      id,
      label: String(k.label || id),
      user,
      userLabel: String(k.userLabel || (USERS[user] && USERS[user].label) || user),
      client,
      account: String(k.account || ''),
      envVar: String(k.envVar || ''),
      lanes: Array.isArray(k.lanes) ? k.lanes.map(String) : [],
      locked: false,
      source: 'server registry',
    });
  }
  return out;
}

/**
 * Our own ids only — keys filed under the owner. Now that a paid account gets its
 * own key id (§29, "per user per key"), "ours" cannot mean "not Junkalot's": a
 * paying user's key is neither ours nor a client's, so it is excluded by user,
 * never by client name.
 */
function ownUsageIds() {
  return listUsageIds().filter((k) => String(k.user || 'owner') === 'owner');
}

/** The account tag is printed only where two ids share one account (§51). */
function accountTags(ids) {
  const counts = new Map();
  for (const k of ids || []) {
    const a = k && k.account;
    if (a) counts.set(a, (counts.get(a) || 0) + 1);
  }
  const tags = new Map();
  for (const k of ids || []) {
    if (k && k.account && counts.get(k.account) > 1) tags.set(k.id, k.account);
  }
  return tags;
}

/**
 * Usage grouped per user, then per key — the shape both /usage and the admin card
 * render. Order is stable (`owner`, then `junkalot`, then anything added later in
 * the order it appeared), so a user's block never jumps rows between refreshes.
 * A key belongs to exactly one user; nothing is summed across users (§29.6).
 */
function groupByUser(ids) {
  const list = Array.isArray(ids) ? ids : [];
  const groups = new Map();
  for (const k of list) {
    if (!k || !k.id) continue;
    const user = String(k.user || 'owner');
    if (!groups.has(user)) {
      groups.set(user, {
        user,
        label: String(k.userLabel || (USERS[user] && USERS[user].label) || user),
        keys: [],
      });
    }
    groups.get(user).keys.push(k);
  }
  const rank = (u) => {
    const i = USER_ORDER.indexOf(u);
    return i === -1 ? USER_ORDER.length : i;
  };
  return [...groups.values()].sort((a, b) => rank(a.user) - rank(b.user));
}

/** One-line display for an id. */
function describeUsageId(k) {
  if (!k) return '';
  const parts = [k.id];
  if (k.label) parts.push(k.label);
  if (k.account) parts.push(k.account);
  if (k.envVar) parts.push(k.envVar);
  return parts.join(' · ');
}

module.exports = {
  REGISTRY_FILE,
  USERS,
  USER_ORDER,
  LOCKED_USAGE_IDS,
  LANE_USAGE_ID,
  usageIdFor,
  listUsageIds,
  ownUsageIds,
  groupByUser,
  accountTags,
  describeUsageId,
};
