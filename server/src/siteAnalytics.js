'use strict';

// Lightweight first-party site analytics. IP addresses are never retained:
// this process uses a random, per-start salt and stores only salted hashes.
const crypto = require('crypto');

const SALT = crypto.randomBytes(32);
const WINDOW_MS = 24 * 60 * 60 * 1000;
const ACTIVE_MS = 5 * 60 * 1000;
const MAX_EVENTS = 50000;
const events = [];
const lastClickByIp = new Map();

function hashIp(ip) {
  return crypto.createHmac('sha256', SALT).update(String(ip || 'unknown')).digest('hex');
}

function cleanPath(value) {
  const path = String(value || '/').split(/[?#]/, 1)[0];
  return /^\/[A-Za-z0-9_./-]{0,120}$/.test(path) ? path : '/';
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
    visitors5m: activeVisitors,
    pageViews24h: views,
    clicks24h: clicks,
    uniqueIps24h: uniqueIps,
    topPages: [...paths].map(([path, count]) => ({ path, views: count }))
      .sort((a, b) => b.views - a.views).slice(0, 8),
  };
}

module.exports = { record, summary };
