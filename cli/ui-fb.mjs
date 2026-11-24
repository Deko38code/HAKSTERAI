// Built by esbuild from ui/src — do not edit. Run: node ui/build.mjs
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../src/ads/ad-cache.js
var require_ad_cache = __commonJS({
  "../src/ads/ad-cache.js"(exports, module) {
    "use strict";
    var AD_TTL_MS = 30 * 6e4;
    var held = /* @__PURE__ */ new Map();
    var inFlight = /* @__PURE__ */ new Map();
    var ackedImpressions = /* @__PURE__ */ new Set();
    var cacheOwner = null;
    var signals = { served: 0, failed: 0, held: 0, rtMs: [] };
    function resetAdCache() {
      held.clear();
      inFlight.clear();
      ackedImpressions.clear();
      cacheOwner = null;
    }
    function syncCacheOwner(token) {
      if (cacheOwner === token) return false;
      if (cacheOwner !== null) resetAdCache();
      cacheOwner = token;
      return true;
    }
    function refusalReason({ adsEnabled, announcedIds, placementId, ad, provider, requireFirstParty }) {
      if (!adsEnabled) return "ads-off";
      if (announcedIds && !announcedIds.includes(placementId)) return "placement-not-announced";
      if (!ad) return null;
      if (!ad.impUrl) return "no-impression-url";
      if (requireFirstParty && provider !== "first_party") return "foreign-fill";
      return null;
    }
    async function getAd(placementId, deps) {
      const {
        adsEnabled,
        authToken,
        announcedPlacements = async () => null,
        fetchAuction,
        sanitize = (x) => x,
        requireFirstParty = true,
        ttlMs = AD_TTL_MS,
        now = Date.now
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
        const announcedIds = await announcedPlacements();
        if (refusalReason({ adsEnabled: adsEnabled(), announcedIds, placementId })) return null;
        const startedAt = now();
        let data;
        try {
          data = await fetchAuction(placementId);
        } catch {
          signals.failed++;
          throw new Error("auction-failed");
        }
        const elapsed = now() - startedAt;
        if (Number.isFinite(elapsed) && elapsed >= 0) {
          signals.rtMs.push(elapsed);
          if (signals.rtMs.length > 20) signals.rtMs.shift();
        }
        const raw = data && Array.isArray(data.ads) ? data.ads[0] : void 0;
        const ad = raw ? sanitize(raw) : void 0;
        if (!ad) return null;
        const provider = data && data.provider || ad.provider;
        if (refusalReason({ adsEnabled: true, ad, provider, requireFirstParty })) return null;
        return { ...ad, provider, placementId, receivedAtMs: now() };
      })().catch(() => null).then((ad) => {
        inFlight.delete(placementId);
        held.set(placementId, { ad, expiresAt: now() + ttlMs });
        if (ad) signals.served++;
        else signals.held++;
        return ad;
      });
      inFlight.set(placementId, request);
      return request;
    }
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
        ackedImpressions.delete(ad.impUrl);
      }
      return dispatched;
    }
    function renderDelaySinceReceipt(ad, now = Date.now) {
      if (!ad || typeof ad.receivedAtMs !== "number") return void 0;
      const d = now() - ad.receivedAtMs;
      return Number.isFinite(d) && d >= 0 ? d : void 0;
    }
    function adSessionSnapshot() {
      return {
        adsServed: signals.served,
        adsHeld: signals.held,
        failedRequests: signals.failed,
        rttSamplesMs: signals.rtMs.slice()
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
      _internals: { held, inFlight, ackedImpressions, signals }
    };
  }
});

// ../src/ads/terminal-safe-text.js
var require_terminal_safe_text = __commonJS({
  "../src/ads/terminal-safe-text.js"(exports, module) {
    "use strict";
    var CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
    var OSC = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
    var STRING_COMMAND = /(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x07|\x9c|$)/g;
    var SHORT_ESCAPE = /\x1b[\x20-\x2f]*[\x30-\x7e]?/g;
    var CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
    var DEFAULT_IGNORABLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/gu;
    function sanitizeTerminalText(input) {
      if (typeof input !== "string" || input === "") return typeof input === "string" ? input : "";
      return input.replace(OSC, "").replace(STRING_COMMAND, "").replace(CSI, "").replace(SHORT_ESCAPE, "").replace(DEFAULT_IGNORABLE, "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(CONTROL, "");
    }
    function sanitizeTerminalOutput(input) {
      if (typeof input !== "string" || input === "") return input;
      const collapsed = input.includes("\r") ? input.replace(/\r+\n/g, "\n").split("\n").map((line) => line.slice(line.lastIndexOf("\r") + 1)).join("\n") : input;
      return sanitizeTerminalText(collapsed);
    }
    function sanitizeTerminalStrings(value, seen = /* @__PURE__ */ new WeakSet()) {
      if (typeof value === "string") return sanitizeTerminalText(value);
      if (value === null || typeof value !== "object") return value;
      if (seen.has(value)) return void 0;
      seen.add(value);
      if (Array.isArray(value)) return value.map((v) => sanitizeTerminalStrings(v, seen));
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
        const clean = sanitizeTerminalStrings(v, seen);
        if (clean !== void 0) out[sanitizeTerminalText(k)] = clean;
      }
      return out;
    }
    module.exports = {
      sanitizeTerminalText,
      sanitizeTerminalOutput,
      sanitizeTerminalStrings,
      // exported for tests
      _patterns: { CSI, OSC, STRING_COMMAND, SHORT_ESCAPE, CONTROL, DEFAULT_IGNORABLE }
    };
  }
});

// ../src/ads/ad-client.js
var require_ad_client = __commonJS({
  "../src/ads/ad-client.js"(exports, module) {
    "use strict";
    var { getAd, resetAdCache, recordImpression, renderDelaySinceReceipt, adSessionSnapshot } = require_ad_cache();
    var { sanitizeTerminalStrings } = require_terminal_safe_text();
    var ADS_URL = (process.env.HAKSTER_ADS_URL || process.env.HAKSTER_API_URL || "http://localhost:3579").replace(/\/+$/, "");
    var ADS_ENABLED = process.env.HAKSTER_ADS !== "0" && process.env.HAKSTER_ADS !== "false";
    var PLACEMENTS = {
      tuiComposer: "CLI-Composer",
      tuiRail: "CLI-Rail",
      tuiSplash: "CLI-Splash"
    };
    var DEFAULT_ANNOUNCED = [PLACEMENTS.tuiRail, PLACEMENTS.tuiComposer, PLACEMENTS.tuiSplash];
    var announcedCache = null;
    var announcedAt = 0;
    var ANNOUNCE_TTL_MS = 10 * 6e4;
    async function announcedPlacements() {
      if (announcedCache && Date.now() - announcedAt < ANNOUNCE_TTL_MS) return announcedCache;
      try {
        const r = await fetch(`${ADS_URL}/api/ads/placements`, { signal: AbortSignal.timeout(3e3) });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.placements)) {
            announcedCache = j.placements;
            announcedAt = Date.now();
            return announcedCache;
          }
        }
      } catch {
      }
      announcedCache = DEFAULT_ANNOUNCED;
      announcedAt = Date.now();
      return announcedCache;
    }
    async function fetchAuction(placementId, context = {}) {
      const r = await fetch(`${ADS_URL}/api/ads/auction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          placementId,
          surface: "cli_tui",
          sessionId: process.env.HAKSTER_SESSION_ID || null,
          context
        }),
        signal: AbortSignal.timeout(4e3)
      });
      if (!r.ok) return null;
      return r.json();
    }
    function getPlacementAd(placementId, context) {
      return getAd(placementId, {
        adsEnabled: () => ADS_ENABLED,
        // A local harness has no per-user ad token; the auction route is local.
        authToken: () => process.env.HAKSTER_ADS_TOKEN || "local",
        announcedPlacements: () => announcedPlacements(),
        fetchAuction: (id) => fetchAuction(id, context),
        sanitize: sanitizeTerminalStrings,
        requireFirstParty: true
      });
    }
    function ackImpression(ad) {
      return recordImpression(ad, (a) => {
        const delay = renderDelaySinceReceipt(a);
        fetch(`${ADS_URL}/api/ads/impression`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            impUrl: a.impUrl,
            placementId: a.placementId || "unknown",
            clientFamily: "cli",
            ...delay !== void 0 ? { renderDelayMs: delay } : {}
          }),
          signal: AbortSignal.timeout(3e3)
        }).catch(() => {
        });
        return true;
      });
    }
    function recordClick(ad) {
      if (!ad || !ad.impUrl) return false;
      fetch(`${ADS_URL}/api/ads/click`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ impUrl: ad.impUrl, placementId: ad.placementId || "unknown", url: ad.clickUrl || ad.url || "" }),
        signal: AbortSignal.timeout(3e3)
      }).catch(() => {
      });
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
      _setAnnouncedCache: (v) => {
        announcedCache = v;
        announcedAt = Date.now();
      }
    };
  }
});

// ../src/ads/inline-ad-layout.js
var require_inline_ad_layout = __commonJS({
  "../src/ads/inline-ad-layout.js"(exports, module) {
    "use strict";
    var { sanitizeTerminalText } = require_terminal_safe_text();
    var MIN_INLINE_WIDTH_WITH_DESTINATION = 48;
    var MIN_INLINE_AD_WIDTH = 20;
    var MAX_DESC_LINES = 2;
    var INLINE_AD_DISCLOSURE = "Ad";
    var INLINE_AD_GAP = 2;
    var INLINE_AD_LINK_SUFFIX = " \u2197";
    function truncateToLines(text, lineWidth, maxLines) {
      if (lineWidth <= 0) return text;
      const maxChars = lineWidth * maxLines;
      if (text.length <= maxChars) return text;
      return text.slice(0, maxChars - 1) + "\u2026";
    }
    function truncateToWidth(text, width) {
      if (width <= 0) return "";
      if (text.length <= width) return text;
      return text.slice(0, width - 1) + "\u2026";
    }
    var extractDomain = (url) => {
      try {
        return new URL(url).hostname.replace(/^www\./, "");
      } catch {
        return sanitizeTerminalText(url);
      }
    };
    function getAdDisplayLabel(ad) {
      const url = String(ad.url || "").trim();
      if (url) return { text: extractDomain(url), variant: "domain" };
      return { text: String(ad.title || "").trim() || "Sponsored", variant: "title" };
    }
    function getInlineAdLayout2(ad, width) {
      const contentWidth = Math.max(0, width - 4);
      const displayLabel = getAdDisplayLabel(ad);
      const headerTrailingWidth = INLINE_AD_GAP + INLINE_AD_DISCLOSURE.length;
      const titleWidth = Math.max(0, contentWidth - headerTrailingWidth);
      const destinationLabel = width >= MIN_INLINE_WIDTH_WITH_DESTINATION && displayLabel.variant === "domain" ? displayLabel.text : "";
      const maxLabelWidth = Math.max(0, Math.min(24, Math.floor(contentWidth / 3)));
      const label = truncateToWidth(destinationLabel, maxLabelWidth);
      const trailingWidth = label ? INLINE_AD_GAP + label.length + INLINE_AD_LINK_SUFFIX.length : 0;
      const descriptionWidth = Math.max(0, contentWidth - trailingWidth);
      return {
        title: truncateToWidth(String(ad.title || "").trim() || displayLabel.text, titleWidth),
        description: truncateToWidth(String(ad.adText || "").trim(), descriptionWidth),
        label
      };
    }
    function wrapToLines2(text, width, maxLines) {
      if (width <= 0 || maxLines <= 0) return [];
      const words = String(text || "").trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) return [];
      const lines = [];
      let current = "";
      const pushCurrent = () => {
        if (current) lines.push(current);
        current = "";
      };
      let overflowed = false;
      for (const word of words) {
        let remaining = word;
        while (remaining.length > width) {
          pushCurrent();
          lines.push(remaining.slice(0, width));
          remaining = remaining.slice(width);
          if (lines.length >= maxLines) {
            overflowed = true;
            break;
          }
        }
        if (overflowed) break;
        if (!current) current = remaining;
        else if (current.length + 1 + remaining.length <= width) current += " " + remaining;
        else {
          pushCurrent();
          current = remaining;
        }
        if (lines.length >= maxLines) {
          overflowed = true;
          break;
        }
      }
      pushCurrent();
      if (lines.length > maxLines) lines.length = maxLines;
      if (overflowed && lines.length) {
        const last = lines[lines.length - 1];
        if (last.length >= width) lines[lines.length - 1] = last.slice(0, width - 1) + "\u2026";
      }
      return lines;
    }
    module.exports = {
      MIN_INLINE_WIDTH_WITH_DESTINATION,
      MIN_INLINE_AD_WIDTH,
      MAX_DESC_LINES,
      INLINE_AD_DISCLOSURE,
      INLINE_AD_GAP,
      INLINE_AD_LINK_SUFFIX,
      truncateToLines,
      truncateToWidth,
      extractDomain,
      getAdDisplayLabel,
      getInlineAdLayout: getInlineAdLayout2,
      wrapToLines: wrapToLines2
    };
  }
});

// ../src/kitty-graphics.js
var require_kitty_graphics = __commonJS({
  "../src/kitty-graphics.js"(exports, module) {
    "use strict";
    var fs10 = __require("fs");
    var path8 = __require("path");
    var CHUNK_BYTES = 4096;
    var LOGO_ID = 18507;
    function isSupported3(env = process.env, out = process.stdout) {
      try {
        if (!out || out.isTTY === false) return false;
        if (String(env.HAKSTER_GRAPHICS || "").toLowerCase() === "off") return false;
        if (String(env.HAKSTER_GRAPHICS || "") === "1") return true;
        if (env.KITTY_WINDOW_ID) return true;
        if (/kitty/i.test(String(env.TERM || ""))) return true;
        const prog = String(env.TERM_PROGRAM || "").toLowerCase();
        return prog === "ghostty" || prog === "wezterm";
      } catch {
        return false;
      }
    }
    function pngSize2(buffer) {
      try {
        if (buffer.length < 24) return null;
        if (buffer[1] !== 80 || buffer[2] !== 78 || buffer[3] !== 71) return null;
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
      } catch {
        return null;
      }
    }
    function logoPath(explicit) {
      if (explicit) return explicit;
      const root2 = process.env.HAKSTER_CLI_DIR || path8.join(__dirname, "..");
      return path8.join(root2, "assets", "haksterai-logo.png");
    }
    function heroPath2(explicit) {
      if (explicit) return explicit;
      const root2 = process.env.HAKSTER_CLI_DIR || path8.join(__dirname, "..");
      return path8.join(root2, "assets", "haksterai-hero.png");
    }
    function placeImage3({ file, cols = 24, rows = 12, id = LOGO_ID, zIndex = -1, write = (s) => process.stdout.write(s) } = {}) {
      let data;
      try {
        data = fs10.readFileSync(file || logoPath());
      } catch {
        return null;
      }
      const b64 = data.toString("base64");
      const meta = `a=T,f=100,t=d,c=${cols},r=${rows},i=${id},z=${zIndex},C=1,q=2`;
      let chunks = 0;
      let first = true;
      for (let offset = 0; offset < b64.length; offset += CHUNK_BYTES) {
        const payload = b64.slice(offset, offset + CHUNK_BYTES);
        const more = offset + CHUNK_BYTES < b64.length ? 1 : 0;
        const controls = first ? `${meta},m=${more}` : `m=${more}`;
        write(`\x1B_G${controls};${payload}\x1B\\`);
        first = false;
        chunks += 1;
      }
      return { id, bytes: data.length, chunks, ...pngSize2(data) || {} };
    }
    function deleteImage3(id = LOGO_ID, write = (s) => process.stdout.write(s)) {
      write(`\x1B_Ga=d,d=i,i=${id},q=2\x1B\\`);
    }
    function deleteAll(write = (s) => process.stdout.write(s)) {
      write("\x1B_Ga=d,d=a,q=2\x1B\\");
    }
    function moveCursor3(row, col, write = (s) => process.stdout.write(s)) {
      write(`\x1B[${Math.max(1, row)};${Math.max(1, col)}H`);
    }
    function placeById3({ id = LOGO_ID, placementId = 1, zIndex = -1, write = (s) => process.stdout.write(s) } = {}) {
      write(`\x1B_Ga=p,i=${id},p=${placementId},z=${zIndex},C=1,q=2\x1B\\`);
    }
    function deletePlacement3({ placementId = 1, write = (s) => process.stdout.write(s) } = {}) {
      write(`\x1B_Ga=d,d=p,p=${placementId},q=2\x1B\\`);
    }
    module.exports = {
      CHUNK_BYTES,
      LOGO_ID,
      isSupported: isSupported3,
      pngSize: pngSize2,
      logoPath,
      heroPath: heroPath2,
      placeImage: placeImage3,
      deleteImage: deleteImage3,
      deleteAll,
      moveCursor: moveCursor3,
      placeById: placeById3,
      deletePlacement: deletePlacement3
    };
  }
});

// ../src/live-image.js
var require_live_image = __commonJS({
  "../src/live-image.js"(exports, module) {
    "use strict";
    var fs10 = __require("fs");
    var os6 = __require("os");
    var path8 = __require("path");
    var crypto = __require("crypto");
    var CACHE_DIR = path8.join(os6.homedir(), ".hakster", "cache", "live");
    var MAX_BYTES = 12 * 1024 * 1024;
    var FETCH_TIMEOUT_MS = 12e3;
    var EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
    var MIME_EXT = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/bmp": "bmp"
    };
    function urlExt(url) {
      try {
        const p = new URL(url).pathname;
        const m = p.match(EXT);
        return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "";
      } catch {
        return "";
      }
    }
    function findImageSource2(texts) {
      const list = Array.isArray(texts) ? texts : [texts];
      for (const raw of list) {
        const text = String(raw == null ? "" : raw);
        if (!text) continue;
        const data = text.match(/data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,([A-Za-z0-9+/=\s]+)/i);
        if (data) {
          const b64 = data[2].replace(/\s+/g, "");
          if (b64.length * 0.75 <= MAX_BYTES) {
            return { kind: "data", ref: data[0], name: `inline.${data[1].toLowerCase().replace("jpeg", "jpg")}` };
          }
        }
        const url = text.match(/https?:\/\/[^\s"'<>()\]]+/gi) || [];
        for (const u of url) {
          const ext = urlExt(u);
          if (ext) return { kind: "url", ref: u.replace(/[.,;]+$/, ""), name: path8.basename(new URL(u.replace(/[.,;]+$/, "")).pathname) || `image.${ext}` };
        }
        const paths = text.match(/(?:file:\/\/)?\/[^\s"'<>()\]]+\.(?:png|jpe?g|webp|gif|bmp)\b/gi) || [];
        for (const p of paths) {
          const file = p.replace(/^file:\/\//, "");
          try {
            if (fs10.existsSync(file) && fs10.statSync(file).size <= MAX_BYTES) {
              return { kind: "file", ref: file, name: path8.basename(file) };
            }
          } catch {
          }
        }
      }
      return null;
    }
    function cacheFile(ext) {
      return path8.join(CACHE_DIR, `${crypto.createHash("sha256").update(String(Date.now()) + Math.random()).digest("hex").slice(0, 24)}.${ext}`);
    }
    function writeCache(buffer, ext) {
      if (!fs10.existsSync(CACHE_DIR)) fs10.mkdirSync(CACHE_DIR, { recursive: true, mode: 448 });
      const file = cacheFile(ext);
      fs10.writeFileSync(file, buffer, { mode: 384 });
      return file;
    }
    async function materialize2(source) {
      if (!source || !source.ref) return { ok: false, reason: "no image" };
      if (source.kind === "file") {
        try {
          const st = fs10.statSync(source.ref);
          if (!st.isFile()) return { ok: false, reason: "not a file" };
          if (st.size > MAX_BYTES) return { ok: false, reason: `too big (${Math.round(st.size / 1048576)} MB)` };
          return { ok: true, file: source.ref, name: source.name };
        } catch {
          return { ok: false, reason: "file is gone" };
        }
      }
      if (source.kind === "data") {
        try {
          const m = source.ref.match(/^data:image\/([a-z0-9]+);base64,(.*)$/i);
          if (!m) return { ok: false, reason: "unreadable inline image" };
          const buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
          if (buf.length > MAX_BYTES) return { ok: false, reason: "inline image too big" };
          return { ok: true, file: writeCache(buf, m[1].toLowerCase().replace("jpeg", "jpg")), name: source.name };
        } catch (e) {
          return { ok: false, reason: e && e.message || "inline image failed" };
        }
      }
      if (source.kind === "url") {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(source.ref, {
            signal: ctrl.signal,
            redirect: "follow",
            headers: { accept: "image/*", "user-agent": "haksterai-cli (+https://haksterai.com)" }
          });
          if (!res.ok) return { ok: false, reason: `http ${res.status}` };
          const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
          const ext = MIME_EXT[type] || urlExt(source.ref);
          if (!ext) return { ok: false, reason: `not an image (${type || "unknown type"})` };
          const len = Number(res.headers.get("content-length") || 0);
          if (len && len > MAX_BYTES) return { ok: false, reason: `too big (${Math.round(len / 1048576)} MB)` };
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > MAX_BYTES) return { ok: false, reason: "too big" };
          return { ok: true, file: writeCache(buf, ext), name: source.name || `image.${ext}` };
        } catch (e) {
          const reason = e && e.name === "AbortError" ? `timed out after ${FETCH_TIMEOUT_MS / 1e3}s` : e && e.message || "fetch failed";
          return { ok: false, reason };
        } finally {
          clearTimeout(timer);
        }
      }
      return { ok: false, reason: "unknown source" };
    }
    module.exports = { findImageSource: findImageSource2, materialize: materialize2, MAX_BYTES, CACHE_DIR };
  }
});

// ../src/prefs.js
var require_prefs = __commonJS({
  "../src/prefs.js"(exports, module) {
    "use strict";
    var fs10 = __require("fs");
    var os6 = __require("os");
    var path8 = __require("path");
    var PREFS_DIR = path8.join(os6.homedir(), ".hakster");
    var PREFS_FILE = path8.join(PREFS_DIR, "cli-prefs.json");
    var LEGACY_FILE = path8.join(PREFS_DIR, "tui-prefs.json");
    var DEFAULTS = {
      model: "",
      // '' = the pinned primary model (§22)
      provider: "",
      autoHandoff: true,
      // DeepSeek → Codex → server waterfall
      ads: true,
      // the TUI's ad rail
      monitorFollow: true,
      // the monitor view follows the newest line
      updateCheck: true,
      // background CLI update check
      opaqueBackdrop: false,
      // false = transparent over the terminal's wallpaper
      intro: true,
      // the five-line decode splash on start
      graphics: true,
      // real logo image in kitty / Ghostty / WezTerm (no-op elsewhere)
      usageRefresh: 15
      // the usage page's poll, seconds (0 = paused)
    };
    var META2 = {
      model: { label: "Model", detail: "blank = the pinned Phantom Flash config" },
      provider: { label: "Provider", detail: "blank = the pinned provider (ollama)" },
      autoHandoff: { label: "Auto handoff", detail: "a failed run moves down the model ladder" },
      ads: { label: "Ad rail", detail: "the sponsor line under the chat column" },
      monitorFollow: { label: "Monitor follow", detail: "the live monitor follows the newest line" },
      updateCheck: { label: "Update check", detail: "background CLI update check on start" },
      opaqueBackdrop: { label: "Opaque backdrop", detail: "solid background over the terminal wallpaper" },
      intro: { label: "Intro splash", detail: "the five-line decode screen on start" },
      graphics: { label: "Kitty graphics", detail: "real logo image in kitty / Ghostty / WezTerm" },
      usageRefresh: { label: "Usage refresh", detail: "seconds between usage polls (0 = paused)" }
    };
    var KEYS = Object.keys(DEFAULTS);
    function readJson(file) {
      try {
        const value = JSON.parse(fs10.readFileSync(file, "utf8"));
        return value && typeof value === "object" && !Array.isArray(value) ? value : null;
      } catch {
        return null;
      }
    }
    function load() {
      const legacy = readJson(LEGACY_FILE) || {};
      const current = readJson(PREFS_FILE) || {};
      const out = { ...DEFAULTS };
      for (const key of KEYS) {
        if (typeof legacy[key] === typeof DEFAULTS[key] && legacy[key] !== void 0) out[key] = legacy[key];
        if (typeof current[key] === typeof DEFAULTS[key] && current[key] !== void 0) out[key] = current[key];
      }
      return out;
    }
    function save(patch) {
      const next = { ...load() };
      for (const key of KEYS) {
        if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
      }
      try {
        fs10.mkdirSync(PREFS_DIR, { recursive: true, mode: 448 });
        const tmp = `${PREFS_FILE}.tmp-${process.pid}`;
        fs10.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}
`, { mode: 384 });
        fs10.renameSync(tmp, PREFS_FILE);
      } catch {
      }
      return next;
    }
    function coerce(key, value) {
      const fallback = DEFAULTS[key];
      if (typeof fallback === "boolean") {
        const v = String(value || "").toLowerCase();
        if (["1", "true", "on", "yes", "y"].includes(v)) return true;
        if (["0", "false", "off", "no", "n"].includes(v)) return false;
        return null;
      }
      if (typeof fallback === "number") {
        const n = Number(String(value == null ? "" : value).trim());
        if (!Number.isFinite(n) || n < 0) return null;
        return Math.min(3600, Math.round(n));
      }
      return String(value == null ? "" : value).trim();
    }
    function isKnown(key) {
      return KEYS.includes(String(key || ""));
    }
    function list() {
      const current = load();
      return KEYS.map((key) => ({ key, value: current[key], default: DEFAULTS[key] }));
    }
    module.exports = { DEFAULTS, KEYS, META: META2, PREFS_FILE, load, save, coerce, isKnown, list };
  }
});

// ../src/models/ladder.js
var require_ladder = __commonJS({
  "../src/models/ladder.js"(exports, module) {
    "use strict";
    var PRIMARY_MODEL2 = "deepseek-v4.1-flash:cloud";
    var PRIMARY_PROVIDER2 = "ollama";
    var MODEL_LADDER2 = Object.freeze([
      Object.freeze({
        tier: 1,
        // The engine the TUI drives its turns with: the Claude Code CLI on the
        // owner's own DeepSeek route (owner, 2026-11-24: "just add my claude cli
        // with my deepseek model to the tui … and he will run like butter").
        // Same wire model, same base URL (127.0.0.1:11434), same context window as
        // the Claude Code session this box already runs (§22 — the model config is
        // unchanged; only the harness around it is Claude Code's own tool loop,
        // which keeps going across tool rounds instead of stopping after one).
        provider: "claude-cli",
        model: PRIMARY_MODEL2,
        label: "DeepSeek Flash"
      }),
      Object.freeze({
        tier: 2,
        // The same model straight from the Ollama relay through the server's own
        // loop. Nothing was replaced: if the CLI engine fails, the identical turn
        // retries on this route before any other lane is tried.
        provider: PRIMARY_PROVIDER2,
        model: PRIMARY_MODEL2,
        label: "DeepSeek direct"
      }),
      Object.freeze({
        tier: 3,
        provider: "codex-cli",
        // Empty model: the server fills in the provider's own defaultModel, so the
        // CLI never invents a Codex model string of its own.
        model: "",
        label: "Codex"
      }),
      Object.freeze({
        tier: 4,
        provider: "",
        model: "",
        label: "waterfall"
      })
    ]);
    var isPrimary = (model) => String(model || "") === PRIMARY_MODEL2;
    function attemptsFor2(model, provider) {
      const chosen = String(model || "");
      const prov = String(provider || "");
      if (!chosen) {
        const start2 = MODEL_LADDER2.findIndex((entry) => entry.provider && entry.provider === prov);
        if (start2 > 0) return MODEL_LADDER2.slice(start2).map((entry) => ({ ...entry }));
        if (prov && start2 === -1) return [{ tier: 0, provider: prov, model: "", label: prov }];
        return MODEL_LADDER2.map((entry) => ({ ...entry }));
      }
      if (isPrimary(chosen)) return MODEL_LADDER2.map((entry) => ({ ...entry }));
      return [{ tier: 0, provider: null, model: chosen, label: chosen }];
    }
    function labelForModel(model) {
      const chosen = String(model || "");
      const hit = MODEL_LADDER2.find((entry) => entry.model && entry.model === chosen);
      return hit ? hit.label : chosen || PRIMARY_MODEL2;
    }
    function tierOf(model) {
      const chosen = String(model || "");
      if (!chosen || isPrimary(chosen)) return 1;
      return 0;
    }
    module.exports = {
      MODEL_LADDER: MODEL_LADDER2,
      PRIMARY_MODEL: PRIMARY_MODEL2,
      PRIMARY_PROVIDER: PRIMARY_PROVIDER2,
      attemptsFor: attemptsFor2,
      labelForModel,
      tierOf,
      isPrimary
    };
  }
});

// ../src/updater.js
var require_updater = __commonJS({
  "../src/updater.js"(exports, module) {
    "use strict";
    var fs10 = __require("fs");
    var os6 = __require("os");
    var path8 = __require("path");
    var crypto = __require("crypto");
    var { spawn: spawn2 } = __require("child_process");
    var DEFAULT_CLI_DIR = process.env.HAKSTER_CLI_DIR || (typeof __dirname === "string" ? path8.join(__dirname, "..") : "");
    function cliDirOf(explicit) {
      return path8.resolve(String(explicit || DEFAULT_CLI_DIR || process.cwd()));
    }
    var UPDATES_DIR = path8.join(os6.homedir(), ".hakster", "updates");
    var STAGED_DIR = path8.join(UPDATES_DIR, "staged");
    var TARBALL = path8.join(UPDATES_DIR, "latest.tar.gz");
    var PENDING_FILE = path8.join(UPDATES_DIR, "pending.json");
    var MAX_TARBALL = 32 * 1024 * 1024;
    function readJson(file, fallback) {
      try {
        return JSON.parse(fs10.readFileSync(file, "utf8"));
      } catch {
        return fallback;
      }
    }
    function writeJson(file, value) {
      fs10.mkdirSync(path8.dirname(file), { recursive: true, mode: 448 });
      const tmp = `${file}.tmp-${process.pid}`;
      fs10.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
      fs10.renameSync(tmp, file);
    }
    function sha256File(file) {
      try {
        return crypto.createHash("sha256").update(fs10.readFileSync(file)).digest("hex");
      } catch {
        return "";
      }
    }
    function runningInfo(explicitDir) {
      const dir = cliDirOf(explicitDir);
      const pkg = readJson(path8.join(dir, "package.json"), {});
      return {
        version: String(pkg.version || "0.0.0"),
        bundleSha: sha256File(path8.join(dir, "ui-fb.mjs")),
        dir
      };
    }
    function isSourceCheckout(explicitDir) {
      return fs10.existsSync(path8.join(cliDirOf(explicitDir), "..", ".git"));
    }
    function serverUrl() {
      const cfg = readJson(path8.join(os6.homedir(), ".hakster", "config.json"), {});
      return String(cfg.server || process.env.HAKSTER_SERVER || "").replace(/\/+$/, "");
    }
    function cmpVersion(a, b) {
      const pa = String(a || "").split(/[.+-]/).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
      const pb = String(b || "").split(/[.+-]/).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
      const len = Math.max(pa.length, pb.length);
      for (let i = 0; i < len; i += 1) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x !== y) return x > y ? 1 : -1;
      }
      return 0;
    }
    async function fetchJson(url, timeoutMs) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          signal: ctl.signal,
          headers: { accept: "application/json", "x-hakster-client": "cli" }
        });
        const type = String(res.headers.get("content-type") || "");
        if (!res.ok || !type.includes("json")) return null;
        const body = await res.json();
        return body && typeof body === "object" ? body : null;
      } finally {
        clearTimeout(timer);
      }
    }
    async function downloadTarball(url, timeoutMs) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctl.signal, headers: { accept: "application/gzip", "x-hakster-client": "cli" } });
        if (!res.ok) return { ok: false, reason: `http ${res.status}` };
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) return { ok: false, reason: "empty package" };
        if (buf.length > MAX_TARBALL) return { ok: false, reason: "package too large" };
        fs10.mkdirSync(UPDATES_DIR, { recursive: true, mode: 448 });
        fs10.writeFileSync(TARBALL, buf, { mode: 384 });
        return { ok: true, bytes: buf.length };
      } catch (e) {
        return { ok: false, reason: e && e.name === "AbortError" ? "timeout" : String(e && e.message || e) };
      } finally {
        clearTimeout(timer);
      }
    }
    function extractStaged() {
      fs10.mkdirSync(STAGED_DIR, { recursive: true, mode: 448 });
      return new Promise((resolve) => {
        const tar = spawn2("tar", ["-xzf", TARBALL, "-C", STAGED_DIR], { stdio: "ignore" });
        tar.on("error", (e) => resolve({ ok: false, reason: String(e.message || e) }));
        tar.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, reason: `tar exited ${code}` }));
      });
    }
    function stagedInfo() {
      const pkg = readJson(path8.join(STAGED_DIR, "cli", "package.json"), {});
      return {
        version: String(pkg.version || ""),
        bundleSha: sha256File(path8.join(STAGED_DIR, "cli", "ui-fb.mjs")),
        deps: JSON.stringify(pkg && pkg.dependencies || {})
      };
    }
    function sameDeps(installedDeps, stagedDeps) {
      const norm = (obj) => {
        const out = {};
        for (const key of Object.keys(obj || {}).sort()) out[key] = String(obj[key]);
        return JSON.stringify(out);
      };
      return norm(JSON.parse(installedDeps || "{}")) === norm(JSON.parse(stagedDeps || "{}"));
    }
    async function checkForUpdate2(opts = {}) {
      const timeoutMs = Number(opts.timeoutMs) || 8e3;
      const running = runningInfo(opts.cliDir);
      const origin = opts.server || serverUrl();
      if (!origin) return { status: "unknown", reason: "no server configured", checkedAt: (/* @__PURE__ */ new Date()).toISOString(), running };
      const latest = await fetchJson(`${origin}/cli/latest.json`, timeoutMs).catch(() => null);
      if (latest && latest.version) {
        const version = String(latest.version);
        const bundleSha = String(latest.bundleSha256 || "");
        const upToDate2 = cmpVersion(version, running.version) === 0 && (!bundleSha || bundleSha === running.bundleSha);
        if (upToDate2) {
          const pending2 = readJson(PENDING_FILE, null);
          if (pending2 && !pending2.appliedAt && pending2.state !== "current") {
            writeJson(PENDING_FILE, { ...pending2, verifiedAt: (/* @__PURE__ */ new Date()).toISOString(), state: "current", blocked: null });
          }
          return { status: "current", version, checkedAt: (/* @__PURE__ */ new Date()).toISOString(), running };
        }
      }
      const dl = await downloadTarball(`${origin}/cli/pkg.tar.gz`, timeoutMs);
      if (!dl.ok) return { status: "error", reason: dl.reason, checkedAt: (/* @__PURE__ */ new Date()).toISOString(), running };
      const ex = await extractStaged();
      if (!ex.ok) return { status: "error", reason: ex.reason, checkedAt: (/* @__PURE__ */ new Date()).toISOString(), running };
      const staged = stagedInfo();
      if (!staged.version || !staged.bundleSha) {
        return { status: "error", reason: "staged package unreadable", checkedAt: (/* @__PURE__ */ new Date()).toISOString(), running };
      }
      const upToDate = cmpVersion(staged.version, running.version) === 0 && staged.bundleSha === running.bundleSha;
      if (upToDate) {
        const pending2 = readJson(PENDING_FILE, null);
        if (pending2 && pending2.version === staged.version && pending2.bundleSha === staged.bundleSha && !pending2.appliedAt) {
          writeJson(PENDING_FILE, { ...pending2, verifiedAt: (/* @__PURE__ */ new Date()).toISOString(), state: "current", blocked: null });
        }
        return { status: "current", version: staged.version, checkedAt: (/* @__PURE__ */ new Date()).toISOString(), running };
      }
      const blocked = isSourceCheckout(opts.cliDir) ? "source-checkout" : null;
      const pending = {
        version: staged.version,
        bundleSha: staged.bundleSha,
        stagedAt: (/* @__PURE__ */ new Date()).toISOString(),
        verifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
        runningVersion: running.version,
        source: origin,
        dir: path8.join(STAGED_DIR, "cli"),
        state: blocked ? "blocked" : "staged",
        blocked
      };
      writeJson(PENDING_FILE, pending);
      return { status: blocked ? "blocked" : "staged", reason: blocked || void 0, ...pending, checkedAt: pending.stagedAt, running };
    }
    function sameBuild(pending, running) {
      if (!pending || !running) return false;
      if (String(pending.version || "") !== String(running.version || "")) return false;
      return !pending.bundleSha || pending.bundleSha === running.bundleSha;
    }
    function pendingInfo2(explicitDir) {
      const pending = readJson(PENDING_FILE, null);
      if (!pending || !pending.version) return null;
      const ok = !!pending.bundleSha && sha256File(path8.join(STAGED_DIR, "cli", "ui-fb.mjs")) === pending.bundleSha;
      return { ...pending, verified: ok, isCurrent: sameBuild(pending, runningInfo(explicitDir)) };
    }
    var APPLIED_NOTICE_MS = 24 * 60 * 60 * 1e3;
    function appliedNotice2(explicitDir, maxAgeMs) {
      const pending = readJson(PENDING_FILE, null);
      if (!pending || !pending.appliedAt || !pending.appliedOver) return null;
      const at = Date.parse(pending.appliedAt);
      if (!Number.isFinite(at)) return null;
      if (Date.now() - at > (Number(maxAgeMs) || APPLIED_NOTICE_MS)) return null;
      if (!sameBuild(pending, runningInfo(explicitDir))) return null;
      return {
        version: String(pending.version || ""),
        from: String(pending.appliedOver || ""),
        appliedAt: pending.appliedAt,
        backupDir: pending.backupDir || ""
      };
    }
    function applyPending(explicitDir) {
      const pending = pendingInfo2();
      if (!pending) return null;
      const target = cliDirOf(explicitDir);
      if (pending.appliedAt) return { applied: false, reason: "already applied", version: pending.version };
      if (!pending.verified) return { applied: false, reason: "staged package failed verification", version: pending.version };
      if (isSourceCheckout(target)) return { applied: false, reason: "source-checkout", version: pending.version };
      const running = runningInfo(target);
      if (sameBuild(pending, running)) {
        writeJson(PENDING_FILE, { ...pending, matchedAt: (/* @__PURE__ */ new Date()).toISOString(), state: "current" });
        return { applied: false, reason: "current", version: pending.version };
      }
      const installedDeps = readJson(path8.join(target, "package.json"), {}).dependencies || {};
      const staged = stagedInfo();
      if (!sameDeps(JSON.stringify(installedDeps), staged.deps)) {
        return { applied: false, reason: "dependencies changed \u2014 run npm install for the new version", version: pending.version };
      }
      const backupDir = path8.join(UPDATES_DIR, `backup-${running.version}-${Date.now()}`);
      const stagedCli = path8.join(STAGED_DIR, "cli");
      try {
        fs10.cpSync(stagedCli, backupDir, {
          recursive: true,
          filter: (src) => !src.includes(`${path8.sep}node_modules`) && !src.includes(`${path8.sep}.git`)
        });
        fs10.cpSync(stagedCli, target, {
          recursive: true,
          force: true,
          filter: (src) => !src.includes(`${path8.sep}node_modules`) && !src.includes(`${path8.sep}.git`)
        });
      } catch (e) {
        return { applied: false, reason: `copy failed: ${e && e.message || e}`, version: pending.version, backupDir };
      }
      writeJson(PENDING_FILE, {
        ...pending,
        appliedAt: (/* @__PURE__ */ new Date()).toISOString(),
        state: "applied",
        appliedFrom: pending.version,
        appliedOver: running.version,
        backupDir
      });
      return { applied: true, version: pending.version, from: running.version, backupDir };
    }
    async function promptStagedUpdate(opts = {}) {
      const pending = pendingInfo2();
      if (!pending || !pending.version) return { action: "none" };
      if (pending.appliedAt) return { action: "none", pending };
      const running = runningInfo(opts.cliDir);
      if (sameBuild(pending, running)) {
        return { action: "current", pending, running };
      }
      if (isSourceCheckout(opts.cliDir)) return { action: "blocked", pending, running };
      const stdin = process.stdin;
      const stdout = process.stdout;
      const tty = !!(stdin && stdin.isTTY && stdout && stdout.isTTY);
      if (!tty || process.env.HAKSTER_NO_UPDATE_PROMPT) {
        return { action: "auto", pending, running };
      }
      const mark = (state) => {
        try {
          writeJson(PENDING_FILE, { ...pending, deferredAt: state === "wait" ? (/* @__PURE__ */ new Date()).toISOString() : pending.deferredAt || null, promptState: state });
        } catch {
        }
      };
      stdout.write(`
\u2B06 CLI v${pending.version} is ready \u2014 this session is on v${running.version}.
`);
      stdout.write("  [i] Install now  \xB7 this session runs the new CLI\n");
      stdout.write("  [w] Wait until next one  \xB7 keep the current version for now\n");
      stdout.write("Choice [i/w]: ");
      const answer = await readChoice(opts.timeoutMs || 2e4);
      stdout.write("\n");
      const k = String(answer || "").trim().toLowerCase();
      if (k === "i" || k === "y" || k === "1" || k === "\r" || k === "\n") {
        mark("install");
        return { action: "install", pending, running };
      }
      mark("wait");
      return { action: "wait", pending, running };
    }
    function readChoice(timeoutMs) {
      return new Promise((resolve) => {
        const stdin = process.stdin;
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try {
            stdin.removeListener("data", onData);
          } catch {
          }
          try {
            stdin.setRawMode(false);
          } catch {
          }
          try {
            stdin.pause();
          } catch {
          }
          resolve(value);
        };
        const onData = (buf) => {
          const text = buf.toString("utf8");
          if (text === "\r" || text === "\n") finish("\r");
          else finish(text);
        };
        const timer = setTimeout(() => finish(""), Math.max(1e3, Number(timeoutMs) || 2e4));
        try {
          stdin.setRawMode(true);
        } catch {
        }
        stdin.resume();
        stdin.on("data", onData);
      });
    }
    module.exports = {
      checkForUpdate: checkForUpdate2,
      applyPending,
      appliedNotice: appliedNotice2,
      pendingInfo: pendingInfo2,
      promptStagedUpdate,
      runningInfo,
      isSourceCheckout,
      cliDirOf,
      UPDATES_DIR,
      PENDING_FILE
    };
  }
});

// ../src/input-history.js
var require_input_history = __commonJS({
  "../src/input-history.js"(exports, module) {
    var fs10 = __require("fs");
    var os6 = __require("os");
    var path8 = __require("path");
    var MAX_KEEP = 500;
    var MAX_RECALL = 200;
    function historyPath() {
      return path8.join(process.env.HAKSTER_HOME || path8.join(os6.homedir(), ".hakster"), "history");
    }
    var TERMINAL_JUNK = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\x1b|rgb:|VTE\(|[─│┌┐└┘├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋]|;\d+\$y|\[\?/;
    var BOX_ONLY = /^[\s│┃|]+|[\s│┃|]+$/;
    var NON_TYPED = [
      /^Captured:\s*\d{4}-\d{2}-\d{2}T/,
      // issue-report header block
      /^Page:\s*https?:\/\//,
      //
      /^Browser:\s*Mozilla\//,
      //
      /^Total issues this session:/i,
      //
      /^Recent messages:?$/i,
      //
      /^\d+\.\s*\[\d{1,2}:\d{2}:\d{2}\s*[AP]M\]/,
      // "1. [2:20 PM] notice: …"
      /^⚠️?\s/
      // library notice captured mid-turn
    ];
    var SECRET_SHAPES = [
      /\bsk-[A-Za-z0-9_-]{12,}/,
      // OpenAI-style
      /\bsk_(live|test)_[A-Za-z0-9]{10,}/,
      // Stripe secret
      /\bpk_(live|test)_[A-Za-z0-9]{10,}/,
      // Stripe publishable
      /\bgh[pousr]_[A-Za-z0-9]{20,}/,
      // GitHub tokens
      /\bgithub_pat_[A-Za-z0-9_]{20,}/,
      /\bAKIA[0-9A-Z]{16}\b/,
      // AWS access key id
      /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
      // Slack
      /\bBearer\s+[A-Za-z0-9._-]{20,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\b(api[_-]?key|secret|token|passwd|password|pass|client[_-]?secret)\s*[:=]\s*\S{8,}/i,
      /\b[A-Fa-f0-9]{40,}\b/
      // long hex blobs (digests / keys)
    ];
    function looksSecret(line) {
      return SECRET_SHAPES.some((re) => re.test(line));
    }
    function isKept(raw) {
      if (typeof raw !== "string") return false;
      const line = raw.replace(/\r/g, "").trim();
      if (line.length < 3) return false;
      if (TERMINAL_JUNK.test(line)) return false;
      if (BOX_ONLY.test(line) && !/[A-Za-z]/.test(line.replace(/[│┃|]/g, ""))) return false;
      if (looksSecret(line)) return false;
      if (NON_TYPED.some((re) => re.test(line))) return false;
      if (/^Tool execution results:/i.test(line)) return false;
      if (/^Session resumed from disk\./i.test(line)) return false;
      if (/^Continue based on these results\.?$/i.test(line)) return false;
      if (/^\[(trimmed|truncated|\.\.\.|…)\]$/i.test(line)) return false;
      return true;
    }
    function isTruncationOf(a, b) {
      if (a.length < 40 || b.length < 40) return false;
      const long = a.length >= b.length ? a : b;
      const short = a.length >= b.length ? b : a;
      if (!long.startsWith(short)) return false;
      return short.length >= long.length * 0.35;
    }
    var NOTICE_HEAD = /^⚠️?\s/;
    function sanitizeLines(lines) {
      const out = [];
      let noticeTail = 0;
      for (const raw of lines || []) {
        if (typeof raw !== "string") continue;
        const line = raw.replace(/\r/g, "").trim();
        if (noticeTail > 0) {
          noticeTail -= 1;
          if (/[.!?]$/.test(line)) noticeTail = 0;
          continue;
        }
        if (NOTICE_HEAD.test(line)) {
          noticeTail = 4;
          continue;
        }
        if (!isKept(line)) continue;
        if (out.length && out[out.length - 1] === line) continue;
        const prior = out.findIndex((h) => isTruncationOf(h, line));
        if (prior !== -1) {
          if (out[prior].length < line.length) {
            out.splice(prior, 1);
            out.push(line);
          }
          continue;
        }
        out.push(line);
      }
      return out.slice(-MAX_KEEP);
    }
    function loadInputHistory2(limit = MAX_RECALL) {
      try {
        const lines = fs10.readFileSync(historyPath(), "utf8").split("\n");
        return sanitizeLines(lines).slice(-Math.max(0, limit));
      } catch {
        return [];
      }
    }
    function appendInputHistory2(line, limit = MAX_KEEP) {
      if (process.env.HAKSTER_NO_HISTORY === "1") return false;
      if (!isKept(line)) return false;
      const value = String(line).replace(/\r/g, "").trim();
      try {
        const file = historyPath();
        const dir = path8.dirname(file);
        if (!fs10.existsSync(dir)) fs10.mkdirSync(dir, { recursive: true });
        const existing = sanitizeLines(
          fs10.existsSync(file) ? fs10.readFileSync(file, "utf8").split("\n") : []
        );
        const next = existing.filter((h) => h !== value);
        next.push(value);
        fs10.writeFileSync(file, next.slice(-limit).join("\n") + "\n");
        return true;
      } catch {
        return false;
      }
    }
    module.exports = {
      historyPath,
      isKept,
      looksSecret,
      sanitizeLines,
      loadInputHistory: loadInputHistory2,
      appendInputHistory: appendInputHistory2
    };
  }
});

// ../src/models/catalog.js
var require_catalog = __commonJS({
  "../src/models/catalog.js"(exports, module) {
    "use strict";
    var REFERENCE_CATALOG = [
      {
        id: "MiMo 2.6 Flash",
        vendor: "Xiaomi",
        access: "full+limited",
        bestFor: "The default everywhere; balanced performance with image support.",
        context: null,
        images: true,
        audio: false
      },
      {
        id: "GLM 5.3 Flash",
        vendor: "Zhipu",
        access: "full+limited",
        bestFor: "Deepest reasoning, unmetered.",
        context: null,
        images: false,
        audio: false
      },
      {
        id: "DeepSeek V4.1 Flash",
        vendor: "DeepSeek",
        access: "full+limited",
        bestFor: "Fast coding and tool use, unmetered.",
        context: null,
        images: false,
        audio: false
      },
      {
        id: "DeepSeek V4.1 Flash Fast",
        vendor: "DeepSeek",
        access: "full",
        bestFor: "Fast mode: splits work across parallel subagents and verifies the result.",
        context: null,
        images: false,
        audio: false
      },
      {
        id: "GPT-6 Luna",
        vendor: "OpenAI",
        access: "full",
        bestFor: "Strong all-around with native images; runs on flex capacity.",
        context: null,
        images: true,
        audio: false
      },
      {
        id: "MiMo 2.6 Pro",
        vendor: "Xiaomi",
        access: "full",
        bestFor: "Xiaomi's stronger reasoning model, with image support.",
        context: null,
        images: true,
        audio: false
      },
      {
        id: "Solar Mini 4",
        vendor: "Upstage",
        access: "full+limited",
        bestFor: "Fast, compact; text only.",
        context: 524e3,
        images: false,
        audio: false
      },
      {
        id: "Solar Pro 4",
        vendor: "Upstage",
        access: "full+limited",
        bestFor: "Larger, stronger; text only.",
        context: 524e3,
        images: false,
        audio: false
      },
      {
        id: "Gemini 3.8 Flash",
        vendor: "Google",
        access: "paid",
        bestFor: "1M context, and the only model that accepts audio, video and PDF.",
        context: 1e6,
        images: true,
        audio: true
      },
      {
        id: "Muse Spark 1.3",
        vendor: "Meta",
        access: "paid",
        bestFor: "Agentic coding, 1M context.",
        context: 1e6,
        images: false,
        audio: false
      },
      {
        id: "GPT-6.1 Sol",
        vendor: "OpenAI",
        access: "region/paid",
        bestFor: "OpenAI's flagship; one session a day per account, 1M context, images.",
        context: 1e6,
        images: true,
        audio: false
      },
      {
        id: "Gemini 3.1 Flash Lite",
        vendor: "Google",
        access: "specialist",
        bestFor: "Powers specialist tasks such as file finding and research rather than the main picker.",
        context: null,
        images: false,
        audio: false
      }
    ];
    var RETIRED = [
      { id: "DeepSeek V4 Pro", vendor: "DeepSeek", replacedBy: "GLM 5.3 Flash", note: "Retired from the catalog; GLM 5.3 Flash replaces it as the deep-reasoning pick." }
    ];
    var CONTEXT_BY_MODEL = {
      "deepseek-v4.1-flash:cloud": 1048576,
      // owner's Claude DeepSeek config (1 MiB override)
      "glm-5.2:cloud": 128e3,
      "thudm/glm-5.2:cloud": 128e3,
      "thudm/glm-5.1:cloud-ctx": 128e3,
      "thudm/glm-5.1:cloud": 128e3,
      "gpt-oss:120b-cloud": 131072,
      "openai/gpt-oss-120b": 131072,
      "claude-sonnet-4-5": 2e5,
      "claude-opus-4-5": 2e5,
      "claude-haiku-3-5": 2e5,
      "gpt-4o": 128e3,
      "openai/gpt-5.5": 128e3,
      "gemini-2.5-flash": 1e6,
      "gemini-2.0-flash-lite": 1e6
    };
    var DEFAULT_CONTEXT = 128e3;
    function contextMaxFor(model) {
      if (!model) return DEFAULT_CONTEXT;
      if (CONTEXT_BY_MODEL[model]) return CONTEXT_BY_MODEL[model];
      const m = String(model).toLowerCase();
      if (m.includes("claude")) return 2e5;
      if (m.includes("gpt-oss") || m.includes("120b")) return 131072;
      if (m.includes("glm")) return 128e3;
      if (m.includes("deepseek-v4.1-flash")) return 1048576;
      if (m.includes("deepseek")) return 131072;
      const hit = REFERENCE_CATALOG.find((c) => c.id.toLowerCase() === m);
      if (hit && hit.context) return hit.context;
      const env = parseInt(process.env.HAKSTER_CONTEXT_MAX || "", 10);
      return Number.isFinite(env) && env > 0 ? env : DEFAULT_CONTEXT;
    }
    function findModel(name) {
      const q = String(name || "").toLowerCase();
      return REFERENCE_CATALOG.find((m) => m.id.toLowerCase() === q) || REFERENCE_CATALOG.find((m) => m.id.toLowerCase().includes(q)) || null;
    }
    function byAccess() {
      const groups = {};
      for (const m of REFERENCE_CATALOG) (groups[m.access] ||= []).push(m);
      return groups;
    }
    function labelFor(m) {
      const ctx = m.context ? `${Math.round(m.context / 1e3)}K` : "ctx n/s";
      const flags = [m.images && "img", m.audio && "av/pdf"].filter(Boolean).join("+");
      return `${m.id} \u2014 ${m.vendor} \xB7 ${ctx}${flags ? " \xB7 " + flags : ""}`;
    }
    module.exports = {
      REFERENCE_CATALOG,
      RETIRED,
      CONTEXT_BY_MODEL,
      DEFAULT_CONTEXT,
      contextMaxFor,
      findModel,
      byAccess,
      labelFor
    };
  }
});

// src/index.jsx
import React28 from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

// src/App.jsx
import React27, { useCallback as useCallback5, useEffect as useEffect16, useRef as useRef11, useState as useState17 } from "react";
import fs9 from "node:fs";
import path7 from "node:path";
import { useKeyboard as useKeyboard7, useRenderer as useRenderer3, useTerminalDimensions } from "@opentui/react";
import { TextAttributes as TextAttributes20 } from "@opentui/core";

// src/components/DockAd.jsx
var import_ad_client = __toESM(require_ad_client());
var import_inline_ad_layout = __toESM(require_inline_ad_layout());
import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { jsx, jsxs } from "react/jsx-runtime";
function DockAd({
  width = 80,
  placementId,
  enabled = true,
  focused = false,
  expanded = false
}) {
  const [ad, setAd] = useState(null);
  const [state, setState] = useState("loading");
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setState("off");
      return;
    }
    let cancelled = false;
    setState("loading");
    import_ad_client.default.getPlacementAd(placementId, { width, shell: process.env.SHELL || null }).then((fetched) => {
      if (cancelled) return;
      if (fetched) {
        setAd(fetched);
        setState("filled");
        import_ad_client.default.ackImpression(fetched);
      } else {
        setAd(null);
        setState("none");
      }
    }).catch(() => {
      if (cancelled) return;
      setAd(null);
      setState("none");
    });
    return () => {
      cancelled = true;
    };
  }, [placementId, enabled, width]);
  useKeyboard((key) => {
    if (!focused || !ad) return;
    if (key.name === "return") {
      if (ad.impUrl) {
        setOpened(true);
        import_ad_client.default.recordClick(ad);
      }
    }
  });
  if (!enabled || state === "off") {
    return null;
  }
  if (state === "loading") {
    return /* @__PURE__ */ jsx("box", { style: { width, paddingLeft: 1, paddingRight: 1 }, children: /* @__PURE__ */ jsx("text", { fg: "gray", children: "\u2026" }) });
  }
  if (!ad) {
    return /* @__PURE__ */ jsx("box", { style: { width, paddingLeft: 1, paddingRight: 1 }, children: /* @__PURE__ */ jsx("text", { fg: "gray", children: "\u2014" }) });
  }
  const { title, description, label } = (0, import_inline_ad_layout.getInlineAdLayout)(ad, width);
  if (!expanded) {
    const glyph = focused ? "\u25B8 " : "  ";
    const tail = `${label ? ` ${label}` : ""}${focused ? "  enter open" : ""}`;
    const titleRoom = Math.max(6, width - 2 - glyph.length - tail.length);
    const shownTitle = title.length > titleRoom ? `${title.slice(0, titleRoom - 1)}\u2026` : title;
    const lead = `${glyph}${shownTitle}`;
    const room = Math.max(0, width - 2 - lead.length - tail.length);
    let desc = "";
    if (description && room > 4) {
      const full = ` \u2014 ${description}`;
      desc = full.length <= room ? full : `${full.slice(0, Math.max(0, room - 1))}\u2026`;
    }
    return /* @__PURE__ */ jsxs("box", { style: { width, flexDirection: "row", paddingLeft: 1, paddingRight: 1 }, children: [
      /* @__PURE__ */ jsx("text", { fg: focused ? "cyan" : "gray", attributes: TextAttributes.BOLD, children: focused ? "\u25B8 " : "  " }),
      /* @__PURE__ */ jsx("text", { fg: "white", children: shownTitle }),
      desc ? /* @__PURE__ */ jsx("text", { fg: "gray", children: desc }) : null,
      label ? /* @__PURE__ */ jsx("text", { fg: "cyan", children: ` ${label}` }) : null,
      focused ? /* @__PURE__ */ jsx("text", { fg: "gray", children: "  enter open" }) : null
    ] });
  }
  const bodyWidth = Math.max(8, width - 6);
  const bodyLines = (0, import_inline_ad_layout.wrapToLines)(ad.adText || description, bodyWidth, 3);
  return /* @__PURE__ */ jsxs(
    "box",
    {
      style: {
        width,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: focused ? "cyan" : "gray",
        paddingLeft: 1,
        paddingRight: 1
      },
      children: [
        /* @__PURE__ */ jsxs("box", { style: { flexDirection: "row", justifyContent: "space-between" }, children: [
          /* @__PURE__ */ jsx("text", { fg: "cyan", attributes: TextAttributes.BOLD, children: title }),
          label ? /* @__PURE__ */ jsx("text", { fg: "gray", children: label }) : null
        ] }),
        bodyLines.map((line, i) => /* @__PURE__ */ jsx("text", { fg: "white", children: line }, `body-${i}`)),
        ad.impUrl ? /* @__PURE__ */ jsx("text", { fg: "cyan", children: ad.impUrl }) : null,
        /* @__PURE__ */ jsx("text", { fg: "gray", children: focused ? "^O collapse \xB7 enter visit" : "^O collapse" })
      ]
    }
  );
}

// src/components/ApprovalPrompt.jsx
import React2, { useEffect as useEffect2, useState as useState2 } from "react";
import { useKeyboard as useKeyboard2 } from "@opentui/react";
import { TextAttributes as TextAttributes2 } from "@opentui/core";

// src/utils/danger-password.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var CONFIG_DIR = path.join(os.homedir(), ".hakster");
var CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
function getDangerPassword() {
  if (process.env.HAKSTER_DANGER_PASSWORD) return process.env.HAKSTER_DANGER_PASSWORD;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (cfg && typeof cfg.dangerPassword === "string") return cfg.dangerPassword;
  } catch {
  }
  return null;
}
function isSudoCommand(command) {
  return /^\s*sudo\b/i.test(String(command || ""));
}

// src/components/ApprovalPrompt.jsx
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function ApprovalPrompt({ width = 80, request, onAnswer }) {
  const [password, setPassword] = useState2("");
  const [wrong, setWrong] = useState2(false);
  const command = request && request.command || "";
  const toolCallId = request && request.toolCallId;
  const sudo = isSudoCommand(command);
  const dangerPassword = getDangerPassword();
  const needsPassword = sudo && !!dangerPassword;
  useEffect2(() => {
    setPassword("");
    setWrong(false);
  }, [toolCallId]);
  function submitPassword(value) {
    if (value === dangerPassword) {
      onAnswer(true, { permanent: false });
    } else {
      setPassword("");
      setWrong(true);
    }
  }
  useKeyboard2((key) => {
    if (!request) return;
    if (key.name === "escape") {
      onAnswer(false, { permanent: false });
      return;
    }
    if (needsPassword) {
      const name = key.name ? String(key.name) : "";
      if (name === "return") {
        submitPassword(password);
      } else if (name === "backspace" || name === "delete") {
        if (wrong) setWrong(false);
        setPassword((prev) => prev.slice(0, -1));
      } else if (name.length === 1) {
        if (wrong) setWrong(false);
        setPassword((prev) => prev + name);
      }
      return;
    }
    const k = key.name ? String(key.name).toLowerCase() : "";
    if (k === "y") onAnswer(true, { permanent: false });
    else if (k === "n") onAnswer(false, { permanent: false });
    else if (k === "a" && !sudo) onAnswer(true, { permanent: true });
  });
  if (!request) return null;
  const inner = Math.max(8, (width || 80) - 4);
  return /* @__PURE__ */ jsxs2(
    "box",
    {
      style: {
        width,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: sudo ? "red" : "yellow",
        paddingLeft: 1,
        paddingRight: 1
      },
      children: [
        /* @__PURE__ */ jsxs2("box", { style: { width: inner, flexDirection: "row", justifyContent: "space-between" }, children: [
          /* @__PURE__ */ jsx2("text", { fg: sudo ? "red" : "yellow", attributes: TextAttributes2.BOLD, children: sudo ? "sudo approval required" : "approval required" }),
          /* @__PURE__ */ jsx2("text", { fg: "gray", children: request.toolName })
        ] }),
        /* @__PURE__ */ jsx2("text", { fg: "gray", children: request.reason }),
        command ? /* @__PURE__ */ jsxs2("text", { children: [
          /* @__PURE__ */ jsx2("span", { fg: "gray", children: "$ " }),
          String(command).slice(0, Math.max(8, inner - 2))
        ] }) : null,
        needsPassword ? /* @__PURE__ */ jsxs2(Fragment, { children: [
          /* @__PURE__ */ jsxs2("box", { style: { width: inner, flexDirection: "row" }, children: [
            /* @__PURE__ */ jsx2("text", { fg: "yellow", attributes: TextAttributes2.BOLD, children: "password " }),
            /* @__PURE__ */ jsx2("text", { fg: password ? "white" : "gray", children: password ? "*".repeat(password.length) : "the agent approval password" })
          ] }),
          wrong ? /* @__PURE__ */ jsx2("text", { fg: "red", children: "wrong password \u2014 try again, or esc to deny" }) : null,
          /* @__PURE__ */ jsx2("text", { fg: "gray", children: "enter approves \xB7 esc denies" })
        ] }) : /* @__PURE__ */ jsxs2("text", { children: [
          /* @__PURE__ */ jsx2("span", { fg: "green", attributes: TextAttributes2.BOLD, children: "y" }),
          /* @__PURE__ */ jsx2("span", { fg: "gray", children: " allow this session  \xB7 " }),
          !sudo ? /* @__PURE__ */ jsxs2(Fragment, { children: [
            /* @__PURE__ */ jsx2("span", { fg: "cyan", attributes: TextAttributes2.BOLD, children: "a" }),
            /* @__PURE__ */ jsx2("span", { fg: "gray", children: " allow always  \xB7 " })
          ] }) : null,
          /* @__PURE__ */ jsx2("span", { fg: "red", attributes: TextAttributes2.BOLD, children: "n" }),
          /* @__PURE__ */ jsx2("span", { fg: "gray", children: " deny" })
        ] })
      ]
    }
  );
}

// src/components/Composer.jsx
import React3 from "react";
import { TextAttributes as TextAttributes3 } from "@opentui/core";
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
var clipHint = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}\u2026`;
};
function Composer({
  width,
  value = "",
  onChange,
  onSubmit,
  focused = true,
  disabled = false,
  placeholder = "describe a task\u2026",
  hint,
  adSlot
}) {
  const inner = Math.max(8, (width || 80) - 4);
  return /* @__PURE__ */ jsxs3(
    "box",
    {
      style: {
        width,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: focused ? "cyan" : "gray",
        paddingLeft: 1,
        paddingRight: 1
      },
      children: [
        /* @__PURE__ */ jsxs3("box", { style: { width: inner, flexDirection: "row" }, children: [
          /* @__PURE__ */ jsx3("text", { fg: disabled ? "gray" : "cyan", attributes: TextAttributes3.BOLD, children: disabled ? "\u2026 " : "\u203A " }),
          focused && !disabled ? /* @__PURE__ */ jsx3(
            "input",
            {
              style: { width: Math.max(1, inner - 2), flexGrow: 1, flexShrink: 1 },
              value,
              placeholder,
              onInput: onChange,
              onSubmit: (text) => {
                if (typeof onSubmit === "function") onSubmit(text);
              },
              focused: true
            }
          ) : /* @__PURE__ */ jsx3("text", { fg: "gray", children: value || (disabled ? "working\u2026" : placeholder) })
        ] }),
        adSlot,
        /* @__PURE__ */ jsx3("box", { style: { width: inner }, children: /* @__PURE__ */ jsx3("text", { fg: "gray", children: clipHint(hint || "enter send \xB7 esc stop \xB7 tab focus \xB7 ctrl+c quit", inner) }) })
      ]
    }
  );
}

// src/components/GridLayout.jsx
import React4 from "react";

// src/hooks/useGridLayout.js
import { useMemo } from "react";

// src/utils/layout-helpers.js
var MIN_COLUMN_WIDTH = 10;
function computeSmartColumns(itemCount, maxColumns) {
  if (itemCount === 0) return 1;
  if (itemCount <= maxColumns) return itemCount;
  if (itemCount % maxColumns === 0) return maxColumns;
  if (itemCount === 4 && maxColumns === 3) return 2;
  for (let c = maxColumns; c >= 2; c--) {
    if (itemCount % c === 0) return c;
  }
  return maxColumns;
}

// src/hooks/useGridLayout.js
var WIDTH_MD_THRESHOLD = 100;
var WIDTH_LG_THRESHOLD = 150;
var WIDTH_XL_THRESHOLD = 200;
var WIDTH_THRESHOLDS = [WIDTH_MD_THRESHOLD, WIDTH_LG_THRESHOLD, WIDTH_XL_THRESHOLD];
var COLUMN_GAP = 1;
function computeGridLayout(items, availableWidth) {
  const minWidthForTwoColumns = MIN_COLUMN_WIDTH * 2 + COLUMN_GAP;
  if (availableWidth < minWidthForTwoColumns) {
    return {
      columns: 1,
      columnWidth: Math.max(1, availableWidth),
      columnWidths: [Math.max(1, availableWidth)],
      columnGroups: [items]
    };
  }
  const maxColumns = WIDTH_THRESHOLDS.filter((t) => availableWidth >= t).length + 1;
  const columns = computeSmartColumns(items.length, maxColumns);
  const totalGap = columns - 1;
  const usable = Math.max(1, availableWidth - totalGap);
  const base = Math.max(1, Math.floor(usable / columns));
  const remainder = usable - base * columns;
  const columnWidths = Array.from(
    { length: columns },
    (_, i) => Math.max(MIN_COLUMN_WIDTH, base + (i < remainder ? 1 : 0))
  );
  const columnWidth = Math.max(...columnWidths);
  const columnGroups = Array.from({ length: columns }, () => []);
  items.forEach((item, idx) => {
    columnGroups[idx % columns].push(item);
  });
  return { columns, columnWidth, columnWidths, columnGroups };
}
function useGridLayout(items, availableWidth) {
  return useMemo(
    () => computeGridLayout(items, availableWidth),
    [items, availableWidth]
  );
}

// src/components/GridLayout.jsx
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function GridLayout({ items, availableWidth, getItemKey, renderItem, footer, marginTop = 0 }) {
  const { columns, columnWidths, columnGroups } = useGridLayout(items, availableWidth);
  if (items.length === 0) return null;
  const isMultiColumn = columns > 1;
  return /* @__PURE__ */ jsxs4("box", { style: { flexDirection: "column", gap: isMultiColumn ? 1 : 0, width: availableWidth, marginTop }, children: [
    /* @__PURE__ */ jsx4(
      "box",
      {
        style: {
          flexDirection: "row",
          gap: isMultiColumn ? 1 : 0,
          width: availableWidth,
          alignItems: "flex-start"
        },
        children: columnGroups.map((columnItems, colIdx) => {
          const columnKey = columnItems[0] ? getItemKey(columnItems[0]) : `col-${colIdx}`;
          const colWidth = columnWidths[colIdx] ?? availableWidth;
          return /* @__PURE__ */ jsx4(
            "box",
            {
              style: {
                flexDirection: "column",
                gap: 0,
                width: colWidth,
                flexShrink: 0,
                minWidth: MIN_COLUMN_WIDTH
              },
              children: columnItems.map((item, idx) => /* @__PURE__ */ jsx4("box", { style: { width: colWidth }, children: renderItem(item, idx, colWidth) }, getItemKey(item)))
            },
            columnKey
          );
        })
      }
    ),
    footer
  ] });
}
var GridLayout_default = GridLayout;

// src/components/GridPanel.jsx
import React5 from "react";
import { TextAttributes as TextAttributes4 } from "@opentui/core";
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function GridPanel({ title, cols = 4, width, children, borderColor = "gray", hint, dense = false }) {
  const inner = Math.max(1, (width || 80) - 4);
  const titleText = String(title || "");
  const hintText = String(hint || "");
  const hintWidth = Math.max(0, inner - titleText.length - 1);
  const clippedHint = hintText.length <= hintWidth ? hintText : hintWidth > 1 ? `${hintText.slice(0, hintWidth - 1)}\u2026` : "";
  const body = dense ? React5.Children.map(children, (child) => React5.isValidElement(child) && child.type === Cell ? React5.cloneElement(child, { dense: true }) : child) : children;
  return /* @__PURE__ */ jsxs5("box", { style: { width, flexDirection: "column", border: true, borderStyle: "rounded", borderColor, paddingLeft: 1, paddingRight: 1 }, children: [
    /* @__PURE__ */ jsxs5("box", { style: { width: inner, flexDirection: "row", justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsx5("text", { fg: "cyan", attributes: TextAttributes4.BOLD, children: titleText.slice(0, inner) }),
      clippedHint ? /* @__PURE__ */ jsx5("text", { fg: "gray", children: clippedHint }) : null
    ] }),
    /* @__PURE__ */ jsx5("box", { style: { width: inner, flexDirection: "row", flexWrap: "wrap" }, children: body })
  ] });
}
function Cell({ label, value, w = 18, color = "white", dense = false }) {
  const clip7 = (s, n) => {
    const t = String(s == null ? "\u2014" : s);
    return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + "\u2026";
  };
  if (dense) {
    const lw = Math.max(3, Math.min(Math.floor(w / 2), 8));
    return /* @__PURE__ */ jsxs5("box", { style: { width: Math.max(1, w), flexDirection: "row", flexShrink: 0, marginRight: 1 }, children: [
      /* @__PURE__ */ jsx5("text", { fg: "gray", children: clip7(label, lw) }),
      /* @__PURE__ */ jsx5("text", { fg: color, attributes: TextAttributes4.BOLD, children: ` ${clip7(value, Math.max(1, w - lw - 1))}` })
    ] });
  }
  return /* @__PURE__ */ jsxs5("box", { style: { width: Math.max(1, w), flexDirection: "column", flexShrink: 0, marginRight: 1 }, children: [
    /* @__PURE__ */ jsx5("text", { fg: "gray", children: clip7(label, w) }),
    /* @__PURE__ */ jsx5("text", { fg: color, attributes: TextAttributes4.BOLD, children: clip7(value, w) })
  ] });
}
function Meter({ value, max = 100, w = 16, color = "green" }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(pct * w);
  return /* @__PURE__ */ jsxs5("text", { children: [
    /* @__PURE__ */ jsx5("span", { fg: color, children: "\u2588".repeat(filled) }),
    /* @__PURE__ */ jsx5("span", { fg: "gray", children: "\u2591".repeat(Math.max(0, w - filled)) }),
    /* @__PURE__ */ jsx5("span", { fg: "gray", children: ` ${String(Math.round(pct * 100)).padStart(3)}%` })
  ] });
}
function Spark({ data = [], w = 24 }) {
  const blocks = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
  if (!data.length) return /* @__PURE__ */ jsx5("text", { fg: "gray", children: "\u2581".repeat(w) });
  const window = data.slice(-w);
  const max = Math.max(...window, 1);
  const min = Math.min(...window, 0);
  const span = max - min || 1;
  return /* @__PURE__ */ jsx5("text", { fg: "cyan", children: window.map((v, i) => {
    const idx = Math.round((v - min) / span * (blocks.length - 1));
    return blocks[Math.max(0, Math.min(blocks.length - 1, idx))];
  }).join("") });
}
var GridPanel_default = GridPanel;

// src/components/LiveSidebar.jsx
import React7, { useEffect as useEffect4, useRef as useRef2, useState as useState4 } from "react";
import { TextAttributes as TextAttributes5 } from "@opentui/core";
import { useKeyboard as useKeyboard3 } from "@opentui/react";

// src/utils/panel-scroll.js
var maxStartOf = (total, rows) => {
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  const r = Math.max(0, Math.trunc(Number(rows) || 0));
  return Math.max(0, n - r);
};
var clampStart = (offset, total, rows) => offset == null ? maxStartOf(total, rows) : Math.max(0, Math.min(Math.trunc(Number(offset) || 0), maxStartOf(total, rows)));
var stepOffset = (offset, total, rows, delta) => {
  const max = maxStartOf(total, rows);
  const base = offset == null ? max : Math.max(0, Math.min(Math.trunc(Number(offset) || 0), max));
  const next = Math.max(0, Math.min(max, base + Math.trunc(Number(delta) || 0)));
  return next >= max ? null : next;
};
var overflows = (total, rows) => Number(rows) > 0 && Number(total) > Number(rows);
var gutterChar = (i, rows, total, start2) => {
  const r = Math.max(0, Math.trunc(Number(rows) || 0));
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  if (!overflows(n, r)) return "\u2502";
  if (r <= 2) return "\u2588";
  const row = Math.max(0, Math.min(r - 1, Math.trunc(Number(i) || 0)));
  if (row === 0) return "\u25B2";
  if (row === r - 1) return "\u25BC";
  const track = Math.max(1, r - 2);
  const thumb = Math.max(1, Math.min(track, Math.round(track * r / Math.max(1, n))));
  const maxStart = Math.max(1, n - r);
  const pos = Math.max(0, Math.min(maxStart, Math.trunc(Number(start2) || 0)));
  const top = Math.round(pos / maxStart * Math.max(0, track - thumb));
  const at = row - 1;
  return at >= top && at < top + thumb ? "\u2588" : "\u2502";
};
var scrollHint = (total, rows, start2, following = true) => {
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  const r = Math.max(0, Math.trunc(Number(rows) || 0));
  if (!overflows(n, r)) return String(n);
  const s = clampStart(start2, n, r);
  const parked = !following && s < maxStartOf(n, r);
  return `${s + 1}-${Math.min(n, s + r)}/${n}${parked ? " \u21E3" : ""}`;
};
var nearestStart = (selected, total, rows) => {
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  const r = Math.max(0, Math.trunc(Number(rows) || 0));
  if (!n || !r) return 0;
  const sel = Math.max(0, Math.min(n - 1, Math.trunc(Number(selected) || 0)));
  return Math.max(0, Math.min(sel - Math.floor(r / 2), maxStartOf(n, r)));
};
var BINDING_MODS = {
  none: {},
  shift: { shift: true },
  alt: { meta: true },
  ctrl: { ctrl: true }
};
var keyMatches = (key, name, mod = "none") => {
  if (!key || key.name !== name) return false;
  const want = BINDING_MODS[mod] || {};
  return !!key.shift === !!want.shift && !!key.meta === !!want.meta && !!key.ctrl === !!want.ctrl;
};

// src/components/LiveImageViewer.jsx
var import_kitty_graphics = __toESM(require_kitty_graphics());
var import_live_image = __toESM(require_live_image());
import React6, { useEffect as useEffect3, useRef, useState as useState3 } from "react";
import fs2 from "node:fs";
import { useRenderer } from "@opentui/react";
import { Fragment as Fragment2, jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
function LiveImageViewer({
  width = 40,
  height = 6,
  source = null,
  graphics = true,
  label = ""
}) {
  const w = Math.max(8, Number(width) || 40);
  const h = Math.max(2, Number(height) || 6);
  const renderer2 = useRenderer();
  const boxRef = useRef(null);
  const [state, setState] = useState3({ status: "waiting" });
  const ref = source && source.ref ? String(source.ref) : "";
  useEffect3(() => {
    let cancelled = false;
    if (!source || !source.ref) {
      setState({ status: "none" });
      return void 0;
    }
    setState({ status: "loading" });
    (0, import_live_image.materialize)(source).then((r) => {
      if (cancelled) return;
      setState(r && r.ok ? { status: "ready", file: r.file, name: r.name } : { status: "error", reason: r && r.reason || "unavailable" });
    }).catch((e) => {
      if (!cancelled) setState({ status: "error", reason: e && e.message || "unavailable" });
    });
    return () => {
      cancelled = true;
    };
  }, [ref]);
  const supported = graphics && (0, import_kitty_graphics.isSupported)(process.env, process.stdout);
  const ready = state.status === "ready" && supported;
  useEffect3(() => {
    if (!ready || !state.file) return void 0;
    let placed = null;
    let onFrame = null;
    let disposed = false;
    const withPaused = (fn) => {
      try {
        if (renderer2 && typeof renderer2.pause === "function") renderer2.pause();
        return fn();
      } finally {
        try {
          if (renderer2 && typeof renderer2.resume === "function") renderer2.resume();
        } catch {
        }
      }
    };
    const spot = () => {
      const box = boxRef.current;
      if (!box) return null;
      const x = Number(typeof box.screenX === "function" ? box.screenX() : box.screenX);
      const y = Number(typeof box.screenY === "function" ? box.screenY() : box.screenY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { row: Math.max(1, Math.round(y) + 1), col: Math.max(1, Math.round(x) + 1) };
    };
    const settle = () => {
      if (disposed) return;
      const at = spot();
      if (!at) return;
      let size = null;
      try {
        size = (0, import_kitty_graphics.pngSize)(fs2.readFileSync(state.file));
      } catch {
        size = null;
      }
      let cols = w;
      let rows2 = h;
      if (size && size.width > 0 && size.height > 0) {
        rows2 = h;
        cols = Math.round(rows2 * size.width / (size.height * 2));
        if (cols > w) {
          cols = w;
          rows2 = Math.max(1, Math.round(cols * size.height * 2 / size.width));
        }
        if (cols < 4) cols = Math.min(w, 4);
        if (rows2 < 1) rows2 = 1;
        if (rows2 > h) rows2 = h;
      }
      withPaused(() => {
        const write = (s) => process.stdout.write(s);
        (0, import_kitty_graphics.moveCursor)(at.row, at.col, write);
        if (placed) (0, import_kitty_graphics.deletePlacement)({ placementId: 1, write });
        if (!placed) placed = (0, import_kitty_graphics.placeImage)({ file: state.file, cols, rows: rows2, zIndex: -1 });
        else (0, import_kitty_graphics.placeById)({ id: placed.id, placementId: 1, zIndex: -1, write });
      });
      if (!onFrame && placed && renderer2 && typeof renderer2.on === "function") {
        onFrame = () => {
          if (placed) {
            const at2 = spot();
            if (at2) withPaused(() => {
              const write = (s) => process.stdout.write(s);
              (0, import_kitty_graphics.moveCursor)(at2.row, at2.col, write);
              (0, import_kitty_graphics.placeById)({ id: placed.id, placementId: 1, zIndex: -1, write });
            });
          }
        };
        try {
          renderer2.on("frame", onFrame);
        } catch {
          onFrame = null;
        }
      }
    };
    const timer = setTimeout(settle, 40);
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (onFrame) {
        try {
          renderer2.off("frame", onFrame);
        } catch {
        }
      }
      if (placed) withPaused(() => (0, import_kitty_graphics.deleteImage)(placed.id));
    };
  }, [ready, state.file, w, h, renderer2]);
  const line = (text, fg) => /* @__PURE__ */ jsx6("box", { style: { width: w, flexShrink: 0 }, children: /* @__PURE__ */ jsx6("text", { fg, children: clip(text, w) }) });
  const pad = (n) => Array.from({ length: Math.max(0, n) }, (_, i) => /* @__PURE__ */ jsx6("box", { style: { width: w, flexShrink: 0 }, children: /* @__PURE__ */ jsx6("text", { children: " " }) }, `pad:${i}`));
  if (ready) {
    return /* @__PURE__ */ jsx6("box", { ref: boxRef, style: { width: w, height: h, flexShrink: 0 } });
  }
  const head = state.status === "error" ? `\u{1F5BC} ${state.reason}` : state.status === "loading" ? "\u{1F5BC} loading\u2026" : "\u{1F5BC} image";
  const name = label || source && source.name || "";
  const where = source && source.ref ? String(source.ref) : "";
  const rows = [
    [head, "yellow"],
    [name ? `image: ${name}` : "", "white"],
    [where ? supported ? "in terminal: kitty graphics" : "no graphics here \u2014 open this link:" : "", "gray"],
    [where, "cyan"]
  ];
  return /* @__PURE__ */ jsxs6(Fragment2, { children: [
    rows.slice(0, h).map(([text, fg], i) => line(text, i === 0 ? fg : fg)),
    pad(h - rows.length)
  ] });
}

// src/components/LiveSidebar.jsx
import { Fragment as Fragment3, jsx as jsx7, jsxs as jsxs7 } from "react/jsx-runtime";
var isWide = (cp) => cp >= 4352 && cp <= 4447 || cp === 9001 || cp === 9002 || cp >= 9728 && cp <= 10175 || cp >= 11008 && cp <= 11263 || cp >= 11904 && cp <= 42191 || cp >= 44032 && cp <= 55203 || cp >= 63744 && cp <= 64255 || cp >= 65072 && cp <= 65135 || cp >= 65280 && cp <= 65376 || cp >= 65504 && cp <= 65510 || cp >= 126976 && cp <= 129791;
var cellWidth = (ch) => {
  const cp = ch.codePointAt(0);
  if (cp === 65039 || cp === 8205) return 0;
  return isWide(cp) ? 2 : 1;
};
var clip = (s, n) => {
  const t = String(s == null ? "\u2014" : s);
  let w = 0;
  for (const ch of t) w += cellWidth(ch);
  if (w <= n) return t;
  let out = "";
  let acc = 0;
  for (const ch of t) {
    const c = cellWidth(ch);
    if (acc + c > Math.max(0, n - 1)) break;
    out += ch;
    acc += c;
  }
  return `${out}\u2026`;
};
function Row({ width, k, v, color = "white" }) {
  const kw = Math.min(10, Math.max(4, Math.floor(width / 3)));
  return /* @__PURE__ */ jsxs7("box", { style: { width, flexDirection: "row", justifyContent: "space-between", flexShrink: 0 }, children: [
    /* @__PURE__ */ jsx7("text", { fg: "gray", children: clip(k, kw) }),
    /* @__PURE__ */ jsx7("text", { fg: color, attributes: TextAttributes5.BOLD, children: clip(v, Math.max(1, width - kw - 1)) })
  ] });
}
var EVENT_COLOR = {
  phase: "cyan",
  start: "yellow",
  ok: "green",
  err: "red",
  mcp: "blue",
  done: "green",
  handoff: "magenta",
  confirm: "yellow",
  sys: "gray"
};
var EVENT_GLYPH = {
  phase: "\u25C8",
  start: "\u2699",
  ok: "\u2713",
  err: "\u2717",
  mcp: "\u2B21",
  done: "\u25CF",
  handoff: "\u21C4",
  confirm: "\u26A0",
  sys: "\u2022"
};
var fmtTok = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  return v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v));
};
var clock = (ts) => {
  const d = new Date(Number(ts) || Date.now());
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
function EventLine({ width, line, compact = false }) {
  return /* @__PURE__ */ jsx7("box", { style: { width, flexShrink: 0 }, children: /* @__PURE__ */ jsxs7("text", { children: [
    compact ? null : /* @__PURE__ */ jsx7("span", { fg: "gray", children: `${clock(line.ts)} ` }),
    /* @__PURE__ */ jsx7("span", { fg: EVENT_COLOR[line.kind] || "white", children: `${EVENT_GLYPH[line.kind] || "\u2022"} ` }),
    /* @__PURE__ */ jsx7("span", { fg: line.kind === "err" ? "red" : "white", children: clip(line.text, Math.max(1, width - (compact ? 2 : 8))) })
  ] }) });
}
function ScrollRow({ width, children, gutter }) {
  return /* @__PURE__ */ jsxs7("box", { style: { width, flexDirection: "row", flexShrink: 0 }, children: [
    children,
    gutter ? /* @__PURE__ */ jsx7("text", { fg: "gray", children: gutter }) : null
  ] });
}
function Panel({ width, title, hint, children, borderColor = "gray" }) {
  const inner = Math.max(1, width - 4);
  return /* @__PURE__ */ jsxs7("box", { style: { width, flexDirection: "column", border: true, borderStyle: "rounded", borderColor, paddingLeft: 1, paddingRight: 1, flexShrink: 0 }, children: [
    /* @__PURE__ */ jsxs7("box", { style: { width: inner, flexDirection: "row", justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsx7("text", { fg: "cyan", attributes: TextAttributes5.BOLD, children: clip(title, inner) }),
      hint ? /* @__PURE__ */ jsx7("text", { fg: "gray", children: clip(hint, Math.max(0, inner - title.length - 1)) }) : null
    ] }),
    /* @__PURE__ */ jsx7("box", { style: { width: inner, flexDirection: "column" }, children })
  ] });
}
function LiveSidebar({
  width = 30,
  // The sidebar's whole vertical allowance, in rows (header + status already
  // removed by the caller). Every panel is fitted inside it; nothing below is
  // allowed to push the layout apart, so a short terminal simply shows fewer
  // panels rather than a broken screen.
  height = 34,
  // agentStatus / phase are still accepted so both call sites keep working,
  // but they no longer draw a row: the spinner row, the status bar and the
  // monitor feed own the run state and the phase (owner, 2026-11-24).
  agentStatus: _agentStatus = "idle",
  phase: _phase = "IDLE",
  tool = "",
  turns = 0,
  elapsedMs = 0,
  version = "0.1.0",
  mcp = null,
  serverOk = false,
  liveTool = "",
  liveLines = [],
  liveImage = null,
  graphics = true,
  busy = false,
  activity = [],
  usage = null,
  memory = null,
  update = null,
  // The monitor view renders the big Activity/Output columns itself, so it
  // asks the sidebar for the same panels minus those two; their rows go to
  // the MCP list instead.
  feed = true
}) {
  void _agentStatus;
  void _phase;
  void turns;
  const inner = Math.max(1, width - 4);
  const servers = mcp && Array.isArray(mcp.servers) ? mcp.servers : [];
  const h = Math.max(0, Number(height) || 0);
  const tall = h >= 44;
  const huge = h >= 50;
  const liveRows = Math.min(2, Math.max(0, h - 3));
  let left = h - (3 + liveRows);
  const showUsage = left >= 9;
  if (showUsage) left -= 9;
  const showMemory = left >= 26;
  if (showMemory) left -= 8;
  const wantOutput = huge ? 12 : tall ? 9 : 6;
  const MCP_MIN = 5;
  const ACT_MIN = 2;
  const activityMax = huge ? showMemory ? 8 : 10 : tall ? 7 : 5;
  const outRoom = Math.max(0, left - 4);
  const outCap = outRoom - MCP_MIN - ACT_MIN >= 2 ? outRoom - MCP_MIN - ACT_MIN : outRoom;
  const outputRows = feed && outCap >= 2 ? Math.min(wantOutput, outCap) : 0;
  if (outputRows) left -= outputRows + 4;
  const actCap = left - 3 - MCP_MIN;
  const activityRows = feed && actCap >= ACT_MIN ? Math.min(activityMax, actCap) : 0;
  if (activityRows) left -= activityRows + 3;
  const maxServers = Math.max(0, left - 4);
  const live = servers.filter((s) => s.initialized || (s.toolCount || 0) > 0).length;
  const ordered = [...servers].sort((a, b) => {
    const rank = (x) => x.initialized || (x.toolCount || 0) > 0 ? 0 : x.lazy ? 1 : 2;
    return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
  });
  const [actOffset, setActOffset] = useState4(null);
  const [outOffset, setOutOffset] = useState4(null);
  const [mcpOffset, setMcpOffset] = useState4(null);
  const prevAct = useRef2(activity.length);
  const prevOut = useRef2(liveLines.length);
  useEffect4(() => {
    if (busy && activity.length > prevAct.current) setActOffset(null);
    if (busy && liveLines.length > prevOut.current) setOutOffset(null);
    prevAct.current = activity.length;
    prevOut.current = liveLines.length;
  }, [activity.length, liveLines.length, busy]);
  const actStart = clampStart(actOffset, activity.length, activityRows || 1);
  const outStart = clampStart(outOffset, liveLines.length, outputRows || 1);
  const compact = inner < 24;
  const mcpCapacity = maxServers + 1;
  const mcpOverflow = ordered.length > mcpCapacity;
  const mcpVisible = Math.max(0, mcpOverflow ? mcpCapacity - 1 : ordered.length);
  const mcpStart = mcpOffset == null ? 0 : Math.max(0, Math.min(mcpOffset, Math.max(0, ordered.length - mcpVisible)));
  const shownServers = ordered.slice(mcpStart, mcpStart + mcpVisible);
  const moreAbove = mcpStart;
  const moreBelow = ordered.length - mcpStart - shownServers.length;
  const scrollBy = (setter, total, rows, delta) => {
    if (!rows) return;
    const max = Math.max(0, total - rows);
    setter((cur) => {
      const base = cur == null ? max : cur;
      const next = Math.max(0, Math.min(max, base + delta));
      return next >= max ? null : next;
    });
  };
  useKeyboard3((key) => {
    if (!key || key.ctrl) return;
    const name = key.name;
    if (name === "home" || name === "end") {
      const bottom = name === "end";
      if (key.meta) {
        setMcpOffset(bottom && !mcpOverflow ? null : bottom ? Math.max(0, ordered.length - mcpVisible) : null);
      } else if (key.shift) {
        if (activityRows) setActOffset(bottom ? null : 0);
        else if (outputRows) setOutOffset(bottom ? null : 0);
      }
      return;
    }
    if (name !== "up" && name !== "down" && name !== "pageup" && name !== "pagedown") return;
    const page = name === "pageup" ? -1 : name === "pagedown" ? 1 : 0;
    if (key.meta) {
      const step = page ? page * Math.max(1, mcpVisible) : name === "up" ? -1 : 1;
      scrollBy(setMcpOffset, ordered.length, mcpVisible, step);
      return;
    }
    if (!key.shift) return;
    if (activityRows) {
      const step = page ? page * Math.max(1, activityRows) : name === "up" ? -1 : 1;
      scrollBy(setActOffset, activity.length, activityRows, step);
    } else if (outputRows) {
      const step = page ? page * Math.max(1, outputRows) : name === "up" ? -1 : 1;
      scrollBy(setOutOffset, liveLines.length, outputRows, step);
    }
  });
  const actGutter = overflows(activity.length, activityRows);
  const outGutter = overflows(liveLines.length, outputRows);
  const actBody = Math.max(1, inner - (actGutter ? 1 : 0));
  const outBody = Math.max(1, inner - (outGutter ? 1 : 0));
  const actHint = !activity.length ? busy ? "waiting" : "0" : scrollHint(activity.length, activityRows, actStart, actOffset == null);
  const outHint = !liveLines.length ? busy ? "live" : "last" : scrollHint(liveLines.length, outputRows, outStart, outOffset == null);
  return /* @__PURE__ */ jsxs7("box", { style: { width, flexDirection: "column", flexShrink: 0 }, children: [
    /* @__PURE__ */ jsxs7(Panel, { width, title: "\u25C8 Live", hint: serverOk ? "" : "offline", children: [
      liveRows >= 1 ? /* @__PURE__ */ jsx7(Row, { width: inner, k: "tool", v: tool || "\u2014" }) : null,
      liveRows >= 2 ? /* @__PURE__ */ jsx7(
        Row,
        {
          width: inner,
          k: "version",
          v: update && update.version && (update.status === "staged" || update.status === "blocked") ? `tui ${version} ${update.status === "blocked" ? "\u27C2" : "\u2B06"}${update.version}` : `tui ${version}`,
          color: update && update.status === "blocked" ? "yellow" : update && update.status === "staged" ? "green" : "white"
        }
      ) : null
    ] }),
    showUsage ? /* @__PURE__ */ jsxs7(Panel, { width, title: "\u25D4 Usage", hint: busy ? "live" : "session", children: [
      /* @__PURE__ */ jsx7(Row, { width: inner, k: "tools", v: compact ? String(Number(usage && usage.tools) || 0) : `${Number(usage && usage.tools) || 0} calls`, color: "cyan" }),
      /* @__PURE__ */ jsx7(
        Row,
        {
          width: inner,
          k: "wins",
          v: `${Number(usage && usage.ok) || 0}\u2713 ${Number(usage && usage.fail) || 0}\u2717`,
          color: Number(usage && usage.fail) > 0 ? "yellow" : "green"
        }
      ),
      /* @__PURE__ */ jsx7(Row, { width: inner, k: "requests", v: Number(usage && usage.requests) || 0 }),
      /* @__PURE__ */ jsx7(Row, { width: inner, k: "turns", v: Number(usage && usage.turns) || 0 }),
      /* @__PURE__ */ jsx7(Row, { width: inner, k: "tokens", v: usage && usage.tokensKnown ? `${fmtTok(usage.inTok)} / ${fmtTok(usage.outTok)}` : "\u2014", color: "white" }),
      /* @__PURE__ */ jsx7(
        Row,
        {
          width: inner,
          k: "ctx",
          v: usage && usage.ctxPct != null ? `${usage.ctxPct}%` : "\u2014",
          color: Number(usage && usage.ctxPct) > 85 ? "red" : Number(usage && usage.ctxPct) > 60 ? "yellow" : "green"
        }
      )
    ] }) : null,
    showMemory ? /* @__PURE__ */ jsx7(Panel, { width, title: "\u{1F9E0} Memory", hint: memory ? `${memory.total} entries` : "\u2026", children: !memory ? /* @__PURE__ */ jsx7("box", { style: { width: inner }, children: /* @__PURE__ */ jsx7("text", { fg: "gray", children: clip("\u2014", inner) }) }) : memory.banks.length === 0 ? /* @__PURE__ */ jsx7("box", { style: { width: inner }, children: /* @__PURE__ */ jsx7("text", { fg: "gray", children: clip("empty", inner) }) }) : /* @__PURE__ */ jsxs7(Fragment3, { children: [
      (memory.banks.length > 4 ? memory.banks.slice(0, 4) : memory.banks).map((b) => /* @__PURE__ */ jsx7(
        Row,
        {
          width: inner,
          k: b.slug,
          v: compact ? String(b.entries) : `${b.entries} ${b.entries === 1 ? "entry" : "entries"}`,
          color: "green"
        },
        b.slug
      )),
      memory.banks.length < 4 && memory.newest ? /* @__PURE__ */ jsx7(Row, { width: inner, k: "newest", v: `${memory.newest.slug} ${clock(memory.newest.last)}`, color: "gray" }) : null,
      /* @__PURE__ */ jsx7(
        Row,
        {
          width: inner,
          k: "clusters",
          v: compact ? String(memory.clusters) : `${memory.clusters} tags`,
          color: "cyan"
        }
      )
    ] }) }) : null,
    activityRows ? /* @__PURE__ */ jsx7(Panel, { width, title: "\u26A1 Activity", hint: actHint, children: activity.length === 0 ? /* @__PURE__ */ jsxs7(Fragment3, { children: [
      /* @__PURE__ */ jsx7("box", { style: { width: inner }, children: /* @__PURE__ */ jsx7("text", { fg: "gray", children: clip(busy ? "waiting for events\u2026" : "\u2014", inner) }) }),
      Array.from({ length: Math.max(0, activityRows - 1) }, (_, i) => /* @__PURE__ */ jsx7("box", { style: { width: inner, flexShrink: 0 }, children: /* @__PURE__ */ jsx7("text", { children: " " }) }, `apad:${i}`))
    ] }) : (
      // Exactly `activityRows` rows whether two events or twenty have
      // arrived: the panel (and the bar's track) keeps its height while a
      // run streams, so the panels below never jump and the thumb keeps
      // pace with the newest line.
      Array.from({ length: activityRows }, (_, i) => {
        const line = activity[actStart + i];
        return /* @__PURE__ */ jsx7(
          ScrollRow,
          {
            width: inner,
            gutter: actGutter ? gutterChar(i, activityRows, activity.length, actStart) : null,
            children: line ? /* @__PURE__ */ jsx7(EventLine, { width: actBody, line, compact }) : /* @__PURE__ */ jsx7("box", { style: { width: actBody }, children: /* @__PURE__ */ jsx7("text", { children: " " }) })
          },
          `e:${actStart + i}:${i}`
        );
      })
    ) }) : null,
    outputRows ? /* @__PURE__ */ jsxs7(Panel, { width, title: "\u25B6 Output", hint: outHint, children: [
      /* @__PURE__ */ jsx7(Row, { width: inner, k: "call", v: liveTool ? clip(liveTool, Math.max(1, inner - 5)) : "\u2014", color: liveTool ? "cyan" : "gray" }),
      liveImage && outputRows >= 3 ? /* @__PURE__ */ jsx7(LiveImageViewer, { width: inner, height: outputRows, source: liveImage, graphics }) : liveLines.length === 0 ? /* @__PURE__ */ jsxs7(Fragment3, { children: [
        /* @__PURE__ */ jsx7("box", { style: { width: inner }, children: /* @__PURE__ */ jsx7("text", { fg: "gray", children: clip(busy ? "waiting for output\u2026" : "\u2014", inner) }) }),
        Array.from({ length: Math.max(0, outputRows - 1) }, (_, i) => /* @__PURE__ */ jsx7("box", { style: { width: inner, flexShrink: 0 }, children: /* @__PURE__ */ jsx7("text", { children: " " }) }, `opad:${i}`))
      ] }) : (
        // Same contract as Activity: the tail is drawn in a fixed-height
        // window, padded to `outputRows`, with the ▲/█/▼ bar on every row —
        // the bar tracks the newest line as output streams instead of
        // appearing late on a panel that grew to meet it.
        Array.from({ length: outputRows }, (_, i) => {
          const index = outStart + i;
          return /* @__PURE__ */ jsx7(
            ScrollRow,
            {
              width: inner,
              gutter: outGutter ? gutterChar(i, outputRows, liveLines.length, outStart) : null,
              children: index < liveLines.length ? /* @__PURE__ */ jsx7("box", { style: { width: outBody }, children: /* @__PURE__ */ jsx7("text", { fg: index === liveLines.length - 1 ? "white" : "gray", children: clip(liveLines[index], outBody) }) }) : /* @__PURE__ */ jsx7("box", { style: { width: outBody }, children: /* @__PURE__ */ jsx7("text", { children: " " }) })
            },
            `o:${index}:${i}`
          );
        })
      )
    ] }) : null,
    maxServers > 0 ? /* @__PURE__ */ jsxs7(Panel, { width, title: "\u2B21 MCP servers", hint: servers.length ? `${live}/${servers.length}` : "\u2026", children: [
      shownServers.map((s, i) => {
        const up = !!s.initialized || (s.toolCount || 0) > 0;
        const lazy = !!s.lazy && !up;
        const bar = mcpOverflow ? gutterChar(i, mcpVisible, ordered.length, mcpStart) : null;
        return /* @__PURE__ */ jsx7(ScrollRow, { width: inner, gutter: bar, children: /* @__PURE__ */ jsx7(
          Row,
          {
            width: Math.max(1, inner - (bar ? 1 : 0)),
            k: s.name,
            v: up ? `${s.toolCount || 0} tools` : lazy ? "lazy" : "down",
            color: up ? "green" : lazy ? "yellow" : "red"
          }
        ) }, s.name);
      }),
      moreAbove || moreBelow ? /* @__PURE__ */ jsx7(
        Row,
        {
          width: inner,
          k: "more",
          v: `${moreAbove ? `\u25B2 ${moreAbove} ` : ""}${moreBelow ? `\u25BC ${moreBelow}` : ""}`.trim(),
          color: "gray"
        }
      ) : null
    ] }) : null
  ] });
}

// src/components/LiveOutputPanel.jsx
import React8 from "react";

// src/hooks/usePanelScroll.js
import { useCallback, useEffect as useEffect5, useRef as useRef3, useState as useState5 } from "react";
import { useKeyboard as useKeyboard4 } from "@opentui/react";
function usePanelScroll({
  total = 0,
  rows = 0,
  bindings = null,
  enabled = true,
  initial = "follow",
  selected = null,
  autoResume = false
}) {
  const [offset, setOffsetState] = useState5(initial === "top" ? 0 : null);
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  const r = Math.max(0, Math.trunc(Number(rows) || 0));
  const start2 = selected == null ? clampStart(offset, n, r) : nearestStart(selected, n, r);
  const following = selected != null ? true : offset == null;
  const prevTotal = useRef3(n);
  useEffect5(() => {
    if (autoResume && n > prevTotal.current && offset != null) setOffsetState(null);
    prevTotal.current = n;
  }, [n, autoResume, offset]);
  const setOffset = useCallback((value) => {
    setOffsetState((cur) => typeof value === "function" ? value(cur) : value);
  }, []);
  const scrollBy = useCallback(
    (delta) => {
      setOffsetState((cur) => stepOffset(cur, n, r, delta));
    },
    [n, r]
  );
  const toTop = useCallback(() => setOffsetState(0), []);
  const toBottom = useCallback(() => setOffsetState(null), []);
  useKeyboard4((key) => {
    if (!enabled || !bindings || !r) return;
    const names = ["up", "down", "pageup", "pagedown", "home", "end", "left", "right"];
    for (const name of names) {
      const mod = bindings[name];
      if (!mod || !keyMatches(key, name, mod)) continue;
      if (name === "home") return toTop();
      if (name === "end") return toBottom();
      const page = name === "pageup" || name === "pagedown";
      const back = name === "up" || name === "pageup" || name === "left";
      const delta = page ? back ? -Math.max(1, r) : Math.max(1, r) : back ? -1 : 1;
      return scrollBy(delta);
    }
  });
  return {
    offset,
    setOffset,
    start: start2,
    following,
    total: n,
    rows: r,
    maxStart: maxStartOf(n, r),
    gutter: (i) => selected == null && n > r ? gutterChar(i, r, n, start2) : null,
    hint: (fallback = "") => n === 0 ? fallback : scrollHint(n, r, start2, following),
    scrollBy,
    toTop,
    toBottom
  };
}

// src/components/LiveOutputPanel.jsx
import { Fragment as Fragment4, jsx as jsx8, jsxs as jsxs8 } from "react/jsx-runtime";
function LiveOutputPanel({
  width = 80,
  rows = 3,
  lines = [],
  call = "",
  busy = false,
  bindings = null,
  image = null,
  graphics = true,
  phase = ""
}) {
  const w = Math.max(20, Number(width) || 80);
  const inner = Math.max(1, w - 4);
  const r = Math.max(1, Math.trunc(Number(rows) || 1));
  const list = Array.isArray(lines) ? lines : [];
  const callRow = w >= 44;
  const compact = !callRow;
  const state = usePanelScroll({ total: list.length, rows: r, bindings, enabled: r > 0, autoResume: busy });
  const gutterOn = overflows(list.length, r);
  const bodyW = Math.max(1, inner - (gutterOn ? 1 : 0));
  const emptyHint = phase === "thinking" ? "reasoning above \u2014 the answer lands here" : phase === "running" ? "tool running\u2026" : "waiting for the first token\u2026";
  const hint = image ? `image${call && compact ? ` \xB7 ${clip(call, Math.max(6, inner - 12))}` : ""}` : list.length ? `${state.hint("")}${call && compact ? ` \xB7 ${clip(call, Math.max(6, inner - 12))}` : ""}` : busy ? "" : "last";
  return /* @__PURE__ */ jsxs8(Panel, { width: w, title: busy ? "\u25B6 Live" : "\u25B6 Result", hint, children: [
    callRow ? /* @__PURE__ */ jsx8("box", { style: { width: inner, flexShrink: 0 }, children: /* @__PURE__ */ jsx8("text", { fg: call ? "cyan" : "gray", children: clip(call || "\u2014", inner) }) }) : null,
    image && r >= 3 ? /* @__PURE__ */ jsx8(LiveImageViewer, { width: bodyW, height: r, source: image, graphics }) : list.length === 0 ? /* @__PURE__ */ jsxs8(Fragment4, { children: [
      /* @__PURE__ */ jsx8("box", { style: { width: inner, flexShrink: 0 }, children: /* @__PURE__ */ jsx8("text", { fg: "gray", children: busy ? clip(emptyHint, inner) : " " }) }),
      Array.from({ length: Math.max(0, r - 1) }, (_, i) => /* @__PURE__ */ jsx8("box", { style: { width: inner, flexShrink: 0 }, children: /* @__PURE__ */ jsx8("text", { children: " " }) }, `pad:${i}`))
    ] }) : Array.from({ length: r }, (_, i) => {
      const index = state.start + i;
      return /* @__PURE__ */ jsx8(ScrollRow, { width: inner, gutter: gutterOn ? state.gutter(i) : null, children: index < list.length ? /* @__PURE__ */ jsx8("box", { style: { width: bodyW }, children: /* @__PURE__ */ jsx8("text", { fg: index === list.length - 1 ? "white" : "gray", children: clip(list[index], bodyW) }) }) : /* @__PURE__ */ jsx8("box", { style: { width: bodyW }, children: /* @__PURE__ */ jsx8("text", { children: " " }) }) }, `o:${i}`);
    })
  ] });
}

// src/components/UsageView.jsx
import React9 from "react";
import { TextAttributes as TextAttributes6 } from "@opentui/core";
import { Fragment as Fragment5, jsx as jsx9, jsxs as jsxs9 } from "react/jsx-runtime";
var BLOCKS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}
function until(tsSec) {
  const ms = Number(tsSec) * 1e3 - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const s = Math.round(ms / 1e3);
  const d = Math.floor(s / 86400);
  const h = Math.floor(s % 86400 / 3600);
  const m = Math.floor(s % 3600 / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
function since(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1e3));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function Bar({ w, pct, color = "green" }) {
  const width = Math.max(4, w);
  if (pct == null) {
    return /* @__PURE__ */ jsx9("text", { fg: "gray", children: "\u2591".repeat(width) });
  }
  const filled = Math.max(0, Math.min(width, Math.round(width * pct / 100)));
  return /* @__PURE__ */ jsxs9("box", { style: { width, flexDirection: "row", flexShrink: 0 }, children: [
    /* @__PURE__ */ jsx9("text", { fg: color, children: "\u2588".repeat(filled) }),
    /* @__PURE__ */ jsx9("text", { fg: "gray", children: "\u2591".repeat(width - filled) })
  ] });
}
function sparkline(series, width) {
  const byDay = /* @__PURE__ */ new Map();
  for (const row of Array.isArray(series) ? series : []) {
    if (row && row.day) byDay.set(String(row.day), Number(row.calls) || 0);
  }
  const days = [];
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 864e5);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, calls: byDay.get(key) || 0 });
  }
  const shown = days.slice(Math.max(0, days.length - Math.max(4, width)));
  const max = shown.reduce((m, d) => Math.max(m, d.calls), 0);
  const text = shown.map((d) => max === 0 ? BLOCKS[0] : BLOCKS[Math.min(BLOCKS.length - 1, Math.round(d.calls / max * (BLOCKS.length - 1)))]).join("");
  return { text, max, shown };
}
var Row2 = ({ children, w }) => /* @__PURE__ */ jsx9("box", { style: { width: w, flexShrink: 0 }, children });
function UsageView({ width = 80, height = 24, usage = null, refreshSeconds = 15, account = "" }) {
  const w = Math.max(30, Number(width) || 80);
  const inner = w - 2;
  const data = usage && usage.data ? usage.data : null;
  const err = usage && usage.error ? usage.error : "";
  const updated = usage && usage.updatedAt ? since(usage.updatedAt) : "\u2014";
  const rate = refreshSeconds > 0 ? `every ${refreshSeconds}s` : "paused";
  const line = (text, fg = "white", bold = false) => /* @__PURE__ */ jsx9(Row2, { w: inner, children: /* @__PURE__ */ jsx9("text", { fg, attributes: bold ? TextAttributes6.BOLD : 0, children: clip(text, inner) }) });
  if (!data) {
    return /* @__PURE__ */ jsxs9("box", { style: { width: w, border: true, borderStyle: "rounded", borderColor: "green", flexDirection: "column", flexShrink: 0 }, children: [
      line("\u25D4 Usage", "green", true),
      /* @__PURE__ */ jsx9(Row2, { w: inner, children: /* @__PURE__ */ jsx9("text", { children: " " }) }),
      line(err || (usage && usage.loading ? "loading usage\u2026" : "no usage data yet"), err ? "yellow" : "gray"),
      line(err ? "fix: hakster login \xB7 then r to retry \xB7 esc to go back" : "r refresh \xB7 esc back", "gray")
    ] });
  }
  const plan = String(data.plan || "free");
  const limit = Number(data.limit);
  const used = Number(data.used) || 0;
  const capped = Number.isFinite(limit) && limit > 0;
  const pct = capped ? Math.min(100, Math.round(used / limit * 100)) : null;
  const resets = data.resets || {};
  const windows = data.windows || {};
  const day = windows.day || {};
  const week = windows.week || {};
  const month = windows.month || {};
  const spark = sparkline(data.dailySeries, Math.max(10, inner - 2));
  const webLimit = Number(data.webResearchLimit);
  const webUsed = Number(data.webResearchUsed) || 0;
  const webPct = Number.isFinite(webLimit) && webLimit > 0 ? Math.min(100, Math.round(webUsed / webLimit * 100)) : null;
  const windowRows = [
    { label: "Today", w: day, until: resets.dailyAt },
    { label: "This week", w: week, until: resets.weeklyAt },
    { label: "This month", w: month, until: resets.monthlyAt }
  ];
  const biggest = Math.max(used, 1);
  return /* @__PURE__ */ jsxs9("box", { style: { width: w, border: true, borderStyle: "rounded", borderColor: "green", flexDirection: "column", flexShrink: 0 }, children: [
    line(`\u25D4 Usage \xB7 ${account || "this account"} \xB7 plan ${plan}`, "green", true),
    line(
      capped ? `Plan allowance ${fmtNum(used)} / ${fmtNum(limit)} calls \xB7 ${pct}% \xB7 resets in ${until(resets.planResetAt)}` : `Plan allowance ${fmtNum(used)} calls \xB7 no call cap on this plan${resets.planWindow ? ` \xB7 window ${resets.planWindow}` : ""}`,
      capped ? "white" : "gray"
    ),
    /* @__PURE__ */ jsx9(Row2, { w: inner, children: /* @__PURE__ */ jsx9(Bar, { w: Math.max(10, Math.min(inner, 48)), pct, color: pct != null && pct >= 90 ? "red" : pct != null && pct >= 70 ? "yellow" : "green" }) }),
    /* @__PURE__ */ jsx9(Row2, { w: inner, children: /* @__PURE__ */ jsx9("text", { children: " " }) }),
    windowRows.map(({ label, w: win, until: resetAt }) => {
      const calls = Number(win.calls) || 0;
      const share = biggest > 0 ? Math.min(100, Math.round(calls / biggest * 100)) : 0;
      const tokens = `in ${fmtNum(win.inputTokens)} \xB7 out ${fmtNum(win.outputTokens)}`;
      return /* @__PURE__ */ jsxs9("box", { style: { width: inner, flexDirection: "column", flexShrink: 0 }, children: [
        line(`${label.padEnd(10)} ${fmtNum(calls).padStart(6)} calls \xB7 ${tokens} \xB7 ${win.agentCalls || 0} agent / ${win.chatCalls || 0} chat`, "white"),
        /* @__PURE__ */ jsxs9("box", { style: { width: inner, flexDirection: "row", flexShrink: 0 }, children: [
          /* @__PURE__ */ jsx9("text", { fg: "gray", children: " ".repeat(11) }),
          /* @__PURE__ */ jsx9(Bar, { w: Math.max(8, Math.min(40, inner - 26)), pct: share, color: "cyan" }),
          /* @__PURE__ */ jsx9("text", { fg: "gray", children: ` resets in ${until(resetAt)}` })
        ] })
      ] }, label);
    }),
    /* @__PURE__ */ jsx9(Row2, { w: inner, children: /* @__PURE__ */ jsx9("text", { children: " " }) }),
    line(`14-day calls  ${spark.text}  peak ${fmtNum(spark.max)}/day`, "white"),
    line(`   ${spark.shown.length ? `${spark.shown[0].key.slice(5)} \u2192 ${spark.shown[spark.shown.length - 1].key.slice(5)}` : ""}`, "gray"),
    /* @__PURE__ */ jsx9(Row2, { w: inner, children: /* @__PURE__ */ jsx9("text", { children: " " }) }),
    line(webPct != null ? `Web research ${webUsed} / ${webLimit} \xB7 ${webPct}%` : `Web research ${data.webResearchLimit === -1 ? "unlimited on this plan" : `${webUsed} used`}`, "white"),
    line(`Tokens all time  in ${fmtNum(data.tokenUsage && data.tokenUsage.inputTokens)} \xB7 out ${fmtNum(data.tokenUsage && data.tokenUsage.outputTokens)} \xB7 tool calls ${fmtNum(data.tokenUsage && data.tokenUsage.toolCalls)} \xB7 last ${since(data.tokenUsage && data.tokenUsage.lastUsedAt)}`, "gray"),
    line(`Token balance ${fmtNum(data.tokenBalance)} \xB7 live: ${rate} \xB7 updated ${updated}`, "gray"),
    /* @__PURE__ */ jsx9(Row2, { w: inner, children: /* @__PURE__ */ jsx9("text", { children: " " }) }),
    data.ownerMeter ? /* @__PURE__ */ jsxs9(Fragment5, { children: [
      line(`Billing meter (owner view)  $${Number(data.ownerMeter.monthMeterUsd || 0).toFixed(2)} this ${data.ownerMeter.windowDays || 30}d \xB7 all-time $${Number(data.ownerMeter.meterUsd || 0).toFixed(2)}`, "green"),
      line(`   at $${Number(data.ownerMeter.rateInPerMTok || 0).toFixed(2)} in / $${Number(data.ownerMeter.rateOutPerMTok || 0).toFixed(2)} out per Mtok \xB7 ${clip(`source ${data.ownerMeter.source || "junkalot.co"}${data.ownerMeter.live ? " \xB7 live" : " \xB7 stale"}`, inner - 6)}`, "gray"),
      line(`   ${data.ownerMeter.shareOfPlanPct == null ? "no monthly plan price" : `${Number(data.ownerMeter.shareOfPlanPct).toFixed(2)}% of $${Number(data.ownerMeter.planUsdMonth || 0).toFixed(0)} plan`}${Number(data.ownerMeter.overageUsd) > 0 ? ` \xB7 over by $${Number(data.ownerMeter.overageUsd).toFixed(2)}` : ""} \xB7 meter, not an invoice`, "gray"),
      /* @__PURE__ */ jsx9(Row2, { w: inner, children: /* @__PURE__ */ jsx9("text", { children: " " }) })
    ] }) : null,
    Array.isArray(data.tokenWiring && data.tokenWiring.recent) && data.tokenWiring.recent.length ? /* @__PURE__ */ jsxs9(Fragment5, { children: [
      line("Recent calls", "green"),
      data.tokenWiring.recent.slice(0, Math.max(0, Math.min(5, height - 16))).map((r, i) => /* @__PURE__ */ jsx9(Row2, { w: inner, children: /* @__PURE__ */ jsx9("text", { fg: "gray", children: clip(`${new Date(Number(r.created_at) * 1e3).toISOString().slice(5, 16).replace("T", " ")}  ${String(r.endpoint || "").padEnd(16)} ${String(r.model || r.provider || "").slice(0, 18).padEnd(18)} in ${fmtNum(r.input_tokens)} out ${fmtNum(r.output_tokens)}`, inner) }) }, `recent:${i}`))
    ] }) : null,
    line("r refresh \xB7 ] faster \xB7 [ slower \xB7 PgUp/PgDn scroll \xB7 esc back", "gray")
  ] });
}

// src/hooks/useServerUsage.js
import { useCallback as useCallback2, useEffect as useEffect6, useRef as useRef4, useState as useState6 } from "react";
import fs3 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";
var DEFAULT_API = process.env.HAKSTER_API_URL || "http://localhost:3579";
function configuredServer() {
  if (process.env.HAKSTER_API_URL) return String(process.env.HAKSTER_API_URL).replace(/\/+$/, "");
  try {
    const cfg = JSON.parse(fs3.readFileSync(path2.join(os2.homedir(), ".hakster", "config.json"), "utf8"));
    if (cfg && typeof cfg.server === "string" && cfg.server) return cfg.server.replace(/\/+$/, "");
  } catch {
  }
  return DEFAULT_API;
}
function useServerUsage(refreshSeconds = 15, enabled = true) {
  const [state, setState] = useState6({ data: null, error: null, updatedAt: null, loading: true });
  const timerRef = useRef4(null);
  const aliveRef = useRef4(true);
  const load = useCallback2(async () => {
    const key = process.env.HAKSTER_API_KEY || "";
    const base = configuredServer();
    if (!key) {
      setState((s) => ({ ...s, loading: false, error: "not signed in \u2014 run hakster login" }));
      return;
    }
    try {
      const res = await fetch(`${base}/api/usage`, {
        headers: { "x-api-key": key },
        cache: "no-store"
      });
      const body = await res.json().catch(() => null);
      if (!aliveRef.current) return;
      if (!res.ok || !body || typeof body !== "object") {
        setState((s) => ({ ...s, loading: false, error: `usage unavailable (http ${res.status})` }));
        return;
      }
      setState({ data: body, error: null, updatedAt: Date.now(), loading: false });
    } catch (e) {
      if (!aliveRef.current) return;
      setState((s) => ({ ...s, loading: false, error: `usage unavailable (${e && e.message || "network"})` }));
    }
  }, []);
  useEffect6(() => {
    aliveRef.current = true;
    if (!enabled) return void 0;
    load();
    const every = Math.max(0, Number(refreshSeconds) || 0);
    if (timerRef.current) clearInterval(timerRef.current);
    if (every > 0) timerRef.current = setInterval(load, every * 1e3);
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [load, refreshSeconds, enabled]);
  return { ...state, refresh: load };
}

// src/App.jsx
var import_live_image2 = __toESM(require_live_image());

// src/components/MonitorFeed.jsx
import React10, { useState as useState7 } from "react";
import { useKeyboard as useKeyboard5 } from "@opentui/react";
import { Fragment as Fragment6, jsx as jsx10, jsxs as jsxs10 } from "react/jsx-runtime";
function EventLine2({ width, line }) {
  const compact = width < 30;
  return /* @__PURE__ */ jsx10("box", { style: { width, flexShrink: 0 }, children: /* @__PURE__ */ jsxs10("text", { children: [
    compact ? null : /* @__PURE__ */ jsx10("span", { fg: "gray", children: `${clock(line.ts)} ` }),
    /* @__PURE__ */ jsx10("span", { fg: EVENT_COLOR[line.kind] || "white", children: `${EVENT_GLYPH[line.kind] || "\u2022"} ` }),
    /* @__PURE__ */ jsx10("span", { fg: line.kind === "err" ? "red" : "white", children: clip(line.text, Math.max(1, width - (compact ? 2 : 8))) })
  ] }) });
}
function MonitorFeed({
  width = 60,
  height = 20,
  activity = [],
  liveTool = "",
  liveLines = [],
  busy = false
}) {
  const inner = Math.max(1, width - 4);
  const h = Math.max(0, Number(height) || 0);
  const outRows = h >= 44 ? 12 : h >= 32 ? 8 : h >= 22 ? 5 : h >= 14 ? 3 : 0;
  const feedRows = Math.max(0, h - (outRows ? outRows + 4 : 0) - 3);
  const [offset, setOffset] = useState7(null);
  const [outOffset, setOutOffset] = useState7(null);
  const feedStart = clampStart(offset, activity.length, feedRows || 1);
  const outStart = clampStart(outOffset, liveLines.length, outRows || 1);
  const feedGutter = feedRows > 0 && activity.length > feedRows;
  const outGutter = outRows > 0 && liveLines.length > outRows;
  const feedBody = Math.max(1, inner - (feedGutter ? 1 : 0));
  const outBody = Math.max(1, inner - (outGutter ? 1 : 0));
  useKeyboard5((key) => {
    if (!key || key.ctrl || key.meta || !key.shift) return;
    const name = key.name;
    const setter = feedRows ? setOffset : outRows ? setOutOffset : null;
    const total = feedRows ? activity.length : liveLines.length;
    const rows = feedRows || outRows;
    if (!setter || !rows) return;
    if (name === "home" || name === "end") {
      setter(name === "end" ? null : 0);
      return;
    }
    if (name !== "up" && name !== "down" && name !== "pageup" && name !== "pagedown") return;
    const page = name === "pageup" ? -1 : name === "pagedown" ? 1 : 0;
    const step = page ? page * Math.max(1, rows) : name === "up" ? -1 : 1;
    const max = Math.max(0, total - rows);
    setter((cur) => {
      const base = cur == null ? max : cur;
      const next = Math.max(0, Math.min(max, base + step));
      return next >= max ? null : next;
    });
  });
  const feedHint = !activity.length ? busy ? "waiting" : "0" : feedGutter ? `${feedStart + 1}-${Math.min(activity.length, feedStart + feedRows)}/${activity.length}${offset != null ? " \u21E3" : ""}` : String(activity.length);
  const outHint = outGutter ? `${outStart + 1}-${Math.min(liveLines.length, outStart + outRows)}/${liveLines.length}${outOffset != null ? " \u21E3" : ""}` : busy ? "live" : "last";
  return /* @__PURE__ */ jsxs10("box", { style: { width, flexDirection: "column", flexShrink: 0 }, children: [
    feedRows ? /* @__PURE__ */ jsx10(Panel, { width, title: "\u26A1 Live activity", hint: feedHint, children: activity.length === 0 ? /* @__PURE__ */ jsxs10(Fragment6, { children: [
      /* @__PURE__ */ jsx10("box", { style: { width: inner }, children: /* @__PURE__ */ jsx10("text", { fg: "gray", children: clip(busy ? "waiting for events\u2026" : "no events this session \u2014 run a task", inner) }) }),
      Array.from({ length: Math.max(0, feedRows - 1) }, (_, i) => /* @__PURE__ */ jsx10("box", { style: { width: inner, flexShrink: 0 }, children: /* @__PURE__ */ jsx10("text", { children: " " }) }, `pad:${i}`))
    ] }) : (
      // Exactly `feedRows` rows: the bar's track is full height from the
      // first event, and the newest line stays on the bottom row as the
      // feed streams (§ all-panels rule).
      Array.from({ length: feedRows }, (_, i) => {
        const line = activity[feedStart + i];
        return /* @__PURE__ */ jsx10(
          ScrollRow,
          {
            width: inner,
            gutter: feedGutter ? gutterChar(i, feedRows, activity.length, feedStart) : null,
            children: line ? /* @__PURE__ */ jsx10(EventLine2, { width: feedBody, line }) : /* @__PURE__ */ jsx10("box", { style: { width: feedBody }, children: /* @__PURE__ */ jsx10("text", { children: " " }) })
          },
          `e:${feedStart + i}:${i}`
        );
      })
    ) }) : null,
    outRows ? /* @__PURE__ */ jsxs10(Panel, { width, title: "\u25B6 Output", hint: outHint, children: [
      /* @__PURE__ */ jsx10("box", { style: { width: inner, flexShrink: 0 }, children: /* @__PURE__ */ jsx10("text", { fg: liveTool ? "cyan" : "gray", children: clip(liveTool || "no tool call yet", inner) }) }),
      liveLines.length === 0 ? /* @__PURE__ */ jsxs10(Fragment6, { children: [
        /* @__PURE__ */ jsx10("box", { style: { width: inner }, children: /* @__PURE__ */ jsx10("text", { fg: "gray", children: clip(busy ? "waiting for output\u2026" : "\u2014", inner) }) }),
        Array.from({ length: Math.max(0, outRows - 1) }, (_, i) => /* @__PURE__ */ jsx10("box", { style: { width: inner, flexShrink: 0 }, children: /* @__PURE__ */ jsx10("text", { children: " " }) }, `pad:${i}`))
      ] }) : Array.from({ length: outRows }, (_, i) => {
        const index = outStart + i;
        return /* @__PURE__ */ jsx10(
          ScrollRow,
          {
            width: inner,
            gutter: outGutter ? gutterChar(i, outRows, liveLines.length, outStart) : null,
            children: index < liveLines.length ? /* @__PURE__ */ jsx10("box", { style: { width: outBody }, children: /* @__PURE__ */ jsx10("text", { fg: index === liveLines.length - 1 ? "white" : "gray", children: clip(liveLines[index], outBody) }) }) : /* @__PURE__ */ jsx10("box", { style: { width: outBody }, children: /* @__PURE__ */ jsx10("text", { children: " " }) })
          },
          `o:${index}:${i}`
        );
      })
    ] }) : null
  ] });
}

// src/components/DecodeSplash.jsx
var import_kitty_graphics2 = __toESM(require_kitty_graphics());
import React11, { useEffect as useEffect7, useRef as useRef5, useState as useState8 } from "react";
import fs4 from "node:fs";
import path3 from "node:path";
import { TextAttributes as TextAttributes7 } from "@opentui/core";
import { useRenderer as useRenderer2 } from "@opentui/react";
import { Fragment as Fragment7, jsx as jsx11, jsxs as jsxs11 } from "react/jsx-runtime";
var GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
var HERO_FONT = {
  H: ["\u2588   \u2588", "\u2588   \u2588", "\u2588\u2588\u2588\u2588\u2588", "\u2588   \u2588", "\u2588   \u2588"],
  A: [" \u2588\u2588\u2588 ", "\u2588   \u2588", "\u2588\u2588\u2588\u2588\u2588", "\u2588   \u2588", "\u2588   \u2588"],
  K: ["\u2588   \u2588", "\u2588  \u2588 ", "\u2588\u2588\u2588  ", "\u2588  \u2588 ", "\u2588   \u2588"],
  S: [" \u2588\u2588\u2588\u2588", "\u2588    ", " \u2588\u2588\u2588 ", "    \u2588", "\u2588\u2588\u2588\u2588 "],
  T: ["\u2588\u2588\u2588\u2588\u2588", "  \u2588  ", "  \u2588  ", "  \u2588  ", "  \u2588  "],
  E: ["\u2588\u2588\u2588\u2588\u2588", "\u2588    ", "\u2588\u2588\u2588\u2588 ", "\u2588    ", "\u2588\u2588\u2588\u2588\u2588"],
  R: ["\u2588\u2588\u2588\u2588 ", "\u2588   \u2588", "\u2588\u2588\u2588\u2588 ", "\u2588  \u2588 ", "\u2588   \u2588"]
};
var HERO_WORD = "HAKSTER";
var HERO_WORDMARK = [0, 1, 2, 3, 4].map((row) => HERO_WORD.split("").map((ch) => HERO_FONT[ch][row]).join(" "));
var HERO_W = Math.max(...HERO_WORDMARK.map((l) => l.length));
var HERO_GREEN = "#00ff41";
var RAIN_GLYPHS = "\uFF71\uFF72\uFF73\uFF74\uFF75\uFF76\uFF77\uFF78\uFF79\uFF7A\uFF7B\uFF7C\uFF7D\uFF7E\uFF7F\uFF80\uFF81\uFF82\uFF83\uFF84\uFF85\uFF86\uFF87\uFF88\uFF89\uFF8A\uFF8B\uFF8C\uFF8D\uFF8E\uFF8F\uFF90\uFF91\uFF92\uFF93\uFF94\uFF95\uFF96\uFF97\uFF98\uFF99\uFF9A\uFF9B\uFF9C\uFF9D0123456789";
var RAIN_COLORS = { head: "#d8ffe6", near: "#00ff41", tail: "#0a5c22" };
function rainHash(a, b, c) {
  let h = Math.imul(a + 1, 374761393) + Math.imul(b + 1, 668265263) + Math.imul(c + 1, 1440662683);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return (h ^ h >>> 16) >>> 0;
}
function rainColumns(width, height, frame) {
  const cols = Math.max(1, Math.floor(width / 2));
  const period = height + 12;
  const streams = [];
  for (let c = 0; c < cols; c += 1) {
    const speed = 0.45 + rainHash(c, 7, 1) % 100 / 90;
    const phase = rainHash(c, 11, 2) % period;
    const trail = 3 + rainHash(c, 13, 3) % 7;
    const head = Math.floor((frame * speed + phase) % period) - 8;
    streams.push({ c, head, trail });
  }
  return { streams, cols };
}
function MatrixRain({ width, height, frame }) {
  const w = Math.max(2, Number(width) || 80);
  const h = Math.max(1, Number(height) || 20);
  const { streams } = rainColumns(w, h, frame);
  const rows = [];
  for (let r = 0; r < h; r += 1) {
    const parts = [];
    let pending = 0;
    for (const s of streams) {
      const dist = s.head - r;
      const lit = dist >= 0 && dist < s.trail;
      if (!lit) {
        pending += 2;
        continue;
      }
      if (pending) {
        parts.push(/* @__PURE__ */ jsx11("span", { children: " ".repeat(pending) }, `p${parts.length}`));
        pending = 0;
      }
      const glyph = RAIN_GLYPHS[rainHash(s.c, r, Math.floor(frame / 2)) % RAIN_GLYPHS.length];
      const color = dist === 0 ? RAIN_COLORS.head : dist <= 2 ? RAIN_COLORS.near : RAIN_COLORS.tail;
      parts.push(/* @__PURE__ */ jsx11("span", { fg: color, children: glyph }, `g${parts.length}`));
      pending = 1;
    }
    if (pending) parts.push(/* @__PURE__ */ jsx11("span", { children: " ".repeat(pending) }, `t${parts.length}`));
    rows.push(
      /* @__PURE__ */ jsx11("box", { style: { width: w, flexDirection: "row", flexShrink: 0, height: 1 }, children: /* @__PURE__ */ jsx11("text", { children: parts }) }, `rain:${r}`)
    );
  }
  return /* @__PURE__ */ jsx11("box", { style: { position: "absolute", left: 0, top: 0, width: w, height: h, flexDirection: "column", overflow: "hidden" }, children: rows });
}
var ART_FILE = "haksterai-hero.art.json";
var _heroArt;
function loadHeroArt() {
  if (_heroArt !== void 0) return _heroArt;
  try {
    const file = path3.join(path3.dirname((0, import_kitty_graphics2.heroPath)()), ART_FILE);
    const json = JSON.parse(fs4.readFileSync(file, "utf8"));
    const px = Buffer.from(String(json.rgbBase64 || ""), "base64");
    _heroArt = px.length === json.width * json.height * 3 ? { width: json.width, height: json.height, px } : null;
  } catch {
    _heroArt = null;
  }
  return _heroArt;
}
var hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
var rgbHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
function HeroBackdrop({ cols, rows, frame, left = 0, top = 0 }) {
  const art = loadHeroArt();
  if (!art || cols < 8 || rows < 4) return null;
  const stepX = art.width / cols;
  const stepY = art.height / (rows * 2);
  const pixel = (c, py) => {
    const x = Math.min(art.width - 1, Math.floor(c * stepX + stepX / 2));
    const y = Math.min(art.height - 1, Math.floor(py * stepY + stepY / 2));
    const o = (y * art.width + x) * 3;
    return rgbHex(art.px[o], art.px[o + 1], art.px[o + 2]);
  };
  const { streams } = rainColumns(cols * 2, rows, frame);
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    const parts = [];
    let run = null;
    let runN = 0;
    const flush = () => {
      if (run && runN) parts.push(/* @__PURE__ */ jsx11("span", { fg: run.fg, bg: run.bg, children: "\u2580".repeat(runN) }, `a${parts.length}`));
      run = null;
      runN = 0;
    };
    for (let c = 0; c < cols; c += 1) {
      const s = streams[c];
      const dist = s ? s.head - r : 99;
      if (s && dist >= 0 && dist < s.trail) {
        flush();
        const glyph = RAIN_GLYPHS[rainHash(c, r, Math.floor(frame / 2)) % RAIN_GLYPHS.length];
        const color = dist === 0 ? RAIN_COLORS.head : dist <= 2 ? RAIN_COLORS.near : RAIN_COLORS.tail;
        parts.push(/* @__PURE__ */ jsx11("span", { fg: color, bg: pixel(c, r * 2 + 1), children: glyph }, `r${parts.length}`));
      } else {
        const fg = pixel(c, r * 2);
        const bg = pixel(c, r * 2 + 1);
        if (run && run.fg === fg && run.bg === bg) runN += 1;
        else {
          flush();
          run = { fg, bg };
          runN = 1;
        }
      }
    }
    flush();
    out.push(
      /* @__PURE__ */ jsx11("box", { style: { width: cols, height: 1, flexShrink: 0 }, children: /* @__PURE__ */ jsx11("text", { children: parts }) }, `hb:${r}`)
    );
  }
  return /* @__PURE__ */ jsx11("box", { style: { position: "absolute", left, top, width: cols, height: rows, flexDirection: "column", overflow: "hidden" }, children: out });
}
function artSize(width, height, reservedRows) {
  const art = loadHeroArt();
  if (!art) return { cols: 0, rows: 0 };
  const maxRows = Math.min(art.height / 2, height - reservedRows);
  const maxCols = Math.min(art.width, width - 2);
  if (maxRows < 8 || maxCols < 24) return { cols: 0, rows: 0 };
  let rows = maxRows;
  let cols = Math.round(rows * 2 * (art.width / art.height));
  if (cols > maxCols) {
    cols = maxCols;
    rows = Math.max(4, Math.round(cols * art.height / art.width / 2));
  }
  return { cols, rows };
}
function scrambleLine(text, reveal, frame) {
  const t = String(text == null ? "" : text);
  let out = "";
  let index = 0;
  for (const ch of t) {
    if (index < reveal || !/[A-Za-z0-9]/.test(ch)) {
      out += ch;
    } else {
      const seed = Math.imul(index + frame + 1, 2654435761) + ch.charCodeAt(0) * 101 >>> 0;
      out += GLYPHS[seed % GLYPHS.length];
    }
    index += 1;
  }
  return out;
}
function DecodeSplash({ width = 80, height = 24, lines = [], onDone, stepMs = 55, graphics = true }) {
  const [frame, setFrame] = useState8(0);
  const renderer2 = useRenderer2();
  const doneRef = useRef5(onDone);
  doneRef.current = onDone;
  const longest = lines.reduce((n, l) => Math.max(n, String(l.text || "").length), 1);
  const revealStep = 2.4;
  const settleAt = Math.ceil(longest / revealStep) + 1;
  const reveal = Math.min(longest, Math.floor(frame * revealStep));
  const done = frame >= settleAt;
  const imageAllowed = Boolean(graphics) && (0, import_kitty_graphics2.isSupported)(process.env, process.stdout);
  let heroAsset = false;
  try {
    heroAsset = imageAllowed && fs4.existsSync((0, import_kitty_graphics2.heroPath)());
  } catch {
    heroAsset = false;
  }
  const [heroFailed, setHeroFailed] = useState8(false);
  const artFit = !imageAllowed || heroFailed ? artSize(width, height, lines.length + 3) : { cols: 0, rows: 0 };
  const showArt = artFit.cols >= 24 && artFit.rows >= 8;
  const showWordmark = !showArt && (!heroAsset || heroFailed);
  useEffect7(() => {
    if (done) return void 0;
    const id = setInterval(() => {
      setFrame((f) => f + 1 >= settleAt ? settleAt : f + 1);
    }, stepMs);
    return () => clearInterval(id);
  }, [done, settleAt, stepMs]);
  useEffect7(() => {
    if (!done) return void 0;
    const id = setTimeout(() => {
      if (typeof doneRef.current === "function") doneRef.current();
    }, 260);
    return () => clearTimeout(id);
  }, [done]);
  useEffect7(() => {
    if (!graphics || !(0, import_kitty_graphics2.isSupported)(process.env, process.stdout)) return void 0;
    let placed = null;
    let row = 1;
    let col = 1;
    let onFrame = null;
    const withPausedRenderer = (fn) => {
      try {
        if (renderer2 && typeof renderer2.pause === "function") renderer2.pause();
        return fn();
      } finally {
        try {
          if (renderer2 && typeof renderer2.resume === "function") renderer2.resume();
        } catch {
        }
      }
    };
    const placeAgain = () => {
      if (!placed) return;
      const write = (s) => process.stdout.write(s);
      (0, import_kitty_graphics2.moveCursor)(row, col, write);
      (0, import_kitty_graphics2.deletePlacement)({ placementId: 1, write });
      (0, import_kitty_graphics2.placeById)({ id: placed.id, placementId: 1, write });
    };
    const timer = setTimeout(() => {
      withPausedRenderer(() => {
        let heroRows = Math.max(6, Math.floor(height * 0.94));
        let heroCols = Math.round(heroRows * 8 / 3);
        if (heroCols > width - 2) {
          heroCols = Math.max(8, width - 2);
          heroRows = Math.max(6, Math.round(heroCols * 3 / 8));
        }
        row = Math.max(1, Math.floor((height - heroRows) / 2) + 1);
        col = Math.max(1, Math.floor((width - heroCols) / 2) + 1);
        (0, import_kitty_graphics2.moveCursor)(row, col);
        placed = (0, import_kitty_graphics2.placeImage)({ file: (0, import_kitty_graphics2.heroPath)(), cols: heroCols, rows: heroRows });
        if (!placed) setHeroFailed(true);
      });
      if (placed && renderer2 && typeof renderer2.on === "function") {
        onFrame = () => placeAgain();
        try {
          renderer2.on("frame", onFrame);
        } catch {
          onFrame = null;
        }
      }
    }, 60);
    return () => {
      clearTimeout(timer);
      if (onFrame) {
        try {
          renderer2.off("frame", onFrame);
        } catch {
        }
      }
      if (placed) withPausedRenderer(() => (0, import_kitty_graphics2.deleteImage)(placed.id));
    };
  }, [graphics, renderer2, width, height, lines.length]);
  return /* @__PURE__ */ jsxs11(
    "box",
    {
      style: {
        width,
        height,
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        overflow: "hidden"
      },
      children: [
        /* @__PURE__ */ jsx11(MatrixRain, { width, height, frame }),
        showArt ? /* @__PURE__ */ jsx11(
          HeroBackdrop,
          {
            cols: artFit.cols,
            rows: artFit.rows,
            frame,
            left: Math.max(0, Math.floor((width - artFit.cols) / 2)),
            top: Math.max(0, Math.floor((height - artFit.rows) / 2))
          }
        ) : null,
        /* @__PURE__ */ jsxs11(
          "box",
          {
            style: {
              position: "absolute",
              left: 0,
              top: 0,
              width,
              height,
              flexDirection: "column",
              justifyContent: "center",
              alignItems: "center"
            },
            children: [
              showWordmark && width >= HERO_W && height >= 14 ? /* @__PURE__ */ jsxs11(Fragment7, { children: [
                HERO_WORDMARK.map((row, i) => /* @__PURE__ */ jsx11("box", { style: { flexDirection: "row", flexShrink: 0 }, children: /* @__PURE__ */ jsx11("text", { fg: HERO_GREEN, attributes: TextAttributes7.BOLD, children: row }) }, `hero:${i}`)),
                /* @__PURE__ */ jsx11("box", { style: { height: 1, flexShrink: 0 } })
              ] }) : null,
              lines.map((line, i) => /* @__PURE__ */ jsx11("box", { style: { flexDirection: "row", flexShrink: 0 }, children: /* @__PURE__ */ jsx11("text", { fg: line.color || "gray", attributes: line.bold ? TextAttributes7.BOLD : 0, children: scrambleLine(line.text, reveal, frame + i) }) }, `d:${i}`)),
              /* @__PURE__ */ jsx11("box", { style: { flexDirection: "row", flexShrink: 0 }, children: /* @__PURE__ */ jsx11("text", { fg: "gray", children: done ? " " : scrambleLine("\u259A\u259A\u259A\u259A\u259A\u259A\u259A\u259A", frame, frame) }) })
            ]
          }
        )
      ]
    }
  );
}

// src/components/MenuPalette.jsx
import React12 from "react";
import { TextAttributes as TextAttributes8 } from "@opentui/core";
import { jsx as jsx12, jsxs as jsxs12 } from "react/jsx-runtime";
var MENU_ITEMS = [
  { cmd: "/model", label: "Models", detail: "switch the model for this session" },
  { cmd: "/auto", label: "Autonomy", detail: "ask \xB7 edit \xB7 full \u2014 how far it runs alone" },
  { cmd: "/mcp", label: "MCP servers", detail: "server manager \xB7 status, tools, pids" },
  { cmd: "/handoff", label: "Auto handoff", detail: "on/off \xB7 DeepSeek \u2192 Codex \u2192 others" },
  { cmd: "/ports", label: "Ports", detail: "services and every listening port" },
  { cmd: "/attach", label: "Attach image", detail: "/attach <path> \xB7 sends with your message" },
  { cmd: "/dashboard", label: "Dashboard", detail: "system / session / agent panels" },
  { cmd: "/monitor", label: "Live monitor", detail: "full-screen feed + output \xB7 shift+\u2191/\u2193 scroll" },
  { cmd: "/scripts", label: "Live scripts", detail: "run ours live \xB7 OMP snapshot compares the source" },
  { cmd: "/squad", label: "Sub-agents", detail: "the peer agents the server reports \xB7 enter delegates" },
  { cmd: "/status", label: "Status", detail: "server, phase, tokens" },
  { cmd: "/usage", label: "Usage", detail: "per-user \xB7 daily & weekly graphs \xB7 r refresh \xB7 [ ] rate" },
  { cmd: "/update", label: "Update", detail: "check \xB7 downloads in-session \xB7 applies on restart" },
  { cmd: "/settings", label: "Settings", detail: "every CLI setting \xB7 change it in place" },
  { cmd: "/graphics", label: "Kitty graphics", detail: "real logo image in kitty/Ghostty/WezTerm \xB7 report or on/off" },
  { cmd: "/clear", label: "Clear transcript", detail: "start the conversation over" },
  { cmd: "/help", label: "Help", detail: "keys and commands" },
  { cmd: "/quit", label: "Quit", detail: "leave the dashboard" }
];

// src/components/CatalogPopout.jsx
import React13 from "react";
import { TextAttributes as TextAttributes9 } from "@opentui/core";
import { jsx as jsx13, jsxs as jsxs13 } from "react/jsx-runtime";
var clip2 = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}\u2026`;
};
var KIND_COLOR = {
  agent: "magenta",
  model: "cyan",
  mcp: "blue",
  cmd: "green"
};
function CatalogPopout({
  width = 72,
  height = 20,
  rows = [],
  selectable = [],
  selected = 0,
  query = "",
  filter = ""
}) {
  const w = Math.max(24, Number(width) || 72);
  const inner = Math.max(1, w - 4);
  const h = Math.max(6, Number(height) || 20);
  const bodyRows = Math.max(3, h - 5);
  const selRow = selectable[Math.min(selected, selectable.length - 1)] ?? 0;
  const start2 = Math.max(0, Math.min(selRow - Math.floor(bodyRows / 2), Math.max(0, rows.length - bodyRows)));
  const shown = rows.slice(start2, start2 + bodyRows);
  const hiddenAbove = start2;
  const hiddenBelow = Math.max(0, rows.length - start2 - shown.length);
  const gutterOn = overflows(rows.length, bodyRows);
  const bodyW = Math.max(8, inner - (gutterOn ? 1 : 0));
  const compact = bodyW < 40;
  return /* @__PURE__ */ jsxs13("box", { style: { width: w, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: "cyan", paddingLeft: 1, paddingRight: 1, flexShrink: 0 }, children: [
    /* @__PURE__ */ jsxs13("box", { style: { width: inner, flexDirection: "row", justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsx13("text", { fg: "cyan", attributes: TextAttributes9.BOLD, children: "\u25C7 Catalog" }),
      /* @__PURE__ */ jsx13("text", { fg: "gray", children: clip2(hiddenAbove || hiddenBelow ? `${hiddenAbove}\u2191 ${hiddenBelow}\u2193 \xB7 \u2191\u2193 \xB7 enter \xB7 esc` : "\u2191\u2193 select \xB7 enter apply \xB7 esc close", inner - 10) })
    ] }),
    /* @__PURE__ */ jsxs13("box", { style: { width: inner, flexDirection: "row" }, children: [
      /* @__PURE__ */ jsx13("text", { fg: "yellow", children: "\u2315 " }),
      /* @__PURE__ */ jsx13("text", { fg: "white", children: clip2(query, inner - 2) })
    ] }),
    /* @__PURE__ */ jsxs13("box", { style: { width: inner, flexDirection: "column" }, children: [
      shown.length === 0 ? /* @__PURE__ */ jsx13("text", { fg: "gray", children: clip2("no match \u2014 backspace to widen, esc to close", inner) }) : shown.map((row, i) => {
        const abs = start2 + i;
        const gutter = gutterOn ? gutterChar(i, bodyRows, rows.length, start2) : null;
        if (row.kind === "header") {
          return /* @__PURE__ */ jsxs13("box", { style: { width: inner, flexDirection: "row", flexShrink: 0 }, children: [
            /* @__PURE__ */ jsx13("text", { fg: "gray", attributes: TextAttributes9.BOLD, children: clip2(`\u2014 ${row.label} \u2014`, bodyW) }),
            gutter ? /* @__PURE__ */ jsx13("text", { fg: "gray", children: gutter }) : null
          ] }, `h:${row.label}`);
        }
        const isSel = abs === selRow;
        const color = KIND_COLOR[row.kind] || "white";
        const detail = compact ? "" : String(row.detail || "");
        const valueW = detail ? Math.min(detail.length, Math.max(0, Math.floor(bodyW / 2))) : 0;
        const labelW = Math.max(8, bodyW - (valueW ? valueW + 1 : 0));
        return /* @__PURE__ */ jsxs13("box", { style: { width: inner, flexDirection: "row", flexShrink: 0 }, children: [
          /* @__PURE__ */ jsx13("text", { fg: isSel ? "yellow" : color, attributes: isSel ? TextAttributes9.BOLD : 0, children: clip2(`${isSel ? "\u25B8 " : "  "}${row.label}`, labelW) }),
          valueW ? /* @__PURE__ */ jsx13("text", { fg: isSel ? "white" : "gray", children: ` ${clip2(detail, valueW)}` }) : null,
          gutter ? /* @__PURE__ */ jsx13("text", { fg: "gray", children: gutter }) : null
        ] }, `${row.kind}:${row.label}`);
      }),
      Array.from({ length: Math.max(0, bodyRows - Math.max(1, shown.length)) }, (_, i) => /* @__PURE__ */ jsx13("box", { style: { width: inner, flexShrink: 0 }, children: /* @__PURE__ */ jsx13("text", { children: " " }) }, `pad:${i}`))
    ] }),
    /* @__PURE__ */ jsx13("box", { style: { width: inner, flexDirection: "row" }, children: /* @__PURE__ */ jsx13("text", { fg: "gray", children: clip2(filter || "type to filter \xB7 a model row switches this session \xB7 esc closes", inner) }) })
  ] });
}

// src/components/SettingsView.jsx
import React15 from "react";
import { TextAttributes as TextAttributes10 } from "@opentui/core";

// src/components/ScrollPanel.jsx
import React14 from "react";
import { jsx as jsx14 } from "react/jsx-runtime";
function ScrollPanel({
  width = 40,
  title = "",
  hint = "",
  total = 0,
  rows = 0,
  bindings = null,
  initial = "follow",
  selected = null,
  empty = "\u2014",
  busy = false,
  compactWhen = null,
  borderColor = "gray",
  children
}) {
  const w = Math.max(12, Number(width) || 40);
  const r = Math.max(0, Math.trunc(Number(rows) || 0));
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  const inner = Math.max(1, w - 4);
  const state = usePanelScroll({
    total: n,
    rows: r,
    bindings,
    enabled: r > 0,
    initial,
    selected,
    // A panel fed by a running agent returns to the tail on its own; a static
    // list (scripts, squad) keeps wherever the operator put it.
    autoResume: busy && initial === "follow"
  });
  const gutterOn = selected == null && r > 0 && overflows(n, r);
  const bodyW = Math.max(1, inner - (gutterOn ? 1 : 0));
  const compact = compactWhen == null ? bodyW < 24 || r < 5 : !!compactWhen;
  const titleHint = n === 0 ? busy ? "waiting" : hint : overflows(n, r) ? state.hint(hint) : hint || String(n);
  return /* @__PURE__ */ jsx14(Panel, { width: w, title, hint: titleHint, borderColor, children: n === 0 || r === 0 ? /* @__PURE__ */ jsx14("box", { style: { width: inner }, children: /* @__PURE__ */ jsx14("text", { fg: "gray", children: clip(busy ? "waiting\u2026" : empty, inner) }) }) : Array.from({ length: r }, (_, i) => {
    const index = state.start + i;
    const row = index < n ? children(index, { width: bodyW, compact, selected: index === selected }) : null;
    return /* @__PURE__ */ jsx14(ScrollRow, { width: inner, gutter: gutterOn ? state.gutter(i) : null, children: row == null ? /* @__PURE__ */ jsx14("box", { style: { width: bodyW }, children: /* @__PURE__ */ jsx14("text", { children: " " }) }) : row }, `row-${i}`);
  }) });
}
var ScrollPanel_default = ScrollPanel;

// src/components/SettingsView.jsx
var import_prefs = __toESM(require_prefs());
import { jsx as jsx15, jsxs as jsxs14 } from "react/jsx-runtime";
var clip3 = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}\u2026`;
};
var showValue = (v) => {
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") return String(v);
  return v === "" ? "(default)" : String(v);
};
var valueColor = (v) => typeof v === "boolean" ? v ? "green" : "gray" : typeof v === "number" ? "yellow" : "cyan";
function SettingsView({
  width = 72,
  rows = 16,
  list = [],
  selected = 0
}) {
  const w = Math.max(24, Number(width) || 72);
  const contentRows = Math.max(3, Number(rows) || 16);
  const keyW = Math.min(14, Math.max(8, ...list.map((r) => String(r.key).length)));
  const changed = list.filter((r) => String(r.value) !== String(r.default)).length;
  return /* @__PURE__ */ jsx15(
    ScrollPanel_default,
    {
      width: w,
      title: `\u2699 Settings${changed ? ` \xB7 ${changed} changed` : ""}`,
      hint: "\u2191\u2193 select \xB7 enter change \xB7 r reset \xB7 esc back",
      total: list.length,
      rows: contentRows,
      selected: Math.min(selected, Math.max(0, list.length - 1)),
      initial: "top",
      empty: "no settings \u2014 prefs.js lists none",
      compactWhen: w < 70,
      children: (index, { width: rowW, compact }) => {
        const row = list[index];
        if (!row) return null;
        const active = index === selected;
        const meta = import_prefs.META[row.key] || {};
        const isChanged = String(row.value) !== String(row.default);
        const value = showValue(row.value);
        const valueW = Math.min(12, Math.max(3, value.length));
        const detailW = Math.max(0, rowW - keyW - valueW - 6);
        return /* @__PURE__ */ jsxs14("box", { style: { width: rowW, flexDirection: "row", flexShrink: 0 }, children: [
          /* @__PURE__ */ jsx15("text", { fg: active ? "yellow" : "gray", attributes: active ? TextAttributes10.BOLD : 0, children: `${active ? "\u25B8 " : "  "}${clip3(String(row.key).padEnd(keyW), keyW)}` }),
          /* @__PURE__ */ jsx15("text", { fg: active ? "yellow" : valueColor(row.value), attributes: isChanged ? TextAttributes10.BOLD : 0, children: ` ${clip3(value, valueW).padEnd(valueW)}` }),
          /* @__PURE__ */ jsx15("text", { fg: isChanged ? "yellow" : "gray", children: isChanged ? "*" : " " }),
          !compact && detailW > 3 ? /* @__PURE__ */ jsx15("text", { fg: "gray", children: ` ${clip3(meta.detail || meta.label || "", detailW - 1)}` }) : null
        ] });
      }
    }
  );
}

// src/components/McpView.jsx
import React16 from "react";
import { TextAttributes as TextAttributes11 } from "@opentui/core";
import { Fragment as Fragment8, jsx as jsx16, jsxs as jsxs15 } from "react/jsx-runtime";
var clip4 = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}\u2026`;
};
var wrap = (words, width) => {
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} \xB7 ${word}` : word;
    if (next.length > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
};
function McpView({
  width = 72,
  height = 20,
  servers = [],
  selected = 0
}) {
  const w = Math.max(24, Number(width) || 72);
  const h = Math.max(7, Number(height) || 20);
  const inner = Math.max(1, w - 4);
  const live = servers.filter((s) => s.initialized || (Number(s.toolCount) || 0) > 0).length;
  const tools = servers.reduce((n, s) => n + (Number(s.toolCount) || 0), 0);
  const body = Math.max(3, h - 4);
  const listRows = Math.max(1, Math.min(servers.length, Math.ceil(body / 2)));
  const sel = Math.max(0, Math.min(selected, Math.max(0, servers.length - 1)));
  const start2 = Math.max(0, Math.min(sel - Math.floor(listRows / 2), Math.max(0, servers.length - listRows)));
  const shown = servers.slice(start2, start2 + listRows);
  const active = servers[sel];
  const toolRows = Math.max(0, body - listRows - 1);
  const toolLines = active ? wrap(Array.isArray(active.tools) && active.tools.length ? active.tools : ["(no tools listed)"], inner - 2) : [];
  return /* @__PURE__ */ jsxs15("box", { style: { width: w, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: "blue", paddingLeft: 1, paddingRight: 1, flexShrink: 0 }, children: [
    /* @__PURE__ */ jsxs15("box", { style: { width: inner, flexDirection: "row", justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsx16("text", { fg: "blue", attributes: TextAttributes11.BOLD, children: "\u2B21 MCP servers" }),
      /* @__PURE__ */ jsx16("text", { fg: "gray", children: clip4(`${live}/${servers.length} live \xB7 ${tools} tools${servers.length > listRows ? ` \xB7 ${start2}\u2191 ${Math.max(0, servers.length - start2 - shown.length)}\u2193` : ""}`, inner - 14) })
    ] }),
    /* @__PURE__ */ jsx16("box", { style: { width: inner, flexDirection: "column" }, children: shown.length === 0 ? /* @__PURE__ */ jsx16("text", { fg: "gray", children: clip4("no servers reported \u2014 is the server reachable?", inner) }) : shown.map((s, i) => {
      const abs = start2 + i;
      const isSel = abs === sel;
      const up = s.initialized || (Number(s.toolCount) || 0) > 0;
      const count = s.toolCount == null ? "?" : String(s.toolCount);
      const notes = [
        `${count} tools`,
        s.lazy ? "lazy" : "",
        s.initialized === false ? "down" : "",
        s.pid ? `pid ${s.pid}` : ""
      ].filter(Boolean).join(" \xB7 ");
      return /* @__PURE__ */ jsxs15("box", { style: { width: inner, flexDirection: "row", flexShrink: 0 }, children: [
        /* @__PURE__ */ jsx16("text", { fg: isSel ? "yellow" : up ? "green" : "red", attributes: isSel ? TextAttributes11.BOLD : 0, children: `${isSel ? "\u25B8 " : "  "}${up ? "\u25CF" : "\u25CB"} ${clip4(s.name, Math.max(8, Math.floor(inner / 2)))}` }),
        /* @__PURE__ */ jsx16("text", { fg: isSel ? "white" : "gray", children: ` ${clip4(notes, Math.max(4, inner - Math.floor(inner / 2) - 5))}` })
      ] }, `s:${s.name}`);
    }) }),
    toolRows > 0 ? /* @__PURE__ */ jsxs15(Fragment8, { children: [
      /* @__PURE__ */ jsx16("box", { style: { width: inner, flexShrink: 0 }, children: /* @__PURE__ */ jsx16("text", { fg: "gray", attributes: TextAttributes11.BOLD, children: clip4(`\u2014 tools \xB7 ${active ? active.name : "\u2014"} \u2014`, inner) }) }),
      /* @__PURE__ */ jsx16("box", { style: { width: inner, flexDirection: "column" }, children: (() => {
        const overflow = toolLines.length > toolRows;
        const visible = overflow ? toolLines.slice(0, Math.max(0, toolRows - 1)) : toolLines.slice(0, toolRows);
        const pad = Math.max(0, toolRows - visible.length - (overflow ? 1 : 0));
        return /* @__PURE__ */ jsxs15(Fragment8, { children: [
          visible.map((line, i) => /* @__PURE__ */ jsx16("box", { style: { width: inner, flexShrink: 0 }, children: /* @__PURE__ */ jsx16("text", { fg: "white", children: clip4(`  ${line}`, inner) }) }, `t:${i}`)),
          overflow ? /* @__PURE__ */ jsx16("box", { style: { width: inner, flexShrink: 0 }, children: /* @__PURE__ */ jsx16("text", { fg: "gray", children: clip4(`  \u2026 ${toolLines.length - visible.length} more tool rows`, inner) }) }) : null,
          Array.from({ length: pad }, (_, i) => /* @__PURE__ */ jsx16("box", { style: { width: inner, flexShrink: 0 }, children: /* @__PURE__ */ jsx16("text", { children: " " }) }, `tp:${i}`))
        ] });
      })() })
    ] }) : null,
    /* @__PURE__ */ jsx16("box", { style: { width: inner }, children: /* @__PURE__ */ jsx16("text", { fg: "gray", children: clip4("\u2191\u2193 select \xB7 r re-read \xB7 esc back \xB7 servers come from .hakster/mcp.json", inner) }) })
  ] });
}

// src/components/ScriptsView.jsx
import React17, { useMemo as useMemo2 } from "react";
import { TextAttributes as TextAttributes12 } from "@opentui/core";

// src/utils/scripts.js
import fs5 from "node:fs";
import path4 from "node:path";
import { fileURLToPath } from "node:url";
var SCRIPT_EXT = /* @__PURE__ */ new Set([".sh", ".bash", ".cjs", ".mjs", ".js", ".py"]);
function projectRoots() {
  let cliDir;
  try {
    cliDir = path4.dirname(fileURLToPath(import.meta.url));
  } catch {
    cliDir = process.cwd();
  }
  const candidates = [];
  let dir = cliDir;
  for (let i = 0; i < 5; i += 1) {
    candidates.push(dir);
    dir = path4.dirname(dir);
  }
  const repo = candidates.find((d) => fs5.existsSync(path4.join(d, "package.json")) && fs5.existsSync(path4.join(d, "cli"))) || candidates.find((d) => fs5.existsSync(path4.join(d, "package.json"))) || process.cwd();
  return { repo, cli: path4.join(repo, "cli") };
}
var interpreterFor = (file) => {
  const ext = path4.extname(file).toLowerCase();
  if (ext === ".sh" || ext === ".bash") return "bash";
  if (ext === ".py") return "python3";
  return "node";
};
function discoverScripts() {
  const { repo, cli } = projectRoots();
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (entry) => {
    if (!entry || seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };
  for (const [dir, tag] of [[path4.join(repo, "scripts"), "repo"], [path4.join(cli, "scripts"), "cli"]]) {
    let names = [];
    try {
      names = fs5.readdirSync(dir).filter((n) => SCRIPT_EXT.has(path4.extname(n).toLowerCase())).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = path4.join(dir, name);
      try {
        if (!fs5.statSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      add({
        id: `${tag}/${name}`,
        label: name,
        tag,
        path: abs,
        run: [interpreterFor(abs), abs],
        cwd: repo
      });
    }
  }
  try {
    const pkg = JSON.parse(fs5.readFileSync(path4.join(repo, "package.json"), "utf8"));
    for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
      if (name === "postinstall" || name === "astro") continue;
      add({
        id: `npm/${name}`,
        label: `npm run ${name}`,
        tag: "npm",
        path: path4.join(repo, "package.json"),
        run: ["npm", "run", name],
        cwd: repo
      });
    }
  } catch {
  }
  return out;
}
var LAST_RUN = /* @__PURE__ */ new Map();
function sourceOf(entry) {
  try {
    return fs5.readFileSync(entry.path, "utf8").replace(/\r\n/g, "\n").split("\n");
  } catch {
    return [];
  }
}
function snapshotBeforeRun(entry) {
  const prev = LAST_RUN.get(entry.id) || null;
  LAST_RUN.set(entry.id, sourceOf(entry));
  return prev;
}
var lastSnapshot = (entry) => LAST_RUN.get(entry?.id) || null;
function diffLines(prev, next) {
  const before = Array.isArray(prev) ? prev : [];
  const after = Array.isArray(next) ? next : [];
  if (!before.length) return after.map((text) => ({ text, mark: "" }));
  const pool = /* @__PURE__ */ new Map();
  for (const line of before) pool.set(line, (pool.get(line) || 0) + 1);
  const marked = after.map((text) => {
    const n = pool.get(text) || 0;
    if (n > 0) {
      pool.set(text, n - 1);
      return { text, mark: "" };
    }
    return { text, mark: "+" };
  });
  const gone = [];
  for (const [line, n] of pool) {
    for (let i = 0; i < n; i += 1) gone.push({ text: line, mark: "-" });
  }
  return [...gone, ...marked];
}
var linesOf = (entry) => sourceOf(entry);

// src/components/ScriptsView.jsx
import { jsx as jsx17, jsxs as jsxs16 } from "react/jsx-runtime";
var STATUS_COLOR = {
  idle: "gray",
  running: "yellow",
  done: "green",
  failed: "red",
  stopped: "yellow"
};
var clipLine = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}\u2026`;
};
var statusText = (run) => {
  switch (run.status) {
    case "running":
      return `running${run.script ? ` \xB7 ${Math.max(0, Math.round((Date.now() - run.startedAt) / 1e3))}s` : ""}`;
    case "done":
      return `done \xB7 exit ${run.exit ?? 0}`;
    case "failed":
      return `failed \xB7 exit ${run.exit == null ? "?" : run.exit}`;
    case "stopped":
      return "stopped";
    default:
      return "not run yet";
  }
};
function ScriptsView({
  width = 80,
  height = 20,
  scripts = [],
  selected = 0,
  run = { status: "idle", lines: [], script: null },
  onSelect,
  onRun
}) {
  const w = Math.max(24, Number(width) || 80);
  const h = Math.max(8, Number(height) || 20);
  const chosen = scripts[Math.min(selected, Math.max(0, scripts.length - 1))] || null;
  const listRows = Math.min(6, Math.max(1, scripts.length || 1));
  const listPanelRows = listRows + 3;
  const snapshotRows = Math.max(5, h - listPanelRows - 1);
  const paneRows = Math.max(2, snapshotRows - 3);
  const src = useMemo2(() => chosen ? linesOf(chosen) : [], [chosen]);
  const prev = chosen ? lastSnapshot(chosen) : null;
  const diff = useMemo2(() => diffLines(prev, src), [prev, src]);
  const changed = diff.filter((d) => d.mark).length;
  const diffRows = diff.map((d) => `${d.mark === "+" ? "+" : d.mark === "-" ? "-" : " "} ${d.text}`);
  const lines = Array.isArray(run.lines) ? run.lines : [];
  const wide = w >= 100;
  const halfW = Math.floor((w - 2) / 2);
  return /* @__PURE__ */ jsxs16("box", { style: { width: w, height: h, flexDirection: "column", overflow: "hidden", flexShrink: 0 }, children: [
    /* @__PURE__ */ jsx17(
      ScrollPanel_default,
      {
        width: w,
        title: `\u2318 Live scripts \xB7 ${scripts.length}`,
        hint: "\u2191\u2193 select \xB7 enter run \xB7 esc back",
        total: scripts.length,
        rows: listRows,
        selected: Math.min(selected, Math.max(0, scripts.length - 1)),
        initial: "top",
        empty: "no scripts found in this checkout",
        children: (index, { width: rowW, compact }) => {
          const s = scripts[index];
          if (!s) return null;
          const active = index === selected;
          const isRunning = run.status === "running" && run.script && run.script.id === s.id;
          const tag = compact ? "" : `${s.tag} `;
          return /* @__PURE__ */ jsxs16("box", { style: { width: rowW, flexDirection: "row", flexShrink: 0 }, children: [
            /* @__PURE__ */ jsx17("text", { fg: active ? "yellow" : "gray", attributes: active ? TextAttributes12.BOLD : 0, children: `${active ? "\u25B8 " : "  "}${clipLine(`${tag}${s.label}`, Math.max(8, rowW - 12))}` }),
            isRunning ? /* @__PURE__ */ jsx17("text", { fg: "yellow", children: " \u25CF running" }) : null
          ] });
        }
      }
    ),
    /* @__PURE__ */ jsxs16("box", { style: { width: w, height: 1, flexShrink: 0, flexDirection: "row" }, children: [
      /* @__PURE__ */ jsx17("text", { fg: "#00ff41", attributes: TextAttributes12.BOLD, children: clipLine(`\u25C6 OMP SNAPSHOT \xB7 ${chosen ? chosen.label : "\u2014"}`, Math.max(8, w - 24)) }),
      /* @__PURE__ */ jsx17("text", { fg: "gray", children: `  ${changed ? `${changed} changed` : "source"} \xB7 ours vs live` })
    ] }),
    wide ? /* @__PURE__ */ jsxs16("box", { style: { width: w, flexDirection: "row", flexShrink: 0 }, children: [
      /* @__PURE__ */ jsx17(
        ScrollPanel_default,
        {
          width: halfW,
          title: "OURS",
          hint: changed ? `${changed} changed since last run` : "source",
          total: diffRows.length,
          rows: paneRows,
          borderColor: "#00ff41",
          initial: "follow",
          children: (index, { width: rowW }) => {
            const mark = diff[index]?.mark || "";
            return /* @__PURE__ */ jsx17("box", { style: { width: rowW }, children: /* @__PURE__ */ jsx17("text", { fg: mark === "+" ? "green" : mark === "-" ? "red" : "gray", children: clipLine(diffRows[index] || " ", rowW) }) });
          }
        }
      ),
      /* @__PURE__ */ jsx17(
        ScrollPanel_default,
        {
          width: w - halfW,
          title: "LIVE",
          hint: statusText(run),
          total: lines.length,
          rows: paneRows,
          borderColor: STATUS_COLOR[run.status] || "gray",
          initial: "follow",
          empty: run.status === "running" ? "waiting for output\u2026" : "not run yet \u2014 enter runs the selected script",
          children: (index, { width: rowW }) => /* @__PURE__ */ jsx17("box", { style: { width: rowW }, children: /* @__PURE__ */ jsx17("text", { fg: index === lines.length - 1 ? "white" : "gray", children: clipLine(lines[index] || " ", rowW) }) })
        }
      )
    ] }) : /* @__PURE__ */ jsx17(
      ScrollPanel_default,
      {
        width: w,
        title: "LIVE",
        hint: statusText(run),
        total: lines.length,
        rows: Math.max(2, snapshotRows - 3),
        borderColor: STATUS_COLOR[run.status] || "gray",
        initial: "follow",
        empty: run.status === "running" ? "waiting for output\u2026" : "not run yet \u2014 enter runs the selected script",
        children: (index, { width: rowW }) => /* @__PURE__ */ jsx17("box", { style: { width: rowW }, children: /* @__PURE__ */ jsx17("text", { fg: index === lines.length - 1 ? "white" : "gray", children: clipLine(lines[index] || " ", rowW) }) })
      }
    )
  ] });
}

// src/components/SquadView.jsx
import React18 from "react";
import { TextAttributes as TextAttributes13 } from "@opentui/core";

// src/utils/squad.js
var PEER_PATTERN = /agent|squad|subagent|codex|kiro|phantom|hermes|claude-code|hivemind|miniforge|serena|stealth|bounty/i;
var RANK = { live: 0, lazy: 1, down: 2 };
function peersFromMcp(mcp) {
  const servers = mcp && Array.isArray(mcp.servers) ? mcp.servers : [];
  return servers.filter((s) => s && s.name && PEER_PATTERN.test(s.name)).map((s) => {
    const state = s.initialized ? "live" : s.lazy ? "lazy" : "down";
    return {
      name: s.name,
      tools: Array.isArray(s.tools) ? s.tools : [],
      up: state === "live",
      lazy: !!s.lazy,
      state
    };
  }).sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name));
}

// src/components/SquadView.jsx
import { jsx as jsx18, jsxs as jsxs17 } from "react/jsx-runtime";
function SquadView({
  width = 80,
  height = 20,
  peers = [],
  selected = 0,
  onPick
}) {
  const w = Math.max(24, Number(width) || 80);
  const h = Math.max(8, Number(height) || 20);
  const chosen = peers[Math.min(selected, Math.max(0, peers.length - 1))] || null;
  const listRows = Math.min(8, Math.max(1, peers.length || 1));
  const listPanelRows = listRows + 3;
  const toolsRows = Math.max(2, h - listPanelRows - 3);
  const up = peers.filter((p) => p.up).length;
  const lazy = peers.filter((p) => p.state === "lazy").length;
  const DOT = { live: "\u25CF ", lazy: "\u25D0 ", down: "\u25CB " };
  const TINT = { live: "green", lazy: "cyan", down: "red" };
  return /* @__PURE__ */ jsxs17("box", { style: { width: w, height: h, flexDirection: "column", overflow: "hidden", flexShrink: 0 }, children: [
    /* @__PURE__ */ jsx18(
      ScrollPanel_default,
      {
        width: w,
        title: `\u26E8 Squad \xB7 ${up}/${peers.length} live${lazy ? ` \xB7 ${lazy} lazy` : ""}`,
        hint: "\u2191\u2193 select \xB7 enter delegate \xB7 esc back",
        total: peers.length,
        rows: listRows,
        selected: Math.min(selected, Math.max(0, peers.length - 1)),
        initial: "top",
        empty: "no agent peers reported by the server yet",
        children: (index, { width: rowW }) => {
          const p = peers[index];
          if (!p) return null;
          const active = index === selected;
          return /* @__PURE__ */ jsxs17("box", { style: { width: rowW, flexDirection: "row", flexShrink: 0 }, children: [
            /* @__PURE__ */ jsx18("text", { fg: active ? "yellow" : TINT[p.state] || "red", attributes: active ? TextAttributes13.BOLD : 0, children: `${active ? "\u25B8 " : "  "}${DOT[p.state] || "\u25CB "}` }),
            /* @__PURE__ */ jsx18("text", { fg: active ? "yellow" : "white", children: p.name.padEnd(Math.min(16, Math.max(8, rowW - 16))) }),
            /* @__PURE__ */ jsx18("text", { fg: "gray", children: `${p.tools.length} tools \xB7 ${p.state}` })
          ] });
        }
      }
    ),
    /* @__PURE__ */ jsx18(
      ScrollPanel_default,
      {
        width: w,
        title: chosen ? `${chosen.name} \xB7 tools` : "tools",
        hint: chosen ? `${chosen.tools.length} available` : "",
        total: chosen ? chosen.tools.length : 0,
        rows: toolsRows,
        borderColor: "magenta",
        initial: "top",
        empty: "\u2014",
        children: (index, { width: rowW, compact }) => {
          const tool = chosen && chosen.tools[index];
          if (!tool) return null;
          return /* @__PURE__ */ jsx18("box", { style: { width: rowW }, children: /* @__PURE__ */ jsx18("text", { fg: "white", children: compact ? tool : `mcp__${chosen.name}__${tool}` }) });
        }
      }
    )
  ] });
}

// src/components/ServicesPanel.jsx
import React19 from "react";
import { TextAttributes as TextAttributes14 } from "@opentui/core";

// ../smartness.mjs
import fs6 from "node:fs";
import os3 from "node:os";
import path5 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { execFile } from "node:child_process";
var CLI_DIR = path5.dirname(fileURLToPath2(import.meta.url));
var EXPECTED_SERVICES = [
  { port: 3579, name: "haksterAi", proto: "http" },
  { port: 8081, name: "cinevault", proto: "http" },
  { port: 4e3, name: "phantom", proto: "http" },
  { port: 8082, name: "claude-proxy", proto: "http" },
  { port: 5555, name: "miniforge", proto: "http" }
];
var DEFAULT_SCORE = 98;
function anchorScore() {
  try {
    const file = path5.join(os3.homedir(), ".hakster", "perf_history.json");
    const rows = JSON.parse(fs6.readFileSync(file, "utf8"));
    const last = Array.isArray(rows) ? rows[rows.length - 1] : null;
    const n = Number(last && (last.smartnessEnd ?? last.smartnessPeak));
    if (!Number.isFinite(n)) return DEFAULT_SCORE;
    return Math.max(50, Math.min(100, Math.round(n)));
  } catch {
    return DEFAULT_SCORE;
  }
}
function scoreToolCall(name, args, ok, out) {
  const cmd = String(args && args.command || "");
  const o = String(out || "").toLowerCase();
  let d = 0;
  if (ok === false) {
    d -= 5;
    if (/(eaddrinuse|err_dlopen_failed|npm error|syntaxerror|cannot find module|enoent|eacces|permission denied|module not found)/.test(o)) d -= 5;
  }
  if (/\brm\s+-[rf]/i.test(cmd) || /\bgit\s+(reset\s+--hard|checkout\s+--|clean)\b/i.test(cmd)) {
    if (/\.(md|json|env|js|ts|astro|sh|py)$|(agents\.md|package\.json|config|\.env)/i.test(cmd)) d -= 10;
    else d -= 5;
  }
  if (ok !== false) {
    if (/(http\/1\.1\s+200|\b200\s+ok\b|\bok\b|rebuilt|\bbuilt\b|success|✓|applied)/.test(o)) d += 2;
    else d += 1;
    if (["write_file", "patch_file", "multi_patch", "edit_file", "insert_lines", "replace_regex", "append_file"].includes(name)) {
      const content = String(args && (args.content || args.patch || args.text || args.new_string) || "");
      const fp = String(args && (args.path || args.file) || "");
      const isDataDoc = /\.(md|json|ya?ml|txt|csv|py|js|ts|astro|sh)$/i.test(fp);
      const len = content.length;
      const pts = isDataDoc ? Math.min(10, Math.round(len / 200)) : Math.min(8, Math.round(len / 300));
      d += Math.max(2, pts);
    }
    if (/scrape|firecrawl/i.test(name) || /firecrawl|scrape/.test(cmd)) d += 3;
    if (/\b(npm\s+install|npm\s+rebuild|pip\s+install|chown|chmod|pm2\s+(restart|start))\b/i.test(cmd)) d += 1;
  }
  return Math.max(-12, Math.min(10, d));
}
function createMeter() {
  const meter = {
    score: anchorScore(),
    delta: 0,
    points: 0,
    rounds: 0,
    successes: 0,
    failures: 0,
    peak: 0
  };
  meter.peak = meter.score;
  const apply = (d) => {
    if (!Number.isFinite(d) || d === 0) return 0;
    const before = meter.score;
    meter.score = Math.max(0, Math.min(100, meter.score + d));
    meter.delta = meter.score - before;
    meter.points += d;
    if (meter.score > meter.peak) meter.peak = meter.score;
    return meter.delta;
  };
  meter.tool = (name, args, ok, out) => {
    if (ok) meter.successes++;
    else meter.failures++;
    return apply(scoreToolCall(name, args, ok, out));
  };
  meter.bump = (d) => apply(d);
  meter.resetTask = () => {
    meter.rounds = 0;
    meter.delta = 0;
  };
  meter.snapshot = () => ({
    score: meter.score,
    delta: meter.delta,
    points: meter.points,
    rounds: meter.rounds,
    successes: meter.successes,
    failures: meter.failures,
    peak: meter.peak
  });
  return meter;
}
function smartLabel(score) {
  if (score >= 80) return "Sharp";
  if (score >= 66) return "Strong";
  if (score >= 50) return "Steady";
  if (score >= 33) return "Slipping";
  return "Struggling";
}
function barCells(value, total, len = 16) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  const filled = Math.round(ratio * len);
  return { filled, empty: Math.max(0, len - filled) };
}
function barColor(kind, value) {
  if (kind === "points") {
    if (value >= 150) return "#58a6ff";
    if (value >= 66) return "#3fb950";
    if (value >= 33) return "#d29922";
    return "#f85149";
  }
  if (value >= 66) return "#3fb950";
  if (value >= 33) return "#d29922";
  return "#f85149";
}
function scanPorts(timeoutMs = 4e3) {
  return new Promise((resolve) => {
    execFile("ss", ["-tlnp"], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => {
      const text = String(stdout || "");
      const ports = /* @__PURE__ */ new Set();
      const procs = {};
      for (const line of text.split("\n")) {
        const m = line.match(/:([0-9]{2,5})\s+\S+\s+.*users:\(\("([^"]+)"/);
        if (m) {
          ports.add(Number(m[1]));
          procs[m[1]] = m[2];
          continue;
        }
        const m2 = line.match(/:([0-9]{2,5})\s+\S+/);
        if (m2) ports.add(Number(m2[1]));
      }
      if (err && !text) return resolve({ ok: false, ports: [], procs: {}, at: Date.now() });
      resolve({ ok: true, ports: [...ports].sort((a, b) => a - b), procs, at: Date.now() });
    });
  });
}
function serviceStates(scan) {
  const open = new Set(scan && scan.ports || []);
  return EXPECTED_SERVICES.map((svc) => ({
    ...svc,
    up: open.has(svc.port),
    proc: scan && scan.procs && scan.procs[String(svc.port)] || ""
  }));
}
function otherListening(scan) {
  const known = new Set(EXPECTED_SERVICES.map((svc) => svc.port));
  const ports = scan && scan.ports || [];
  return ports.filter((port) => !known.has(port)).map((port) => ({
    port,
    proc: scan && scan.procs && scan.procs[String(port)] || ""
  }));
}
var IMPORTANT_FILES = [
  "AGENTS.md",
  "package.json",
  "cli/index.js",
  "cli/memory.js",
  "server/src/index.js",
  "server/src/agent/index.js",
  "server/src/agent/loop.js",
  "server/src/agent/autolearn.js",
  "server/hakster-config.json",
  "server/src/hakster-config.json",
  "scripts/hakster-guardrails.sh",
  "HAKSTERAI-PHANTOM-MERGED.md",
  ".env"
];
function fileGuard(root2 = path5.resolve(CLI_DIR, "..")) {
  const present = [];
  const missing = [];
  for (const rel of IMPORTANT_FILES) {
    try {
      if (fs6.existsSync(path5.join(root2, rel))) present.push(rel);
      else missing.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  return { present: present.length, total: IMPORTANT_FILES.length, missing };
}
function portLabel(entry, max = 14) {
  const proc = String(entry && entry.proc || "").split(/\s+/)[0];
  const text = proc || "listening";
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}\u2026`;
}

// src/components/ServicesPanel.jsx
import { jsx as jsx19, jsxs as jsxs18 } from "react/jsx-runtime";
var CELL_W = 16;
function servicesGridRows(width, count, dense = false) {
  const inner = Math.max(1, (Number(width) || 80) - 4);
  const perRow = Math.max(1, Math.floor(inner / (CELL_W + 1)));
  const rows = Math.max(1, Math.ceil(Math.max(1, Number(count) || 1) / perRow));
  return 3 + rows * (dense ? 1 : 2);
}
var clip5 = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}\u2026`;
};
function ServicesPanel({
  width = 100,
  services = [],
  scan = null,
  showAll = false,
  maxCells = 32,
  dense = false
}) {
  const w = Math.max(24, Number(width) || 80);
  const list = Array.isArray(services) ? services : [];
  const known = new Set(list.map((s) => s.port));
  const others = otherListening(scan).filter((p) => !known.has(p.port));
  const up = list.filter((s) => s.up).length;
  const scanOk = !!(scan && scan.ok);
  const allUp = list.length > 0 && up === list.length;
  if (w < 96) {
    const inner = Math.max(8, w - 4);
    const head = `Services ${up}/${list.length} online  `;
    const room = Math.max(0, inner - head.length);
    const shown = [];
    let used = 0;
    for (const s of list) {
      const text = `\u25CF :${s.port}  `;
      if (used + text.length > room) break;
      shown.push({ ...s, text });
      used += text.length;
    }
    const hiddenSvc = list.length - shown.length;
    const leftover = Math.max(0, inner - head.length - used);
    const tails = !scanOk ? ["scan unavailable", "scan \u2026", "\u2026"] : hiddenSvc > 0 ? [`+${hiddenSvc}  +${others.length} ports`, `+${hiddenSvc}  +${others.length}`, `+${hiddenSvc + others.length}`] : others.length ? [`+${others.length} other ports`, `+${others.length} ports`, `+${others.length}`] : [];
    const tail = tails.find((t) => t.length <= leftover) || "";
    return /* @__PURE__ */ jsx19("box", { style: { width: w, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: "gray", paddingLeft: 1, paddingRight: 1, flexShrink: 0 }, children: /* @__PURE__ */ jsxs18("text", { children: [
      /* @__PURE__ */ jsx19("span", { fg: "cyan", attributes: TextAttributes14.BOLD, children: "Services " }),
      /* @__PURE__ */ jsx19("span", { fg: allUp ? "green" : up > 0 ? "yellow" : "red", children: `${up}/${list.length} online  ` }),
      shown.map((s) => /* @__PURE__ */ jsx19("span", { fg: s.up ? "green" : "red", children: s.text }, s.port)),
      /* @__PURE__ */ jsx19("span", { fg: scanOk ? "gray" : "yellow", children: tail })
    ] }) });
  }
  const cells = list.map((s) => ({
    key: String(s.port),
    label: `:${s.port}`,
    value: `\u25CF ${s.name}`,
    color: s.up ? "green" : "red"
  }));
  if (showAll) {
    const shown = others.slice(0, 15);
    for (const p of shown) {
      cells.push({
        key: `x${p.port}`,
        label: `:${p.port}`,
        value: `\u25CF ${portLabel(p)}`,
        color: "green"
      });
    }
    if (others.length > shown.length) {
      cells.push({
        key: "more",
        label: "other",
        value: `+${others.length - shown.length} ports`,
        color: "cyan"
      });
    }
  }
  const capacity = Math.max(2, Math.trunc(Number(maxCells) || 32));
  const overflow = cells.length - capacity;
  const shownCells = overflow > 0 ? cells.slice(0, capacity - 1) : cells;
  const hiddenCells = cells.length - shownCells.length;
  return /* @__PURE__ */ jsxs18(
    GridPanel_default,
    {
      title: "\u25A3 Services on ports",
      width: w,
      borderColor: "gray",
      dense,
      hint: clip5(
        `${up}/${list.length} online${others.length ? ` \xB7 ${others.length} other ports` : ""}${scanOk ? "" : " \xB7 scan unavailable"}`,
        Math.max(6, w - 24)
      ),
      children: [
        shownCells.map((c) => /* @__PURE__ */ jsx19(Cell, { label: c.label, value: c.value, w: CELL_W, color: c.color, dense }, c.key)),
        hiddenCells > 0 ? /* @__PURE__ */ jsx19(Cell, { label: "more", value: `+${hiddenCells} cells`, w: CELL_W, color: "cyan", dense }, "__more") : null
      ]
    }
  );
}

// src/components/StatusServicesPanel.jsx
import React21 from "react";
import { TextAttributes as TextAttributes16 } from "@opentui/core";

// src/components/SystemPanel.jsx
import React20 from "react";
import { TextAttributes as TextAttributes15 } from "@opentui/core";
import { jsx as jsx20, jsxs as jsxs19 } from "react/jsx-runtime";
var clip6 = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}\u2026`;
};
function SystemPanel({ width = 100, meters = null, ctxUsed = 0, ctxMax = 1, host = null }) {
  const w = Math.max(24, Number(width) || 80);
  const score = Math.max(0, Math.min(100, Math.round(Number(meters && meters.score) || 0)));
  const points = Math.max(0, Math.round(Number(meters && meters.points) || 0));
  const delta = Number(meters && meters.delta) || 0;
  const ctxPct = ctxMax > 0 ? Math.max(0, Math.min(100, Math.round((Number(ctxUsed) || 0) / ctxMax * 100))) : 0;
  const arrow = delta > 0 ? "\u25B2" : delta < 0 ? "\u25BC" : "\u25C6";
  const arrowColor = delta > 0 ? "green" : delta < 0 ? "red" : "gray";
  const cpuPct = host && host.cpuPct != null ? host.cpuPct : null;
  const memPct = host && host.memPct != null ? host.memPct : null;
  const swapPct = host && host.swapPct != null ? host.swapPct : null;
  const heat = (p) => p == null ? "gray" : p > 85 ? "red" : p > 60 ? "yellow" : "green";
  const hostTxt = cpuPct == null && memPct == null ? "" : `cpu ${cpuPct == null ? "\u2014" : `${cpuPct}%`}  ram ${memPct == null ? "\u2014" : `${memPct}%`}  swap ${swapPct == null ? "\u2014" : `${swapPct}%`}`;
  const sc = barCells(score, 100, 12);
  const ac = barCells(points, 100, 10);
  const cc = barCells(ctxPct, 100, 8);
  const fullLen = 3 + 12 + 13 + 3 + 2 + 10 + 16 + 3 + 4 + 8 + 7 + (hostTxt ? hostTxt.length + 3 : 0);
  const hostShort = cpuPct == null && memPct == null ? "" : `  cpu ${cpuPct == null ? "\u2014" : `${cpuPct}%`} ram ${memPct == null ? "\u2014" : `${memPct}%`}`;
  const compact = `\u{1F9E0} ${score}% ${arrow} ${smartLabel(score)}  \u2726 ${points}p autolearn  ctx ${ctxPct}%${hostShort}`;
  const terse = `\u{1F9E0} ${score}% \u2726 ${points}p ctx ${ctxPct}%${hostShort}`;
  if (fullLen <= w) {
    return /* @__PURE__ */ jsx20("box", { style: { width: w, flexDirection: "column", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }, children: /* @__PURE__ */ jsxs19("text", { children: [
      /* @__PURE__ */ jsx20("span", { fg: barColor("smart", score), attributes: TextAttributes15.BOLD, children: "\u{1F9E0} " }),
      /* @__PURE__ */ jsx20("span", { fg: barColor("smart", score), children: "\u2588".repeat(sc.filled) }),
      /* @__PURE__ */ jsx20("span", { fg: "gray", children: "\u2591".repeat(sc.empty) }),
      /* @__PURE__ */ jsx20("span", { fg: "white", attributes: TextAttributes15.BOLD, children: ` ${score}% ` }),
      /* @__PURE__ */ jsx20("span", { fg: arrowColor, children: arrow }),
      /* @__PURE__ */ jsx20("span", { fg: "gray", children: ` ${smartLabel(score)}` }),
      /* @__PURE__ */ jsx20("span", { fg: "gray", children: "   " }),
      /* @__PURE__ */ jsx20("span", { fg: barColor("points", points), attributes: TextAttributes15.BOLD, children: "\u2726 " }),
      /* @__PURE__ */ jsx20("span", { fg: barColor("points", points), children: "\u2588".repeat(ac.filled) }),
      /* @__PURE__ */ jsx20("span", { fg: "gray", children: "\u2591".repeat(ac.empty) }),
      /* @__PURE__ */ jsx20("span", { fg: "white", attributes: TextAttributes15.BOLD, children: ` ${points}p` }),
      /* @__PURE__ */ jsx20("span", { fg: "gray", children: " autolearn   " }),
      /* @__PURE__ */ jsx20("span", { fg: ctxPct > 85 ? "red" : ctxPct > 60 ? "yellow" : "green", children: "ctx " }),
      /* @__PURE__ */ jsx20("span", { fg: ctxPct > 85 ? "red" : ctxPct > 60 ? "yellow" : "green", children: "\u2588".repeat(cc.filled) }),
      /* @__PURE__ */ jsx20("span", { fg: "gray", children: "\u2591".repeat(cc.empty) }),
      /* @__PURE__ */ jsx20("span", { fg: "white", children: ` ${ctxPct}%` }),
      hostTxt ? /* @__PURE__ */ jsx20("span", { fg: "gray", children: "   " }) : null,
      hostTxt ? /* @__PURE__ */ jsx20("span", { fg: heat(cpuPct), children: `cpu ${cpuPct == null ? "\u2014" : `${cpuPct}%`}` }) : null,
      hostTxt ? /* @__PURE__ */ jsx20("span", { fg: heat(memPct), children: `  ram ${memPct == null ? "\u2014" : `${memPct}%`}` }) : null,
      hostTxt ? /* @__PURE__ */ jsx20("span", { fg: heat(swapPct), children: `  swap ${swapPct == null ? "\u2014" : `${swapPct}%`}` }) : null
    ] }) });
  }
  return /* @__PURE__ */ jsx20("box", { style: { width: w, flexDirection: "column", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }, children: /* @__PURE__ */ jsx20("text", { children: /* @__PURE__ */ jsx20("span", { fg: barColor("smart", score), attributes: TextAttributes15.BOLD, children: clip6(compact.length <= w ? compact : terse, Math.max(10, w - 2)) }) }) });
}

// src/components/StatusServicesPanel.jsx
import { jsx as jsx21, jsxs as jsxs20 } from "react/jsx-runtime";
var CELL_W2 = 16;
function gridShape(width, n) {
  const inner = Math.max(1, (Number(width) || 80) - 4);
  const perRowCap = Math.max(1, Math.floor(inner / (CELL_W2 + 1)));
  const perRow = Math.max(1, Math.min(perRowCap, Math.ceil(Math.max(1, n) / 2)));
  const capacity = perRow * 2;
  return { perRow, capacity };
}
function statusServicesRows(width, count, dense = true, showMeters = true) {
  const n = Math.max(1, Number(count) || 1);
  const { perRow, capacity } = gridShape(width, n);
  const shown = Math.min(n, capacity);
  const rows = Math.max(1, Math.min(2, Math.ceil(shown / perRow)));
  return 3 + (showMeters ? 1 : 0) + rows * (dense ? 1 : 2);
}
function StatusServicesPanel({
  width = 100,
  services = [],
  version = "",
  guard = null,
  online = true,
  offline = false,
  meters = null,
  ctxUsed = 0,
  ctxMax = 1,
  host = null,
  dense = true,
  showMeters = true
}) {
  const w = Math.max(24, Number(width) || 80);
  const inner = Math.max(1, w - 4);
  const list = Array.isArray(services) ? services : [];
  const up = list.filter((s) => s.up).length;
  const allUp = list.length > 0 && up === list.length;
  const guardTxt = guard ? `${guard.present}/${guard.total} files` : "";
  const guardBad = !!(guard && guard.missing && guard.missing.length);
  const stateTxt = offline ? "OFFLINE" : online ? "ONLINE" : "connecting\u2026";
  const stateColor = offline ? "red" : online ? "green" : "yellow";
  const leftBase = `${offline ? "\u25CB " : online ? "\u25CF " : "\u25CC "}\u25C6 haksterAi \xB7 ${stateTxt}`;
  const leftFull = guardTxt ? `${leftBase}   ${guardTxt}` : leftBase;
  const rightFull = `ports ${up}/${list.length}${version ? ` \xB7 tui ${version}` : ""}`;
  const candidates = [
    { left: leftFull, right: rightFull, guard: true },
    { left: leftFull, right: version ? `tui ${version}` : "", guard: true },
    { left: leftFull, right: "", guard: true },
    { left: leftBase, right: version ? `tui ${version}` : "", guard: false },
    { left: leftBase, right: "", guard: false }
  ];
  const head = candidates.find(
    (c) => c.left.length + (c.right ? c.right.length + 2 : 0) <= inner
  ) || { left: leftBase, right: "", guard: false };
  const showGuardHere = head.guard && !!guardTxt;
  const rightText = head.right;
  const cells = list.map((s) => ({
    key: String(s.port),
    label: `:${s.port}`,
    value: `\u25CF ${s.name}`,
    color: s.up ? "green" : "red"
  }));
  const { perRow, capacity } = gridShape(w, cells.length);
  const shown = cells.length > capacity ? cells.slice(0, capacity - 1) : cells;
  const hidden = cells.length - shown.length;
  const items = hidden > 0 ? [...shown, { key: "__more", label: "more", value: `+${hidden}`, color: "cyan" }] : shown;
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  return /* @__PURE__ */ jsxs20("box", { style: { width: w, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: "gray", paddingLeft: 1, paddingRight: 1, flexShrink: 0 }, children: [
    /* @__PURE__ */ jsxs20("box", { style: { width: inner, flexDirection: "row", justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsxs20("text", { children: [
        /* @__PURE__ */ jsx21("span", { fg: stateColor, attributes: TextAttributes16.BOLD, children: offline ? "\u25CB " : online ? "\u25CF " : "\u25CC " }),
        /* @__PURE__ */ jsx21("span", { fg: "cyan", attributes: TextAttributes16.BOLD, children: "\u25C6 haksterAi" }),
        /* @__PURE__ */ jsx21("span", { fg: stateColor, children: ` \xB7 ${stateTxt}` }),
        showGuardHere ? /* @__PURE__ */ jsx21("span", { fg: guardBad ? "red" : "gray", children: `   ${guardTxt}` }) : null
      ] }),
      rightText ? /* @__PURE__ */ jsx21("text", { fg: allUp ? "green" : up > 0 ? "yellow" : "red", children: rightText }) : null
    ] }),
    showMeters ? /* @__PURE__ */ jsx21(SystemPanel, { width: inner, meters, ctxUsed, ctxMax, host }) : null,
    rows.map((row, i) => /* @__PURE__ */ jsx21("box", { style: { width: inner, flexDirection: "row" }, children: row.map((c) => /* @__PURE__ */ jsx21(Cell, { label: c.label, value: c.value, w: CELL_W2, color: c.color, dense }, c.key)) }, `r${i}`))
  ] });
}

// src/components/StatusBar.jsx
import React22 from "react";
import { TextAttributes as TextAttributes17 } from "@opentui/core";
import { jsx as jsx22, jsxs as jsxs21 } from "react/jsx-runtime";
var STATUS_STYLES = {
  idle: { text: "ready", color: "gray" },
  connecting: { text: "can't reach server\u2026", color: "yellow" },
  thinking: { text: "thinking\u2026", color: "yellow" },
  streaming: { text: "working\u2026", color: "cyan" },
  // The run is parked on a decision the operator has to make. Naming it here
  // matters: the composer is disabled and otherwise nothing on this bar would
  // explain why the session has gone quiet.
  approval: { text: "needs approval", color: "yellow" },
  error: { text: "error", color: "red" }
};
function formatElapsed(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  return `${(n / 1e3).toFixed(1)}s`;
}
function StatusBar({ width, status, model, cols, focus, adsOn, elapsedMs, hint, handoff, autoMode }) {
  const known = status ? STATUS_STYLES[status] : null;
  const label = known ? known.text : status ? String(status) : "";
  const elapsed = status === "streaming" || status === "thinking" || status === "approval" ? formatElapsed(elapsedMs) : null;
  const segs = [];
  if (label) segs.push({ key: "status", color: known ? known.color : "gray", text: label });
  if (elapsed) segs.push({ key: "elapsed", color: "gray", text: elapsed });
  if (model) segs.push({ key: "model", color: "yellow", text: model });
  if (handoff !== void 0 && handoff !== null) {
    segs.push({ key: "handoff", color: handoff ? "green" : "red", text: handoff ? "handoff auto" : "handoff off" });
  }
  if (autoMode) {
    segs.push({
      key: "auto",
      color: autoMode === "full-auto" ? "yellow" : autoMode === "suggest" ? "gray" : "green",
      text: autoMode === "full-auto" ? "auto full" : autoMode === "suggest" ? "auto ask" : "auto edit"
    });
  }
  if (cols !== void 0 && cols !== null) segs.push({ key: "cols", color: "gray", text: `${cols}c` });
  segs.push({ key: "ads", color: adsOn ? "green" : "red", text: adsOn ? "ads on" : "ads off" });
  const leftText = focus === "ad" ? "\u27EA ad \u27EB" : "\u27EA composer \u27EB";
  const hintText = hint ? `  ${hint}` : "";
  const barW = Math.max(20, Number(width) || 80);
  const avail = Math.max(8, barW - 2 - leftText.length - hintText.length - 2);
  const joinedLen = (list) => list.reduce((n, one, i) => n + one.text.length + (i ? 3 : 0), 0);
  const shown = segs.slice();
  while (shown.length > 1 && joinedLen(shown) > avail) shown.pop();
  if (shown.length === 1 && shown[0].text.length > avail) {
    shown[0] = { ...shown[0], text: `${shown[0].text.slice(0, Math.max(0, avail - 1))}\u2026` };
  }
  return /* @__PURE__ */ jsxs21("box", { style: { width: barW, flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1, overflow: "hidden", flexShrink: 0 }, children: [
    /* @__PURE__ */ jsx22("text", { fg: "gray", children: `${leftText}${hintText}` }),
    /* @__PURE__ */ jsx22("text", { children: shown.map((seg, i) => /* @__PURE__ */ jsx22("span", { fg: seg.color, children: `${i ? " \xB7 " : ""}${seg.text}` }, seg.key)) })
  ] });
}

// src/components/CrushStatus.jsx
import React23, { useEffect as useEffect8, useState as useState9 } from "react";
import { jsx as jsx23, jsxs as jsxs22 } from "react/jsx-runtime";
var FRAMES = ["\u2744", "\u2726", "\u2727", "\u2736", "\u2727", "\u2726"];
var SHIMMER = ["\u2745", "\u2744", "\u2727", "\u2744", "\u2745"];
var GRADIENT = [51, 87, 117, 153, 117, 87];
var PHASES = {
  THINK: { color: "#58a6ff", emoji: "\u{1F9E0}", phrases: ["Thinking through the problem\u2026", "Reasoning carefully\u2026", "Analyzing the request\u2026", "Connecting concepts\u2026"] },
  PLAN: { color: "#c084fc", emoji: "\u{1F4CB}", phrases: ["Formulating a plan\u2026", "Mapping out steps\u2026", "Structuring the approach\u2026"] },
  ACT: { color: "#3fb950", emoji: "\u26A1", phrases: ["Executing command\u2026", "Running tool\u2026", "Taking action\u2026"] },
  OBSERVE: { color: "#39c5cf", emoji: "\u{1F441}", phrases: ["Observing output\u2026", "Reading results\u2026", "Checking response\u2026"] },
  REFLECT: { color: "#d29922", emoji: "\u{1FA9E}", phrases: ["Assessing the outcome\u2026", "Learning from this step\u2026"] },
  CONSOLIDATE: { color: "#ffd700", emoji: "\u{1F4E6}", phrases: ["Consolidating findings\u2026", "Compiling the answer\u2026", "Putting it all together\u2026"] },
  DEFAULT: { color: "#58a6ff", emoji: "\u25C7", phrases: ["Working on it\u2026", "Processing\u2026", "Hold tight\u2026"] }
};
function formatElapsed2(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1e3));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
function CrushStatus({ width, phase, activity, elapsedMs, queued = 0 }) {
  const [frame, setFrame] = useState9(0);
  useEffect8(() => {
    const timer = setInterval(() => setFrame((value) => value + 1), 80);
    return () => clearInterval(timer);
  }, []);
  const normalizedPhase = String(phase || "DEFAULT").toUpperCase();
  const info = PHASES[normalizedPhase] || PHASES.DEFAULT;
  const color = Number(elapsedMs || 0) < 5e3 ? "#3fb950" : Number(elapsedMs || 0) < 15e3 ? "#d29922" : "#f85149";
  const grad = GRADIENT[frame % GRADIENT.length];
  const gradColor = `rgb(${grad},${Math.floor(grad * 0.7)},${Math.floor(grad * 1.2)})`;
  const phrase = activity || info.phrases[Math.floor(frame / 20) % info.phrases.length];
  const shimmer = [0, 1, 2].map((offset) => SHIMMER[(frame + offset) % SHIMMER.length]).join("");
  return /* @__PURE__ */ jsx23("box", { style: { width, flexDirection: "row", paddingLeft: 1, overflow: "hidden" }, children: /* @__PURE__ */ jsxs22("text", { children: [
    /* @__PURE__ */ jsx23("span", { fg: gradColor, children: "\u27E6" }),
    /* @__PURE__ */ jsx23("span", { fg: color, children: FRAMES[frame % FRAMES.length] }),
    /* @__PURE__ */ jsx23("span", { fg: gradColor, children: "\u27E7" }),
    " ",
    /* @__PURE__ */ jsx23("span", { children: info.emoji }),
    " ",
    /* @__PURE__ */ jsx23("span", { fg: info.color, children: normalizedPhase }),
    " ",
    /* @__PURE__ */ jsx23("span", { fg: "#a5b4c3", children: phrase }),
    " ",
    /* @__PURE__ */ jsx23("span", { fg: gradColor, children: shimmer }),
    " ",
    /* @__PURE__ */ jsx23("span", { fg: "gray", children: formatElapsed2(elapsedMs) }),
    Number(queued) > 0 ? /* @__PURE__ */ jsx23("span", { fg: "#d29922", children: `  \u23F3 ${Number(queued)} queued` }) : null
  ] }) });
}

// src/components/TodoPanel.jsx
import React24 from "react";
import { TextAttributes as TextAttributes18 } from "@opentui/core";
import { jsx as jsx24, jsxs as jsxs23 } from "react/jsx-runtime";
var GLYPH_DONE = "\u2713";
var GLYPH_TODO = "\u25CB";
var EMPTY_TEXT = "No todos yet \u2014 the agent's checklist appears here once it creates one.";
function TodoPanel({ todos = [], width, hint, maxVisibleRows = 8 }) {
  const list = Array.isArray(todos) ? todos : [];
  const completed = list.filter((t) => t && t.done).length;
  const title = width && width < 34 ? `Todos ${completed}/${list.length}` : `Todos \u2014 ${completed}/${list.length} completed`;
  return /* @__PURE__ */ jsx24(
    ScrollPanel_default,
    {
      width,
      title,
      hint,
      total: list.length,
      rows: Math.max(1, Math.min(Number(maxVisibleRows) || 1, Math.max(1, list.length))),
      empty: EMPTY_TEXT,
      compactWhen: width != null && width < 46,
      children: (index, { width: bodyW, compact }) => {
        const todo = list[index] || {};
        const done = !!todo.done;
        const text = clip(todo.text || "", Math.max(1, bodyW - 2));
        return /* @__PURE__ */ jsxs23("box", { style: { width: bodyW, flexDirection: "row", flexShrink: 0 }, children: [
          /* @__PURE__ */ jsx24("text", { fg: done ? "green" : "gray", attributes: done || compact ? 0 : TextAttributes18.DIM, children: done ? GLYPH_DONE : GLYPH_TODO }),
          /* @__PURE__ */ jsx24("text", { fg: done ? "white" : "gray", children: ` ${text}` })
        ] });
      }
    }
  );
}

// src/components/Transcript.jsx
import React26, { useEffect as useEffect10, useRef as useRef6, useState as useState11 } from "react";
import { useKeyboard as useKeyboard6 } from "@opentui/react";

// src/components/MessageBlock.jsx
import React25, { useEffect as useEffect9, useState as useState10 } from "react";
import { TextAttributes as TextAttributes19 } from "@opentui/core";
import { Fragment as Fragment9, jsx as jsx25, jsxs as jsxs24 } from "react/jsx-runtime";
var RESULT_LINES = 3;
var ROLE_STYLE = {
  user: { border: "cyan", label: "you" },
  assistant: { border: "gray", label: "hakster" },
  system: { border: "yellow", label: "system" }
};
var TONE_COLOR = { error: "red", warn: "yellow", notice: "cyan" };
var lastLine = (s) => String(s || "").replace(/\r/g, "").split("\n").filter((l) => l.trim()).pop() || "";
var LIVE_THINK_LINES = 4;
var LIVE_TEXT_LINES = 8;
function tailWindow(value, n) {
  const lines = String(value == null ? "" : value).replace(/\r/g, "").split("\n").filter((l) => l.trim());
  return { lines: lines.slice(-n), hidden: Math.max(0, lines.length - n) };
}
var thoughtFor = (ms) => `Thought for ${Math.max(1, Math.round((Number(ms) || 0) / 1e3))}s`;
function ThinkingBlock({ text, startedAt, endedAt, live, width, compact, expand, label = true }) {
  const frame = useSpinnerFrame(live);
  const started = Number(startedAt) || 0;
  const ended = Number(endedAt) || 0;
  if (live) {
    const window = tailWindow(text, compact ? 1 : LIVE_THINK_LINES);
    return /* @__PURE__ */ jsxs24("box", { style: { flexDirection: "column", width, flexShrink: 0 }, children: [
      label ? /* @__PURE__ */ jsxs24("text", { children: [
        /* @__PURE__ */ jsx25("span", { fg: "yellow", children: `${SPINNER_FRAMES[frame]} ` }),
        /* @__PURE__ */ jsx25("span", { fg: "gray", children: `thinking\u2026${started ? ` ${fmtDur(Date.now() - started)}` : ""}` })
      ] }) : null,
      window.lines.map((line, i) => /* @__PURE__ */ jsx25("text", { fg: "gray", children: line.trim() }, `th-${i}`))
    ] });
  }
  if (!expand) {
    const label2 = started && ended ? thoughtFor(ended - started) : lastLine(text);
    return /* @__PURE__ */ jsx25("text", { fg: "gray", children: clip(`\u22EF ${label2}`, Math.max(4, width)) });
  }
  return /* @__PURE__ */ jsx25("box", { style: { flexDirection: "column", width, flexShrink: 0 }, children: String(text || "").replace(/\r/g, "").split("\n").filter((l) => l.trim()).map((line, i) => /* @__PURE__ */ jsx25("text", { fg: "gray", children: line.trim() }, `td-${i}`)) });
}
function ProseBlock({ text, live, width, compact }) {
  if (!live) return /* @__PURE__ */ jsx25("text", { fg: "white", children: String(text) });
  const window = tailWindow(text, compact ? 3 : LIVE_TEXT_LINES);
  return /* @__PURE__ */ jsxs24("box", { style: { flexDirection: "column", width, flexShrink: 0 }, children: [
    window.hidden ? /* @__PURE__ */ jsx25("text", { fg: "gray", children: `\u22EF ${window.hidden} earlier line${window.hidden === 1 ? "" : "s"} (writing)` }) : null,
    window.lines.map((line, i) => /* @__PURE__ */ jsx25("text", { fg: "white", children: line.trim() }, `pr-${i}`))
  ] });
}
var SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
var ARGS_BUDGET = 64;
var ARG_VALUE_MAX = 40;
function flattenArgs(args) {
  if (args === null || args === void 0) return "";
  if (typeof args === "string") return args.trim().replace(/\s+/g, " ");
  if (Array.isArray(args)) return flattenArgs(args.join(" "));
  if (typeof args === "object") {
    return Object.entries(args).map(([k, v]) => {
      let val = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
      if (val.length > ARG_VALUE_MAX) val = `${val.slice(0, ARG_VALUE_MAX - 1)}\u2026`;
      return `${k}=${val}`;
    }).join(" ");
  }
  return String(args);
}
var isErrorResult = (result) => /^Error[:\n]|^❌/i.test(String(result == null ? "" : result).trim());
function fmtDur(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  return n < 1e3 ? `${n}ms` : `${(n / 1e3).toFixed(1)}s`;
}
function useSpinnerFrame(active) {
  const [frame, setFrame] = useState10(0);
  useEffect9(() => {
    if (!active) return void 0;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 100);
    return () => clearInterval(id);
  }, [active]);
  return frame;
}
function ToolRow({ tool, width, compact = false }) {
  const pending = tool.result === null || tool.result === void 0;
  const frame = useSpinnerFrame(pending);
  const failed = !pending && isErrorResult(tool.result);
  const glyph = pending ? SPINNER_FRAMES[frame] : failed ? "\u2717" : "\u2713";
  const colour = pending ? "yellow" : failed ? "red" : "green";
  const name = tool.name || "tool";
  const args = clip(flattenArgs(tool.args), ARGS_BUDGET);
  const dur = pending ? fmtDur(Date.now() - (Number(tool.t0) || Date.now())) : tool.ms != null ? fmtDur(tool.ms) : "";
  const nameW = name.length + 2;
  const argW = Math.max(4, width - nameW - (args ? dur.length + 3 : 0));
  const shown = pending ? null : String(tool.result).replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").split("\n");
  const limit = compact ? 1 : RESULT_LINES;
  const lines = shown ? shown.slice(0, limit) : [];
  const hidden = shown ? Math.max(0, shown.length - lines.length) : 0;
  return /* @__PURE__ */ jsxs24("box", { style: { flexDirection: "column", width, flexShrink: 0 }, children: [
    /* @__PURE__ */ jsxs24("text", { children: [
      /* @__PURE__ */ jsxs24("span", { fg: colour, children: [
        glyph,
        " "
      ] }),
      /* @__PURE__ */ jsx25("span", { fg: "white", children: name }),
      args ? /* @__PURE__ */ jsx25("span", { fg: "gray", children: ` ${clip(args, argW)}` }) : null,
      dur ? /* @__PURE__ */ jsx25("span", { fg: "gray", children: `  ${dur}` }) : null
    ] }),
    lines.map((line, i) => /* @__PURE__ */ jsx25("text", { fg: failed ? "red" : "gray", children: clip(line.trim() || " ", Math.max(4, width - 1)) }, `r-${i}`)),
    pending && !lines.length ? /* @__PURE__ */ jsx25("text", { fg: "gray", children: clip("\u2502 waiting for output\u2026", Math.max(4, width)) }) : null,
    hidden > 0 ? /* @__PURE__ */ jsx25("text", { fg: "gray", children: `\u2026 +${hidden} more line${hidden === 1 ? "" : "s"} \xB7 \u25B6 Result` }) : null
  ] });
}
function MessageBlock({ message, width, compact = false, live = false, expandThinking = false, showLiveLabel = true }) {
  if (!message) return null;
  const roleStyle = ROLE_STYLE[message.role] || ROLE_STYLE.system;
  const border = message.role === "system" && message.tone ? TONE_COLOR[message.tone] || roleStyle.border : roleStyle.border;
  const inner = Math.max(8, (width || 80) - 4);
  if (message.role === "system") {
    return /* @__PURE__ */ jsx25("box", { style: { width, flexShrink: 0, border: true, borderStyle: "rounded", borderColor: border, paddingLeft: 1, paddingRight: 1 }, children: /* @__PURE__ */ jsx25("text", { fg: border, children: String(message.text || "") }) });
  }
  const tools = Array.isArray(message.tools) ? message.tools : [];
  const rounds = (Array.isArray(message.rounds) ? message.rounds : []).filter(
    (r) => r && (r.text && String(r.text).trim() || r.thinking && String(r.thinking).trim() || Array.isArray(r.tools) && r.tools.length)
  );
  return /* @__PURE__ */ jsxs24("box", { style: { width, flexShrink: 0, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: border, paddingLeft: 1, paddingRight: 1 }, children: [
    compact ? null : /* @__PURE__ */ jsx25("text", { fg: border, attributes: TextAttributes19.BOLD, children: roleStyle.label }),
    message.images ? /* @__PURE__ */ jsx25("text", { fg: "gray", children: `\u{1F4CE} ${message.imageName || `${message.images} image`}` }) : null,
    rounds.length ? rounds.map((round, i) => {
      const tail = live && i === rounds.length - 1;
      const roundTools = Array.isArray(round.tools) ? round.tools : [];
      const proseLive = tail && roundTools.length === 0;
      const thinkLive = proseLive && String(round.thinking || "").trim() !== "" && String(round.text || "").trim() === "";
      return /* @__PURE__ */ jsxs24("box", { style: { flexDirection: "column", width: inner, flexShrink: 0 }, children: [
        round.thinking && String(round.thinking).trim() ? /* @__PURE__ */ jsx25(
          ThinkingBlock,
          {
            text: round.thinking,
            startedAt: round.thinkingT0,
            endedAt: round.thinkingT1,
            live: thinkLive,
            width: inner,
            compact,
            expand: expandThinking,
            label: showLiveLabel
          }
        ) : null,
        round.text && String(round.text).trim() ? /* @__PURE__ */ jsx25(ProseBlock, { text: round.text, live: proseLive, width: inner, compact }) : null,
        roundTools.map((tool, j) => /* @__PURE__ */ jsx25(ToolRow, { tool, width: inner, compact }, `tool-${i}-${j}`))
      ] }, `round-${i}`);
    }) : /* @__PURE__ */ jsxs24(Fragment9, { children: [
      message.thinking ? /* @__PURE__ */ jsx25(
        ThinkingBlock,
        {
          text: message.thinking,
          startedAt: message.thinkingT0,
          endedAt: message.thinkingT1,
          live: live && !tools.length,
          width: inner,
          compact,
          expand: expandThinking,
          label: showLiveLabel
        }
      ) : null,
      message.text ? /* @__PURE__ */ jsx25(ProseBlock, { text: message.text, live: live && !tools.length, width: inner, compact }) : !message.thinking && tools.length === 0 ? (
        // Same duplicate, one row lower: the plain "thinking…" under the
        // live spinner. Only drawn where the spinner row is absent.
        showLiveLabel ? /* @__PURE__ */ jsx25("text", { fg: "gray", children: "thinking\u2026" }) : null
      ) : null,
      tools.map((tool, i) => /* @__PURE__ */ jsx25(ToolRow, { tool, width: inner, compact }, `tool-${i}`))
    ] })
  ] });
}

// src/components/Transcript.jsx
import { jsx as jsx26, jsxs as jsxs25 } from "react/jsx-runtime";
var MAX_TURNS = 80;
var SCROLLBAR_OPTIONS = {
  width: 1,
  showArrows: true,
  arrowOptions: {
    foregroundColor: "#9ca3af",
    arrowChars: { up: "\u25B2", down: "\u25BC" }
  },
  trackOptions: {
    backgroundColor: "#374151",
    foregroundColor: "#22d3ee"
  }
};
function turnWeight(message) {
  const textLen = (v) => String(v == null ? "" : v).length;
  const toolLen = (t) => textLen(t && t.result) + 4;
  let n = textLen(message.text) + textLen(message.thinking);
  for (const t of Array.isArray(message.tools) ? message.tools : []) n += toolLen(t);
  for (const r of Array.isArray(message.rounds) ? message.rounds : []) {
    n += textLen(r && r.text) + textLen(r && r.thinking);
    for (const t of Array.isArray(r && r.tools) ? r.tools : []) n += toolLen(t);
  }
  return n;
}
function Transcript({ messages = [], width, height, emptyHint, scrollRef, live = false, expandThinking = false, liveLabel = true }) {
  const list = Array.isArray(messages) ? messages : [];
  const budget = Math.max(1, Number(height) || 20);
  const boxRef = useRef6(null);
  const [follow, setFollow] = useState11(true);
  const capped = list.slice(-MAX_TURNS);
  const hidden = list.length - capped.length;
  const listSig = `${capped.reduce((n, m) => n + turnWeight(m) + 7, 0)}:${capped.length}:${hidden}`;
  const setBox = (node) => {
    boxRef.current = node;
    if (!scrollRef) return;
    if (typeof scrollRef === "function") scrollRef(node);
    else scrollRef.current = node;
  };
  const pinToTail = () => {
    const box = boxRef.current;
    if (!box) return;
    const view = box.viewport && box.viewport.height ? box.viewport.height : 0;
    if (!view) return;
    const max = Math.max(0, (box.scrollHeight || 0) - view);
    if (max <= 0) return;
    if (box.scrollTop < max) box.scrollTo(max);
  };
  useEffect10(() => {
    if (!follow) return void 0;
    pinToTail();
    const t1 = setTimeout(pinToTail, 0);
    const t2 = setTimeout(pinToTail, 25);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [listSig, budget, follow]);
  useEffect10(() => {
    if (!follow || !live) return void 0;
    const id = setInterval(pinToTail, 100);
    return () => clearInterval(id);
  }, [follow, live]);
  useKeyboard6((key) => {
    const box = boxRef.current;
    if (!box) return;
    const name = key.name;
    if (name !== "pageup" && name !== "pagedown" && name !== "home" && name !== "end") return;
    const view = box.viewport && box.viewport.height ? box.viewport.height : budget;
    const max = Math.max(0, (box.scrollHeight || 0) - view);
    if (name === "pageup") {
      box.scrollTop = Math.max(0, box.scrollTop - Math.max(1, view - 1));
      setFollow(false);
    } else if (name === "pagedown") {
      const next = Math.min(max, box.scrollTop + Math.max(1, view - 1));
      box.scrollTop = next;
      setFollow(next >= max);
    } else if (name === "home") {
      box.scrollTop = 0;
      setFollow(false);
    } else {
      box.scrollTop = max;
      setFollow(true);
    }
  });
  if (list.length === 0) {
    return /* @__PURE__ */ jsx26("box", { style: { width, flexDirection: "column" }, children: /* @__PURE__ */ jsx26("text", { fg: "gray", children: emptyHint || "Ask for something and the agent runs it." }) });
  }
  const contentW = Math.max(8, (Number(width) || 80) - 1);
  const compact = budget < 12 || contentW < 40;
  return /* @__PURE__ */ jsx26("box", { style: { width, height: budget, flexShrink: 0, overflow: "hidden" }, children: /* @__PURE__ */ jsxs25(
    "scrollbox",
    {
      ref: setBox,
      style: {
        width,
        height: budget,
        stickyScroll: true,
        stickyStart: "bottom",
        scrollY: true,
        scrollX: false,
        viewportCulling: true
      },
      scrollbarOptions: SCROLLBAR_OPTIONS,
      children: [
        hidden > 0 ? /* @__PURE__ */ jsx26("text", { fg: "gray", children: `\u2026 ${hidden} earlier turn${hidden === 1 ? "" : "s"} (PgUp)` }) : null,
        /* @__PURE__ */ jsx26("box", { style: { flexDirection: "column", width: contentW }, children: capped.map((message, i) => /* @__PURE__ */ jsx26("box", { style: { marginBottom: compact ? 0 : 1, flexShrink: 0 }, children: /* @__PURE__ */ jsx26(
          MessageBlock,
          {
            message,
            width: contentW,
            compact,
            live: live && i === capped.length - 1 && message.role === "assistant",
            expandThinking,
            showLiveLabel: liveLabel
          }
        ) }, message.id)) })
      ]
    }
  ) });
}

// src/hooks/useAgentStream.js
import { useCallback as useCallback3, useEffect as useEffect11, useRef as useRef7, useState as useState12 } from "react";
var import_ladder = __toESM(require_ladder());
var DEFAULT_API2 = process.env.HAKSTER_API_URL || "http://localhost:3579";
var DEFAULT_TIMEOUT_MS = Math.max(3e4, Number(process.env.HAKSTER_AGENT_TIMEOUT_MS) || 3e5);
var seq = 0;
var nextId = (prefix) => `${prefix}-${++seq}`;
var toolMs = (meta) => meta && meta.t0 ? ` \xB7 ${Math.max(0, Date.now() - meta.t0)}ms` : "";
var fmtTok2 = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  return v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v));
};
var HISTORY_MAX_MESSAGES = 16;
var HISTORY_MAX_CHARS = 24e3;
var HISTORY_MSG_CHARS = 6e3;
function buildHistory(msgs) {
  if (!Array.isArray(msgs) || msgs.length === 0) return [];
  const out = [];
  let chars = 0;
  for (let i = msgs.length - 1; i >= 0 && out.length < HISTORY_MAX_MESSAGES; i -= 1) {
    const m = msgs[i];
    if (!m || m.role !== "user" && m.role !== "assistant") continue;
    const text = String(m.text || "").trim();
    if (!text) continue;
    const clipped = text.length > HISTORY_MSG_CHARS ? `${text.slice(0, HISTORY_MSG_CHARS)}\u2026` : text;
    if (chars + clipped.length > HISTORY_MAX_CHARS) break;
    chars += clipped.length;
    out.push({ role: m.role, content: clipped });
  }
  return out.reverse();
}
function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.filter((t) => t && typeof t === "object").map((t) => ({
    text: String(t.text || "").trim(),
    done: t.status === "done"
  })).filter((t) => t.text);
}
function useAgentStream({
  api = DEFAULT_API2,
  model,
  provider,
  system,
  sessionId,
  cwd,
  approvalMode,
  // Owner's switch (2026-11-23): when a run fails before producing anything,
  // move to the next entry of the ladder (src/models/ladder.js). Off means the
  // run fails where it failed — no silent model change.
  autoHandoff = true
} = {}) {
  const [messages, setMessages] = useState12([]);
  const messagesRef = useRef7([]);
  useEffect11(() => {
    messagesRef.current = messages;
  }, [messages]);
  const [todos, setTodos] = useState12([]);
  const [status, setStatus] = useState12("idle");
  const [error, setError] = useState12(null);
  const [elapsedMs, setElapsedMs] = useState12(0);
  const [activity, setActivity] = useState12([]);
  const [requests, setRequests] = useState12(0);
  const [tokens, setTokens] = useState12({ in: 0, out: 0, reported: false });
  const requestsRef = useRef7(0);
  const pushActivity = useCallback3((kind, text) => {
    const line = { kind: String(kind || "sys"), text: String(text == null ? "" : text), ts: Date.now() };
    setActivity((prev) => prev.length >= 60 ? [...prev.slice(prev.length - 59), line] : [...prev, line]);
  }, []);
  const [pendingConfirm, setPendingConfirm] = useState12(null);
  const pendingConfirmRef = useRef7(null);
  const meterRef = useRef7(null);
  if (!meterRef.current) meterRef.current = createMeter();
  const [meters, setMeters] = useState12(() => meterRef.current.snapshot());
  const toolMetaRef = useRef7(/* @__PURE__ */ new Map());
  const lastToolRef = useRef7(null);
  const syncMeters = useCallback3(() => setMeters(meterRef.current.snapshot()), []);
  const scoreTool = useCallback3((name, args, result) => {
    const text = String(result == null ? "" : result).trim();
    const ok = !/^Error[:\n]|^❌/i.test(text);
    try {
      meterRef.current.tool(name || "tool", args || {}, ok, text);
      syncMeters();
    } catch {
    }
    return ok;
  }, [syncMeters]);
  const setPending = useCallback3((value) => {
    pendingConfirmRef.current = value;
    setPendingConfirm(value);
  }, []);
  const abortRef = useRef7(null);
  const userAbortRef = useRef7(false);
  const attemptCtxRef = useRef7({ produced: false, sawError: null, status: null });
  const startedAtRef = useRef7(null);
  const statusRef = useRef7("idle");
  const activeRunIdRef = useRef7(null);
  const setStatusBoth = useCallback3((next) => {
    statusRef.current = next;
    setStatus(next);
  }, []);
  useEffect11(() => {
    const ticking = status === "thinking" || status === "streaming" || status === "approval";
    if (!ticking) return void 0;
    const id = setInterval(() => {
      if (startedAtRef.current) setElapsedMs(Date.now() - startedAtRef.current);
    }, 250);
    return () => clearInterval(id);
  }, [status]);
  const patch = useCallback3((id, fn) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx === -1) return prev;
      const next = prev.slice();
      next[idx] = fn(next[idx]) || next[idx];
      return next;
    });
  }, []);
  const append = useCallback3((entry) => {
    setMessages((prev) => [...prev, entry]);
  }, []);
  const withRound = useCallback3((m, opensNew, mutate) => {
    const rounds = Array.isArray(m.rounds) ? m.rounds.map((r) => ({ ...r, tools: Array.isArray(r.tools) ? r.tools.slice() : [] })) : [];
    let cur = rounds[rounds.length - 1];
    if (!cur || opensNew(cur)) {
      cur = { text: "", thinking: "", tools: [] };
      rounds.push(cur);
    }
    mutate(cur);
    return { ...m, rounds };
  }, []);
  const drop = useCallback3((id) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);
  const withToolResult = useCallback3((m, id, result, mcp = false) => {
    const pick = (list) => {
      let idx2 = id ? list.findIndex((t) => t.id === id) : -1;
      if (idx2 === -1) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].result === null && (mcp ? list[i].mcp : true)) {
            idx2 = i;
            break;
          }
        }
      }
      return idx2;
    };
    const settled = (entry) => ({
      ...entry,
      result,
      ms: Math.max(0, Date.now() - (Number(entry.t0) || Date.now())),
      ...mcp ? { mcp: true } : {}
    });
    const tools = m.tools.slice();
    const idx = pick(tools);
    if (idx !== -1) tools[idx] = settled(tools[idx]);
    const rounds = Array.isArray(m.rounds) ? m.rounds.map((r) => {
      const rt = Array.isArray(r.tools) ? r.tools.slice() : [];
      const at = pick(rt);
      if (at !== -1) rt[at] = settled(rt[at]);
      return { ...r, tools: rt };
    }) : m.rounds;
    return { ...m, tools, rounds };
  }, []);
  const abort = useCallback3(() => {
    userAbortRef.current = true;
    if (pendingConfirmRef.current) {
      const pending = pendingConfirmRef.current;
      setPending(null);
      fetch(`${api}/api/agent/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...process.env.HAKSTER_API_KEY ? { "x-api-key": process.env.HAKSTER_API_KEY } : {} },
        body: JSON.stringify({
          sessionId: sessionId || "default",
          toolCallId: pending.toolCallId,
          approved: false,
          command: pending.command || "",
          permanent: false
        })
      }).catch(() => {
      });
    }
    if (abortRef.current) {
      try {
        abortRef.current.abort();
      } catch {
      }
      abortRef.current = null;
    }
    setStatusBoth("idle");
    setElapsedMs(startedAtRef.current ? Date.now() - startedAtRef.current : 0);
  }, [api, sessionId, setPending, setStatusBoth]);
  const answerConfirm = useCallback3(
    async (approved, { permanent = false } = {}) => {
      const pending = pendingConfirmRef.current;
      if (!pending) return false;
      const cmd = pending.command || "";
      setPending(null);
      setStatusBoth("streaming");
      try {
        const res = await fetch(`${api}/api/agent/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...process.env.HAKSTER_API_KEY ? { "x-api-key": process.env.HAKSTER_API_KEY } : {} },
          body: JSON.stringify({
            sessionId: sessionId || "default",
            toolCallId: pending.toolCallId,
            approved: !!approved,
            command: cmd,
            permanent: !!permanent
          })
        });
        if (!res.ok) throw new Error(`confirm failed (${res.status})`);
        append({
          id: nextId("sys"),
          role: "system",
          tone: approved ? "notice" : "warn",
          text: `${approved ? "approved" : "denied"}${cmd ? `: ${cmd}` : ""}${approved && permanent ? " \u2014 allowed from now on" : ""}`
        });
        return true;
      } catch (e) {
        const msg = e && e.message || "could not report the decision";
        append({ id: nextId("sys"), role: "system", tone: "error", text: msg });
        setError(msg);
        return false;
      }
    },
    [api, append, sessionId, setPending, setStatusBoth]
  );
  const runTurn = useCallback3(
    async (text, opts = {}) => {
      const prompt = String(text == null ? "" : text).trim();
      if (!prompt || statusRef.current === "connecting" || statusRef.current === "streaming") {
        return;
      }
      const images = Array.isArray(opts && opts.images) ? opts.images.filter((url) => typeof url === "string" && url.startsWith("data:image/")) : [];
      append({
        id: nextId("user"),
        role: "user",
        text: prompt,
        images: images.length,
        imageName: opts && opts.imageName || ""
      });
      const assistantId = nextId("ai");
      append({
        id: assistantId,
        role: "assistant",
        text: "",
        thinking: "",
        phase: null,
        tools: [],
        model: model || null
      });
      setError(null);
      setStatusBoth("connecting");
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      try {
        meterRef.current.resetTask();
        syncMeters();
      } catch {
      }
      toolMetaRef.current.clear();
      const attempts = (0, import_ladder.attemptsFor)(model, provider);
      if (attempts.length && provider && attempts[0].provider !== provider) {
        attempts[0] = { ...attempts[0], provider };
      }
      const terminalStatus = (status2) => status2 === 400 || status2 === 401 || status2 === 402 || status2 === 403 || status2 === 413 || status2 === 415 || status2 === 422;
      userAbortRef.current = false;
      const applyEvent = (evt) => {
        if (!evt || typeof evt !== "object") return;
        switch (evt.type) {
          case "delta":
            setStatusBoth("streaming");
            attemptCtxRef.current.produced = true;
            patch(assistantId, (m) => withRound(
              { ...m, text: m.text + (evt.content || "") },
              (r) => r.tools.length > 0,
              // Prose starting ends the reasoning clock: the transcript folds a
              // finished thought to "Thought for 12s" (see MessageBlock).
              (r) => {
                if (r.thinkingT0 && !r.thinkingT1) r.thinkingT1 = Date.now();
                r.text += evt.content || "";
              }
            ));
            break;
          case "thinking_start": {
            setStatusBoth("thinking");
            const thinkAt = Date.now();
            patch(assistantId, (m) => withRound(
              { ...m, thinking: "" },
              (r) => r.tools.length > 0 || String(r.text || "").trim() !== "",
              (r) => {
                r.thinkingT0 = thinkAt;
                r.thinkingT1 = void 0;
              }
            ));
            break;
          }
          case "thinking":
            setStatusBoth("thinking");
            attemptCtxRef.current.produced = true;
            patch(assistantId, (m) => withRound(
              { ...m, thinking: m.thinking + (evt.content || "") },
              (r) => r.tools.length > 0,
              (r) => {
                if (!r.thinkingT0) r.thinkingT0 = Date.now();
                r.thinking += evt.content || "";
              }
            ));
            break;
          case "thinking_end":
            patch(assistantId, (m) => {
              const rounds = Array.isArray(m.rounds) ? m.rounds.map((r) => ({ ...r })) : [];
              const cur = rounds[rounds.length - 1];
              if (cur && cur.thinkingT0 && !cur.thinkingT1) cur.thinkingT1 = Date.now();
              return { ...m, rounds };
            });
            break;
          case "phase":
            if (evt.phase) {
              patch(assistantId, (m) => ({ ...m, phase: evt.phase }));
              pushActivity("phase", evt.phase);
            }
            break;
          case "tool_call_start": {
            const name = evt.tool_name || "unknown";
            lastToolRef.current = { name, args: evt.tool_args || {}, t0: Date.now() };
            if (evt.tool_call_id) toolMetaRef.current.set(evt.tool_call_id, lastToolRef.current);
            pushActivity("start", name);
            if (name === "update_todo" || name === "plan") {
              const raw = evt.tool_args && (evt.tool_args.todos || evt.tool_args.steps) || null;
              const next = name === "plan" ? normalizeTodos((raw || []).map((s) => ({ text: s, status: "pending" }))) : normalizeTodos(raw);
              if (next) setTodos(next);
            }
            patch(assistantId, (m) => {
              const call = {
                id: evt.tool_call_id || nextId("tool"),
                name,
                args: evt.tool_args || {},
                result: null,
                mcp: name.startsWith("mcp__"),
                // Start of the call, for the live duration on its card.
                t0: Date.now()
              };
              return withRound(
                { ...m, tools: [...m.tools, call] },
                () => false,
                // a call joins the round the prose before it opened
                (r) => {
                  if (r.thinkingT0 && !r.thinkingT1) r.thinkingT1 = Date.now();
                  r.tools.push(call);
                }
              );
            });
            break;
          }
          case "mcp_result": {
            const result = String(evt.data == null ? "" : evt.data);
            const meta = evt.tool_call_id && toolMetaRef.current.get(evt.tool_call_id) || lastToolRef.current;
            if (meta) {
              const ok = scoreTool(meta.name, meta.args, result);
              pushActivity(ok ? "mcp" : "err", `${meta.name}${toolMs(meta)}`);
            }
            patch(assistantId, (m) => withToolResult(m, evt.tool_call_id, result, true));
            break;
          }
          case "tool_call_result":
          case "tool_result": {
            const result = String(
              evt.tool_result != null ? evt.tool_result : evt.result != null ? evt.result : ""
            );
            const meta = evt.tool_call_id && toolMetaRef.current.get(evt.tool_call_id) || lastToolRef.current;
            if (meta) {
              const ok = scoreTool(meta.name, meta.args, result);
              pushActivity(ok ? "ok" : "err", `${meta.name}${toolMs(meta)}`);
            }
            patch(assistantId, (m) => withToolResult(m, evt.tool_call_id, result));
            break;
          }
          case "needs_confirmation": {
            setStatusBoth("approval");
            pushActivity("confirm", `${evt.tool_name || "tool"} needs approval`);
            setPending({
              toolCallId: evt.tool_call_id || null,
              toolName: evt.tool_name || "tool",
              reason: evt.reason || "Approval needed",
              command: evt.command || ""
            });
            break;
          }
          case "steer": {
            const text2 = String(evt.content || "").trim();
            if (text2) {
              append({ id: nextId("user"), role: "user", text: text2 });
              pushActivity("sys", "\u21B3 live steer applied");
            }
            break;
          }
          case "loop_detected":
            try {
              meterRef.current.bump(-10);
              syncMeters();
            } catch {
            }
            pushActivity("err", "loop detected");
            append({ id: nextId("sys"), role: "system", tone: "warn", text: evt.message || "loop detected" });
            break;
          case "auto_nudge":
            append({
              id: nextId("sys"),
              role: "system",
              tone: "notice",
              text: evt.message || "nudging the model to use tools\u2026"
            });
            break;
          case "max_turns":
            append({
              id: nextId("sys"),
              role: "system",
              tone: "warn",
              text: `stopped at the turn limit (${evt.maxTurns ?? "?"} turns)`
            });
            break;
          case "file_created":
          case "file_changed":
          case "artifact":
            append({
              id: nextId("sys"),
              role: "system",
              tone: "notice",
              text: `${evt.type.replace("_", " ")}: ${evt.path || evt.file || evt.name || ""}`.trim()
            });
            break;
          case "aborted":
            append({ id: nextId("sys"), role: "system", tone: "warn", text: "run aborted" });
            break;
          case "error":
            attemptCtxRef.current.sawError = evt.error || "agent error";
            pushActivity("err", evt.error || "agent error");
            setStatusBoth("error");
            break;
          case "done": {
            const inTok = Number(evt.inputTokens);
            const outTok = Number(evt.outputTokens);
            if (Number.isFinite(inTok) || Number.isFinite(outTok)) {
              setTokens((t) => ({
                in: t.in + (Number.isFinite(inTok) ? inTok : 0),
                out: t.out + (Number.isFinite(outTok) ? outTok : 0),
                reported: true
              }));
              pushActivity("done", `turn done \xB7 ${fmtTok2(inTok)} in / ${fmtTok2(outTok)} out`);
            } else {
              pushActivity("done", "turn done");
            }
            patch(assistantId, (m) => ({
              ...m,
              model: evt.model || m.model,
              tokens: evt.inputTokens != null || evt.outputTokens != null ? { in: evt.inputTokens, out: evt.outputTokens } : m.tokens
            }));
            break;
          }
          default:
            break;
        }
      };
      const runAttempt = async (target) => {
        requestsRef.current += 1;
        setRequests(requestsRef.current);
        pushActivity("sys", `\u2192 ${target.label || target.provider || "auto"}`);
        const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        activeRunIdRef.current = runId;
        const controller = new AbortController();
        abortRef.current = controller;
        const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        const ctx = { produced: false, sawError: null, status: null };
        attemptCtxRef.current = ctx;
        try {
          const res = await fetch(`${api}/api/agent/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...process.env.HAKSTER_API_KEY ? { "x-api-key": process.env.HAKSTER_API_KEY } : {} },
            signal: controller.signal,
            body: JSON.stringify({
              messages: [
                ...system ? [{ role: "system", content: system }] : [],
                // The conversation so far, so this turn continues the task
                // instead of starting a fresh one (see buildHistory above).
                ...buildHistory(messagesRef.current),
                {
                  role: "user",
                  content: images.length ? [{ type: "text", text: prompt }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] : prompt
                }
              ],
              stream: true,
              runId,
              // Tier 3 sends neither, so the server's own waterfall decides —
              // that is what "others last" means here.
              ...target.provider ? { provider: target.provider } : {},
              ...target.model ? { model: target.model } : {},
              ...cwd ? { cwd } : {},
              ...sessionId ? { sessionId } : {},
              ...approvalMode ? { approvalMode } : {},
              // An autonomous run is allowed the server's full round budget so a
              // long job is finished in one go rather than stopping at a cap.
              ...approvalMode === "full-auto" || approvalMode === "auto-edit" ? { maxTurns: 120 } : {}
            })
          });
          ctx.status = res.status;
          if (!res.ok) {
            throw new Error(
              res.status === 413 ? "the server refused the body (413) \u2014 image too large" : `server replied ${res.status}`
            );
          }
          if (!res.body) throw new Error("server sent no stream");
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (; ; ) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, idx).replace(/\r$/, "");
              buffer = buffer.slice(idx + 1);
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try {
                applyEvent(JSON.parse(payload));
              } catch {
              }
            }
          }
          if (ctx.sawError) return { ok: false, aborted: false, ...ctx, error: ctx.sawError };
          if (statusRef.current !== "error") setStatusBoth("idle");
          return { ok: true, aborted: false, ...ctx, error: null };
        } catch (e) {
          if (e && e.name === "AbortError") {
            return {
              ok: false,
              aborted: true,
              ...ctx,
              error: userAbortRef.current ? "run cancelled" : "timed out"
            };
          }
          return { ok: false, aborted: false, ...ctx, error: e && e.message || "request failed" };
        } finally {
          clearTimeout(timeout);
        }
      };
      let spoke = false;
      for (let i = 0; i < attempts.length; i++) {
        const target = attempts[i];
        const res = await runAttempt(target);
        spoke = spoke || !!res.produced;
        if (res.ok) break;
        if (res.aborted && userAbortRef.current) {
          append({ id: nextId("sys"), role: "system", tone: "warn", text: "run cancelled" });
          setStatusBoth("idle");
          break;
        }
        const next = attempts[i + 1];
        const canHandoff = autoHandoff && !!next && !res.produced && !res.aborted && !terminalStatus(res.status);
        if (!canHandoff) {
          const msg = res.error || "request failed";
          setError(msg);
          setStatusBoth("error");
          if (!spoke) drop(assistantId);
          append({ id: nextId("sys"), role: "system", tone: "error", text: msg });
          break;
        }
        append({
          id: nextId("sys"),
          role: "system",
          tone: "warn",
          text: `handoff ${target.label} \u2192 ${next.label}: ${res.error}`
        });
        pushActivity("handoff", `${target.label} \u2192 ${next.label}`);
        patch(assistantId, (m) => ({
          ...m,
          text: "",
          thinking: "",
          tools: [],
          phase: null,
          model: next.model || next.provider || "auto"
        }));
        toolMetaRef.current.clear();
        setError(null);
        setStatusBoth("connecting");
      }
      abortRef.current = null;
      activeRunIdRef.current = null;
      setPending(null);
      setElapsedMs(startedAtRef.current ? Date.now() - startedAtRef.current : 0);
    },
    [api, append, approvalMode, autoHandoff, cwd, drop, model, patch, provider, pushActivity, sessionId, setPending, setStatusBoth, system]
  );
  const send = useCallback3((text, opts = {}) => {
    const prompt = String(text == null ? "" : text).trim();
    if (!prompt || statusRef.current === "connecting" || statusRef.current === "streaming") return false;
    runTurn(text, opts);
    return true;
  }, [runTurn]);
  const steer = useCallback3(async (text) => {
    const prompt = String(text == null ? "" : text).trim();
    const runId = activeRunIdRef.current;
    if (!prompt || !runId) return false;
    try {
      const res = await fetch(`${api}/api/agent/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...process.env.HAKSTER_API_KEY ? { "x-api-key": process.env.HAKSTER_API_KEY } : {} },
        body: JSON.stringify({ runId, text: prompt })
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => ({}));
      return data && data.ok === true;
    } catch {
      return false;
    }
  }, [api]);
  const clear = useCallback3(() => {
    abort();
    setPending(null);
    setMessages([]);
    setTodos([]);
    setError(null);
    setElapsedMs(0);
    setActivity([]);
    setRequests(0);
    setTokens({ in: 0, out: 0, reported: false });
    requestsRef.current = 0;
    startedAtRef.current = null;
  }, [abort, setPending]);
  const busy = status === "connecting" || status === "streaming" || status === "thinking" || status === "approval";
  return {
    messages,
    todos,
    status,
    error,
    elapsedMs,
    busy,
    meters,
    activity,
    requests,
    tokens,
    pendingConfirm,
    answerConfirm,
    send,
    steer,
    abort,
    clear
  };
}
var useAgentStream_default = useAgentStream;

// src/hooks/useHostStats.js
import { useEffect as useEffect12, useRef as useRef8, useState as useState13 } from "react";
import os4 from "node:os";
import fs7 from "node:fs";
var readText = (p) => {
  try {
    return fs7.readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
function cpuTimes() {
  const line = (readText("/proc/stat").split("\n")[0] || "").trim();
  if (!line.startsWith("cpu")) return null;
  const n = line.split(/\s+/).slice(1).map(Number);
  if (!n.length || n.some((x) => !Number.isFinite(x))) return null;
  const idle = (n[3] || 0) + (n[4] || 0);
  const total = n.reduce((a, b) => a + b, 0);
  return { idle, total };
}
function meminfo() {
  const out = {};
  for (const line of readText("/proc/meminfo").split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}
function disk() {
  try {
    const s = fs7.statfsSync("/");
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    if (!Number.isFinite(total) || total <= 0) return null;
    return { total, free, pct: Math.round((1 - free / total) * 100) };
  } catch {
    return null;
  }
}
function useHostStats(intervalMs = 5e3) {
  const [stats, setStats] = useState13(null);
  const prevRef = useRef8(null);
  useEffect12(() => {
    const cores = Math.max(1, (os4.cpus() || []).length);
    const sample = () => {
      const now = cpuTimes();
      let cpuPct = null;
      const prev = prevRef.current;
      if (now && prev && now.total > prev.total) {
        const dt = now.total - prev.total;
        const idleDelta = now.idle - prev.idle;
        cpuPct = Math.max(0, Math.min(100, Math.round((1 - idleDelta / dt) * 100)));
      }
      if (now) prevRef.current = now;
      const mi = meminfo();
      const memTotal = mi.MemTotal || os4.totalmem();
      const memAvail = mi.MemAvailable != null ? mi.MemAvailable : os4.freemem();
      const swapTotal = mi.SwapTotal || 0;
      const swapFree = mi.SwapFree || 0;
      const d = disk();
      setStats({
        cores,
        cpuPct,
        load1: Math.round(((os4.loadavg() || [0])[0] || 0) * 100) / 100,
        memPct: memTotal ? Math.max(0, Math.min(100, Math.round((1 - memAvail / memTotal) * 100))) : null,
        memUsedGb: memTotal ? (memTotal - memAvail) / 1e9 : null,
        memTotalGb: memTotal ? memTotal / 1e9 : null,
        swapPct: swapTotal ? Math.max(0, Math.min(100, Math.round((1 - swapFree / swapTotal) * 100))) : null,
        swapUsedMb: swapTotal ? Math.round((swapTotal - swapFree) / 1e6) : null,
        swapTotalMb: swapTotal ? Math.round(swapTotal / 1e6) : null,
        diskPct: d ? d.pct : null,
        diskFreeGb: d ? d.free / 1e9 : null,
        diskTotalGb: d ? d.total / 1e9 : null,
        uptimeS: Math.round(os4.uptime())
      });
    };
    sample();
    const warm = setTimeout(sample, 800);
    const t = setInterval(sample, intervalMs);
    return () => {
      clearTimeout(warm);
      clearInterval(t);
    };
  }, [intervalMs]);
  return stats;
}

// src/hooks/useMemoryBank.js
import { useEffect as useEffect13, useState as useState14 } from "react";
import fs8 from "node:fs";
import os5 from "node:os";
import path6 from "node:path";
var BANK_DIR = path6.join(os5.homedir(), ".hakster", "memories", "banks");
function readMemoryBanks(dir = BANK_DIR) {
  let files;
  try {
    files = fs8.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  const banks = [];
  const tagCounts = /* @__PURE__ */ new Map();
  let total = 0;
  let newest = null;
  for (const file of files) {
    let entries;
    try {
      entries = JSON.parse(fs8.readFileSync(path6.join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    let last = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      for (const tag of Array.isArray(entry.tags) ? entry.tags : []) {
        const key = String(tag).trim().toLowerCase();
        if (!key) continue;
        tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
      }
      const ts = Date.parse(entry.bankedAt || entry.timestamp || "") || 0;
      if (ts > last) last = ts;
    }
    const slug = file.replace(/\.json$/, "");
    banks.push({ slug, entries: entries.length, last });
    total += entries.length;
    if (last && (!newest || last > newest.last)) newest = { slug, last };
  }
  banks.sort((a, b) => b.entries - a.entries || a.slug.localeCompare(b.slug));
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return { banks, total, clusters: tagCounts.size, topTags, newest, sampledAt: Date.now() };
}
function useMemoryBank(intervalMs = 1e4) {
  const [state, setState] = useState14(() => readMemoryBanks());
  useEffect13(() => {
    const tick = () => setState((prev) => readMemoryBanks() || prev);
    const id = setInterval(tick, intervalMs);
    try {
      if (typeof id.unref === "function") id.unref();
    } catch {
    }
    return () => clearInterval(id);
  }, [intervalMs]);
  return state;
}

// src/hooks/useCliUpdate.js
var import_updater = __toESM(require_updater());
var import_prefs2 = __toESM(require_prefs());
import { useEffect as useEffect14, useRef as useRef9, useState as useState15 } from "react";
function readStartup() {
  try {
    const applied = (0, import_updater.appliedNotice)();
    const pending = (0, import_updater.pendingInfo)();
    if (applied) {
      return { applied, status: { status: "applied", version: applied.version, from: applied.from, checkedAt: applied.appliedAt } };
    }
    if (pending && pending.version) {
      if (pending.isCurrent) {
        return { applied: null, status: { status: "current", version: pending.version, checkedAt: pending.stagedAt } };
      }
      return {
        applied: null,
        status: {
          status: pending.blocked ? "blocked" : "staged",
          version: pending.version,
          blocked: pending.blocked || void 0,
          checkedAt: pending.stagedAt
        }
      };
    }
  } catch {
  }
  return { applied: null, status: { status: "idle" } };
}
function useCliUpdate(intervalMs = 30 * 60 * 1e3) {
  const startup = useRef9(null);
  if (startup.current === null) startup.current = readStartup();
  const applied = startup.current.applied;
  const [state, setState] = useState15(startup.current.status);
  useEffect14(() => {
    let alive = true;
    const tick = async () => {
      if (import_prefs2.default.load().updateCheck === false) return;
      setState(
        (prev) => prev.status === "staged" || prev.status === "blocked" || prev.status === "applied" ? prev : { ...prev, status: "checking" }
      );
      try {
        const res = await (0, import_updater.checkForUpdate)();
        if (!alive) return;
        setState((prev) => {
          if (applied) return prev;
          return {
            status: res.status,
            version: res.version,
            blocked: res.blocked || (res.status === "blocked" ? "source-checkout" : void 0),
            reason: res.reason,
            checkedAt: res.checkedAt
          };
        });
      } catch (e) {
        if (alive) setState({ status: "error", reason: String(e && e.message || e) });
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    try {
      if (typeof id.unref === "function") id.unref();
    } catch {
    }
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs, applied]);
  return { ...state, applied };
}

// src/hooks/useScriptRunner.js
import { useCallback as useCallback4, useEffect as useEffect15, useRef as useRef10, useState as useState16 } from "react";
import { spawn } from "node:child_process";
var MAX_LINES = 400;
var TIMEOUT_MS = 12e4;
function useScriptRunner() {
  const [scripts] = useState16(() => {
    try {
      return discoverScripts();
    } catch {
      return [];
    }
  });
  const [run, setRun] = useState16({ status: "idle", script: null, lines: [], startedAt: 0, endedAt: 0, exit: null });
  const procRef = useRef10(null);
  const timerRef = useRef10(null);
  const seq2 = useRef10(0);
  const stop = useCallback4(() => {
    const p = procRef.current;
    if (p) {
      procRef.current = null;
      try {
        p.kill("SIGTERM");
      } catch {
      }
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setRun((r) => r.status === "running" ? { ...r, status: "stopped", endedAt: Date.now() } : r);
  }, []);
  useEffect15(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const p = procRef.current;
    if (p) {
      try {
        p.kill("SIGTERM");
      } catch {
      }
    }
  }, []);
  const start2 = useCallback4((entry) => {
    if (!entry || !Array.isArray(entry.run) || !entry.run.length) return false;
    stop();
    const id = ++seq2.current;
    const startedAt = Date.now();
    snapshotBeforeRun(entry);
    setRun({ status: "running", script: entry, lines: [], startedAt, endedAt: 0, exit: null });
    let child;
    try {
      child = spawn(entry.run[0], entry.run.slice(1), { cwd: entry.cwd, env: process.env });
    } catch (e) {
      setRun({ status: "failed", script: entry, lines: [`spawn failed: ${e && e.message || e}`], startedAt, endedAt: Date.now(), exit: null });
      return true;
    }
    procRef.current = child;
    const push = (text) => {
      if (seq2.current !== id) return;
      const lines = String(text).replace(/\r/g, "").split("\n").filter((l, i, a) => l !== "" || i < a.length - 1);
      setRun((r) => r.status === "running" || r.status === "stopped" ? { ...r, lines: [...r.lines, ...lines].slice(-MAX_LINES) } : r);
    };
    child.stdout?.on("data", (b) => push(b.toString()));
    child.stderr?.on("data", (b) => push(b.toString()));
    timerRef.current = setTimeout(() => {
      if (seq2.current !== id) return;
      try {
        child.kill("SIGTERM");
      } catch {
      }
      push(`\u23F1 stopped after ${Math.round(TIMEOUT_MS / 1e3)}s (the runner's cap)`);
    }, TIMEOUT_MS);
    child.on("error", (e) => {
      if (seq2.current !== id) return;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      procRef.current = null;
      setRun((r) => ({ ...r, status: "failed", endedAt: Date.now(), lines: [...r.lines, `error: ${e && e.message || e}`].slice(-MAX_LINES) }));
    });
    child.on("close", (code) => {
      if (seq2.current !== id) return;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      procRef.current = null;
      setRun((r) => ({
        ...r,
        status: code === 0 ? "done" : "failed",
        exit: code,
        endedAt: Date.now(),
        lines: [...r.lines, `\u2014 exit ${code == null ? "?" : code} \u2014`].slice(-MAX_LINES)
      }));
    });
    return true;
  }, [stop]);
  return { scripts, run, start: start2, stop };
}
var useScriptRunner_default = useScriptRunner;

// src/App.jsx
var import_prefs3 = __toESM(require_prefs());
var import_input_history = __toESM(require_input_history());
var import_ladder2 = __toESM(require_ladder());
var import_catalog = __toESM(require_catalog());
var import_kitty_graphics3 = __toESM(require_kitty_graphics());
var import_ad_client2 = __toESM(require_ad_client());
import { Fragment as Fragment10, jsx as jsx27, jsxs as jsxs26 } from "react/jsx-runtime";
var API = process.env.HAKSTER_API_URL || "http://localhost:3579";
var MCP_OUTPUT_LINES = 6;
var PAGE_SCROLLBAR = {
  width: 1,
  showArrows: true,
  arrowOptions: {
    foregroundColor: "#9ca3af",
    arrowChars: { up: "\u25B2", down: "\u25BC" }
  },
  trackOptions: {
    backgroundColor: "#374151",
    foregroundColor: "#22d3ee"
  }
};
var SYSTEM = process.env.HAKSTER_TUI_SYSTEM || "You are haksterAi running inside a terminal dashboard. Answer briefly and use tools when they are needed.";
var IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp"
};
var MAX_IMAGE_BYTES = 12 * 1024 * 1024;
var AUTO_MODES = /* @__PURE__ */ new Set(["suggest", "auto-edit", "full-auto"]);
function readPrefs() {
  try {
    return import_prefs3.default.load();
  } catch {
    return {};
  }
}
function writePrefs(patch) {
  try {
    return import_prefs3.default.save(patch);
  } catch {
    return null;
  }
}
var CRUSH_CONFIG_PATHS = [
  path7.join(process.env.HOME || "/home/ghost", ".crush.json"),
  path7.join(process.env.HOME || "/home/ghost", ".config", "crush", "crush.json")
];
function readCrushModels() {
  for (const p of CRUSH_CONFIG_PATHS) {
    try {
      const j = JSON.parse(fs9.readFileSync(p, "utf8"));
      const out = [];
      for (const [slot, m] of Object.entries(j.models || {})) {
        if (m && m.model) out.push({ slot, model: m.model, provider: m.provider || "ollama" });
      }
      if (out.length) return out;
    } catch {
    }
  }
  return [];
}
var clipLine2 = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}\u2026`;
};
var toolArgLine = (args) => {
  if (!args || typeof args !== "object") return "";
  const raw = args.command || args.path || args.file || args.query || args.url || args.pattern || "";
  const s = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return s ? ` ${s}` : "";
};
function readImageAttachment(file) {
  const raw = String(file || "").trim();
  if (!raw) throw new Error("no file given");
  const abs = path7.resolve(raw.replace(/^~(?=\/)/, process.env.HOME || ""));
  const mime = IMAGE_MIME[path7.extname(abs).toLowerCase()];
  if (!mime) throw new Error("not an image (png, jpg, webp, gif, bmp)");
  const st = fs9.statSync(abs);
  if (!st.isFile()) throw new Error("not a file");
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(`too large (${Math.round(st.size / 1024 / 1024)}MB, max 12MB)`);
  }
  const buf = fs9.readFileSync(abs);
  return {
    path: abs,
    name: path7.basename(abs),
    bytes: buf.length,
    dataUrl: `data:${mime};base64,${buf.toString("base64")}`
  };
}
function App({ version = "0.1.0" }) {
  const renderer2 = useRenderer3();
  const { width: cols, height: rows } = useTerminalDimensions();
  const [view, setView] = useState17("chat");
  const [focus, setFocus] = useState17("composer");
  const [adsOn, setAdsOn] = useState17(() => readPrefs().ads !== false);
  const [dockExpanded, setDockExpanded] = useState17(false);
  const [draft, setDraft] = useState17("");
  const [inputHistory, setInputHistory] = useState17(() => (0, import_input_history.loadInputHistory)());
  const [histIdx, setHistIdx] = useState17(-1);
  const draftStash = useRef11("");
  const [model, setModel] = useState17(() => process.env.HAKSTER_MODEL && !/^glm/i.test(process.env.HAKSTER_MODEL) ? process.env.HAKSTER_MODEL : readPrefs().model || import_ladder2.PRIMARY_MODEL);
  const [provider, setProvider] = useState17(process.env.HAKSTER_PROVIDER || "");
  const [modelIdx, setModelIdx] = useState17(0);
  const prefsRef = useRef11(null);
  if (!prefsRef.current) prefsRef.current = readPrefs();
  const [handoffOn, setHandoffOn] = useState17(() => prefsRef.current.autoHandoff !== false);
  const [autoMode, setAutoMode] = useState17(() => {
    const saved = String(prefsRef.current.autoMode || "");
    return AUTO_MODES.has(saved) ? saved : "auto-edit";
  });
  const [expandThinking, setExpandThinking] = useState17(() => prefsRef.current.thinkingExpanded === true);
  const [usageRefresh, setUsageRefresh] = useState17(() => {
    const n = Number(prefsRef.current.usageRefresh);
    return Number.isFinite(n) && n >= 0 ? n : 15;
  });
  const [introDone, setIntroDone] = useState17(() => process.env.HAKSTER_NO_INTRO === "1" || readPrefs().intro === false);
  const [status, setStatus] = useState17(null);
  const [statusErr, setStatusErr] = useState17(null);
  const [mcp, setMcp] = useState17(null);
  const [history, setHistory] = useState17([]);
  const [menuOpen, setMenuOpen] = useState17(false);
  const [scriptIdx, setScriptIdx] = useState17(0);
  const [squadIdx, setSquadIdx] = useState17(0);
  const [menuIndex, setMenuIndex] = useState17(0);
  const [menuQuery, setMenuQuery] = useState17("");
  const [settingsIdx, setSettingsIdx] = useState17(0);
  const [mcpIdx, setMcpIdx] = useState17(0);
  const [prefsTick, setPrefsTick] = useState17(0);
  const [notice, setNotice] = useState17(null);
  const [scan, setScan] = useState17({ ok: false, ports: [], procs: {}, at: 0 });
  const [guard, setGuard] = useState17(null);
  const [pointsHistory, setPointsHistory] = useState17([]);
  const [attachment, setAttachment] = useState17(null);
  const [steerQueue, setSteerQueue] = useState17([]);
  const scrollRef = useRef11(null);
  const dashRef = useRef11(null);
  const usageRef = useRef11(null);
  const agent = useAgentStream_default({
    api: API,
    model,
    provider,
    system: SYSTEM,
    cwd: process.env.HAKSTER_AGENT_CWD || null,
    autoHandoff: handoffOn,
    // Autonomy: the server turns this into its autonomous directive + the
    // "you replied with text only, act" nudge, so a run drives to the end.
    approvalMode: autoMode === "suggest" ? void 0 : autoMode
  });
  const usagePage = useServerUsage(usageRefresh, view === "usage");
  useEffect16(() => {
    writePrefs({ autoHandoff: handoffOn });
  }, [handoffOn]);
  useEffect16(() => {
    writePrefs({ autoMode });
  }, [autoMode]);
  const load = useCallback5(async () => {
    try {
      const r = await fetch(`${API}/api/tui/status`, { signal: AbortSignal.timeout(4e3), headers: { ...process.env.HAKSTER_API_KEY ? { "x-api-key": process.env.HAKSTER_API_KEY } : {} } });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const j = await r.json();
      setStatus(j);
      setStatusErr(null);
      setHistory((h) => [...h.slice(-59), Number(j.tokens || j.messages || 0)]);
    } catch (e) {
      setStatusErr(e.message);
    }
  }, []);
  useEffect16(() => {
    load();
    const t = setInterval(load, 3e3);
    return () => clearInterval(t);
  }, [load]);
  const mcpRefreshRef = useRef11(null);
  useEffect16(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${API}/api/agent/mcp-status`, {
          signal: AbortSignal.timeout(5e3),
          headers: { ...process.env.HAKSTER_API_KEY ? { "x-api-key": process.env.HAKSTER_API_KEY } : {} }
        });
        if (!r.ok) return;
        const j = await r.json();
        if (alive && j && Array.isArray(j.servers)) setMcp(j);
      } catch {
      }
    };
    mcpRefreshRef.current = tick;
    tick();
    const t = setInterval(tick, 3e4);
    return () => {
      alive = false;
      mcpRefreshRef.current = null;
      clearInterval(t);
    };
  }, []);
  useEffect16(() => {
    let alive = true;
    const tick = async () => {
      const next = await scanPorts();
      if (alive) setScan(next);
    };
    tick();
    const t = setInterval(tick, 3e4);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  useEffect16(() => {
    const tick = () => {
      try {
        setGuard(fileGuard());
      } catch {
      }
    };
    tick();
    const t = setInterval(tick, 1e4);
    return () => clearInterval(t);
  }, []);
  const meterPoints = Number(agent.meters && agent.meters.points) || 0;
  useEffect16(() => {
    setPointsHistory((h) => [...h.slice(-59), meterPoints]);
  }, [meterPoints]);
  const models = import_catalog.default.REFERENCE_CATALOG || [];
  const pickerModels = [
    { key: "__claude", vendor: "Claude", value: `Claude Code \xB7 ${import_ladder2.PRIMARY_MODEL}`, model: import_ladder2.PRIMARY_MODEL, provider: "claude-cli" },
    { key: "__deepseek", vendor: "DeepSeek", value: `DeepSeek relay \xB7 ${import_ladder2.PRIMARY_MODEL}`, model: import_ladder2.PRIMARY_MODEL, provider: import_ladder2.PRIMARY_PROVIDER },
    { key: "__codex", vendor: "Codex", value: "Codex (Pro) \xB7 provider default", model: "", provider: "codex-cli" },
    ...models.map((m) => ({ key: `c:${m.id}`, vendor: m.vendor, value: m.id, model: m.id, provider: import_ladder2.PRIMARY_PROVIDER }))
  ];
  const pickerIndexFor = (m, p) => {
    const i = pickerModels.findIndex((x) => x.model === (m || "") && x.provider === (p || ""));
    return i < 0 ? 0 : i;
  };
  const modelText = model || (provider === "codex-cli" ? "Codex (Pro)" : provider || "auto");
  const ctxMax = import_catalog.default.contextMaxFor(model || import_ladder2.PRIMARY_MODEL) || 1;
  const ctxUsed = Number(status && (status.tokens || status.contextUsed) || 0);
  const meters = agent.meters || null;
  const lastAssistant = (() => {
    for (let i = agent.messages.length - 1; i >= 0; i--) {
      if (agent.messages[i].role === "assistant") return agent.messages[i];
    }
    return null;
  })();
  const lastTool = lastAssistant && Array.isArray(lastAssistant.tools) && lastAssistant.tools.length ? lastAssistant.tools[lastAssistant.tools.length - 1] : null;
  const liveToolTxt = lastTool ? `${lastTool.name}${toolArgLine(lastTool.args)}` : "";
  const livePhase = !agent.busy ? "result" : lastAssistant && String(lastAssistant.text || "").trim() ? "writing" : lastAssistant && String(lastAssistant.thinking || "").trim() ? "thinking" : lastTool && lastTool.result == null ? "running" : "waiting";
  const liveLines = (() => {
    if (!lastAssistant) return [];
    const toLines = (v) => String(v == null ? "" : v).replace(/\r/g, "").split("\n").filter((l) => l.trim());
    const text = toLines(lastAssistant.text);
    const result = lastTool && lastTool.result != null ? toLines(lastTool.result) : [];
    return text.length ? text : result;
  })();
  const liveImage = lastAssistant ? (0, import_live_image2.findImageSource)([lastTool && lastTool.result != null ? String(lastTool.result) : "", String(lastAssistant.text || "")]) : null;
  const host = useHostStats(5e3);
  const memory = useMemoryBank(1e4);
  const update = useCliUpdate();
  const runner = useScriptRunner_default();
  const userTurns = agent.messages.filter((m) => m.role === "user").length;
  const toolCalls = agent.messages.reduce((n, m) => n + (Array.isArray(m.tools) ? m.tools.length : 0), 0);
  const usage = {
    tools: toolCalls,
    ok: Number(meters && meters.successes) || 0,
    fail: Number(meters && meters.failures) || 0,
    requests: Number(agent.requests) || 0,
    turns: userTurns,
    inTok: agent.tokens ? agent.tokens.in : 0,
    outTok: agent.tokens ? agent.tokens.out : 0,
    // The agent stream's `done` event only carries token counts when the
    // answering path reports them (the claude-cli path does; the plain provider
    // loop does not). Until one does, the panel says "—" rather than a zero it
    // cannot stand behind (§10).
    tokensKnown: !!(agent.tokens && agent.tokens.reported),
    ctxPct: ctxUsed > 0 && ctxMax > 0 ? Math.max(0, Math.min(100, Math.round(ctxUsed / ctxMax * 100))) : null
  };
  const peers = peersFromMcp(mcp);
  const services = serviceStates(scan);
  const otherPorts = otherListening(scan);
  const showNotice = useCallback5((text) => {
    setNotice(text);
    setTimeout(() => setNotice((cur) => cur === text ? null : cur), 6e3);
  }, []);
  const installedAnnounced = useRef11(false);
  useEffect16(() => {
    if (installedAnnounced.current) return;
    if (!update || !update.applied || !update.applied.version) return;
    installedAnnounced.current = true;
    const from = update.applied.from && update.applied.from !== update.applied.version ? ` (was v${update.applied.from})` : " (newer build, same version)";
    showNotice(`\u2713 CLI updated to v${update.applied.version}${from} \u2014 installed on this start`);
  }, [update, showNotice]);
  const updateAnnounced = useRef11("");
  useEffect16(() => {
    if (update && update.applied) return;
    if (!update || !update.version) return;
    if (update.status !== "staged" && update.status !== "blocked") return;
    const key = `${update.status}:${update.version}`;
    if (updateAnnounced.current === key) return;
    updateAnnounced.current = key;
    showNotice(
      update.status === "blocked" ? `\u2B06 CLI v${update.version} staged \u2014 this is a source checkout; nothing was written, pull/install when ready` : `\u2B06 CLI v${update.version} staged \u2014 applies when the CLI restarts`
    );
  }, [update, showNotice]);
  const settingsRows = React27.useMemo(() => {
    void prefsTick;
    let rows2 = [];
    try {
      rows2 = import_prefs3.default.list();
    } catch {
      rows2 = [];
    }
    return rows2.map((r) => {
      if (r.key === "ads") return { ...r, value: adsOn };
      if (r.key === "autoHandoff") return { ...r, value: handoffOn };
      if (r.key === "usageRefresh") return { ...r, value: usageRefresh };
      if (r.key === "graphics") return { ...r, value: prefsRef.current.graphics !== false };
      return r;
    });
  }, [prefsTick, adsOn, handoffOn, usageRefresh]);
  const applySetting = useCallback5((key, value) => {
    writePrefs({ [key]: value });
    prefsRef.current = { ...prefsRef.current, [key]: value };
    if (key === "ads") setAdsOn(!!value);
    else if (key === "autoHandoff") setHandoffOn(!!value);
    else if (key === "model") {
      setModel(String(value) || "");
      setProvider(import_ladder2.PRIMARY_PROVIDER);
    } else if (key === "provider") setProvider(String(value) || import_ladder2.PRIMARY_PROVIDER);
    else if (key === "usageRefresh") setUsageRefresh(Number(value) || 0);
    setPrefsTick((t) => t + 1);
    const shown = typeof value === "boolean" ? value ? "on" : "off" : value === "" ? "(default)" : value;
    showNotice(`\u2699 ${key} \u2192 ${shown}${key === "opaqueBackdrop" || key === "intro" ? " \u2014 applies on the next launch" : ""}`);
  }, [showNotice]);
  const changeSetting = useCallback5((key) => {
    const row = settingsRows.find((r) => r.key === key);
    if (!row) return;
    if (typeof row.value === "boolean") {
      applySetting(key, !row.value);
      return;
    }
    if (typeof row.value === "number") {
      const steps = [0, 5, 15, 30, 60, 120];
      const next = steps.find((s) => s > Number(row.value));
      applySetting(key, next == null ? steps[0] : next);
      return;
    }
    if (key === "model") {
      setView("models");
      return;
    }
    showNotice(`\u2699 ${key} is text \u2014 set it with /settings ${key} <value>`);
  }, [settingsRows, applySetting, showNotice]);
  const runCommand = useCallback5((raw) => {
    const parts = String(raw || "").trim().split(/\s+/);
    const cmd = (parts[0] || "").toLowerCase();
    const arg = parts.slice(1).join(" ");
    switch (cmd) {
      case "/menu":
        setMenuIndex(0);
        setMenuQuery("");
        setMenuOpen(true);
        return;
      case "/attach":
      case "/image": {
        if (!arg || arg === "clear" || arg === "off") {
          setAttachment(null);
          showNotice("image attachment cleared");
          return;
        }
        try {
          const next = readImageAttachment(arg);
          setAttachment(next);
          showNotice(`\u{1F4CE} ${next.name} \xB7 ${Math.round(next.bytes / 1024)}K \u2014 enter sends it with your message`);
        } catch (e) {
          showNotice(`attach failed: ${e && e.message || "could not read the file"}`);
        }
        return;
      }
      case "/model":
        if (arg) {
          setModel(arg);
          setProvider(import_ladder2.PRIMARY_PROVIDER);
          showNotice(`model \u2192 ${arg} \xB7 provider ${import_ladder2.PRIMARY_PROVIDER}`);
        } else {
          setModelIdx(pickerIndexFor(model, provider));
          setView("models");
        }
        return;
      case "/mcp": {
        const list = mcp && Array.isArray(mcp.servers) ? mcp.servers : [];
        if (!list.length) {
          showNotice("MCP \u2014 no server list yet (server unreachable?)");
          return;
        }
        if (arg) {
          const at = list.findIndex((x) => String(x.name) === String(arg));
          setMcpIdx(at > 0 ? at : 0);
        } else {
          setMcpIdx(0);
        }
        setView("mcp");
        return;
      }
      case "/handoff": {
        const want = arg === "on" ? true : arg === "off" ? false : !handoffOn;
        setHandoffOn(want);
        showNotice(
          want ? `auto handoff ON \u2014 ${import_ladder2.MODEL_LADDER.map((e) => e.label).join(" \u2192 ")} (a failed run moves on)` : "auto handoff OFF \u2014 a run that fails stays on the model it started on"
        );
        return;
      }
      case "/auto": {
        const want = String(arg || "").trim().toLowerCase();
        const next = want === "on" ? "auto-edit" : want === "off" || want === "ask" ? "suggest" : want === "full" ? "full-auto" : AUTO_MODES.has(want) ? want : autoMode === "suggest" ? "auto-edit" : autoMode === "auto-edit" ? "full-auto" : "suggest";
        setAutoMode(next);
        showNotice(
          next === "full-auto" ? "auto FULL \u2014 the agent runs and finishes without asking (sudo still confirms)" : next === "auto-edit" ? "auto EDIT \u2014 it works and finishes on its own; a dangerous shell command still asks" : "auto ASK \u2014 every command that changes the box waits for you"
        );
        return;
      }
      case "/ports": {
        const up = services.filter((s) => s.up).length;
        setView("dashboard");
        showNotice(
          `services ${up}/${services.length} online \xB7 ${otherPorts.length} other listening${otherPorts.length ? ` \xB7 ${otherPorts.slice(0, 10).map((p) => `:${p.port}`).join(" ")}${otherPorts.length > 10 ? " \u2026" : ""}` : ""}${scan.ok ? "" : " \xB7 scan unavailable"}`
        );
        return;
      }
      case "/dashboard":
        setView("dashboard");
        return;
      case "/monitor":
        setView("monitor");
        return;
      case "/usage":
        setView("usage");
        return;
      case "/scripts":
        setView("scripts");
        return;
      case "/squad":
        setView("squad");
        return;
      case "/status":
        showNotice(status ? `phase ${status.phase} \xB7 model ${status.model} \xB7 tokens ${status.tokens} \xB7 trust ${status.trust} \xB7 ${status.connected ? "connected" : "offline"}` : `server ${statusErr || "connecting\u2026"}`);
        return;
      case "/settings": {
        const [key, ...rest] = arg.split(/\s+/).filter(Boolean);
        if (!key) {
          setSettingsIdx(0);
          setView("settings");
          return;
        }
        if (!import_prefs3.default.isKnown(key)) {
          showNotice(`\u2699 settings \u2014 unknown key ${key} \xB7 known: ${import_prefs3.default.KEYS.join(", ")}`);
          return;
        }
        if (!rest.length) {
          const row = import_prefs3.default.list().find((r) => r.key === key);
          const show = (v) => typeof v === "boolean" ? v ? "on" : "off" : v || "(unset)";
          showNotice(`\u2699 ${key}:${show(row.value)} \xB7 default ${show(row.default)}`);
          return;
        }
        const value = import_prefs3.default.coerce(key, rest.join(" "));
        if (value === null) {
          showNotice(`\u2699 settings \u2014 ${key} takes on/off`);
          return;
        }
        writePrefs({ [key]: value });
        if (key === "ads") setAdsOn(!!value);
        else if (key === "autoHandoff") setHandoffOn(!!value);
        else if (key === "model") setModel(String(value) || import_ladder2.PRIMARY_MODEL);
        else if (key === "provider") setProvider(String(value) || import_ladder2.PRIMARY_PROVIDER);
        showNotice(`\u2699 ${key} \u2192 ${typeof value === "boolean" ? value ? "on" : "off" : value || "(unset)"}${key === "opaqueBackdrop" || key === "intro" ? " \u2014 applies on the next launch" : ""}`);
        return;
      }
      case "/graphics": {
        const want = String(arg || "").trim().toLowerCase();
        if (want === "on" || want === "off") {
          writePrefs({ graphics: want === "on" });
          showNotice(`\u25C6 kitty graphics \u2192 ${want}${want === "on" ? " (takes effect on the next launch)" : ""}`);
          return;
        }
        const sup = (0, import_kitty_graphics3.isSupported)(process.env, process.stdout);
        showNotice(`\u25C6 kitty graphics \u2014 ${sup ? "supported by this terminal" : "not in this terminal (kitty \xB7 Ghostty \xB7 WezTerm)"} \xB7 logo ${prefsRef.current.graphics !== false ? "on" : "off"} \xB7 /graphics on|off`);
        return;
      }
      case "/update":
        showNotice(
          !update || update.status === "idle" || update.status === "checking" ? "\u2B06 update \u2014 checking the server for a newer CLI\u2026" : update.status === "applied" || update.applied && update.applied.version ? `\u2B06 update \u2014 running v${version}, installed on this start${update.applied && update.applied.from ? ` (was v${update.applied.from})` : ""}` : update.status === "current" ? `\u2B06 update \u2014 up to date (v${update.version || version})` : update.status === "staged" ? `\u2B06 update \u2014 v${update.version} staged; applies when the CLI restarts` : update.status === "blocked" ? `\u2B06 update \u2014 v${update.version} staged; source checkout, not applied (pull/install when ready)` : `\u2B06 update \u2014 check failed: ${update.reason || "unknown"}`
        );
        return;
      case "/clear":
        agent.clear();
        setSteerQueue([]);
        showNotice("transcript cleared \xB7 steer queue emptied");
        return;
      case "/help":
        showNotice("keys: tab focus \xB7 pgup/pgdn scroll \xB7 ^P catalog \xB7 h handoff \xB7 d dashboard \xB7 v monitor \xB7 m models \xB7 s scripts \xB7 g squad \xB7 u usage \xB7 c clear \xB7 q quit \xB7 esc stop \u2014 commands: /menu /model /auto /graphics /mcp /handoff /ports /attach /dashboard /monitor /scripts /squad /usage /status /update /settings /clear /quit");
        return;
      case "/quit":
      case "/exit":
        agent.abort();
        renderer2.destroy();
        return;
      default:
        showNotice(`unknown command ${cmd} \u2014 /menu lists them`);
    }
  }, [agent, models, model, mcp, status, statusErr, renderer2, showNotice, services, otherPorts, scan, handoffOn, autoMode, update, version]);
  const crushModelList = useRef11(null);
  if (!crushModelList.current) crushModelList.current = readCrushModels();
  const catalogRows = (() => {
    const q = menuQuery.trim().toLowerCase();
    const match = (label, detail) => !q || `${label} ${detail}`.toLowerCase().includes(q);
    const rows2 = [];
    const pushSection = (section, items) => {
      const hits = items.filter((it) => match(it.label, it.detail));
      if (!hits.length) return;
      rows2.push({ kind: "header", label: section });
      rows2.push(...hits);
    };
    pushSection("AGENTS", [
      { kind: "agent", label: `Claude \xB7 ${import_ladder2.PRIMARY_MODEL}`, detail: "our config \xB7 ollama", action: { model: import_ladder2.PRIMARY_MODEL, provider: import_ladder2.PRIMARY_PROVIDER } },
      { kind: "agent", label: "Codex (Pro)", detail: "provider default \xB7 ladder 2", action: { model: "", provider: "codex-cli" } },
      ...(crushModelList.current || []).map((c) => ({
        kind: "agent",
        label: `Crush ${c.slot} \xB7 ${c.model}`,
        detail: `crush \xB7 ${c.provider}`,
        action: { model: c.model, provider: c.provider }
      }))
    ]);
    pushSection("MODELS", models.map((m) => ({
      kind: "model",
      label: m.id,
      detail: `${m.vendor}${m.context ? ` \xB7 ${Math.round(m.context / 1e3)}K` : ""}`,
      action: { model: m.id, provider: import_ladder2.PRIMARY_PROVIDER }
    })));
    const servers = mcp && Array.isArray(mcp.servers) ? mcp.servers : [];
    pushSection("MCP", servers.map((s) => ({
      kind: "mcp",
      label: `${s.initialized === false && !(Number(s.toolCount) || 0) ? "\u25CB" : "\u25CF"} ${s.name}`,
      detail: `mcp \xB7 ${s.toolCount == null ? "?" : s.toolCount} tools${s.lazy ? " \xB7 lazy" : ""}${s.initialized === false ? " \xB7 down" : ""}`,
      action: { mcp: s.name }
    })));
    pushSection("SETTINGS", settingsRows.map((r) => ({
      kind: "setting",
      label: `${r.key} ${showValue(r.value)}`,
      detail: `setting \xB7 ${String(r.value) !== String(r.default) ? "changed \xB7 " : "default \xB7 "}enter changes`,
      action: { setting: r.key }
    })));
    pushSection("COMMANDS", MENU_ITEMS.map((i) => ({
      kind: "cmd",
      label: `${i.cmd} ${i.label}`,
      detail: i.detail,
      action: { cmd: i.cmd }
    })));
    return rows2;
  })();
  const catalogSelectable = catalogRows.map((r, i) => r.kind === "header" ? -1 : i).filter((i) => i >= 0);
  const applyCatalogRow = useCallback5((row) => {
    if (!row || !row.action) return;
    if ("model" in row.action) {
      setModel(row.action.model || "");
      setProvider(row.action.provider || import_ladder2.PRIMARY_PROVIDER);
      showNotice(`model \u2192 ${row.action.model || row.label} \xB7 provider ${row.action.provider || import_ladder2.PRIMARY_PROVIDER}`);
      return;
    }
    if (row.action.setting) {
      changeSetting(row.action.setting);
      return;
    }
    if (row.action.mcp) {
      const at = (mcp && Array.isArray(mcp.servers) ? mcp.servers : []).findIndex((s) => s.name === row.action.mcp);
      setMcpIdx(at > 0 ? at : 0);
      setView("mcp");
      return;
    }
    if (row.action.cmd) runCommand(row.action.cmd);
  }, [runCommand, showNotice, changeSetting, mcp]);
  const submit = useCallback5(
    (text) => {
      const v = String(text == null ? "" : text).trim();
      if (!v) return;
      if ((0, import_input_history.appendInputHistory)(v)) {
        setInputHistory((h) => {
          const next = h.filter((x) => x !== v);
          next.push(v);
          return next.slice(-200);
        });
      }
      setHistIdx(-1);
      draftStash.current = "";
      if (v.startsWith("/")) {
        setDraft("");
        runCommand(v);
        return;
      }
      const att = attachment;
      setDraft("");
      setAttachment(null);
      if (agent.busy) {
        const queued = {
          id: `steer-${Date.now()}-${steerQueue.length}`,
          text: v,
          image: att ? att.dataUrl : "",
          imageName: att ? att.name : ""
        };
        if (att) {
          setSteerQueue((q) => [...q, queued]);
          showNotice(`\u23F3 steer queued (${steerQueue.length + 1}) \u2014 an attachment sends when this run ends`);
          return;
        }
        Promise.resolve(agent.steer(v)).then((delivered) => {
          if (delivered) {
            showNotice("\u21B3 steer sent \u2014 the running agent reads it before this run ends");
            return;
          }
          setSteerQueue((q) => [...q, queued]);
          showNotice(`\u23F3 steer queued (${steerQueue.length + 1}) \u2014 sends when this run ends`);
        });
        return;
      }
      agent.send(v, att ? { images: [att.dataUrl], imageName: att.name } : void 0);
    },
    [agent, attachment, runCommand, showNotice, steerQueue.length]
  );
  const steerFlushLock = useRef11(false);
  useEffect16(() => {
    if (agent.busy) {
      steerFlushLock.current = false;
      return;
    }
    if (steerFlushLock.current || steerQueue.length === 0) return;
    const [next, ...rest] = steerQueue;
    if (agent.send(next.text, next.image ? { images: [next.image], imageName: next.imageName } : void 0) === false) return;
    steerFlushLock.current = true;
    setSteerQueue(rest);
  }, [agent.busy, steerQueue]);
  const approving = !!agent.pendingConfirm;
  const showCrushStatus = view === "chat" && agent.busy;
  const activeAssistant = [...agent.messages].reverse().find((message) => message.role === "assistant");
  const activeTool = activeAssistant?.tools?.slice().reverse().find((tool) => tool.result === null);
  const latestMcpTool = agent.messages.filter((message) => message.role === "assistant").flatMap((message) => message.tools || []).filter((tool) => tool.mcp || String(tool.name || "").startsWith("mcp__")).slice(-1)[0] || null;
  const mcpOutputText = latestMcpTool?.result == null ? "Waiting for MCP server output\u2026" : String(latestMcpTool.result).replace(/\r/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const mcpOutLines = (rows || 30) >= 44 ? 10 : (rows || 30) >= 30 ? 8 : MCP_OUTPUT_LINES;
  const mcpPanelRows = mcpOutLines + 3;
  const mcpPanelWidth = Math.max(1, Math.max(40, Math.min((cols || 100) - 2, 140)) - 10);
  const mcpOutputLines = mcpOutputText.split("\n").flatMap((line) => {
    if (!line) return [" "];
    const rows2 = [];
    for (let i = 0; i < line.length; i += mcpPanelWidth) rows2.push(line.slice(i, i + mcpPanelWidth));
    return rows2;
  });
  const crushPhase = activeAssistant?.phase || (agent.status === "thinking" ? "THINK" : agent.status === "connecting" ? "PLAN" : "ACT");
  const answerApproval = useCallback5(
    (approved, opts) => {
      agent.answerConfirm(approved, opts);
    },
    [agent]
  );
  const cycleFocus = useCallback5(() => {
    setFocus((f) => f === "composer" ? "ad" : "composer");
  }, []);
  useKeyboard7((key) => {
    if (process.env.HAKSTER_TUI_KEYLOG) {
      try {
        fs9.appendFileSync(process.env.HAKSTER_TUI_KEYLOG, JSON.stringify({ name: key.name, ctrl: !!key.ctrl, meta: !!key.meta, shift: !!key.shift }) + "\n");
      } catch {
      }
    }
    if (key.ctrl && key.name === "c") {
      agent.abort();
      renderer2.destroy();
      return;
    }
    if (menuOpen) {
      const n = catalogSelectable.length || 1;
      if (key.name === "escape") {
        setMenuOpen(false);
        return;
      }
      if (key.name === "up") {
        setMenuIndex((i) => (i - 1 + n) % n);
        return;
      }
      if (key.name === "down") {
        setMenuIndex((i) => (i + 1) % n);
        return;
      }
      if (key.name === "backspace") {
        setMenuQuery((q) => q.slice(0, -1));
        setMenuIndex(0);
        return;
      }
      if (key.name === "return") {
        const row = catalogRows[catalogSelectable[Math.min(menuIndex, catalogSelectable.length - 1)]];
        if (row && row.action && row.action.setting) {
          applyCatalogRow(row);
          return;
        }
        setMenuOpen(false);
        setMenuQuery("");
        applyCatalogRow(row);
        return;
      }
      if (key.ctrl || key.meta) return;
      const ch = key.name === "space" ? " " : key.name && key.name.length === 1 ? key.name : "";
      if (ch) {
        setMenuQuery((q) => q + ch);
        setMenuIndex(0);
      }
      return;
    }
    if (approving) return;
    if (view === "models") {
      if (key.name === "escape" || key.name === "m") {
        setView("dashboard");
        return;
      }
      if (pickerModels.length) {
        if (key.name === "up") setModelIdx((i) => (i - 1 + pickerModels.length) % pickerModels.length);
        if (key.name === "down") setModelIdx((i) => (i + 1) % pickerModels.length);
        if (key.name === "return") {
          const pick = pickerModels[modelIdx] || pickerModels[0];
          setModel(pick.model || "");
          setProvider(pick.provider || import_ladder2.PRIMARY_PROVIDER);
          writePrefs({ model: pick.model || "", provider: pick.provider || import_ladder2.PRIMARY_PROVIDER });
          setView("chat");
          showNotice(`model \u2192 ${pick.value} \xB7 provider ${pick.provider || import_ladder2.PRIMARY_PROVIDER}`);
        }
      }
      return;
    }
    if (view === "usage") {
      if (key.name === "escape") {
        setView("chat");
        return;
      }
      if (key.name === "r") {
        usagePage.refresh();
        showNotice("\u25D4 usage \u2014 refreshed");
        return;
      }
      if (key.name === "]" || key.name === "=" || key.name === "+") {
        const next = Math.min(300, (usageRefresh || 0) + 15);
        setUsageRefresh(next);
        writePrefs({ usageRefresh: next });
        showNotice(`\u25D4 usage refresh \u2014 every ${next}s`);
        return;
      }
      if (key.name === "[" || key.name === "-") {
        const next = Math.max(0, (usageRefresh || 0) - 15);
        setUsageRefresh(next);
        writePrefs({ usageRefresh: next });
        showNotice(next ? `\u25D4 usage refresh \u2014 every ${next}s` : "\u25D4 usage refresh \u2014 paused");
        return;
      }
      const page = usageRef.current;
      if (page && typeof page.scrollBy === "function") {
        if (key.name === "pageup" || key.name === "pagedown") {
          page.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
          return;
        }
        if (key.name === "up" || key.name === "down") {
          page.scrollBy(key.name === "up" ? -1 : 1, "absolute");
          return;
        }
        if (key.name === "home") {
          page.scrollTo(0);
          return;
        }
        if (key.name === "end") {
          page.scrollBy(1e3, "viewport");
          return;
        }
      }
      return;
    }
    if (view === "settings") {
      const n = settingsRows.length || 1;
      if (key.name === "escape") {
        setView("chat");
        return;
      }
      if (key.name === "up") {
        setSettingsIdx((i) => (i - 1 + n) % n);
        return;
      }
      if (key.name === "down") {
        setSettingsIdx((i) => (i + 1) % n);
        return;
      }
      if (key.name === "return") {
        const row = settingsRows[Math.min(settingsIdx, settingsRows.length - 1)];
        if (row) changeSetting(row.key);
        return;
      }
      if (key.name === "r") {
        const row = settingsRows[Math.min(settingsIdx, settingsRows.length - 1)];
        if (row) applySetting(row.key, row.default);
        return;
      }
      return;
    }
    if (view === "mcp") {
      const n = (mcp && Array.isArray(mcp.servers) ? mcp.servers.length : 0) || 1;
      if (key.name === "escape") {
        setView("chat");
        return;
      }
      if (key.name === "up") {
        setMcpIdx((i) => (i - 1 + n) % n);
        return;
      }
      if (key.name === "down") {
        setMcpIdx((i) => (i + 1) % n);
        return;
      }
      if (key.name === "r") {
        mcpRefreshRef.current && mcpRefreshRef.current();
        showNotice("\u2B21 MCP \u2014 re-reading /api/agent/mcp-status");
        return;
      }
      return;
    }
    if (view === "scripts" || view === "squad") {
      const isScripts = view === "scripts";
      const n = (isScripts ? runner.scripts.length : peers.length) || 1;
      const move = (d) => {
        if (isScripts) setScriptIdx((i) => (i + d + n) % n);
        else setSquadIdx((i) => (i + d + n) % n);
      };
      if (key.name === "escape") {
        setView("chat");
        return;
      }
      if (key.name === "up") {
        move(-1);
        return;
      }
      if (key.name === "down") {
        move(1);
        return;
      }
      if (key.name === "return") {
        if (isScripts) {
          const entry = runner.scripts[scriptIdx];
          if (entry) {
            runner.start(entry);
            showNotice(`\u2318 ${entry.label} \u2014 running`);
          }
        } else {
          const peer = peers[squadIdx];
          if (peer) {
            const tool = peer.tools[0];
            setDraft(`Delegate this to the ${peer.name} sub-agent${tool ? ` (mcp__${peer.name}__${tool})` : ""}: `);
            setView("chat");
            setFocus("composer");
            showNotice(`\u26E8 ${peer.name} \u2014 delegation placed on the composer`);
          }
        }
        return;
      }
      return;
    }
    if (key.name === "tab") {
      cycleFocus();
      return;
    }
    if (key.name === "escape") {
      if (agent.busy) agent.abort();
      else if (view === "monitor") setView("chat");
      else if (focus !== "composer") setFocus("composer");
      return;
    }
    if (view === "dashboard") {
      const dash = dashRef.current;
      if (dash && typeof dash.scrollBy === "function") {
        if (key.name === "pageup" || key.name === "pagedown") {
          dash.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
          return;
        }
        if (key.name === "up" || key.name === "down") {
          dash.scrollBy(key.name === "up" ? -1 : 1, "absolute");
          return;
        }
        if (key.name === "home") {
          dash.scrollTo(0);
          return;
        }
        if (key.name === "end") {
          dash.scrollBy(1e3, "viewport");
          return;
        }
      }
    }
    if (key.name === "pageup" || key.name === "pagedown") return;
    if (focus === "composer" && !key.ctrl && !key.meta && !key.shift && (key.name === "up" || key.name === "down") && inputHistory.length > 0) {
      if (key.name === "up") {
        if (histIdx === -1) draftStash.current = draft;
        const next = histIdx === -1 ? inputHistory.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(next);
        setDraft(inputHistory[next]);
      } else if (histIdx !== -1) {
        if (histIdx < inputHistory.length - 1) {
          setHistIdx(histIdx + 1);
          setDraft(inputHistory[histIdx + 1]);
        } else {
          setHistIdx(-1);
          setDraft(draftStash.current || "");
          draftStash.current = "";
        }
      }
      return;
    }
    if (focus === "composer" && !key.ctrl && !key.meta) return;
    if (key.ctrl && key.name === "p") {
      setMenuQuery("");
      setMenuIndex(0);
      setMenuOpen(true);
      return;
    }
    if (key.ctrl && key.name === "o") {
      setDockExpanded((v) => !v);
      return;
    }
    if (key.ctrl && key.name === "t") {
      const want = !expandThinking;
      setExpandThinking(want);
      writePrefs({ thinkingExpanded: want });
      showNotice(want ? '\u{1F9E0} reasoning expanded \u2014 Ctrl+T folds it to "Thought for \u2026"' : "\u{1F9E0} reasoning folded \u2014 Ctrl+T expands it");
      return;
    }
    if (key.ctrl || key.meta) return;
    switch (key.name) {
      case "a": {
        const want = !adsOn;
        setAdsOn(want);
        writePrefs({ ads: want });
        break;
      }
      case "h": {
        const want = !handoffOn;
        setHandoffOn(want);
        showNotice(want ? `auto handoff ON \u2014 ${import_ladder2.MODEL_LADDER.map((e) => e.label).join(" \u2192 ")}` : "auto handoff OFF \u2014 a failed run stays on its model");
        break;
      }
      case "d":
        setView((v) => v === "chat" ? "dashboard" : "chat");
        break;
      case "v":
        setView((v) => v === "monitor" ? "chat" : "monitor");
        break;
      case "m":
        setModelIdx(pickerIndexFor(model, provider));
        setView("models");
        break;
      case "s":
        setView("scripts");
        break;
      case "g":
        setView("squad");
        break;
      case "u":
        setView((v) => v === "usage" ? "chat" : "usage");
        break;
      case "c":
        agent.clear();
        break;
      case "r":
        load();
        break;
      case "q":
        agent.abort();
        renderer2.destroy();
        break;
      default:
        break;
    }
  });
  const panelW = Math.max(40, Math.min((cols || 100) - 2, 140));
  const headerState = statusErr ? "OFFLINE" : status ? "ONLINE" : "connecting\u2026";
  const statusBoxShown = view === "chat";
  const ctxK = Math.round(ctxMax / 1e3);
  const ctxPart = model ? `ctx ${ctxK}K` : null;
  const headerRightVariants = statusBoxShown ? (
    // `tui <version>` lives on the status box's top line here, not twice.
    [[view, ctxPart].filter(Boolean).join(" \xB7 "), view]
  ) : [
    ["tui " + version, view, ctxPart].filter(Boolean).join(" \xB7 "),
    [view, ctxPart].filter(Boolean).join(" \xB7 "),
    view
  ];
  const headerInner = panelW - 2;
  const guardTxt = guard ? `${guard.present}/${guard.total} files` : "";
  const headerLeftLen = (withFiles) => `\u25CF \u25C6 haksterAi \xB7 ${headerState}`.length + (withFiles && guardTxt ? `   ${guardTxt}`.length : 0);
  const showGuard = !statusBoxShown && !!guardTxt && headerLeftLen(true) + 8 <= headerInner;
  const headerFiles = showGuard ? guardTxt : "";
  const headerLeftText = statusBoxShown ? 0 : headerLeftLen(showGuard);
  const meterScore = Math.max(0, Math.min(100, Math.round(Number(meters && meters.score) || 0)));
  const meterPts = Math.max(0, Math.round(Number(meters && meters.points) || 0));
  const meterDelta = Number(meters && meters.delta) || 0;
  const meterArrow = meterDelta > 0 ? "\u25B2" : meterDelta < 0 ? "\u25BC" : "\u25C6";
  const meterArrowFg = meterDelta > 0 ? "green" : meterDelta < 0 ? "red" : "gray";
  const meterCpu = host && host.cpuPct != null ? `${host.cpuPct}%` : "\u2014";
  const meterRam = host && host.memPct != null ? `${host.memPct}%` : "\u2014";
  const meterCtxPct = ctxMax > 0 ? Math.max(0, Math.min(100, Math.round((Number(ctxUsed) || 0) / ctxMax * 100))) : 0;
  const heatFg = (v) => v == null ? "gray" : v > 85 ? "red" : v > 60 ? "yellow" : "green";
  const meterFg = {
    smart: barColor("smart", meterScore),
    pts: barColor("points", meterPts),
    cpu: heatFg(host && host.cpuPct),
    ram: heatFg(host && host.memPct)
  };
  const mkMeter = (parts) => ({ text: parts.map((x) => x.t).join(""), parts });
  const headerMeterVariants = [
    mkMeter([
      { t: "\u{1F9E0} ", fg: meterFg.smart, bold: true },
      { t: `${meterScore}% `, fg: "white", bold: true },
      { t: meterArrow, fg: meterArrowFg },
      { t: `  \u2726 ${meterPts}p`, fg: meterFg.pts },
      { t: `  ctx ${meterCtxPct}%`, fg: meterCtxPct > 85 ? "red" : meterCtxPct > 60 ? "yellow" : "green" },
      { t: `  cpu ${meterCpu}`, fg: meterFg.cpu },
      { t: `  ram ${meterRam}`, fg: meterFg.ram }
    ]),
    mkMeter([
      { t: "\u{1F9E0} ", fg: meterFg.smart, bold: true },
      { t: `${meterScore}% `, fg: "white", bold: true },
      { t: meterArrow, fg: meterArrowFg },
      { t: `  \u2726 ${meterPts}p`, fg: meterFg.pts },
      { t: `  cpu ${meterCpu}`, fg: meterFg.cpu },
      { t: `  ram ${meterRam}`, fg: meterFg.ram }
    ]),
    mkMeter([
      { t: "\u{1F9E0} ", fg: meterFg.smart, bold: true },
      { t: `${meterScore}% `, fg: "white", bold: true },
      { t: meterArrow, fg: meterArrowFg },
      { t: ` \u2726 ${meterPts}p`, fg: meterFg.pts },
      { t: ` cpu ${meterCpu}`, fg: meterFg.cpu },
      { t: ` ram ${meterRam}`, fg: meterFg.ram }
    ]),
    mkMeter([
      { t: `\u2726 ${meterPts}p`, fg: meterFg.pts },
      { t: ` cpu ${meterCpu}`, fg: meterFg.cpu },
      { t: ` ram ${meterRam}`, fg: meterFg.ram }
    ])
  ];
  let headerRight = "";
  let headerMeter = null;
  if (view === "chat") {
    for (const meter of headerMeterVariants) {
      const rightText = headerRightVariants.find((t) => headerLeftText + 3 + meter.text.length + 2 + (t ? t.length + 2 : 0) + 2 <= headerInner);
      if (rightText !== void 0) {
        headerRight = rightText;
        headerMeter = meter;
        break;
      }
    }
  }
  if (!headerMeter) {
    headerRight = headerRightVariants.find((t) => headerLeftText + t.length + 2 <= headerInner) || "";
  }
  const sideW = (cols || 100) >= 96 ? 30 : 0;
  const bodyW = panelW - 2;
  const mainW = bodyW - (sideW ? sideW + 1 : 0);
  const dense = (rows || 30) < 34;
  const dashDense = (rows || 30) < 26;
  const systemRows = 1;
  const servicesCapacityFor = (w, d = dense) => Math.max(4, Math.max(1, Math.floor(Math.max(1, w - 4) / 17)) * (d ? 3 : 2));
  const servicesRowsFor = (w, capacity, rawCount) => {
    if (w < 96) return 3;
    return servicesGridRows(w, Math.min(Math.max(1, rawCount), capacity), dense);
  };
  const servicesRaw = Math.max(1, services.length);
  const servicesRawAll = services.length + (otherPorts.length ? 1 : 0);
  const statusRows = statusServicesRows(mainW, servicesRaw, true, !headerMeter);
  const dashServicesWidth = Math.max(1, panelW - 1);
  const dashServicesCapacity = servicesCapacityFor(dashServicesWidth, dashDense);
  const monitorServicesCapacity = servicesCapacityFor(panelW);
  const monitorServicesRows = servicesRowsFor(panelW, monitorServicesCapacity, servicesRawAll);
  const liveOutputLineCap = (rows || 30) >= 48 ? 18 : (rows || 30) >= 34 ? 12 : 8;
  const liveOutputCallRows = mainW >= 44 ? 1 : 0;
  const liveOutputChrome = 3 + liveOutputCallRows;
  const dashRows = Math.max(6, (rows || 30) - 2 - (statusErr ? 3 : 0));
  const modelRows = Math.max(3, (rows || 30) - 5);
  const sidebarRows = Math.max(0, (rows || 30) - 2);
  const monitorRows = Math.max(
    8,
    (rows || 30) - 2 - systemRows - monitorServicesRows - (notice ? 1 : 0)
  );
  const CHROME_ROWS = 1 + 1 + (showCrushStatus ? 1 : 0);
  const errRows = statusErr ? 3 : 0;
  const noticeRows = notice ? 1 : 0;
  const railRows = dockExpanded ? 7 : 1;
  const approvalRows = approving ? 6 : 0;
  const chromeNoComposer = CHROME_ROWS + errRows + noticeRows + railRows + approvalRows + statusRows + liveOutputChrome;
  const MENU_ROWS = Math.max(6, Math.min(26, (rows || 30) - 12, (rows || 30) - chromeNoComposer - 2));
  const composerRows = menuOpen ? MENU_ROWS : 5;
  const todoVisible = (rows || 30) >= 34 ? 6 : 3;
  const mandatoryRows = CHROME_ROWS + errRows + noticeRows + composerRows + railRows + approvalRows + statusRows + liveOutputChrome + 2;
  const optionalBudget = (rows || 30) - mandatoryRows;
  const wantTodoRows = agent.todos.length ? Math.min(agent.todos.length, todoVisible) + 3 : 0;
  const showTodo = wantTodoRows > 0 && optionalBudget >= wantTodoRows;
  const todoRows = showTodo ? wantTodoRows : 0;
  const showMcpPanel = !!latestMcpTool && optionalBudget - todoRows >= mcpPanelRows;
  const fixedRows = CHROME_ROWS + errRows + noticeRows + composerRows + railRows + todoRows + approvalRows + statusRows + liveOutputChrome + (showMcpPanel ? mcpPanelRows : 0);
  const sharedRows = (rows || 30) - fixedRows;
  const sharedBudget = Math.max(2, sharedRows);
  const liveFloor = sharedBudget >= 24 ? 6 : sharedBudget >= 14 ? 4 : 2;
  const liveOutputLines = Math.max(
    1,
    Math.min(liveOutputLineCap, sharedBudget - 1, Math.max(liveFloor, Math.round(sharedBudget * 0.35)))
  );
  const transcriptRows = Math.max(1, sharedBudget - liveOutputLines);
  const dashboardItems = [
    {
      key: "system",
      title: "System",
      hint: status ? "live" : "connecting\u2026",
      cells: [
        { label: "phase", value: status ? status.phase : "\u2014", color: "cyan" },
        { label: "connected", value: status ? status.connected ? "yes" : "no" : "\u2014", color: status && status.connected ? "green" : "red" },
        { label: "server model", value: status ? status.model : "\u2014" },
        { label: "trust", value: status ? status.trust : "\u2014" },
        { label: "file guards", value: guard ? `${guard.present}/${guard.total}` : "\u2026", color: guard && guard.missing && guard.missing.length ? "red" : "green" }
      ]
    },
    {
      key: "host",
      title: "Host",
      hint: "5s refresh",
      cells: [
        { label: "cpu", value: host && host.cpuPct != null ? `${host.cpuPct}%` : "\u2014", color: !host || host.cpuPct == null ? "gray" : host.cpuPct > 85 ? "red" : host.cpuPct > 60 ? "yellow" : "green" },
        { label: "load 1m", value: host ? `${host.load1}/${host.cores}` : "\u2014", color: !host ? "gray" : host.load1 > host.cores ? "red" : host.load1 > host.cores * 0.7 ? "yellow" : "green" },
        { label: "ram", value: host && host.memPct != null ? `${host.memPct}%` : "\u2014", color: !host || host.memPct == null ? "gray" : host.memPct > 90 ? "red" : host.memPct > 75 ? "yellow" : "green" },
        { label: "swap", value: host && host.swapTotalMb ? `${host.swapUsedMb}/${host.swapTotalMb}M` : "none", color: !host ? "gray" : host.swapPct > 85 ? "red" : host.swapPct > 50 ? "yellow" : "green" },
        { label: "disk free", value: host && host.diskFreeGb != null ? `${host.diskFreeGb.toFixed(1)}G / ${host.diskTotalGb.toFixed(0)}G` : "\u2014", color: !host || host.diskPct == null ? "gray" : host.diskPct > 95 ? "red" : host.diskPct > 90 ? "yellow" : "green" },
        { label: "uptime", value: host ? `${Math.floor(host.uptimeS / 3600)}h ${Math.floor(host.uptimeS % 3600 / 60)}m` : "\u2014" }
      ]
    },
    {
      key: "session",
      title: "Session",
      hint: "3s refresh",
      cells: [
        { label: "tokens", value: ctxUsed },
        { label: "ad requests", value: import_ad_client2.default.adSessionSnapshot().adsServed, color: "cyan" },
        { label: "ads held", value: import_ad_client2.default.adSessionSnapshot().adsHeld }
      ]
    },
    {
      key: "context",
      title: "Context",
      hint: `${ctxK}K window`,
      cells: [
        { label: "used", value: ctxUsed },
        { label: "window", value: `${ctxK}K` },
        { label: "share", value: ctxUsed > 0 && ctxMax > 0 ? `${Math.round(ctxUsed / ctxMax * 100)}%` : "\u2014", color: ctxUsed / ctxMax > 0.8 ? "red" : "green" }
      ]
    },
    {
      key: "agent",
      title: "Agent",
      hint: agent.status,
      cells: [
        { label: "state", value: agent.status, color: agent.status === "error" ? "red" : "green" },
        { label: "turns", value: agent.messages.filter((m) => m.role === "user").length },
        { label: "todos done", value: `${agent.todos.filter((t) => t.done).length}/${agent.todos.length}` },
        { label: "elapsed", value: `${(agent.elapsedMs / 1e3).toFixed(1)}s` }
      ]
    }
  ];
  const sidebarProps = {
    width: sideW || 30,
    height: sidebarRows,
    agentStatus: agent.status,
    phase: crushPhase,
    tool: activeTool?.name || "",
    turns: userTurns,
    elapsedMs: agent.elapsedMs,
    version,
    mcp,
    serverOk: !statusErr && !!status,
    liveTool: liveToolTxt,
    liveLines,
    liveImage,
    graphics: prefsRef.current.graphics !== false,
    busy: agent.busy,
    activity: agent.activity || [],
    usage,
    memory,
    update
  };
  if (!introDone) {
    const updateLine = update && update.applied && update.applied.version ? {
      text: update.applied.from && update.applied.from !== update.applied.version ? `\u2713 updated from v${update.applied.from}` : "\u2713 updated to the newest build",
      color: "#00ff41",
      bold: true
    } : update && update.status === "blocked" ? { text: `update v${update.version} held \xB7 source checkout`, color: "gray" } : update && update.status === "staged" ? { text: `update v${update.version} staged \xB7 applies on restart`, color: "yellow" } : { text: "up to date \xB7 updates check live", color: "gray" };
    return /* @__PURE__ */ jsx27(
      DecodeSplash,
      {
        width: cols || 100,
        height: rows || 30,
        stepMs: Number(process.env.HAKSTER_INTRO_STEP_MS) > 0 ? Number(process.env.HAKSTER_INTRO_STEP_MS) : 55,
        graphics: prefsRef.current.graphics !== false,
        lines: [
          // Lime green on the hacker-desk hero, per the owner's 2026-11-23 note.
          { text: "\u25C6 haksterAi", color: "#00ff41", bold: true },
          { text: `CLI v${version} \xB7 ${updateLine.text}`, color: updateLine.color || "gray", bold: !!updateLine.bold },
          { text: `model ${modelText}`, color: "#a3e635" },
          {
            text: statusErr ? `server offline \u2014 ${statusErr}` : status ? "server online" : "connecting\u2026",
            color: statusErr ? "red" : status ? "#00ff41" : "yellow"
          },
          { text: "type a task \xB7 /menu commands \xB7 v live monitor", color: "gray" }
        ],
        onDone: () => setIntroDone(true)
      }
    );
  }
  return /* @__PURE__ */ jsxs26("box", { style: { flexDirection: "column", width: cols || 100, height: rows || 30, overflow: "hidden" }, children: [
    /* @__PURE__ */ jsxs26("box", { style: { width: panelW, flexDirection: "row", justifyContent: "space-between", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }, children: [
      /* @__PURE__ */ jsxs26("box", { style: { flexDirection: "row" }, children: [
        statusBoxShown ? null : /* @__PURE__ */ jsxs26(Fragment10, { children: [
          /* @__PURE__ */ jsx27("text", { fg: status ? statusErr ? "red" : "green" : "yellow", attributes: TextAttributes20.BOLD, children: statusErr ? "\u25CB " : status ? "\u25CF " : "\u25CC " }),
          /* @__PURE__ */ jsx27("text", { fg: "cyan", attributes: TextAttributes20.BOLD, children: "\u25C6 haksterAi" }),
          /* @__PURE__ */ jsx27("text", { fg: statusErr ? "red" : status ? "green" : "yellow", children: ` \xB7 ${headerState}` }),
          headerFiles ? /* @__PURE__ */ jsx27("text", { fg: guard.missing && guard.missing.length ? "red" : "gray", children: `   ${headerFiles}` }) : null
        ] }),
        headerMeter ? /* @__PURE__ */ jsxs26("text", { children: [
          statusBoxShown ? null : /* @__PURE__ */ jsx27("span", { fg: "gray", children: "   " }),
          headerMeter.parts.map((part, i) => /* @__PURE__ */ jsx27("span", { fg: part.fg, attributes: part.bold ? TextAttributes20.BOLD : 0, children: part.t }, i))
        ] }) : null
      ] }),
      headerRight ? /* @__PURE__ */ jsx27("text", { fg: "gray", children: headerRight }) : null
    ] }),
    statusErr ? /* @__PURE__ */ jsx27("box", { style: { width: panelW, border: true, borderStyle: "rounded", borderColor: "red", paddingLeft: 1, paddingRight: 1 }, children: /* @__PURE__ */ jsxs26("text", { fg: "red", children: [
      "server unreachable \u2014 ",
      statusErr
    ] }) }) : null,
    view === "models" ? /* @__PURE__ */ jsx27(
      ScrollPanel_default,
      {
        width: panelW,
        title: "Models",
        hint: "\u2191\u2193 select \xB7 enter apply \xB7 esc back",
        total: pickerModels.length,
        rows: modelRows,
        selected: modelIdx,
        initial: "top",
        compactWhen: panelW < 70,
        children: (index, { width: rowW, compact }) => {
          const pick = pickerModels[index];
          const active = index === modelIdx;
          const vendorW = compact ? 7 : 11;
          return /* @__PURE__ */ jsxs26("box", { style: { width: rowW, flexDirection: "row", flexShrink: 0 }, children: [
            /* @__PURE__ */ jsx27("text", { fg: active ? "yellow" : "gray", attributes: active ? TextAttributes20.BOLD : 0, children: `${active ? "\u25B8 " : "  "}${clipLine2(pick.vendor, vendorW)}` }),
            /* @__PURE__ */ jsx27("text", { fg: active ? "yellow" : "white", children: ` ${clipLine2(pick.value, Math.max(4, rowW - vendorW - 3))}` })
          ] });
        }
      }
    ) : view === "settings" ? (
      /* The full settings page: every key in cli-prefs.json, its live value
         and what it does. Same row budget as the models picker so the status
         bar never moves. */
      /* @__PURE__ */ jsx27(
        SettingsView,
        {
          width: panelW,
          rows: modelRows,
          list: settingsRows,
          selected: settingsIdx
        }
      )
    ) : view === "mcp" ? (
      /* The MCP server manager: each server's real state from
         /api/agent/mcp-status, with the selected server's tool names. */
      /* @__PURE__ */ jsx27(
        McpView,
        {
          width: panelW,
          height: Math.max(7, (rows || 30) - 2),
          servers: mcp && Array.isArray(mcp.servers) ? mcp.servers : [],
          selected: mcpIdx
        }
      )
    ) : view === "scripts" ? /* @__PURE__ */ jsx27(
      ScriptsView,
      {
        width: panelW,
        height: dashRows,
        scripts: runner.scripts,
        selected: scriptIdx,
        run: runner.run
      }
    ) : view === "squad" ? /* @__PURE__ */ jsx27(
      SquadView,
      {
        width: panelW,
        height: dashRows,
        peers,
        selected: squadIdx
      }
    ) : view === "usage" ? (
      /* One scrollable page, like the dashboard: the page can be taller than
         a short terminal, so it scrolls with OpenTUI's own ▲/█/▼ bar instead
         of clipping the last measured rows (§ all-panels rule). */
      /* @__PURE__ */ jsx27("box", { style: { width: panelW, height: dashRows, flexShrink: 0, overflow: "hidden" }, children: /* @__PURE__ */ jsx27(
        "scrollbox",
        {
          ref: usageRef,
          style: { width: panelW, height: dashRows, scrollY: true, scrollX: false, viewportCulling: true },
          scrollbarOptions: PAGE_SCROLLBAR,
          children: /* @__PURE__ */ jsx27(
            UsageView,
            {
              width: Math.max(1, panelW - 1),
              height: dashRows,
              usage: usagePage,
              refreshSeconds: usageRefresh,
              account: status && status.user && status.user.username || ""
            }
          )
        }
      ) })
    ) : view === "dashboard" ? (
      /* The dashboard is one scrollable page. Before this it was a fixed
         stack, so a short terminal clipped the services grid and pushed the
         status bar off the bottom. PgUp/PgDn (and ↑/↓, Home/End) scroll it;
         the panel cells auto-compact to one line on a short screen. */
      /* @__PURE__ */ jsx27("box", { style: { width: panelW, height: dashRows, flexShrink: 0, overflow: "hidden" }, children: /* @__PURE__ */ jsx27(
        "scrollbox",
        {
          ref: dashRef,
          style: { width: panelW, height: dashRows, scrollY: true, scrollX: false, viewportCulling: true },
          scrollbarOptions: PAGE_SCROLLBAR,
          children: /* @__PURE__ */ jsxs26("box", { style: { width: Math.max(1, panelW - 1), flexDirection: "column" }, children: [
            /* @__PURE__ */ jsx27(
              GridLayout_default,
              {
                items: dashboardItems,
                availableWidth: Math.max(1, panelW - 1),
                getItemKey: (item) => item.key,
                renderItem: (item, index, columnWidth) => /* @__PURE__ */ jsx27(GridPanel_default, { title: item.title, width: columnWidth, hint: item.hint, dense: dashDense, children: item.cells.map((c) => /* @__PURE__ */ jsx27(Cell, { label: c.label, value: c.value, color: c.color, w: Math.max(1, Math.floor((columnWidth - 6) / 2)), dense: dashDense }, c.label)) })
              }
            ),
            /* @__PURE__ */ jsxs26(
              GridPanel_default,
              {
                title: "\u25C9 Meters",
                width: Math.max(1, panelW - 1),
                hint: `${smartLabel(meters ? meters.score : 0)} \xB7 ${meterPoints}p autolearn`,
                children: [
                  /* @__PURE__ */ jsxs26("box", { style: { width: Math.max(10, panelW - 5), flexDirection: "row", flexShrink: 0 }, children: [
                    /* @__PURE__ */ jsx27("text", { fg: "gray", children: "smartness   " }),
                    /* @__PURE__ */ jsx27(Meter, { value: meters ? meters.score : 0, max: 100, w: Math.min(40, Math.max(10, panelW - 40)), color: barColor("smart", meters ? meters.score : 0) }),
                    /* @__PURE__ */ jsx27("text", { fg: "white", children: ` ${meters ? meters.score : 0}% ${meters && meters.delta > 0 ? "\u25B2" : meters && meters.delta < 0 ? "\u25BC" : "\u25C6"} ${smartLabel(meters ? meters.score : 0)}` })
                  ] }),
                  /* @__PURE__ */ jsxs26("box", { style: { width: Math.max(10, panelW - 5), flexDirection: "row", flexShrink: 0 }, children: [
                    /* @__PURE__ */ jsx27("text", { fg: "gray", children: "autolearn   " }),
                    /* @__PURE__ */ jsx27(Meter, { value: Math.min(100, meterPoints), max: 100, w: Math.min(40, Math.max(10, panelW - 40)), color: barColor("points", meterPoints) }),
                    /* @__PURE__ */ jsx27("text", { fg: "white", children: ` ${meterPoints}p` }),
                    /* @__PURE__ */ jsx27("box", { style: { marginLeft: 2 }, children: /* @__PURE__ */ jsx27(Spark, { data: pointsHistory, w: Math.min(24, Math.max(8, panelW - 70)) }) })
                  ] }),
                  /* @__PURE__ */ jsxs26("box", { style: { width: Math.max(10, panelW - 5), flexDirection: "row", flexShrink: 0 }, children: [
                    /* @__PURE__ */ jsx27("text", { fg: "gray", children: "context     " }),
                    /* @__PURE__ */ jsx27(Meter, { value: ctxUsed, max: ctxMax, w: Math.min(40, Math.max(10, panelW - 40)), color: ctxUsed / ctxMax > 0.8 ? "red" : "green" }),
                    /* @__PURE__ */ jsx27("text", { fg: "white", children: ` ${Math.round(ctxUsed / ctxMax * 100)}%` })
                  ] })
                ]
              }
            ),
            /* @__PURE__ */ jsx27(ServicesPanel, { width: dashServicesWidth, services, scan, showAll: true, dense: dashDense, maxCells: dashServicesCapacity })
          ] })
        }
      ) })
    ) : view === "monitor" ? (
      /* Live monitor — the whole screen watching one run: host meters and
         services on top, then the big activity feed and live output beside
         the sidebar. Shift+↑/↓ scrolls the feed, shift+End resumes follow,
         esc returns to the chat. Nothing runs from here; it only watches. */
      /* @__PURE__ */ jsxs26(Fragment10, { children: [
        /* @__PURE__ */ jsxs26("box", { style: { width: panelW, paddingLeft: 1, paddingRight: 1, flexDirection: "column", flexShrink: 0 }, children: [
          /* @__PURE__ */ jsx27(SystemPanel, { width: bodyW, meters, ctxUsed, ctxMax, host }),
          /* @__PURE__ */ jsx27(ServicesPanel, { width: bodyW, services, scan, dense, maxCells: monitorServicesCapacity })
        ] }),
        /* @__PURE__ */ jsxs26("box", { style: { flexDirection: "row", width: panelW, paddingLeft: 1, paddingRight: 1, flexGrow: 1, flexShrink: 1, overflow: "hidden" }, children: [
          /* @__PURE__ */ jsx27("box", { style: { width: sideW ? Math.max(20, bodyW - sideW - 1) : bodyW, flexDirection: "column", flexShrink: 0, overflow: "hidden" }, children: /* @__PURE__ */ jsx27(
            MonitorFeed,
            {
              width: sideW ? Math.max(20, bodyW - sideW - 1) : bodyW,
              height: monitorRows,
              activity: agent.activity || [],
              liveTool: liveToolTxt,
              liveLines,
              busy: agent.busy
            }
          ) }),
          sideW ? /* @__PURE__ */ jsx27("box", { style: { marginLeft: 1 }, children: /* @__PURE__ */ jsx27(LiveSidebar, { ...sidebarProps, height: monitorRows, feed: false }) }) : null
        ] })
      ] })
    ) : /* @__PURE__ */ jsxs26("box", { style: { flexDirection: "row", width: panelW, paddingLeft: 1, paddingRight: 1, flexGrow: 1, flexShrink: 1, overflow: "hidden" }, children: [
      /* @__PURE__ */ jsxs26("box", { style: { width: mainW, flexDirection: "column", flexShrink: 0, overflow: "hidden" }, children: [
        /* @__PURE__ */ jsx27(
          StatusServicesPanel,
          {
            width: mainW,
            showMeters: !headerMeter,
            services,
            version,
            guard,
            online: !!status,
            offline: !!statusErr,
            meters,
            ctxUsed,
            ctxMax,
            host,
            dense: true
          }
        ),
        showTodo ? /* @__PURE__ */ jsx27("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx27(
          TodoPanel,
          {
            todos: agent.todos,
            width: mainW,
            hint: "the agent's checklist \xB7 updates live",
            maxVisibleRows: Math.min(agent.todos.length, todoVisible)
          }
        ) }) : null,
        /* @__PURE__ */ jsx27("box", { style: { flexShrink: 0, overflow: "hidden" }, children: /* @__PURE__ */ jsx27(
          LiveOutputPanel,
          {
            width: mainW,
            rows: liveOutputLines,
            lines: liveLines,
            image: liveImage,
            graphics: prefsRef.current.graphics !== false,
            call: liveToolTxt,
            busy: agent.busy,
            phase: livePhase,
            bindings: sideW ? null : { up: "shift", down: "shift", pageup: "shift", pagedown: "shift", home: "shift", end: "shift" }
          }
        ) }),
        showMcpPanel ? /* @__PURE__ */ jsx27(
          ScrollPanel_default,
          {
            width: mainW,
            title: `MCP Output \xB7 ${String(latestMcpTool.name || "").split("__")[1] || "server"}`,
            hint: "Ctrl+\u2191/\u2193",
            total: mcpOutputLines.length,
            rows: mcpOutLines,
            initial: "follow",
            bindings: { up: "ctrl", down: "ctrl", pageup: "ctrl", pagedown: "ctrl", home: "ctrl", end: "ctrl" },
            empty: "Waiting for MCP server output\u2026",
            borderColor: "magenta",
            children: (index, { width: rowW }) => /* @__PURE__ */ jsx27("box", { style: { width: rowW }, children: /* @__PURE__ */ jsx27("text", { fg: "white", children: clipLine2(String(mcpOutputLines[index] || " "), rowW) }) })
          },
          latestMcpTool.id || latestMcpTool.name || "mcp"
        ) : null,
        /* @__PURE__ */ jsx27("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx27(
          DockAd,
          {
            width: mainW,
            placementId: import_ad_client2.default.PLACEMENTS.tuiRail,
            enabled: adsOn,
            focused: focus === "ad",
            expanded: dockExpanded
          }
        ) }),
        approving ? /* @__PURE__ */ jsx27("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx27(
          ApprovalPrompt,
          {
            width: mainW,
            request: agent.pendingConfirm,
            onAnswer: answerApproval
          }
        ) }) : null,
        notice ? /* @__PURE__ */ jsx27("box", { style: { flexShrink: 0, width: mainW }, children: /* @__PURE__ */ jsx27("text", { fg: "cyan", children: clipLine2(`\u25C6 ${notice}`, Math.max(8, mainW - 2)) }) }) : null,
        /* @__PURE__ */ jsx27("box", { style: { flexShrink: 0, overflow: "hidden" }, children: /* @__PURE__ */ jsx27(
          Transcript,
          {
            messages: agent.messages,
            width: mainW,
            height: transcriptRows,
            scrollRef,
            live: agent.status !== "idle",
            expandThinking,
            liveLabel: !showCrushStatus,
            emptyHint: "Type a task and the agent runs it with tools. /attach <path> sends an image. PgUp/PgDn scroll the transcript; Ctrl+T opens the reasoning; esc stops a run."
          }
        ) }),
        /* @__PURE__ */ jsx27("box", { style: { flexShrink: 0 }, children: menuOpen ? /* @__PURE__ */ jsx27(
          CatalogPopout,
          {
            width: mainW,
            height: MENU_ROWS,
            rows: catalogRows,
            selectable: catalogSelectable,
            selected: menuIndex,
            query: menuQuery
          }
        ) : /* @__PURE__ */ jsx27(
          Composer,
          {
            width: mainW,
            value: draft,
            onChange: setDraft,
            onSubmit: submit,
            focused: focus === "composer" && !approving,
            disabled: false,
            hint: approving ? "answer the request above \u2014 it is holding the run" : agent.busy ? `enter queues a steer${steerQueue.length ? ` (${steerQueue.length} waiting)` : ""} \xB7 it sends when this run ends \xB7 esc stop` : attachment ? `\u{1F4CE} ${attachment.name} ${Math.round(attachment.bytes / 1024)}K \xB7 enter sends it \xB7 /attach clear` : "enter send \xB7 \u2191 history \xB7 /menu commands \xB7 /attach \xB7 pgup scroll \xB7 q quit",
            adSlot: /* @__PURE__ */ jsx27(
              DockAd,
              {
                width: Math.max(8, mainW - 4),
                placementId: import_ad_client2.default.PLACEMENTS.tuiComposer,
                enabled: adsOn,
                focused: false,
                expanded: false
              }
            )
          }
        ) }),
        showCrushStatus ? /* @__PURE__ */ jsx27("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx27(
          CrushStatus,
          {
            width: mainW,
            phase: crushPhase,
            activity: activeTool?.name || "",
            elapsedMs: agent.elapsedMs,
            queued: steerQueue.length
          }
        ) }) : null
      ] }),
      sideW ? /* @__PURE__ */ jsx27("box", { style: { marginLeft: 1 }, children: /* @__PURE__ */ jsx27(LiveSidebar, { ...sidebarProps }) }) : null
    ] }),
    /* @__PURE__ */ jsx27("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx27(
      StatusBar,
      {
        width: panelW,
        status: showCrushStatus ? null : agent.status,
        model: modelText,
        cols: cols || 100,
        focus,
        adsOn,
        elapsedMs: agent.elapsedMs,
        handoff: handoffOn,
        autoMode,
        hint: focus === "ad" ? "enter opens \xB7 ^O details" : null
      }
    ) })
  ] });
}

// src/index.jsx
var import_prefs4 = __toESM(require_prefs());
var root = null;
var renderer = null;
async function start({ version = "0.1.0" } = {}) {
  if (root) return null;
  renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    hideCursor: true,
    // Transparent backsplash: the terminal's own background stays visible —
    // Guake's installed HaksterAI wallpaper with `hakster quake`, or any
    // terminal wallpaper. OpenTUI's default background is alpha 0, and saying
    // it here keeps it that way if a future version changes the default.
    // HAKSTER_TUI_OPAQUE=1 paints solid for terminals that smear transparency.
    backgroundColor: process.env.HAKSTER_TUI_OPAQUE || import_prefs4.default.load().opaqueBackdrop ? "#000000" : "transparent"
  });
  root = createRoot(renderer);
  root.render(React28.createElement(App, { version }));
  return {
    unmount() {
      if (root) {
        root.unmount();
        root = null;
      }
      if (renderer) {
        renderer.destroy();
        renderer = null;
      }
    }
  };
}
var index_default = start;
export {
  index_default as default,
  start
};
