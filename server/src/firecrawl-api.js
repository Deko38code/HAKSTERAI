'use strict';
/* Which Firecrawl API base to call, and how to read its answer.
 *
 * Owner, 2026-11-26: "i got noti saying firecralwer swithing to dev 2 on dec 10".
 * The documented current base is https://api.firecrawl.dev/v2 and v1 retires on
 * 2026-12-10, so v2 is tried first and v1 stays BEHIND it as a fallback — a version
 * migration must never cost a search or a scrape the older base can still answer
 * (the repo's fix-only rule: add the fallback, never replace working behaviour).
 *
 * The two versions are not the same shape. Measured live with a real key on
 * 2026-11-26: /scrape answers {success,data:{markdown,metadata}} on BOTH, so no
 * change is needed there; /search answers {data:[{url,title,description}]} on v1 but
 * {data:{web:[…]}} on v2 — read the old way, `data.map` is a TypeError. searchRows()
 * reads both, so no caller has to know which version answered.
 *
 * FIRECRAWL_BASE_URL, if set, pins one base (a proxy or a test endpoint) and the
 * fallback is off; it is not set on either box today.
 */
const DEFAULT_BASES = ['https://api.firecrawl.dev/v2', 'https://api.firecrawl.dev/v1'];

/** Bases to try, newest first. */
function apiBases() {
  const override = String(process.env.FIRECRAWL_BASE_URL || '').trim().replace(/\/+$/, '');
  return override ? [override] : DEFAULT_BASES.slice();
}

/** True when the answer is about the key (auth / rate limit), which no other API version fixes. */
function isAccountFailure(status) {
  return [401, 403, 429].includes(Number(status));
}

/** Normalise a /search body (v1 data[] or v2 data.web[]) into {title, url, snippet} rows. */
function searchRows(json) {
  const data = json && json.data !== undefined ? json.data : json && json.results;
  const rows = Array.isArray(data) ? data : Array.isArray(data && data.web) ? data.web : [];
  return rows.map((r) => ({
    title: r.title || r.metadata?.title || '(No title)',
    url: r.url || r.metadata?.sourceURL || '',
    snippet: r.description || r.markdown?.slice(0, 300) || '',
  }));
}

module.exports = { apiBases, isAccountFailure, searchRows, DEFAULT_BASES };
