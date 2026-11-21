'use strict';
/* ════════════════════════════════════════════════════════════════════════
 * Ad cache — the timing rules that make an in-terminal ad slot behave.
 *
 * A terminal slot mounts and unmounts constantly (a slash menu opens on a
 * keystroke). Without these rules a placement would re-auction on every
 * keystroke, and the busiest slot in the app would be asking hardest exactly
 * when there is nothing to serve it. Four rules, all of them ordering/timing:
 *
 *  1. THE HOLD. One answer per placement for TTL_MS. A NO-FILL IS HELD JUST AS
 *     FIRMLY AS A FILL — otherwise a paced-out slot still re-auctions per
 *     keystroke.
 *  2. IN-FLIGHT DEDUPE. Concurrent asks for the same placement share one
 *     request.
 *  3. ONE IMPRESSION PER HELD ANSWER. The acknowledged set is keyed by the
 *     impression token and lives at MODULE scope, not in a component ref,
 *     because the row remounts against the same held fill. A per-component
 *     guard would reset exactly when it is needed and turn billing into a
 *     function of how often someone opens a menu.
 *  4. CACHE OWNER SYNC. A held fill is one account's answer. Comparing the
 *     token on the way in catches a sign-out, a sign-in and a switch between
 *     accounts with one rule and no cooperation from the logout path.
 *
 * PORTED FROM: CodebuffAI/freebuff `cli/src/ads/partner-ads.ts` + `ad-signals.ts`
 * (Apache-2.0). See ATTRIBUTION.md. Changes: TypeScript -> CommonJS; the
 * Freebuff placement registry, policy endpoint and telemetry are replaced by
 * injected deps so this stays dependency-free and testable.
 * ════════════════════════════════════════════════════════════════════════ */

/** How long one answer is held before the slot re-auctions. */
const AD_TTL_MS = 30 * 60_000;

/** @type {Map<string, {ad: object|null, expiresAt: number}>} */
const held = new Map();
/** @type {Map<string, Promise<object|null>>} */
const inFlight = new Map();
/** Impression tokens already acknowledged. Module scope, deliberately. */
const ackedImpressions = new Set();
/** Which account the three collections above belong to. */
let cacheOwner = null;
/** Rolling signal counters, mirroring ad-signals' session snapshot. */
const signals = { served: 0, failed: 0, held: 0, rtMs: [] };

function resetAdCache() {
  held.clear();
  inFlight.clear();
  ackedImpressions.clear();
  cacheOwner = null;
}

/**
 * Drop everything cached for a different account.
 *
 * Self-healing rather than wired into a logout path: comparing on the way in
 * catches every way the account can change with one rule.
 */
function syncCacheOwner(token) {
  if (cacheOwner === token) return false;
  if (cacheOwner !== null) resetAdCache();
  cacheOwner = token;
  return true;
}

/**
 * A gate result, mirroring Freebuff's four refusals. Every one is the same
 * answer to the caller — null, draw nothing — because a partner slot has no
 * fallback: the only honest thing to put there when the deal is not serving is
 * nothing at all.
 *
 *  - ADS ARE OFF for this session.
 *  - THE PLACEMENT is not announced for this session (the deal is not live, so
 *    asking would spend a round trip to be refused).
 *  - NO impression URL. An ad that cannot be acknowledged cannot be billed.
 *  - NOT OUR OWN INVENTORY. A fill from a network we do not measure is the one
 *    thing a branded row may never draw.
 */
function refusalReason({ adsEnabled, announcedIds, placementId, ad, provider, requireFirstParty }) {
  if (!adsEnabled) return 'ads-off';
  if (announcedIds && !announcedIds.includes(placementId)) return 'placement-not-announced';
  if (!ad) return null; // an honest no-fill, not a refusal
  if (!ad.impUrl) return 'no-impression-url';
  if (requireFirstParty && provider !== 'first_party') return 'foreign-fill';
  return null;
}

/**
 * One placement's ad, or null.
 *
 * `deps` is injected rather than imported so the hold, the dedupe and the
 * refusals — the whole behaviour of this module, all of it timing and ordering
 * — can be driven by a test with a fake clock and a request counter.
 */
async function getAd(placementId, deps) {
  const {
    adsEnabled,
    authToken,
    announcedPlacements = async () => null,
    fetchAuction,
    sanitize = (x) => x,
    requireFirstParty = true,
    ttlMs = AD_TTL_MS,
    now = Date.now,
  } = deps;

  if (!adsEnabled()) return null;
  const token = authToken();
  if (!token) return null;
  syncCacheOwner(token);

  const answer = held.get(placementId);
  if (answer && now() < answer.expiresAt) return answer.ad;
  const pending = inFlight.get(placementId);
  if (pending) return pending;

  const request = (async () => {
    // The deal may not be live for this session. Asking anyway would spend a
    // round trip to be refused, so the announcement gate is checked first.
    const announcedIds = await announcedPlacements();
    if (refusalReason({ adsEnabled: adsEnabled(), announcedIds, placementId })) return null;

    const startedAt = now();
    let data;
    try {
      data = await fetchAuction(placementId);
    } catch {
      signals.failed++;
      throw new Error('auction-failed');
    }
    const elapsed = now() - startedAt;
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      signals.rtMs.push(elapsed);
      if (signals.rtMs.length > 20) signals.rtMs.shift();
    }

    // Advertiser-written text is drawn in the terminal: no escape sequences.
    const raw = data && Array.isArray(data.ads) ? data.ads[0] : undefined;
    const ad = raw ? sanitize(raw) : undefined;
    // A no-fill is not a refusal, but it is still nothing to draw. Spreading an
    // empty ad here would hand the caller a truthy object it would try to render.
    if (!ad) return null;
    const provider = (data && data.provider) || ad.provider;
    if (refusalReason({ adsEnabled: true, ad, provider, requireFirstParty })) return null;

    return { ...ad, provider, placementId, receivedAtMs: now() };
  })()
    .catch(() => null)
    .then((ad) => {
      inFlight.delete(placementId);
      // A no-fill is held for the same window as a fill.
      held.set(placementId, { ad, expiresAt: now() + ttlMs });
      if (ad) signals.served++; else signals.held++;
      return ad;
    });

  inFlight.set(placementId, request);
  return request;
}

/**
 * Acknowledge one impression, at most once per held answer.
 * `ack` receives the ad and returns true when the receipt was dispatched.
 */
function recordImpression(ad, ack) {
  if (!ad || !ad.impUrl) return false;
  if (ackedImpressions.has(ad.impUrl)) return false;
  ackedImpressions.add(ad.impUrl);
  let dispatched = false;
  try {
    dispatched = ack(ad) !== false;
  } catch {
    dispatched = false;
  }
  if (!dispatched) {
    // Unreachable while foreign fills are refused. Left as a rollback rather
    // than a second transport: an impression we cannot bill is one to notice,
    // not one to send another way.
    ackedImpressions.delete(ad.impUrl);
  }
  return dispatched;
}

/** Milliseconds between the ad arriving and the row being drawn (COD-365). */
function renderDelaySinceReceipt(ad, now = Date.now) {
  if (!ad || typeof ad.receivedAtMs !== 'number') return undefined;
  const d = now() - ad.receivedAtMs;
  return Number.isFinite(d) && d >= 0 ? d : undefined;
}

function adSessionSnapshot() {
  return {
    adsServed: signals.served,
    adsHeld: signals.held,
    failedRequests: signals.failed,
    rttSamplesMs: signals.rtMs.slice(),
  };
}

module.exports = {
  AD_TTL_MS,
  getAd,
  resetAdCache,
  syncCacheOwner,
  recordImpression,
  renderDelaySinceReceipt,
  adSessionSnapshot,
  refusalReason,
  // exported for tests
  _internals: { held, inFlight, ackedImpressions, signals },
};
