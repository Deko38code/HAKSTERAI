// The installer must survive a `hakster` that is already in npm's bin and is
// not npm's own (owner, 2026-11-26: the older Lenovo standby could not install
// the published CLI at all).
//
// On that box `npm install -g` exited EEXIST because
// ~/.nvm/versions/node/v24.14.0/bin/hakster was a symlink into an old checkout.
// The installer hid npm's output in /dev/null and then reported "the global
// install needs permissions we do not have" — a cause it had never read — and
// the ~/.local fallback died the same way on a hand-written launcher. So an
// install that was fully permitted was refused twice and blamed on permissions.
//
// What is pinned here is the behaviour of the REAL `install_into` function,
// sliced out of install.sh and run against a stub npm — not a regex over the
// source (§50.1: a change is finished when a command showed it working):
//   1. a conflicting bin entry is moved aside and the install then succeeds,
//      with the original kept beside it (never deleted, never --forced);
//   2. if the install still fails, the entry is put back exactly as it was;
//   3. npm's own message is captured and printed, never replaced by a guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync, readlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const installSh = path.join(repoRoot, 'install.sh');

// The function as it is actually written in install.sh, from `install_into() {`
// to its closing brace at column 0.
function sliceInstallInto() {
  const src = readFileSync(installSh, 'utf8');
  const start = src.indexOf('install_into() {');
  assert.ok(start > 0, 'install_into exists in install.sh');
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'install_into is a complete function');
  return src.slice(start, end + 3);
}

// A stub npm. `npm install -g <pkg> [--prefix <dir>]`:
//   · a `hakster` already in the prefix's bin → the real EEXIST shape, exit 1;
//   · STUB_FAIL_ALWAYS set → a different failure (EACCES), exit 1;
//   · otherwise it writes the bin entry and exits 0.
// The prefix is read from the --prefix flag wherever it sits in argv, and falls
// back to STUB_GLOBAL for npm's default global install.
const STUB_NPM = `#!/bin/sh
prefix=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--prefix" ]; then prefix="$a"; fi
  prev="$a"
done
[ -n "$prefix" ] || prefix="\${STUB_GLOBAL:-}"
entry="$prefix/bin/hakster"
if [ -e "$entry" ] || [ -L "$entry" ]; then
  printf 'npm error code EEXIST\\nnpm error path %s\\nnpm error EEXIST: file already exists\\n' "$entry" >&2
  exit 1
fi
if [ -n "\${STUB_FAIL_ALWAYS:-}" ]; then
  printf 'npm error code EACCES\\nnpm error EACCES: permission denied, mkdir %s\\n' "$prefix" >&2
  exit 1
fi
mkdir -p "$prefix/bin" && printf '#!/bin/sh\\necho installed\\n' > "$entry" && chmod +x "$entry"
`;

function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hakster-existing-bin-'));
  mkdirSync(path.join(root, 'stub'), { recursive: true });
  writeFileSync(path.join(root, 'stub', 'npm'), STUB_NPM);
  chmodSync(path.join(root, 'stub', 'npm'), 0o755);

  // The real function plus the two lines that make it callable: the installer's
  // own `say`, then a call that reports the return code and what npm said.
  writeFileSync(path.join(root, 'fn.sh'), [
    'say() { printf \'%s\\n\' "$*"; }',
    sliceInstallInto(),
    'install_into "$1" "$2"',
    'rc=$?',
    'printf \'RC=%s\\n\' "$rc"',
    'printf \'NPM_ERR=%s\\n\' "${NPM_ERR:-}"',
    'exit 0',
    '',
  ].join('\n'));

  const prefix = path.join(root, 'prefix');
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  return { root, prefix };
}

function run(root, prefix, extraEnv = {}) {
  // `sh -c '...' -- <pkg> <prefix>`: the tarball path is never read — the stub
  // npm decides everything — so any readable path will do.
  return execFileSync('sh', ['-c', '. ./fn.sh', '--', path.join(root, 'pkg.tgz'), prefix], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'stub')}${path.delimiter}${process.env.PATH || ''}`,
      // install.sh sets TMP=mktemp -d before this block; the slice needs it.
      TMP: root,
      STUB_GLOBAL: prefix,
      ...extraEnv,
    },
  });
}

test('a conflicting hakster is moved aside, and the install then succeeds', () => {
  const { root, prefix } = sandbox();
  try {
    const entry = path.join(prefix, 'bin', 'hakster');
    // The Lenovo shape: an installed CLI's bin entry pointing into a checkout.
    writeFileSync(path.join(root, 'old-cli-index.js'), '// old checkout\n');
    execFileSync('ln', ['-s', path.join(root, 'old-cli-index.js'), entry]);

    const out = run(root, prefix);
    assert.match(out, /RC=0/, 'the install succeeds once the conflict is out of the way');
    assert.match(out, /moved the existing .*hakster aside/, 'the move is reported, not silent');

    // The entry npm could not overwrite is kept beside it, never deleted.
    const aside = readdirSync(path.join(prefix, 'bin')).filter((n) => n.startsWith('hakster.pre-npm-'));
    assert.equal(aside.length, 1, 'the old entry is kept as hakster.pre-npm-<stamp>');
    assert.match(readFileSync(path.join(prefix, 'bin', aside[0]), 'utf8') || '', /^\/\/ old checkout/m,
      'the kept entry is the original file');

    // And what sits on PATH now is npm's own install, not the old link.
    assert.match(readFileSync(entry, 'utf8'), /echo installed/, 'the bin entry is the installed CLI');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('when the install still fails, the moved entry is put back exactly', () => {
  const { root, prefix } = sandbox();
  try {
    const entry = path.join(prefix, 'bin', 'hakster');
    const target = path.join(root, 'old-cli-index.js');
    writeFileSync(target, '// old checkout\n');
    execFileSync('ln', ['-s', target, entry]);

    const out = run(root, prefix, { STUB_FAIL_ALWAYS: '1' });
    assert.match(out, /RC=1/, 'a real failure is a failure');
    assert.match(out, /put .*hakster back/, 'the restore is reported');
    assert.equal(readlinkSync(entry), target, 'the symlink is back, pointing where it did');
    assert.equal(
      readdirSync(path.join(prefix, 'bin')).filter((n) => n.startsWith('hakster.pre-npm-')).length, 0,
      'nothing is left behind when the install did not happen',
    );
    assert.match(out, /NPM_ERR=npm error code EACCES/, "npm's own message is kept, not guessed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a clean machine installs straight through', () => {
  const { root, prefix } = sandbox();
  try {
    const out = run(root, prefix);
    assert.match(out, /RC=0/);
    assert.doesNotMatch(out, /moved the existing/, 'no aside message when there is nothing to move');
    assert.ok(existsSync(path.join(prefix, 'bin', 'hakster')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the installer never hides npm output or guesses the cause', () => {
  const src = readFileSync(installSh, 'utf8');
  // The exact line that produced the wrong diagnosis on the Lenovo.
  assert.doesNotMatch(src, /npm install -g "\$TMP\/\$PKG" >\/dev\/null/,
    'the CLI install never discards npm output');
  assert.doesNotMatch(src, /needs permissions we do not have/,
    'a failure is not labelled "permissions" without reading why');
  assert.match(src, /install_into\(\) \{/, 'the shared install helper exists');
  assert.match(src, /npm error path/, 'the EEXIST bin entry is located from npm\'s own message');
  assert.match(src, /never\s*\n?#?\s*`--force`|never `--force`/, 'the conflict is moved aside, never forced');
  assert.match(src, /it reported:/, 'npm\'s message is printed when an install fails');
});
