#!/usr/bin/env node
'use strict';
/**
 * Live agent-lane probe.
 *
 * Proves that a provider dispatch works on the RUNNING server — not just in a
 * stubbed unit test. It reads the owner API key IN-PROCESS from
 * ~/.hakster/config.json and sends it as x-api-key (§23.3: a secret is used,
 * never printed, never put in argv, never written anywhere).
 *
 * Usage:
 *   node scripts/probe-agent-lane.cjs [provider] [expectedToken]
 *   node scripts/probe-agent-lane.cjs codex-cli LIVE_CODEX_OK
 *
 * Env:
 *   PROBE_BASE        base URL      (default http://127.0.0.1:3580 — the primary)
 *   PROBE_TIMEOUT_MS  wall clock    (default 150000)
 *
 * Exit 0 = the lane answered with the expected token.
 * Exit 1 = it did not (and the reason is printed).
 * Exit 2 = the probe could not run (no key, connection refused).
 *
 * §46.4: a lane is only claimed as working after one real call through its own
 * dispatch. This is that call.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const provider = process.argv[2] || 'codex-cli';
const expected = process.argv[3] || 'LIVE_CODEX_OK';
const base = (process.env.PROBE_BASE || 'http://127.0.0.1:3580').replace(/\/$/, '');
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS || 150000);

function ownerKey() {
  const p = path.join(os.homedir(), '.hakster', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const k = cfg.ownerApiKey || cfg.apiKey;
  if (!k) throw new Error('no ownerApiKey/apiKey in ' + p);
  return k;
}

let key;
try {
  key = ownerKey();
} catch (e) {
  console.error('[probe] cannot run: ' + e.message);
  process.exit(2);
}

const body = JSON.stringify({
  provider,
  messages: [{ role: 'user', content: 'Reply with exactly ' + expected + ' and nothing else.' }],
});

let url;
try {
  url = new URL(base + '/api/agent/run');
} catch (e) {
  console.error('[probe] bad PROBE_BASE: ' + base);
  process.exit(2);
}

const started = Date.now();
const chunks = [];
let statusCode = 0;
let firstByteMs = null;

const req = http.request(
  {
    hostname: url.hostname,
    port: Number(url.port || 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-api-key': key,
    },
    timeout: timeoutMs,
  },
  (res) => {
    statusCode = res.statusCode;
    res.setEncoding('utf8');
    res.on('data', (d) => {
      if (firstByteMs === null) firstByteMs = Date.now() - started;
      chunks.push(d);
    });
    res.on('end', finish);
    res.on('error', (e) => {
      console.error('[probe] stream error: ' + e.message);
      finish();
    });
  }
);

req.on('timeout', () => {
  console.error('[probe] timed out after ' + timeoutMs + 'ms');
  req.destroy();
});
req.on('error', (e) => {
  console.error('[probe] request failed: ' + e.message);
  process.exit(2);
});

function finish() {
  const totalMs = Date.now() - started;
  const raw = chunks.join('');

  // §23/§31: never let a key reach the output, even by accident.
  const leaked = raw.includes(key);
  const safe = leaked ? raw.split(key).join('[REDACTED]') : raw;

  // Pull the human-readable text out of the SSE stream (data: {...} lines).
  const deltas = [];
  const events = [];
  for (const line of safe.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(payload); } catch { continue; }
    if (typeof obj.type === 'string') events.push(obj.type);
    const piece =
      (typeof obj.delta === 'string' && obj.delta) ||
      (typeof obj.content === 'string' && obj.content) ||
      (obj.message && typeof obj.message.content === 'string' && obj.message.content) ||
      (obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content) ||
      '';
    if (piece) deltas.push(piece);
  }
  const text = deltas.join('');

  const pass = statusCode === 200 && text.includes(expected) && !leaked;

  console.log('[probe] provider      ' + provider);
  console.log('[probe] endpoint      ' + base + '/api/agent/run');
  console.log('[probe] http status   ' + statusCode);
  console.log('[probe] first byte    ' + (firstByteMs === null ? 'none' : firstByteMs + 'ms'));
  console.log('[probe] total         ' + totalMs + 'ms');
  console.log('[probe] sse events    ' + (events.length ? [...new Set(events)].join(', ') : 'none'));
  console.log('[probe] answer        ' + JSON.stringify(text.slice(0, 300)));
  if (leaked) console.log('[probe] KEY LEAK       the response contained the API key — redacted');
  if (!pass && !text) {
    // No stream text at all: show what the server actually said, trimmed.
    console.log('[probe] raw           ' + JSON.stringify(safe.slice(0, 400)));
  }
  console.log('[probe] ' + (pass ? 'PASS' : 'FAIL') + ' — expected ' + JSON.stringify(expected));
  process.exit(pass ? 0 : 1);
}

req.write(body);
req.end();
