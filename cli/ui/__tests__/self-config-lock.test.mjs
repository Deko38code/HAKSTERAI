/* The self-config lock — hakster may fix and patch, never break himself.
 *
 * Owner (2026-11-25): "add a guard where hakster can break himself only fix
 * patch but never do what he just did break his own config".
 *
 * What went wrong on 2026-11-25: a speed commit (4952d7f) pinned the default
 * lane to PRIMARY_PROVIDER (the ollama direct lane). On this box that lane
 * runs a tool, gets the result, then answers with empty content and re-issues
 * the identical call until the duplicate-call loop guard stops the run — so
 * every tool task died. claude-cli, ladder tier 1, calls the tool and answers.
 *
 * These tests pin the default lane and the locked config, so no future change
 * can flip either one silently: the suite fails instead, and flipping a lane
 * has to be a deliberate edit to this file (CLAUDE.md §22.4).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

import {
  MODEL_LADDER, PRIMARY_MODEL, PRIMARY_PROVIDER, MODEL_DISPLAY_NAME, attemptsFor,
} from '../../src/models/ladder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(here, '..', 'src', 'App.jsx'), 'utf8');

test('the locked wire config does not move', () => {
  // §22/§35: the name is a label over exactly this config.
  assert.equal(PRIMARY_MODEL, 'deepseek-v4.1-flash:cloud');
  assert.equal(PRIMARY_PROVIDER, 'ollama');
  assert.equal(MODEL_DISPLAY_NAME, 'HAKSTERAI-FLASH');
});

test('the ladder keeps the tool-capable lane first', () => {
  // Tier 1 answers by default, and it is the lane that completes a tool round.
  assert.equal(MODEL_LADDER[0].provider, 'claude-cli');
  assert.equal(MODEL_LADDER[0].model, PRIMARY_MODEL);
  // The pinned relay stays tier 2, so it is a fallback and never the default.
  assert.equal(MODEL_LADDER[1].provider, PRIMARY_PROVIDER);
  assert.equal(MODEL_LADDER[1].model, PRIMARY_MODEL);
  // The paid/unpinned fallbacks stay behind both.
  assert.equal(MODEL_LADDER[2].provider, 'codex-cli');
  assert.equal(MODEL_LADDER[3].provider, '');
});

test('the default attempt resolves to the tool-capable lane', () => {
  const attempts = attemptsFor(PRIMARY_MODEL, '');
  assert.equal(attempts[0].provider, 'claude-cli');
  assert.deepEqual(
    attempts.map((a) => a.provider),
    ['claude-cli', PRIMARY_PROVIDER, 'codex-cli', ''],
  );
  // No model and no provider — the fresh-install case — lands there too.
  assert.equal(attemptsFor('', '').at(0).provider, 'claude-cli');
});

test('the TUI does not pin a default provider', () => {
  // The 2026-11-25 regression was exactly this line. A pin here overrides the
  // ladder on every turn, so the first lane stops being a decision the ladder
  // makes — and a lane that cannot complete a tool round silently becomes the
  // product. Only an explicit env var or a saved /provider pick may pin one.
  const line = appSource.match(/const \[provider, setProvider\] = useState\(\(\) => ([^\n]+)\);/);
  assert.ok(line, 'the provider default line must exist in App.jsx');
  const expr = line[1].trim();
  assert.ok(!/PRIMARY_PROVIDER/.test(expr), `the default provider must not be pinned to PRIMARY_PROVIDER — found: ${expr}`);
  assert.ok(/\|\|\s*''\s*$/.test(expr), `the default provider must fall through to "" (ladder decides) — found: ${expr}`);
});

test('the self-config guard protects the locked files', () => {
  const { guardSelfConfig } = require('../../src/self-config-guard.js');
  const guardOn = process.env.HAKSTER_ALLOW_SELF_CONFIG;
  delete process.env.HAKSTER_ALLOW_SELF_CONFIG;
  try {
    // A write to the ladder, the prefs store, the runtime config or an env
    // file is refused — whatever tool asked for it.
    assert.match(guardSelfConfig('write_file', { path: '/home/ghost/haksterAi/cli/src/models/ladder.js' }) || '', /BLOCKED/);
    assert.match(guardSelfConfig('edit_file', { file: 'cli/src/prefs.js' }, '/home/ghost/haksterAi') || '', /BLOCKED/);
    assert.match(guardSelfConfig('exec_shell', { command: 'sed -i "s/x/y/" cli/src/models/ladder.js' }, '/home/ghost/haksterAi') || '', /BLOCKED/);
    assert.match(guardSelfConfig('exec_shell', { command: 'echo "DEFAULT_MODEL=glm-5.2" >> .env' }, '/home/ghost/haksterAi') || '', /BLOCKED/);
    // Ordinary fixes and patches are untouched.
    assert.equal(guardSelfConfig('write_file', { path: '/home/ghost/haksterAi/cli/ui/src/App.jsx' }), null);
    assert.equal(guardSelfConfig('edit_file', { file: 'src/App.jsx' }, '/home/ghost/haksterAi/cli/ui'), null);
    assert.equal(guardSelfConfig('exec_shell', { command: 'npm test' }, '/home/ghost/haksterAi/cli'), null);
    // Reading the config is allowed; only writing it is refused.
    assert.equal(guardSelfConfig('read_file', { path: '/home/ghost/haksterAi/cli/src/models/ladder.js' }), null);
    assert.equal(guardSelfConfig('exec_shell', { command: 'grep PRIMARY_MODEL cli/src/models/ladder.js' }, '/home/ghost/haksterAi'), null);
    // The owner's explicit override opens the gate.
    process.env.HAKSTER_ALLOW_SELF_CONFIG = '1';
    assert.equal(guardSelfConfig('write_file', { path: '/home/ghost/haksterAi/cli/src/models/ladder.js' }), null);
  } finally {
    if (guardOn === undefined) delete process.env.HAKSTER_ALLOW_SELF_CONFIG;
    else process.env.HAKSTER_ALLOW_SELF_CONFIG = guardOn;
  }
});

test('the guard still protects an install whose folder is not named `cli`', () => {
  // Owner-reported 2026-11-26: "its mising 2 out of 5 startup checklist" on
  // the Surface Pro. The Windows installer puts the app in
  // %APPDATA%\npm\node_modules\hakster-cli, so the `/cli/src/...` suffix never
  // matched and the ladder was writable there — a real hole, reported by the
  // rail as a missing check. Matched by tail now, on both separators.
  const { guardSelfConfig } = require('../../src/self-config-guard.js');
  const guardOn = process.env.HAKSTER_ALLOW_SELF_CONFIG;
  delete process.env.HAKSTER_ALLOW_SELF_CONFIG;
  try {
    assert.match(guardSelfConfig('write_file', { path: '/app/node_modules/hakster-cli/src/models/ladder.js' }) || '', /BLOCKED/);
    assert.match(guardSelfConfig('write_file', { path: 'C:\\Users\\M\\AppData\\Roaming\\npm\\node_modules\\hakster-cli\\src\\models\\ladder.js' }) || '', /BLOCKED/);
    assert.match(guardSelfConfig('edit_file', { file: 'C:\\app\\hakster-cli\\src\\prefs.js' }) || '', /BLOCKED/);
    assert.match(guardSelfConfig('write_file', { path: '/opt/hakster-cli/src/usage-ids.js' }) || '', /BLOCKED/);
    // …and a tail match never widens into a look-alike file.
    assert.equal(guardSelfConfig('write_file', { path: '/tmp/x/evil-ladder.js' }), null);
    assert.equal(guardSelfConfig('write_file', { path: '/srv/app/src/models/ladder2.js' }), null);
  } finally {
    if (guardOn === undefined) delete process.env.HAKSTER_ALLOW_SELF_CONFIG;
    else process.env.HAKSTER_ALLOW_SELF_CONFIG = guardOn;
  }
});

test('the spawned CLI runs this session’s own config, value for value', () => {
  // Owner (2026-11-25): "make it exacly like this cli and my model are set to
  // and he will perform great". The spawned Claude Code CLI gets its env from
  // claudeCliEnv() in the server — one place, both spawn sites. Every value
  // below was read from the owner's running session, so a drift here is a
  // different CLI than the one he is comparing against.
  const src = fs.readFileSync(
    path.join(here, '..', '..', '..', 'server', 'src', 'providers.js'),
    'utf8',
  );
  const block = src.slice(src.indexOf('function claudeCliEnv()'));
  const body = block.slice(0, block.indexOf('\n}'));
  // Values stated as literals in the env block…
  const pinned = {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1048576',
    // The compact window is the owner's session value (200000), not the max
    // context figure — see §39 and cli/ui/__tests__/auto-compact.test.mjs.
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_FEEDBACK_COMMAND: '1',
  };
  for (const [k, v] of Object.entries(pinned)) {
    const m = body.match(new RegExp(`${k}:\\s*'([^']*)'`));
    assert.ok(m, `${k} is missing from claudeCliEnv()`);
    assert.equal(m[1], v, `${k} drifted from this session's config`);
  }
  // …and the ones routed through the two file-level constants, so a change to
  // either constant is caught here too.
  const viaConst = {
    ANTHROPIC_BASE_URL: ['CLAUDE_CLI_BASE_URL', 'http://127.0.0.1:11434'],
    ANTHROPIC_DEFAULT_SONNET_MODEL: ['CLAUDE_CLI_MODEL', 'deepseek-v4.1-flash:cloud'],
    ANTHROPIC_DEFAULT_OPUS_MODEL: ['CLAUDE_CLI_MODEL', 'deepseek-v4.1-flash:cloud'],
    ANTHROPIC_DEFAULT_HAIKU_MODEL: ['CLAUDE_CLI_MODEL', 'deepseek-v4.1-flash:cloud'],
    CLAUDE_CODE_SUBAGENT_MODEL: ['CLAUDE_CLI_MODEL', 'deepseek-v4.1-flash:cloud'],
  };
  for (const [k, [constName, value]] of Object.entries(viaConst)) {
    assert.match(body, new RegExp(`${k}:\\s*${constName}\\b`), `${k} no longer reads ${constName}`);
    const cm = src.match(new RegExp(`const ${constName} = '([^']*)'`));
    assert.ok(cm, `${constName} is not a literal in providers.js`);
    assert.equal(cm[1], value, `${constName} drifted from this session's config`);
  }
});
