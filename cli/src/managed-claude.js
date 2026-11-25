/* managed-claude.js — `hakster claude`: the Claude Code CLI on our plan.
 *
 * Owner, 2026-11-25: "we need to edit the claude cli area with oauth and add
 * our to replace anthropic sign in with ours but still use mcp etc tools".
 *
 * What this does, and what it deliberately does not do:
 *
 *   - It runs the customer's own `claude` binary with OUR base URL and THEIR
 *     HaksterAI key, so the CLI never asks Anthropic to sign in and never
 *     needs an Anthropic account. The server's /anthropic/v1/messages relay
 *     answers with the locked wire model on our Ollama relay (§22, §28.5).
 *   - It points `claude` at an isolated config dir (~/.hakster-claude), so the
 *     machine's real Claude Code login (~/.claude, ~/.claude.json) is never
 *     read for credentials, never refreshed and never overwritten. The owner's
 *     own `claude` keeps working exactly as before ("dont break my reg claude
 *     cli").
 *   - It carries the user's own MCP servers across by copying the read-only
 *     `mcpServers` map out of ~/.claude.json into the isolated dir and passing
 *     --mcp-config, so MCP tools keep working even though the config dir is
 *     separate. Nothing is written back to their real config.
 *   - The key is handed to the child through the environment only. It is never
 *     printed, never put in argv and never written into settings.json (§9, §23).
 *
 * Signing in is `hakster login` (magic link + device approval). This module
 * only consumes the key that flow already stored in ~/.hakster/config.json.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// The locked wire model (§22, §35) — a label for the user, the wire id to the relay.
const WIRE_MODEL = 'deepseek-v4.1-flash:cloud';
const DISPLAY_MODEL = 'HAKSTERAI-FLASH';

function loadCliConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.hakster', 'config.json'), 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

/** Resolve `claude` from PATH without executing anything. */
function findClaude() {
  const names = process.platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];
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

/**
 * Copy the user's own MCP server definitions into the isolated config dir and
 * return a path to pass as --mcp-config. Read-only in every source location:
 * ~/.claude.json and ~/.claude/*.json are never modified.
 *
 * If the user already passed their own --mcp-config, that wins and we do nothing.
 */
function carryMcpServers(args, cfgDir) {
  if (args.some((a) => a === '--mcp-config' || a.startsWith('--mcp-config='))) return null;
  const candidates = [
    path.join(os.homedir(), '.claude.json'),
    path.join(os.homedir(), '.claude', '.mcp.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  for (const file of candidates) {
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const servers = cfg && cfg.mcpServers;
    if (!servers || typeof servers !== 'object' || !Object.keys(servers).length) continue;
    const out = path.join(cfgDir, 'mcp.json');
    try {
      fs.writeFileSync(out, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
      try { fs.chmodSync(out, 0o600); } catch { /* best effort */ }
      return { path: out, count: Object.keys(servers).length };
    } catch {
      return null;
    }
  }
  return null;
}

async function verifyAccount(origin, key) {
  try {
    const res = await fetch(`${origin}/api/auth/me`, {
      headers: { 'x-api-key': key, 'x-hakster-client': 'cli' },
      cache: 'no-store',
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.user) return null;
    return body;
  } catch {
    return null;
  }
}

/** Run `claude <args>` on this account's plan. Resolves to a process exit code. */
async function runManagedClaude(args) {
  const cfg = loadCliConfig();
  const key = String(process.env.HAKSTER_API_KEY || cfg.apiKey || '').trim();
  const origin = String(process.env.HAKSTER_SERVER || cfg.server || 'https://haksterai.com').replace(/\/+$/, '');

  if (!key) {
    console.error('Not signed in. Run:  hakster login');
    return 1;
  }

  const me = await verifyAccount(origin, key);
  if (!me) {
    console.error(`Could not verify your account at ${origin}.`);
    console.error('Run:  hakster login');
    return 1;
  }

  // The server is the authority on entitlement (§28.5); this is only a clear
  // message before we hand over the terminal.
  const cli = me.cli || {};
  if (cli.included === false) {
    console.error(cli.reason || 'Your plan does not include the CLI.');
    console.error('Plans from $20/month include it: https://haksterai.com/plans/');
    return 1;
  }

  const bin = findClaude();
  if (!bin) {
    console.error('Claude Code (claude) is not installed on this machine.');
    console.error('Use `hakster` for our own terminal agent, or install Claude Code and re-run `hakster claude`.');
    return 1;
  }

  // Isolated config dir: no Anthropic login is read, refreshed or written here,
  // and the machine's real ~/.claude is left untouched.
  const cfgDir = path.join(os.homedir(), '.hakster-claude');
  try {
    fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(cfgDir, 0o700);
  } catch { /* a read-only home must not stop the run; the env still carries the route */ }

  const mcp = carryMcpServers(args, cfgDir);

  const finalArgs = args.slice();
  if (!finalArgs.some((a) => a === '--model' || a.startsWith('--model='))) {
    finalArgs.push('--model', WIRE_MODEL);
  }
  if (mcp) finalArgs.push('--mcp-config', mcp.path);

  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: cfgDir,
    // Ours, not Anthropic's: the account key is the bearer token and the base
    // URL is our own relay. No OAuth, no Anthropic account.
    ANTHROPIC_BASE_URL: `${origin}/anthropic`,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_DEFAULT_SONNET_MODEL: WIRE_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: WIRE_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: WIRE_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: WIRE_MODEL,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1048576',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
  };
  // An inherited OAuth token outranks both the relay token and the config dir,
  // which is exactly the "OAuth session expired" failure measured on 2026-11-25.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;

  console.log(`▸ ${DISPLAY_MODEL} · ${origin}`);
  console.log(`▸ Signed in as ${me.user.email || me.user.username || 'your account'} — no Anthropic sign-in needed.`);
  if (mcp) console.log(`▸ ${mcp.count} MCP server(s) carried over from your own config.`);

  return new Promise((resolve) => {
    let settled = false;
    const done = (code) => { if (!settled) { settled = true; resolve(code); } };
    let child;
    try {
      child = spawn(bin, finalArgs, { stdio: 'inherit', env });
    } catch (e) {
      console.error('Could not start claude:', e.message);
      return done(1);
    }
    child.on('error', (e) => { console.error('Could not start claude:', e.message); done(1); });
    child.on('exit', (code, signal) => done(signal ? 1 : (code == null ? 0 : code)));
  });
}

module.exports = { runManagedClaude, WIRE_MODEL, DISPLAY_MODEL, carryMcpServers, findClaude };
