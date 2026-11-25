// failover-router blue-green: two slots, one peer address, no gap for a user.
//
// Owner, 2026-11-25: "how can we make it to where no user gets errors we need
// both online at all times". The sync boots the idle slot, waits for it to
// answer, then moves the router to it and only THEN stops the old one — so at
// no instant is there no standby serving static traffic.
//
// Pinned here:
//   · only the ACTIVE slot takes peer traffic
//   · POST /router/peer moves it, and an unknown url is refused
//   · the shared door (what the other box dials) follows the active slot, so a
//     switch needs no change on the other box
//   · the old slot being stopped after a switch produces no 5xx
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

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
}

function get(port, pathname, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, timeout: 8000 }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({
        status: res.statusCode, node: res.headers['x-router-node'],
        peerIndex: res.headers['x-router-peer'], body: text,
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let primary;
let slotA;
let slotB;
let routerPort;
let doorPort;
let child;

before(async () => {
  primary = await upstream('primary');
  slotA = await upstream('slotA');
  slotB = await upstream('slotB');
  routerPort = await freePort();
  doorPort = await freePort();
  child = spawn(process.execPath, [routerScript], {
    env: {
      ...process.env,
      ROUTER_LISTEN: `127.0.0.1:${routerPort}`,
      PRIMARY_URL: `http://127.0.0.1:${primary.port}`,
      PEER_URLS: `http://127.0.0.1:${slotA.port},http://127.0.0.1:${slotB.port}`,
      SHARED_LISTEN: `127.0.0.1:${doorPort}`,
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
    new Promise((r) => slotB.server.close(r)),
  ]);
});

test('only the active slot takes peer traffic', async () => {
  const seen = new Set();
  for (let i = 0; i < 6; i += 1) {
    const r = await get(routerPort, '/');
    if (r.node === 'peer') seen.add(r.peerIndex);
  }
  assert.deepEqual([...seen], ['0'], 'the idle slot must get no traffic before it is switched in');
});

test('the shared door follows the active slot', async () => {
  // what the other box dials: always the active slot, whichever port that is
  for (const p of ['/', '/api/version']) {
    const r = await get(doorPort, p);
    assert.equal(r.status, 200);
    assert.equal(r.node, 'peer');
    assert.equal(r.peerIndex, '0');
  }
});

test('an unknown slot url is refused, a known one moves traffic', async () => {
  const bad = await get(routerPort, '/router/peer', 'POST', JSON.stringify({ url: 'http://127.0.0.1:9' }));
  assert.equal(bad.status, 400);

  const ok = await get(routerPort, '/router/peer', 'POST',
    JSON.stringify({ url: `http://127.0.0.1:${slotB.port}` }));
  assert.equal(ok.status, 200);
  const status = JSON.parse(ok.body);
  assert.equal(status.activePeer, 1);

  const seen = new Set();
  for (let i = 0; i < 6; i += 1) {
    const r = await get(routerPort, '/');
    if (r.node === 'peer') seen.add(r.peerIndex);
  }
  assert.deepEqual([...seen], ['1'], 'after the switch every peer request is the new slot');
});

test('stopping the old slot after a switch breaks nothing', async () => {
  await new Promise((r) => slotA.server.close(r));
  await sleep(300);
  let failures = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = await get(routerPort, '/');
    if (r.status >= 500) failures += 1;
    if (r.node === 'peer') assert.equal(r.peerIndex, '1');
  }
  assert.equal(failures, 0, 'a blue-green move must not cost a visitor an error');
  const viaDoor = await get(doorPort, '/');
  assert.equal(viaDoor.status, 200);
});

test('a write still never reaches a slot', async () => {
  const r = await get(routerPort, '/somewhere', 'POST');
  assert.equal(r.node, 'primary');
});
