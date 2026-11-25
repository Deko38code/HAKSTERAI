// Pins the claude-cli lane's prompt steering scope (CLAUDE.md §38/§39/§45).
//
// Why: the spawned `claude` loads <cwd-walk>/CLAUDE.md itself, and
// /home/ghost/haksterAi/CLAUDE.md is byte-identical to
// /home/ghost/haksterAi/AGENTS.md (sha256 0c7af095…). Injecting the walk-up
// AGENTS.md chain as well sent the same ~48.9KB twice on every turn, so the lane
// now appends only the master /home/ghost/AGENTS.md head. This probe fails if a
// later edit puts the duplicate back or drops the guardrail block.
//
// Run: node server/__smoke__/prompt-steering-probe.mjs
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';

const require = createRequire(import.meta.url);
const providers = require('../src/providers.js');
const WORK = '/home/ghost/haksterAi/server/data/workspaces/default';

let failed = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

// 1. The two files really are the same bytes, or the whole premise is wrong.
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const agents = sha('/home/ghost/haksterAi/AGENTS.md');
const claudeMd = sha('/home/ghost/haksterAi/CLAUDE.md');
check(agents === claudeMd, 'project CLAUDE.md is byte-identical to project AGENTS.md', `${agents.slice(0, 12)}…`);

// 2. Master mode is smaller than walk-up mode by roughly the duplicate.
const all = providers.buildAgentSystemPrompt(WORK, [], { lowToken: false });
const master = providers.buildAgentSystemPrompt(WORK, [], { lowToken: false, steering: 'master' });
const saved = all.length - master.length;
check(master.length < all.length, 'master mode sends fewer chars', `${all.length} → ${master.length} (−${saved}, ${Math.round((1 - master.length / all.length) * 100)}%)`);
check(saved >= 30000, 'the saved chars really are the duplicate AGENTS.md block', `−${saved} chars`);
check(master.length < 70000, 'lane prompt stays under 70K chars', `${master.length}`);

// 3. The rules that are NOT loaded natively must still be in the prompt.
check(master.includes('RULE #0'), 'master mode keeps RULE #0 (config/brain files read-only)');
check(master.includes('CineVault Agent Roster'), 'master mode keeps the CineVault roster');
check(master.includes('IPTV authorization'), 'master mode keeps the IPTV authorization rule');
check(master.includes('master AGENTS.md'), 'block is labelled as the master rulebook');
check(!master.includes('═══ PROJECT STEERING (AGENTS.md) ═══'), 'no walk-up steering block in master mode');

// 4. Default mode is untouched — every other caller keeps full steering.
check(all.includes('═══ PROJECT STEERING (AGENTS.md) ═══'), 'default mode still injects the walk-up chain');
check(providers.buildAgentSystemPrompt(WORK, [], { lowToken: false, steering: 'nonsense' }).length === all.length, 'unknown steering option falls back to default');

// 5. Byte stability: two builds of the same mode must be identical, or the
// provider's cached prefix is discarded every turn (2026-11-26 fix).
const a = providers.buildAgentSystemPrompt(WORK, [], { lowToken: false, steering: 'master' });
const b = providers.buildAgentSystemPrompt(WORK, [], { lowToken: false, steering: 'master' });
check(a === b, 'prompt is byte-stable across rebuilds');

console.log(failed === 0 ? '\nPASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
