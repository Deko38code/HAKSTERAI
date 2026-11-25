/* A chat turn starts the core tool set, whatever the approval dial says.
 *
 * Owner, 2026-11-26: "check his response time was almost 20sec this time on
 * dell" → "go". Measured that day on the Dell, same prompt: 6-server core
 * 3.54 s vs all 20 servers 8.81 s — so ~5.3 s of every full-auto turn was MCP
 * startup before the model was asked anything. Full-auto is about approving
 * tool calls, not about paying for the whole toolkit.
 *
 * Pinned here:
 *   1. the scope decision does not mention the approval mode;
 *   2. the core set is still the six tools the lane depends on;
 *   3. the heavy servers are still reachable by name / alias, and "all tools"
 *      is the explicit ask for everything;
 *   4. the lean file is derived from mcp.json — no server definition is edited.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const SRC = fs.readFileSync(path.join(repo, 'server', 'src', 'index.js'), 'utf8');

const scopeBlock = SRC.slice(SRC.indexOf('const msgForScope'), SRC.indexOf('args.push(\'--mcp-config\''));

test('the tool scope is decided by the message, never by the approval mode', () => {
  assert.ok(scopeBlock.length > 0, 'the per-run scope block is present');
  assert.ok(!/wantsAll[\s\S]{0,200}effectiveApprovalMode/.test(scopeBlock),
    'full-auto must not widen the tool set');
  assert.match(scopeBlock, /const wantsAll = \/\\ball tools\\b/, 'only an explicit ask loads everything');
  assert.match(scopeBlock, /const msgForScope/, 'the message is read once and used for scope');
});

test('the core set is unchanged', () => {
  assert.match(SRC, /const MCP_CORE = new Set\(\['filesystem', 'phantom', 'hakster', 'sqlite', 'memory', 'sequential-thinking'\]\)/);
});

test('heavy servers are still reachable by name or alias', () => {
  for (const alias of ['nmap', 'playwright', 'serena', 'hermes', 'kiro', 'codex', 'hivemind']) {
    assert.ok(SRC.includes(`${alias}: /`), `${alias} keeps its alias`);
  }
  assert.match(scopeBlock, /new RegExp\(`\\\\b\$\{name/, 'naming a server outright still earns it a start');
});

test('the lean file is derived, never a copy of the config', () => {
  assert.match(scopeBlock, /const lean = \{ mcpServers: \{\} \}/, 'built from the same mcp.json');
  assert.match(scopeBlock, /hakster-mcp-lean-/, 'written to a temp file, not into .hakster/');
});
