// §46 probe — a CLI lane must be runnable, must only be sent a model it serves,
// and must never be benched by our own wiring bug.
//
// Runs entirely in its own process with a stubbed child_process.spawn and a
// throwaway 401 server. It never contacts the live :3579 server, never touches
// config, and never restarts anything.
//
//   node server/__smoke__/codex-lane-probe.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const cp = require('child_process');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Stub every `codex` spawn: record argv, answer whatever the test wants ──
let spawnMode = 'ok';           // 'ok' | 'auth401'
let lastArgs = null;
cp.spawn = function stubSpawn(cmd, args) {
  lastArgs = { cmd, args: [...args] };
  const child = new EventEmitter();
  child.stdin = { on() {}, write() {}, end() {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (spawnMode === 'auth401') {
      child.stderr.emit('data', Buffer.from('401 Unauthorized: invalid credentials'));
      child.emit('close', 1);
      return;
    }
    const evt = { type: 'item.completed', item: { type: 'agent_message', text: 'stub answer' } };
    child.stdout.emit('data', Buffer.from(JSON.stringify(evt) + '\n'));
    child.emit('close', 0);
  });
  return child;
};

const providers = require('../src/providers.js');
const { codexCliComplete, isCodexNativeModel, isCliLane, PROVIDERS, WATERFALL_ORDER, markProviderRateLimited, isProviderAuthDead, chat, isRefusal } = providers;

// ── 1. §46.2 — only a Codex-native id reaches `-m` ─────────────────────────
check('locked wire model is NOT a codex model', isCodexNativeModel('deepseek-v4.1-flash:cloud') === false);
check('codex default (gpt-6-luna) IS a codex model', isCodexNativeModel('gpt-6-luna') === true);
check('claude alias is NOT a codex model', isCodexNativeModel('claude-sonnet-5') === false);
check('ollama cloud tag is NOT a codex model', isCodexNativeModel('glm-5.2:cloud') === false);

await codexCliComplete({ model: 'deepseek-v4.1-flash:cloud', messages: [{ role: 'user', content: 'hi' }], system: 'sys' });
check('foreign model ⇒ no -m in codex argv', !lastArgs.args.includes('-m'), `argv: ${lastArgs.args.join(' ')}`);
check('foreign model still runs `codex exec`', lastArgs.cmd === 'codex' && lastArgs.args[0] === 'exec');

await codexCliComplete({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }], system: 'sys' });
const mi = lastArgs.args.indexOf('-m');
check('native model ⇒ -m forwarded', mi >= 0 && lastArgs.args[mi + 1] === 'gpt-6-luna', `argv: ${lastArgs.args.join(' ')}`);

// ── 2. §46.3 — a CLI lane is never benched by an auth-looking error ────────
check('isCliLane(codex-cli)', isCliLane('codex-cli') === true);
check('isCliLane(claude-cli)', isCliLane('claude-cli') === true);
check('isCliLane(deepseek) is false', isCliLane('deepseek') === false);

// A real HTTP lane that answers 401 must STILL be marked dead — the gate
// narrows the rule, it does not remove it.
const srv = http.createServer((req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port401 = srv.address().port;
PROVIDERS['probe-http-lane'] = { name: 'probe', baseURL: `http://127.0.0.1:${port401}`, apiKey: 'x', defaultModel: 'probe-model', type: 'openai-compat' };
try { await chat({ provider: 'probe-http-lane', messages: [{ role: 'user', content: 'hi' }] }); } catch { /* expected */ }
check('a real HTTP 401 lane IS marked auth-dead', isProviderAuthDead('probe-http-lane') === true);
srv.close();

// A CLI lane that emits an auth-looking failure must stay enabled.
spawnMode = 'auth401';
for (const name of [...WATERFALL_ORDER, 'ollama', 'probe-http-lane']) markProviderRateLimited(name, 60000);
const _ollamaBase = PROVIDERS.ollama.baseURL;
PROVIDERS.ollama.baseURL = 'http://127.0.0.1:1'; // make the fallback retry fail instantly, offline
let cliErr = null;
try { await chat({ provider: 'codex-cli', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { cliErr = e; }
PROVIDERS.ollama.baseURL = _ollamaBase;
check('codex lane surfaced the 401-shaped error (so the gate had something to catch)',
  Boolean(cliErr) && /401|unauthoriz|invalid|authenticat/i.test(cliErr.message), cliErr && cliErr.message.slice(0, 80));
check('an auth-looking error does NOT bench the codex lane', isProviderAuthDead('codex-cli') === false);

// ── 3. §46.1 — the lane has a dispatch, not just a ladder entry ────────────
const fs = require('fs');
const indexSrc = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
check('index.js carries a codex-cli dispatch block', /cfg\.type === 'codex-cli'/.test(indexSrc));
check('rotation never lands on a CLI lane', /PROVIDERS\[_n\]\.type === 'claude-cli' \|\| PROVIDERS\[_n\]\.type === 'codex-cli'\) continue;/.test(indexSrc));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
