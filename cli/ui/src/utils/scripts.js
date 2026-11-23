import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* Live scripts.
 *
 * The owner asked for "a side panel for our live scripts to show and run live
 * to compare code when need to ours" (2026-11-23). This module is the honest
 * half of that: it discovers what is actually on disk, and remembers the source
 * every script had the last time it was run, so the compare window can say what
 * changed since — a real diff against a real snapshot, not an invented one.
 *
 * Nothing here runs anything. The runner lives in hooks/useScriptRunner.js and
 * only ever executes a path this module returned.
 */

const SCRIPT_EXT = new Set(['.sh', '.bash', '.cjs', '.mjs', '.js', '.py']);

/** Where the checkout is, from the bundle's own location (cli/ui-fb.mjs). */
export function projectRoots() {
  let cliDir;
  try {
    cliDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    cliDir = process.cwd();
  }
  // The bundle sits in cli/, the source in cli/ui/src/utils/ — walk up until a
  // directory that looks like the repo (package.json + scripts or cli).
  const candidates = [];
  let dir = cliDir;
  for (let i = 0; i < 5; i += 1) {
    candidates.push(dir);
    dir = path.dirname(dir);
  }
  const repo = candidates.find((d) => fs.existsSync(path.join(d, 'package.json')) && fs.existsSync(path.join(d, 'cli')))
    || candidates.find((d) => fs.existsSync(path.join(d, 'package.json')))
    || process.cwd();
  return { repo, cli: path.join(repo, 'cli') };
}

const interpreterFor = (file) => {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.sh' || ext === '.bash') return 'bash';
  if (ext === '.py') return 'python3';
  return 'node';
};

/** Every runnable script in scripts/ and cli/scripts/, plus npm scripts. */
export function discoverScripts() {
  const { repo, cli } = projectRoots();
  const out = [];
  const seen = new Set();
  const add = (entry) => {
    if (!entry || seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };

  for (const [dir, tag] of [[path.join(repo, 'scripts'), 'repo'], [path.join(cli, 'scripts'), 'cli']]) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => SCRIPT_EXT.has(path.extname(n).toLowerCase())).sort();
    } catch {
      continue; // no such directory in this install
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      try {
        if (!fs.statSync(abs).isFile()) continue;
      } catch { continue; }
      add({
        id: `${tag}/${name}`,
        label: name,
        tag,
        path: abs,
        run: [interpreterFor(abs), abs],
        cwd: repo,
      });
    }
  }

  // npm scripts are live too (the deploy path lives in one of them).
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
      if (name === 'postinstall' || name === 'astro') continue; // not ours to run from here
      add({
        id: `npm/${name}`,
        label: `npm run ${name}`,
        tag: 'npm',
        path: path.join(repo, 'package.json'),
        run: ['npm', 'run', name],
        cwd: repo,
      });
    }
  } catch { /* a checkout without a package.json still lists its scripts */ }

  return out;
}

/* The source a script had the last time it was run in this process. */
const LAST_RUN = new Map();

export function sourceOf(entry) {
  try {
    return fs.readFileSync(entry.path, 'utf8').replace(/\r\n/g, '\n').split('\n');
  } catch {
    return [];
  }
}

/** Remember what we are about to run; returns the source it replaces. */
export function snapshotBeforeRun(entry) {
  const prev = LAST_RUN.get(entry.id) || null;
  LAST_RUN.set(entry.id, sourceOf(entry));
  return prev;
}

export const lastSnapshot = (entry) => LAST_RUN.get(entry?.id) || null;

/**
 * A line diff between two snapshots, good enough to point at what moved.
 * Lines present in both keep no mark, added lines get '+', removed lines get
 * '-'. Duplicates are matched by count, so a repeated line is not reported as
 * a change just because it appears twice.
 */
export function diffLines(prev, next) {
  const before = Array.isArray(prev) ? prev : [];
  const after = Array.isArray(next) ? next : [];
  if (!before.length) return after.map((text) => ({ text, mark: '' }));
  const pool = new Map();
  for (const line of before) pool.set(line, (pool.get(line) || 0) + 1);
  const marked = after.map((text) => {
    const n = pool.get(text) || 0;
    if (n > 0) {
      pool.set(text, n - 1);
      return { text, mark: '' };
    }
    return { text, mark: '+' };
  });
  // Removed lines are shown first, so the reader sees what went away.
  const gone = [];
  for (const [line, n] of pool) {
    for (let i = 0; i < n; i += 1) gone.push({ text: line, mark: '-' });
  }
  return [...gone, ...marked];
}

/** The script's own lines, unchanged (for the "ours" column). */
export const linesOf = (entry) => sourceOf(entry);
