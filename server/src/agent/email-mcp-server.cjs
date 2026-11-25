#!/usr/bin/env node
'use strict';
/**
 * HaksterAI email MCP server (stdio, JSON-RPC 2.0).
 *
 * Three sources behind one tool surface, so the agent can read mail that is actually
 * on this box instead of assuming a credential exists:
 *
 *   1. thunderbird — the local Thunderbird profile's mbox store (read-only). Works with
 *      no credentials at all; ~8 GB of Gmail is already synced there.
 *   2. gmail — the project's existing Gmail OAuth connection (gmail.readonly + gmail.send),
 *      token at ~/.hakster/gmail-monitor/connection-<sha256(userId)>.json, AES-256-GCM with
 *      an HMAC key derived from GOOGLE_CLIENT_SECRET. Never printed.
 *   3. imap — accounts held in server/src/mail-store.js (also AES-256-GCM, 0600).
 *
 * Secrets are read in-process only (CLAUDE.md §23.3). Nothing here logs a token, a
 * password or a full message body. Sending is a tool call the operator/agent makes
 * explicitly; nothing sends on its own.
 *
 * Verification: server/__smoke__/email-mcp-probe.mjs spawns this file, does the real
 * initialize + tools/list handshake and calls a few tools against the live store.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.HOME || '/home/ghost';
const SERVER_ROOT = path.resolve(__dirname, '../..');       // /home/ghost/haksterAi/server
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');          // /home/ghost/haksterAi

// Deps live in server/node_modules; resolve them explicitly so this file runs from any cwd.
function loadDep(name) {
  try { return require(path.join(SERVER_ROOT, 'node_modules', name)); } catch (_) { /* fall through */ }
  try { return require(name); } catch (_) { return null; }
}
const mailparser = loadDep('mailparser');
const nodemailer = loadDep('nodemailer');
const { ImapFlow } = loadDep('imapflow') || {};

const MAX_BODY_CHARS = 20000;
const DEFAULT_TAIL_MB = 32;

// ── env (in-process only) ───────────────────────────────────────────────────
function readEnvFile(file) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return out; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

let envCache = null;
function env() {
  if (envCache) return envCache;
  envCache = { ...readEnvFile(path.join(SERVER_ROOT, '.env')), ...readEnvFile(path.join(REPO_ROOT, '.env')) };
  for (const [k, v] of Object.entries(envCache)) if (!process.env[k]) process.env[k] = v;
  return envCache;
}

// ── small helpers ──────────────────────────────────────────────────────────
function clamp(n, min, max, fallback) {
  const v = Number.parseInt(String(n ?? ''), 10);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
function mb(bytes) { return Math.round((bytes / (1024 * 1024)) * 10) / 10; }
function firstLine(value, max = 300) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ── 1. Thunderbird local store (read-only) ─────────────────────────────────
function profiles() {
  const base = path.join(HOME, '.thunderbird');
  let entries = [];
  try { entries = fs.readdirSync(base); } catch (_) { return []; }
  const found = [];
  for (const name of entries) {
    const dir = path.join(base, name);
    try {
      if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'prefs.js'))) found.push(dir);
    } catch (_) { /* skip */ }
  }
  // Default profile first, when profiles.ini names one.
  try {
    const ini = fs.readFileSync(path.join(base, 'profiles.ini'), 'utf8');
    const def = (ini.match(/Default=([^\r\n]+)/) || [])[1];
    if (def) found.sort((a, b) => (path.basename(b) === def.trim() ? 1 : 0) - (path.basename(a) === def.trim() ? 1 : 0));
  } catch (_) { /* fine */ }
  return found;
}

const SKIP_FILE = /\.(msf|dat|sqlite|json|lz4|bin|asc|ini|bak|txt)$/i;

function walkMbox(dir, prefix, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.sbd')) walkMbox(full, prefix ? `${prefix}/${entry.name.slice(0, -4)}` : entry.name.slice(0, -4), out);
      continue;
    }
    if (SKIP_FILE.test(entry.name) || entry.name.startsWith('.')) continue;
    if (entry.name === 'msgFilterRules.dat') continue;
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (!st.isFile()) continue;
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    out.push({ key, file: full, size: st.size, mtime: st.mtime.toISOString() });
  }
  return out;
}

function thunderbirdFolders() {
  const list = [];
  for (const profile of profiles()) {
    for (const container of ['ImapMail', 'Mail']) {
      const dir = path.join(profile, container);
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.endsWith('.sbd')) continue;
        walkMbox(path.join(dir, entry.name), `${container === 'Mail' ? 'Local' : entry.name}`, list);
      }
    }
  }
  return list;
}

function resolveThunderbirdFolder(folder) {
  const folders = thunderbirdFolders();
  if (!folder) {
    const inbox = folders.find((f) => /(^|\/)INBOX$/.test(f.key)) || folders.find((f) => f.size > 0);
    return inbox || null;
  }
  const wanted = String(folder).toLowerCase();
  return folders.find((f) => f.key.toLowerCase() === wanted)
    || folders.find((f) => f.key.toLowerCase().endsWith('/' + wanted))
    || folders.find((f) => path.basename(f.key).toLowerCase() === wanted)
    || null;
}

/**
 * True when `text` at `i` starts a real mbox message.
 * Thunderbird writes CRLF line endings, so the character before "From " is "\r" — checking
 * only for "\n" silently finds nothing (measured: 123 real boundaries in a 4 MB tail).
 * A real separator also has header evidence within ~1.2 KB; an escaped body line is ">From ".
 */
function isMessageStart(text, i) {
  if (i !== 0) {
    const prev = text[i - 1];
    if (prev !== '\n' && prev !== '\r') return false;
  }
  if (text.slice(i, i + 5) !== 'From ') return false;
  const nl = text.indexOf('\n', i);
  if (nl === -1) return false;
  const envelope = text.slice(i, nl);
  if (envelope.length > 400 || !/\d/.test(envelope)) return false;
  const ahead = text.slice(nl + 1, nl + 1200);
  return /(X-Mozilla-Status|Delivered-To|Return-Path|Received|From:|Subject|Message-ID|Date)[:2]/i.test(ahead);
}

function messageStarts(text) {
  const starts = [];
  let i = 0;
  while ((i = text.indexOf('From ', i)) !== -1) {
    if (isMessageStart(text, i)) starts.push(i);
    i += 5;
  }
  return starts;
}

function readChunk(fd, start, length) {
  const buf = Buffer.allocUnsafe(Math.max(0, length));
  const read = fs.readSync(fd, buf, 0, buf.length, start);
  return buf.subarray(0, read).toString('utf8');
}

/**
 * Walk an mbox backwards in overlapping windows, newest message first.
 * `pick(raw, meta)` returns a value to keep, or null to skip.
 *
 * Windows overlap by 2 MB so a message straddling a window edge is still seen whole in the
 * earlier window; `seen` dedupes by absolute byte offset. Offsets are exact (byte-measured),
 * which is what makes the `tb:<folder>:<offset>` refs readable later.
 */
function scanBackwards(file, { maxBytes = 32 * 1024 * 1024, maxParse = 4000, pick }) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (err) { throw new Error(`cannot open ${file}: ${err.code}`); }
  try {
    const total = fs.fstatSync(fd).size;
    const windowSize = 4 * 1024 * 1024;
    const overlap = 2 * 1024 * 1024;
    const seen = new Set();
    const out = [];
    let scanned = 0;
    let parsed = 0;
    let end = total;
    while (end > 0 && scanned < maxBytes && parsed < maxParse) {
      const start = Math.max(0, end - windowSize);
      const text = readChunk(fd, start, end - start);
      const starts = messageStarts(text);
      const absStarts = starts.map((s) => start + Buffer.byteLength(text.slice(0, s), 'utf8'));
      for (let n = absStarts.length - 1; n >= 0 && parsed < maxParse; n -= 1) {
        const sOff = absStarts[n];
        if (seen.has(sOff)) continue;
        // The last start in a window that does not reach EOF may be cut off — skip it; the
        // overlapping earlier window will present it whole.
        if (n === absStarts.length - 1 && end < total) continue;
        seen.add(sOff);
        const sliceEnd = n + 1 < starts.length ? starts[n + 1] : text.length;
        parsed += 1;
        const hit = pick(text.slice(starts[n], sliceEnd), { offset: sOff });
        if (hit !== null && hit !== undefined) out.push(hit);
      }
      scanned += end - start;
      if (start === 0) break;
      end = start + overlap;
    }
    return out;
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

/**
 * Parse the header block properly: find the blank line that ends the headers, then unfold
 * continuation lines. A fixed 4 KB slice silently missed Subject/From on real Gmail mail —
 * DKIM + ARC + Received chains regularly push the first 4 KB past every field we want.
 */
function headerMap(raw) {
  const scan = String(raw).slice(0, 262144);
  const idx = scan.search(/\r?\n\r?\n/);
  const block = idx === -1 ? scan.slice(0, 20000) : scan.slice(0, idx);
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  const map = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9-]+):[ \t]?(.*)$/.exec(line);
    if (m && !map[m[1].toLowerCase()]) map[m[1].toLowerCase()] = m[2].trim();
  }
  return map;
}

/** Decode RFC 2047 encoded words (=?UTF-8?B?…?=) so subjects and names read normally. */
function decodeMimeWords(value) {
  return String(value || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, enc, text) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString('utf8');
      const bytes = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
      return Buffer.from(bytes, 'binary').toString('utf8');
    } catch (_) { return whole; }
  });
}

function summarizeMessage(raw, meta) {
  const headers = headerMap(raw);
  const subject = decodeMimeWords(headers.subject || '');
  const from = decodeMimeWords(headers.from || '');
  const to = decodeMimeWords(headers.to || '');
  const date = headers.date || '';
  const messageId = (headers['message-id'] || '').replace(/^<?([^>\s]+)>?$/, '$1');
  return {
    ref: meta.ref,
    folder: meta.folder,
    subject: firstLine(subject, 200),
    from: firstLine(from, 200),
    to: firstLine(to, 200),
    date: firstLine(date, 80),
    messageId,
    sizeBytes: Buffer.byteLength(raw, 'utf8'),
  };
}

async function parseRaw(raw) {
  // Drop the mbox "From " envelope line — it is not a header and confuses a strict parser.
  const cleaned = String(raw || '').replace(/^From [^\r\n]*\r?\n/, '');
  if (mailparser?.simpleParser) {
    try { return await mailparser.simpleParser(cleaned); } catch (_) { /* fall back below */ }
  }
  raw = cleaned;
  return {
    subject: (raw.match(/^Subject:\s*(.*)$/im) || [])[1] || '',
    text: raw.slice(0, MAX_BODY_CHARS),
    attachments: [],
  };
}

function messageText(parsed) {
  const text = String(parsed.text || '').trim();
  if (text) return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) + '\n…[truncated]' : text;
  const html = String(parsed.html || '');
  if (!html) return '';
  const stripped = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return stripped.length > MAX_BODY_CHARS ? stripped.slice(0, MAX_BODY_CHARS) + '\n…[truncated]' : stripped;
}

function thunderbirdRecent({ folder, limit }) {
  const target = resolveThunderbirdFolder(folder);
  if (!target) throw new Error(`No Thunderbird folder matched "${folder || 'INBOX'}"`);
  const items = scanBackwards(target.file, {
    maxBytes: DEFAULT_TAIL_MB * 1024 * 1024,
    maxParse: 4000,
    pick: (raw, meta) => summarizeMessage(raw, { ...meta, ref: `tb:${target.key}:${meta.offset}`, folder: target.key }),
  });
  return { folder: target.key, file: target.file, sizeMb: mb(target.size), messages: items.slice(0, clamp(limit, 1, 100, 10)) };
}

function thunderbirdSearch({ query, folder, limit, maxScanMb }) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new Error('query is required');
  const cap = clamp(limit, 1, 100, 20);
  const targets = folder ? [resolveThunderbirdFolder(folder)].filter(Boolean) : thunderbirdFolders().filter((f) => f.size > 0);
  if (!targets.length) throw new Error('No Thunderbird mail store found');
  const results = [];
  const searched = [];
  for (const target of targets) {
    if (results.length >= cap) break;
    searched.push(target.key);
    const found = scanBackwards(target.file, {
      maxBytes: clamp(maxScanMb, 4, 512, 64) * 1024 * 1024,
      maxParse: 8000,
      pick: (raw, meta) => {
        const hay = raw.slice(0, 300000).toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return null;
        return summarizeMessage(raw, { ...meta, ref: `tb:${target.key}:${meta.offset}`, folder: target.key });
      },
    });
    results.push(...found);
  }
  return { query, scannedFolders: searched, matches: results.slice(0, cap) };
}

async function thunderbirdRead(ref) {
  const m = /^tb:(.+):(\d+)$/.exec(String(ref || ''));
  if (!m) throw new Error('ref must look like tb:<folder>:<offset> — take one from email_recent/email_search');
  const folderKey = m[1];
  const offset = Number(m[2]);
  const folder = thunderbirdFolders().find((f) => f.key === folderKey);
  if (!folder) throw new Error(`Unknown Thunderbird folder "${folderKey}"`);
  const fd = fs.openSync(folder.file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    const length = Math.min(total - offset, 12 * 1024 * 1024);
    let raw = readChunk(fd, offset, length);
    // Cut at the next real message boundary.
    const starts = messageStarts(raw);
    if (starts.length > 1) raw = raw.slice(0, starts[1]);
    const parsed = await parseRaw(raw);
    return {
      folder: folderKey,
      subject: String(parsed.subject || ''),
      from: parsed.from?.text || '',
      to: parsed.to?.text || '',
      cc: parsed.cc?.text || '',
      date: parsed.date ? new Date(parsed.date).toISOString() : '',
      messageId: parsed.messageId || '',
      attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename || '(unnamed)', sizeBytes: a.size || 0, contentType: a.contentType || '' })),
      body: messageText(parsed),
    };
  } finally {
    fs.closeSync(fd);
  }
}

// ── 2. Gmail over the project's existing OAuth connection ──────────────────
const gmailTokenCache = new Map();

function gmailConnectionFiles() {
  const dir = path.join(HOME, '.hakster', 'gmail-monitor');
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  return entries.filter((n) => /^connection-[0-9a-f]{64}\.json$/.test(n)).map((n) => path.join(dir, n));
}

function gmailConnection() {
  const clientSecret = env().GOOGLE_CLIENT_SECRET;
  const clientId = env().GOOGLE_CLIENT_ID;
  if (!clientId || !clientSecret) return { configured: false, reason: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set on the server' };
  const files = gmailConnectionFiles();
  if (!files.length) return { configured: false, reason: 'No Gmail inbox connected yet — owner connects once at /admin (Gmail monitor), then this works with no further setup' };
  const key = crypto.createHmac('sha256', clientSecret).update('haksterai:gmail-monitor:refresh-token:v1').digest();
  const errors = [];
  for (const file of files) {
    try {
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (envelope.version !== 1) throw new Error('unsupported format');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]).toString('utf8');
      const connection = JSON.parse(plain);
      if (connection.refreshToken) return { configured: true, clientId, clientSecret, connection };
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { configured: false, reason: `Gmail connection present but unreadable (${errors[0] || 'unknown'})` };
}

async function gmailToken(state) {
  const cacheKey = String(state.connection.refreshToken).slice(0, 16);
  const hit = gmailTokenCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now() + 60000) return hit.token;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: state.clientId,
      client_secret: state.clientSecret,
      refresh_token: state.connection.refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Gmail authorization expired — reconnect the inbox in the admin panel');
  const data = await response.json();
  const token = String(data.access_token || '');
  if (!token) throw new Error('Gmail did not return an access token');
  gmailTokenCache.set(cacheKey, { token, expiresAt: Date.now() + (Number(data.expires_in) || 3000) * 1000 });
  return token;
}

async function gmailApi(state, urlPath, options = {}) {
  const token = await gmailToken(state);
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/${urlPath}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Gmail API ${response.status}: ${firstLine(text, 200)}`);
  return text ? JSON.parse(text) : {};
}

function headerValue(payload, name) {
  const hit = (payload?.headers || []).find((h) => String(h.name).toLowerCase() === name.toLowerCase());
  return hit ? hit.value : '';
}

function gmailBodyText(payload) {
  const queue = [payload];
  while (queue.length) {
    const part = queue.shift();
    if (!part) continue;
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf8');
    }
    if (Array.isArray(part.parts)) queue.unshift(...part.parts);
    if (Array.isArray(part.parts)) {
      const nested = gmailBodyText({ parts: part.parts });
      if (nested) return nested;
    }
  }
  return '';
}

async function gmailRecent({ limit, query }) {
  const state = gmailConnection();
  if (!state.configured) throw new Error(state.reason);
  const max = clamp(limit, 1, 50, 10);
  const q = String(query || '').trim();
  const list = await gmailApi(state, `users/me/messages?maxResults=${max}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const messages = [];
  for (const item of list.messages || []) {
    const full = await gmailApi(state, `users/me/messages/${item.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`);
    messages.push({
      ref: `gmail:${item.id}`,
      threadId: item.threadId,
      subject: headerValue(full.payload, 'Subject'),
      from: headerValue(full.payload, 'From'),
      to: headerValue(full.payload, 'To'),
      date: headerValue(full.payload, 'Date'),
      snippet: full.snippet || '',
      labels: full.labelIds || [],
    });
  }
  return { account: state.connection.email || 'gmail', messages };
}

async function gmailRead(ref) {
  const state = gmailConnection();
  if (!state.configured) throw new Error(state.reason);
  const id = String(ref || '').replace(/^gmail:/, '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('ref must be gmail:<messageId>');
  const full = await gmailApi(state, `users/me/messages/${id}?format=full`);
  const body = firstLine(gmailBodyText(full.payload), MAX_BODY_CHARS);
  return {
    ref: `gmail:${id}`,
    threadId: full.threadId,
    subject: headerValue(full.payload, 'Subject'),
    from: headerValue(full.payload, 'From'),
    to: headerValue(full.payload, 'To'),
    cc: headerValue(full.payload, 'Cc'),
    date: headerValue(full.payload, 'Date'),
    labels: full.labelIds || [],
    attachments: (full.payload?.parts || []).filter((p) => p.filename).map((p) => ({ filename: p.filename, sizeBytes: p.body?.size || 0, contentType: p.mimeType })),
    body: body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + '\n…[truncated]' : body,
  };
}

// ── 3. IMAP/SMTP accounts from the encrypted mail store ────────────────────
function mailStore() {
  try { return require(path.join(SERVER_ROOT, 'src', 'mail-store.js')); } catch (_) { return null; }
}

function imapAccounts() {
  // The store is a single AES-256-GCM envelope keyed by ~/.hakster/mail/.key (0600). Decrypt
  // in-process only; the passwords never leave this function.
  const store = mailStore();
  const dir = store?.MAIL_DIR || path.join(HOME, '.hakster', 'mail');
  try {
    const key = fs.readFileSync(path.join(dir, '.key'));
    if (key.length !== 32) return [];
    const envelope = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
    if (envelope.version !== 1) return [];
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]).toString('utf8');
    const payload = JSON.parse(plain);
    return Array.isArray(payload.accounts) ? payload.accounts : [];
  } catch (_) { return []; }
}

async function withImap(account, fn) {
  if (!ImapFlow) throw new Error('imapflow is not installed in server/node_modules');
  const client = new ImapFlow({
    host: account.imapHost,
    port: Number(account.imapPort) || 993,
    secure: String(account.imapSecure ?? 'true') !== 'false',
    auth: { user: account.username, pass: account.password },
    logger: false,
    tls: { rejectUnauthorized: true, servername: account.imapHost },
  });
  await client.connect();
  try { return await fn(client); } finally { try { await client.logout(); } catch (_) { /* ignore */ } }
}

async function imapRecent({ account: accountId, folder, limit }) {
  const accounts = imapAccounts();
  const account = accounts.find((a) => a.id === accountId) || accounts[0];
  if (!account) throw new Error('No IMAP account connected — add one in the admin mail panel');
  const mailbox = folder || 'INBOX';
  const max = clamp(limit, 1, 50, 10);
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const exists = client.mailbox.exists;
      if (!exists) return { account: account.email, folder: mailbox, messages: [] };
      const from = Math.max(1, exists - max + 1);
      const messages = [];
      for await (const msg of client.fetch(`${from}:*`, { envelope: true, bodyStructure: true, size: true, flags: true })) {
        messages.push({
          ref: `imap:${account.id}:${mailbox}:${msg.uid}`,
          subject: msg.envelope?.subject || '',
          from: (msg.envelope?.from || []).map((a) => a.address).join(', '),
          date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : '',
          seen: msg.flags?.has ? msg.flags.has('\\Seen') : null,
          sizeBytes: msg.size || 0,
        });
      }
      return { account: account.email, folder: mailbox, messages: messages.reverse() };
    } finally { lock.release(); }
  });
}

async function imapRead(ref) {
  const m = /^imap:([^:]+):(.+):(\d+)$/.exec(String(ref || ''));
  if (!m) throw new Error('ref must be imap:<accountId>:<folder>:<uid>');
  const [, accountId, folder, uid] = m;
  const accounts = imapAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Unknown IMAP account "${accountId}"`);
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
      if (!msg || !msg.source) throw new Error('Message not found');
      const parsed = await parseRaw(msg.source.toString('utf8'));
      return {
        ref,
        subject: String(parsed.subject || ''),
        from: parsed.from?.text || '',
        to: parsed.to?.text || '',
        date: parsed.date ? new Date(parsed.date).toISOString() : '',
        attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename || '(unnamed)', sizeBytes: a.size || 0, contentType: a.contentType || '' })),
        body: messageText(parsed),
      };
    } finally { lock.release(); }
  });
}

// ── send ───────────────────────────────────────────────────────────────────
function buildRfc822({ from, to, cc, bcc, subject, text, html, inReplyTo, references }) {
  const safe = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim();
  const lines = [
    `From: ${safe(from)}`,
    `To: ${safe(to)}`,
    cc ? `Cc: ${safe(cc)}` : null,
    bcc ? `Bcc: ${safe(bcc)}` : null,
    `Subject: ${safe(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    inReplyTo ? `In-Reply-To: ${safe(inReplyTo)}` : null,
    references ? `References: ${safe(references)}` : null,
    `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset=UTF-8`,
    '',
    String(html || text || ''),
  ].filter(Boolean);
  return lines.join('\r\n');
}

async function emailSend(args) {
  const to = String(args.to || '').trim();
  const subject = String(args.subject || '').trim();
  const body = String(args.text || args.body || '').trim();
  if (!to || !subject || !body) throw new Error('to, subject and text are required');
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(to.split(',')[0].trim())) throw new Error('to must be an email address');

  const wanted = String(args.account || '').toLowerCase();
  if (wanted && wanted !== 'gmail') {
    const accounts = imapAccounts();
    const account = accounts.find((a) => a.id === wanted || String(a.email || '').toLowerCase() === wanted);
    if (account) return sendViaSmtp(account, args);
  }
  const state = gmailConnection();
  if (state.configured) {
    const from = state.connection.email || 'me';
    const raw = buildRfc822({ from, to, cc: args.cc, bcc: args.bcc, subject, text: args.text, html: args.html, inReplyTo: args.inReplyTo, references: args.references });
    const sent = await gmailApi(state, 'users/me/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url') }),
    });
    return { sent: true, via: 'gmail', from, to, subject, messageId: sent.id, threadId: sent.threadId };
  }
  const accounts = imapAccounts();
  if (accounts.length) return sendViaSmtp(accounts[0], args);
  throw new Error(`No sending account available. ${state.reason || ''}`.trim());
}

async function sendViaSmtp(account, args) {
  if (!nodemailer) throw new Error('nodemailer is not installed in server/node_modules');
  if (!account.smtpHost) throw new Error('This account has no SMTP host configured');
  const transport = nodemailer.createTransport({
    host: account.smtpHost,
    port: Number(account.smtpPort) || 465,
    secure: String(account.smtpSecure ?? 'true') !== 'false',
    auth: { user: account.username, pass: account.password },
    connectionTimeout: 15000,
    tls: { rejectUnauthorized: true, servername: account.smtpHost },
  });
  const info = await transport.sendMail({
    from: account.email,
    to: args.to,
    cc: args.cc || undefined,
    bcc: args.bcc || undefined,
    subject: args.subject,
    text: args.text,
    html: args.html || undefined,
  });
  return { sent: true, via: `smtp:${account.id}`, from: account.email, to: args.to, subject: args.subject, messageId: info.messageId };
}

// ── status ─────────────────────────────────────────────────────────────────
function emailStatus() {
  const folders = thunderbirdFolders();
  const totalBytes = folders.reduce((sum, f) => sum + f.size, 0);
  const gmail = gmailConnection();
  const accounts = imapAccounts();
  return {
    thunderbird: {
      available: folders.length > 0,
      profiles: profiles().map((p) => path.basename(p)),
      folders: folders.length,
      sizeMb: mb(totalBytes),
      largest: folders.sort((a, b) => b.size - a.size).slice(0, 5).map((f) => ({ folder: f.key, sizeMb: mb(f.size), updated: f.mtime })),
    },
    gmail: gmail.configured
      ? { available: true, account: gmail.connection.email || '(connected)', scopes: gmail.connection.scopes || [], connectedAt: gmail.connection.connectedAt || '' }
      : { available: false, reason: gmail.reason },
    imap: { available: accounts.length > 0, accounts: accounts.map((a) => ({ id: a.id, label: a.label, email: a.email, imapHost: a.imapHost })) },
    note: 'thunderbird is read-only and needs no credentials. gmail/imap are the live paths and are used for sending.',
  };
}

// ── tool surface ───────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'email_status',
    description: 'Report which mail sources are actually usable right now: the local Thunderbird store (read-only, no credentials), the Gmail OAuth connection, and any IMAP/SMTP account. Call this before claiming mail access exists.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'email_folders',
    description: 'List mail folders available in the local Thunderbird store, with size and last-updated time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'email_recent',
    description: 'List the newest messages in a folder. source=thunderbird reads the local store (default); source=gmail reads the live Gmail account; source=imap reads a connected IMAP account.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['thunderbird', 'gmail', 'imap'], description: 'Where to read from (default thunderbird)' },
        folder: { type: 'string', description: 'Folder name, e.g. INBOX or "[Gmail]/Sent Mail" (thunderbird/imap)' },
        account: { type: 'string', description: 'IMAP account id or email (imap only)' },
        query: { type: 'string', description: 'Gmail search query, e.g. "is:unread newer_than:7d" (gmail only)' },
        limit: { type: 'number', description: 'How many messages (default 10, max 100)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'email_search',
    description: 'Search mail. thunderbird: full-text over the local mbox store (case-insensitive, all words must match), bounded by maxScanMb so it always returns. gmail: real Gmail query syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text (thunderbird) or Gmail query (gmail)' },
        source: { type: 'string', enum: ['thunderbird', 'gmail'], description: 'Default thunderbird' },
        folder: { type: 'string', description: 'Restrict to one Thunderbird folder' },
        limit: { type: 'number', description: 'Max matches (default 20)' },
        maxScanMb: { type: 'number', description: 'How much of the store to scan, in MB (default 64)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'email_read',
    description: 'Read one message in full (text body, headers, attachment names/sizes — never attachment content). Pass the ref returned by email_recent or email_search, e.g. tb:imap.gmail.com/INBOX:12345 or gmail:18f2ab.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Message reference from email_recent/email_search' } },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'email_send',
    description: 'Send an email. Uses the connected Gmail account (gmail.send) unless another account is named. Sending is an explicit, outward action — confirm the recipient and content before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        cc: { type: 'string' },
        bcc: { type: 'string' },
        subject: { type: 'string' },
        text: { type: 'string', description: 'Plain-text body (required unless html is given)' },
        html: { type: 'string', description: 'Optional HTML body' },
        account: { type: 'string', description: 'Account id or email to send from; default is the Gmail connection' },
      },
      required: ['to', 'subject', 'text'],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'email_status': return emailStatus();
    case 'email_folders': return { folders: thunderbirdFolders().map((f) => ({ folder: f.key, sizeMb: mb(f.size), updated: f.mtime })).sort((x, y) => y.sizeMb - x.sizeMb) };
    case 'email_recent': {
      const source = String(a.source || 'thunderbird').toLowerCase();
      if (source === 'gmail') return gmailRecent(a);
      if (source === 'imap') return imapRecent(a);
      return thunderbirdRecent(a);
    }
    case 'email_search': {
      const source = String(a.source || 'thunderbird').toLowerCase();
      if (source === 'gmail') return gmailRecent({ limit: a.limit, query: a.query });
      return thunderbirdSearch(a);
    }
    case 'email_read': {
      const ref = String(a.ref || '');
      if (ref.startsWith('gmail:')) return gmailRead(ref);
      if (ref.startsWith('imap:')) return imapRead(ref);
      return thunderbirdRead(ref);
    }
    case 'email_send': return emailSend(a);
    default: throw new Error(`Unknown tool "${name}"`);
  }
}

// ── JSON-RPC over stdio ────────────────────────────────────────────────────
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(message) {
  const { id, method, params } = message || {};
  const isNotification = id === undefined || id === null;
  try {
    if (method === 'initialize') {
      return send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'hakster-email', version: '1.0.0' },
        },
      });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const name = params?.name;
      const result = await callTool(name, params?.arguments);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false } });
    }
    if (isNotification) return;
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    if (isNotification) return;
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } });
  }
}

let buffer = '';
let pending = 0;
let ended = false;

function track(message) {
  pending += 1;
  Promise.resolve(handle(message)).finally(() => {
    pending -= 1;
    if (ended && pending === 0) process.exit(0);
  });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch (_) { continue; }
    track(message);
  }
});
// Exit only once every in-flight call has answered — a piped client sends and closes, and
// exiting on 'end' would drop the response it is waiting for.
process.stdin.on('end', () => {
  ended = true;
  if (pending === 0) process.exit(0);
  setTimeout(() => process.exit(0), 30000).unref?.();
});
