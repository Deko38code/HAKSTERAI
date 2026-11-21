'use strict';
/**
 * Shared update log — one contract, three sites.
 *
 * Every build the owner ships is stamped. Each site records "I saw build X"
 * (and every Update / Later click) as one JSON line, so the admin views always
 * agree on what went out and when.
 *
 *   site        "haksterai" | "junkalot" | "phantomide"
 *   box         "dell"      | "parrot"
 *   at          ISO-8601 UTC
 *   atLocal     browser-local string when the site can supply it
 *   build       the build the page then ran
 *   from        the build the page was running before
 *   path        where it was seen
 *   action      "seen" | "later" | "update" | "waiting" | "reload"
 *   actor       signed-in account, or "anonymous"
 *   userAgent   trimmed UA
 *
 * Read-only on the far side of the wire: the Dell reads its own file directly
 * and Parrot's files over the existing owner SSH alias with one bounded
 * `tail`/`wc` command. Nothing on either box is written or changed here.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const LOCAL_FILE = path.join(__dirname, '..', 'data', 'update-seen.jsonl');
const SSH_ALIAS = process.env.PEER_SSH_ALIAS || 'parrot';
const TTL_MS = 15000;
const TIMEOUT_MS = 9000;
const PER_FILE = 40;
const MAX_ROWS = 60;

// Parrot-side logs, in the order they should be preferred. A path that does not
// exist is reported as unavailable — never invented and never substituted.
const PEER_FILES = [
  { site: 'junkalot', box: 'parrot', file: '/home/ghost694/junkalot/data/update-log.jsonl' },
  { site: 'phantomide', box: 'parrot', file: '/home/ghost694/phantomide/data/update-log.jsonl' },
];

let cache = { at: 0, value: null, inflight: null };

function clean(v, n) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
}

function normalize(entry, site, box) {
  const at = clean(entry.at || entry.seenAt, 40);
  return {
    site: clean(entry.site, 20) || site,
    box: clean(entry.box, 12) || box,
    at,
    atLocal: clean(entry.atLocal, 40) || '',
    action: clean(entry.action, 16) || 'seen',
    build: clean(entry.build, 60),
    from: clean(entry.from, 60),
    path: clean(entry.path, 160),
    actor: clean(entry.actor || entry.ip, 120) || 'anonymous',
    userAgent: clean(entry.userAgent || entry.ua, 160),
  };
}

function parseLines(text, site, box) {
  const rows = [];
  let bad = 0;
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed && (parsed.at || parsed.seenAt)) rows.push(normalize(parsed, site, box));
    } catch { bad += 1; }
  }
  return { rows, bad };
}

function readLocal() {
  try {
    const text = fs.readFileSync(LOCAL_FILE, 'utf8');
    const lines = text.trim() ? text.trim().split('\n').slice(-PER_FILE).join('\n') : '';
    const { rows } = parseLines(lines, 'haksterai', 'dell');
    return { site: 'haksterai', box: 'dell', state: rows.length ? 'ok' : 'empty', rows, error: '' };
  } catch (err) {
    if (err.code === 'ENOENT') return { site: 'haksterai', box: 'dell', state: 'empty', rows: [], error: '' };
    return { site: 'haksterai', box: 'dell', state: 'error', rows: [], error: clean(err.message, 160) };
  }
}

function readPeer() {
  const targets = PEER_FILES.map((f) => f.file);
  const script = targets
    .map((f) => `echo "@@${f}"; if [ -f "${f}" ]; then wc -l < "${f}"; tail -n ${PER_FILE} "${f}"; else echo MISSING; fi`)
    .join('; ');
  return new Promise((resolve) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', SSH_ALIAS, script], {
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout) => {
      const raw = String(stdout || '');
      if (err) {
        return resolve(PEER_FILES.map((f) => ({ site: f.site, box: f.box, state: 'unreachable', rows: [], total: null, error: clean(err.message, 160) })));
      }
      const blocks = raw.split(/^@@/m).slice(1);
      const byFile = new Map();
      for (const block of blocks) {
        const nl = block.indexOf('\n');
        const file = (nl === -1 ? block : block.slice(0, nl)).trim();
        const body = nl === -1 ? '' : block.slice(nl + 1);
        byFile.set(file, body.trim());
      }
      resolve(PEER_FILES.map((f) => {
        const body = byFile.get(f.file);
        if (body == null) return { site: f.site, box: f.box, state: 'unavailable', rows: [], total: null, error: 'not reported' };
        if (body === 'MISSING' || body === '') return { site: f.site, box: f.box, state: 'absent', rows: [], total: 0, error: '' };
        const splitAt = body.indexOf('\n');
        const countLine = splitAt === -1 ? '' : body.slice(0, splitAt).trim();
        const text = splitAt === -1 ? '' : body.slice(splitAt + 1);
        const total = Number.isFinite(Number(countLine)) ? Number(countLine) : null;
        const { rows, bad } = parseLines(text, f.site, f.box);
        return { site: f.site, box: f.box, state: rows.length ? 'ok' : 'empty', rows, total, error: bad ? bad + ' unreadable line(s)' : '' };
      }));
    });
  });
}

/** Cached (15s) single-flight view of all three sites' update logs. */
async function getState(force = false) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < TTL_MS) return cache.value;
  if (cache.inflight) return cache.inflight;
  cache.inflight = (async () => {
    const local = readLocal();
    const peers = await readPeer();
    const sources = [local].concat(peers);
    const rows = sources
      .flatMap((s) => s.rows)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, MAX_ROWS);
    const value = {
      at: new Date().toISOString(),
      schema: ['site', 'box', 'at', 'atLocal', 'action', 'build', 'from', 'path', 'actor', 'userAgent'],
      sources: sources.map((s) => ({ site: s.site, box: s.box, state: s.state, total: s.total == null ? null : s.total, rows: s.rows.length, error: s.error || '' })),
      rows,
      readOnly: true,
    };
    cache = { at: Date.now(), value, inflight: null };
    return value;
  })().catch((err) => {
    cache = { at: Date.now(), value: { at: new Date().toISOString(), sources: [], rows: [], error: clean(err.message, 160), readOnly: true }, inflight: null };
    return cache.value;
  });
  return cache.inflight;
}

module.exports = { getState, LOCAL_FILE, PEER_FILES, SSH_ALIAS };
