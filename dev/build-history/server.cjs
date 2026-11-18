'use strict';
/**
 * ISOLATED DEVELOPMENT SERVER — port 3999, not under PM2, not behind a tunnel.
 *
 * It exists so the HaksterAI live applet and the Build History system can be
 * exercised end to end without touching production: no hakster restart, no
 * dist/ write, no Cloudflare route, no PhantomIDE or Junkalot access.
 *
 * Every administrative route here is bound to loopback. The feed route is the
 * only cross-service surface and it requires its own dedicated token.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const store = require('./lib/store.cjs');
const feed = require('./lib/feed.cjs');
const recorder = require('./lib/recorder.cjs');
const stability = require('./lib/stability.cjs');
const livejob = require('./lib/livejob.cjs');
const { mountAppletStream } = require('../applet/stream.cjs');

const PORT = Number(process.env.HP_DEV_PORT || 3999);
const DEV = path.join(__dirname, '..');
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// ── dev owner credential (generated once, 0600, never printed) ──────────────
const DEV_CRED = path.join(__dirname, 'data', 'dev-owner.json');
function devCredential() {
  try { return JSON.parse(fs.readFileSync(DEV_CRED, 'utf8')); } catch (_) {}
  const cred = { token: crypto.randomBytes(24).toString('hex'), role: 'owner', createdAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(DEV_CRED), { recursive: true });
  fs.writeFileSync(DEV_CRED, JSON.stringify(cred, null, 2), { mode: 0o600 });
  return cred;
}
const devOwner = devCredential();

const loopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip || req.socket?.remoteAddress || '');
function isDevOwner(req) {
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const key = req.headers['x-api-key'] || bearer || '';
  if (!key) return false;
  const a = Buffer.from(key), b = Buffer.from(devOwner.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const requireDevOwner = (req, res, next) => {
  if (!loopback(req)) return res.status(403).json({ error: 'isolated dev server: loopback only' });
  if (!isDevOwner(req)) return res.status(401).json({ error: 'dev owner token required' });
  next();
};

// ── applet stream (same module production will mount) ──────────────────────
const applet = mountAppletStream(app, {
  getUserByKey: (key) => {
    const a = Buffer.from(key), b = Buffer.from(devOwner.token);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { id: 'dev-owner', email: 'owner@localhost', role: 'admin' };
    }
    return null;
  },
  isOwner: (user) => Boolean(user && user.role === 'admin'),
});

// ── build history API ──────────────────────────────────────────────────────
app.get('/api/build-history/list', requireDevOwner, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(store.query({
    project: req.query.project || undefined,
    status: req.query.status || undefined,
    buildId: req.query.buildId || undefined,
    since: req.query.since || undefined,
    limit: req.query.limit || 100,
  }));
});

app.get('/api/build-history/build/:buildId', requireDevOwner, (req, res) => {
  const { rows } = store.readAll();
  const rec = rows.find((r) => r.buildId === req.params.buildId);
  if (!rec) return res.status(404).json({ error: 'unknown build id' });
  res.set('Cache-Control', 'no-store');
  res.json(rec);
});

app.get('/api/build-history/stats', requireDevOwner, (_req, res) => res.json(store.stats()));

app.get('/api/build-history/stability', requireDevOwner, async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await stability.snapshot(true));
});

app.get('/api/build-history/audit', requireDevOwner, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, 500);
  const file = stability.AUDIT_FILE;
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse();
    res.set('Cache-Control', 'no-store');
    res.json({ count: lines.length, entries: lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) });
  } catch (e) {
    res.json({ count: 0, entries: [], detail: e.code === 'ENOENT' ? 'no transitions logged yet' : e.message });
  }
});

app.get('/api/build-history/live-job', requireDevOwner, (_req, res) => {
  res.set('Cache-Control', 'no-store').json(livejob.summary());
});

app.post('/api/build-history/run', requireDevOwner, async (req, res) => {
  const { record, key, error } = await recorder.runBuild({
    trigger: req.body?.trigger || 'dev-manual',
    requestedBy: 'dev-owner',
    runTests: Boolean(req.body?.tests),
  });
  res.json({ ok: !error, key, error: error || null, record });
});

// ── cross-project feed (dedicated least-privilege token) ───────────────────
app.get('/api/build-history/feed', async (req, res) => {
  if (!feed.authorized(req)) return res.status(401).json({ error: 'feed token required' });
  const { rows } = store.query({ project: 'haksterai', limit: Number(req.query.limit) || 50, since: req.query.since });
  const st = await stability.snapshot();
  res.set('Cache-Control', 'no-store');
  res.json({
    feed: 'haksterai-builds',
    version: 2,
    generatedAt: new Date().toISOString(),
    scope: 'metadata-only',
    count: rows.length,
    builds: rows.map(feed.sanitize),
    // Applet lifecycle events for this project only: event name, build id,
    // stage, percent and the server's UTC timestamp. Detail text stays here —
    // it can name local paths, and the receiving dashboard has no need for it.
    events: livejob.readAudit(60).map((e) => ({
      at: e.at, project: e.project, event: e.event,
      buildId: e.buildId, stage: e.stage, percent: e.percent,
    })),
    // Stability travels as a projection too: state, reason, window and per-check
    // status only. Check detail text, logs and host paths stay on this box.
    stability: {
      state: st.state,
      reason: st.reason,
      window: st.window,
      timestamps: {
        lastCheckAt: st.timestamps.lastCheckAt,
        lastDeployedAt: st.timestamps.lastDeployedAt,
        deployedBuildId: st.timestamps.deployedBuildId,
        stableForSec: st.timestamps.stableForSec,
      },
      checks: (st.checks || []).map((c) => ({ id: c.id, status: c.status })),
    },
  });
});

app.get('/api/build-history/feed-credential', requireDevOwner, (_req, res) => {
  // Metadata only. The token itself is never returned by any route.
  res.json(feed.publicMeta());
});

// ── pages ─────────────────────────────────────────────────────────────────
app.use('/applet', express.static(path.join(DEV, 'applet'), { index: 'applet.html' }));
app.get('/admin/build-history', (req, res) => {
  // Loopback dev panel: the dev owner token is injected at serve time so the
  // page can call the same owner-gated API. The token is never printed and the
  // route is unreachable from anywhere but this machine.
  if (!loopback(req)) return res.status(403).send('isolated dev server: loopback only');
  const html = fs.readFileSync(path.join(__dirname, 'public', 'panel.html'), 'utf8')
    .replace('__DEV_TOKEN__', devOwner.token);
  res.set('Cache-Control', 'no-store').type('html').send(html);
});
app.get('/', (_req, res) => res.redirect('/applet/'));

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev] isolated server on http://127.0.0.1:${PORT}`);
  console.log(`[dev] applet preview   http://127.0.0.1:${PORT}/applet/`);
  console.log(`[dev] build history    http://127.0.0.1:${PORT}/admin/build-history`);
  console.log(`[dev] applet streams open: ${applet.activeStreams()}`);
  console.log('[dev] not under PM2, not behind a tunnel, production untouched');
});

module.exports = { app, server };
