'use strict';
/* ════════════════════════════════════════════════════════════════════════
 * Ad client — one place an auction request is built, and one place a served
 * impression or click is acknowledged.
 *
 * Points at YOUR OWN ad service (`HAKSTER_ADS_URL`), not anyone else's. The
 * auction route is expected to answer:
 *
 *   POST /api/ads/auction   { placementId, surface, sessionId, context }
 *     -> { ads: [ { title, adText, url, impUrl, clickUrl, provider, ... } ],
 *          provider: 'first_party' }
 *
 * An empty `ads` array is a valid, honest reply: a no-fill. It is held by
 * ad-cache for the same window as a fill.
 *
 * PORTED FROM: CodebuffAI/freebuff `cli/src/ads/ad-request.ts` (Apache-2.0).
 * See ATTRIBUTION.md. Changes: Freebuff's auth token, device fingerprint,
 * dock-arm and sponsored-capability plumbing are removed — this talks to a
 * local harness endpoint and carries only the placement, the surface and an
 * optional session id.
 * ════════════════════════════════════════════════════════════════════════ */

const { getAd, resetAdCache, recordImpression, renderDelaySinceReceipt, adSessionSnapshot } = require('./ad-cache');
const { sanitizeTerminalStrings } = require('./terminal-safe-text');

const ADS_URL = (process.env.HAKSTER_ADS_URL || process.env.HAKSTER_API_URL || 'http://localhost:3579').replace(/\/+$/, '');
const ADS_ENABLED = process.env.HAKSTER_ADS !== '0' && process.env.HAKSTER_ADS !== 'false';

/** Placement ids this harness auctions. Mirrors Freebuff's per-slot registry. */
const PLACEMENTS = {
  tuiComposer: 'CLI-Composer',
  tuiRail: 'CLI-Rail',
  tuiSplash: 'CLI-Splash',
};

const DEFAULT_ANNOUNCED = [PLACEMENTS.tuiRail, PLACEMENTS.tuiComposer, PLACEMENTS.tuiSplash];

let announcedCache = null;
let announcedAt = 0;
const ANNOUNCE_TTL_MS = 10 * 60_000;

/** What the policy endpoint says this session may ask for. */
async function announcedPlacements() {
  if (announcedCache && Date.now() - announcedAt < ANNOUNCE_TTL_MS) return announcedCache;
  try {
    const r = await fetch(`${ADS_URL}/api/ads/placements`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.placements)) {
        announcedCache = j.placements;
        announcedAt = Date.now();
        return announcedCache;
      }
    }
  } catch {
    /* fall through to the local default */
  }
  // The local service being down must not blank the UI; the default list is
  // what this harness is allowed to ask for anyway.
  announcedCache = DEFAULT_ANNOUNCED;
  announcedAt = Date.now();
  return announcedCache;
}

async function fetchAuction(placementId, context = {}) {
  const r = await fetch(`${ADS_URL}/api/ads/auction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      placementId,
      surface: 'cli_tui',
      sessionId: process.env.HAKSTER_SESSION_ID || null,
      context,
    }),
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) return null;
  return r.json();
}

/** One placement's ad, or null. Safe to call on every render. */
function getPlacementAd(placementId, context) {
  return getAd(placementId, {
    adsEnabled: () => ADS_ENABLED,
    // A local harness has no per-user ad token; the auction route is local.
    authToken: () => process.env.HAKSTER_ADS_TOKEN || 'local',
    announcedPlacements: () => announcedPlacements(),
    fetchAuction: (id) => fetchAuction(id, context),
    sanitize: sanitizeTerminalStrings,
    requireFirstParty: true,
  });
}

/** Acknowledge one impression, at most once per held answer. */
function ackImpression(ad) {
  return recordImpression(ad, (a) => {
    const delay = renderDelaySinceReceipt(a);
    fetch(`${ADS_URL}/api/ads/impression`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impUrl: a.impUrl,
        placementId: a.placementId || 'unknown',
        clientFamily: 'cli',
        ...(delay !== undefined ? { renderDelayMs: delay } : {}),
      }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    // The receipt is handed to the network; ad-cache owns the once-per-answer
    // rule, so this reports success rather than waiting on the socket.
    return true;
  });
}

/** Report a click on an ad row. Fire-and-forget, like the impression. */
function recordClick(ad) {
  if (!ad || !ad.impUrl) return false;
  fetch(`${ADS_URL}/api/ads/click`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ impUrl: ad.impUrl, placementId: ad.placementId || 'unknown', url: ad.clickUrl || ad.url || '' }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
  return true;
}

module.exports = {
  ADS_URL,
  PLACEMENTS,
  getPlacementAd,
  ackImpression,
  recordClick,
  announcedPlacements,
  resetAdCache,
  adSessionSnapshot,
  _setAnnouncedCache: (v) => { announcedCache = v; announcedAt = Date.now(); },
};
