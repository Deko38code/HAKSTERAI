'use strict';
/**
 * gitExposure.js — continuous secret-exposure watcher for the owner's git repos.
 *
 * The pre-commit / pre-push hooks in ~/bin/secret-scan.sh stop a secret from
 * being *committed* in the first place. This module is the backstop that keeps
 * watching afterwards: it re-scans every repo on a slow cadence, covers commits
 * that got in with --no-verify, and reports any change.
 *
 * What it looks at, per repo:
 *   1. the whole tracked tree at HEAD, with --deep so values from
 *      ~/.secrets.env are matched by content, not only by key shape;
 *   2. every commit since the last run (catches a pushed commit that skipped
 *      the hooks);
 *   3. tracked files whose *names* are sensitive (.env, *.pem, id_rsa, ...);
 *   4. whether the GitHub remote is publicly readable.
 *
 * It never prints, stores, or transmits a secret value. secret-scan.sh reports
 * only `file:line` + rule name, and that is all this module keeps or sends.
 *
 * The scan is CPU-bound (~1 min for the big home repo), so it runs on its own
 * timer at EXPOSURE_INTERVAL_MS instead of inside the 5-minute security audit.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFile, spawn } = require('child_process');

const SCANNER = path.join(os.homedir(), 'bin', 'secret-scan.sh');
const STATE_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(STATE_DIR, 'git-exposure-state.json');

// 6h by default. Overridable so a manual or cron run can ask for a single pass.
const INTERVAL_MS = Number(process.env.EXPOSURE_INTERVAL_MS || 6 * 60 * 60 * 1000);
// The big /home/ghost tree takes ~55s; give it room without hanging forever.
const SCAN_TIMEOUT_MS = Number(process.env.EXPOSURE_SCAN_TIMEOUT_MS || 7 * 60 * 1000);

const SEVERITY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', INFO: 'info' };

// Repos the owner publishes. `github` is used only for the visibility probe.
const DEFAULT_REPOS = [
  { label: 'ghost-machine', path: '/home/ghost', github: 'Deko38code/ghost-machine' },
  { label: 'haksterAi', path: '/home/ghost/haksterAi', github: 'Deko38code/haksterAi' },
  { label: 'cine-vault', path: '/home/ghost/cine-vault-live', github: 'Deko38code/cine-vault' },
];

// Tracked files whose *name* is a red flag even when the scanner is quiet.
const SENSITIVE_NAME = new RegExp(
  [
    '(^|/)\\.env(\\.|$)',
    '\\.pem$',
    '(^|/)id_(rsa|ed25519|ecdsa|dsa)(\\.|$)',
    '\\.key$',
    'credentials\\.json$',
    'dump\\.pm2$',
    '(^|/)\\.npmrc$',
    '(^|/)\\.pgpass$',
    '(^|/)\\.netrc$',
    '(^|/)\\.secrets\\.env$',
    'keyrings',
    'kwallet',
  ].join('|'),
  'i'
);
const SENSITIVE_EXEMPT = /(example|sample|template|\.dist$|\.md$)/i;

let _timer = null;
let _notifCallback = null;
let _running = false;

// ── helpers ──────────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: SCAN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          timedOut: Boolean(err && err.killed),
          stdout: stdout || '',
          stderr: stderr || '',
        });
      }
    );
  });
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && raw.repos) return raw;
  } catch {}
  return { version: 1, repos: {} };
}

function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[git-exposure] could not persist state:', e.message);
  }
}

/**
 * Parse secret-scan.sh human output into findings.
 * Lines look like:  "   ✗ private-key      path/to/file.js:12"
 * The scanner never emits the matched value, so neither do we.
 */
function parseScannerOutput(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s+([✗·])\s+(\S+)\s+(\S.*?:\d+)\s*$/);
    if (!m) continue;
    out.push({
      tier: m[1] === '✗' ? 'hard' : 'soft',
      rule: m[2],
      loc: m[3],
    });
  }
  return out;
}

function dedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const k = `${f.tier}|${f.rule}|${f.loc}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

// ── per-repo checks ──────────────────────────────────────────────────────
async function currentHead(repoPath) {
  const r = await run('git', ['-C', repoPath, 'rev-parse', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function isAncestor(repoPath, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  const r = await run('git', ['-C', repoPath, 'merge-base', '--is-ancestor', ancestor, descendant]);
  return r.code === 0;
}

async function scanTree(repoPath) {
  const r = await run(SCANNER, ['--tree', '--deep'], { cwd: repoPath });
  return {
    findings: parseScannerOutput(r.stdout + '\n' + r.stderr),
    timedOut: r.timedOut,
    code: r.code,
  };
}

async function scanSince(repoPath, fromRev, toRev) {
  if (!fromRev || !toRev || fromRev === toRev) return [];
  if (!(await isAncestor(repoPath, fromRev, toRev))) {
    // History was rewritten (rebase/force-push) — fall back to the full tree.
    return [];
  }
  const r = await run(SCANNER, ['--commits', `${fromRev}..${toRev}`]);
  return parseScannerOutput(r.stdout + '\n' + r.stderr);
}

async function sensitiveTracked(repoPath) {
  const r = await run('git', ['-C', repoPath, 'ls-files', '-z']);
  if (r.code !== 0) return [];
  const hits = [];
  for (const p of r.stdout.split('\0')) {
    if (!p) continue;
    if (!SENSITIVE_NAME.test(p)) continue;
    if (SENSITIVE_EXEMPT.test(p)) continue;
    hits.push(p);
  }
  return hits;
}

/**
 * Unauthenticated probe: 200 means anyone can read the repo right now,
 * 404 means private (or gone). 60 req/h anonymous is plenty at a 6h cadence.
 * If GITHUB_TOKEN / GH_TOKEN is present it is sent as a bearer token so the
 * result is accurate for private repos too — and it is never logged.
 */
function githubVisibility(slug) {
  return new Promise((resolve) => {
    if (!slug) return resolve({ ok: false, visibility: 'unknown', reason: 'no-remote' });
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${slug}`,
        method: 'GET',
        timeout: 15000,
        headers: {
          'User-Agent': 'haksterai-git-exposure-watcher',
          Accept: 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          if (body.length < 65536) body += c;
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            let priv = null;
            try {
              priv = JSON.parse(body).private;
            } catch {}
            resolve({
              ok: true,
              visibility: priv === true ? 'private' : 'public',
              httpStatus: 200,
            });
          } else if (res.statusCode === 404) {
            resolve({ ok: true, visibility: 'private-or-missing', httpStatus: 404 });
          } else if (res.statusCode === 403) {
            resolve({ ok: false, visibility: 'unknown', reason: 'rate-limited', httpStatus: 403 });
          } else {
            resolve({ ok: false, visibility: 'unknown', reason: `http-${res.statusCode}`, httpStatus: res.statusCode });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, visibility: 'unknown', reason: 'timeout' });
    });
    req.on('error', (e) => resolve({ ok: false, visibility: 'unknown', reason: e.code || 'error' }));
    req.end();
  });
}

// ── one repo ─────────────────────────────────────────────────────────────
async function checkRepo(repo, previous) {
  const result = {
    label: repo.label,
    path: repo.path,
    ok: true,
    error: null,
    head: null,
    findings: [],
    newCommitsScanned: false,
    sensitiveFiles: [],
    visibility: null,
    durationMs: 0,
  };
  const started = Date.now();

  if (!fs.existsSync(path.join(repo.path, '.git'))) {
    result.ok = false;
    result.error = 'not a git repository';
    return result;
  }
  if (!fs.existsSync(SCANNER)) {
    result.ok = false;
    result.error = `scanner missing at ${SCANNER}`;
    return result;
  }

  const prevHead = previous && previous.head ? previous.head : null;
  result.head = await currentHead(repo.path);

  const tree = await scanTree(repo.path);
  if (tree.timedOut) {
    result.ok = false;
    result.error = 'scan timed out';
  }
  result.findings.push(...tree.findings);

  const since = await scanSince(repo.path, prevHead, result.head);
  if (since.length) result.newCommitsScanned = true;
  result.findings.push(...since);

  result.sensitiveFiles = await sensitiveTracked(repo.path);
  result.visibility = await githubVisibility(repo.github);
  result.findings = dedupe(result.findings);
  result.durationMs = Date.now() - started;
  return result;
}

// ── reporting ────────────────────────────────────────────────────────────
function signatureOf(repoResult) {
  const f = repoResult.findings
    .map((x) => `${x.tier}:${x.rule}:${x.loc}`)
    .sort()
    .join(',');
  const s = repoResult.sensitiveFiles.slice().sort().join(',');
  const v = repoResult.visibility ? repoResult.visibility.visibility : 'unknown';
  const e = repoResult.error || '';
  return `${e}|${v}|${s}|${f}`;
}

function hardCount(r) {
  return r.findings.filter((f) => f.tier === 'hard').length;
}
function softCount(r) {
  return r.findings.filter((f) => f.tier === 'soft').length;
}

function buildReport(scan) {
  const totalHard = scan.repos.reduce((n, r) => n + hardCount(r), 0);
  const totalSoft = scan.repos.reduce((n, r) => n + softCount(r), 0);
  const publicRepos = scan.repos.filter((r) => r.visibility && r.visibility.visibility === 'public');
  const errored = scan.repos.filter((r) => !r.ok);

  const lines = [];
  const head =
    totalHard > 0
      ? `🔐 Git exposure: ${totalHard} hard finding${totalHard === 1 ? '' : 's'}`
      : '🔐 Git exposure: clean';
  lines.push(head);
  lines.push('');
  lines.push(`${scan.repos.length} repos scanned · ${totalHard} hard · ${totalSoft} soft · ${scan.durationMs}ms`);

  for (const r of scan.repos) {
    const bits = [`${r.label}:`];
    if (!r.ok) {
      bits.push(`⚠️ ${r.error}`);
    } else {
      const h = hardCount(r);
      const s = softCount(r);
      bits.push(h === 0 && s === 0 ? 'clean' : `${h} hard / ${s} soft`);
      if (r.visibility && r.visibility.ok) bits.push(r.visibility.visibility);
      if (r.sensitiveFiles.length) bits.push(`${r.sensitiveFiles.length} sensitive-name file(s) tracked`);
      if (r.newCommitsScanned) bits.push('new commits checked');
    }
    lines.push('• ' + bits.join(' '));
    for (const f of r.findings.slice(0, 12)) {
      lines.push(`   ${f.tier === 'hard' ? '✗' : '·'} ${f.rule} ${f.loc}`);
    }
    if (r.findings.length > 12) lines.push(`   … ${r.findings.length - 12} more`);
    for (const s of r.sensitiveFiles.slice(0, 8)) lines.push(`   ⚠️ tracked by name: ${s}`);
    if (r.sensitiveFiles.length > 8) lines.push(`   … ${r.sensitiveFiles.length - 8} more`);
  }

  if (publicRepos.length) {
    lines.push('');
    lines.push(
      `🌐 Public right now: ${publicRepos.map((r) => r.label).join(', ')} — anyone can read them at this moment.`
    );
  }
  if (errored.length) {
    lines.push('');
    lines.push(`⚠️ Not fully checked: ${errored.map((r) => `${r.label} (${r.error})`).join(', ')}`);
  }
  lines.push('');
  lines.push('Values are never shown. Rotate anything flagged at its provider; then untrack the file.');
  return lines.join('\n');
}

let _lastSend = Promise.resolve(true);

function telegramSend(text, onDone) {
  _lastSend = new Promise((resolve) => {
    const finish = (ok) => {
      try {
        if (typeof onDone === 'function') onDone(ok);
      } finally {
        resolve(ok);
      }
    };
    // Inside the running server, initBots() has already created the bot objects.
    try {
      const tg = require('./telegramBots');
      const role = tg && tg.ROLES && tg.ROLES.TELEGRAM_BOT_TOKEN_2;
      if (role && role.bot && typeof tg.sendDeployStatus === 'function') {
        Promise.resolve(tg.sendDeployStatus(text))
          .then(finish)
          .catch((e) => {
            console.error('[git-exposure] telegram send failed:', e.message);
            finish(false);
          });
        return;
      }
    } catch (e) {
      if (process.env.EXPOSURE_DEBUG === '1') console.warn('[git-exposure] telegramBots unavailable:', e.message);
    }
    // Standalone / cron: talk to the Bot API through the report CLI. It does not
    // start polling, so it can never steal getUpdates from the running server.
    const script = path.join(__dirname, '..', 'scripts', 'telegram-report.js');
    if (!fs.existsSync(script)) {
      console.error('[git-exposure] telegram-report.js missing — report not sent');
      return finish(false);
    }
    const child = spawn(process.execPath, [script, '--role', 'coder', '--stdin'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => {
      console.error('[git-exposure] telegram-report spawn failed:', e.message);
      finish(false);
    });
    child.on('exit', (code) => {
      if (process.env.EXPOSURE_DEBUG === '1') console.log('[git-exposure] telegram-report:', out.trim());
      finish(code === 0);
    });
    child.stdin.end(text);
  });
  return _lastSend;
}

/** Wait for an in-flight Telegram report (used by the CLI before it exits). */
function waitForPendingReport(ms = 25000) {
  return Promise.race([_lastSend, new Promise((r) => setTimeout(() => r(false), ms))]);
}

function notify(text, scan) {
  if (typeof _notifCallback === 'function') {
    try {
      _notifCallback({
        message: text,
        type: 'security',
        priority: scan.totalHard > 0 ? 'critical' : 'normal',
        source: 'git-exposure',
      });
    } catch {}
  }
  telegramSend(text, (ok) => {
    if (process.env.EXPOSURE_DEBUG === '1') console.log('[git-exposure] telegram delivered:', ok);
  });
}

// ── one full pass ────────────────────────────────────────────────────────
/**
 * @param {{ repos?: Array, notify?: boolean, forceReport?: boolean }} opts
 */
async function runExposureScan(opts = {}) {
  if (_running) return null;
  _running = true;
  try {
    const repos = opts.repos && opts.repos.length ? opts.repos : DEFAULT_REPOS;
    const state = loadState();
    const started = Date.now();
    const results = [];

    for (const repo of repos) {
      const prev = state.repos[repo.label];
      let r;
      try {
        r = await checkRepo(repo, prev);
      } catch (e) {
        r = {
          label: repo.label,
          path: repo.path,
          ok: false,
          error: e.message,
          head: null,
          findings: [],
          sensitiveFiles: [],
          visibility: null,
          durationMs: 0,
        };
      }
      results.push(r);

      const sig = signatureOf(r);
      const changed = !prev || prev.signature !== sig;
      const lastReport = prev && prev.lastReport ? Date.parse(prev.lastReport) : 0;
      const staleReport = Date.now() - (Number.isNaN(lastReport) ? 0 : lastReport) > 24 * 60 * 60 * 1000;
      const shouldReport =
        Boolean(opts.forceReport) || changed || (hardCount(r) > 0 && staleReport);

      state.repos[repo.label] = {
        path: repo.path,
        github: repo.github || null,
        head: r.head,
        signature: sig,
        findings: r.findings.slice(0, 200),
        sensitiveFiles: r.sensitiveFiles.slice(0, 200),
        visibility: r.visibility ? r.visibility.visibility : 'unknown',
        lastRun: new Date().toISOString(),
        lastReport: shouldReport && !opts.noMark ? new Date().toISOString() : prev && prev.lastReport,
        changed: shouldReport,
        error: r.error || null,
      };
      r.reported = shouldReport;
    }

    const scan = {
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - started,
      repos: results,
      totalHard: results.reduce((n, r) => n + hardCount(r), 0),
      totalSoft: results.reduce((n, r) => n + softCount(r), 0),
    };

    saveState(state);

    const anyReport = results.some((r) => r.reported);
    if (anyReport && opts.notify !== false) notify(buildReport(scan), scan);

    return scan;
  } finally {
    _running = false;
  }
}

function startGitExposureWatcher(notifCb) {
  _notifCallback = notifCb;
  if (_timer) clearInterval(_timer);
  // Don't compete with boot: first pass after 90s, then on the interval.
  setTimeout(() => {
    runExposureScan().catch((e) => console.error('[git-exposure] first pass failed:', e.message));
  }, 90 * 1000).unref?.();
  _timer = setInterval(() => {
    runExposureScan().catch((e) => console.error('[git-exposure] pass failed:', e.message));
  }, INTERVAL_MS);
  _timer.unref?.();
  console.log(
    `[git-exposure] watcher started — ${DEFAULT_REPOS.length} repos, interval ${Math.round(INTERVAL_MS / 60000)}min, scanner ${SCANNER}`
  );
}

function getExposureState() {
  return loadState();
}

module.exports = {
  runExposureScan,
  startGitExposureWatcher,
  getExposureState,
  buildReport,
  parseScannerOutput,
  waitForPendingReport,
  DEFAULT_REPOS,
  SEVERITY,
};

// ── standalone CLI: node src/gitExposure.js [--once] [--no-notify] [--json] ──
if (require.main === module) {
  const argv = process.argv.slice(2);
  const noNotify = argv.includes('--no-notify');
  const asJson = argv.includes('--json');
  const repoArg = argv.indexOf('--repo');
  if (argv.includes('--debug')) process.env.EXPOSURE_DEBUG = '1';
  const opts = { notify: !noNotify, forceReport: argv.includes('--report') };
  if (repoArg !== -1 && argv[repoArg + 1]) {
    const wanted = argv[repoArg + 1];
    const match = DEFAULT_REPOS.find((r) => r.label === wanted || r.path === wanted);
    if (match) opts.repos = [match];
  }
  runExposureScan(opts)
    .then(async (scan) => {
      if (!scan) {
        console.error('[git-exposure] another pass is already running');
        process.exit(2);
      }
      if (asJson) console.log(JSON.stringify(scan, null, 2));
      else console.log(buildReport(scan));
      // Let an in-flight Telegram report finish before the process exits.
      await waitForPendingReport(30000);
      process.exit(scan.totalHard > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error('[git-exposure] failed:', e.message);
      process.exit(2);
    });
}
