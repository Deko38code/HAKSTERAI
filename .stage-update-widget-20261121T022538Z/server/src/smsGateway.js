'use strict';
/**
 * haksterAI — our own SMS gateway.
 *
 * Why: the Ez Texting trial is one recipient, credential-gated and currently
 * answering 401. It is a rented pipe. This module is the self-hosted one: a
 * small transport router that can put a text on the owner's own SIM, or reach
 * his phone through a carrier's email-to-SMS bridge, without a paid provider.
 *
 * Transports (tried in this order unless SMS_PROVIDER forces one):
 *
 *   1. phone         — the owner's Android phone running Termux:API. The Dell
 *                      opens an SSH connection and runs `termux-sms-send`, so
 *                      the message leaves from the owner's own SIM: real SMS,
 *                      any recipient, no per-message cost, inbound readable too.
 *   2. carrier-email — <10-digit number>@<carrier gateway domain> through SMTP.
 *                      Free, deliverable to the owner's own phone only. Good
 *                      last resort when the phone is asleep or off the LAN.
 *   3. eztexting     — the existing rented API, kept as an optional provider so
 *                      nothing that already works is removed.
 *
 * Configuration is owner-supplied in server/.env. Agents never write that file.
 *
 *   # transport 1 — phone
 *   SMS_PHONE_HOST=10.0.0.147
 *   SMS_PHONE_PORT=8022
 *   SMS_PHONE_USER=u0_a584
 *   SMS_PHONE_KEY=/home/ghost/haksterAi/server/data/phone_sms_key
 *   #   ...or, if key auth is not set up yet:
 *   SMS_PHONE_PASSWORD_FILE=/home/ghost/haksterAi/server/data/phone_sms_password
 *
 *   # transport 2 — carrier email bridge
 *   SMS_CARRIER_GATEWAY=vtext.com            (the carrier's own gateway domain)
 *   SMS_SMTP_HOST=smtp.example.com
 *   SMS_SMTP_PORT=587
 *   SMS_SMTP_SECURE=false
 *   SMS_SMTP_USER=...
 *   SMS_SMTP_PASS=...
 *   SMS_FROM_EMAIL=alerts@haksterai.com
 *
 *   # shared
 *   SMS_TO=<owner's own mobile, digits>
 *   SMS_PROVIDER=auto|phone|carrier-email|eztexting
 *
 * Safety:
 *   * No secrets and no full phone numbers ever leave this module in a log line,
 *     status object or error string — only the last four digits.
 *   * SSH is invoked with execFile (no local shell), a hard timeout, a known-hosts
 *     file inside server/data (never ~/.ssh), and a base64 payload so message text
 *     cannot be read as shell syntax on the phone.
 *   * Nothing here decides *whether* to send. Policy stays in notifySms.js:
 *     SMS_ENABLED, the /sms switch, the single-recipient trial rule and the daily
 *     cap all run before deliver() is ever called.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const KNOWN_HOSTS = path.join(DATA_DIR, 'phone_known_hosts');

// ── small helpers ───────────────────────────────────────────────────────────
function env(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

function digits(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

/** Last four digits only. Everything user-facing in this file goes through it. */
function maskNumber(value) {
  const s = digits(value);
  return s.length >= 4 ? `…${s.slice(-4)}` : '…';
}

function validNumber(value) {
  return /^\d{10,15}$/.test(digits(value));
}

// ── transport 1: the owner's phone (Termux:API over SSH) ────────────────────
function phoneConfig() {
  return {
    host: env('SMS_PHONE_HOST'),
    port: Number(env('SMS_PHONE_PORT', '8022')) || 8022,
    user: env('SMS_PHONE_USER', 'u0_a584'),
    keyFile: env('SMS_PHONE_KEY', path.join(DATA_DIR, 'phone_sms_key')),
    passwordFile: env('SMS_PHONE_PASSWORD_FILE'),
    connectTimeout: Number(env('SMS_PHONE_TIMEOUT', '8')) || 8,
  };
}

function phoneConfigured() {
  const c = phoneConfig();
  if (!c.host) return false;
  if (c.passwordFile) return fs.existsSync(c.passwordFile);
  return fs.existsSync(c.keyFile);
}

function sshArgs(c, remoteCommand) {
  const args = [
    '-p', String(c.port),
    '-o', 'BatchMode=' + (c.passwordFile ? 'no' : 'yes'),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=' + KNOWN_HOSTS,   // never touch ~/.ssh — that is owner config
    '-o', 'ConnectTimeout=' + c.connectTimeout,
    '-o', 'LogLevel=ERROR',
    '-o', 'ServerAliveInterval=5',
  ];
  if (!c.passwordFile && c.keyFile) {
    args.push('-i', c.keyFile, '-o', 'IdentitiesOnly=yes');
  }
  args.push(`${c.user}@${c.host}`, '--', remoteCommand);
  return args;
}

function runRemote(remoteCommand, timeoutMs = 20000) {
  const c = phoneConfig();
  const bin = c.passwordFile ? 'sshpass' : 'ssh';
  const args = c.passwordFile
    ? ['-f', c.passwordFile, 'ssh', ...sshArgs(c, remoteCommand)]
    : sshArgs(c, remoteCommand);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) { /* directory already fine */ }
  return new Promise((resolve) => {
    execFile(bin, args, {
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      maxBuffer: 2 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '').trim(),
      });
    });
  });
}

/**
 * Read-only check that the phone can actually send. Runs no send.
 * `command -v` proves Termux has its API binary on PATH; the package check proves
 * the Termux:API companion app is installed, which is what `termux-sms-send` talks to.
 */
async function probePhone() {
  const c = phoneConfig();
  if (!c.host) return { ok: false, reason: 'SMS_PHONE_HOST is not set' };
  if (!phoneConfigured()) {
    return { ok: false, reason: c.passwordFile
      ? `password file missing: ${c.passwordFile}`
      : `private key missing: ${c.keyFile}` };
  }
  const r = await runRemote(
    'echo BIN=$(command -v termux-sms-send || echo MISSING); ' +
    'echo API=$(pm list packages 2>/dev/null | grep -c com.termux.api); ' +
    'echo HOST=$(getprop ro.product.model 2>/dev/null | tr -d "\\n")',
    15000,
  );
  if (!r.ok) {
    return { ok: false, reason: r.stderr || `ssh exited ${r.code}`, host: `${c.user}@${c.host}:${c.port}` };
  }
  const read = (key) => {
    const m = r.stdout.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  return {
    ok: read('BIN') !== '' && read('BIN') !== 'MISSING',
    host: `${c.user}@${c.host}:${c.port}`,
    model: read('HOST') || 'unknown',
    binary: read('BIN') || 'unknown',
    termuxApiInstalled: read('API') !== '0' && read('API') !== '',
  };
}

/**
 * The exact one-liner sent to the phone. Kept as its own function so the shell
 * safety can be tested: the number is validated digits-only and the message
 * travels base64-encoded, so no character in the text can be read as shell syntax.
 */
function phoneCommand(number, text) {
  const digitsOnly = digits(number);
  if (!validNumber(digitsOnly)) throw new Error('recipient must be 10–15 digits');
  const payload = Buffer.from(String(text || ''), 'utf8').toString('base64');
  return `termux-sms-send -n ${digitsOnly} "$(printf %s ${payload} | base64 -d)"`;
}

async function sendViaPhone(to, text) {
  let remote;
  try {
    remote = phoneCommand(to, text);
  } catch (e) {
    return { ok: false, provider: 'phone', error: e.message };
  }
  const r = await runRemote(remote, 30000);
  if (!r.ok) {
    const detail = r.stderr || `ssh exit ${r.code}`;
    return { ok: false, provider: 'phone', error: detail.slice(0, 200) };
  }
  return { ok: true, provider: 'phone', id: null };
}

/** Read the phone's recent SMS — inbound half of "our own SMS". Masked. */
async function readPhoneInbox(limit = 5) {
  const n = Math.min(Math.max(Number(limit) || 5, 1), 50);
  const r = await runRemote(`termux-sms-list -l ${n}`, 20000);
  if (!r.ok) return { ok: false, error: (r.stderr || `ssh exit ${r.code}`).slice(0, 200), messages: [] };
  let rows = [];
  try { rows = JSON.parse(r.stdout || '[]'); } catch (_) { return { ok: false, error: 'phone did not return JSON', messages: [] }; }
  const messages = (Array.isArray(rows) ? rows : []).map((row) => ({
    from: maskNumber(row.number),
    type: row.type || 'unknown',
    at: row.received || row.date || null,
    text: String(row.body || '').slice(0, 500),
    read: Boolean(row.read),
  }));
  return { ok: true, messages };
}

// ── transport 2: carrier email-to-SMS bridge ────────────────────────────────
// The domain has to be the carrier's own published gateway. It is read from env,
// never guessed: sending to the wrong carrier's domain silently fails.
function carrierConfig() {
  return {
    gateway: env('SMS_CARRIER_GATEWAY').replace(/^@/, '').toLowerCase(),
    smtpHost: env('SMS_SMTP_HOST'),
    smtpPort: Number(env('SMS_SMTP_PORT', '587')) || 587,
    secure: String(env('SMS_SMTP_SECURE', 'false')).toLowerCase() === 'true',
    user: env('SMS_SMTP_USER'),
    pass: String(process.env.SMS_SMTP_PASS || ''),
    from: env('SMS_FROM_EMAIL', env('SMS_SMTP_USER')),
  };
}

function carrierConfigured() {
  const c = carrierConfig();
  return Boolean(c.gateway && c.smtpHost && c.from);
}

async function sendViaCarrierEmail(to, text) {
  const c = carrierConfig();
  const number = digits(to);
  if (!validNumber(number)) {
    return { ok: false, provider: 'carrier-email', error: 'recipient must be 10–15 digits' };
  }
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch (_) {
    return { ok: false, provider: 'carrier-email', error: 'nodemailer is not installed' };
  }
  const transport = nodemailer.createTransport({
    host: c.smtpHost,
    port: c.smtpPort,
    secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
  });
  const body = String(text || '').slice(0, 1200);
  try {
    const info = await transport.sendMail({
      from: c.from,
      to: `${number}@${c.gateway}`,
      subject: '',                       // carrier bridges show the subject as a prefix
      text: body,
    });
    return { ok: true, provider: 'carrier-email', id: info.messageId || null };
  } catch (e) {
    return { ok: false, provider: 'carrier-email', error: String(e.message || e).slice(0, 200) };
  } finally {
    try { transport.close(); } catch (_) { /* already closed */ }
  }
}

// ── transport 3: Ez Texting (optional, kept as-is) ──────────────────────────
function eztextingConfigured() {
  return Boolean(env('EZ_TEXTING_USER') && String(process.env.EZ_TEXTING_PASSWORD || ''));
}

async function sendViaEzTexting(to, text) {
  const user = env('EZ_TEXTING_USER');
  const password = String(process.env.EZ_TEXTING_PASSWORD || '');
  const from = digits(env('EZ_TEXTING_FROM'));
  const number = digits(to);
  if (!validNumber(number)) {
    return { ok: false, provider: 'eztexting', error: 'recipient must be 10–15 digits' };
  }
  try {
    const res = await fetch('https://a.eztexting.com/v1/messages', {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64'),
      },
      body: JSON.stringify({ toNumbers: [number], message: String(text || '').slice(0, 640), ...(from ? { fromNumber: from } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 200 || res.status === 201) return { ok: true, provider: 'eztexting', id: body.id || null };
    const error = body?.errors?.[0]?.message || body?.message || `HTTP ${res.status}`;
    return { ok: false, provider: 'eztexting', error: String(error).slice(0, 200) };
  } catch (e) {
    return { ok: false, provider: 'eztexting', error: String(e.message || e).slice(0, 200) };
  }
}

// ── routing ────────────────────────────────────────────────────────────────
const TRANSPORTS = {
  phone: { configured: phoneConfigured, send: sendViaPhone },
  'carrier-email': { configured: carrierConfigured, send: sendViaCarrierEmail },
  eztexting: { configured: eztextingConfigured, send: sendViaEzTexting },
};

/** Provider order: an explicit SMS_PROVIDER wins, otherwise every configured one. */
function providerOrder() {
  const forced = env('SMS_PROVIDER', 'auto').toLowerCase();
  if (forced && forced !== 'auto') {
    // A typo must not silently fall through to a different transport.
    return TRANSPORTS[forced] ? [forced] : [];
  }
  return Object.keys(TRANSPORTS).filter((name) => {
    try { return TRANSPORTS[name].configured(); } catch (_) { return false; }
  });
}

/**
 * The destination for our own transports. Explicit only: a number has to be
 * named in env. Nothing is inferred, so a wrong default can never text a stranger.
 */
function explicitDestination() {
  const candidate = digits(env('SMS_TO')) || digits(env('SMS_ALLOWED_RECIPIENT')) || digits(env('EZ_TEXTING_TO'));
  return validNumber(candidate) ? candidate : null;
}

function anyTransportConfigured() {
  return providerOrder().length > 0;
}

/**
 * Hand one message to the first transport that works.
 * Returns { ok, provider, id } or { ok:false, provider, error }.
 * Never throws — the caller's primary channel must not fail because SMS did.
 */
async function deliver({ to, text } = {}) {
  const order = providerOrder();
  if (!order.length) {
    return { ok: false, provider: null, error: 'no SMS transport is configured (see docs/sms-own-gateway.md)' };
  }
  const failures = [];
  for (const name of order) {
    const transport = TRANSPORTS[name];
    let result;
    try {
      result = await transport.send(to, text);
    } catch (e) {
      result = { ok: false, provider: name, error: String(e.message || e).slice(0, 200) };
    }
    if (result && result.ok) return result;
    failures.push(`${name}: ${(result && result.error) || 'failed'}`);
  }
  return { ok: false, provider: order[0], error: failures.join(' | ').slice(0, 400) };
}

/** Safe status for a CLI, a route or a Telegram line. No secrets, no full numbers. */
function status() {
  const p = phoneConfig();
  const ce = carrierConfig();
  return {
    providerOrder: providerOrder(),
    forcedProvider: env('SMS_PROVIDER', 'auto').toLowerCase(),
    destination: maskNumber(explicitDestination()),
    phone: {
      configured: phoneConfigured(),
      host: p.host ? `${p.user}@${p.host}:${p.port}` : null,
      auth: p.passwordFile ? 'password-file' : fs.existsSync(p.keyFile) ? 'key' : 'none',
    },
    carrierEmail: {
      configured: carrierConfigured(),
      gateway: ce.gateway || null,
      smtp: ce.smtpHost ? `${ce.smtpHost}:${ce.smtpPort}${ce.secure ? ' (tls)' : ''}` : null,
    },
    eztexting: { configured: eztextingConfigured() },
  };
}

module.exports = {
  deliver,
  status,
  providerOrder,
  explicitDestination,
  anyTransportConfigured,
  probePhone,
  readPhoneInbox,
  phoneCommand,
  maskNumber,
  validNumber,
  phoneConfig,
  phoneConfigured,
  carrierConfigured,
  eztextingConfigured,
  KNOWN_HOSTS,
};
