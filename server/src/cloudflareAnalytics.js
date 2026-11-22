'use strict';

// Cloudflare GraphQL Analytics API adapter. Credentials are read in-process only
// — never returned to callers, logged or put in a command line (§9, §23).
//
// Best-effort source order (owner, 2026-11-22: "need traffic working at all
// times"): the real numbers come from first-party counters in siteAnalytics.js,
// always. This adapter only enriches the dashboard when a working token exists.
// It reads the server process environment first, then falls back to the owner's
// silent secret store ~/.secrets.env (export KEY=value, mode 600), re-read on
// every call so a rotated token takes effect without a restart.
const fs = require('fs');
const os = require('os');
const path = require('path');

// The Cloudflare API sits behind an IP allowlist that blocked IPv6 before
// (error 9109); prefer IPv4 for this process's lookups.
try { require('node:dns').setDefaultResultOrder('ipv4first'); } catch {}

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const SECRETS_FILE = path.join(os.homedir(), '.secrets.env');
const QUERY = `query HaksterTraffic($zoneTag: string, $start: Time, $end: Time) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    totals: httpRequestsAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_lt: $end, requestSource: "eyeball" }) {
      count sum { visits edgeResponseBytes }
    }
    pages: httpRequestsAdaptiveGroups(limit: 8, orderBy: [count_DESC], filter: { datetime_geq: $start, datetime_lt: $end, requestSource: "eyeball" }) {
      count sum { visits } dimensions { clientRequestPath }
    }
  } }
}`;

let cached = null;
let cachedAt = 0;
let inflight = null;

// Parse `export NAME=value` lines without ever echoing a value.
function readSecretsFile() {
  const out = {};
  let raw = '';
  try { raw = fs.readFileSync(SECRETS_FILE, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

function config() {
  const envToken = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  const envZone = String(process.env.CLOUDFLARE_ZONE_ID || '').trim();
  const envAccount = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const fallback = readSecretsFile();
  const token = envToken || String(fallback.CLOUDFLARE_API_TOKEN || '').trim();
  const zone = envZone || String(fallback.CLOUDFLARE_ZONE_ID || fallback.CF_ZONE_ID || '').trim();
  const account = envAccount || String(fallback.CLOUDFLARE_ACCOUNT_ID || '').trim();
  return { token, zone, account };
}

async function getSummary() {
  const { token, zone } = config();
  if (!token) {
    return { connected: false, configured: false, message: 'No Cloudflare API token on the server; first-party traffic is shown instead.' };
  }
  if (!zone) {
    return { connected: false, configured: false, message: 'Cloudflare token found but no zone ID configured; first-party traffic is shown instead.' };
  }
  if (cached && Date.now() - cachedAt < 60000) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 15 * 60 * 1000);
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { zoneTag: zone, start: start.toISOString(), end: end.toISOString() } }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Cloudflare Analytics returned HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error('Cloudflare Analytics query was rejected; check token permissions and zone ID.');
    const zoneData = json.data?.viewer?.zones?.[0];
    if (!zoneData) throw new Error('Cloudflare Analytics returned no zone data.');
    const total = zoneData.totals?.[0] || {};
    const result = {
      connected: true,
      configured: true,
      generatedAt: new Date().toISOString(),
      window: 'rolling 15m; eyeball traffic only',
      requests15m: Number(total.count || 0),
      visits15m: Number(total.sum?.visits || 0),
      edgeBytes15m: Number(total.sum?.edgeResponseBytes || 0),
      topPages: (zoneData.pages || []).map((row) => ({
        path: String(row.dimensions?.clientRequestPath || '/').split(/[?#]/, 1)[0].slice(0, 120),
        requests: Number(row.count || 0), visits: Number(row.sum?.visits || 0),
      })),
    };
    cached = result;
    cachedAt = Date.now();
    return result;
  })().catch((error) => ({ connected: false, configured: true, message: error.message }))
    .finally(() => { inflight = null; });
  return inflight;
}

module.exports = { getSummary };
