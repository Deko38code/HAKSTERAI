#!/usr/bin/env node
/* Tool-calling canary — the behavioural half of the self-config guard.
 *
 * Owner (2026-11-25): "add a guard where hakster can break himself only fix
 * patch but never do what he just did break his own config".
 *
 * The lock test (ui/__tests__/self-config-lock.test.mjs) pins the config and
 * the default lane. This checks the thing that actually broke: that a tool
 * round COMPLETES — a tool is called, and an answer comes back after it.
 *
 *   node scripts/selfcheck-toolcalling.mjs           # static + relay checks
 *   node scripts/selfcheck-toolcalling.mjs --live    # + one real run on the
 *                                                    #   server's default lane
 *
 * Exit 0 = every check passed. Exit 1 = a check failed; the change must not
 * be called done (CLAUDE.md §13). Exit 2 = a check could not run (relay or
 * server unreachable) — reported as SKIPPED, never as a pass.
 *
 * Never prints a key: the owner key is read in-process from ~/.hakster/
 * config.json and only ever put in a request header (§23).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RELAY = 'http://127.0.0.1:11434';
const SERVER = process.env.HAKSTER_SERVER || 'http://127.0.0.1:3579';
const MODEL = 'deepseek-v4.1-flash:cloud';
const TOOL_SPEC = [{
  type: 'function',
  function: {
    name: 'list_dir',
    description: 'List a directory',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
}];

const results = [];
const record = (name, state, detail = '') => {
  results.push({ name, state, detail });
  console.log(`${state.padEnd(5)} ${name}${detail ? ' — ' + detail : ''}`);
};

// ── 1. Ladder: the tool-capable lane answers by default ────────────────────
try {
  const mod = await import('../src/models/ladder.js');
  const first = mod.attemptsFor(mod.PRIMARY_MODEL, '')[0];
  if (first.provider !== 'claude-cli') {
    record('default lane', 'FAIL', `${first.provider} answers first; claude-cli must (it is the lane that completes a tool round)`);
  } else {
    record('default lane', 'PASS', 'claude-cli');
  }
} catch (e) {
  record('default lane', 'SKIP', `ladder unreadable: ${e.message}`);
}

// ── 2. Relay: the pinned model still returns a tool call ───────────────────
let relayOk = false;
try {
  const res = await fetch(`${RELAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Use the list_dir tool on /tmp. Call the tool, do not answer in prose.' }],
      tools: TOOL_SPEC,
      tool_choice: 'auto',
      stream: false,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json();
  const call = data?.choices?.[0]?.message?.tool_calls?.[0];
  if (call && call.function?.name === 'list_dir') {
    relayOk = true;
    record('relay tool call', 'PASS', 'list_dir returned');
  } else {
    record('relay tool call', 'FAIL', `no tool call in the reply (finish: ${data?.choices?.[0]?.finish_reason || 'unknown'})`);
  }
} catch (e) {
  record('relay tool call', 'SKIP', `relay unreachable: ${e.message}`);
}

// ── 3. Live: one real tool round on the server's default lane ──────────────
if (!process.argv.includes('--live')) {
  record('live tool round', 'SKIP', 'not requested (pass --live)');
} else if (!relayOk) {
  record('live tool round', 'SKIP', 'skipped because the relay check did not pass');
} else {
  try {
    const cfgPath = path.join(os.homedir(), '.hakster', 'config.json');
    const key = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).apiKey;
    const res = await fetch(`${SERVER}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Call the list_dir tool on /tmp and answer with the number of entries you saw. One tool call, then the answer.' }],
        // The same lane the CLI sends by default (ladder tier 1) — not the
        // server's own waterfall, which is a different lane with different
        // behaviour.
        provider: 'claude-cli',
        approvalMode: 'auto-edit',
        maxTurns: 3,
        stream: true,
        runId: `selfcheck-${Date.now()}`,
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`server replied ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let sawTool = false;
    let sawText = '';
    let loop = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.type === 'tool_call_start') sawTool = true;
        if (evt.type === 'delta' && evt.content) sawText += evt.content;
        if (evt.type === 'loop_detected') loop = evt.reason || 'loop';
      }
    }
    if (loop) record('live tool round', 'FAIL', `the run hit the loop guard (${loop}) instead of answering in prose`);
    else if (!sawTool) record('live tool round', 'FAIL', 'no tool was called');
    else if (!sawText.trim()) record('live tool round', 'FAIL', 'a tool ran but the model never answered — the 2026-11-25 break');
    else record('live tool round', 'PASS', `${sawTool ? 'tool called, ' : ''}answer returned (${sawText.trim().length} chars)`);
  } catch (e) {
    record('live tool round', 'SKIP', `server unreachable: ${e.message}`);
  }
}

const failed = results.filter((r) => r.state === 'FAIL');
const skipped = results.filter((r) => r.state === 'SKIP');
console.log('');
if (failed.length) {
  console.log(`✗ ${failed.length} check(s) FAILED — do not call this change done.`);
  process.exit(1);
}
if (skipped.length) {
  console.log(`○ ${skipped.length} check(s) skipped — nothing failed, but nothing was proven either.`);
  process.exit(2);
}
console.log('✓ tool calling verified.');
process.exit(0);
