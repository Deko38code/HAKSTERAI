'use strict';
/**
 * Junkalot guard — availability watchdog + dependency self-heal for junkalot.co.
 *
 * 2026-11-17 (owner): junkalot.co served a Cloudflare 502 for about an hour because
 * /home/ghost694/junkalot/node_modules had vanished. systemd crash-looped `next start`
 * every 5s and nothing told anyone. This module watches the site from the Dell and, when
 * the dependency tree is gone, puts it back from the editing copy on Parrot. The unit's
 * own Restart=always brings the app up — this module never touches the service.
 *
 * What it obeys:
 *  - read-only against the site; it never restarts, stops, kills or reprioritises anything
 *  - it never deletes, moves or truncates a file; the heal is a copy INTO a missing directory
 *  - the only source it copies from is junkalot's own editing copy on Parrot
 *  - alerts are rate-limited, so a long outage sends one message, not hundreds
 *  - if Parrot is unreachable it says so and keeps the previous reading instead of guessing
 *
 * Wiring: index.js calls start({ alert }) after the bot fleet is up. `alert` is
 * telegramBots.sendUptimeAlert (bot 5). Injection avoids a require cycle.
 */

const https = require('https');
const http = require('http');
const { execFile } = require('child_process');

const PRIMARY = 'https://junkalot.co/api/version';
const FALLBACK = 'http://10.0.0.251:5006/api/version';
const PROBE_TIMEOUT_MS = 8000;
const SSH_TIMEOUT_MS = 60000;
const INTERVAL_MS = 3 * 60 * 1000;
const FIRST_PROBE_DELAY_MS = 60 * 1000;
const FAILURES_BEFORE_ALERT = 2;
const ALERT_REPEAT_MS = 30 * 60 * 1000;
const SSH_TARGET = 'parrot';

// Runs on Parrot. Checks the dependency binary the unit actually executes, restores it
// only when it is missing, and reports the unit + port state. No deletions, no signals.
const HEAL_SCRIPT = [
  'M=/home/ghost694/junkalot',
  'E=/home/ghost694/workspace/dekekenneth840@gmail.com/junkalot',
  'if [ -x "$M/node_modules/next/dist/bin/next" ]; then',
  '  echo "deps:ok"',
  'elif [ -x "$E/node_modules/next/dist/bin/next" ]; then',
  '  if cp -a "$E/node_modules" "$M/node_modules" 2>/dev/null; then echo "deps:restored"; else echo "deps:restore-failed"; fi',
  'else',
  '  echo "deps:missing-source"',
  'fi',
  '[ -f "$M/.env.local" ] && echo "envlocal:ok" || echo "envlocal:missing"',
  '[ -f "$M/.env.production.local" ] && echo "envprod:ok" || echo "envprod:missing"',
  '[ -f "$M/next.config.js" ] && echo "nextconfig:ok" || echo "nextconfig:missing"',
  '[ -f "$M/package.json" ] && echo "packagejson:ok" || echo "packagejson:missing"',
  'B=""; for d in "$M"/.next-junkalot-*; do [ -f "$d/BUILD_READY" ] && B="$d"; done',
  'if [ -n "$B" ]; then echo "build:ok"; else echo "build:missing"; fi',
  'echo "unit:$(systemctl is-active junkalot 2>/dev/null || echo unknown)"',
  'if ss -tln 2>/dev/null | grep -q ":5006 "; then echo "port:up"; else echo "port:down"; fi',
].join('\n');

// Every key the Parrot check reports, in the order a person reads them.
const FILE_KEYS = [
  ['deps', 'node_modules/next'],
  ['envlocal', '.env.local'],
  ['envprod', '.env.production.local'],
  ['nextconfig', 'next.config.js'],
  ['packagejson', 'package.json'],
  ['build', 'a staged build with BUILD_READY'],
  ['unit', 'junkalot.service'],
  ['port', 'port 5006'],
];

let alert = () => {};
let timer = null;
let started = false;
let failures = 0;
let wasDown = false;
let lastAlertAt = 0;
let lastState = { ok: null, at: null, detail: 'not probed yet' };

function getJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      const lib = url.startsWith('https:') ? https : http;
      req = lib.get(url, { timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 20000) body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return done({ ok: false, status: res.statusCode });
          try {
            done({ ok: true, status: res.statusCode, json: JSON.parse(body) });
          } catch {
            done({ ok: false, status: res.statusCode, detail: 'unreadable body' });
          }
        });
      });
      req.on('timeout', () => {
        try { req.destroy(); } catch {}
        done({ ok: false, detail: 'timeout' });
      });
      req.on('error', (err) => done({ ok: false, detail: err.code || err.message }));
    } catch (err) {
      done({ ok: false, detail: err.message });
    }
  });
}

function runOnParrot(script) {
  return new Promise((resolve) => {
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', SSH_TARGET, script],
      { timeout: SSH_TIMEOUT_MS },
      (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, detail: err.killed ? 'ssh timeout' : err.code || err.message });
        resolve({ ok: true, text: String(stdout || '').trim() });
      },
    );
  });
}

function parseHeal(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// A key is bad when its value is not the healthy one. deps:restored is healthy (it healed).
function isBad(key, value) {
  if (!value) return true;
  if (key === 'deps') return value !== 'ok' && value !== 'restored';
  if (key === 'unit') return value !== 'active';
  if (key === 'port') return value !== 'up';
  return value !== 'ok';
}

function missingFiles(deps) {
  const missing = [];
  for (const [key, label] of FILE_KEYS) {
    if (isBad(key, deps[key])) missing.push('- ' + label + ' — ' + (deps[key] || 'no reading'));
  }
  return missing;
}

/**
 * Human-readable file/dependency report for junkalot on Parrot. Heals a missing
 * dependency tree on the way through, exactly like the automatic check does.
 * Used by the security bot's /files command and available for manual runs.
 */
async function filesReport() {
  const deps = await checkDeps();
  if (deps.unreachable) {
    return 'Junkalot files — could not read Parrot over SSH.\n\n' + deps.detail;
  }
  const lines = ['Junkalot files — parrot, master /home/ghost694/junkalot', ''];
  for (const [key, label] of FILE_KEYS) {
    const value = deps[key] || 'no reading';
    const good = !isBad(key, value);
    const note = key === 'deps' && value === 'restored' ? 'restored just now' : value;
    lines.push((good ? '✅ ' : '❌ ') + label + ' — ' + note);
  }
  const missing = missingFiles(deps);
  lines.push('');
  lines.push(missing.length ? 'MISSING: ' + missing.length + ' item(s) need attention.' : 'All required files, deps and the service check out.');
  const probe = await probeOnce();
  lines.push('Site: ' + (probe.ok ? 'answering — ' + probe.detail : 'NOT answering — ' + probe.detail));
  return lines.join('\n');
}

function send(text) {
  lastAlertAt = Date.now();
  try {
    Promise.resolve(alert(text)).catch(() => {});
  } catch {}
  console.log('[junkalot-guard] alert:', text.replace(/\n/g, ' | '));
}

/**
 * One probe. Returns { ok, source, detail }. Never throws.
 */
async function probeOnce() {
  const pub = await getJson(PRIMARY, PROBE_TIMEOUT_MS);
  if (pub.ok) {
    const build = pub.json && pub.json.build ? String(pub.json.build).slice(0, 64) : 'unknown build';
    const state = { ok: true, source: 'public', detail: 'https ok, ' + build };
    lastState = { ...state, at: Date.now() };
    return state;
  }

  const local = await getJson(FALLBACK, PROBE_TIMEOUT_MS);
  if (local.ok) {
    const state = { ok: false, source: 'local', detail: 'public https failing (' + (pub.detail || pub.status || 'no answer') + '), app answering on 10.0.0.251:5006' };
    lastState = { ...state, at: Date.now() };
    return state;
  }

  const state = { ok: false, source: 'down', detail: 'public: ' + (pub.detail || pub.status || 'no answer') + '; local: ' + (local.detail || local.status || 'no answer') };
  lastState = { ...state, at: Date.now() };
  return state;
}

/**
 * Check the dependency tree on Parrot and restore it if missing. Returns parsed output.
 */
async function checkDeps() {
  const res = await runOnParrot(HEAL_SCRIPT);
  if (!res.ok) return { unreachable: true, detail: res.detail };
  return parseHeal(res.text);
}

async function tick() {
  const before = await probeOnce();
  const deps = await checkDeps();

  // Parrot unreadable: keep the reading honest and only speak up if the site is down too.
  if (deps.unreachable) {
    if (!before.ok) {
      failures += 1;
      if (failures >= FAILURES_BEFORE_ALERT && Date.now() - lastAlertAt > ALERT_REPEAT_MS) {
        wasDown = true;
        send('junkalot.co is down and Parrot could not be read over SSH, so I could not check or heal it.\n\nProbe: ' + before.detail + '\nSSH: ' + deps.detail);
      }
    }
    return;
  }

  const missing = missingFiles(deps);

  // A restored dependency tree: let the unit's own Restart=always come up, then re-check.
  if (deps.deps === 'restored') {
    await new Promise((r) => setTimeout(r, 12000));
    const after = await probeOnce();
    if (after.ok) {
      failures = 0;
      wasDown = false;
      send('junkalot.co was down because its node_modules had gone missing on Parrot.\n\nRestored it from the editing copy; the service came back on its own.\n\nProbe: ' + after.detail);
    } else {
      wasDown = true;
      send('junkalot.co is down: node_modules was missing and I restored it, but the site is still not answering.\n\nProbe: ' + after.detail + '\nUnit: ' + (deps.unit || 'unknown') + ', port: ' + (deps.port || 'unknown'));
    }
    return;
  }

  if (before.ok) {
    failures = 0;
    if (wasDown) {
      wasDown = false;
      send('junkalot.co is answering again.\n\nProbe: ' + before.detail);
    }
    // Site up but something is missing on disk — say so before it becomes an outage.
    if (missing.length && Date.now() - lastAlertAt > ALERT_REPEAT_MS) {
      wasDown = true;
      send('junkalot.co is up, but files are missing on Parrot:\n\n' + missing.join('\n') + '\n\nProbe: ' + before.detail);
    }
    return;
  }

  failures += 1;

  // Public failing but the app is up means the edge/tunnel path, not the app.
  if (before.source === 'local') {
    send('junkalot.co public HTTPS is failing while the app answers locally.\n\n' + before.detail + (missing.length ? '\n\nMissing on Parrot:\n' + missing.join('\n') : ''));
    return;
  }

  // Site is down and something is missing on disk — that is the actionable detail.
  if (missing.length) {
    wasDown = true;
    send('junkalot.co is down. Missing or unhealthy on Parrot:\n\n' + missing.join('\n') + '\n\nProbe: ' + before.detail);
    return;
  }

  if (failures >= FAILURES_BEFORE_ALERT && Date.now() - lastAlertAt > ALERT_REPEAT_MS) {
    wasDown = true;
    send('junkalot.co is down but every file, dependency and the unit check out, so this is not a missing-file failure.\n\nProbe: ' + before.detail + '\nUnit: ' + (deps.unit || 'unknown') + ', port: ' + (deps.port || 'unknown'));
  }
}

function start(opts) {
  if (started) return;
  if (opts && typeof opts.alert === 'function') alert = opts.alert;
  started = true;
  const run = () => {
    tick().catch((err) => console.warn('[junkalot-guard] tick failed:', err && err.message));
  };
  const first = setTimeout(run, FIRST_PROBE_DELAY_MS);
  const repeated = setInterval(run, INTERVAL_MS);
  if (first.unref) first.unref();
  if (repeated.unref) repeated.unref();
  timer = repeated;
  console.log('  ✓ Junkalot guard started (probe every ' + Math.round(INTERVAL_MS / 60000) + ' min, self-heals a missing dependency tree)');
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

module.exports = { start, stop, probeOnce, checkDeps, filesReport, _state: () => lastState };
