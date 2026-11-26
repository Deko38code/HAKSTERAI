/* server-target.test.mjs — the TUI dials the server this install was pointed at
 *
 * Owner, 2026-11-26, Surface Pro: "its saying fetch failed and only shows input
 * bar". The Windows install had written `server: https://haksterai.com` into
 * ~/.hakster/config.json (`hakster config set server`), and the TUI still used
 * its loopback fallback — http://localhost:3579 — because nothing copied the
 * configured server into the env the bundles read. On the Dell that fallback is
 * right (the server runs there), so the bug only shows on a remote install.
 *
 * This pins the shipped bytes, not a copy of them: the block is sliced out of
 * cli/index.js and cli/tui-entry.mjs and executed with a fake config, exactly
 * the way the two real launch paths run it. If a later edit drops the
 * derivation, this fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.join(CLI, rel), 'utf8');

/** Slice from `startMarker` through `endMarker` (inclusive) out of the file. */
function sliceRange(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a >= 0, `marker not found: ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  assert.ok(b > a, `end not found after ${startMarker}`);
  return src.slice(a, b + endMarker.length);
}

const ENV_TAIL = 'process.env.HAKSTER_URL = `${ws}/ws`;';

/** Close the block's open braces so the slice parses as a statement list. */
function closeBraces(code) {
  let depth = 0;
  for (const ch of code) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
  return code + '\n}'.repeat(Math.max(0, depth));
}

/** Run the shipped derivation block against a fresh fake env. */
function runIndexBlock(server, env = {}) {
  const code = closeBraces(sliceRange(read('index.js'), 'const _CFG_SERVER = String(', ENV_TAIL));
  const fakeEnv = { ...env };
  const fn = new Function('process', '_cfgDefaults', `${code}\nreturn process.env;`);
  return fn({ env: fakeEnv, platform: 'win32' }, { server });
}

function runTuiEntryBlock(server, env = {}) {
  const block = closeBraces(sliceRange(read('tui-entry.mjs'), 'const server = String((cfg && cfg.server)', ENV_TAIL));
  const fakeEnv = { ...env };
  const fn = new Function('process', 'cfg', `${block}\nreturn process.env;`);
  return fn({ env: fakeEnv, platform: 'win32' }, { server });
}

test('index.js derives both URLs from the configured server', () => {
  const env = runIndexBlock('https://haksterai.com');
  assert.equal(env.HAKSTER_API_URL, 'https://haksterai.com');
  assert.equal(env.HAKSTER_URL, 'wss://haksterai.com/ws');
});

test('index.js keeps the exact loopback default the Dell already uses', () => {
  const env = runIndexBlock('http://127.0.0.1:3579');
  assert.equal(env.HAKSTER_API_URL, 'http://127.0.0.1:3579');
  assert.equal(env.HAKSTER_URL, 'ws://127.0.0.1:3579/ws');
});

test('index.js leaves the built-in defaults alone when config has no server', () => {
  const env = runIndexBlock('');
  assert.equal(env.HAKSTER_API_URL, undefined);
  assert.equal(env.HAKSTER_URL, undefined);
});

test('index.js never overrides an explicit env var', () => {
  const env = runIndexBlock('https://haksterai.com', {
    HAKSTER_API_URL: 'http://10.0.0.210:3581',
    HAKSTER_URL: 'ws://10.0.0.210:3581/ws',
  });
  assert.equal(env.HAKSTER_API_URL, 'http://10.0.0.210:3581');
  assert.equal(env.HAKSTER_URL, 'ws://10.0.0.210:3581/ws');
});

test('index.js strips a trailing slash, so one server cannot become two paths', () => {
  const env = runIndexBlock('https://haksterai.com/');
  assert.equal(env.HAKSTER_API_URL, 'https://haksterai.com');
  assert.equal(env.HAKSTER_URL, 'wss://haksterai.com/ws');
});

test('tui-entry derives the same target for a direct bun launch', () => {
  const env = runTuiEntryBlock('https://haksterai.com');
  assert.equal(env.HAKSTER_API_URL, 'https://haksterai.com');
  assert.equal(env.HAKSTER_URL, 'wss://haksterai.com/ws');
});

test('tui-entry matches index.js for a loopback install', () => {
  const a = runIndexBlock('http://127.0.0.1:3579');
  const b = runTuiEntryBlock('http://127.0.0.1:3579');
  assert.equal(b.HAKSTER_API_URL, a.HAKSTER_API_URL);
  assert.equal(b.HAKSTER_URL, a.HAKSTER_URL);
});

test('the API key rides along to the configured origin, and only that origin', () => {
  // _isHaksterApi is what decides whether the CLI attaches HAKSTER_API_KEY, so
  // a remote install does not silently run every /api call anonymous.
  const code = sliceRange(
    read('index.js'),
    'const _NON_HAKSTER_PORTS',
    '} catch {\n    return false;\n  }\n}',
  );
  const env = { HAKSTER_API_KEY: 'k' };
  const fn = new Function('process', '_CFG_SERVER', `${code}\nreturn _isHaksterApi;`);
  const isHaksterApi = fn({ env }, 'https://haksterai.com');
  assert.equal(isHaksterApi('https://haksterai.com/api/agent/run'), true);
  assert.equal(isHaksterApi('http://127.0.0.1:3579/api/health'), true);
  // Never another host, never another local service, never a non-API path.
  assert.equal(isHaksterApi('https://evil.example/api/agent/run'), false);
  assert.equal(isHaksterApi('http://127.0.0.1:11434/api/generate'), false);
  assert.equal(isHaksterApi('https://haksterai.com/plans/'), false);
});
