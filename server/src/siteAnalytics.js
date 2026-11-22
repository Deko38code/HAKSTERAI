'use strict';

// Lightweight first-party site analytics. IP addresses are never retained:
// this process stores only salted hashes, and the salt lives in data/ so the
// hashes stay stable across restarts (unique-IP counts do not double-count a
// returning visitor just because the server restarted).
//
// Persistence (owner, 2026-11-22: "need traffic working at all times"): every
// event is appended to data/site-analytics.jsonl and reloaded on boot, so the
// rolling-24h traffic survives deploys and restarts instead of resetting to 0.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SITE_ANALYTICS_DIR || path.join(__dirname, '..', '..', 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'site-analytics.jsonl');
const SALT_FILE = path.join(DATA_DIR, '.site-analytics-salt');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const ACTIVE_MS = 5 * 60 * 1000;
const MAX_EVENTS = 50000;
const PRUNE_MS = 60 * 60 * 1000;

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

function loadSalt() {
  try {
    const s = fs.readFileSync(SALT_FILE);
    if (s.length >= 32) return s;
  } catch {}
  const s = crypto.randomBytes(32);
  try { fs.writeFileSync(SALT_FILE, s, { mode: 0o600 }); } catch {}
  return s;
}
const SALT = loadSalt();

function hashIp(ip) {
  return crypto.createHmac('sha256', SALT).update(String(ip || 'unknown')).digest('hex');
}

function cleanPath(value) {
  const p = String(value || '/').split(/[?#]/, 1)[0];
  return /^\/[A-Za-z0-9_./-]{0,120}$/.test(p) ? p : '/';
}

function loadEvents() {
  let raw = '';
  try { raw = fs.readFileSync(EVENTS_FILE, 'utf8'); } catch { return []; }
  const cutoff = Date.now() - WINDOW_MS;
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || !Number.isFinite(e.at) || e.at < cutoff) continue;
    if (!['view', 'beat', 'click'].includes(e.kind)) continue;
    out.push({ at: e.at, kind: e.kind, ipHash: String(e.ipHash || ''), visitor: String(e.visitor || '').slice(0, 64) || String(e.ipHash || ''), path: cleanPath(e.path) });
  }
  return out.slice(-MAX_EVENTS);
}

const events = loadEvents();
const lastClickByIp = new Map();

let lastPruneAt = 0;

function writeFileSync() {
  // Rewrite the whole file from memory (drops lines older than 24h).
  try { fs.writeFileSync(EVENTS_FILE, events.map((e) => JSON.stringify(e)).join('\n') + '\n'); } catch {}
}

function persist(item) {
  // Synchronous append: no event can be lost if the process is restarted
  // mid-flight (deploy auto-apply, crash, pm2 reload). Volume is tiny.
  try { fs.appendFileSync(EVENTS_FILE, JSON.stringify(item) + '\n'); } catch {}
  const now = Date.now();
  if (now - lastPruneAt >= PRUNE_MS) {
    lastPruneAt = now;
    writeFileSync();
  }
}

function record(ip, body) {
  const kind = String(body?.kind || '');
  if (!['view', 'beat', 'click'].includes(kind)) return false;
  const ipHash = hashIp(ip);
  const now = Date.now();
  const recent = lastClickByIp.get(ipHash) || 0;
  if (kind === 'click' && now - recent < 300) return false;
  if (kind === 'click') lastClickByIp.set(ipHash, now);
  const visitor = String(body?.visitor || '').slice(0, 64) || ipHash;
  const item = { at: now, kind, ipHash, visitor, path: cleanPath(body?.path) };
  events.push(item);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  const cutoff = now - WINDOW_MS;
  while (events.length && events[0].at < cutoff) events.shift();
  if (lastClickByIp.size > MAX_EVENTS) {
    for (const [key, at] of lastClickByIp) {
      if (now - at > WINDOW_MS) lastClickByIp.delete(key);
    }
  }
  persist(item);
  return true;
}

function summary() {
  const now = Date.now();
  const recent = events.filter((item) => now - item.at <= WINDOW_MS);
  const active = recent.filter((item) => now - item.at <= ACTIVE_MS);
  const views = recent.filter((item) => item.kind === 'view').length;
  const clicks = recent.filter((item) => item.kind === 'click').length;
  const activeVisitors = new Set(active.map((item) => item.visitor)).size;
  const uniqueIps = new Set(recent.map((item) => item.ipHash)).size;
  const paths = new Map();
  for (const item of recent) {
    if (item.kind === 'view') paths.set(item.path, (paths.get(item.path) || 0) + 1);
  }
  return {
    generatedAt: new Date(now).toISOString(),
    window: 'rolling 24h; active visitors use a rolling 5m window',
    processLocal: true,
    persisted: true,
    visitors5m: activeVisitors,
    pageViews24h: views,
    clicks24h: clicks,
    uniqueIps24h: uniqueIps,
    topPages: [...paths].map(([path, count]) => ({ path, views: count }))
      .sort((a, b) => b.views - a.views).slice(0, 8),
  };
}

module.exports = { record, summary };
