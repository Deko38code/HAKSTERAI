'use strict';
/**
 * Fleet ops log — one feed for bots, build guards and agents.
 *
 * 2026-11-16 (owner): "all logs go to haksterai.com dash from junkalot and
 * phantomide dash no data is displayed about bots ever on junkalot admin never
 * to coach only lessons etc need wired back to admin haksterai.com phantomide".
 *
 * What this module does:
 *   1. records bot/agent events from this box (every Telegram role delivery,
 *      plus anything an agent appends through POST /api/admin/fleet-log) into
 *      server/data/fleet-log.jsonl — append-only, capped, never trimmed;
 *   2. pulls the same feed from the two Parrot sites over the owner SSH alias —
 *      junkalot's guard/build/ops records and Mr Ed's coach-lessons ledger, and
 *      phantomide's data/ops-log.jsonl. Junkalot's own /api/fleet-log is
 *      owner-gated (403 to everyone else), so nothing here depends on it;
 *   3. leaves a small snapshot of the merged feed on each Parrot site at
 *      data/fleet-snapshot.json, so each admin page shows the fleet without
 *      needing to reach this box. Missing snapshots are reported as missing,
 *      never invented.
 *
 * Every row is a record that exists on disk. Nothing is inferred.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOCAL_FILE = path.join(DATA_DIR, 'fleet-log.jsonl');
const SSH_ALIAS = process.env.PEER_SSH_ALIAS || 'parrot';
const JUNKALOT_FEED = process.env.JUNKALOT_FLEET_FEED || 'https://junkalot.co/api/fleet-log';
const TTL_MS = 20000;
const TIMEOUT_MS = 9000;
const PER_SITE = 40;
const MAX_ROWS = 80;
const MAX_BYTES = 8 * 1024 * 1024;

// Where the snapshot is left on each Parrot site, so those admins can show it.
const SNAPSHOT_TARGETS = [
  { site: 'junkalot', dir: '/home/ghost694/junkalot/data' },
  { site: 'phantomide', dir: '/home/ghost694/phantomide/data' },
];
const PHANTOM_OPS_FILE = '/home/ghost694/phantomide/data/ops-log.jsonl';
const PHANTOM_UPDATE_FILE = '/home/ghost694/phantomide/data/update-log.jsonl';

let cache = { at: 0, value: null, inflight: null };
let lastPush = { at: 0, signature: '', states: {} };

function clean(v, n) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
}

// Anything token-shaped never reaches a log line, a snapshot or a page.
function scrub(text, n) {
  return clean(text, n)
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/\b(sk|pk|rk)_[A-Za-z0-9]{12,}\b/g, '[redacted-key]')
    .replace(/\b[Aa][Ii]za[0-9A-Za-z_-]{20,}/g, '[redacted-key]')
    .slice(0, n);
}

function row(patch) {
  return {
    at: clean(patch && patch.at, 40) || new Date().toISOString(),
    site: clean(patch && patch.site, 30) || 'haksterai',
    box: clean(patch && patch.box, 20) || 'dell',
    agent: scrub(patch && patch.agent, 60) || 'unknown',
    kind: clean(patch && patch.kind, 30) || 'ops',
    action: scrub(patch && patch.action, 140) || 'event',
    detail: scrub(patch && patch.detail, 400),
    build: clean(patch && patch.build, 80),
    // Where it happened. Kept because a PhantomIDE update row is only
    // meaningful with the page it happened on. No actor, no IP, no UA.
    path: clean(patch && patch.path, 200),
  };
}

function appendLocal(event) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try { if (fs.statSync(LOCAL_FILE).size > MAX_BYTES) return false; } catch (_) {}
    fs.appendFileSync(LOCAL_FILE, JSON.stringify(row({ ...event, site: 'haksterai', box: 'dell' })) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/** Record one bot/agent event. Never throws, never blocks the caller. */
function record(event) {
  const ok = appendLocal(event);
  // A new event is worth showing immediately on the next dashboard poll.
  cache.at = 0;
  return ok;
}

function parseLines(text, site, box) {
  const rows = [];
  let bad = 0;
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object') rows.push(row({ ...parsed, site: parsed.site || site, box: parsed.box || box }));
    } catch (_) { bad += 1; }
  }
  return { rows, bad };
}

function readLocal() {
  try {
    const text = fs.readFileSync(LOCAL_FILE, 'utf8');
    const lines = text.trim() ? text.trim().split('\n').slice(-PER_SITE).join('\n') : '';
    const { rows, bad } = parseLines(lines, 'haksterai', 'dell');
    return { site: 'haksterai', state: rows.length ? 'ok' : 'empty', rows, error: bad ? bad + ' unreadable line(s)' : '' };
  } catch (err) {
    if (err.code === 'ENOENT') return { site: 'haksterai', state: 'empty', rows: [], error: '' };
    return { site: 'haksterai', state: 'error', rows: [], error: clean(err.message, 160) };
  }
}

// Junkalot's bot/agent rows are operator data, so its own feed is owner-only
// now (2026-11-16: "clients can see i know we have bots running server only").
// This hub reads the same records the site's admin reads, over the owner SSH
// alias: the guard's verified/selfcheck/handoff records, the staged build, and
// any ops rows a bot appended. Nothing is published publicly.
const JUNKALOT_FILES = {
  guard: '/home/ghost694/junkalot/data/auto-apply.json',
  attempt: '/home/ghost694/junkalot/data/apply-update.json',
  latest: '/home/ghost694/junkalot/data/latest-build.json',
  ops: '/home/ghost694/junkalot/data/ops-log.jsonl',
  // Mr Ed's lesson/badge ledger. Lessons stay on the box that runs Junkalot;
  // badge rows are mirrored to the owner's admins here.
  lessons: '/home/ghost694/junkalot/data/coach-lessons.jsonl',
};

function junkalotRow(patch) {
  return row({ site: 'junkalot', box: 'parrot', ...patch });
}

function readJunkalot() {
  const files = Object.values(JUNKALOT_FILES);
  const script = files
    // The leading newline matters: a JSON/JSONL file that does not end with a
    // newline would otherwise glue the next header onto its last line, and the
    // block splitter would never see it.
    .map((f) => `printf '\\n@@%s\\n' "${f}"; if [ -f "${f}" ]; then tail -c 20000 "${f}"; else echo MISSING; fi`)
    .join('; ');
  return new Promise((resolve) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', SSH_ALIAS, script], {
      timeout: TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) return resolve({ site: 'junkalot', state: 'unreachable', rows: [], error: clean(err.message, 160) });
      const blocks = String(stdout || '').split(/^@@/m).slice(1);
      const byFile = new Map();
      for (const block of blocks) {
        const nl = block.indexOf('\n');
        const file = (nl === -1 ? block : block.slice(0, nl)).trim();
        byFile.set(file, (nl === -1 ? '' : block.slice(nl + 1)).trim());
      }
      const jsonOf = (key) => {
        const body = byFile.get(JUNKALOT_FILES[key]);
        if (!body || body === 'MISSING') return null;
        try { return JSON.parse(body); } catch (_) { return null; }
      };
      const rows = [];
      const guard = jsonOf('guard');
      if (guard && guard.verified && guard.verified.build) {
        rows.push(junkalotRow({
          at: guard.verified.at,
          agent: 'junkalot update guard',
          kind: 'guard',
          action: 'verified the build after the handoff',
          detail: 'pid ' + guard.verified.pid + ' is serving the build it applied',
          build: guard.verified.build,
        }));
      }
      if (guard && guard.selfcheck && guard.selfcheck.build) {
        const sc = guard.selfcheck;
        rows.push(junkalotRow({
          at: sc.at,
          agent: 'junkalot update guard',
          kind: 'selfcheck',
          action: sc.ok ? 'selfcheck passed' : 'selfcheck FAILED',
          detail: (sc.checks || []).map((c) => (c.ok ? 'ok ' : 'FAIL ') + c.name + ' (' + c.detail + ')').join(' · '),
          build: sc.build,
        }));
      }
      const attempt = jsonOf('attempt');
      if (attempt && attempt.build) {
        rows.push(junkalotRow({
          at: attempt.at,
          agent: 'junkalot update guard',
          kind: 'handoff',
          action: 'handed the process back to systemd',
          detail: 'attempt ' + attempt.attempts + ' — systemd Restart=always starts the new build',
          build: attempt.build,
        }));
      }
      const latest = jsonOf('latest');
      if (latest && latest.build) {
        rows.push(junkalotRow({
          at: latest.stagedAt,
          agent: 'junkalot build stager',
          kind: 'build',
          action: 'staged a production build',
          detail: String(latest.dir || '') + (latest.verified ? ' · verified ' + String(latest.verifiedAt || '') : ' · awaiting verification'),
          build: latest.build,
        }));
      }
      const opsBody = byFile.get(JUNKALOT_FILES.ops);
      if (opsBody && opsBody !== 'MISSING') {
        const { rows: ops } = parseLines(opsBody, 'junkalot', 'parrot');
        for (const o of ops) rows.push(o);
      }
      const lessonsBody = byFile.get(JUNKALOT_FILES.lessons);
      if (lessonsBody && lessonsBody !== 'MISSING') {
        const lessonRows = [];
        for (const line of lessonsBody.split('\n')) {
          const t = line.trim();
          if (!t || t[0] !== '{') continue;
          try {
            const entry = JSON.parse(t);
            if (!entry || typeof entry !== 'object') continue;
            // Badge rows are already mirrored into the ops log by Junkalot, so
            // read this ledger for the lesson turns and keep one copy of each.
            if (entry.badge) continue;
            lessonRows.push(junkalotRow({
              at: entry.at,
              agent: 'Mr Ed · coach',
              kind: entry.badge ? 'badge' : 'lesson',
              action: entry.action || 'lesson',
              detail: [entry.badgeName || entry.badge, entry.verified && entry.total ? entry.verified + '/' + entry.total + ' verified' : '', entry.detail].filter(Boolean).join(' · '),
              build: '',
            }));
          } catch (_) { /* skip malformed line */ }
        }
        // The lesson ledger can be long; show the newest handful only.
        rows.push(...lessonRows.slice(-10));
      }
      rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      resolve({ site: 'junkalot', state: rows.length ? 'ok' : 'empty', rows: rows.slice(0, PER_SITE), error: '' });
    });
  });
}

// PhantomIDE keeps its own logs on Parrot. Its bot/agent ops log is the primary
// source; until it has one, its page update log is the real record of what the
// IDE did. Either way the rows are read-only over the owner SSH alias and a
// missing file is reported absent, never filled in.
function readPhantomide() {
  const script = `for f in "${PHANTOM_OPS_FILE}" "${PHANTOM_UPDATE_FILE}"; do printf '\\n@@%s\\n' "$f"; if [ -f "$f" ]; then wc -l < "$f"; tail -n ${PER_SITE} "$f"; else echo MISSING; fi; done`;
  return new Promise((resolve) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', SSH_ALIAS, script], {
      timeout: TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) return resolve({ site: 'phantomide', state: 'unreachable', rows: [], error: clean(err.message, 160) });
      const blocks = String(stdout || '').split(/^@@/m).slice(1);
      const byFile = new Map();
      for (const block of blocks) {
        const nl = block.indexOf('\n');
        const file = (nl === -1 ? block : block.slice(0, nl)).trim();
        byFile.set(file, (nl === -1 ? '' : block.slice(nl + 1)).trim());
      }
      const read = (file, kind) => {
        const body = byFile.get(file);
        if (body == null || body === 'MISSING') return null;
        const splitAt = body.indexOf('\n');
        const text = splitAt === -1 ? '' : body.slice(splitAt + 1);
        const { rows, bad } = parseLines(text, 'phantomide', 'parrot');
        return {
          state: rows.length ? 'ok' : 'empty',
          rows: rows.map((r) => ({
            ...r,
            site: 'phantomide',
            box: 'parrot',
            agent: r.agent && r.agent !== 'unknown' ? r.agent : kind === 'ops' ? 'phantomide agent' : 'phantomide page',
            kind: r.kind === 'ops' && kind === 'update' ? 'update' : r.kind,
            action: kind === 'update' ? 'update · ' + clean(r.action, 60) : r.action,
            detail: kind === 'update'
              ? [r.path, r.build ? 'build ' + String(r.build).slice(0, 8) : ''].filter(Boolean).join(' · ')
              : r.detail,
          })),
          error: bad ? bad + ' unreadable line(s)' : '',
        };
      };
      const ops = read(PHANTOM_OPS_FILE, 'ops');
      const updates = read(PHANTOM_UPDATE_FILE, 'update');
      const chosen = ops && ops.rows.length ? ops : updates;
      if (!chosen) return resolve({ site: 'phantomide', state: 'absent', rows: [], error: '' });
      resolve({ site: 'phantomide', state: chosen.state, rows: chosen.rows, error: chosen.error });
    });
  });
}

// Leave the merged feed where each Parrot admin can read it. Atomic per file
// (temp + rename), so a reader never sees half a snapshot.
function pushSnapshot(snapshot) {
  const signature = snapshot.events.map((e) => e.at + e.site + e.action).join('|');
  if (signature === lastPush.signature && Date.now() - lastPush.at < 5 * 60 * 1000) return Promise.resolve(lastPush.states);
  const payload = JSON.stringify(snapshot, null, 2);
  const states = {};
  const writes = SNAPSHOT_TARGETS.map((target) => new Promise((resolve) => {
    const script = `umask 022; mkdir -p "${target.dir}"; T=$(mktemp "${target.dir}/.fleet-snapshot.XXXXXX") && cat > "$T" && mv "$T" "${target.dir}/fleet-snapshot.json"`;
    let child;
    try {
      child = execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', SSH_ALIAS, script], {
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      }, (err, _stdout, stderr) => {
        if (err) {
          states[target.site] = 'unreachable';
          console.warn('[fleet-log] snapshot not written for', target.site, '-', clean(err.message || stderr, 160));
        } else {
          states[target.site] = 'ok';
        }
        resolve();
      });
      // execFile pipes stdin by default; the JSON goes in and the pipe closes.
      if (child.stdin) child.stdin.end(payload);
    } catch (err) {
      states[target.site] = 'error';
      console.warn('[fleet-log] snapshot write failed for', target.site, '-', clean(err.message, 160));
      resolve();
    }
  }));
  return Promise.all(writes).then(() => {
    lastPush = { at: Date.now(), signature, states };
    return states;
  });
}

/** Cached (20s) single-flight view of the fleet feed. */
async function getState(force = false) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < TTL_MS) return cache.value;
  if (cache.inflight) return cache.inflight;
  cache.inflight = (async () => {
    const local = readLocal();
    const [junkalot, phantomide] = await Promise.all([readJunkalot(), readPhantomide()]);
    const sources = [local, junkalot, phantomide];
    const events = sources
      .flatMap((s) => s.rows)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, MAX_ROWS);
    const value = {
      at: new Date().toISOString(),
      schema: ['at', 'site', 'box', 'agent', 'kind', 'action', 'detail', 'build'],
      sources: sources.map((s) => ({ site: s.site, state: s.state, rows: s.rows.length, error: s.error || '' })),
      events,
      readOnly: true,
    };
    const snapshot = {
      generatedAt: value.at,
      hub: 'haksterai.com',
      sources: value.sources.map((s) => ({ site: s.site, state: s.state, events: s.rows })),
      events: value.events,
    };
    try {
      value.snapshot = await pushSnapshot(snapshot);
    } catch (err) {
      value.snapshot = { error: clean((err && err.message) || err, 160) };
    }
    cache = { at: Date.now(), value, inflight: null };
    return value;
  })().catch((err) => {
    cache = { at: Date.now(), value: { at: new Date().toISOString(), sources: [], events: [], error: clean(err.message, 160), readOnly: true }, inflight: null };
    return cache.value;
  });
  return cache.inflight;
}

module.exports = { getState, record, LOCAL_FILE, SNAPSHOT_TARGETS, SSH_ALIAS, JUNKALOT_FEED, startPulse };

// 2026-11-16 (owner): "always" — the feed refreshes and the snapshots get left
// on both Parrot sites on their own, not only when someone opens the dashboard.
// Unref'd, so it never keeps a short-lived script alive; ~90s between reads of
// two sites is a handful of bounded commands, nothing more.
let pulse = null;
function startPulse() {
  if (pulse) return pulse;
  const every = Math.max(30000, Number(process.env.FLEET_PULSE_MS) || 90000);
  pulse = setInterval(() => {
    getState(true).catch(() => {});
  }, every);
  if (pulse.unref) pulse.unref();
  const first = setTimeout(() => {
    getState(true).catch(() => {});
  }, 8000);
  if (first.unref) first.unref();
  return pulse;
}

startPulse();
