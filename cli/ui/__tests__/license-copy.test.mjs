// The CLI ships its own copy of the license module.
//
// Owner, 2026-11-25 ("make sure its solid"): a standalone install — /install.sh,
// the Windows installer, `npm install -g hakster-cli` — has no `server/` sibling,
// and index.js used to require `../server/src/license` at the top level, so the
// first command crashed with MODULE_NOT_FOUND. The copy is verbatim, and this
// test keeps it verbatim: if server/src/license.js changes, the copy is refreshed
// in the same commit or this fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, '..', '..');
const shipped = path.join(cliRoot, 'src', 'license.js');
const monorepo = path.resolve(cliRoot, '..', 'server', 'src', 'license.js');

test('the package carries its own license module', () => {
  assert.equal(existsSync(shipped), true, 'cli/src/license.js must exist for a standalone install');
});

test('the shipped copy is byte-identical to the monorepo module', () => {
  assert.equal(existsSync(monorepo), true, 'run this test from the repo checkout');
  const a = readFileSync(shipped);
  const b = readFileSync(monorepo);
  assert.equal(
    Buffer.compare(a, b),
    0,
    'cli/src/license.js drifted from server/src/license.js — copy it again: cp server/src/license.js cli/src/license.js',
  );
});

test('index.js loads the shipped copy first, with the monorepo path as fallback', () => {
  const src = readFileSync(path.join(cliRoot, 'index.js'), 'utf8');
  assert.match(src, /require\('\.\/src\/license'\)/, 'index.js must require ./src/license');
  assert.match(src, /require\('\.\.\/server\/src\/license'\)/, 'the monorepo fallback must stay');
  // It must never be the hard top-level require it used to be.
  assert.doesNotMatch(
    src,
    /^const \{ checkLicense \} = require\('\.\.\/server\/src\/license'\);/m,
    'the unguarded top-level require is what broke standalone installs',
  );
});

test('the module has no dependency outside Node built-ins and the user home', () => {
  const src = readFileSync(shipped, 'utf8');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  for (const r of requires) {
    assert.ok(
      ['fs', 'os', 'path', 'https', 'http'].includes(r),
      `license.js must not require ${r} — it has to run inside the installed package alone`,
    );
  }
});
