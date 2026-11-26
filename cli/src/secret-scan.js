'use strict';
// secret-scan — one scanner behind every layer that can leak a credential,
// written in Node so it exists on every platform we ship to.
//
// Owner, 2026-11-26: "windows flow is only thing left … we need to ace this".
// `~/bin/secret-scan.sh` is a POSIX shell gate: a Windows install carries no
// shell scanner, so the start card's `secrets gate` rail could never be proven
// there. This module is the same rules, the same tiers, the same exit codes and
// the same `file:line`-only reporting, with no bash and no awk — so the rail is
// real on Windows, macOS and Linux alike (CLAUDE.md §48).
//
//   hakster secret-scan --staged          added lines in the index
//   hakster secret-scan --tree            every tracked file at HEAD
//   hakster secret-scan --at REV          every tracked file at REV
//   hakster secret-scan --commits RANGE   files changed in RANGE
//   hakster secret-scan --deep            --tree plus exact match of live values
//                                         in ~/.secrets.env
//
//   --strict   treat SOFT findings as failures too
//   --quiet    only set the exit code
//
// Exit: 0 clean, 1 findings, 2 usage error.
//
// It prints the file, the line number and the rule name. It never prints the
// matched value, never writes a value to disk, and never sends one anywhere.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ── rules ──────────────────────────────────────────────────────────────────
// name, tier ("hard" fails, "soft" only warns), JS regex source.
// The source is written so the same string can be handed to `git grep -E`
// with `\s` translated to the POSIX class — one source, two engines, no drift.
const RULE_DEFS = [
  ['private-key', 'hard', '-----BEGIN [A-Z ]*PRIVATE KEY-----'],
  ['anthropic', 'hard', 'sk-ant-[A-Za-z0-9_-]{20,}'],
  ['openrouter', 'hard', 'sk-or-v1-[A-Za-z0-9]{20,}'],
  ['openai', 'hard', 'sk-(proj-)?[A-Za-z0-9_-]{32,}'],
  ['groq', 'hard', 'gsk_[A-Za-z0-9]{20,}'],
  ['nvidia', 'hard', 'nvapi-[A-Za-z0-9_-]{20,}'],
  ['google', 'hard', 'AIzaSy[A-Za-z0-9_-]{30,}'],
  ['aws', 'hard', '(AKIA|ASIA)[0-9A-Z]{16}'],
  ['github', 'hard', '(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})'],
  ['slack', 'hard', 'xox[baprs]-[A-Za-z0-9-]{10,}'],
  ['stripe', 'hard', '(sk|rk)_live_[A-Za-z0-9]{20,}'],
  ['telegram', 'hard', '[0-9]{8,10}:[A-Za-z0-9_-]{35}'],
  ['cftunnel', 'hard', '"TunnelSecret"\\s*:'],
  ['dburl', 'hard', '(postgres|postgresql|mysql|mongodb|mongodb\\+srv|redis)://[A-Za-z0-9_.-]+:[^@/\\s]{6,}@'],
  ['jwt', 'hard', 'eyJ[A-Za-z0-9_-]{15,}\\.[A-Za-z0-9_-]{15,}\\.[A-Za-z0-9_-]{10,}'],
  ['bearer', 'soft', '[Bb]earer\\s+[A-Za-z0-9._-]{25,}'],
  ['assignment', 'soft', '(api[_-]?key|secret|token|password|passwd|client[_-]?secret)\\s*[:=]\\s*["\'][A-Za-z0-9_./+=-]{16,}["\']'],
];

const RULES = RULE_DEFS.map(([name, tier, src]) => ({
  name,
  tier,
  re: new RegExp(src, tier === 'soft' ? 'i' : ''),
  ere: src.replace(/\\s/g, '[[:space:]]'),
}));

// Placeholder-looking lines are not credentials. A file that passes may only
// have been filtered, so this list is never widened to silence a finding
// (CLAUDE.md §48.4).
const NOISE = /your[_-]?|example|placeholder|xxxx|changeme|replace[_-]?me|process\.env|dummy|sample|\.\.\.|\$\{[a-z_]+\}|<[a-z_-]+>|redacted/i;

// ── helpers ────────────────────────────────────────────────────────────────

function git(args, opts = {}) {
  return spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
    ...opts,
  });
}

function repoRoot(cwd) {
  const r = git(['rev-parse', '--show-toplevel'], { cwd });
  if (r.status !== 0) return '';
  return String(r.stdout || '').trim();
}

/** Scan one text blob. Returns [{rule, tier, line}] — line is 1-based.
 *  Exported so the start card can PROVE the rules work in-process, without
 *  spawning anything (guardrail-check.js never spawns). */
function scanText(text, opts = {}) {
  const out = [];
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || NOISE.test(line)) continue;
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      out.push({ rule: rule.name, tier: rule.tier, line: i + 1 });
      break;
    }
  }
  return out;
}

/** Read the live secret values that may be matched by value in --deep mode. */
function liveValues(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (let line of raw.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    line = line.replace(/^\s*export\s+/, '');
    const k = line.indexOf('=');
    if (k === 0) continue;
    if (k < 0) continue;
    const name = line.slice(0, k).trim();
    let value = line.slice(k + 1).trim().replace(/^["']|["']$/g, '');
    if (value.length >= 12) out.push({ name, value });
  }
  return out;
}

// Files git should never be asked to scan for credentials.
const EXCLUDES = [
  ':(exclude)*.lock', ':(exclude)package-lock.json', ':(exclude)*.min.js',
  ':(exclude)*.map', ':(exclude)snapshots/**', ':(exclude)snapshots-rsync/**',
  ':(exclude)backups/**',
];

/** Parse a unified diff and scan only added lines. */
function scanDiff(diffText) {
  const findings = [];
  let file = '';
  let ln = 0;
  for (const raw of String(diffText).split(/\r?\n/)) {
    if (raw.startsWith('+++ b/')) { file = raw.slice(6); ln = 0; continue; }
    if (raw.startsWith('+++ ')) { file = ''; continue; }
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      ln = m ? Number(m[1]) - 1 : 0;
      continue;
    }
    if (!raw.startsWith('+')) continue;
    if (!file) continue;
    ln++;
    const line = raw.slice(1);
    if (NOISE.test(line)) continue;
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      findings.push({ tier: rule.tier, rule: rule.name, file, line: ln });
      break;
    }
  }
  return findings;
}

/** Scan a revision with git grep — fast, tracked-only, real line numbers.
 *  git grep narrows candidates by the union of the tier's patterns; the JS
 *  regexes then own the decision, so both engines cannot disagree. */
function scanRev(root, rev, paths, cwd) {
  const findings = [];
  const targets = Array.isArray(paths) ? paths.filter(Boolean) : [];
  for (const tier of ['hard', 'soft']) {
    const rules = RULES.filter((r) => r.tier === tier);
    if (!rules.length) continue;
    const args = ['grep', '-n', '-I', '-E'];
    if (tier === 'soft') args.push('-i');
    for (const r of rules) args.push('-e', r.ere);
    args.push(rev, '--');
    args.push(...(targets.length ? targets : ['.']));
    const r = git(args, { cwd: root });
    // git grep exits 1 when nothing matched — that is clean, not an error.
    if (r.status !== 0 && r.status !== 1) continue;
    const text = String(r.stdout || '');
    for (const raw of text.split(/\r?\n/)) {
      if (!raw) continue;
      if (NOISE.test(raw)) continue;
      // rev:path:line:content — path and content may both contain ':'
      const parts = raw.split(':');
      if (parts.length < 3) continue;
      const file = parts.slice(1, parts.length - 2).join(':');
      const lineNo = Number(parts[parts.length - 2]);
      const content = parts[parts.length - 1];
      if (!file || !Number.isFinite(lineNo)) continue;
      for (const rule of rules) {
        if (!rule.re.test(content)) continue;
        findings.push({ tier, rule: rule.name, file, line: lineNo });
        break;
      }
    }
  }
  return findings;
}

/** --deep: exact match of the live values in ~/.secrets.env. An unknown key
 *  format is still caught by value rather than by shape (§48.1). */
function scanValues(root, rev, paths, valuesFile) {
  const values = liveValues(valuesFile);
  if (!values.length) return [];
  const findings = [];
  const targets = Array.isArray(paths) ? paths.filter(Boolean) : [];
  const list = git(['ls-tree', '-r', '--name-only', rev, '--', ...(targets.length ? targets : ['.'])], { cwd: root });
  if (list.status !== 0) return [];
  const files = String(list.stdout || '').split(/\r?\n/).filter((f) => /\.(js|mjs|cjs|ts|jsx|tsx|json|env|md|txt|sh|bash|ps1|py|yml|yaml|conf|ini|cfg|toml|html|css|php|rb|go|java|xml|log|pem|key|bak)$/i.test(f));
  for (const file of files) {
    let text = '';
    try {
      const abs = path.join(root, file);
      if (fs.existsSync(abs)) text = fs.readFileSync(abs, 'utf8');
      else {
        const show = git(['show', rev + ':' + file], { cwd: root });
        if (show.status === 0) text = String(show.stdout || '');
      }
    } catch { continue; }
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length < 12) continue;
      for (const v of values) {
        if (line.includes(v.value)) {
          findings.push({ tier: 'hard', rule: 'LIVE:' + v.name, file, line: i + 1 });
          break;
        }
      }
    }
  }
  return findings;
}

function readAllow(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => { try { return new RegExp(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

const USAGE = [
  'secret-scan — one scanner behind every layer that can leak a credential.',
  '',
  '  hakster secret-scan --staged          added lines in the index',
  '  hakster secret-scan --tree            every tracked file at HEAD',
  '  hakster secret-scan --at REV          every tracked file at REV',
  '  hakster secret-scan --commits RANGE   files changed in RANGE',
  '  hakster secret-scan --deep            --tree plus a match of live values',
  '',
  '  --strict   treat SOFT findings as failures too',
  '  --quiet    only set the exit code',
  '',
  'Exit: 0 clean, 1 findings, 2 usage error. Values are never printed.',
].join('\n');

/**
 * Run the scanner. Returns an exit code (0 clean, 1 findings, 2 usage) instead
 * of calling process.exit, so the command wrapper and the rail share one path.
 * @param {string[]} argv
 * @param {{cwd?: string, out?: (s: string) => void, err?: (s: string) => void}} [io]
 */
function run(argv = [], io = {}) {
  const out = io.out || ((s) => process.stdout.write(s + '\n'));
  const err = io.err || ((s) => process.stderr.write(s + '\n'));
  const env = process.env;

  let mode = '';
  let deep = false;
  let strict = false;
  let quiet = false;
  let range = '';
  let at = '';
  const paths = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged') mode = 'staged';
    else if (a === '--tree') mode = 'tree';
    else if (a === '--at') { mode = 'tree'; at = argv[++i] || 'HEAD'; }
    else if (a === '--commits') { mode = 'commits'; range = argv[++i] || ''; }
    else if (a === '--deep') deep = true;
    else if (a === '--strict') strict = true;
    else if (a === '--quiet') quiet = true;
    else if (a === '-h' || a === '--help') { out(USAGE); return 0; }
    else if (a === '--') { paths.push(...argv.slice(i + 1)); break; }
    else if (a.startsWith('-')) { err('secret-scan: unknown option ' + a); return 2; }
    else paths.push(a);
  }
  if (!mode) mode = 'staged';
  if (env.SECRET_SCAN_SKIP === '1') return 0;

  const root = repoRoot(io.cwd || process.cwd());
  if (!root) { err('secret-scan: not a git repo'); return 2; }
  const values = env.SECRET_VALUES_FILE || path.join(os.homedir(), '.secrets.env');
  const allowFile = env.SECRET_SCAN_ALLOW || path.join(os.homedir(), 'bin', 'secret-scan.allow');

  let findings = [];
  if (mode === 'staged') {
    const d = git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACM', '--', '.', ...EXCLUDES], { cwd: root });
    if (d.status !== 0 && d.status !== 1) { err('secret-scan: git diff failed'); return 2; }
    findings = scanDiff(String(d.stdout || ''));
  } else if (mode === 'tree') {
    const rev = at || 'HEAD';
    findings = scanRev(root, rev, paths, io.cwd);
    if (deep) findings.push(...scanValues(root, rev, paths, values));
  } else if (mode === 'commits') {
    if (!range) { err('secret-scan: --commits needs a range'); return 2; }
    const tip = range.includes('..') ? range.split('..').pop() || 'HEAD' : 'HEAD';
    const changed = git(['diff', '--name-only', '--diff-filter=ACM', range], { cwd: root });
    const files = String(changed.stdout || '').split(/\r?\n/).filter(Boolean);
    if (files.length) {
      findings = scanRev(root, tip, files, io.cwd);
      findings.push(...scanValues(root, tip, files, values));
    }
  } else {
    err('secret-scan: bad mode ' + mode);
    return 2;
  }

  // Dedupe on location + rule, then apply the allow list by path.
  const seen = new Set();
  let uniq = findings.filter((f) => {
    const k = f.tier + '\t' + f.rule + '\t' + f.file + ':' + f.line;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const allow = readAllow(allowFile);
  if (allow.length) {
    uniq = uniq.filter((f) => !allow.some((re) => re.test(f.file)));
  }

  if (!uniq.length) {
    if (!quiet) out('secret-scan (' + mode + '): clean');
    return 0;
  }

  const hard = uniq.filter((f) => f.tier === 'hard').length;
  const soft = uniq.filter((f) => f.tier === 'soft').length;
  if (!quiet) {
    out('\u{1F6AB} secret-scan (' + mode + '): ' + hard + ' hard, ' + soft + ' soft');
    for (const f of uniq) {
      const mark = f.tier === 'soft' ? '·' : '✗';
      out('   ' + mark + ' ' + f.rule.padEnd(16) + ' ' + f.file + ':' + f.line);
    }
    out('');
    out('   Values are deliberately not shown. Open the line and move the value');
    out('   to ~/.secrets.env (mode 600, gitignored) or an untracked .env.');
    out('   False positive: add its path regex to ' + allowFile);
  }
  if (hard > 0) return 1;
  if (strict && soft > 0) return 1;
  return 0;
}

module.exports = { RULES, NOISE, scanText, run, liveValues, USAGE };

// Running as a script: `node src/secret-scan.js --staged`
if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}
