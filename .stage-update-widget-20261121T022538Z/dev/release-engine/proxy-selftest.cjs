'use strict';
/**
 * Front-proxy integration test — real sockets, real timing, no production.
 *
 * Every assertion here is measured, not assumed:
 *   - SSE chunks must arrive BEFORE the upstream finishes (proves no buffering)
 *   - an in-flight request must finish on the upstream it started on
 *   - drain must resolve only once that connection has closed
 *   - a dead upstream must fail over to the other one, once, before any byte
 *   - WebSocket upgrades must tunnel
 *   - the control surface must refuse requests without the token
 *
 * Run: node dev/release-engine/proxy-selftest.cjs
 */
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { createFront, CONTROL_TOKEN_FILE } = require('./front-proxy.cjs');

const PORT = 3590, CONTROL = 3591;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(44) + (detail || '')); };

/** A stand-in upstream that behaves like the real app for the paths we test. */
function upstream(name) {
  const server = http.createServer((req, res) => {
    const tag = name;
    if (req.url === '/api/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    if (req.url === '/slow') {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': tag }); res.end('slow-done-' + tag); }, 1500);
      return;
    }
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      let n = 0;
      const t = setInterval(() => {
        n++;
        res.write(`data: chunk-${n}-${tag}-at-${Date.now()}\n\n`);
        if (n === 3) { clearInterval(t); res.end(); }
      }, 400);
      req.on('close', () => clearInterval(t));
      return;
    }
    if (req.url === '/echo') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': tag }); res.end(JSON.stringify({ tag, method: req.method, body })); });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': tag });
    res.end('hello from ' + tag);
  });
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write('echo:' + d.toString().trim() + '\n'));
  });
  return server;
}

// `agent: false` on every client request in this file. Node 19+ keeps the
// global agent's sockets alive, and a lingering client socket means
// server.close() waits forever — the test would hang in teardown with every
// assertion already passed. One socket per request, closed with it.
const get = (port, pathname, opts = {}) => new Promise((resolve, reject) => {
  const started = Date.now();
  const req = http.request({ host: '127.0.0.1', port, path: pathname, method: opts.method || 'GET', agent: false, headers: opts.headers || {} }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, ms: Date.now() - started }));
  });
  req.on('error', reject);
  if (opts.body) req.write(opts.body);
  req.end();
});

// Hard watchdog: whatever blocks, the run reports what it got and exits.
// 90s is far past the slowest real phase (a 1.5s request and a 2.5s WS check).
const watchdog = setTimeout(() => {
  console.log(`\nWATCHDOG: still running after 90s — ${results.length} checks recorded so far:`);
  for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name);
  process.exit(3);
}, 90000);
watchdog.unref();

(async () => {
  const blue = upstream('blue'), green = upstream('green');
  await new Promise((r) => blue.listen(3580, '127.0.0.1', r));
  await new Promise((r) => green.listen(3581, '127.0.0.1', r));

  const token = crypto.randomBytes(16).toString('hex');
  require('fs').mkdirSync(path.dirname(CONTROL_TOKEN_FILE), { recursive: true });
  require('fs').writeFileSync(CONTROL_TOKEN_FILE, token, { mode: 0o600 });

  const front = createFront({ port: PORT, controlPort: CONTROL, upstreams: { blue: 3580, green: 3581 }, active: 'blue' });
  await front.listen(); await front.listenControl();

  try {
    // 1 — plain GET
    let r = await get(PORT, '/');
    check('HTTP passthrough reaches the active upstream', r.status === 200 && r.body === 'hello from blue' && r.headers['x-upstream'] === 'blue');

    // 2 — POST body
    r = await get(PORT, '/echo', { method: 'POST', body: JSON.stringify({ a: 1 }) });
    check('POST body is forwarded intact', r.status === 200 && JSON.parse(r.body).body === '{"a":1}');

    // 3 — SSE is not buffered: first chunk must arrive well before the stream ends
    const sse = await new Promise((resolve, reject) => {
      const t0 = Date.now(); const marks = [];
      http.get({ host: '127.0.0.1', port: PORT, path: '/sse', agent: false }, (res) => {
        res.on('data', (c) => marks.push({ at: Date.now() - t0, text: c.toString().trim() }));
        res.on('end', () => resolve({ marks, total: Date.now() - t0 }));
      }).on('error', reject);
    });
    const first = sse.marks[0];
    check('SSE chunks stream without buffering', sse.marks.length >= 3 && first.at < sse.total - 400,
      `first chunk at ${first.at}ms, stream ended at ${sse.total}ms`);

    // 4 — an in-flight request survives a switch and stays on its upstream
    const slow = get(PORT, '/slow');
    await new Promise((r2) => setTimeout(r2, 250));
    const sw = front.switchTo('green', 'selftest');
    const slowRes = await slow;
    check('in-flight request finishes on the upstream it started on', slowRes.body === 'slow-done-blue' && slowRes.headers['x-upstream'] === 'blue',
      `switch ${sw.from}→${sw.to} mid-request`);
    r = await get(PORT, '/');
    check('new requests go to the newly active upstream', r.body === 'hello from green');

    // 5 — drain waits for the old upstream's open connection
    const slow2 = get(PORT, '/slow');
    await new Promise((r2) => setTimeout(r2, 200));
    front.switchTo('blue', 'selftest drain');
    const drainStart = Date.now();
    const drained = await front.drain('green', 8000);
    const drainMs = Date.now() - drainStart;
    await slow2;
    check('drain resolves only after the old connection closes', drained.drained === true && drainMs > 800,
      `drained in ${drainMs}ms, remaining ${drained.remaining}`);

    // 6 — failover when an upstream is dead
    front.switchTo('green', 'selftest failover');
    if (blue.closeAllConnections) blue.closeAllConnections();
    await new Promise((r2) => blue.close(r2));
    const upRes = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', agent: false }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', () => resolve({ status: 0, body: '' }));
    });
    // active is green and green is alive: this passes without needing failover.
    check('active upstream still serves while the other is dead', upRes.status === 200 && upRes.body === 'hello from green');

    // now point at the dead one and prove the retry
    front.switchTo('blue', 'selftest dead active');
    const failover = await get(PORT, '/');
    check('a dead active upstream fails over to the live one', failover.status === 200 && failover.body === 'hello from green',
      `served by ${failover.headers['x-upstream']}`);

    // 7 — rollback to the previous release
    front.switchTo('green', 'selftest rollback');
    r = await get(PORT, '/');
    check('rollback switch restores the previous release', r.body === 'hello from green');

    // 8 — WebSocket upgrade tunnels
    const wsOk = await new Promise((resolve) => {
      const sock = net.connect(PORT, '127.0.0.1', () => {
        sock.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        setTimeout(() => sock.write('ping\n'), 150);
      });
      let buf = '';
      const done = (v) => { try { sock.destroy(); } catch (_) {} resolve(v); };
      sock.on('data', (d) => { buf += d.toString(); if (buf.includes('101') && buf.includes('echo:ping')) done(true); });
      sock.on('error', () => done(false));
      setTimeout(() => done(buf.includes('101') && buf.includes('echo:ping')), 2500);
    });
    check('WebSocket upgrade tunnels through the proxy', wsOk);

    // 9 — control surface refuses an unauthenticated caller
    const forbidden = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: CONTROL, path: '/__state', agent: false }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve(0));
    });
    const authorized = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: CONTROL, path: '/__state', agent: false, headers: { 'x-control-token': token } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ code: res.statusCode, body: b }));
      }).on('error', () => resolve({ code: 0 }));
    });
    check('control surface rejects a caller without the token', forbidden === 403);
    check('control surface reports real state with the token', authorized.code === 200 && JSON.parse(authorized.body).active === 'green');
  } finally {
    // Teardown must never be able to hang the run: a stuck close reports, it
    // does not wait forever. closeAllConnections() drops whatever is left.
    try { if (front.server.closeAllConnections) front.server.closeAllConnections(); } catch (_) {}
    try { if (front.control.closeAllConnections) front.control.closeAllConnections(); } catch (_) {}
    const closed = await Promise.race([
      front.close().then(() => 'closed'),
      new Promise((r) => setTimeout(() => r('timeout'), 4000)),
    ]);
    if (closed !== 'closed') console.log('NOTE teardown: front.close() did not finish within 4s (connections remained) conns=' + JSON.stringify(front.info().conns));
    try { if (green.closeAllConnections) green.closeAllConnections(); green.close(); } catch (_) {}
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} proxy checks passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('selftest crashed:', e.message); process.exit(2); });
