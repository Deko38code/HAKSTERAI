'use strict';

// Cloudflare GraphQL Analytics API adapter. Credentials are read only from the
// server process environment and are never returned to callers or logged.
const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
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

function config() {
  return {
    token: String(process.env.CLOUDFLARE_API_TOKEN || '').trim(),
    zone: String(process.env.CLOUDFLARE_ZONE_ID || '').trim(),
  };
}

async function getSummary() {
  const { token, zone } = config();
  if (!token || !zone) return { connected: false, configured: false, message: 'Cloudflare Analytics needs server-side CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID.' };
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
