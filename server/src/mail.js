'use strict';
// HaksterAI mail client backend.
// Multi-account: Gmail (existing OAuth connection) + generic IMAP/SMTP accounts.
// Every route is owner-gated by the caller-supplied `requireOwner`.
// Credentials stay in mail-store.js (AES-256-GCM, 0600) and never reach the browser.

const path = require('path');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const store = require('./mail-store');

const IMAP_TIMEOUT = 20000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_COMPOSE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const LIST_LIMIT_MAX = 100;

// ── tiny helpers ────────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'Operation'} timed out`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function safeText(value, max = 500) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}

function isEmail(value) {
  const text = String(value || '').trim();
  return text.length > 3 && text.length <= 254 && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(text);
}

function addressList(input) {
  return String(input || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((item) => ({ address: item }))
    .filter((item) => isEmail(item.address));
}

// ── HTML sanitising ────────────────────────────────────────────────────────
// Two layers: scrub the markup here, then render it in a sandboxed iframe whose CSP
// forbids scripts entirely. Neither layer is trusted alone.
function sanitizeEmailHtml(html, { allowImages }) {
  let out = String(html || '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<\s*(script|iframe|object|embed|form|link|meta|base)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  out = out.replace(/<\s*(script|iframe|object|embed|form|link|meta|base)\b[^>]*\/?>/gi, '');
  out = out.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/\s+(?:srcdoc|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/(?:href|src|action|formaction)\s*=\s*(["'])\s*(?:javascript|vbscript|data:text\/html)[^"']*\1/gi, 'href="#"');
  let blockedImages = 0;
  if (!allowImages) {
    out = out.replace(/(<img\b[^>]*?\s)src\s*=\s*(["'])((?:https?:)?\/\/[^"']*)\2/gi, (match, lead) => {
      blockedImages += 1;
      return `${lead}src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-blocked-src="1"`;
    });
    // CSS url() can fetch remote images too.
    out = out.replace(/url\(\s*(["']?)((?:https?:)?\/\/[^)"']*)\1\s*\)/gi, 'none');
  }
  // Any surviving url() to remote origins is still blocked by the iframe CSP.
  return { html: out, blockedImages };
}

function htmlDocument(bodyHtml) {
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">`
    + `<style>html,body{margin:0;padding:0;background:#fff}body{font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;padding:14px;word-break:break-word}img{max-width:100%!important;height:auto!important}table{max-width:100%!important}a{color:#1a4fd6}</style>`
    + bodyHtml;
}

// ── IMAP ───────────────────────────────────────────────────────────────────
let imapSlots = 0;
const IMAP_MAX_CONCURRENT = 3;

async function withImap(account, fn) {
  while (imapSlots >= IMAP_MAX_CONCURRENT) await new Promise((resolve) => setTimeout(resolve, 120));
  imapSlots += 1;
  const client = new ImapFlow({
    host: account.imapHost,
    port: clampInt(account.imapPort, 1, 65535, 993),
    secure: account.imapSecure !== false,
    auth: { user: account.username, pass: account.password },
    logger: false,
    emitLogs: false,
    greetingTimeout: IMAP_TIMEOUT,
    socketTimeout: IMAP_TIMEOUT,
    tls: { rejectUnauthorized: true, servername: account.imapHost },
  });
  try {
    await withTimeout(client.connect(), IMAP_TIMEOUT + 5000, 'IMAP connect');
    return await fn(client);
  } finally {
    try { await withTimeout(client.logout(), 5000, 'IMAP logout'); } catch { try { client.close(); } catch {} }
    imapSlots -= 1;
  }
}

function mailboxName(value) {
  const name = String(value || 'INBOX');
  if (!name || name.length > 200 || /[\r\n]/.test(name)) throw new Error('Invalid folder name');
  return name;
}

function addressText(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list.map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address)).filter(Boolean).join(', ').slice(0, 1000);
}

function envelopeSummary(node) {
  const from = addressText(node?.from);
  const to = addressText(node?.to);
  return { from, to, subject: safeText(node?.subject, 400) };
}

function threadKey(headers, subject) {
  const refs = headers.get('references');
  const inReplyTo = headers.get('in-reply-to');
  const messageId = headers.get('message-id');
  const firstRef = Array.isArray(refs) ? refs[0] : (typeof refs === 'string' ? refs.split(/\s+/)[0] : '');
  const base = String(firstRef || (Array.isArray(inReplyTo) ? inReplyTo[0] : inReplyTo) || '').replace(/[<>\s]/g, '');
  if (base) return base.slice(0, 120);
  const normalised = String(subject || '').replace(/^\s*((re|fw|fwd|aw|sv)\s*:\s*)+/i, '').trim().toLowerCase();
  return normalised ? 'subj:' + crypto.createHash('sha1').update(normalised).digest('hex').slice(0, 16) : '';
}

// ── attachment walk over mailparser structure ──────────────────────────────
function attachmentsOf(parsed) {
  return (parsed.attachments || []).map((item, index) => ({
    part: `att${index}`,
    filename: safeText(item.filename || `attachment-${index + 1}`, 200),
    contentType: safeText(item.contentType || 'application/octet-stream', 120),
    size: Number(item.size) || (item.content ? item.content.length : 0),
    inline: Boolean(item.contentDisposition === 'inline' && item.related),
    contentId: safeText(item.cid || '', 200),
  }));
}

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Gmail REST (existing OAuth connection) ─────────────────────────────────
function gmailTokenCache() {
  if (!gmailTokenCache.map) gmailTokenCache.map = new Map();
  return gmailTokenCache.map;
}

async function gmailAccessToken({ connection, clientId, clientSecret }) {
  const cache = gmailTokenCache();
  const key = `${connection.email}:${connection.refreshToken.slice(0, 12)}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60000) return hit.token;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: connection.refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const error = new Error('Gmail authorization expired. Reconnect the inbox.');
    error.code = 'RECONNECT';
    throw error;
  }
  const data = await response.json();
  const token = String(data.access_token || '');
  if (!token) throw new Error('Gmail did not return an access token');
  cache.set(key, { token, expiresAt: Date.now() + (Number(data.expires_in) || 3000) * 1000 });
  return token;
}

async function gmailFetch(token, urlPath, options = {}) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${urlPath}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const error = new Error(safeText(detail?.error?.message || `Gmail request failed (${response.status})`, 300));
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function gmailHeaders(payload) {
  const list = payload?.headers || [];
  const read = (name) => String(list.find((item) => String(item.name).toLowerCase() === name.toLowerCase())?.value || '');
  return { read };
}

function gmailParts(payload) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    out.push(node);
    (node.parts || []).forEach(walk);
  };
  walk(payload);
  return out;
}

function decodeBase64Url(input) {
  return Buffer.from(String(input || ''), 'base64url');
}

// ── routes ─────────────────────────────────────────────────────────────────
module.exports = function createMailRoutes(options) {
  const {
    app,
    requireOwner,
    readGmailConnection,
    googleClientId,
    googleClientSecret,
  } = options;

  const gmailConfigured = () => Boolean(readGmailConnection && googleClientId && googleClientSecret);

  async function resolveAccount(userId, requestedId) {
    const id = String(requestedId || '').trim();
    if (!id) throw Object.assign(new Error('Choose a mail account'), { status: 400 });
    if (id === 'gmail') {
      if (!gmailConfigured()) throw Object.assign(new Error('Gmail is not configured on the server'), { status: 503 });
      const connection = readGmailConnection(userId);
      if (!connection?.refreshToken) throw Object.assign(new Error('Connect an authorized Gmail inbox first'), { status: 409 });
      if (!String(connection.scopes || '').includes('gmail') && !Array.isArray(connection.scopes)) {
        // scopes may be an array; tolerate both shapes
      }
      return { kind: 'gmail', id: 'gmail', label: connection.email || 'Gmail', email: connection.email, connection };
    }
    const account = store.getAccount(userId, id);
    if (!account) throw Object.assign(new Error('Unknown mail account'), { status: 404 });
    return account;
  }

  function failure(res, error, fallback) {
    const status = Number(error?.status) || 502;
    if (error?.code === 'RECONNECT') return res.status(401).json({ error: error.message, reconnectRequired: true });
    return res.status(status).json({ error: safeText(error?.message || fallback, 400) });
  }

  app.get('/api/admin/mail/accounts', requireOwner, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const accounts = [];
    try {
      if (gmailConfigured()) {
        const connection = readGmailConnection(req.user.id);
        if (connection?.refreshToken) {
          accounts.push({ id: 'gmail', kind: 'gmail', label: connection.email || 'Gmail', email: connection.email || '', status: 'connected', canModify: false });
        }
      }
    } catch { /* an unreadable Gmail connection should not hide IMAP accounts */ }
    try {
      for (const account of store.listAccounts(req.user.id)) {
        accounts.push({ ...account, canModify: true });
      }
    } catch (error) {
      return failure(res, error, 'Mail account storage needs attention');
    }
    res.json({ accounts, gmailConfigured: gmailConfigured() });
  });

  app.post('/api/admin/mail/accounts', requireOwner, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body || {};
    const email = String(body.email || '').trim();
    const username = String(body.username || email).trim();
    const password = String(body.password || '');
    const label = safeText(body.label || email, 80);
    const imapHost = String(body.imapHost || '').trim();
    const smtpHost = String(body.smtpHost || '').trim();
    if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!imapHost || !/^[a-z0-9.-]{1,253}$/i.test(imapHost)) return res.status(400).json({ error: 'Enter a valid IMAP server hostname' });
    if (!smtpHost || !/^[a-z0-9.-]{1,253}$/i.test(smtpHost)) return res.status(400).json({ error: 'Enter a valid SMTP server hostname' });
    if (!username || username.length > 254) return res.status(400).json({ error: 'Enter the IMAP username' });
    if (!password || password.length > 512) return res.status(400).json({ error: 'Enter the IMAP/SMTP password or app password' });

    const account = {
      kind: 'imap',
      label,
      email,
      username,
      password,
      imapHost,
      imapPort: clampInt(body.imapPort, 1, 65535, 993),
      imapSecure: body.imapSecure !== false,
      smtpHost,
      smtpPort: clampInt(body.smtpPort, 1, 65535, 465),
      smtpSecure: body.smtpSecure !== false,
      status: 'unknown',
    };

    try {
      await withImap(account, async (client) => {
        const lock = await client.getMailboxLock('INBOX');
        lock.release();
      });
    } catch (error) {
      return res.status(400).json({ error: `IMAP sign-in failed: ${safeText(error.message, 240)}` });
    }
    try {
      const transport = nodemailer.createTransport({
        host: account.smtpHost,
        port: account.smtpPort,
        secure: account.smtpSecure,
        auth: { user: account.username, pass: account.password },
        connectionTimeout: 12000,
        greetingTimeout: 12000,
        socketTimeout: 20000,
      });
      await withTimeout(transport.verify(), 20000, 'SMTP verification');
    } catch (error) {
      return res.status(400).json({ error: `SMTP sign-in failed: ${safeText(error.message, 240)}` });
    }

    try {
      const created = store.addAccount(req.user.id, { ...account, status: 'connected', lastCheckedAt: new Date().toISOString() });
      res.json({ ok: true, account: { ...created, canModify: true } });
    } catch (error) {
      return failure(res, error, 'Could not save the mail account');
    }
  });

  app.post('/api/admin/mail/accounts/remove', requireOwner, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const id = String(req.body?.id || '');
    if (id === 'gmail') return res.status(400).json({ error: 'Use Disconnect Gmail on the Email Monitor page to revoke Google access' });
    try {
      const removed = store.removeAccount(req.user.id, id);
      if (!removed) return res.status(404).json({ error: 'Unknown mail account' });
      res.json({ ok: true });
    } catch (error) {
      return failure(res, error, 'Could not remove the mail account');
    }
  });

  // ── folders ──
  app.get('/api/admin/mail/folders', requireOwner, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const account = await resolveAccount(req.user.id, req.query.account);
      if (account.kind === 'gmail') {
        const token = await gmailAccessToken({ connection: account.connection, clientId: googleClientId, clientSecret: googleClientSecret });
        const data = await gmailFetch(token, '/labels');
        const folders = (data.labels || [])
          .filter((label) => label.type === 'system' || label.labelListVisibility !== 'labelHide')
          .map((label) => ({
            id: label.id,
            name: label.name,
            role: label.type === 'system' ? String(label.id).toLowerCase() : 'user',
          }))
          .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'inbox' ? -1 : b.role === 'inbox' ? 1 : 0));
        return res.json({ account: account.id, folders });
      }
      const folders = await withImap(account, async (client) => {
        const list = await client.list();
        return list
          .filter((box) => !box.flags || !box.flags.has('\\Noselect'))
          .map((box) => ({
            id: box.path,
            name: box.name || box.path,
            special: box.specialUse || '',
            role: String(box.specialUse || '').replace('\\', '').toLowerCase(),
          }))
          .sort((a, b) => {
            const rank = (item) => (item.role === 'inbox' ? 0 : item.role === 'sent' ? 1 : item.role === 'drafts' ? 2 : item.role === 'trash' ? 9 : 5);
            return rank(a) - rank(b) || a.name.localeCompare(b.name);
          });
      });
      res.json({ account: account.id, folders });
    } catch (error) {
      return failure(res, error, 'Could not load folders');
    }
  });

  // ── message list ──
  app.get('/api/admin/mail/messages', requireOwner, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const limit = clampInt(req.query.limit, 1, LIST_LIMIT_MAX, 40);
    const offset = clampInt(req.query.offset, 0, 100000, 0);
    const folder = String(req.query.folder || 'INBOX');
    try {
      const account = await resolveAccount(req.user.id, req.query.account);
      if (account.kind === 'gmail') {
        const token = await gmailAccessToken({ connection: account.connection, clientId: googleClientId, clientSecret: googleClientSecret });
        const params = new URLSearchParams({ maxResults: String(limit), labelIds: folder === 'ALL' ? '' : folder });
        if (folder === 'ALL') params.delete('labelIds');
        if (req.query.pageToken) params.set('pageToken', String(req.query.pageToken));
        const listing = await gmailFetch(token, `/messages?${params.toString()}`);
        const items = await Promise.all((listing.messages || []).slice(0, limit).map(async (entry) => {
          try {
            const url = `/messages/${encodeURIComponent(entry.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=In-Reply-To`;
            const message = await gmailFetch(token, url);
            const headers = gmailHeaders(message.payload);
            const timestamp = Number(message.internalDate) || 0;
            return {
              uid: String(message.id),
              threadId: String(message.threadId || ''),
              thread: String(headers.read('References') || headers.read('In-Reply-To') || message.threadId || message.id).slice(0, 120),
              from: safeText(headers.read('From'), 300),
              to: safeText(headers.read('To'), 300),
              subject: safeText(headers.read('Subject'), 300) || '(no subject)',
              date: timestamp ? new Date(timestamp).toISOString() : safeText(headers.read('Date'), 80),
              snippet: safeText(message.snippet, 300),
              unread: (message.labelIds || []).includes('UNREAD'),
              flagged: (message.labelIds || []).includes('STARRED'),
              size: Number(message.sizeEstimate) || 0,
              hasAttachments: false,
            };
          } catch { return null; }
        }));
        return res.json({
          account: account.id,
          folder,
          messages: items.filter(Boolean),
          nextPageToken: listing.nextPageToken || '',
          total: Number(listing.resultSizeEstimate) || 0,
        });
      }

      const box = mailboxName(folder);
      const result = await withImap(account, async (client) => {
        const lock = await client.getMailboxLock(box);
        try {
          const total = client.mailbox.exists || 0;
          if (!total) return { messages: [], total: 0 };
          const end = total - offset;
          if (end < 1) return { messages: [], total };
          const start = Math.max(1, end - limit + 1);
          const messages = [];
          for await (const message of client.fetch(`${start}:${end}`, {
            envelope: true,
            flags: true,
            internalDate: true,
            size: true,
            bodyStructure: true,
            headers: true,
          }, { uid: false })) {
            const summary = envelopeSummary(message.envelope);
            const raw = message.headers ? Buffer.from(message.headers).toString('utf8') : '';
            const headerValue = (name) => {
              const match = raw.match(new RegExp(`^${name}:\\s*(.+(?:\\n\\s+.+)*)`, 'im'));
              return match ? match[1].replace(/\s+/g, ' ').trim() : '';
            };
            const refs = headerValue('References') || headerValue('In-Reply-To') || headerValue('Message-ID');
            const hasAttachments = Boolean(message.bodyStructure && JSON.stringify(message.bodyStructure).includes('attachment'));
            messages.push({
              uid: String(message.uid),
              seq: Number(message.seq) || 0,
              thread: String(refs || '').slice(0, 120),
              from: safeText(summary.from, 300),
              to: safeText(summary.to, 300),
              subject: summary.subject || '(no subject)',
              date: message.internalDate ? new Date(message.internalDate).toISOString() : '',
              snippet: '',
              unread: !(message.flags && message.flags.has('\\Seen')),
              flagged: Boolean(message.flags && message.flags.has('\\Flagged')),
              size: Number(message.size) || 0,
              hasAttachments,
            });
          }
          messages.sort((a, b) => String(b.date).localeCompare(String(a.date)));
          return { messages, total };
        } finally {
          lock.release();
        }
      });
      res.json({ account: account.id, folder: box, ...result });
    } catch (error) {
      return failure(res, error, 'Could not load messages');
    }
  });

  // ── search ──
  app.get('/api/admin/mail/search', requireOwner, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const query = safeText(req.query.q, 200).trim();
    const folder = String(req.query.folder || 'INBOX');
    if (!query) return res.status(400).json({ error: 'Enter something to search for' });
    try {
      const account = await resolveAccount(req.user.id, req.query.account);
      if (account.kind === 'gmail') {
        const token = await gmailAccessToken({ connection: account.connection, clientId: googleClientId, clientSecret: googleClientSecret });
        const params = new URLSearchParams({ maxResults: '40', q: query });
        if (folder && folder !== 'ALL') params.append('labelIds', folder);
        const listing = await gmailFetch(token, `/messages?${params.toString()}`);
        const items = await Promise.all((listing.messages || []).map(async (entry) => {
          try {
            const message = await gmailFetch(token, `/messages/${encodeURIComponent(entry.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
            const headers = gmailHeaders(message.payload);
            const timestamp = Number(message.internalDate) || 0;
            return {
              uid: String(message.id),
              thread: String(message.threadId || message.id),
              from: safeText(headers.read('From'), 300),
              to: '',
              subject: safeText(headers.read('Subject'), 300) || '(no subject)',
              date: timestamp ? new Date(timestamp).toISOString() : '',
              snippet: safeText(message.snippet, 300),
              unread: (message.labelIds || []).includes('UNREAD'),
              flagged: (message.labelIds || []).includes('STARRED'),
              hasAttachments: false,
            };
          } catch { return null; }
        }));
        return res.json({ account: account.id, folder, query, messages: items.filter(Boolean) });
      }
      const box = mailboxName(folder);
      const messages = await withImap(account, async (client) => {
        const lock = await client.getMailboxLock(box);
        try {
          const found = new Set();
          for (const criteria of [{ subject: query }, { from: query }, { to: query }, { body: query }]) {
            try {
              const hits = await client.search(criteria, { uid: true });
              (hits || []).forEach((value) => found.add(value));
            } catch { /* unsupported per-server criterion — keep the others */ }
          }
          const uids = [...found].sort((a, b) => a - b);
          if (!uids.length) return [];
          const recent = uids.slice(-40);
          const out = [];
          for await (const message of client.fetch(recent.join(','), { envelope: true, flags: true, internalDate: true, size: true, headers: true }, { uid: true })) {
            const summary = envelopeSummary(message.envelope);
            const raw = message.headers ? Buffer.from(message.headers).toString('utf8') : '';
            const match = raw.match(/^References:\s*(.+)/im);
            out.push({
              uid: String(message.uid),
              thread: match ? match[1].trim().slice(0, 120) : '',
              from: safeText(summary.from, 300),
              to: safeText(summary.to, 300),
              subject: summary.subject || '(no subject)',
              date: message.internalDate ? new Date(message.internalDate).toISOString() : '',
              snippet: '',
              unread: !(message.flags && message.flags.has('\\Seen')),
              flagged: Boolean(message.flags && message.flags.has('\\Flagged')),
              hasAttachments: false,
            });
          }
          return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        } finally {
          lock.release();
        }
      });
      res.json({ account: account.id, folder: box, query, messages });
    } catch (error) {
      return failure(res, error, 'Search failed');
    }
  });

  // ── single message ──
  app.get('/api/admin/mail/message', requireOwner, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const folder = String(req.query.folder || 'INBOX');
    const uid = String(req.query.uid || '');
    const allowImages = String(req.query.images || '') === '1';
    if (!uid || !/^[A-Za-z0-9_-]{1,200}$/.test(uid)) return res.status(400).json({ error: 'Invalid message reference' });
    try {
      const account = await resolveAccount(req.user.id, req.query.account);
      if (account.kind === 'gmail') {
        const token = await gmailAccessToken({ connection: account.connection, clientId: googleClientId, clientSecret: googleClientSecret });
        const message = await gmailFetch(token, `/messages/${encodeURIComponent(uid)}?format=full`);
        const headers = gmailHeaders(message.payload);
        const parts = gmailParts(message.payload);
        const partOf = (type) => parts.find((part) => part.mimeType === type && part.body?.data);
        const htmlPart = partOf('text/html');
        const textPart = partOf('text/plain');
        const rawHtml = htmlPart ? decodeBase64Url(htmlPart.body.data).toString('utf8') : '';
        const text = textPart ? decodeBase64Url(textPart.body.data).toString('utf8') : stripHtmlToText(rawHtml);
        const attachments = parts
          .filter((part) => part.filename && part.body?.attachmentId)
          .map((part) => ({
            part: String(part.body.attachmentId),
            filename: safeText(part.filename, 200),
            contentType: safeText(part.mimeType || 'application/octet-stream', 120),
            size: Number(part.body.size) || 0,
            inline: false,
          }));
        const { html, blockedImages } = sanitizeEmailHtml(rawHtml, { allowImages });
        return res.json({
          account: account.id,
          folder,
          uid,
          from: safeText(headers.read('From'), 400),
          to: safeText(headers.read('To'), 400),
          cc: safeText(headers.read('Cc'), 400),
          subject: safeText(headers.read('Subject'), 400),
          date: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : safeText(headers.read('Date'), 80),
          text: safeText(text, 400000),
          html: html ? htmlDocument(html) : '',
          attachments,
          blockedImages,
          readOnly: true,
        });
      }

      const box = mailboxName(folder);
      const parsedResult = await withImap(account, async (client) => {
        const lock = await client.getMailboxLock(box);
        try {
          const message = await client.fetchOne(uid, { source: true, size: true }, { uid: true });
          if (!message || !message.source) throw Object.assign(new Error('Message not found in this folder'), { status: 404 });
          if (message.size && Number(message.size) > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error('Message is too large to display'), { status: 413 });
          const parsed = await simpleParser(message.source);
          try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch { /* marking read is best-effort */ }
          return parsed;
        } finally {
          lock.release();
        }
      });
      const rawHtml = parsedResult.html || '';
      const { html, blockedImages } = sanitizeEmailHtml(rawHtml, { allowImages });
      res.json({
        account: account.id,
        folder: box,
        uid,
        from: safeText(parsedResult.from?.text, 400),
        to: safeText(parsedResult.to?.text, 400),
        cc: safeText(parsedResult.cc?.text, 400),
        subject: safeText(parsedResult.subject, 400),
        date: parsedResult.date ? new Date(parsedResult.date).toISOString() : '',
        text: safeText(parsedResult.text || stripHtmlToText(rawHtml), 400000),
        html: html ? htmlDocument(html) : '',
        attachments: attachmentsOf(parsedResult),
        blockedImages,
        readOnly: false,
        thread: {
          messageId: safeText(parsedResult.messageId, 200),
          inReplyTo: safeText(parsedResult.inReplyTo, 200),
          references: [].concat(parsedResult.references || []).map((item) => safeText(item, 200)).slice(0, 20),
        },
      });
    } catch (error) {
      return failure(res, error, 'Could not load the message');
    }
  });

  // ── flags (read / starred) ──
  app.post('/api/admin/mail/flags', requireOwner, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const folder = String(req.body?.folder || 'INBOX');
    const uid = String(req.body?.uid || '');
    if (!uid || !/^[A-Za-z0-9_-]{1,200}$/.test(uid)) return res.status(400).json({ error: 'Invalid message reference' });
    try {
      const account = await resolveAccount(req.user.id, req.body?.account);
      if (account.kind === 'gmail') {
        return res.status(409).json({ error: 'The Gmail connection has read + send permission only, so it cannot change message state. Add the inbox as an IMAP account to mark messages read or starred.' });
      }
      const box = mailboxName(folder);
      await withImap(account, async (client) => {
        const lock = await client.getMailboxLock(box);
        try {
          if (typeof req.body?.seen === 'boolean') {
            if (req.body.seen) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            else await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
          }
          if (typeof req.body?.flagged === 'boolean') {
            if (req.body.flagged) await client.messageFlagsAdd(uid, ['\\Flagged'], { uid: true });
            else await client.messageFlagsRemove(uid, ['\\Flagged'], { uid: true });
          }
        } finally {
          lock.release();
        }
      });
      res.json({ ok: true });
    } catch (error) {
      return failure(res, error, 'Could not update the message');
    }
  });

  // ── attachment download ──
  app.get('/api/admin/mail/attachment', requireOwner, async (req, res) => {
    const folder = String(req.query.folder || 'INBOX');
    const uid = String(req.query.uid || '');
    const part = String(req.query.part || '');
    if (!uid || !/^[A-Za-z0-9_-]{1,200}$/.test(uid)) return res.status(400).json({ error: 'Invalid message reference' });
    if (!part || !/^(att\d{1,3}|[A-Za-z0-9_-]{1,200})$/.test(part)) return res.status(400).json({ error: 'Invalid attachment reference' });
    try {
      const account = await resolveAccount(req.user.id, req.query.account);
      let filename = 'attachment';
      let contentType = 'application/octet-stream';
      let content;
      if (account.kind === 'gmail') {
        const token = await gmailAccessToken({ connection: account.connection, clientId: googleClientId, clientSecret: googleClientSecret });
        const message = await gmailFetch(token, `/messages/${encodeURIComponent(uid)}?format=full`);
        const match = gmailParts(message.payload).find((item) => item.body?.attachmentId === part);
        if (!match) return res.status(404).json({ error: 'Attachment not found' });
        const data = await gmailFetch(token, `/messages/${encodeURIComponent(uid)}/attachments/${encodeURIComponent(part)}`);
        content = decodeBase64Url(data.data);
        filename = safeText(match.filename, 200) || filename;
        contentType = safeText(match.mimeType, 120) || contentType;
      } else {
        const box = mailboxName(folder);
        content = await withImap(account, async (client) => {
          const lock = await client.getMailboxLock(box);
          try {
            const message = await client.fetchOne(uid, { source: true, size: true }, { uid: true });
            if (!message || !message.source) return null;
            if (message.size && Number(message.size) > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error('Attachment is too large to download here'), { status: 413 });
            const parsed = await simpleParser(message.source);
            const index = Number(part.replace('att', ''));
            const item = (parsed.attachments || [])[index];
            if (!item) return null;
            filename = safeText(item.filename, 200) || filename;
            contentType = safeText(item.contentType, 120) || contentType;
            return item.content;
          } finally {
            lock.release();
          }
        });
        if (!content) return res.status(404).json({ error: 'Attachment not found' });
      }
      if (content.length > MAX_ATTACHMENT_BYTES) return res.status(413).json({ error: 'Attachment is too large to download here' });
      res.setHeader('Content-Type', /^[\w.+-]+\/[\w.+-]+$/.test(contentType) ? contentType : 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/["\\]/g, '_').slice(0, 180)}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.send(content);
    } catch (error) {
      return failure(res, error, 'Could not download the attachment');
    }
  });

  // ── send ──
  app.post('/api/admin/mail/send', requireOwner, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body || {};
    const to = addressList(body.to);
    const cc = addressList(body.cc);
    const bcc = addressList(body.bcc);
    const replyTo = isEmail(body.replyTo) ? String(body.replyTo).trim() : '';
    const subject = String(body.subject || '').trim();
    const text = String(body.text || '');
    const html = String(body.html || '');
    const attachmentsInput = Array.isArray(body.attachments) ? body.attachments.slice(0, 10) : [];
    if (!to.length) return res.status(400).json({ error: 'Add at least one valid recipient' });
    if (subject.length > 300 || /[\r\n]/.test(subject)) return res.status(400).json({ error: 'Enter a subject of up to 300 characters on one line' });
    if (!text.trim() && !html.trim()) return res.status(400).json({ error: 'Write a message before sending' });
    if (text.length > 100000 || html.length > 200000) return res.status(400).json({ error: 'Message is too long' });

    const attachments = [];
    let total = 0;
    for (const item of attachmentsInput) {
      const filename = safeText(item?.filename, 200);
      const encoded = String(item?.content || '');
      if (!filename || !encoded) continue;
      let content;
      try { content = Buffer.from(encoded, 'base64'); } catch { return res.status(400).json({ error: 'Attachment encoding is invalid' }); }
      total += content.length;
      if (total > MAX_COMPOSE_ATTACHMENT_BYTES) return res.status(413).json({ error: 'Attachments total more than 20 MB' });
      attachments.push({ filename, content, contentType: safeText(item?.contentType, 120) || undefined });
    }

    try {
      const account = await resolveAccount(req.user.id, body.account);
      if (account.kind === 'gmail') {
        const token = await gmailAccessToken({ connection: account.connection, clientId: googleClientId, clientSecret: googleClientSecret });
        const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
        const built = await transport.sendMail({
          from: account.email,
          to: to.map((item) => item.address),
          cc: cc.length ? cc.map((item) => item.address) : undefined,
          bcc: bcc.length ? bcc.map((item) => item.address) : undefined,
          replyTo: replyTo || undefined,
          subject,
          text: text || stripHtmlToText(html),
          html: html || undefined,
          attachments,
          inReplyTo: body.inReplyTo || undefined,
          references: body.references || undefined,
        });
        const raw = Buffer.from(built.message).toString('base64url');
        const sent = await gmailFetch(token, '/messages/send', { method: 'POST', body: JSON.stringify({ raw }) });
        return res.json({ ok: true, id: String(sent.id || ''), to: to.map((item) => item.address) });
      }

      const transport = nodemailer.createTransport({
        host: account.smtpHost,
        port: clampInt(account.smtpPort, 1, 65535, 465),
        secure: account.smtpSecure !== false,
        auth: { user: account.username, pass: account.password },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
      });
      const info = await transport.sendMail({
        from: account.email,
        to: to.map((item) => item.address),
        cc: cc.length ? cc.map((item) => item.address) : undefined,
        bcc: bcc.length ? bcc.map((item) => item.address) : undefined,
        replyTo: replyTo || undefined,
        subject,
        text: text || stripHtmlToText(html),
        html: html || undefined,
        attachments,
        inReplyTo: body.inReplyTo || undefined,
        references: body.references || undefined,
      });
      res.json({ ok: true, id: String(info.messageId || ''), to: to.map((item) => item.address) });
    } catch (error) {
      if (error?.code === 'EAUTH') return res.status(401).json({ error: 'The mail server rejected the sign-in. Check the username and app password.' });
      return failure(res, error, 'Could not send the message');
    }
  });

  return { resolveAccount };
};

// Exposed for the mail client test harness; not used by the routes.
module.exports.sanitizeEmailHtml = sanitizeEmailHtml;
module.exports.stripHtmlToText = stripHtmlToText;
