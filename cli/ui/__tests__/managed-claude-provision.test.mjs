/* `hakster claude` must work for a paid plan with no Claude Code installed.
 *
 * Owner, 2026-11-25: "if users didnt have claude code installed locally then
 * wont work so can u find a way to have the claude cli with our install for cli
 * but gotta use our sighn in flow etc" — "we need our cli to work right after
 * install for paid users 20 and hogher".
 *
 * What is pinned here:
 *   1. resolution order — the user's own `claude` on PATH, then our private
 *      copy in ~/.hakster/claude-code, then one automatic install into it;
 *   2. the install is verified (`claude --version`), not assumed from npm's
 *      exit code (§13), and a failure leaves a copy-pasteable fix;
 *   3. nothing points at the machine's real ~/.claude — the managed program
 *      runs with its own CLAUDE_CONFIG_DIR;
 *   4. the signed-in route is ours: our /anthropic relay, this account's key,
 *      the locked wire model, and no inherited OAuth token.
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

const provision = require(path.join(cliRoot, 'src', 'claude-code-provision.js'));
const { buildManagedEnv } = require(path.join(cliRoot, 'src', 'managed-claude.js'));

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `mg-${name}-`));

function writeFakeBinary(file, bytes = 5000) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x23), { mode: 0o755 });
  return file;
}

test('resolution order: the user’s own claude on PATH wins', () => {
  const dir = tmp('path');
  const bin = writeFakeBinary(path.join(dir, 'claude'));
  const prefix = tmp('prefix');
  writeFakeBinary(path.join(prefix, 'node_modules', '.bin', 'claude'));
  const env = { ...process.env, PATH: dir, HAKSTER_CLAUDE_PREFIX: prefix };
  const saved = { PATH: process.env.PATH, HAKSTER_CLAUDE_PREFIX: process.env.HAKSTER_CLAUDE_PREFIX };
  process.env.PATH = env.PATH;
  process.env.HAKSTER_CLAUDE_PREFIX = env.HAKSTER_CLAUDE_PREFIX;
  try {
    const r = provision.resolveClaudeBinary({ allowInstall: false });
    assert.equal(r.source, 'path');
    assert.equal(r.bin, bin);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.HAKSTER_CLAUDE_PREFIX === undefined) delete process.env.HAKSTER_CLAUDE_PREFIX;
    else process.env.HAKSTER_CLAUDE_PREFIX = saved.HAKSTER_CLAUDE_PREFIX;
  }
});

test('our private copy is used when the machine has no claude', () => {
  const emptyPath = tmp('empty-path');
  const prefix = tmp('prefix');
  const bin = writeFakeBinary(path.join(prefix, 'node_modules', '.bin', 'claude'));
  const savedPath = process.env.PATH;
  process.env.PATH = emptyPath;
  try {
    const found = provision.findManagedClaude(prefix);
    assert.equal(found, bin);
    const r = provision.resolveClaudeBinary({ prefix, allowInstall: false });
    assert.equal(r.source, 'managed');
    assert.equal(r.bin, bin);
  } finally {
    process.env.PATH = savedPath;
  }
});

test('the package’s <4 KB placeholder stub is never treated as installed', () => {
  const prefix = tmp('stub');
  const stub = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  writeFakeBinary(stub, 500); // what install.cjs leaves when the native binary is absent
  assert.equal(provision.findManagedClaude(prefix), null);
  writeFakeBinary(stub, 500 * 1024);
  assert.equal(provision.findManagedClaude(prefix), stub);
});

test('the private prefix is ~/.hakster/claude-code and never inside ~/.claude', () => {
  const saved = process.env.HAKSTER_CLAUDE_PREFIX;
  delete process.env.HAKSTER_CLAUDE_PREFIX;
  try {
    assert.equal(provision.managedPrefix(), path.join(os.homedir(), '.hakster', 'claude-code'));
  } finally {
    if (saved !== undefined) process.env.HAKSTER_CLAUDE_PREFIX = saved;
  }
  const realClaude = path.join(os.homedir(), '.claude');
  for (const p of provision.managedBinCandidates(provision.managedPrefix())) {
    assert.ok(p.startsWith(provision.managedPrefix()), `${p} escapes the managed prefix`);
    assert.ok(!p.startsWith(realClaude + path.sep) && p !== realClaude, `${p} touches the real ~/.claude`);
  }
});

test('missing npm fails with the exact command to run, and changes nothing', () => {
  const prefix = tmp('no-npm');
  const savedPath = process.env.PATH;
  process.env.PATH = tmp('bare');
  try {
    assert.throws(
      () => provision.provisionClaudeCode({ prefix, log: { log() {} } }),
      (e) => e.code === 'ENOENT_NPM'
        && e.message.includes('npm install --prefix')
        && e.message.includes(prefix),
    );
  } finally {
    process.env.PATH = savedPath;
  }
  assert.deepEqual(fs.readdirSync(prefix), []);
});

test('the first run installs once, then proves it with claude --version', () => {
  const prefix = tmp('install');
  const calls = [];
  const run = (cmd, args) => {
    calls.push({ cmd, args });
    if (args.includes('install')) {
      writeFakeBinary(path.join(prefix, 'node_modules', '.bin', 'claude'));
      // bin/ shim on Windows lands beside node_modules; covered by the candidates list
      writeFakeBinary(path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
      return { status: 0 };
    }
    if (args[0] === '--version') return { status: 0, stdout: '2.1.332 (Claude Code)\n' };
    return { status: 0 };
  };
  const out = provision.provisionClaudeCode({ prefix, log: { log() {} }, run });
  assert.equal(out.version, '2.1.332 (Claude Code)');
  assert.equal(out.prefix, prefix);

  const install = calls.find((c) => c.args.includes('install'));
  assert.ok(install, 'npm install was not run');
  assert.ok(install.args.includes('--prefix') && install.args.includes(prefix));
  assert.ok(install.args.includes('@anthropic-ai/claude-code@2.1.332'), 'version is not pinned');
  assert.ok(calls.some((c) => c.args[0] === '--version'), 'the binary was never verified');
});

test('an install that will not run is reported, not handed over (§13)', () => {
  const prefix = tmp('bad-verify');
  const run = (cmd, args) => {
    if (args.includes('install')) {
      writeFakeBinary(path.join(prefix, 'node_modules', '.bin', 'claude'));
      return { status: 0 };
    }
    return { status: 1, stdout: '' };
  };
  assert.throws(
    () => provision.provisionClaudeCode({ prefix, log: { log() {} }, run }),
    (e) => e.code === 'EVERIFY' && e.message.includes('npm install --prefix'),
  );
});

test('a failed npm install keeps the manual path in the message', () => {
  const prefix = tmp('bad-install');
  const run = () => ({ status: 1, error: null });
  assert.throws(
    () => provision.provisionClaudeCode({ prefix, log: { log() {} }, run }),
    (e) => e.code === 'EINSTALL' && e.message.includes('npm install --prefix'),
  );
});

test('the child runs on our relay, this account’s key, our model — no OAuth', () => {
  const cfgDir = path.join(os.homedir(), '.hakster-claude');
  const env = buildManagedEnv({
    origin: 'https://haksterai.com',
    key: 'hk_test_key_value',
    cfgDir,
    base: {
      PATH: '/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'leftover-oauth-token',
      ANTHROPIC_API_KEY: 'leftover-anthropic-key',
    },
  });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://haksterai.com/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'hk_test_key_value');
  assert.equal(env.CLAUDE_CONFIG_DIR, cfgDir);
  assert.notEqual(env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude'));
  // The locked model, every alias (§22, §35).
  for (const k of [
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
  ]) {
    assert.equal(env[k], 'deepseek-v4.1-flash:cloud', k);
  }
  // This session's compaction window (§39) and no updater fighting our pin.
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000');
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1048576');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  // An inherited OAuth token would outrank the relay key — it must be gone.
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, '');
  // The rest of the operator's environment is preserved.
  assert.equal(env.PATH, '/usr/bin');
});

test('the pinned version has one source and the override is opt-in', () => {
  assert.equal(provision.DEFAULT_SPEC, '@anthropic-ai/claude-code@2.1.332');
  const saved = process.env.HAKSTER_CLAUDE_CODE_SPEC;
  process.env.HAKSTER_CLAUDE_CODE_SPEC = '@anthropic-ai/claude-code@9.9.9';
  try {
    assert.equal(provision.claudeCodeSpec(), '@anthropic-ai/claude-code@9.9.9');
  } finally {
    if (saved === undefined) delete process.env.HAKSTER_CLAUDE_CODE_SPEC;
    else process.env.HAKSTER_CLAUDE_CODE_SPEC = saved;
  }
});

test('`hakster login` tells a paid plan the Claude Code path', () => {
  const src = fs.readFileSync(path.join(cliRoot, 'index.js'), 'utf8');
  assert.match(src, /Claude Code on this plan: 'hakster claude'/);
});
