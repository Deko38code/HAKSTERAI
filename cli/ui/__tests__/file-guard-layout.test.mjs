/* file-guard-layout — the 13-file guard must read the layout it is in.

   Owner, 2026-11-26: "hakster made some file s missing says 2/13 fix on dell".
   A published package ships `cli/` only (CLAUDE.md §28, §42), so counting the
   13 project files inside one reported "2/13 files" — and the server docked
   smartness -10 per "missing" file — for files that package can never hold.
   The guard now resolves the source tree it lives in, and falls back to the
   package's own shipped files. Nothing here creates or repairs a file.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const REPO = path.resolve(CLI_DIR, '..');
const SRC = path.join(CLI_DIR, 'smartness.mjs');

function fakeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-guard-'));
  fs.mkdirSync(path.join(root, 'cli'), { recursive: true });
  fs.copyFileSync(SRC, path.join(root, 'cli', 'smartness.mjs'));
  // A file the guard actually IMPORTS has to be real code, not a placeholder:
  // writing '' here produced ERR_MODULE_NOT_FOUND instead of testing the layout
  // (2026-11-26 — smartness imports src/listening-ports.js for the services
  // panel, so that module must exist in the fixture exactly as it ships).
  // package.json must be real JSON too: resolving a sibling `.js` import makes
  // Node read the fixture's package scope, and an empty file is not valid JSON
  // (ERR_INVALID_PACKAGE_CONFIG), which would fail before any guard logic ran.
  const IMPORTED = new Set(['cli/src/listening-ports.js', 'cli/src/home-dir.js', 'cli/package.json']);
  for (const rel of files) {
    if (rel === 'cli/smartness.mjs') continue; // the real module is already there
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (IMPORTED.has(rel)) fs.copyFileSync(path.join(CLI_DIR, rel.slice('cli/'.length)), p);
    else fs.writeFileSync(p, '');
  }
  return root;
}

test('the repository reads the 13 project files, in project mode', async () => {
  const { fileGuard, IMPORTANT_FILES } = await import('../../smartness.mjs');
  const g = fileGuard();
  assert.equal(g.mode, 'project');
  assert.equal(g.total, IMPORTANT_FILES.length);
  assert.equal(g.missing.length, 0, `missing in the repo: ${g.missing.join(', ')}`);
  assert.equal(g.present, 13);
});

test('a package install reads its own shipped files, never the project files', async () => {
  const { INSTALL_FILES } = await import('../../smartness.mjs');
  const root = fakeTree(INSTALL_FILES);
  try {
    const mod = await import(path.join(root, 'cli', 'smartness.mjs'));
    const g = mod.fileGuard();
    assert.equal(g.mode, 'install', 'a tree with no AGENTS.md/.git is an install, not a repo');
    assert.equal(g.total, INSTALL_FILES.length);
    assert.equal(g.present, INSTALL_FILES.length);
    assert.equal(g.missing.length, 0);
    assert.equal(g.root, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an install missing a shipped file reports that file, not eleven project ones', async () => {
  const { INSTALL_FILES } = await import('../../smartness.mjs');
  const shipped = INSTALL_FILES.filter((f) => f !== 'cli/ui-fb.mjs');
  const root = fakeTree(shipped);
  try {
    const mod = await import(path.join(root, 'cli', 'smartness.mjs'));
    const g = mod.fileGuard();
    assert.equal(g.mode, 'install');
    assert.deepEqual(g.missing, ['cli/ui-fb.mjs']);
    assert.equal(g.total, INSTALL_FILES.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the repo it lives in wins over the install list when both could apply', async () => {
  const { fileGuard, IMPORTANT_FILES } = await import('../../smartness.mjs');
  // A real source tree (AGENTS.md + the agent loop) is checked as a project
  // even though its own cli/ also holds the install files.
  const g = fileGuard(REPO);
  assert.equal(g.mode, 'project');
  assert.equal(g.total, IMPORTANT_FILES.length);
  assert.equal(g.present, 13);
});
