/* `hakster claude` starts with OUR playbooks, not Anthropic's prompt.
 *
 * Owner, 2026-11-26: "the hakster claude uses claude cli feel me ours with
 * hakster deepseep claude playbook mds".
 *
 * What is pinned here:
 *   1. the composed playbooks are written to the isolated config dir as
 *      `CLAUDE.md` — the file Claude Code reads as user memory — and never into
 *      the machine's real ~/.claude;
 *   2. the write is idempotent and versioned: a second run with the same bytes
 *      writes nothing, and the marker carries the CLI version;
 *   3. a CLAUDE.md that is not ours is backed up, never silently replaced;
 *   4. HAKSTER_NO_PLAYBOOKS=1 opts out without failing the run;
 *   5. the playbook set actually carries our identity, tool loop and rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.join(here, '..', '..');

const { installPlaybooks } = require(path.join(cliRoot, 'src', 'managed-claude.js'));
const pkg = require(path.join(cliRoot, 'package.json'));

const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hk-playbook-'));

test('the playbooks land in the isolated config dir as CLAUDE.md, mode 600', () => {
  const dir = tmp();
  try {
    const r = installPlaybooks(dir);
    assert.ok(r, 'installPlaybooks returned nothing');
    assert.ok(r.files.length >= 4, `only ${r.files.length} playbook(s)`);
    assert.equal(r.written, true);
    assert.equal(r.path, path.join(dir, 'CLAUDE.md'));
    assert.equal(fs.statSync(r.path).mode & 0o777, 0o600);
    assert.ok(!dir.includes(`${path.sep}.claude${path.sep}`) && !dir.endsWith(`${path.sep}.claude`),
      'must never target the machine’s real ~/.claude');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the write is idempotent and the marker carries the CLI version', () => {
  const dir = tmp();
  try {
    const first = installPlaybooks(dir);
    const bytes = fs.readFileSync(first.path, 'utf8');
    const second = installPlaybooks(dir);
    assert.equal(second.written, false, 'a second run must not rewrite identical bytes');
    assert.equal(fs.readFileSync(second.path, 'utf8'), bytes);
    assert.match(bytes.split('\n')[0], /^<!-- haksterai-playbooks v\d+\.\d+\.\d+/);
    assert.ok(bytes.split('\n')[0].includes(`v${pkg.version}`), 'marker must name the package version');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a CLAUDE.md that is not ours is backed up, never silently replaced', () => {
  const dir = tmp();
  try {
    const target = path.join(dir, 'CLAUDE.md');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, '# the user’s own memory\n');
    const r = installPlaybooks(dir);
    assert.equal(r.written, true);
    const backups = fs.readdirSync(dir).filter((n) => n.startsWith('CLAUDE.md.bak-'));
    assert.equal(backups.length, 1, 'the foreign file must be backed up exactly once');
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '# the user’s own memory\n');
    assert.match(fs.readFileSync(target, 'utf8'), /haksterai-playbooks/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('HAKSTER_NO_PLAYBOOKS=1 opts out and writes nothing', () => {
  const dir = tmp();
  const prev = process.env.HAKSTER_NO_PLAYBOOKS;
  try {
    process.env.HAKSTER_NO_PLAYBOOKS = '1';
    assert.equal(installPlaybooks(dir), null);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    if (prev === undefined) delete process.env.HAKSTER_NO_PLAYBOOKS;
    else process.env.HAKSTER_NO_PLAYBOOKS = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the playbook set carries our identity, tool loop, rules and tool map', () => {
  const dir = tmp();
  try {
    const body = fs.readFileSync(installPlaybooks(dir).path, 'utf8');
    assert.match(body, /HAKSTERAI-FLASH/, 'names our model');
    assert.match(body, /deepseek-v4\.1-flash:cloud/, 'names the locked wire model');
    assert.match(body, /THINK → PLAN → ACT → OBSERVE → REFLECT → CONSOLIDATE/, 'carries the tool loop');
    assert.match(body, /Read before you write/i, 'carries the read-before-write rule');
    assert.match(body, /Secrets never travel/i, 'carries the secrets rule');
    assert.match(body, /Tool map/, 'carries the tool map');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the playbooks ship in the published package', () => {
  assert.ok(pkg.files.includes('playbooks/'), 'cli/package.json must ship playbooks/');
  const dir = path.join(cliRoot, 'playbooks');
  const mds = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  assert.ok(mds.length >= 4, `only ${mds.length} playbook file(s) on disk`);
});
