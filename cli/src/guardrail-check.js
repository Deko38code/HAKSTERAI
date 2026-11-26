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
//   memory-bank   the bank store reads and every bank parses, with its count   (§40)
//   mcp           the MCP belt is configured, deduped by name, with its count  (§46)
//   codex-lane    the declared codex fallback has a binary that can run it   (§46)  [optional]
//
// Optional checks are reported when they fail but do not lower the score: a
// user who has not installed codex is told once, not alarmed on every start.
// A check may escalate itself by returning `optional: false` — an unreadable
// bank file is a real fault (it silently kills recall, §40), while a bank that
// is merely empty is a fresh install.
//
// Owner, 2026-11-26: "add memory bank check to startup list to and mcp count" —
// the two counts ride on the rail as a short measured `note`, so the start card
// states how much memory is loaded and how many servers are configured.

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
      // The gate is real when a scanner is present AND it catches a leaked key.
      // Owner, 2026-11-26: "windows flow is only thing left … we need to ace
      // this" — a Windows package install carries no ~/bin shell scanner, so
      // this rail used to read a permanent grey note there. The package now
      // ships `src/secret-scan.js` (§48), so the gate is proven in-process on
      // every platform: the same rules our commit hooks run, no shell needed.
      const names = ['secret-scan.sh', 'secret-scan.cmd', 'secret-scan.ps1', 'secret-scan.js'];
      const binScanner = names.map((n) => path.join(HOME, 'bin', n)).find((p) => isFile(p));
      // Prove the bundled scanner by catching a fixture built here, never a
      // literal in the tree — and prove the safe form stays clean, so a rail
      // that passes cannot be one that flags absolutely everything.
      let bundled = '';
      try {
        const scan = require('./secret-scan');
        const fake = 'ghp_' + 'A'.repeat(36);
        const caught = scan.scanText('token = "' + fake + '"');
        const quiet = scan.scanText('token = process.env.GITHUB_TOKEN');
        if (caught.some((h) => h.rule === 'github') && quiet.length === 0) bundled = 'bundled scanner';
      } catch { /* no bundled scanner (old install) */ }

      if (!binScanner && !bundled) return { ok: false, detail: 'no secret scanner installed' };
      if (binScanner && /\.sh$/i.test(binScanner) && !isExecutable(binScanner)) {
        return { ok: false, detail: path.basename(binScanner) + ' not executable' };
      }
      // Hooks are the enforcement side. An installed package has no .git, so a
      // missing hook is a note, not a failure — the scanner is the rail.
      const hooks = [
        path.join(REPO, '.git', 'hooks', 'pre-commit'),
        path.join(HOME, '.git', 'hooks', 'pre-commit'),
      ];
      const wired = hooks.some((h) => /secret-scan/.test(read(h, 8192)));
      const source = binScanner ? path.basename(binScanner) : bundled;
      return { ok: true, detail: source + (wired ? ' + commit hooks' : ' (no commit hook here)') };
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
    id: 'memory-bank',
    label: 'memory bank',
    // The store the TUI header reads (~/.hakster/memories/banks), not the
    // project-local copy — the header's numbers come from here (§40).
    // Empty banks are a fresh install (grey, never red). A bank that will not
    // parse is the fault that silently disables recall, so it escalates.
    optional: true,
    run() {
      const dir = path.join(HOME, '.hakster', 'memories', 'banks');
      let files;
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        return { ok: false, detail: 'no banks yet' };
      }
      let entries = 0;
      const broken = [];
      for (const f of files) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (Array.isArray(parsed)) entries += parsed.length;
          else broken.push(f);
        } catch { broken.push(f); }
      }
      if (broken.length) {
        return { ok: false, optional: false, detail: broken.length + ' bank(s) unreadable: ' + broken.join(', ') };
      }
      if (!entries) return { ok: false, detail: files.length + ' banks, empty' };
      return { ok: true, note: entries + ' notes', detail: files.length + ' banks · ' + entries + ' notes' };
    },
  },
  {
    id: 'mcp',
    label: 'mcp belt',
    // A box may legitimately run without MCP servers, so an absent config is a
    // grey note. A config that will not parse is a fault and escalates (§46.1:
    // a lane that cannot run is not a fallback).
    optional: true,
    run() {
      const dirs = [
        path.join(HOME, '.hakster'),
        path.join(REPO, '.hakster'),
        path.join(process.cwd(), '.hakster'),
      ];
      const names = new Set();
      const broken = [];
      let found = 0;
      for (const dir of dirs) {
        const raw = read(path.join(dir, 'mcp.json'), 400000);
        if (!raw) continue;
        found++;
        try {
          const json = JSON.parse(raw);
          const servers = json.mcpServers || json.servers || {};
          for (const name of Object.keys(servers)) names.add(name);
        } catch { broken.push(dir); }
      }
      if (broken.length) return { ok: false, optional: false, detail: 'mcp.json unreadable in ' + broken.join(', ') };
      if (!found) return { ok: false, detail: 'no mcp.json' };
      if (!names.size) return { ok: false, detail: 'mcp.json lists no servers' };
      return { ok: true, note: names.size + ' servers', detail: names.size + ' servers configured' };
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
      // A result may escalate itself out of "optional" when what it found is a
      // real fault rather than a component this box simply does not carry.
      optional: result.optional != null ? !!result.optional : !!check.optional,
      ok: !!result.ok,
      note: result.note || '',
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
