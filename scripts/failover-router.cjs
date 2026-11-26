#!/usr/bin/env node
/* failover-router.cjs — one port in front of two haksterAi boxes.
 *
 * Owner, 2026-11-25: "if dell server drops for period of time lenovo kicks in" /
 * "if we can get both to serve are requst users would make more better faster
 * power per box" / "not if it breaks or tunnles cause i have alot of ads etc
 * running off tunnels" / "no user gets errors we need both online at all times".
 *
 * The tunnel is never touched. cloudflared keeps dialling 127.0.0.1:3579 exactly
 * as it does today (haksterai-dell.yml, tunnel c5e39c69). This router is what
 * listens there instead: the Dell app moves to 3580, the Lenovo answers behind
 * its own router, and this router decides per request. No ingress edit, no DNS,
 * no connector change, no credential.
 *
 * Routing rules (deliberately conservative — state correctness first):
 *   · stateful paths (/api/*, /admin*, /login, /auth, /callback, PUT/POST/
 *     PATCH/DELETE anywhere) always go to PRIMARY. Two SQLite files cannot be
 *     written by two boxes; the Dell stays the only writer.
 *   · static GET/HEAD (marketing pages, /_astro/, ads' landing pages) are
 *     served round-robin by both boxes — that is the load actually shared,
 *     and it needs no shared state because the bytes are identical.
 *   · PRIMARY down  -> everything goes to a PEER (the failover the owner asked for).
 *   · no PEER up    -> everything goes to PRIMARY.
 *   · both down     -> 502, honestly reported, never a fake success.
 *
 * BLUE-GREEN (added for "both online at all times"): a box can run its app in
 * two slots on two ports. PEER_URLS names them in order and only the ACTIVE
 * one takes traffic; `POST /router/peer {"url": ...}` moves the active slot.
 * The sync boots the idle slot, waits for it to answer, then switches — so
 * there is never an instant with no peer serving, and an update costs a user
 * nothing.
 *
 * SECOND DOOR: SHARED_LISTEN (e.g. 0.0.0.0:3581) opens a second listener that
 * forwards everything to the active slot. That is the address the OTHER box
 * dials as its peer, so it needs no change when the active slot moves.
 *
 * Liveness is /api/version (200 = alive). /api/health is NOT used: a node with
 * no Stripe key reports "degraded" and still serves pages correctly.
 *
 * Env:
 *   ROUTER_LISTEN   default 127.0.0.1:3579
 *   PRIMARY_URL     default http://127.0.0.1:3580
 *   PEER_URLS       comma-separated slots, e.g. http://127.0.0.1:3591,http://127.0.0.1:3592
 *   PEER_URL        default http://10.0.0.210:3579   (single-peer form, still supported)
 *   SHARED_LISTEN   optional second door that always serves the active slot
 *   ROUTER_LOG      default ./router.log (append, one line per unusual event)
 *   ROUTER_STATIC   "share" (default) | "primary"
 */
'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const { URL } = require('node:url');

const LISTEN = parseAddr(process.env.ROUTER_LISTEN || '127.0.0.1:3579');
const PRIMARY = new URL(process.env.PRIMARY_URL || 'http://127.0.0.1:3580');
const PEERS = (process.env.PEER_URLS || process.env.PEER_URL || 'http://10.0.0.210:3579')
  .split(',').map((s) => s.trim()).filter(Boolean).map((u) => new URL(u));
const SHARED_LISTEN = process.env.SHARED_LISTEN ? parseAddr(process.env.SHARED_LISTEN) : null;
const STATIC_MODE = process.env.ROUTER_STATIC || 'share';
const LOG_FILE = process.env.ROUTER_LOG || '';

const HEALTH_MS = 5000;
const PROBE_TIMEOUT_MS = 2500;
const UPSTREAM_TIMEOUT_MS = 30000;

// Paths that must never be shared: they read or write account state.
// /miniforge/app is the signed-in bot app the login lands on. Its page is a
// single file on each box's own disk and nothing syncs it, so sharing it handed
// half the traffic the standby's stale build (2026-11-26: the Nov 3 Pandemonium
// page, 5 of 10 loads). Only the primary serves it while both boxes are alive;
// a real failover still reaches the peer, as it always did.
// 2026-11-26: /cli/ and the installers join this list for the same reason
// /miniforge/app did. The router round-robins stateless GETs, but the standby
// only carries the CLI tree the §41 sync last pushed — and while that sync is
// HELD its /cli/latest.json answered 0.3.79 against the Dell's 0.3.82, so an
// install took the old build on every second attempt (measured: 10 of 10
// alternating). /cli/authorize also mints and redeems device codes against the
// Dell's own database. Only the primary serves these while both boxes are
// alive; a real failover still reaches the peer, exactly as /miniforge/app does.
const STATEFUL_PREFIX = ['/api/', '/admin', '/login', '/auth', '/callback', '/oauth', '/logout', '/miniforge/app', '/cli/', '/install.sh', '/install.ps1'];
// Long-lived streams: no socket timeout, keep the pipe open.
const STREAM_PREFIX = ['/api/agent/run', '/api/tui', '/api/stream', '/api/events'];

const state = {
  primary: { alive: null, checkedAt: 0, fails: 0 },
  peers: PEERS.map(() => ({ alive: null, checkedAt: 0, fails: 0 })),
  // Which slot the router *prefers*. Blue-green moves this, one slot at a time.
  active: 0,
  turn: 0,
  startedAt: Date.now(),
  served: { primary: 0, peer: 0, failed: 0 },
  servedByPeer: PEERS.map(() => 0),
  switches: 0,
  lastSwitchAt: null,
  // Requests a peer answered *because* the primary was down. A non-zero
  // value means a peer may hold writes the Dell does not: the DB sync
  // must stop until the owner decides which copy wins.
  failovers: 0,
  lastFailoverAt: null,
};

function parseAddr(spec) {
  const i = spec.lastIndexOf(':');
  return { host: spec.slice(0, i) || '127.0.0.1', port: Number(spec.slice(i + 1)) };
}

function log(line) {
  const stamp = new Date().toISOString();
  const text = `${stamp} ${line}`;
  process.stderr.write(text + '\n');
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, text + '\n'); } catch { /* logging never breaks routing */ }
  }
}

function base(u) {
  return `${u.protocol}//${u.host}`;
}

function isStateful(req) {
  const path = (req.url || '/').split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') return true;
  return STATEFUL_PREFIX.some((p) => path === p || path.startsWith(p));
}

function isStream(req) {
  const path = (req.url || '/').split('?')[0];
  return STREAM_PREFIX.some((p) => path.startsWith(p));
}

/** The slot that should take peer traffic: the active one if it is alive. */
function alivePeerIndex() {
  if (state.peers[state.active] && state.peers[state.active].alive !== false) return state.active;
  for (let i = 0; i < state.peers.length; i += 1) {
    if (state.peers[i].alive !== false) return i;
  }
  return -1;
}

/** Which upstream gets this request, given current liveness. */
function pick(req) {
  const primaryUp = state.primary.alive !== false;
  const peerIdx = alivePeerIndex();
  const peerUp = peerIdx >= 0;

  if (!primaryUp && peerUp) return { side: 'peer', index: peerIdx };  // Dell down, a slot serves
  if (primaryUp && !peerUp) return { side: 'primary', index: -1 };
  if (!primaryUp && !peerUp) return null;                             // both down

  // Both alive: state stays on the Dell, static traffic is shared.
  if (isStateful(req) || STATIC_MODE === 'primary') return { side: 'primary', index: -1 };
  state.turn += 1;
  return state.turn % 2 === 0 ? { side: 'peer', index: peerIdx } : { side: 'primary', index: -1 };
}

function targetFor(side, index) {
  const u = side === 'peer' ? (PEERS[index] || PEERS[0]) : PRIMARY;
  return { host: u.hostname, port: Number(u.port || 80) };
}

function probePrimary() {
  const started = Date.now();
  const req = http.request({
    host: PRIMARY.hostname, port: Number(PRIMARY.port || 80), path: '/api/version', method: 'GET',
    timeout: PROBE_TIMEOUT_MS,
    headers: { 'user-agent': 'hakster-failover-router', 'x-forwarded-by': 'router' },
  }, (res) => {
    res.resume();
    const ok = res.statusCode === 200;
    const s = state.primary;
    s.fails = ok ? 0 : s.fails + 1;
    if (!ok && s.fails >= 2 && s.alive !== false) log(`node primary reported ${res.statusCode} - treating as DOWN`);
    s.alive = ok ? true : (s.fails >= 2 ? false : s.alive);
    s.checkedAt = Date.now();
    void started;
  });
  req.on('timeout', () => req.destroy(new Error('probe timeout')));
  req.on('error', () => {
    const s = state.primary;
    s.fails += 1;
    if (s.fails >= 2 && s.alive !== false) log('node primary unreachable - treating as DOWN');
    if (s.fails >= 2) s.alive = false;
    s.checkedAt = Date.now();
  });
  req.end();
}

function probePeer(i) {
  const u = PEERS[i];
  const s = state.peers[i];
  const req = http.request({
    host: u.hostname, port: Number(u.port || 80), path: '/api/version', method: 'GET',
    timeout: PROBE_TIMEOUT_MS,
    headers: { 'user-agent': 'hakster-failover-router', 'x-forwarded-by': 'router' },
  }, (res) => {
    res.resume();
    const ok = res.statusCode === 200;
    s.fails = ok ? 0 : s.fails + 1;
    if (!ok && s.fails >= 2 && s.alive !== false) log(`peer ${i} (${base(u)}) reported ${res.statusCode} - DOWN`);
    s.alive = ok ? true : (s.fails >= 2 ? false : s.alive);
    s.checkedAt = Date.now();
  });
  req.on('timeout', () => req.destroy(new Error('probe timeout')));
  req.on('error', () => {
    s.fails += 1;
    if (s.fails >= 2 && s.alive !== false) log(`peer ${i} (${base(u)}) unreachable - DOWN`);
    if (s.fails >= 2) s.alive = false;
    s.checkedAt = Date.now();
  });
  req.end();
}

function proxyHttp(req, res, side, index) {
  const t = targetFor(side, index);
  const stream = isStream(req);
  if (side === 'peer' && state.primary.alive === false) {
    state.failovers += 1;
    state.lastFailoverAt = new Date().toISOString();
  }
  const headers = { ...req.headers, 'x-forwarded-by': 'hakster-router', 'x-hakster-node': side };
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  delete headers['x-forwarded-by-note'];

  const up = http.request({
    host: t.host, port: t.port, path: req.url, method: req.method, headers,
    timeout: stream ? 0 : UPSTREAM_TIMEOUT_MS,
  }, (ur) => {
    state.served[side] += 1;
    if (side === 'peer' && state.servedByPeer[index] !== undefined) state.servedByPeer[index] += 1;
    // Lets anyone (and the tests) see which box actually answered.
    try {
      res.setHeader('x-router-node', side);
      if (side === 'peer') res.setHeader('x-router-peer', String(index));
    } catch { /* headers already sent */ }
    res.writeHead(ur.statusCode || 502, ur.headers);
    ur.pipe(res);
    if (!stream) {
      ur.on('error', () => { try { res.destroy(); } catch { /* already gone */ } });
    }
  });

  up.on('timeout', () => up.destroy(new Error('upstream timeout')));
  up.on('error', (err) => {
    state.served.failed += 1;
    log(`upstream ${side}${side === 'peer' ? `#${index}` : ''} failed for ${req.method} ${req.url}: ${err.message}`);
    // One immediate retry on the other side, but never for a body we may have consumed.
    if ((req.method === 'GET' || req.method === 'HEAD')) {
      if (side === 'primary') {
        const other = alivePeerIndex();
        if (other >= 0) { proxyHttp(req, res, 'peer', other); return; }
      } else if (state.primary.alive !== false) {
        proxyHttp(req, res, 'primary', -1); return;
      }
    }
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'upstream unavailable', node: side }));
    } else {
      try { res.destroy(); } catch { /* already gone */ }
    }
  });

  req.pipe(up);
  res.on('close', () => { if (!up.destroyed) up.destroy(); });
}

function statusBody() {
  return {
    listening: `${LISTEN.host}:${LISTEN.port}`,
    sharedListening: SHARED_LISTEN ? `${SHARED_LISTEN.host}:${SHARED_LISTEN.port}` : null,
    primary: base(PRIMARY), peer: base(PEERS[state.active] || PEERS[0]),
    peers: PEERS.map((u, i) => ({ url: base(u), alive: state.peers[i].alive, served: state.servedByPeer[i] })),
    activePeer: state.active, activePeerUrl: base(PEERS[state.active] || PEERS[0]),
    switches: state.switches, lastSwitchAt: state.lastSwitchAt,
    staticMode: STATIC_MODE,
    uptimeS: Math.round((Date.now() - state.startedAt) / 1000),
    primary_alive: state.primary.alive, peer_alive: alivePeerIndex() >= 0,
    served: state.served,
    failovers: state.failovers, lastFailoverAt: state.lastFailoverAt,
  };
}

/* Bind with a short retry loop instead of dying on EADDRINUSE.
 *
 * The connector dials 3579 and cannot be repointed, so replacing the router
 * means the port changes hands. If the new process dies when the old one still
 * holds it, the swap costs a hole of whatever it takes to start Node (~150-
 * 200 ms) — and a request landing in that hole is a user error. Waiting here
 * shrinks the hole to one retry interval (~25 ms) and lets the new router be
 * started BEFORE the old one stops, which is what makes the cutover safe.
 *
 * Bounded: if the port never frees the router exits with a clear line rather
 * than pretending to serve.
 */
const BIND_RETRY_MS = Number(process.env.ROUTER_BIND_RETRY_MS || 25);
const BIND_TRIES = Number(process.env.ROUTER_BIND_TRIES || 600); // ~15 s

function listenRetrying(srv, opts, label) {
  let tries = 0;
  srv.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && tries < BIND_TRIES) {
      tries += 1;
      if (tries === 1 || tries % 40 === 0) {
        log(`${label} waiting for ${opts.host}:${opts.port} (in use, try ${tries})`);
      }
      setTimeout(() => { try { srv.listen(opts); } catch { /* retried below */ } }, BIND_RETRY_MS);
      return;
    }
    log(`${label} could not listen on ${opts.host}:${opts.port}: ${err && err.code ? err.code : err}`);
    process.exit(1);
  });
  srv.listen(opts);
}

function isLoopback(addr) {
  const a = String(addr || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function normalizeUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '').toLowerCase();
}

/** Move the active slot. Loopback only: it is a local control action. */
function handleSwitch(req, res) {
  if (!isLoopback(req.socket.remoteAddress)) {
    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'loopback only' }));
    return;
  }
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 4096) req.destroy();
  });
  req.on('end', () => {
    let wanted = '';
    try { wanted = normalizeUrl(JSON.parse(body || '{}').url); } catch { wanted = normalizeUrl(body); }
    const index = PEERS.findIndex((u) => normalizeUrl(base(u)) === wanted);
    if (index < 0) {
      res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'unknown peer url', wanted, known: PEERS.map(base) }));
      return;
    }
    const was = state.active;
    state.active = index;
    if (was !== index) {
      state.switches += 1;
      state.lastSwitchAt = new Date().toISOString();
      log(`active peer ${was} -> ${index} (${base(PEERS[index])})`);
    }
    // The new slot has just been verified by the caller; treat it as alive.
    state.peers[index].alive = true;
    state.peers[index].fails = 0;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(statusBody()));
  });
}

/** WebSocket / raw upgrade — pipe the socket to whichever node owns it. */
const server = http.createServer((req, res) => {
  if (req.url === '/router/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(statusBody(), null, 1));
    return;
  }
  if (req.url === '/router/peer') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'POST only' }));
      return;
    }
    handleSwitch(req, res);
    return;
  }

  const name = pick(req);
  if (!name) {
    state.served.failed += 1;
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Both haksterAi nodes are down. Nothing is being faked: this is the router.\n');
    return;
  }
  proxyHttp(req, res, name.side, name.index);
});

server.on('upgrade', (req, socket, head) => {
  const name = pick(req) || { side: 'primary', index: -1 };
  const t = targetFor(name.side, name.index);
  const upstream = net.connect(t.port, t.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push('x-hakster-node: ' + name.side, '', '');
    upstream.write(lines.join('\r\n'));
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const kill = () => { try { socket.destroy(); } catch { /* already gone */ } try { upstream.destroy(); } catch { /* already gone */ } };
  upstream.on('error', kill);
  socket.on('error', kill);
  socket.on('close', () => { try { upstream.destroy(); } catch { /* already gone */ } });
});

/* The second door: what the other box dials as its peer. It always serves the
 * ACTIVE slot, so the other box's peer address survives a blue-green move. It
 * never falls back to the primary — a peer door that silently answers as the
 * primary would make one box look like two. */
let sharedServer = null;
if (SHARED_LISTEN) {
  sharedServer = http.createServer((req, res) => {
    const idx = alivePeerIndex();
    if (idx < 0) {
      state.served.failed += 1;
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'no slot available', door: 'shared' }));
      return;
    }
    proxyHttp(req, res, 'peer', idx);
  });
  sharedServer.on('upgrade', (req, socket, head) => {
    const idx = alivePeerIndex();
    if (idx < 0) { try { socket.destroy(); } catch { /* already gone */ } return; }
    const t = targetFor('peer', idx);
    const upstream = net.connect(t.port, t.host, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push('x-hakster-node: peer', '', '');
      upstream.write(lines.join('\r\n'));
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const kill = () => { try { socket.destroy(); } catch { /* already gone */ } try { upstream.destroy(); } catch { /* already gone */ } };
    upstream.on('error', kill);
    socket.on('error', kill);
    socket.on('close', () => { try { upstream.destroy(); } catch { /* already gone */ } });
  });
  sharedServer.on('listening', () => {
    log(`shared door (peer) listening on ${SHARED_LISTEN.host}:${SHARED_LISTEN.port}`);
  });
  listenRetrying(sharedServer, { port: SHARED_LISTEN.port, host: SHARED_LISTEN.host }, 'shared door');
}

// Health loop. Also used to recover: a node that answers again is UP again.
probePrimary();
PEERS.forEach((_, i) => probePeer(i));
const healthTimer = setInterval(() => {
  probePrimary();
  PEERS.forEach((_, i) => probePeer(i));
}, HEALTH_MS);
healthTimer.unref();

server.on('listening', () => {
  log(`router listening on ${LISTEN.host}:${LISTEN.port} -> primary ${base(PRIMARY)}, peers ${PEERS.map(base).join(' ')} (active ${state.active}, static: ${STATIC_MODE})`);
});
listenRetrying(server, { port: LISTEN.port, host: LISTEN.host }, 'router');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`router stopping (${sig})`);
    server.close(() => process.exit(0));
    try { sharedServer?.close(); } catch { /* already closed */ }
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
