#!/usr/bin/env node
/* failover-router.cjs — one port in front of two haksterAi boxes.
 *
 * Owner, 2026-11-25: "if dell server drops for period of time lenovo kicks in" /
 * "if we can get both to serve are requst users would make more better faster
 * power per box" / "not if it breaks or tunnles cause i have alot of ads etc
 * running off tunnels".
 *
 * The tunnel is never touched. cloudflared on the Dell keeps dialling
 * 127.0.0.1:3579 exactly as it does today (haksterai-dell.yml, tunnel
 * c5e39c69). This router is what listens there instead: the Dell app moves to
 * 3580, the Lenovo answers at 10.0.0.210:3579, and the router decides per
 * request. No ingress edit, no DNS, no connector change, no credential.
 *
 * Routing rules (deliberately conservative — state correctness first):
 *   · stateful paths (/api/*, /admin*, /login, /auth, /callback, PUT/POST/
 *     PATCH/DELETE anywhere) always go to PRIMARY. Two SQLite files cannot be
 *     written by two boxes; the Dell stays the only writer.
 *   · static GET/HEAD (marketing pages, /_astro/, ads' landing pages) are
 *     served round-robin by both boxes — that is the load actually shared,
 *     and it needs no shared state because the bytes are identical.
 *   · PRIMARY down  -> everything goes to PEER (the failover the owner asked for).
 *   · PEER down     -> everything goes to PRIMARY.
 *   · both down     -> 502, honestly reported, never a fake success.
 *
 * Liveness is /api/version (200 = alive). /api/health is NOT used: a node with
 * no Stripe key reports "degraded" and still serves pages correctly.
 *
 * Env:
 *   ROUTER_LISTEN   default 127.0.0.1:3579
 *   PRIMARY_URL     default http://127.0.0.1:3580
 *   PEER_URL        default http://10.0.0.210:3579
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
const PEER = new URL(process.env.PEER_URL || 'http://10.0.0.210:3579');
const STATIC_MODE = process.env.ROUTER_STATIC || 'share';
const LOG_FILE = process.env.ROUTER_LOG || '';

const HEALTH_MS = 5000;
const PROBE_TIMEOUT_MS = 2500;
const UPSTREAM_TIMEOUT_MS = 30000;

// Paths that must never be shared: they read or write account state.
const STATEFUL_PREFIX = ['/api/', '/admin', '/login', '/auth', '/callback', '/oauth', '/logout'];
// Long-lived streams: no socket timeout, keep the pipe open.
const STREAM_PREFIX = ['/api/agent/run', '/api/tui', '/api/stream', '/api/events'];

const state = {
  primary: { alive: null, checkedAt: 0, fails: 0 },
  peer: { alive: null, checkedAt: 0, fails: 0 },
  turn: 0,
  startedAt: Date.now(),
  served: { primary: 0, peer: 0, failed: 0 },
  // Requests the peer answered *because* the primary was down. A non-zero
  // value means the Lenovo may hold writes the Dell does not: the DB sync
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

/** Which upstream gets this request, given current liveness. */
function pick(req) {
  const primaryUp = state.primary.alive !== false;
  const peerUp = state.peer.alive !== false;

  if (!primaryUp && peerUp) return 'peer';       // the whole point: Dell down, Lenovo serves
  if (primaryUp && !peerUp) return 'primary';
  if (!primaryUp && !peerUp) return null;        // both down

  // Both alive: state stays on the Dell, static traffic is shared.
  if (isStateful(req) || STATIC_MODE === 'primary') return 'primary';
  state.turn += 1;
  return state.turn % 2 === 0 ? 'peer' : 'primary';
}

function targetFor(name) {
  const u = name === 'peer' ? PEER : PRIMARY;
  return { host: u.hostname, port: Number(u.port || 80) };
}

function probe(name) {
  const t = targetFor(name);
  const started = Date.now();
  const req = http.request({
    host: t.host, port: t.port, path: '/api/version', method: 'GET', timeout: PROBE_TIMEOUT_MS,
    headers: { 'user-agent': 'hakster-failover-router', 'x-forwarded-by': 'router' },
  }, (res) => {
    res.resume();
    const ok = res.statusCode === 200;
    const s = state[name];
    s.fails = ok ? 0 : s.fails + 1;
    if (!ok && s.fails >= 2 && s.alive !== false) log(`node ${name} reported ${res.statusCode} - treating as DOWN`);
    s.alive = ok ? true : (s.fails >= 2 ? false : s.alive);
    s.checkedAt = Date.now();
    void started;
  });
  req.on('timeout', () => req.destroy(new Error('probe timeout')));
  req.on('error', () => {
    const s = state[name];
    s.fails += 1;
    if (s.fails >= 2 && s.alive !== false) log(`node ${name} unreachable - treating as DOWN`);
    if (s.fails >= 2) s.alive = false;
    s.checkedAt = Date.now();
  });
  req.end();
}

function proxyHttp(req, res, name) {
  const t = targetFor(name);
  const stream = isStream(req);
  if (name === 'peer' && state.primary.alive === false) {
    state.failovers += 1;
    state.lastFailoverAt = new Date().toISOString();
  }
  const headers = { ...req.headers, 'x-forwarded-by': 'hakster-router', 'x-hakster-node': name };
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  delete headers['x-forwarded-by-note'];

  const up = http.request({
    host: t.host, port: t.port, path: req.url, method: req.method, headers,
    timeout: stream ? 0 : UPSTREAM_TIMEOUT_MS,
  }, (ur) => {
    state.served[name] += 1;
    // Lets anyone (and the tests) see which box actually answered.
    try { res.setHeader('x-router-node', name); } catch { /* headers already sent */ }
    res.writeHead(ur.statusCode || 502, ur.headers);
    ur.pipe(res);
    if (!stream) {
      ur.on('error', () => { try { res.destroy(); } catch { /* already gone */ } });
    }
  });

  up.on('timeout', () => up.destroy(new Error('upstream timeout')));
  up.on('error', (err) => {
    state.served.failed += 1;
    log(`upstream ${name} failed for ${req.method} ${req.url}: ${err.message}`);
    // One immediate retry on the other side, but never for a body we may have consumed.
    const other = name === 'primary' ? 'peer' : 'primary';
    if (state[other].alive !== false && (req.method === 'GET' || req.method === 'HEAD')) {
      proxyHttp(req, res, other);
      return;
    }
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'upstream unavailable', node: name }));
    } else {
      try { res.destroy(); } catch { /* already gone */ }
    }
  });

  req.pipe(up);
  res.on('close', () => { if (!up.destroyed) up.destroy(); });
}

/** WebSocket / raw upgrade — pipe the socket to whichever node owns it. */
const server = http.createServer((req, res) => {
  if (req.url === '/router/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      listening: `${LISTEN.host}:${LISTEN.port}`,
      primary: base(PRIMARY), peer: base(PEER),
      staticMode: STATIC_MODE,
      uptimeS: Math.round((Date.now() - state.startedAt) / 1000),
      primary_alive: state.primary.alive, peer_alive: state.peer.alive,
      served: state.served,
      failovers: state.failovers, lastFailoverAt: state.lastFailoverAt,
    }, null, 1));
    return;
  }

  const name = pick(req);
  if (!name) {
    state.served.failed += 1;
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Both haksterAi nodes are down. Nothing is being faked: this is the router.\n');
    return;
  }
  proxyHttp(req, res, name);
});

server.on('upgrade', (req, socket, head) => {
  const name = pick(req) || 'primary';
  const t = targetFor(name);
  const upstream = net.connect(t.port, t.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push('x-hakster-node: ' + name, '', '');
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

// Health loop. Also used to recover: a node that answers again is UP again.
probe('primary');
probe('peer');
const healthTimer = setInterval(() => { probe('primary'); probe('peer'); }, HEALTH_MS);
healthTimer.unref();

server.listen(LISTEN.port, LISTEN.host, () => {
  log(`router listening on ${LISTEN.host}:${LISTEN.port} -> primary ${base(PRIMARY)}, peer ${base(PEER)} (static: ${STATIC_MODE})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`router stopping (${sig})`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
