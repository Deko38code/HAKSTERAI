// The router waits for its port instead of dying on EADDRINUSE.
//
// Owner, 2026-11-25: "no user gets errors we need both online at all times".
// The tunnel connector dials 3579 and cannot be repointed, so replacing the
// router swaps that port. If the new process died while the old one still held
// it, the swap would cost a ~200 ms hole and any request in it would be a user
// error. The router now waits for the port, so it can be started BEFORE the old
// one stops and the hole shrinks to one retry interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const routerScript = path.resolve(here, '..', 'failover-router.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listenHold() {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('holder'); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function upstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, timeout: 4000 }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

test('the router waits for a taken port and binds the moment it frees', async () => {
  const holder = await listenHold();     // stands in for the OLD router
  const primary = await upstream();
  const child = spawn(process.execPath, [routerScript], {
    env: {
      ...process.env,
      ROUTER_LISTEN: `127.0.0.1:${holder.port}`,
      PRIMARY_URL: `http://127.0.0.1:${primary.port}`,
      PEER_URL: `http://127.0.0.1:${primary.port}`,
      ROUTER_BIND_RETRY_MS: '10',
      ROUTER_BIND_TRIES: '200',
      ROUTER_LOG: '',
    },
    stdio: 'ignore',
  });

  try {
    // It must NOT be serving the router yet — the holder still owns the port.
    const held = await get(holder.port, '/router/status');
    assert.equal(held.body, 'holder', 'the old listener keeps the port until it closes');

    // The process must still be alive after a second of retrying.
    await sleep(600);
    assert.equal(child.exitCode, null, 'the router must wait, not exit');

    // Free the port: the router should take it within a few retry intervals.
    await new Promise((r) => holder.server.close(r));
    let up = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await get(holder.port, '/router/status');
        if (r.status === 200 && r.body.includes('"listening"')) { up = true; break; }
      } catch { /* not bound yet */ }
      await sleep(25);
    }
    assert.ok(up, 'the router must bind as soon as the port frees');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => primary.server.close(r));
  }
});
