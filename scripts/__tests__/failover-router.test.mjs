// failover-router: the routing rules that keep two haksterAi boxes safe.
//
// Owner, 2026-11-25: "if dell server drops for period of time lenovo kicks in" /
// "if we can get both to serve are requst users would make more better faster
// power per box" / "not if it breaks or tunnles cause i have alot of ads etc
// running off tunnels".
//
// Pinned here: account traffic never leaves the Dell while it is up, static
// traffic really is shared by both boxes, and a dead primary hands everything
// (state included) to the peer. The tunnel is never involved — the router owns
// the loopback port cloudflared already dials.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const routerScript = path.resolve(here, '..', 'failover-router.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function upstream(name) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ build: 'test', node: name }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html>${name}</html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, name }));
  });
}

function get(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, node: res.headers['x-router-node'], body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

let primary;
let peer;
let routerPort;
let child;

before(async () => {
  primary = await upstream('primary');
  peer = await upstream('peer');
  routerPort = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  child = spawn(process.execPath, [routerScript], {
    env: {
      ...process.env,
      ROUTER_LISTEN: `127.0.0.1:${routerPort}`,
      PRIMARY_URL: `http://127.0.0.1:${primary.port}`,
      PEER_URL: `http://127.0.0.1:${peer.port}`,
      ROUTER_LOG: '',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await get(routerPort, '/router/status');
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('router did not start');
});

after(async () => {
  child?.kill('SIGTERM');
  await Promise.all([
    new Promise((r) => primary.server.close(r)),
    new Promise((r) => peer.server.close(r)),
  ]);
});

test('account traffic always lands on the primary while it is up', async () => {
  for (let i = 0; i < 4; i += 1) {
    const r = await get(routerPort, '/api/version');
    assert.equal(r.status, 200);
    assert.equal(r.node, 'primary', 'stateful paths must never be shared');
  }
});

test('a write of any method is stateful even outside /api', async () => {
  const r = await get(routerPort, '/somewhere', 'POST');
  assert.equal(r.node, 'primary');
});

test('static pages are served by both boxes', async () => {
  const seen = new Set();
  for (let i = 0; i < 6; i += 1) {
    const r = await get(routerPort, '/');
    assert.equal(r.status, 200);
    seen.add(r.node);
  }
  assert.deepEqual([...seen].sort(), ['peer', 'primary'], 'both boxes must actually take static load');
});

test('primary down: everything, state included, moves to the peer', async () => {
  await new Promise((r) => primary.server.close(r));
  // two failed probes at 5 s decide it
  await sleep(12000);
  const api = await get(routerPort, '/api/version');
  assert.equal(api.status, 200);
  assert.equal(api.node, 'peer');
  const page = await get(routerPort, '/');
  assert.equal(page.node, 'peer');
  const status = JSON.parse((await get(routerPort, '/router/status')).body);
  assert.equal(status.primary_alive, false);
  assert.ok(status.failovers >= 1, 'a failover must be counted so the DB sync can hold');
});
