'use strict';
/**
 * HaksterAI live applet — authenticated real-time stream.
 *
 * GET /api/applet/stream   text/event-stream, one snapshot frame per change
 * GET /api/applet/status   the same snapshot as plain JSON (fallback / probes)
 *
 * Authentication is by header only — `x-api-key: <key>` or `Authorization:
 * Bearer <key>` — never a query string, so a key can't leak into access logs,
 * browser history or a Referer. EventSource cannot send headers, so the client
 * uses fetch() + a ReadableStream reader and parses the SSE frames itself.
 *
 * Scope is decided server-side and can only get narrower, never wider:
 *   owner     a configured owner account  -> full telemetry
 *   user      any other active account    -> measured resource use, no paths
 *   public    no key / unknown key        -> build id, up/down, uptime, job state
 *
 * Everything streamed here is measured at read time (see telemetry.js). The
 * job block carries a percentage only when one can actually be computed; when
 * it cannot, `percent` is null and `indeterminate` is true so the applet shows
 * motion without inventing a number.
 */

const crypto = require('crypto');
const telemetry = require('./telemetry.cjs');
const livejob = require('../build-history/lib/livejob.cjs');

const HEARTBEAT_MS = 15000;
const RECHECK_MS = 2000;
const MAX_STREAMS_PER_IP = 6;
const MAX_EVENTS_PER_MIN = 120;

function resolveScope(req, deps) {
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const key = req.headers['x-api-key'] || bearer || '';
  if (!key || key.length < 8) return { scope: 'public', user: null };
  let user = null;
  try { user = deps.getUserByKey ? deps.getUserByKey(key) : null; } catch (_) { user = null; }
  if (!user) return { scope: 'public', user: null };
  let owner = false;
  try { owner = deps.isOwner ? deps.isOwner(user) : false; } catch (_) { owner = false; }
  return { scope: owner ? 'owner' : 'user', user };
}

async function snapshotFor(scope) {
  if (scope === 'owner') return telemetry.ownerSnapshot();
  if (scope === 'user') return telemetry.userSnapshot();
  return telemetry.publicSnapshot();
}

function hashOf(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function mountAppletStream(app, deps) {
  const streamsByIp = new Map();
  const eventsByIp = new Map();

  app.get('/api/applet/stream', async (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const open = streamsByIp.get(ip) || 0;
    if (open >= MAX_STREAMS_PER_IP) {
      return res.status(429).json({ error: 'Too many applet streams from this address' });
    }
    streamsByIp.set(ip, open + 1);

    const { scope } = resolveScope(req, deps);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Applet-Scope': scope,
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    let lastHash = '';
    let lastSend = 0;

    const send = (event, payload) => {
      if (closed) return;
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (_) { /* client vanished; cleanup runs on close */ }
    };

    const push = async (force) => {
      if (closed) return;
      let snap;
      try { snap = await snapshotFor(scope); } catch (e) {
        send('error', { type: 'error', message: 'telemetry unavailable', detail: e.code || e.message });
        return;
      }
      const hash = hashOf(snap);
      const now = Date.now();
      if (force || hash !== lastHash || now - lastSend >= 10000) {
        lastHash = hash;
        lastSend = now;
        snap.seq = now;
        send('snapshot', snap);
      }
    };

    const heartbeat = setInterval(() => {
      if (closed) return;
      try { res.write(': ping\n\n'); } catch (_) {}
    }, HEARTBEAT_MS);

    const tick = setInterval(() => { push(false); }, RECHECK_MS);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(tick);
      const left = (streamsByIp.get(ip) || 1) - 1;
      if (left <= 0) streamsByIp.delete(ip); else streamsByIp.set(ip, left);
      try { res.end(); } catch (_) {}
    };

    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);

    send('hello', { type: 'hello', scope, site: 'haksterai', box: 'dell', checkedAt: new Date().toISOString() });
    await push(true);
  });

  app.get('/api/applet/status', async (req, res) => {
    const { scope } = resolveScope(req, deps);
    try {
      const snap = await snapshotFor(scope);
      res.set('Cache-Control', 'no-store');
      res.set('X-Applet-Scope', scope);
      res.json(snap);
    } catch (e) {
      console.error('[applet/status] telemetry unavailable:', e);
      res.status(500).json({ error: 'telemetry unavailable', scope });
    }
  });

  /**
   * POST /api/applet/event — the applet's UI transitions land in the owning
   * project's audit log. Only whitelisted event names are stored, the server
   * stamps the UTC time (a client clock is never trusted), and public applets
   * cannot write. Rate limited per address so a looping tab cannot flood it.
   */
  app.post('/api/applet/event', (req, res) => {
    const { scope } = resolveScope(req, deps);
    if (scope !== 'owner') {
      return res.status(403).json({ error: 'owner scope required to record audit events' });
    }
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = eventsByIp.get(ip) || { at: now, n: 0 };
    if (now - bucket.at > 60000) { bucket.at = now; bucket.n = 0; }
    bucket.n += 1;
    eventsByIp.set(ip, bucket);
    if (bucket.n > MAX_EVENTS_PER_MIN) return res.status(429).json({ error: 'event rate limit reached' });

    const body = req.body || {};
    const result = livejob.audit({
      event: body.event,
      buildId: body.buildId,
      stage: body.stage,
      percent: body.percent,
      detail: body.detail,
      scope,
    });
    if (!result.ok) return res.status(400).json(result);
    res.set('Cache-Control', 'no-store').json({ ok: true, at: result.line.at, event: result.line.event });
  });

  /** GET /api/applet/events — the same audit log, newest first, owner only. */
  app.get('/api/applet/events', (req, res) => {
    const { scope } = resolveScope(req, deps);
    if (scope !== 'owner') return res.status(403).json({ error: 'owner scope required' });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.set('Cache-Control', 'no-store').json({ count: limit, entries: livejob.readAudit(limit) });
  });

  return {
    activeStreams: () => Array.from(streamsByIp.values()).reduce((a, b) => a + b, 0),
  };
}

module.exports = { mountAppletStream };
