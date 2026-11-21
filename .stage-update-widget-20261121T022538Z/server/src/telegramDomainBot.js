'use strict';

// Domain bot (fleet slot 8) — the marketplace's domain desk.
//
// What it does: checks whether a domain name is registered, using registry data
// (RDAP) only — no paid API, no scraping, no purchase. It also suggests short,
// easy-to-spell names against the marketplace's own product roster and keeps a
// local waitlist while the marketplace is still marked "coming soon".
//
// What it never does: buy, reserve, hold, or promise a name. Registry data says
// whether a record exists; only a registrar can confirm availability at checkout,
// and the bot says that in plain words on every answer.
//
// Commands: /start /check <name> /find <keyword> /tlds /market /waitlist <email> /help

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const WAITLIST_FILE = path.join(DATA_DIR, 'domain-waitlist.json');
const STATUS_FILE = path.join(DATA_DIR, 'marketplace-status.json');

const UA = 'HaksterAI-DomainBot/1.0 (+https://haksterai.com)';
const RDAP_TIMEOUT_MS = 7000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const PER_CHAT_LIMIT = 8;          // lookups per chat per minute
const PER_CHAT_WINDOW_MS = 60 * 1000;
const MAX_CANDIDATES = 6;

// TLDs the desk will quote. Anything outside this still gets checked, but the
// answer says the registry data for it is thin and a registrar has to confirm.
const PREFERRED_TLDS = ['com', 'co', 'io', 'app', 'dev', 'shop', 'site', 'net', 'org', 'us', 'store'];

const cache = new Map();            // name -> { at, result }
let tldList = null;                 // Set of IANA TLDs, or null if it could not be loaded
let tldListAt = 0;
const chatHits = new Map();         // chatId -> { at, count }

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function normalizeName(input) {
  let raw = String(input || '').trim().toLowerCase();
  raw = raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  raw = raw.replace(/[^a-z0-9.-]/g, '');
  if (!raw) return null;
  if (!raw.includes('.')) return `${raw}.com`;
  return raw;
}

function splitName(name) {
  const i = name.lastIndexOf('.');
  return { label: name.slice(0, i), tld: name.slice(i + 1) };
}

// ── IANA list: lets the bot tell "not registered" apart from "not a real TLD" ──
async function loadTlds() {
  if (tldList && Date.now() - tldListAt < 24 * 60 * 60 * 1000) return tldList;
  try {
    const res = await fetch('https://data.iana.org/TLD/tlds-alpha-by-domain.txt', {
      headers: { 'user-agent': UA }, signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
    });
    if (!res.ok) return tldList;
    const raw = await res.text();
    const set = new Set(raw.split('\n').slice(1).map((l) => l.trim().toLowerCase()).filter(Boolean));
    if (set.size > 100) { tldList = set; tldListAt = Date.now(); }
  } catch { /* keep whatever we had */ }
  return tldList;
}

// ── RDAP lookup: one registry question, one honest answer ──
async function rdapLookup(name) {
  const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(name)}`, {
    headers: { 'user-agent': UA, accept: 'application/rdap+json, application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
  });
  if (res.status === 404) return { status: 'available' };
  if (res.status === 429) return { status: 'rate-limited' };
  if (!res.ok) return { status: 'unknown', detail: `HTTP ${res.status}` };

  const body = await res.json().catch(() => null);
  if (!body) return { status: 'unknown', detail: 'unreadable registry response' };

  const events = Array.isArray(body.events) ? body.events : [];
  const created = events.find((e) => e.eventAction === 'registration');
  const registrar = (Array.isArray(body.entities) ? body.entities : [])
    .find((e) => Array.isArray(e.roles) && e.roles.includes('registrar'));
  const registrarName = registrar
    ? (Array.isArray(registrar.vcardArray) && registrar.vcardArray[1]
      ? (registrar.vcardArray[1].find((f) => f[0] === 'fn') || [])[3]
      : null) || registrar.handle || null
    : null;

  return {
    status: 'registered',
    registrar: registrarName || null,
    created: created && created.eventDate ? String(created.eventDate).slice(0, 10) : null,
  };
}

async function checkDomain(input) {
  const name = normalizeName(input);
  if (!name) return { status: 'invalid', name: String(input || '') };

  const { label, tld } = splitName(name);
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return { status: 'invalid', name };
  if (!/^[a-z]{2,24}$/.test(tld)) return { status: 'invalid', name };

  const known = await loadTlds();
  if (known && !known.has(tld)) return { status: 'invalid-tld', name, tld };

  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  let result;
  try {
    result = { name, tld, ...(await rdapLookup(name)) };
  } catch (e) {
    result = { name, tld, status: 'unknown', detail: e.name === 'TimeoutError' ? 'registry timed out' : 'network error' };
  }
  cache.set(name, { at: Date.now(), result });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return result;
}

// ── Name ideas: short, easy to spell, built from the marketplace roster ──
function shortForms(keyword) {
  const kw = String(keyword || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 14);
  if (!kw) return [];
  const dropVowels = kw.replace(/[aeiou]/g, '');
  const trimmed = kw.length > 9 ? kw.slice(0, 8) : kw;
  const out = new Set([
    kw,
    `get${kw}`,
    `${trimmed}hq`,
    `${trimmed}hub`,
    `${trimmed}base`,
    `${trimmed}ly`,
    dropVowels.length >= 3 ? dropVowels : null,
    `${dropVowels}ly`,
    `${trimmed}go`,
    `${trimmed}box`,
  ]);
  return Array.from(out)
    .filter((n) => n && /^[a-z]{3,18}$/.test(n) && n !== 'get')
    .slice(0, MAX_CANDIDATES);
}

// ── Marketplace launch state: truthful, read from one small local file ──
function marketplaceStatus() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    return {
      state: raw.state === 'open' ? 'open' : 'coming-soon',
      note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : '',
    };
  } catch {
    return { state: 'coming-soon', note: '' };
  }
}

function marketplaceLine() {
  const s = marketplaceStatus();
  if (s.state === 'open') return 'The marketplace is open: https://haksterai.com/marketplace/';
  return [
    'The domain desk is live, the marketplace is coming soon.',
    s.note || 'Names can be checked today; nothing can be bought or reserved until the storefront opens.',
  ].join('\n');
}

// ── Waitlist: append-only, local, no secrets ──
function addToWaitlist(email, chatId) {
  const clean = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(clean) || clean.length > 120) {
    return { ok: false, error: 'that does not look like an email address' };
  }
  let data = { entries: [] };
  try { data = JSON.parse(fs.readFileSync(WAITLIST_FILE, 'utf8')); } catch { /* first entry */ }
  if (!Array.isArray(data.entries)) data.entries = [];
  const existing = data.entries.find((e) => e.email === clean);
  if (existing) return { ok: true, duplicate: true, count: data.entries.length };
  data.entries.push({ email: clean, chat_id: String(chatId || ''), added_at: new Date().toISOString() });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WAITLIST_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  } catch (e) {
    return { ok: false, error: `waitlist write failed: ${e.message.slice(0, 60)}` };
  }
  return { ok: true, count: data.entries.length };
}

// ── Replies ──
function formatCheck(r) {
  if (r.status === 'invalid') return `That does not look like a domain name. Try: pawfect.com`;
  if (r.status === 'invalid-tld') {
    return `.${r.tld} is not a real registry suffix (not in the IANA list). Try .com, .co, .io, .app, .dev, .shop or .site.`;
  }
  if (r.status === 'rate-limited') {
    return `The registry is rate-limiting lookups right now for ${r.name}. Try again in a minute — I will not guess.`;
  }
  if (r.status === 'unknown') {
    return [
      `Could not confirm ${r.name}.`,
      r.detail ? `Registry said: ${r.detail}.` : '',
      'Treat it as unknown — never as available.',
    ].filter(Boolean).join('\n');
  }
  if (r.status === 'registered') {
    return [
      `${r.name} — REGISTERED`,
      r.created ? `Registered: ${r.created}` : '',
      r.registrar ? `Registrar on record: ${r.registrar}` : '',
      '',
      'That is registry data, not a sale listing. If you want it, it has to be bought from its owner or a broker.',
    ].filter(Boolean).join('\n');
  }
  return [
    `${r.name} — NO REGISTRATION RECORD`,
    '',
    'The registry shows nothing registered at that exact name, which usually means it is available.',
    'Only a registrar can confirm that at checkout — I do not reserve or buy names.',
  ].join('\n');
}

function formatList(name, results) {
  const available = results.filter((r) => r.status === 'available');
  const taken = results.filter((r) => r.status === 'registered');
  const unsure = results.filter((r) => !['available', 'registered'].includes(r.status));
  const lines = [`Name ideas for "${name}"`];
  if (available.length) {
    lines.push('', 'No registry record:');
    available.forEach((r) => lines.push(`  ${r.name}`));
  }
  if (taken.length) {
    lines.push('', 'Already registered:');
    taken.forEach((r) => lines.push(`  ${r.name}`));
  }
  if (unsure.length) {
    lines.push('', 'Could not confirm:');
    unsure.forEach((r) => lines.push(`  ${r.name}`));
  }
  lines.push('', 'Registry data only. A registrar confirms availability at checkout; nothing here is reserved.');
  return lines.join('\n');
}

const HELP = [
  'Domain desk — marketplace',
  '',
  '/check <name>      is it registered? (e.g. /check pawfect.com)',
  '/find <keyword>    short, easy-to-spell name ideas (e.g. /find trailer)',
  '/tlds              the suffixes this desk quotes',
  '/market            marketplace status and the storefront link',
  '/waitlist <email>  be told when the marketplace opens',
  '/help              this list',
  '',
  'Checks use public registry (RDAP) data. No name is bought, held or reserved here.',
].join('\n');

function startMessage() {
  return [
    'Domain desk — HaksterAI marketplace',
    '',
    marketplaceLine(),
    '',
    'I can check whether a name is already registered and pull short name ideas for a product.',
    'Send /check <name> or /find <keyword>. /help for the rest.',
  ].join('\n');
}

function throttle(chatId) {
  const now = Date.now();
  const entry = chatHits.get(chatId) || { at: now, count: 0 };
  if (now - entry.at > PER_CHAT_WINDOW_MS) { entry.at = now; entry.count = 0; }
  entry.count += 1;
  chatHits.set(chatId, entry);
  if (chatHits.size > 2000) chatHits.delete(chatHits.keys().next().value);
  return entry.count <= PER_CHAT_LIMIT;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCheck(args) {
  const target = args.trim();
  if (!target) return 'Send the name with the command, e.g. /check pawfect.com';
  return formatCheck(await checkDomain(target));
}

async function runFind(args) {
  const keyword = args.trim().replace(/[^a-zA-Z ]/g, '').trim();
  if (!keyword) return 'Send a keyword, e.g. /find trailer';
  const forms = shortForms(keyword);
  if (!forms.length) return 'Give me a longer keyword and I will build names from it.';

  const results = [];
  for (const label of forms) {
    const name = `${label}.com`;
    results.push(await checkDomain(name));
    await sleep(250);
  }
  return formatList(keyword, results);
}

// Returns the reply text for a domain-desk command, or null when the text is not ours.
async function handleDomainCommand(text, ctx = {}) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const [cmdPart, ...rest] = raw.split(/\s+/);
  const cmd = cmdPart.toLowerCase().replace(/@[\w_]+$/, '');
  const args = rest.join(' ');

  const OURS = ['/start', '/help', '/check', '/find', '/tlds', '/market', '/waitlist', '/domain', '/domains'];
  if (!OURS.includes(cmd)) return null;

  if (cmd === '/start') return startMessage();
  if (cmd === '/help') return HELP;
  if (cmd === '/market') {
    const s = marketplaceStatus();
    return [
      marketplaceLine(),
      '',
      s.state === 'open'
        ? 'Names are checked and sold through the storefront.'
        : 'Until it opens, /check tells you what the registry says. Nothing is reserved.',
      '',
      'Storefront: https://haksterai.com/marketplace/',
    ].join('\n');
  }
  if (cmd === '/tlds') {
    return [
      'Suffixes this desk quotes: ' + PREFERRED_TLDS.map((t) => `.${t}`).join(' '),
      '',
      'Any real IANA suffix is checked on request — these are the ones that stay short and easy to spell out loud.',
    ].join('\n');
  }
  if (cmd === '/waitlist') {
    const r = addToWaitlist(args, ctx.chatId);
    if (!r.ok) return `Waitlist: ${r.error}. Send /waitlist you@example.com`;
    return r.duplicate
      ? `You are already on the waitlist (${r.count} on it). I will have the storefront announce openings there.`
      : `Added to the waitlist (${r.count} on it). Nothing is charged and no name is held.`;
  }

  if (!throttle(ctx.chatId || 'anon')) {
    return 'That is a lot of lookups in one minute — give it a minute and ask again. Registries rate-limit too.';
  }

  if (cmd === '/find') return runFind(args);
  // /check, /domain, /domains
  return runCheck(args);
}

module.exports = {
  handleDomainCommand,
  checkDomain,
  shortForms,
  marketplaceStatus,
  addToWaitlist,
  HELP,
  startMessage,
  PREFERRED_TLDS,
};
