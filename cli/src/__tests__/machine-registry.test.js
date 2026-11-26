'use strict';
/* Tests for the CLI machine registry — the box registering itself in the admin.
 *
 * Owner, 2026-11-26: "make sure you add my box in admin to my enterprise plan
 * owner". The admin only ever heard from the web client, so a CLI box was
 * invisible there. These tests pin the three things that matter:
 *   1. what is sent is measured from the machine (never invented),
 *   2. the signed-in key travels in a header and never in the body or output,
 *   3. an unsigned/offline machine registers nothing and never fails a command.
 *
 * Run: node --test cli/src/__tests__/machine-registry.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mr = require('../machine-registry.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-mreg-'));
}

function withStampDir(dir) {
  process.env.HAKSTER_MACHINE_REG_DIR = dir;
}

test('the profile is measured from this machine, not invented', () => {
  const p = mr.machineProfile({ version: '9.9.9' });
  assert.equal(p.device_model, os.hostname());
  assert.equal(p.cores, os.cpus().length);
  assert.equal(p.memory_gb, Math.round(os.totalmem() / 1073741824));
  assert.equal(p.os_version, os.release());
  assert.equal(p.os_name, mr.osNameFromPlatform(process.platform));
  assert.equal(p.device_type, 'desktop');
  assert.equal(p.engine, 'hakster-cli');
  assert.equal(p.engine_version, '9.9.9');
  assert.match(p.session_id, /^cli-[a-z0-9.-]+$/);
  // Browser-only facts must stay absent rather than be guessed.
  assert.equal(p.screen_width, undefined);
  assert.equal(p.screen_height, undefined);
  assert.equal(p.browser, undefined);
  assert.equal(p.gpu, undefined);
});

test('a hostname with spaces or unicode still yields a safe session id', () => {
  assert.equal(mr.machineSessionId('Surface Pro 9'), 'cli-surface-pro-9');
  assert.equal(mr.machineSessionId('ghost-Inspiron-7348'), 'cli-ghost-inspiron-7348');
  assert.equal(mr.machineSessionId(''), 'cli-box');
  assert.equal(mr.machineSessionId('Ñ€Ü'), 'cli-box');
});

test('an unsigned machine registers nothing', async () => {
  withStampDir(tempDir());
  assert.equal((await mr.registerMachine({ server: 'http://127.0.0.1:1' })).status, 'skipped');
  assert.equal((await mr.registerMachine({ apiKey: 'k' })).status, 'skipped');
  assert.equal((await mr.registerMachine({ server: 'not a url', apiKey: 'k' })).status, 'skipped');
});

test('an unreachable or dead server never throws', async () => {
  withStampDir(tempDir());
  const r = await mr.registerMachine({ server: 'http://127.0.0.1:1', apiKey: 'test-key', timeoutMs: 700 });
  assert.equal(r.ok, false);
  assert.ok(['unreachable', 'timeout', 'rejected'].includes(r.status), r.status);
});

test('registers against the account key in a header, and the key never rides in the body', async () => {
  const dir = tempDir();
  withStampDir(dir);

  const seen = { headers: null, body: null, url: null };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.url = req.url;
      seen.headers = req.headers;
      seen.body = JSON.parse(raw || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const KEY = 'unit-test-key-not-a-real-secret';

  try {
    const out = await mr.registerMachine({ server: `http://127.0.0.1:${port}`, apiKey: KEY, version: '1.2.3', force: true });
    assert.equal(out.status, 'registered');

    assert.equal(seen.url, '/api/client-context');
    assert.equal(seen.headers['x-api-key'], KEY);
    assert.equal(seen.headers['x-hakster-client'], 'cli');
    assert.equal(seen.body.device_model, os.hostname());
    assert.equal(seen.body.engine_version, '1.2.3');
    // The key must not appear anywhere in the payload.
    assert.ok(!JSON.stringify(seen.body).includes(KEY), 'key leaked into the body');
    // And the result object is not a channel for it either.
    assert.ok(!JSON.stringify(out).includes(KEY), 'key leaked into the result');

    const stamp = JSON.parse(fs.readFileSync(path.join(dir, 'machine-reg.json'), 'utf8'));
    assert.ok(stamp.at > 0 && typeof stamp.digest === 'string' && stamp.host === os.hostname());
    assert.equal(fs.statSync(path.join(dir, 'machine-reg.json')).mode & 0o777, 0o600);
  } finally {
    server.close();
  }
});

test('an unchanged box is not re-announced inside the stamp window', async () => {
  const dir = tempDir();
  withStampDir(dir);

  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    assert.equal((await mr.registerMachine({ server: serverUrl, apiKey: 'k1' })).status, 'registered');
    assert.equal((await mr.registerMachine({ server: serverUrl, apiKey: 'k1' })).status, 'current');
    assert.equal(hits, 1, 'second call must not POST');
    // A different account is a different registration, not a repeat.
    assert.equal((await mr.registerMachine({ server: serverUrl, apiKey: 'k2' })).status, 'registered');
    assert.equal(hits, 2);
    // force ignores the stamp (the probe / a plan change reading).
    assert.equal((await mr.registerMachine({ server: serverUrl, apiKey: 'k2', force: true })).status, 'registered');
    assert.equal(hits, 3);
  } finally {
    server.close();
  }
});

test('HAKSTER_NO_MACHINE_REG=1 disables it entirely', async () => {
  withStampDir(tempDir());
  const prev = process.env.HAKSTER_NO_MACHINE_REG;
  process.env.HAKSTER_NO_MACHINE_REG = '1';
  try {
    const r = await mr.registerMachine({ server: 'http://127.0.0.1:1', apiKey: 'k', force: true });
    assert.equal(r.status, 'skipped');
    assert.equal(r.reason, 'disabled');
  } finally {
    if (prev === undefined) delete process.env.HAKSTER_NO_MACHINE_REG;
    else process.env.HAKSTER_NO_MACHINE_REG = prev;
    delete process.env.HAKSTER_MACHINE_REG_DIR;
  }
});
