'use strict';
/**
 * Per-key instances on this server (§29, §51, §52).
 *
 * Every model key registered in `provider-keys.json` gets its own lane instance
 * on this box: its own keep-alive connection pool, its own concurrency budget
 * and its own measured health. Two keys never share a pool, so one client's
 * traffic cannot queue behind another's, and a warm connection is reused
 * instead of re-handshaking TLS on every call — the reason a keyed lane answers
 * faster on the second request than the first.
 *
 * This is transport and accounting only. It never changes a model, a route,
 * the provider order, a rate, a plan or an allowance (§19.3, §22.4, §26). A
 * lane with no key id still gets an instance so a call is never refused — it is
 * filed as `key-unattributed` and says so rather than being guessed onto a
 * neighbouring key (§10, §13).
 *
 * Usage recording stays where the measurement is (`recordKeyUsage` via
 * `recordUserTokenUsage` in index.js); this module tracks liveness, isolation
 * and latency, and exposes `status()` for the owner admin.
 */

const providerKeys = require('./providerKeys');

// Isolation budgets. Generous enough never to be the bottleneck, tight enough
// that one saturated key cannot take the whole box's concurrency with it.
const LIMIT_HTTP = 6;
const LIMIT_RELAY = 8;
const LIMIT_CLI = 2;
const DEFAULT_LIMIT = LIMIT_HTTP;

const QUEUE_TIMEOUT_MS = 120000;

// Keep-alive: a warm keyed lane should reuse its socket for a full minute of
// idle time, and up to ten minutes while a long stream is in flight.
const KEEP_ALIVE_TIMEOUT_MS = 60000;
const KEEP_ALIVE_MAX_TIMEOUT_MS = 600000;
const CONNECTIONS_PER_INSTANCE = 8;
const HEADERS_TIMEOUT_MS = 600000; // 10 min — matches the agent stream abort
const BODY_TIMEOUT_MS = 600000;
const CONNECT_TIMEOUT_MS = 30000;

const UNATTRIBUTED = 'key-unattributed';
const RELAY_LANES = new Set(['ollama', 'deepseek', 'ollama-local']);
const CLI_LANES = new Set(['claude-cli', 'codex-cli', 'codex', 'kiro-cli']);
const CLI_PROVIDERS = new Set(['claude-cli', 'codex-cli', 'codex', 'cli']);

const states = new Map(); // keyId -> live state
let registryCache = null;
let registryCacheAt = 0;
const REGISTRY_TTL_MS = 5000;

function registry() {
  const now = Date.now();
  if (registryCache && now - registryCacheAt < REGISTRY_TTL_MS) return registryCache;
  try {
    registryCache = providerKeys.loadRegistry();
  } catch (_) {
    registryCache = { keys: [] };
  }
  registryCacheAt = now;
  return registryCache;
}

function keyRow(keyId) {
  return registry().keys.find((k) => k && k.id === keyId) || null;
}

/** Which key id a lane belongs to, or null when the lane carries no key (§51.6). */
function keyIdForLane(lane) {
  if (!lane) return null;
  try {
    return providerKeys.keyIdByLane(String(lane));
  } catch (_) {
    return null;
  }
}

/** How a key is reached, so its instance can be sized and described honestly. */
function transportFor(row, lane) {
  const provider = String((row && row.provider) || '').toLowerCase();
  const laneName = String(lane || '').toLowerCase();
  if (CLI_PROVIDERS.has(provider) || CLI_LANES.has(laneName)) return 'cli';
  if (provider === 'relay' || RELAY_LANES.has(laneName)) return 'relay';
  return 'http';
}

function limitFor(transport, row) {
  const declared = Number(row && row.maxConcurrency);
  if (Number.isFinite(declared) && declared > 0) return Math.min(32, Math.floor(declared));
  if (transport === 'cli') return LIMIT_CLI;
  if (transport === 'relay') return LIMIT_RELAY;
  return DEFAULT_LIMIT;
}

/**
 * Resolve a lane name or key id to the instance descriptor it belongs to.
 * Never throws: an unknown lane resolves to the unattributed instance, which is
 * a real, working lane — not a refused call.
 */
function forLane(laneOrKeyId) {
  const asked = String(laneOrKeyId || '');
  let row = asked.startsWith('key-') ? keyRow(asked) : null;
  let lane = asked;
  if (!row && asked && !asked.startsWith('key-')) {
    const id = keyIdForLane(asked);
    if (id) row = keyRow(id);
  }
  if (row) {
    const laneNames = Array.isArray(row.lanes) ? row.lanes : [];
    // Prefer the lane that was actually asked for when it belongs to this key.
    const laneName = laneNames.includes(asked) ? asked : (laneNames[0] || asked || '');
    const transport = transportFor(row, laneName || asked);
    return {
      keyId: row.id,
      label: row.label || row.id,
      user: row.user || 'owner',
      userLabel: row.userLabel || 'Owner',
      client: row.client || '',
      account: row.account || '',
      provider: row.provider || '',
      envVar: row.envVar || '',
      lane: laneName || asked || '',
      lanes: laneNames,
      transport,
      maxConcurrency: limitFor(transport, row),
      attributed: true,
    };
  }
  const laneName = asked || '';
  const transport = transportFor(null, laneName);
  return {
    keyId: UNATTRIBUTED,
    label: 'Unattributed lane',
    user: 'owner',
    userLabel: 'Owner',
    client: '',
    account: '',
    provider: laneName,
    envVar: '',
    lane: laneName,
    lanes: [],
    transport,
    maxConcurrency: limitFor(transport, null),
    attributed: false,
  };
}

function stateFor(keyId) {
  let st = states.get(keyId);
  if (st) return st;
  st = {
    keyId,
    inflight: 0,
    queued: 0,
    max: DEFAULT_LIMIT,
    dispatcher: null,
    requests: 0,
    failures: 0,
    lastMs: null,
    ewmaMs: null,
    lastAt: null,
    totalWaitMs: 0,
    queue: [],
    maxConcurrency: 0,
  };
  states.set(keyId, st);
  return st;
}

/** The one keep-alive agent this key's HTTP calls reuse. */
function dispatcherFor(keyId) {
  const st = stateFor(keyId);
  if (st.dispatcher) return st.dispatcher;
  // Lazy so a CLI-only process never spins an HTTP pool it will not use.
  const { Agent } = require('undici');
  st.dispatcher = new Agent({
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
    connections: CONNECTIONS_PER_INSTANCE,
    pipelining: 1,
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
  });
  return st.dispatcher;
}

function releaseFn(inst, st) {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    st.inflight = Math.max(0, st.inflight - 1);
    const next = st.queue.shift();
    st.queued = st.queue.length;
    if (next) {
      clearTimeout(next.timer);
      st.totalWaitMs += Date.now() - next.started;
      st.inflight += 1;
      next.resolve({ instance: inst, release: releaseFn(inst, st) });
    }
  };
}

/**
 * Take this key's slot. Resolves with a `release()` function; the caller must
 * call it in a `finally` so a thrown turn cannot leak the slot. A queue wait
 * longer than QUEUE_TIMEOUT_MS rejects, which lets the caller fall through the
 * waterfall instead of hanging inside a saturated instance.
 */
function acquire(laneOrKeyId) {
  const inst = forLane(laneOrKeyId);
  const st = stateFor(inst.keyId);
  st.max = inst.maxConcurrency;
  if (st.inflight < st.max) {
    st.inflight += 1;
    return Promise.resolve({ instance: inst, release: releaseFn(inst, st) });
  }
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, started, timer: null };
    entry.timer = setTimeout(() => {
      const i = st.queue.indexOf(entry);
      if (i >= 0) st.queue.splice(i, 1);
      st.queued = st.queue.length;
      reject(new Error(`key instance ${inst.keyId} is saturated (${st.max} in flight) — falling through`));
    }, QUEUE_TIMEOUT_MS);
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
    st.queue.push(entry);
    st.queued = st.queue.length;
  });
}

/** Record one measured call against the instance that ran it. */
function note(laneOrKeyId, { ok = true, ms = 0, model = '' } = {}) {
  const inst = typeof laneOrKeyId === 'object' && laneOrKeyId && laneOrKeyId.keyId
    ? laneOrKeyId
    : forLane(laneOrKeyId);
  const st = stateFor(inst.keyId);
  const took = Math.max(0, Math.round(Number(ms) || 0));
  st.requests += 1;
  if (!ok) st.failures += 1;
  st.lastMs = took;
  st.lastAt = new Date().toISOString();
  st.ewmaMs = st.ewmaMs == null ? took : Math.round(st.ewmaMs * 0.7 + took * 0.3);
  st.model = String(model || '').slice(0, 80) || st.model || null;
  return st;
}

/** Health from what the instance actually did, never from a timer. */
function healthOf(st) {
  if (!st.requests) return 'idle';
  const failRate = st.failures / st.requests;
  if (failRate >= 0.5) return 'degraded';
  if (failRate > 0) return 'flaky';
  return 'ok';
}

/**
 * One row per key, in registry order, then any unattributed lane that actually
 * ran. Owner-only accounting shape (§25, §52.4) — ids and figures, never a key
 * value, which this module never sees.
 */
function status() {
  const rows = registry().keys.slice();
  const seen = new Set(rows.map((k) => k && k.id));
  const out = rows.map((row) => {
    const inst = forLane(row.id);
    return describe(inst, stateFor(row.id));
  });
  for (const [keyId, st] of states.entries()) {
    if (seen.has(keyId)) continue;
    out.push(describe(forLane(keyId), st));
  }
  return out;
}

function describe(inst, st) {
  return {
    keyId: inst.keyId,
    label: inst.label,
    user: inst.user,
    userLabel: inst.userLabel,
    client: inst.client,
    provider: inst.provider,
    lane: inst.lane,
    lanes: inst.lanes,
    transport: inst.transport,
    attributed: inst.attributed,
    maxConcurrency: st.max || inst.maxConcurrency,
    inflight: st.inflight,
    queued: st.queued,
    requests: st.requests,
    failures: st.failures,
    avgLatencyMs: st.ewmaMs,
    lastLatencyMs: st.lastMs,
    lastAt: st.lastAt,
    lastModel: st.model || null,
    // A warm pool is the point of the instance: true only once it has answered.
    poolWarm: Boolean(st.dispatcher && st.requests > 0),
    health: healthOf(st),
  };
}

/** Test / maintenance hook. Never called by a request path. */
function reset() {
  for (const st of states.values()) {
    try { if (st.dispatcher) st.dispatcher.close(); } catch (_) { /* already gone */ }
  }
  states.clear();
  registryCache = null;
  registryCacheAt = 0;
}

module.exports = {
  acquire,
  note,
  status,
  reset,
  forLane,
  keyIdForLane,
  dispatcherFor,
  UNATTRIBUTED,
  LIMIT_HTTP,
  LIMIT_RELAY,
  LIMIT_CLI,
};
