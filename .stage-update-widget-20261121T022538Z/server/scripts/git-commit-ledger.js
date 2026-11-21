#!/usr/bin/env node
'use strict';

// Git commit ledger — every commit in the tracked repos, recorded once, with
// who made it and when, reported through the coder bot, and readable back
// later. Append-only: nothing here ever rewrites or drops a ledger line.
//
//   node server/scripts/git-commit-ledger.js --sync            # record new commits
//   node server/scripts/git-commit-ledger.js --report          # send un-reported ones
//   node server/scripts/git-commit-ledger.js --sync --report   # both
//   node server/scripts/git-commit-ledger.js --list --limit 20 # what happened
//   node server/scripts/git-commit-ledger.js --list --repo /home/ghost --since 2026-11-16
//   node server/scripts/git-commit-ledger.js --install-hooks   # record every future commit
//
// No daemon, by design. The post-commit hook is a one-shot process that appends
// a single line and exits (~60 ms); there is no polling loop, no long-lived
// process and nothing to restart. Reporting is manual (`--report`) so a
// periodic job can never pile up on the box.
//
// The post-commit hook installed by --install-hooks calls
//   --hook-commit <sha> --repo <toplevel>
// which appends exactly one line and exits 0 no matter what, so it can never
// block a commit. A pre-existing hook that this script did not write is left
// untouched and reported instead of being replaced.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
try {
  require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env'), quiet: true });
} catch { /* dotenv optional */ }

const DATA_DIR = path.join(ROOT, 'data');
const LEDGER = path.join(DATA_DIR, 'git-commit-ledger.jsonl');
const STATE = path.join(DATA_DIR, 'git-commit-ledger-state.json');
const REPORTER = path.join(__dirname, 'telegram-report.js');
const HOOK_MARK = '# managed by git-commit-ledger.js';

const DEFAULT_REPOS = ['/home/ghost', '/home/ghost/haksterAi', '/home/ghost/cine-vault-live'];
const SEP = '\x1f';
const FMT = ['%H', '%h', '%an', '%ae', '%aI', '%cI', '%s', '%D'].join(SEP);

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function toplevel(p) {
  try {
    return git(path.resolve(p), ['rev-parse', '--show-toplevel']).trim() || null;
  } catch {
    return null;
  }
}

function repoList(raw) {
  const wanted = raw && raw.length ? raw : DEFAULT_REPOS;
  const out = [];
  for (const p of wanted) {
    const top = toplevel(p);
    if (top && !out.includes(top)) out.push(top);
  }
  return out;
}

function shortstat(repo, sha) {
  let s = '';
  try { s = git(repo, ['show', '--shortstat', '--format=', sha]); } catch { return { files: null, insertions: null, deletions: null }; }
  const files = /(\d+) files? changed/.exec(s);
  const ins = /(\d+) insertions?\(\+\)/.exec(s);
  const del = /(\d+) deletions?\(-\)/.exec(s);
  return {
    files: files ? Number(files[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

function readCommit(repo, sha) {
  let line;
  try { line = git(repo, ['show', '-s', `--format=${FMT}`, sha]).trim(); } catch { return null; }
  if (!line) return null;
  const [full, short, an, ae, ad, cd, subject, refs] = line.split(SEP);
  const st = shortstat(repo, full);
  return {
    repo,
    sha: full,
    short,
    author: an || '(unknown)',
    author_email: ae || '',
    author_date: ad || '',
    commit_date: cd || '',
    subject: subject || '',
    refs: refs || '',
    files: st.files,
    insertions: st.insertions,
    deletions: st.deletions,
    recorded_at: new Date().toISOString(),
  };
}

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function saveState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, STATE);
}

function readLedger() {
  try {
    return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function appendLedger(records) {
  if (!records.length) return 0;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const body = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(LEDGER, body);
  return records.length;
}

function knownKeys() {
  const set = new Set();
  for (const r of readLedger()) set.add(`${r.repo}\u0000${r.sha}`);
  return set;
}

// ── modes ────────────────────────────────────────────────────────────────

function sync(repos, opts) {
  const known = knownKeys();
  const added = [];
  const limit = Math.max(1, opts.backfill || 50);
  for (const repo of repos) {
    let shas = [];
    try {
      shas = git(repo, ['log', `-${limit}`, '--format=%H']).trim().split('\n').filter(Boolean);
    } catch { continue; }
    // git log is newest-first; record oldest-first so the ledger reads forward.
    for (const sha of shas.reverse()) {
      const key = `${repo}\u0000${sha}`;
      if (known.has(key)) continue;
      const rec = readCommit(repo, sha);
      if (!rec) continue;
      known.add(key);
      added.push(rec);
    }
  }
  if (!opts.dryRun) appendLedger(added);
  return added;
}

function fmtWhen(iso) {
  if (!iso) return 'unknown time';
  // 2026-11-15T20:36:46-05:00 -> 2026-11-15 20:36 -0500
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}([+-]\d{2}:\d{2}|Z)$/.exec(iso);
  if (!m) return iso;
  return `${m[1]} ${m[2]} ${m[3] === 'Z' ? '+0000' : m[3].replace(':', '')}`;
}

function reportText(records, cap) {
  const shown = records.slice(-cap);
  const lines = [];
  if (records.length > shown.length) lines.push(`(${records.length - shown.length} older commit(s) already in the ledger)`);
  for (const r of shown) {
    const stat = r.files === null ? '' : ` · ${r.files}f +${r.insertions}/-${r.deletions}`;
    lines.push(`${path.basename(r.repo)} · ${r.short} · ${r.author} · ${fmtWhen(r.author_date)}${stat}`);
    lines.push(`   ${r.subject}`);
  }
  return lines.join('\n');
}

function report(repos, opts) {
  const ledger = readLedger();
  const state = loadState();
  const through = Number(state.reported_through || 0);
  const fresh = ledger.slice(through).sort((a, b) => Date.parse(a.author_date) - Date.parse(b.author_date));
  if (!fresh.length) return { sent: false, reason: 'no new commits since last report', fresh: 0 };

  const cap = Math.max(1, opts.max || 25);
  const body = reportText(fresh, cap);
  if (opts.dryRun) return { sent: false, reason: 'dry-run', body, fresh: fresh.length };

  const args = [REPORTER, '--role', 'coder', '--stdin'];
  for (const r of repos) args.push('--git', r);
  try {
    execFileSync(process.execPath, args, { input: body, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return { sent: false, reason: `report failed: ${e.message.split('\n')[0]}`, fresh: fresh.length };
  }
  state.reported_through = ledger.length;
  state.last_report_at = new Date().toISOString();
  saveState(state);
  return { sent: true, fresh: fresh.length };
}

function list(opts) {
  let rows = readLedger();
  if (opts.repo) {
    const top = toplevel(opts.repo) || path.resolve(opts.repo);
    rows = rows.filter(r => path.resolve(r.repo) === path.resolve(top));
  }
  if (opts.since) {
    const t = Date.parse(opts.since);
    if (!Number.isNaN(t)) rows = rows.filter(r => Date.parse(r.commit_date || r.author_date) >= t);
  }
  const shown = rows.slice(-Math.max(1, opts.limit || 25));
  if (opts.json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }
  if (!shown.length) { console.log('ledger is empty for that filter'); return; }
  for (const r of shown) {
    const stat = r.files === null ? '' : ` · ${r.files}f +${r.insertions}/-${r.deletions}`;
    console.log(`${fmtWhen(r.author_date)} · ${path.basename(r.repo)} · ${r.short} · ${r.author}${stat}`);
    console.log(`  ${r.subject}`);
  }
  console.log(`\n${shown.length} of ${rows.length} recorded commit(s) · ledger: ${LEDGER}`);
}

function hookCommit(repoArg, sha) {
  const repo = toplevel(repoArg || '.');
  if (!repo) return 0;
  const known = knownKeys();
  if (known.has(`${repo}\u0000${sha}`)) return 0;
  const rec = readCommit(repo, sha);
  if (rec) appendLedger([rec]);
  return 0;
}

function hookBody() {
  return [
    '#!/bin/sh',
    HOOK_MARK,
    '# records the commit in the ledger; never blocks or slows the commit',
    `"${process.execPath}" "${path.resolve(__filename)}" --hook-commit "$(git rev-parse HEAD)" --repo "$(git rev-parse --show-toplevel)" >/dev/null 2>&1 || true`,
    '',
  ].join('\n');
}

function installHooks(repos, opts) {
  const results = [];
  for (const repo of repos) {
    const hooksDir = path.join(repo, '.git', 'hooks');
    const file = path.join(hooksDir, 'post-commit');
    if (fs.existsSync(file)) {
      const cur = fs.readFileSync(file, 'utf8');
      results.push({ repo, action: cur.includes(HOOK_MARK) ? 'already installed' : 'SKIPPED — a different post-commit hook exists (left untouched)' });
      continue;
    }
    if (opts.dryRun) { results.push({ repo, action: 'would install' }); continue; }
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(file, hookBody(), { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    results.push({ repo, action: 'installed' });
  }
  return results;
}

// ── cli ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    sync: false, report: false, list: false, installHooks: false,
    hookSha: null, repo: null, repos: [], since: null, limit: 25, max: 25,
    backfill: 50, json: false, dryRun: false, quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sync') o.sync = true;
    else if (a === '--report') o.report = true;
    else if (a === '--list') o.list = true;
    else if (a === '--install-hooks') o.installHooks = true;
    else if (a === '--hook-commit') o.hookSha = argv[++i] || null;
    else if (a === '--repo') o.repo = argv[++i] || null;
    else if (a === '--repos') o.repos.push(...String(argv[++i] || '').split(',').filter(Boolean));
    else if (a === '--since') o.since = argv[++i] || null;
    else if (a === '--limit') o.limit = Math.max(1, parseInt(argv[++i], 10) || 25);
    else if (a === '--max') o.max = Math.max(1, parseInt(argv[++i], 10) || 25);
    else if (a === '--backfill') o.backfill = Math.max(1, parseInt(argv[++i], 10) || 50);
    else if (a === '--json') o.json = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function cycle(repos, o) {
  const added = sync(repos, o);
  if (!o.quiet) console.log(`sync: ${added.length} new commit(s) recorded (ledger ${readLedger().length} total)`);
  const r = report(repos, o);
  if (!o.quiet) {
    if (r.sent) console.log(`report: sent ${r.fresh} commit(s) to the coder bot`);
    else console.log(`report: ${r.reason}`);
    if (r.body) console.log(r.body);
  }
  return added.length;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));

  if (o.help) {
    console.log('usage: git-commit-ledger.js [--sync] [--report] [--list] [--install-hooks]');
    console.log('       [--repo <path>] [--repos a,b] [--since <date>] [--limit N] [--max N]');
    console.log('       [--backfill N] [--json] [--dry-run] [--quiet]');
    console.log('       no --watch/daemon mode: commits are recorded by the git hook, reports are on demand');
    console.log('       --hook-commit <sha> --repo <toplevel>   (used by the post-commit hook)');
    return 0;
  }

  if (process.argv.includes('--watch') || process.argv.includes('--interval')) {
    console.error('--watch is deliberately not supported: a polling daemon is not allowed on this box.');
    console.error('commits are recorded by the post-commit hook; run --report when you want them sent.');
    return 2;
  }

  // Hook mode: append one commit and always succeed.
  if (o.hookSha) return hookCommit(o.repo || '.', o.hookSha);

  const repos = repoList(o.repos);
  if (!repos.length) {
    console.error('no git repos found in: ' + (o.repos.length ? o.repos.join(', ') : DEFAULT_REPOS.join(', ')));
    return 1;
  }

  if (o.installHooks) {
    for (const r of installHooks(repos, o)) console.log(`${r.repo}: ${r.action}`);
    if (repos.length && !o.dryRun) {
      // Prove the hook path works on this machine before relying on it.
      const head = git(repos[0], ['rev-parse', 'HEAD']).trim();
      hookCommit(repos[0], head);
      console.log(`self-test: ${path.basename(repos[0])} ${head.slice(0, 7)} is ${knownKeys().has(`${repos[0]}\u0000${head}`) ? 'in the ledger' : 'MISSING from the ledger'}`);
    }
    return 0;
  }

  if (o.list) { list(o); return 0; }

  if (!o.sync && !o.report) o.sync = true;
  if (o.sync && o.report) { cycle(repos, o); return 0; }
  if (o.sync) {
    const added = sync(repos, o);
    if (!o.quiet) console.log(`sync: ${added.length} new commit(s) recorded (ledger ${readLedger().length} total)`);
    return 0;
  }
  const r = report(repos, o);
  if (r.sent) console.log(`report: sent ${r.fresh} commit(s) to the coder bot`);
  else { console.log(`report: ${r.reason}`); if (r.body) console.log(r.body); }
  return 0;
}

main().then(code => process.exit(code)).catch(e => {
  console.error('git-commit-ledger failed:', e && e.message ? e.message : e);
  process.exit(1);
});
