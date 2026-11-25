#!/usr/bin/env node
/**
 * Real verification for the email MCP server.
 *
 *   node server/__smoke__/email-mcp-probe.mjs [searchTerm]
 *
 * Spawns server/src/agent/email-mcp-server.cjs, runs the actual MCP handshake
 * (initialize → tools/list → tools/call) and exercises the live local Thunderbird
 * store. Exits 0 only if every check passes; prints timings so a regression in speed
 * is visible. Never prints message bodies or credentials.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.resolve(here, '../src/agent/email-mcp-server.cjs');
const searchTerm = process.argv[2] || 'invoice';

const child = spawn(process.execPath, [serverFile], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
let nextId = 1;
const pending = new Map();
const stderr = [];

child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter.resolve(message); }
  }
});

function rpc(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after 60s`)); }, 60000);
    pending.set(id, { resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
    child.stdin.write(JSON.stringify(payload) + '\n');
  });
}

async function tool(name, args) {
  const started = Date.now();
  const response = await rpc('tools/call', { name, arguments: args || {} });
  const ms = Date.now() - started;
  const text = response?.result?.content?.[0]?.text ?? '';
  if (response?.error) throw new Error(`${name}: ${response.error.message}`);
  if (response?.result?.isError) throw new Error(`${name}: ${text}`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${name}: non-JSON result`); }
  return { data: parsed, ms };
}

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'email-probe', version: '1' } });
  check('initialize handshake', init?.result?.serverInfo?.name === 'hakster-email', init?.result?.serverInfo?.name);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc('tools/list', {});
  const names = (list?.result?.tools || []).map((t) => t.name);
  const required = ['email_status', 'email_folders', 'email_recent', 'email_search', 'email_read', 'email_send'];
  check('tools/list exposes the full surface', required.every((n) => names.includes(n)), names.join(', '));

  const status = await tool('email_status');
  check('email_status reports the local store', status.data.thunderbird?.available === true,
    `${status.data.thunderbird?.folders} folders / ${status.data.thunderbird?.sizeMb} MB`);
  console.log(`  gmail: ${status.data.gmail?.available ? `connected (${status.data.gmail.account})` : `not connected — ${status.data.gmail?.reason}`}`);

  const folders = await tool('email_folders');
  check('email_folders lists folders', (folders.data.folders || []).length > 0, `${folders.data.folders.length} folders in ${folders.ms} ms`);

  const recent = await tool('email_recent', { folder: 'imap.gmail.com/INBOX', limit: 3 });
  const messages = recent.data.messages || [];
  check('email_recent returns messages', messages.length > 0, `${messages.length} in ${recent.ms} ms`);
  const withHeaders = messages.filter((m) => m.subject || m.from).length;
  check('email_recent parses subject/from', withHeaders > 0, `${withHeaders}/${messages.length} with headers`);

  if (messages.length) {
    const read = await tool('email_read', { ref: messages[0].ref });
    const body = String(read.data.body || '');
    check('email_read returns a body', body.length > 0, `${body.length} chars in ${read.ms} ms, ${read.data.attachments?.length || 0} attachment(s)`);
    check('email_read strips the mbox envelope', read.data.subject === messages[0].subject, read.data.subject?.slice(0, 60) || '(no subject)');
  }

  const search = await tool('email_search', { query: searchTerm, maxScanMb: 32, limit: 5 });
  check(`email_search "${searchTerm}" completes`, Array.isArray(search.data.matches), `${search.data.matches?.length || 0} match(es) in ${search.ms} ms`);

  if (search.data.matches?.length) {
    const hit = await tool('email_read', { ref: search.data.matches[0].ref });
    check('email_read on a search hit', String(hit.data.body || '').length > 0, hit.data.subject?.slice(0, 60) || '(no subject)');
  }

  // A bad ref must fail cleanly rather than crash the server.
  const bad = await rpc('tools/call', { name: 'email_read', arguments: { ref: 'nonsense' } });
  check('invalid ref fails cleanly', bad?.result?.isError === true || Boolean(bad?.error), String(bad?.result?.content?.[0]?.text || '').slice(0, 70));

  const alive = await rpc('ping', {});
  check('server still healthy after errors', Boolean(alive?.result), 'ping answered');
} catch (err) {
  check('probe run', false, err.message);
} finally {
  child.stdin.end();
  setTimeout(() => { try { child.kill(); } catch {} }, 500);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? '✗ FAIL' : '✓ PASS'} — ${results.length - failed.length}/${results.length} checks`);
if (stderr.length && failed.length) console.log(`stderr:\n${stderr.join('').slice(-1500)}`);
process.exit(failed.length ? 1 : 0);
