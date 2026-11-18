'use strict';
/**
 * Front proxy — the stable listener a frozen tunnel can point at forever.
 *
 * It owns one port (3579 in the eventual production design; anything else for
 * tests) and forwards to whichever release is active. Switching releases is a
 * pointer assignment, so it is atomic with respect to request routing: a
 * request picks an upstream once, at its first byte, and keeps it.
 *
 * What it is careful about:
 *   - streaming: request and response are piped, never buffered. SSE chunks
 *     reach the client as they are written (a flush-timing test asserts this).
 *   - long requests: a request already in flight is NEVER moved. The switch
 *     only affects requests that have not started yet.
 *   - draining: the old upstream is marked draining; when its open connections
 *     reach zero (or the grace period expires) it is reported drained.
 *   - failover: if a connection fails before any response byte, the request is
 *     retried once on the other upstream. After bytes have flowed it is not
 *     retried — a partial response is never silently replayed.
 *   - WebSocket: upgrade requests are tunnelled over raw sockets.
 *   - the control surface is bound to loopback and requires a token file; it
 *     is never exposed through the public listener.
 *
 * Nothing here starts, stops, builds or deletes anything.
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTROL_TOKEN_FILE = path.join(__dirname, 'data', 'front-control.token');

function controlToken() {
  try { return fs.readFileSync(CONTROL_TOKEN_FILE, 'utf8').trim(); } catch (_) { return null; }
}

function createFront(opts = {}) {
  const listenPort = opts.port || 3590;
  const controlPort = opts.controlPort || listenPort + 1;
  const upstreams = opts.upstreams || { blue: 3580, green: 3581 };
  const state = {
    active: opts.active || 'blue',
    draining: {},          // name -> true
    conns: {},             // name -> open socket count
    requests: 0,
    switchedAt: null,
    history: [],
    lastError: {},
  };
  for (const k of Object.keys(upstreams)) { state.conns[k] = 0; state.draining[k] = false; }
  const server = http.createServer(handle);
  const wss = new Set();

  function target(name) { return { name, port: upstreams[name] }; }

  function pickForRetry(failed) {
    return Object.keys(upstreams).find((n) => n !== failed && !state.draining[n]) || null;
  }

  function handle(req, res) {
    state.requests++;
    const first = target(state.active);
    forward(req, res, first, true);
  }

  function forward(req, res, t, mayRetry) {
    const startedAt = Date.now();
    const upReq = http.request({
      host: '127.0.0.1',
      port: t.port,
      method: req.method,
      path: req.url,
      // One socket per request, deliberately. Node's global agent keeps sockets
      // alive, which makes "how many connections is this release serving?" — the
      // number draining depends on — unknowable, and lets a socket outlive the
      // request that used it. A drained release must have ZERO sockets.
      agent: false,
      headers: { ...req.headers, 'x-forwarded-by': 'release-engine-front' },
    }, (upRes) => {
      // Bytes are flowing: from here a retry would duplicate side effects.
      res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.headers);
      upRes.pipe(res);           // piped, never buffered
      upRes.on('end', () => upRes.end && undefined);
    });
    state.conns[t.name]++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.conns[t.name] = Math.max(0, state.conns[t.name] - 1);
    };
    upReq.on('socket', (s) => { s.on('close', release); s.setNoDelay(true); });
    upReq.on('error', (e) => {
      release();
      state.lastError[t.name] = { at: new Date().toISOString(), code: e.code || e.message };
      const retryName = mayRetry ? pickForRetry(t.name) : null;
      if (retryName && !res.headersSent) {
        forward(req, res, target(retryName), false);
        return;
      }
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream unavailable', upstream: t.name })); }
      else { try { res.destroy(); } catch (_) {} }
    });
    res.on('close', () => { release(); try { upReq.destroy(); } catch (_) {} });
    req.pipe(upReq);
    res.on('finish', () => { state.history.push({ at: new Date().toISOString(), ms: Date.now() - startedAt, upstream: t.name, path: req.url, status: res.statusCode }); if (state.history.length > 500) state.history.shift(); });
  }

  // WebSocket / upgrade: raw tunnelling, no protocol awareness needed.
  server.on('upgrade', (req, socket, head) => {
    const t = target(state.active);
    const up = net.connect(t.port, '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      socket.pipe(up); up.pipe(socket);
    });
    state.conns[t.name]++;
    let closed = false;
    const done = () => { if (closed) return; closed = true; state.conns[t.name] = Math.max(0, state.conns[t.name] - 1); };
    // An upgraded socket can HALF-close: when the peer goes away Node emits
    // 'end' on our side and no 'close' until something destroys the socket.
    // Accounting on 'close' alone therefore leaks, and a leaked count means a
    // release can never be reported drained — a switch would always burn the
    // full grace period. Every terminal event funnels into one idempotent
    // teardown that closes both ends and counts the connection exactly once.
    const teardown = () => {
      done();
      try { up.destroy(); } catch (_) {}
      try { socket.destroy(); } catch (_) {}
    };
    for (const ev of ['end', 'close', 'error']) { up.on(ev, teardown); socket.on(ev, teardown); }
  });

  function switchTo(name, reason) {
    if (!upstreams[name]) return { ok: false, error: 'unknown upstream ' + name };
    const from = state.active;
    state.active = name;                 // atomic as far as routing is concerned
    // The upstream we just made active is, by definition, no longer draining.
    // Without this, a release switched back into service stays flagged and
    // failover will refuse to use it — a live upstream treated as dead.
    state.draining[name] = false;
    state.switchedAt = new Date().toISOString();
    state.history.push({ at: state.switchedAt, event: 'switch', from, to: name, reason: reason || null });
    return { ok: true, from, to: name, openConnectionsOnOld: state.conns[from] };
  }

  function drain(name, graceMs = 60000) {
    if (name === state.active) return { ok: false, error: 'refusing to drain the active upstream' };
    if (!upstreams[name]) return { ok: false, error: 'unknown upstream' };
    state.draining[name] = true;
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const left = state.conns[name];
        if (left === 0) return resolve({ ok: true, drained: true, ms: Date.now() - startedAt, remaining: 0 });
        if (Date.now() - startedAt >= graceMs) return resolve({ ok: true, drained: false, ms: Date.now() - startedAt, remaining: left, note: 'grace expired; sockets left to finish on their own' });
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  function info() {
    return { active: state.active, draining: state.draining, conns: state.conns, requests: state.requests, switchedAt: state.switchedAt, upstreams, lastError: state.lastError, recent: state.history.slice(-10) };
  }

  const control = http.createServer((req, res) => {
    const token = controlToken();
    const given = req.headers['x-control-token'];
    if (!token || given !== token) { res.writeHead(403); return res.end(); }
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/__state') return res.end(JSON.stringify(info(), null, 2));
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch (_) {}
      if (req.url === '/__switch') return res.end(JSON.stringify(switchTo(payload.to, payload.reason)));
      if (req.url === '/__drain') return res.end(JSON.stringify(await drain(payload.name, payload.graceMs)));
      res.writeHead(404); res.end();
    });
  });

  return {
    server, control, state,
    listen: () => new Promise((r) => server.listen(listenPort, '127.0.0.1', r)),
    listenControl: () => new Promise((r) => control.listen(controlPort, '127.0.0.1', r)),
    close: () => new Promise((r) => { server.close(() => control.close(() => r())); }),
    switchTo, drain, info, pickForRetry,
  };
}

function writeControlToken() {
  try {
    fs.mkdirSync(path.dirname(CONTROL_TOKEN_FILE), { recursive: true });
    if (!fs.existsSync(CONTROL_TOKEN_FILE)) {
      fs.writeFileSync(CONTROL_TOKEN_FILE, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
    }
    return true;
  } catch (_) { return false; }
}

module.exports = { createFront, writeControlToken, CONTROL_TOKEN_FILE };

if (require.main === module) {
  // Standalone form: node front-proxy.cjs [--port 3590] [--blue 3580] [--green 3581]
  const argv = {};
  for (let i = 2; i < process.argv.length; i += 2) argv[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  writeControlToken();
  const front = createFront({
    port: Number(argv.port) || 3590,
    controlPort: Number(argv.controlPort) || (Number(argv.port) || 3590) + 1,
    upstreams: { blue: Number(argv.blue) || 3580, green: Number(argv.green) || 3581 },
    active: argv.active || 'blue',
  });
  front.listen().then(() => front.listenControl()).then(() => {
    console.log('front proxy on', Number(argv.port) || 3590, 'control on', (Number(argv.port) || 3590) + 1, '— token file', CONTROL_TOKEN_FILE);
  });
}
