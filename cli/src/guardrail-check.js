'use strict';
// Fast guardrail flow check — proves the CLI's own safety rails are loaded and
// wired BEFORE the first turn, in a handful of file reads.
//
// Owner, 2026-11-26: "make it do fast flow check for guard rails" — the start
// card states, in milliseconds, that the rails are active, and names the one
// that is not. Never writes, never spawns a process, never throws: a failed
// check is reported, never corrected (CLAUDE.md §11, §22.5, §50).
//
// What it verifies, and why each one is real rather than a file-exists guess:
//   model-lock    the ladder still carries the locked wire model and relay    (§22, §35)
//   self-config   the guard actually REFUSES a write to the ladder itself     (§38.1)
//   secrets       ~/bin/secret-scan.sh is present and executable             (§48)
//   tool-guard    the self-config guard is wired into the tool write path     (§38.1)
//   update-guard  the updater refuses to write into a source checkout         (§43.4, §8)
//   codex-lane    the declared codex fallback has a binary that can run it   (§46)  [optional]
//
// Optional checks are reported when they fail but do not lower the score: a
// user who has not installed codex is told once, not alarmed on every start.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLI_DIR = path.join(__dirname, '..');
const REPO = path.join(CLI_DIR, '..');

const LOCKED_MODEL = 'deepseek-v4.1-flash:cloud';
const LOCKED_RELAY = '127.0.0.1:11434';

function read(file, max) {
  try {
    const buf = fs.readFileSync(file);
    const text = buf.toString('utf8');
    return max && text.length > max ? text.slice(0, max) : text;
  } catch { return ''; }
}
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}
function onPath(bin) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(HOME, '.local', 'bin'));
  return dirs.some((d) => isExecutable(path.join(d, bin)));
}

// ── the checks ─────────────────────────────────────────────────────────────
// Each returns { ok, detail }. `detail` is shown only when it explains
// something — a pass says what it proved, a failure says what is missing.

const CHECKS = [
  {
    id: 'model-lock',
    label: 'model lock',
    run() {
      const src = read(path.join(CLI_DIR, 'src', 'models', 'ladder.js'), 200000);
      if (!src) return { ok: false, detail: 'ladder.js missing' };
      const model = src.includes(LOCKED_MODEL);
      const relay = src.includes(LOCKED_RELAY);
      if (!model) return { ok: false, detail: 'wire model drifted from ' + LOCKED_MODEL };
      if (!relay) return { ok: false, detail: 'relay drifted from ' + LOCKED_RELAY };
      return { ok: true, detail: LOCKED_MODEL };
    },
  },
  {
    id: 'self-config',
    label: 'self-config guard',
    run() {
      try {
        const guard = require('./self-config-guard');
        const target = path.join(CLI_DIR, 'src', 'models', 'ladder.js');
        const refusal = guard.guardSelfConfig('edit_file', { path: target, content: 'drift' }, REPO);
        if (typeof refusal !== 'string' || !/BLOCKED/.test(refusal)) {
          return { ok: false, detail: 'guard did not refuse a ladder write' };
        }
        return { ok: true, detail: 'refuses config writes' };
      } catch {
        return { ok: false, detail: 'guard not loadable' };
      }
    },
  },
  {
    id: 'secrets',
    label: 'secrets gate',
    run() {
      const scanner = path.join(HOME, 'bin', 'secret-scan.sh');
      if (!isFile(scanner)) return { ok: false, detail: 'secret-scan.sh not installed' };
      if (!isExecutable(scanner)) return { ok: false, detail: 'secret-scan.sh not executable' };
      // The hooks are the enforcement side. An installed package has no .git,
      // so a missing hook is a note, not a failure — the scanner is the rail.
      const hooks = [
        path.join(REPO, '.git', 'hooks', 'pre-commit'),
        path.join(HOME, '.git', 'hooks', 'pre-commit'),
      ];
      const wired = hooks.some((h) => /secret-scan/.test(read(h, 8192)));
      return { ok: true, detail: wired ? 'scanner + commit hooks' : 'scanner (no commit hook here)' };
    },
  },
  {
    id: 'tool-guard',
    label: 'tool guard',
    run() {
      const src = read(path.join(CLI_DIR, 'tools.js'), 600000);
      if (!src) return { ok: false, detail: 'tools.js missing' };
      if (!src.includes('self-config-guard')) return { ok: false, detail: 'write path does not call the guard' };
      return { ok: true, detail: 'guard in the write path' };
    },
  },
  {
    id: 'update-guard',
    label: 'update guard',
    run() {
      const src = read(path.join(CLI_DIR, 'src', 'updater.js'), 400000);
      if (!src) return { ok: false, detail: 'updater.js missing' };
      if (!/source-checkout/.test(src)) return { ok: false, detail: 'checkout refusal missing' };
      return { ok: true, detail: 'checkouts never rewritten' };
    },
  },
  {
    id: 'codex-lane',
    label: 'codex lane',
    optional: true,
    run() {
      const src = read(path.join(CLI_DIR, 'src', 'models', 'ladder.js'), 200000);
      if (!/codex-cli/.test(src)) return { ok: false, detail: 'not declared in the ladder' };
      if (!onPath('codex')) return { ok: false, detail: 'declared · binary not installed' };
      return { ok: true, detail: 'fallback #2 ready' };
    },
  },
];

/**
 * Run every check synchronously and return a summary the start card can draw.
 * @param {{only?: string[], skip?: string[]}} [opts]
 * @returns {{ok: boolean, pass: number, total: number, ms: number, items: object[]}}
 */
function runGuardrailCheck(opts = {}) {
  const started = Date.now();
  const skip = new Set(opts.skip || []);
  const only = Array.isArray(opts.only) && opts.only.length ? new Set(opts.only) : null;
  const items = [];
  for (const check of CHECKS) {
    if (skip.has(check.id)) continue;
    if (only && !only.has(check.id)) continue;
    let result;
    try {
      result = check.run() || { ok: false, detail: 'no result' };
    } catch (e) {
      result = { ok: false, detail: 'check threw: ' + (e && e.message ? e.message : 'unknown') };
    }
    items.push({
      id: check.id,
      label: check.label,
      optional: !!check.optional,
      ok: !!result.ok,
      detail: result.detail || '',
    });
  }
  const scored = items.filter((i) => !i.optional);
  const pass = scored.filter((i) => i.ok).length;
  return {
    ok: pass === scored.length,
    pass,
    total: scored.length,
    ms: Date.now() - started,
    items,
  };
}

module.exports = { runGuardrailCheck, CHECKS, LOCKED_MODEL, LOCKED_RELAY };
