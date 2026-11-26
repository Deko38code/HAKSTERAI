/* shodan.js — live Shodan results from the terminal.
 *
 * Owner 2026-11-23: "shodan". A one-line search across Shodan's own API, with
 * the web link for every host so the operator can open it in the browser.
 *
 * The key is read in-process — from SHODAN_API_KEY or ~/.hakster/config.json
 * (`hakster config set shodanKey` prompts hidden) — and is never printed, never
 * logged, never put in argv, and never echoed in an error (§9, §23). If no key
 * is set this says exactly what to run; it does not invent results (§10).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { haksterDir } = require('./home-dir');

const CONFIG_FILE = path.join(haksterDir(), 'config.json');
const API = 'https://api.shodan.io';
const TIMEOUT_MS = 15000;

function apiKey() {
  if (process.env.SHODAN_API_KEY) return String(process.env.SHODAN_API_KEY).trim();
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg && typeof cfg.shodanKey === 'string' && cfg.shodanKey.trim()) return cfg.shodanKey.trim();
  } catch { /* no config */ }
  return '';
}

/** Fetch a Shodan endpoint. The key goes in the query string, which is why the
 *  URL is never logged or included in an error message. */
async function call(endpoint, params = {}) {
  const key = apiKey();
  if (!key) return { ok: false, reason: 'no Shodan API key is set', needsKey: true };
  const qs = new URLSearchParams({ key, ...params });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${endpoint}?${qs}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'haksterai-cli (+https://haksterai.com)' },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (body && body.error) ? String(body.error).replace(key, '<key>') : `http ${res.status}`;
      return { ok: false, reason: msg };
    }
    return { ok: true, data: body };
  } catch (e) {
    const reason = e && e.name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000}s` : (e && e.message) || 'request failed';
    return { ok: false, reason: String(reason).replace(key, '<key>') };
  } finally {
    clearTimeout(timer);
  }
}

/** Search hosts. Returns { ok, total, matches:[{ip,port,org,hostnames,transport,product,link}] }. */
async function search(query, { limit = 15 } = {}) {
  const r = await call('/shodan/host/search', { query: String(query), minify: 'true' });
  if (!r.ok) return r;
  const d = r.data || {};
  const matches = (Array.isArray(d.matches) ? d.matches : []).slice(0, limit).map((m) => ({
    ip: m.ip_str || '',
    port: m.port || null,
    org: m.org || m.isp || '',
    hostnames: Array.isArray(m.hostnames) ? m.hostnames : [],
    transport: m.transport || '',
    product: m.product || '',
    link: m.ip_str ? `https://www.shodan.io/host/${encodeURIComponent(m.ip_str)}` : '',
  }));
  return { ok: true, total: d.total || matches.length, matches };
}

/** One host's record. Returns { ok, host:{...}, link }. */
async function host(ip) {
  const r = await call(`/shodan/host/${encodeURIComponent(ip)}`);
  if (!r.ok) return r;
  const d = r.data || {};
  return { ok: true, link: `https://www.shodan.io/host/${encodeURIComponent(ip)}`, host: d };
}

module.exports = { search, host, apiKey };
