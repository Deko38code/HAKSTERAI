/* claude-code-provision.js — find `claude`, or install it once, so that
 * `hakster claude` works on a machine that never had Claude Code.
 *
 * Owner, 2026-11-25: "if users didnt have claude code installed locally then
 * wont work so can u find a way to have the claude cli with our install for cli
 * but gotta use our sighn in flow etc" and "we need our cli to work right after
 * install for paid users 20 and hogher".
 *
 * The Claude Code package is ~500 MB once its native binary is unpacked, so it
 * is NOT bundled into our tarball (`/cli/pkg.tar.gz` stays small and Parrot's
 * disk is at ~96 % — §5). Instead:
 *
 *   1. A `claude` already on PATH always wins. The user's own install is used,
 *      never moved, upgraded or configured.
 *   2. Otherwise a private copy under ~/.hakster/claude-code is used — our own
 *      prefix, our own `npm install`, untouched by and invisible to any global
 *      install.
 *   3. Otherwise it is installed into that prefix the first time `hakster
 *      claude` runs, behind the same entitlement check the run already does
 *      (§28.5), and verified with `claude --version` before it is handed over
 *      (§13: a successful npm exit alone is not proof).
 *
 * Nothing here touches ~/.claude or ~/.claude.json: the prefix holds the
 * program only, and managed-claude.js points the program at its own isolated
 * config dir (~/.hakster-claude). Sign-in stays our magic link — the installed
 * Claude Code never asks Anthropic for an account.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_NAME = '@anthropic-ai/claude-code';
// Pinned so a support case is reproducible and a future release cannot
// silently change what our relay's callers talk to. Bumping it is a CLI
// version bump (§28.2, §39.3). HAKSTER_CLAUDE_CODE_SPEC overrides it for a
// mirror or a test; it never comes from our config files (§22.4 is about the
// model, and this is not a model value).
const PINNED_VERSION = '2.1.332';
const DEFAULT_SPEC = `${PACKAGE_NAME}@${PINNED_VERSION}`;
// The postinstall copies the native binary over bin/claude.exe; before it
// succeeds that file is a ~500-byte stub that only prints instructions. A
// usable binary is far larger than this.
const STUB_MAX_BYTES = 4096;

function claudeCodeSpec() {
  const override = String(process.env.HAKSTER_CLAUDE_CODE_SPEC || '').trim();
  return override || DEFAULT_SPEC;
}

/** Where our own copy lives. Private to this user's home; never global. */
function managedPrefix() {
  const override = String(process.env.HAKSTER_CLAUDE_PREFIX || '').trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.hakster', 'claude-code');
}

function isUsableFile(file) {
  try {
    const st = fs.statSync(file); // follows the .bin symlink to the real file
    if (!st.isFile()) return false;
    // Windows shims are small text scripts; on Unix a small file here is the
    // package's placeholder stub, i.e. the native binary was never placed.
    if (process.platform === 'win32') return true;
    return st.size > STUB_MAX_BYTES;
  } catch {
    return false;
  }
}

/** Candidate paths inside `prefix`, in preference order. */
function managedBinCandidates(prefix = managedPrefix()) {
  const pkgDir = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  const names = process.platform === 'win32'
    ? ['claude.cmd', 'claude.exe', 'claude.bat', 'claude']
    : ['claude'];
  const out = [];
  for (const name of names) {
    out.push(path.join(prefix, 'node_modules', '.bin', name));
    out.push(path.join(prefix, name)); // npm --prefix on Windows writes shims here
  }
  // The postinstall's destination on every platform — works even when the
  // shim is missing or the install was made with --ignore-scripts off/on.
  out.push(path.join(pkgDir, 'bin', 'claude.exe'));
  out.push(path.join(pkgDir, 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'));
  return [...new Set(out)];
}

/** Find a usable managed copy, or null. */
function findManagedClaude(prefix = managedPrefix()) {
  for (const candidate of managedBinCandidates(prefix)) {
    if (isUsableFile(candidate)) return candidate;
  }
  return null;
}

/** Resolve `claude` from PATH without executing anything. */
function findClaudeOnPath() {
  const names = process.platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (isUsableFile(full)) return full;
    }
  }
  return null;
}

/** `npm` on PATH, or null. */
function findNpm() {
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

function manualHint(prefix = managedPrefix()) {
  return `npm install --prefix ${prefix} ${claudeCodeSpec()}`;
}

/**
 * Install Claude Code into our private prefix and prove it runs.
 * Throws an Error with `.code` = 'ENOENT_NPM' | 'EINSTALL' | 'EVERIFY'.
 */
function provisionClaudeCode(opts = {}) {
  const prefix = opts.prefix || managedPrefix();
  const log = opts.log || console;
  const run = opts.run || spawnSync;
  const spec = opts.spec || claudeCodeSpec();

  const npm = findNpm();
  if (!npm) {
    const err = new Error(
      'npm was not found, so Claude Code cannot be installed automatically.\n'
      + '  Install Node.js (it includes npm) and re-run `hakster claude`, or install it yourself:\n'
      + `    ${manualHint(prefix)}`,
    );
    err.code = 'ENOENT_NPM';
    throw err;
  }

  try {
    fs.mkdirSync(prefix, { recursive: true, mode: 0o700 });
  } catch (e) {
    const err = new Error(`could not create ${prefix}: ${e.message}`);
    err.code = 'EINSTALL';
    throw err;
  }

  log.log(`▸ Claude Code isn't installed here — setting it up once in ${prefix}`);
  log.log('▸ This download is about 500 MB (a minute or two). It stays separate from any');
  log.log('  Claude Code you install yourself, and it still signs in through HaksterAI.');

  const args = [
    'install',
    '--prefix', prefix,
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    spec,
  ];
  const res = run(npm, args, {
    stdio: 'inherit',
    // npm on Windows is a .cmd, which only runs through the shell.
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    },
  });
  if (!res || (typeof res.status === 'number' && res.status !== 0) || res.error) {
    const why = (res && res.error && res.error.message) || `npm exited ${res && res.status}`;
    const err = new Error(
      `installing Claude Code failed (${why}).\n`
      + '  Nothing outside that folder was changed. Try again with:\n'
      + `    ${manualHint(prefix)}`,
    );
    err.code = 'EINSTALL';
    throw err;
  }

  const bin = findManagedClaude(prefix);
  if (!bin) {
    const err = new Error(
      `Claude Code installed into ${prefix} but its binary is not runnable.\n`
      + '  Re-run, or install it yourself:\n'
      + `    ${manualHint(prefix)}`,
    );
    err.code = 'EINSTALL';
    throw err;
  }

  // §13: a zero exit from npm is not proof. The binary answers or it doesn't.
  const check = run(bin, ['--version'], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
  });
  const version = String((check && check.stdout) || '').trim().split('\n')[0];
  if (!check || check.error || (typeof check.status === 'number' && check.status !== 0) || !version) {
    const err = new Error(
      `Claude Code was installed into ${prefix} but \`claude --version\` did not answer.\n`
      + '  Re-run, or install it yourself:\n'
      + `    ${manualHint(prefix)}`,
    );
    err.code = 'EVERIFY';
    throw err;
  }

  log.log(`▸ Claude Code ${version} ready in ${prefix}`);
  return { bin, version, prefix };
}

/**
 * PATH first, then our private copy, then (optionally) a one-time install.
 * Resolves { bin, source, version? } — or throws the provisioning error.
 */
function resolveClaudeBinary(opts = {}) {
  const onPath = findClaudeOnPath();
  if (onPath) return { bin: onPath, source: 'path' };

  const prefix = opts.prefix || managedPrefix();
  const managed = findManagedClaude(prefix);
  if (managed) return { bin: managed, source: 'managed', prefix };

  if (opts.allowInstall === false) return null;
  const installed = provisionClaudeCode({ ...opts, prefix });
  return { bin: installed.bin, source: 'installed', version: installed.version, prefix };
}

module.exports = {
  PACKAGE_NAME,
  PINNED_VERSION,
  DEFAULT_SPEC,
  claudeCodeSpec,
  managedPrefix,
  managedBinCandidates,
  findManagedClaude,
  findClaudeOnPath,
  findNpm,
  provisionClaudeCode,
  resolveClaudeBinary,
  manualHint,
};
