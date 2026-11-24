'use strict';
/**
 * Server build sync — keeps the running API process on the same code as the
 * page build it serves.
 *
 * 2026-11-16 (owner): "can u fix split to be in sync". Page builds already
 * refresh themselves the moment a new one lands (dist/index.html carries a
 * build id and every tab polls /api/version). The server half did not: any
 * change under server/src only took effect after a manual `pm2 restart`, so a
 * freshly built page could sit in front of an old API for hours.
 *
 * This module closes that gap the same way Junkalot does it — apply while the
 * box is idle, never during live work:
 *
 *  - at boot it stamps every .js file under server/src (names + sizes + mtimes);
 *  - a cheap check (5 s cache) says whether the files on disk still match;
 *  - when they do not match, the process waits until it is genuinely idle
 *    (no request has been open longer than the stream threshold, and nothing
 *    has been streaming for a quiet window) and then exits cleanly, letting
 *    pm2's autorestart bring it back on the new code.
 *
 * Safety rails, deliberately conservative:
 *  - never within the first 90 s after boot;
 *  - never while any long-lived request (SSE/CLI/chat stream) is open;
 *  - never while a CLI session is attached (it polls /api/tui/status every 3 s);
 *  - never until a full quiet window has passed since the last one closed;
 *  - one attempt only per process, and every attempt is logged and announced;
 *  - a manual owner route can apply it immediately when the operator asks.
 *
 * Nothing here reads or writes config, and it never touches another process —
 * it only ends its own process, which pm2 is configured to restart.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC_DIR = __dirname;
const STAMP_TTL_MS = 5000;
const LONG_REQUEST_MS = 5000;   // a request open this long is live work
const QUIET_MS = 60000;         // idle this long before we apply
const MIN_UPTIME_MS = 90000;    // never apply in the first 90 s
// 2026-11-24 (owner): "no restart" while a CLI session is attached. The TUI
// polls /api/tui/status every 3 s. A poll within this window means a live CLI
// session, so the auto-apply holds instead of bouncing the process out from
// under it. The explicit owner route (applyNow) still applies on request.
const CLI_ATTACH_MS = 25000;    // a CLI tab is attached if seen this recently
const TICK_MS = 15000;
const EXIT_DELAY_MS = 1500;

const BOOT = {
  at: Date.now(),
  iso: new Date().toISOString(),
  pid: process.pid,
  stamp: null, // filled on first compute below
};

let stampCache = { at: 0, stamp: null, files: [] };
let inflight = 0;
let longLived = 0;
let lastLongEnd = Date.now();
let lastCliSeen = 0;
let applying = false;
let lastApply = null;
let timer = null;

function listSourceFiles(dir = SRC_DIR, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      listSourceFiles(full, out);
    } else if (ent.isFile() && (ent.name.endsWith('.js') || ent.name.endsWith('.cjs')) && !ent.name.includes('.bak')) {
      out.push(full);
    }
  }
  return out;
}

// The live applet, build-history recorder and stability monitor live under
// dev/ and are loaded by this process. Watching them here means a fix to the
// applet itself ships the same way every other server change does — when the
// box is idle, in the background, with no manual restart.
const EXTRA_SOURCE_DIRS = [
  path.join(__dirname, '..', '..', 'dev', 'applet'),
  path.join(__dirname, '..', '..', 'dev', 'build-history', 'lib'),
];

function computeStamp() {
  if (Date.now() - stampCache.at < STAMP_TTL_MS && stampCache.stamp) return stampCache;
  const files = listSourceFiles();
  for (const dir of EXTRA_SOURCE_DIRS) listSourceFiles(dir, files);
  const hash = crypto.createHash('sha256');
  const details = [];
  for (const full of files.sort()) {
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    const rel = path.relative(SRC_DIR, full);
    hash.update(rel + ':' + st.size + ':' + Math.round(st.mtimeMs) + '\n');
    details.push({ file: rel, size: st.size, mtime: Math.round(st.mtimeMs) });
  }
  stampCache = { at: Date.now(), stamp: hash.digest('hex').slice(0, 16), files: details };
  return stampCache;
}

// Captured at require time — i.e. the exact code this process was started with.
// This must happen before any later deploy so a change is always detectable.
BOOT.stamp = computeStamp().stamp;

function bootStamp() {
  return BOOT.stamp;
}

/** Files newer than this process started — the ones a restart would pick up. */
function pendingFiles() {
  const { files } = computeStamp();
  return files.filter((f) => f.mtime > BOOT.at).map((f) => f.file).slice(0, 40);
}

function status() {
  const current = computeStamp();
  const pending = pendingFiles();
  return {
    serverBuild: BOOT.iso,
    serverPid: BOOT.pid,
    startedAt: BOOT.iso,
    sourceStamp: bootStamp(),
    currentStamp: current.stamp,
    stale: current.stamp !== bootStamp() || pending.length > 0,
    pendingFiles: pending,
    pendingCount: pending.length,
    inflight,
    longLived,
    secondsSinceLongRequest: Math.max(0, Math.round((Date.now() - lastLongEnd) / 1000)),
    cliAttached: cliAttached(),
    secondsSinceCliSeen: lastCliSeen ? Math.max(0, Math.round((Date.now() - lastCliSeen) / 1000)) : null,
    holdReason: holdReason(),
    idle: isIdle(),
    applying,
    lastApply,
  };
}

/**
 * A CLI session is attached when the TUI has polled /api/tui/status inside the
 * attach window. The server calls noteCliSeen() from that route; nothing here
 * inspects processes. A dead CLI ages out on its own after CLI_ATTACH_MS.
 */
function noteCliSeen() {
  lastCliSeen = Date.now();
}

function cliAttached() {
  return lastCliSeen > 0 && (Date.now() - lastCliSeen) < CLI_ATTACH_MS;
}

/** Why an apply is being held, for the status payload and the log. */
function holdReason() {
  if (longLived > 0) return 'live request open';
  if (Date.now() - BOOT.at < MIN_UPTIME_MS) return 'booting';
  if (cliAttached()) return 'CLI session attached';
  if (Date.now() - lastLongEnd < QUIET_MS) return 'quiet window';
  return null;
}

function isIdle() {
  if (longLived > 0) return false;
  if (Date.now() - BOOT.at < MIN_UPTIME_MS) return false;
  // Never bounce the process while a CLI session is attached: a restart drops
  // its stream. It applies in the first quiet window after the CLI detaches.
  if (cliAttached()) return false;
  return Date.now() - lastLongEnd >= QUIET_MS;
}

/**
 * Express middleware: counts requests and, separately, the ones that stay open
 * long enough to be a live stream (SSE chat/CLI/agent run).
 */
function track() {
  return function serverBuildTracker(req, res, next) {
    // The applet's own status stream is a read-only telemetry feed, not live
    // work. Counting it as long-lived would keep `idle` false for as long as
    // any browser tab is open, and updates would never apply in the background.
    if (req.path === '/api/applet/stream' || req.path === '/api/applet/status') return next();
    inflight++;
    let marked = false;
    const markTimer = setTimeout(() => {
      if (!res.writableEnded) {
        marked = true;
        longLived++;
      }
    }, LONG_REQUEST_MS);
    if (markTimer.unref) markTimer.unref();
    const done = () => {
      clearTimeout(markTimer);
      inflight = Math.max(0, inflight - 1);
      if (marked) {
        marked = false;
        longLived = Math.max(0, longLived - 1);
        lastLongEnd = Date.now();
      }
    };
    res.on('close', done);
    res.on('finish', done);
    next();
  };
}

// Only ever end this process when something is there to bring it back. Under
// pm2 (autorestart true) that is guaranteed; a hand-started `npm run server`
// has no supervisor, so it is refused rather than left dead.
function supervised() {
  return !!(process.env.pm_id || process.env.PM2_HOME || process.env.pm_exec_path);
}

function applyNow(reason, notify) {
  if (applying) return { ok: false, reason: 'already applying' };
  if (!supervised()) return { ok: false, reason: 'not running under pm2 — restart it manually to pick up server changes' };
  applying = true;
  lastApply = { at: new Date().toISOString(), reason };
  const st = status();
  const msg = 'hakster: applying server update while idle (' + st.pendingCount + ' file(s)' +
    (st.pendingFiles.length ? ': ' + st.pendingFiles.slice(0, 6).join(', ') : '') + ') — ' +
    'the process restarts on the new code. Reason: ' + reason + '.';
  console.log('[server-build] ' + msg);
  if (typeof notify === 'function') {
    try { notify(msg); } catch (_) { /* a notice must never block the apply */ }
  }
  setTimeout(() => {
    try {
      // Own process only. pm2 (autorestart: true) starts it again on the new code.
      process.exit(0);
    } catch (_) {
      try { process.kill(process.pid, 'SIGTERM'); } catch (_) {}
    }
  }, EXIT_DELAY_MS);
  return { ok: true, applying: true, status: st };
}

function tick(notify) {
  if (applying) return;
  const st = status();
  if (!st.stale) return;
  if (!st.idle) return;
  applyNow('idle auto-apply', notify);
}

function startAutoApply(opts = {}) {
  if (timer) return;
  timer = setInterval(() => tick(opts.notify), TICK_MS);
  if (timer.unref) timer.unref();
  console.log('[server-build] auto-apply armed — server code changes apply when the box is idle');
}

module.exports = {
  track,
  status,
  isIdle,
  noteCliSeen,
  cliAttached,
  applyNow,
  startAutoApply,
  BOOT,
  _constants: { LONG_REQUEST_MS, QUIET_MS, MIN_UPTIME_MS, CLI_ATTACH_MS, TICK_MS },
};
