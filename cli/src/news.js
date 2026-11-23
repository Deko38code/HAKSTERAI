/* news.js — live AI and security headlines, straight into the CLI.
 *
 * Owner 2026-11-23: "our cli need live links updates to all ai news out hacking
 * etc". Nothing is scraped and nothing is stored on the server: this reads the
 * publishers' own public feeds over HTTPS, keeps only the fields a link line
 * needs, and caches the normalised list for a few minutes so `--watch` and a
 * second command do not hammer anyone.
 *
 * Rules this respects:
 *  - Read-only (CLAUDE.md is about our own hosts; the same courtesy applies to
 *    other people's feeds): no logins, no cookies, bounded timeout, one request
 *    per feed per cache window, a real User-Agent naming the CLI.
 *  - No fabrication (§10): a feed that fails is reported as failed, with the
 *    reason. A headline's age is computed from its own date, never invented.
 *  - Configurable, additively: ~/.hakster/feeds.json may list extra feeds; the
 *    built-in list is never removed by a config file, only added to.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const NEWS_DIR = path.join(os.homedir(), '.hakster');
const NEWS_CACHE = path.join(NEWS_DIR, 'news-cache.json');
const FEEDS_FILE = path.join(NEWS_DIR, 'feeds.json');
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 7000;

// A small, public, no-key set. Each entry's `topic` decides which group it
// belongs to; `hack` is security/hacking news, `ai` is AI/ML news, `exploit` is
// the live vulnerability/exploit databases themselves. A feed that answers JSON
// carries its own mapper; an XML feed is parsed as RSS/Atom.
// (Owner 2026-11-23: "need live links to db exploit etc web" and "shodan".)
const DEFAULT_FEEDS = [
  { source: 'Hacker News', topic: 'ai', url: 'https://news.ycombinator.com/rss', filter: /\b(ai|llm|gpt|claude|anthropic|openai|model|agent|deepmind|gemini|machine learning|neural)\b/i },
  { source: 'TechCrunch AI', topic: 'ai', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { source: 'VentureBeat AI', topic: 'ai', url: 'https://venturebeat.com/category/ai/feed/' },
  { source: 'MIT Technology Review', topic: 'ai', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed/' },
  { source: 'The Hacker News', topic: 'hack', url: 'https://feeds.feedburner.com/TheHackersNews' },
  { source: 'BleepingComputer', topic: 'hack', url: 'https://www.bleepingcomputer.com/feed/' },
  { source: 'Krebs on Security', topic: 'hack', url: 'https://krebsonsecurity.com/feed/' },
  { source: 'Dark Reading', topic: 'hack', url: 'https://www.darkreading.com/rss.xml' },
  { source: 'CISA Advisories', topic: 'hack', url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml' },
  { source: 'Shodan Blog', topic: 'hack', url: 'https://blog.shodan.io/rss/' },
  { source: 'Hacker News', topic: 'hack', url: 'https://news.ycombinator.com/rss', filter: /\b(hack|cve|exploit|breach|ransom|phish|malware|vulnerab|0day|zero-day|leak|pentest)\b/i },
  // ── the databases ────────────────────────────────────────────────────────
  { source: 'Exploit-DB', topic: 'exploit', url: 'https://www.exploit-db.com/rss.xml' },
  { source: 'MSRC', topic: 'exploit', url: 'https://api.msrc.microsoft.com/update-guide/rss' },
  {
    source: 'CISA KEV',
    topic: 'exploit',
    url: 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
    json: (d) => (Array.isArray(d && d.vulnerabilities) ? d.vulnerabilities : [])
      .slice()
      .sort((a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')))
      .slice(0, 60)
      .map((v) => ({
        title: `${v.cveID} — ${v.vendorProject || ''} ${v.product || ''}`.trim(),
        url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(v.cveID || '')}`,
        summary: v.vulnerabilityName || v.shortDescription || '',
        ts: Date.parse(v.dateAdded || '') || null,
      })),
  },
  {
    source: 'GitHub Advisories',
    topic: 'exploit',
    url: 'https://api.github.com/advisories?per_page=25&sort=published&direction=desc',
    json: (d) => (Array.isArray(d) ? d : []).map((a) => ({
      title: `${a.cve_id || a.ghsa_id} — ${a.severity || ''} — ${a.summary || ''}`.replace(/\s+/g, ' ').trim(),
      url: a.html_url || `https://github.com/advisories/${a.ghsa_id || ''}`,
      summary: a.summary || '',
      ts: Date.parse(a.published_at || '') || null,
    })),
  },
  {
    source: 'NVD',
    topic: 'exploit',
    url: 'https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=25',
    json: (d) => (((d && d.vulnerabilities) || [])).map((v) => {
      const c = (v && v.cve) || {};
      const desc = (Array.isArray(c.descriptions) ? c.descriptions.find((x) => x && x.lang === 'en') : null) || {};
      return {
        title: `${c.id || 'CVE'} — ${desc.value || ''}`.slice(0, 240),
        url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(c.id || '')}`,
        summary: desc.value || '',
        ts: Date.parse(c.published || '') || null,
      };
    }),
  },
];

function loadExtraFeeds() {
  try {
    const raw = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.feeds) ? raw.feeds : [];
    return list
      .filter((f) => f && typeof f.url === 'string' && /^https?:\/\//i.test(f.url))
      .map((f) => ({
        source: String(f.source || new URL(f.url).hostname),
        topic: f.topic === 'hack' ? 'hack' : 'ai',
        url: f.url,
        filter: null,
      }));
  } catch {
    return [];
  }
}

const decode = (s) => String(s == null ? '' : s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}

function link(block) {
  // RSS: <link>url</link>. Atom: <link rel="alternate" href="url"/>
  const plain = tag(block, 'link');
  if (plain) return plain;
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    || block.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["']/i)
    || block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return alt ? decode(alt[1]) : '';
}

function dateOf(block) {
  const raw = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date');
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Parse RSS 2.0 or Atom into a flat list. Never throws on malformed XML. */
function parseFeed(xml, feed) {
  const blocks = [];
  const itemRe = /<item[\s>][\s\S]*?<\/item>|<item>[\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi;
  let m;
  while ((m = itemRe.exec(xml))) blocks.push(m[0]);
  const out = [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    const url = link(b);
    if (!title || !url || !/^https?:\/\//i.test(url)) continue;
    const summary = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content');
    const hay = `${title} ${summary}`;
    if (feed.filter && !feed.filter.test(hay)) continue;
    out.push({
      title,
      url,
      source: feed.source,
      topic: feed.topic,
      ts: dateOf(b),
      summary: summary.length > 200 ? `${summary.slice(0, 199)}…` : summary,
    });
  }
  return out;
}

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'haksterai-cli (+https://haksterai.com)',
        accept: feed.json
          ? 'application/json'
          : 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
      },
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const body = await res.text();
    let items;
    if (feed.json) {
      let data;
      try { data = JSON.parse(body); } catch { throw new Error('not valid JSON'); }
      items = feed.json(data).filter((it) => it && it.title && /^https?:\/\//i.test(String(it.url || '')));
    } else {
      items = parseFeed(body, feed);
    }
    // A filtered feed that matches nothing is not a failure — the filter is
    // ours, the feed answered fine.
    if (!items.length && !feed.filter) throw new Error('no readable items');
    // Feeds are newest-first; a whole archive is never wanted, and the cache
    // would grow without bound (Exploit-DB publishes tens of thousands).
    if (items.length > 60) items = items.slice(0, 60);
    return {
      feed,
      items: items.map((it) => ({
        title: String(it.title).slice(0, 300),
        url: String(it.url),
        source: feed.source,
        topic: feed.topic,
        ts: Number.isFinite(it.ts) ? it.ts : null,
        summary: String(it.summary || '').slice(0, 200),
      })),
    };
  } catch (e) {
    const reason = e && e.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : (e && e.message) || 'failed';
    return { feed, items: [], error: reason };
  } finally {
    clearTimeout(timer);
  }
}

function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(NEWS_CACHE, 'utf8'));
    if (!c || !Array.isArray(c.items) || !Number.isFinite(c.savedAt)) return null;
    return c;
  } catch {
    return null;
  }
}

function writeCache(payload) {
  try {
    if (!fs.existsSync(NEWS_DIR)) fs.mkdirSync(NEWS_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${NEWS_CACHE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, NEWS_CACHE);
  } catch {
    /* a cache that cannot be written is not a failure to show the news */
  }
}

/**
 * Fetch every feed (or serve the cache), dedupe by URL and title, and return
 * newest-first: { items, errors, fetchedAt, fromCache }.
 */
async function getNews({ refresh = false, topics = null } = {}) {
  const now = Date.now();
  let cache = refresh ? null : readCache();
  let fromCache = false;
  if (cache && now - cache.savedAt < CACHE_TTL_MS) {
    fromCache = true;
  } else {
    const feeds = DEFAULT_FEEDS.concat(loadExtraFeeds());
    const results = await Promise.all(feeds.map(fetchFeed));
    const seen = new Set();
    const items = [];
    const errors = [];
    for (const r of results) {
      if (r.error) { errors.push({ source: r.feed.source, url: r.feed.url, error: r.error }); continue; }
      for (const it of r.items) {
        const key = `${it.url.replace(/[?#].*$/, '')}|${it.title.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(it);
      }
    }
    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    cache = { savedAt: now, items, errors };
    writeCache(cache);
    fromCache = false;
  }
  let items = cache.items;
  if (topics && topics.length) items = items.filter((it) => topics.includes(it.topic));
  return { items, errors: cache.errors || [], fetchedAt: cache.savedAt, fromCache };
}

/** "3m", "4h", "2d" — from the item's own date; '' when the feed gave none. */
function age(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

module.exports = { getNews, age, parseFeed, DEFAULT_FEEDS, FEEDS_FILE, NEWS_CACHE, CACHE_TTL_MS };
