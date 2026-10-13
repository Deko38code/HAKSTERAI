'use strict';
/* ════════════════════════════════════════════════════════════════════════
 * Local ad service — the harness's OWN inventory.
 *
 * This is deliberately not a copy of anyone's ad data. The inventory below is
 * house creative for sites this harness already runs, which is the honest
 * starting point: an operator has to own the inventory it serves, or the
 * impressions it reports are meaningless.
 *
 * To put real advertisers here, replace `INVENTORY` (or load it from a file)
 * with your own sold campaigns. Every ad must carry an `impUrl` — the client
 * refuses to draw one without it, because an impression that cannot be
 * acknowledged cannot be billed.
 *
 * Mounted by server/src/index.js via `mountAds(app)`.
 * ════════════════════════════════════════════════════════════════════════ */

const INVENTORY = [
  {
    id: 'house-haksterai',
    partnerBrand: 'haksterai',
    placements: ['CLI-Rail', 'CLI-Composer', 'CLI-Splash'],
    title: 'haksterAi — your own agent harness',
    adText: 'Agent team, tools, MCP bridges and a live TUI in one stack.',
    url: 'https://haksterai.com',
  },
  {
    id: 'house-phantomide',
    partnerBrand: 'phantomide',
    placements: ['CLI-Rail', 'CLI-Composer'],
    title: 'Phantom IDE',
    adText: 'A browser IDE with a gateway that does not need an API key.',
    url: 'https://phantomide.com',
  },
  {
    id: 'house-rmt',
    partnerBrand: 'rmt',
    placements: ['CLI-Rail'],
    title: 'Rent My Trailer',
    adText: 'Peer-to-peer trailer rentals across the US.',
    url: 'https://rmt.haksterai.com',
  },
  {
    id: 'house-flixchill',
    partnerBrand: 'flixchill',
    placements: ['CLI-Splash'],
    title: 'FlixChill',
    adText: 'Where to watch — with your own group.',
    url: 'https://flixchill.link',
  },
];

/** Placement ids the client may ask for. Mirrors cli/src/ads/ad-client.js. */
const PLACEMENTS = ['CLI-Rail', 'CLI-Composer', 'CLI-Splash'];

const stats = {
  auctions: 0,
  fills: 0,
  noFills: 0,
  impressions: 0,
  clicks: 0,
  byPlacement: {},
  recent: [],
};

/* Only the per-placement bucket. The global counters are incremented by the
 * route that owns them, so incrementing here too would count every event twice. */
function bump(placementId, field) {
  const p = (stats.byPlacement[placementId] ||= { auctions: 0, fills: 0, impressions: 0, clicks: 0 });
  if (p[field] !== undefined) p[field]++;
}

function pushRecent(entry) {
  stats.recent.unshift({ at: new Date().toISOString(), ...entry });
  if (stats.recent.length > 50) stats.recent.length = 50;
}

/* Deterministic rotation rather than random, so two identical requests in a
 * row do not flicker between creatives, and so a test can predict the answer. */
const rotation = new Map();

function pickAd(placementId) {
  const eligible = INVENTORY.filter((a) => a.placements.includes(placementId));
  if (!eligible.length) return null;
  const i = (rotation.get(placementId) || 0) % eligible.length;
  rotation.set(placementId, i + 1);
  return eligible[i];
}

function mountAds(app, { basePath = '/api/ads' } = {}) {
  // Which placements this session is allowed to ask for. The client treats a
  // placement that is not announced as "the deal is not live" and never calls
  // the auction route for it.
  app.get(`${basePath}/placements`, (_req, res) => {
    res.json({ placements: PLACEMENTS });
  });

  app.post(`${basePath}/auction`, (req, res) => {
    const placementId = String((req.body && req.body.placementId) || '');
    const context = (req.body && req.body.context) || {};
    stats.auctions++;
    const row = (stats.byPlacement[placementId] ||= { auctions: 0, fills: 0, impressions: 0, clicks: 0 });
    row.auctions++;

    if (!PLACEMENTS.includes(placementId)) {
      stats.noFills++;
      return res.json({ ads: [], provider: 'first_party', reason: 'unknown-placement' });
    }
    const ad = pickAd(placementId);
    if (!ad) {
      stats.noFills++;
      return res.json({ ads: [], provider: 'first_party', reason: 'no-inventory' });
    }

    stats.fills++;
    row.fills++;
    // A local token doubles as the impression id. It has to be unique per
    // served ad, which is what makes "one impression per held answer" work.
    const token = `${ad.id}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    pushRecent({ event: 'fill', placementId, ad: ad.id });
    res.json({
      provider: 'first_party',
      ads: [
        {
          title: ad.title,
          adText: ad.adText,
          url: ad.url,
          clickUrl: ad.url,
          impUrl: token,
          partnerBrand: ad.partnerBrand,
          provider: 'first_party',
          // Context is echoed back only so a caller can see what it sent; the
          // house inventory does not target on it.
          matchedContextKeys: Object.keys(context).slice(0, 8),
        },
      ],
    });
  });

  app.post(`${basePath}/impression`, (req, res) => {
    const placementId = String((req.body && req.body.placementId) || 'unknown');
    stats.impressions++;
    bump(placementId, 'impressions');
    pushRecent({ event: 'impression', placementId, renderDelayMs: (req.body || {}).renderDelayMs });
    res.json({ ok: true });
  });

  app.post(`${basePath}/click`, (req, res) => {
    const placementId = String((req.body && req.body.placementId) || 'unknown');
    stats.clicks++;
    bump(placementId, 'clicks');
    pushRecent({ event: 'click', placementId, url: (req.body || {}).url });
    res.json({ ok: true, url: (req.body || {}).url || null });
  });

  // The only route that echoes inventory back out, so an operator can see what
  // is being served without reading the source.
  app.get(`${basePath}/inventory`, (_req, res) => {
    res.json({ placements: PLACEMENTS, count: INVENTORY.length, inventory: INVENTORY.map(({ placements, ...a }) => ({ ...a, placements })) });
  });

  app.get(`${basePath}/stats`, (_req, res) => {
    res.json({ ...stats });
  });

  return app;
}

module.exports = { mountAds, INVENTORY, PLACEMENTS, stats: () => stats };
