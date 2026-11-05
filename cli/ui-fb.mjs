// Built by esbuild from ui/src — do not edit. Run: node ui/build.mjs
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
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
import React12 from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

// src/App.jsx
import React11, { useCallback as useCallback2, useEffect as useEffect5, useRef as useRef2, useState as useState5 } from "react";
import { useKeyboard as useKeyboard3, useRenderer, useTerminalDimensions } from "@opentui/react";
import { TextAttributes as TextAttributes8 } from "@opentui/core";

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
    return /* @__PURE__ */ jsxs("box", { style: { width, flexDirection: "row", paddingLeft: 1, paddingRight: 1 }, children: [
      /* @__PURE__ */ jsx("text", { fg: focused ? "cyan" : "gray", attributes: TextAttributes.BOLD, children: focused ? "\u25B8 " : "  " }),
      /* @__PURE__ */ jsx("text", { fg: "white", children: title }),
      description ? /* @__PURE__ */ jsx("text", { fg: "gray", children: ` \u2014 ${description}` }) : null,
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
        /* @__PURE__ */ jsxs2("box", { style: { width: inner, justifyContent: "space-between" }, children: [
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
        /* @__PURE__ */ jsx3("box", { style: { width: inner }, children: /* @__PURE__ */ jsx3("text", { fg: "gray", children: hint || "enter send \xB7 esc stop \xB7 tab focus \xB7 ctrl+c quit" }) })
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
      columnGroups: [items]
    };
  }
  const maxColumns = WIDTH_THRESHOLDS.filter((t) => availableWidth >= t).length + 1;
  const columns = computeSmartColumns(items.length, maxColumns);
  let columnWidth;
  if (columns === 1) {
    columnWidth = availableWidth;
  } else {
    const totalGap = columns - 1;
    const rawWidth = Math.floor((availableWidth - totalGap) / columns);
    columnWidth = Math.max(MIN_COLUMN_WIDTH, rawWidth);
  }
  const columnGroups = Array.from({ length: columns }, () => []);
  items.forEach((item, idx) => {
    columnGroups[idx % columns].push(item);
  });
  return { columns, columnWidth, columnGroups };
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
  const { columns, columnWidth, columnGroups } = useGridLayout(items, availableWidth);
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
          return /* @__PURE__ */ jsx4(
            "box",
            {
              style: {
                flexDirection: "column",
                gap: 0,
                flexGrow: 1,
                flexShrink: 1,
                flexBasis: 0,
                minWidth: MIN_COLUMN_WIDTH
              },
              children: columnItems.map((item, idx) => /* @__PURE__ */ jsx4("box", { style: { width: columnWidth }, children: renderItem(item, idx, columnWidth) }, getItemKey(item)))
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
function GridPanel({ title, cols = 4, width, children, borderColor = "gray", hint }) {
  const inner = Math.max(1, (width || 80) - 4);
  const titleText = String(title || "");
  const hintText = String(hint || "");
  const hintWidth = Math.max(0, inner - titleText.length - 1);
  const clippedHint = hintText.length <= hintWidth ? hintText : hintWidth > 1 ? `${hintText.slice(0, hintWidth - 1)}\u2026` : "";
  return /* @__PURE__ */ jsxs5("box", { style: { width, flexDirection: "column", border: true, borderStyle: "rounded", borderColor, paddingLeft: 1, paddingRight: 1 }, children: [
    /* @__PURE__ */ jsxs5("box", { style: { width: inner, justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsx5("text", { fg: "cyan", attributes: TextAttributes4.BOLD, children: titleText.slice(0, inner) }),
      clippedHint ? /* @__PURE__ */ jsx5("text", { fg: "gray", children: clippedHint }) : null
    ] }),
    /* @__PURE__ */ jsx5("box", { style: { width: inner, flexWrap: "wrap" }, children })
  ] });
}
function Cell({ label, value, w = 18, color = "white" }) {
  const clip2 = (s, n) => {
    const t = String(s == null ? "\u2014" : s);
    return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + "\u2026";
  };
  return /* @__PURE__ */ jsxs5("box", { style: { width: Math.max(1, w), flexDirection: "column", flexShrink: 0, marginRight: 1 }, children: [
    /* @__PURE__ */ jsx5("text", { fg: "gray", children: clip2(label, w) }),
    /* @__PURE__ */ jsx5("text", { fg: color, attributes: TextAttributes4.BOLD, children: clip2(value, w) })
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

// src/components/StatusBar.jsx
import React6 from "react";
import { TextAttributes as TextAttributes5 } from "@opentui/core";
import { jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
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
function StatusBar({ width, status, model, cols, focus, adsOn, elapsedMs, hint }) {
  const known = status ? STATUS_STYLES[status] : null;
  const label = known ? known.text : status ? String(status) : "";
  const elapsed = status === "streaming" || status === "thinking" || status === "approval" ? formatElapsed(elapsedMs) : null;
  const right = [];
  if (label) {
    right.push(
      /* @__PURE__ */ jsx6("text", { fg: known ? known.color : "gray", children: label }, "status")
    );
  }
  if (elapsed) {
    right.push(/* @__PURE__ */ jsx6("text", { fg: "gray", children: elapsed }, "elapsed"));
  }
  if (model) {
    right.push(/* @__PURE__ */ jsx6("text", { fg: "yellow", children: model }, "model"));
  }
  if (cols !== void 0 && cols !== null) {
    right.push(/* @__PURE__ */ jsx6("text", { fg: "gray", children: `${cols}c` }, "cols"));
  }
  right.push(
    /* @__PURE__ */ jsx6("text", { fg: adsOn ? "green" : "red", children: adsOn ? "ads on" : "ads off" }, "ads")
  );
  const rightNodes = [];
  right.forEach((node, i) => {
    if (i > 0) {
      rightNodes.push(/* @__PURE__ */ jsx6("text", { fg: "gray", children: " \xB7 " }, `sep-${i}`));
    }
    rightNodes.push(node);
  });
  return /* @__PURE__ */ jsxs6("box", { style: { width, flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 }, children: [
    /* @__PURE__ */ jsxs6("box", { style: { flexDirection: "row" }, children: [
      focus === "ad" ? /* @__PURE__ */ jsx6("text", { fg: "cyan", attributes: TextAttributes5.BOLD, children: "\u27EA ad \u27EB" }) : /* @__PURE__ */ jsx6("text", { fg: "gray", children: "\u27EA composer \u27EB" }),
      hint ? /* @__PURE__ */ jsx6("text", { fg: "gray", children: `  ${hint}` }) : null
    ] }),
    /* @__PURE__ */ jsx6("box", { style: { flexDirection: "row" }, children: rightNodes })
  ] });
}

// src/components/CrushStatus.jsx
import React7, { useEffect as useEffect3, useState as useState3 } from "react";
import { jsx as jsx7, jsxs as jsxs7 } from "react/jsx-runtime";
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
function CrushStatus({ width, phase, activity, elapsedMs }) {
  const [frame, setFrame] = useState3(0);
  useEffect3(() => {
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
  return /* @__PURE__ */ jsx7("box", { style: { width, flexDirection: "row", paddingLeft: 1, overflow: "hidden" }, children: /* @__PURE__ */ jsxs7("text", { children: [
    /* @__PURE__ */ jsx7("span", { fg: gradColor, children: "\u27E6" }),
    /* @__PURE__ */ jsx7("span", { fg: color, children: FRAMES[frame % FRAMES.length] }),
    /* @__PURE__ */ jsx7("span", { fg: gradColor, children: "\u27E7" }),
    " ",
    /* @__PURE__ */ jsx7("span", { children: info.emoji }),
    " ",
    /* @__PURE__ */ jsx7("span", { fg: info.color, children: normalizedPhase }),
    " ",
    /* @__PURE__ */ jsx7("span", { fg: "#a5b4c3", children: phrase }),
    " ",
    /* @__PURE__ */ jsx7("span", { fg: gradColor, children: shimmer }),
    " ",
    /* @__PURE__ */ jsx7("span", { fg: "gray", children: formatElapsed2(elapsedMs) })
  ] }) });
}

// src/components/TodoPanel.jsx
import React8 from "react";
import { TextAttributes as TextAttributes6 } from "@opentui/core";
import { jsx as jsx8, jsxs as jsxs8 } from "react/jsx-runtime";
var GLYPH_DONE = "\u2713";
var GLYPH_TODO = "\u25CB";
var EMPTY_TEXT = "No todos yet \u2014 the agent's checklist appears here once it creates one.";
function clip(text, n) {
  const t = String(text == null ? "" : text);
  if (n <= 0) return "";
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + "\u2026";
}
function TodoPanel({ todos = [], width, hint, maxVisibleRows = 8 }) {
  const list = Array.isArray(todos) ? todos : [];
  const completed = list.filter((t) => t && t.done).length;
  const inner = Math.max(0, (width || 80) - 4);
  const visible = list.slice(0, Math.max(0, maxVisibleRows));
  const overflow = list.length - visible.length;
  const rows = [];
  if (list.length === 0) {
    rows.push(
      /* @__PURE__ */ jsx8("text", { fg: "gray", children: clip(EMPTY_TEXT, inner) }, "empty")
    );
  } else {
    visible.forEach((todo, i) => {
      const done = !!(todo && todo.done);
      const text = clip(todo && todo.text || "", Math.max(0, inner - 2));
      rows.push(
        /* @__PURE__ */ jsxs8("box", { style: { width: "100%", flexDirection: "row" }, children: [
          /* @__PURE__ */ jsx8("text", { fg: done ? "green" : "gray", attributes: done ? 0 : TextAttributes6.DIM, children: done ? GLYPH_DONE : GLYPH_TODO }),
          /* @__PURE__ */ jsx8("text", { fg: done ? "white" : "gray", children: ` ${text}` })
        ] }, `row-${i}`)
      );
    });
    if (overflow > 0) {
      rows.push(
        /* @__PURE__ */ jsx8("text", { fg: "gray", children: `+${overflow} more` }, "more")
      );
    }
  }
  return /* @__PURE__ */ jsxs8("box", { style: { width, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: "gray", paddingLeft: 1, paddingRight: 1 }, children: [
    /* @__PURE__ */ jsx8("text", { fg: "cyan", attributes: TextAttributes6.BOLD, children: `Todos \u2014 ${completed}/${list.length} completed` }),
    rows,
    hint ? /* @__PURE__ */ jsx8("text", { fg: "gray", children: hint }) : null
  ] });
}

// src/components/Transcript.jsx
import React10 from "react";

// src/components/MessageBlock.jsx
import React9 from "react";
import { TextAttributes as TextAttributes7 } from "@opentui/core";
import { jsx as jsx9, jsxs as jsxs9 } from "react/jsx-runtime";
var ROLE_STYLE = {
  user: { border: "cyan", label: "you" },
  assistant: { border: "gray", label: "hakster" },
  system: { border: "yellow", label: "system" }
};
var TONE_COLOR = { error: "red", warn: "yellow", notice: "cyan" };
function ToolRow({ tool, width }) {
  const pending = tool.result === null;
  const glyph = pending ? "\u2026" : "\u2713";
  const colour = pending ? "yellow" : "green";
  const args = tool.args && Object.keys(tool.args).length ? ` ${JSON.stringify(tool.args).slice(0, 60)}` : "";
  return /* @__PURE__ */ jsxs9("box", { style: { flexDirection: "column", width }, children: [
    /* @__PURE__ */ jsxs9("text", { children: [
      /* @__PURE__ */ jsxs9("span", { fg: colour, children: [
        glyph,
        " "
      ] }),
      /* @__PURE__ */ jsx9("span", { fg: "white", children: tool.name || "tool" }),
      args ? /* @__PURE__ */ jsx9("span", { fg: "gray", children: args }) : null
    ] }),
    tool.result != null ? /* @__PURE__ */ jsx9("text", { fg: "gray", children: `  ${String(tool.result).slice(0, 120)}` }) : null
  ] });
}
function MessageBlock({ message, width }) {
  if (!message) return null;
  const roleStyle = ROLE_STYLE[message.role] || ROLE_STYLE.system;
  const border = message.role === "system" && message.tone ? TONE_COLOR[message.tone] || roleStyle.border : roleStyle.border;
  const inner = Math.max(8, (width || 80) - 4);
  if (message.role === "system") {
    return /* @__PURE__ */ jsx9("box", { style: { width, border: true, borderStyle: "rounded", borderColor: border, paddingLeft: 1, paddingRight: 1 }, children: /* @__PURE__ */ jsx9("text", { fg: border, children: String(message.text || "") }) });
  }
  const tools = Array.isArray(message.tools) ? message.tools : [];
  return /* @__PURE__ */ jsxs9("box", { style: { width, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: border, paddingLeft: 1, paddingRight: 1 }, children: [
    /* @__PURE__ */ jsx9("text", { fg: border, attributes: TextAttributes7.BOLD, children: roleStyle.label }),
    message.thinking ? /* @__PURE__ */ jsx9("text", { fg: "gray", children: String(message.thinking) }) : null,
    message.text ? /* @__PURE__ */ jsx9("text", { fg: "white", children: String(message.text) }) : !message.thinking && tools.length === 0 ? /* @__PURE__ */ jsx9("text", { fg: "gray", children: "thinking\u2026" }) : null,
    tools.map((tool, i) => /* @__PURE__ */ jsx9(ToolRow, { tool, width: inner }, `tool-${i}`))
  ] });
}

// src/utils/transcript-rows.js
function wrappedRows(text, inner) {
  const s = String(text == null ? "" : text);
  if (!s) return 0;
  const cols = Math.max(1, inner);
  return s.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / cols)), 0);
}
function innerWidth(width, floor = 8) {
  return Math.max(floor, (width || 80) - 4);
}
function estimateRows(message, width) {
  if (!message) return 0;
  const inner = innerWidth(width);
  if (message.role === "system") return 1 + wrappedRows(message.text, inner - 2);
  let rows = 3;
  rows += wrappedRows(message.thinking, inner);
  rows += wrappedRows(message.text, inner);
  const tools = Array.isArray(message.tools) ? message.tools : [];
  for (const tool of tools) {
    rows += 1;
    if (tool.result) rows += wrappedRows(String(tool.result).slice(0, 160), inner);
  }
  if (!message.text && !message.thinking && tools.length === 0) rows += 1;
  return rows;
}
function fitTranscript(messages, width, budget) {
  const list = Array.isArray(messages) ? messages : [];
  const limit = Math.max(1, Number(budget) || 20);
  const visible = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const rows = estimateRows(list[i], width) + 1;
    if (used + rows > limit && visible.length > 0) break;
    used += rows;
    visible.unshift(list[i]);
  }
  return { visible, hidden: list.length - visible.length, used };
}

// src/components/Transcript.jsx
import { jsx as jsx10, jsxs as jsxs10 } from "react/jsx-runtime";
function Transcript({ messages = [], width, height, emptyHint }) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) {
    return /* @__PURE__ */ jsx10("box", { style: { width, flexDirection: "column" }, children: /* @__PURE__ */ jsx10("text", { fg: "gray", children: emptyHint || "Ask for something and the agent runs it." }) });
  }
  const budget = Math.max(1, Number(height) || 20);
  const { visible, hidden, used } = fitTranscript(list, width, budget);
  const pad = Math.max(0, budget - used);
  return /* @__PURE__ */ jsxs10("box", { style: { width, flexDirection: "column", height: budget }, children: [
    hidden > 0 ? /* @__PURE__ */ jsx10("text", { fg: "gray", children: `\u2026 ${hidden} earlier turn${hidden === 1 ? "" : "s"}` }) : null,
    /* @__PURE__ */ jsx10("box", { style: { flexDirection: "column", marginTop: pad }, children: visible.map((message) => /* @__PURE__ */ jsx10("box", { style: { marginBottom: 1 }, children: /* @__PURE__ */ jsx10(MessageBlock, { message, width }) }, message.id)) })
  ] });
}

// src/hooks/useAgentStream.js
import { useCallback, useEffect as useEffect4, useRef, useState as useState4 } from "react";
var DEFAULT_API = process.env.HAKSTER_API_URL || "http://localhost:3579";
var DEFAULT_TIMEOUT_MS = Math.max(3e4, Number(process.env.HAKSTER_AGENT_TIMEOUT_MS) || 3e5);
var seq = 0;
var nextId = (prefix) => `${prefix}-${++seq}`;
function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.filter((t) => t && typeof t === "object").map((t) => ({
    text: String(t.text || "").trim(),
    done: t.status === "done"
  })).filter((t) => t.text);
}
function useAgentStream({
  api = DEFAULT_API,
  model,
  provider,
  system,
  sessionId,
  cwd,
  approvalMode
} = {}) {
  const [messages, setMessages] = useState4([]);
  const [todos, setTodos] = useState4([]);
  const [status, setStatus] = useState4("idle");
  const [error, setError] = useState4(null);
  const [elapsedMs, setElapsedMs] = useState4(0);
  const [pendingConfirm, setPendingConfirm] = useState4(null);
  const pendingConfirmRef = useRef(null);
  const setPending = useCallback((value) => {
    pendingConfirmRef.current = value;
    setPendingConfirm(value);
  }, []);
  const abortRef = useRef(null);
  const startedAtRef = useRef(null);
  const statusRef = useRef("idle");
  const setStatusBoth = useCallback((next) => {
    statusRef.current = next;
    setStatus(next);
  }, []);
  useEffect4(() => {
    const ticking = status === "thinking" || status === "streaming" || status === "approval";
    if (!ticking) return void 0;
    const id = setInterval(() => {
      if (startedAtRef.current) setElapsedMs(Date.now() - startedAtRef.current);
    }, 250);
    return () => clearInterval(id);
  }, [status]);
  const patch = useCallback((id, fn) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx === -1) return prev;
      const next = prev.slice();
      next[idx] = fn(next[idx]) || next[idx];
      return next;
    });
  }, []);
  const append = useCallback((entry) => {
    setMessages((prev) => [...prev, entry]);
  }, []);
  const abort = useCallback(() => {
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
  const answerConfirm = useCallback(
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
  const send = useCallback(
    async (text) => {
      const prompt = String(text == null ? "" : text).trim();
      if (!prompt || statusRef.current === "connecting" || statusRef.current === "streaming") {
        return;
      }
      append({ id: nextId("user"), role: "user", text: prompt });
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
      const controller = new AbortController();
      abortRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      const applyEvent = (evt) => {
        if (!evt || typeof evt !== "object") return;
        switch (evt.type) {
          case "delta":
            setStatusBoth("streaming");
            patch(assistantId, (m) => ({ ...m, text: m.text + (evt.content || "") }));
            break;
          case "thinking_start":
            setStatusBoth("thinking");
            patch(assistantId, (m) => ({ ...m, thinking: "" }));
            break;
          case "thinking":
            setStatusBoth("thinking");
            patch(assistantId, (m) => ({ ...m, thinking: m.thinking + (evt.content || "") }));
            break;
          case "thinking_end":
            break;
          case "phase":
            if (evt.phase) patch(assistantId, (m) => ({ ...m, phase: evt.phase }));
            break;
          case "tool_call_start": {
            const name = evt.tool_name || "unknown";
            if (name === "update_todo" || name === "plan") {
              const raw = evt.tool_args && (evt.tool_args.todos || evt.tool_args.steps) || null;
              const next = name === "plan" ? normalizeTodos((raw || []).map((s) => ({ text: s, status: "pending" }))) : normalizeTodos(raw);
              if (next) setTodos(next);
            }
            patch(assistantId, (m) => ({
              ...m,
              tools: [
                ...m.tools,
                {
                  id: evt.tool_call_id || nextId("tool"),
                  name,
                  args: evt.tool_args || {},
                  result: null,
                  mcp: name.startsWith("mcp__")
                }
              ]
            }));
            break;
          }
          case "mcp_result": {
            const result = String(evt.data == null ? "" : evt.data);
            patch(assistantId, (m) => {
              const tools = m.tools.slice();
              let idx = evt.tool_call_id ? tools.findIndex((t) => t.id === evt.tool_call_id) : -1;
              if (idx === -1) {
                for (let i = tools.length - 1; i >= 0; i--) {
                  if (tools[i].mcp && tools[i].result === null) {
                    idx = i;
                    break;
                  }
                }
              }
              if (idx !== -1) tools[idx] = { ...tools[idx], result, mcp: true };
              return { ...m, tools };
            });
            break;
          }
          case "tool_call_result":
          case "tool_result": {
            const result = String(
              evt.tool_result != null ? evt.tool_result : evt.result != null ? evt.result : ""
            );
            patch(assistantId, (m) => {
              const tools = m.tools.slice();
              let idx = evt.tool_call_id ? tools.findIndex((t) => t.id === evt.tool_call_id) : -1;
              if (idx === -1) {
                for (let i = tools.length - 1; i >= 0; i--) {
                  if (tools[i].result === null) {
                    idx = i;
                    break;
                  }
                }
              }
              if (idx !== -1) tools[idx] = { ...tools[idx], result };
              return { ...m, tools };
            });
            break;
          }
          case "needs_confirmation": {
            setStatusBoth("approval");
            setPending({
              toolCallId: evt.tool_call_id || null,
              toolName: evt.tool_name || "tool",
              reason: evt.reason || "Approval needed",
              command: evt.command || ""
            });
            break;
          }
          case "loop_detected":
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
            setError(evt.error || "agent error");
            setStatusBoth("error");
            append({ id: nextId("sys"), role: "system", tone: "error", text: evt.error || "agent error" });
            break;
          case "done":
            patch(assistantId, (m) => ({
              ...m,
              model: evt.model || m.model,
              tokens: evt.inputTokens != null || evt.outputTokens != null ? { in: evt.inputTokens, out: evt.outputTokens } : m.tokens
            }));
            break;
          default:
            break;
        }
      };
      try {
        const res = await fetch(`${api}/api/agent/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...process.env.HAKSTER_API_KEY ? { "x-api-key": process.env.HAKSTER_API_KEY } : {} },
          signal: controller.signal,
          body: JSON.stringify({
            messages: [
              ...system ? [{ role: "system", content: system }] : [],
              { role: "user", content: prompt }
            ],
            stream: true,
            provider,
            model,
            ...cwd ? { cwd } : {},
            ...sessionId ? { sessionId } : {},
            ...approvalMode ? { approvalMode } : {}
          })
        });
        if (!res.ok) throw new Error(`server replied ${res.status}`);
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
        if (statusRef.current !== "error") setStatusBoth("idle");
      } catch (e) {
        if (e && e.name === "AbortError") {
          append({ id: nextId("sys"), role: "system", tone: "warn", text: "run cancelled" });
          setStatusBoth("idle");
        } else {
          const msg = e && e.message || "request failed";
          setError(msg);
          setStatusBoth("error");
          append({ id: nextId("sys"), role: "system", tone: "error", text: msg });
        }
      } finally {
        clearTimeout(timeout);
        abortRef.current = null;
        setPending(null);
        setElapsedMs(startedAtRef.current ? Date.now() - startedAtRef.current : 0);
      }
    },
    [api, append, approvalMode, cwd, model, patch, provider, sessionId, setPending, setStatusBoth, system]
  );
  const clear = useCallback(() => {
    abort();
    setPending(null);
    setMessages([]);
    setTodos([]);
    setError(null);
    setElapsedMs(0);
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
    pendingConfirm,
    answerConfirm,
    send,
    abort,
    clear
  };
}
var useAgentStream_default = useAgentStream;

// src/App.jsx
var import_catalog = __toESM(require_catalog());
var import_ad_client2 = __toESM(require_ad_client());
import { Fragment as Fragment2, jsx as jsx11, jsxs as jsxs11 } from "react/jsx-runtime";
var API = process.env.HAKSTER_API_URL || "http://localhost:3579";
var MCP_OUTPUT_LINES = 4;
var MCP_OUTPUT_PANEL_ROWS = MCP_OUTPUT_LINES + 3;
var SYSTEM = process.env.HAKSTER_TUI_SYSTEM || "You are haksterAi running inside a terminal dashboard. Answer briefly and use tools when they are needed.";
function App({ version = "0.1.0" }) {
  const renderer2 = useRenderer();
  const { width: cols, height: rows } = useTerminalDimensions();
  const [view, setView] = useState5("chat");
  const [focus, setFocus] = useState5("composer");
  const [adsOn, setAdsOn] = useState5(true);
  const [dockExpanded, setDockExpanded] = useState5(false);
  const [draft, setDraft] = useState5("");
  const [model, setModel] = useState5(process.env.HAKSTER_MODEL || "glm-5.2:cloud");
  const [modelIdx, setModelIdx] = useState5(0);
  const [status, setStatus] = useState5(null);
  const [statusErr, setStatusErr] = useState5(null);
  const [history, setHistory] = useState5([]);
  const [mcpOutputOffset, setMcpOutputOffset] = useState5(0);
  const agent = useAgentStream_default({
    api: API,
    model,
    provider: process.env.HAKSTER_PROVIDER || "ollama",
    system: SYSTEM,
    cwd: process.env.HAKSTER_AGENT_CWD || null
  });
  const load = useCallback2(async () => {
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
  useEffect5(() => {
    load();
    const t = setInterval(load, 3e3);
    return () => clearInterval(t);
  }, [load]);
  const models = import_catalog.default.REFERENCE_CATALOG || [];
  const ctxMax = import_catalog.default.contextMaxFor(model) || 1;
  const ctxUsed = Number(status && (status.tokens || status.contextUsed) || 0);
  const submit = useCallback2(
    (text) => {
      const v = String(text == null ? "" : text).trim();
      if (!v || agent.busy) return;
      setDraft("");
      agent.send(v);
    },
    [agent]
  );
  const approving = !!agent.pendingConfirm;
  const showCrushStatus = view === "chat" && agent.busy;
  const activeAssistant = [...agent.messages].reverse().find((message) => message.role === "assistant");
  const activeTool = activeAssistant?.tools?.slice().reverse().find((tool) => tool.result === null);
  const latestMcpTool = agent.messages.filter((message) => message.role === "assistant").flatMap((message) => message.tools || []).filter((tool) => tool.mcp || String(tool.name || "").startsWith("mcp__")).slice(-1)[0] || null;
  const mcpOutputText = latestMcpTool?.result == null ? "Waiting for MCP server output\u2026" : String(latestMcpTool.result).replace(/\r/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const mcpPanelWidth = Math.max(1, Math.max(40, Math.min((cols || 100) - 2, 140)) - 10);
  const mcpOutputLines = mcpOutputText.split("\n").flatMap((line) => {
    if (!line) return [" "];
    const rows2 = [];
    for (let i = 0; i < line.length; i += mcpPanelWidth) rows2.push(line.slice(i, i + mcpPanelWidth));
    return rows2;
  });
  const mcpMaxOffset = Math.max(0, mcpOutputLines.length - MCP_OUTPUT_LINES);
  const visibleMcpOutput = mcpOutputLines.slice(mcpOutputOffset, mcpOutputOffset + MCP_OUTPUT_LINES);
  useEffect5(() => {
    setMcpOutputOffset(0);
  }, [latestMcpTool?.id, latestMcpTool?.result]);
  const crushPhase = activeAssistant?.phase || (agent.status === "thinking" ? "THINK" : agent.status === "connecting" ? "PLAN" : "ACT");
  const answerApproval = useCallback2(
    (approved, opts) => {
      agent.answerConfirm(approved, opts);
    },
    [agent]
  );
  const cycleFocus = useCallback2(() => {
    setFocus((f) => f === "composer" ? "ad" : "composer");
  }, []);
  useKeyboard3((key) => {
    if (key.ctrl && key.name === "c") {
      agent.abort();
      renderer2.destroy();
      return;
    }
    if (approving) return;
    if (view === "models") {
      if (key.name === "escape" || key.name === "m") {
        setView("dashboard");
        return;
      }
      if (models.length) {
        if (key.name === "up") setModelIdx((i) => (i - 1 + models.length) % models.length);
        if (key.name === "down") setModelIdx((i) => (i + 1) % models.length);
        if (key.name === "return") {
          setModel(models[modelIdx].id);
          setView("chat");
        }
      }
      return;
    }
    if (key.name === "tab") {
      cycleFocus();
      return;
    }
    if (key.name === "escape") {
      if (agent.busy) agent.abort();
      else if (focus !== "composer") setFocus("composer");
      return;
    }
    if (focus === "composer" && !key.ctrl && !key.meta) return;
    if (key.ctrl && key.name === "o") {
      setDockExpanded((v) => !v);
      return;
    }
    if (key.ctrl && latestMcpTool && (key.name === "up" || key.name === "down")) {
      setMcpOutputOffset((offset) => Math.max(0, Math.min(mcpMaxOffset, offset + (key.name === "up" ? -1 : 1))));
      return;
    }
    switch (key.name) {
      case "a":
        setAdsOn((v) => !v);
        break;
      case "d":
        setView((v) => v === "chat" ? "dashboard" : "chat");
        break;
      case "m":
        setModelIdx(Math.max(0, models.findIndex((x) => x.id === model)));
        setView("models");
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
  const CHROME_ROWS = 1 + 1 + (showCrushStatus ? 1 : 0);
  const composerRows = 5;
  const railRows = dockExpanded ? 7 : 1;
  const todoRows = agent.todos.length ? Math.min(agent.todos.length, 6) + 4 : 0;
  const approvalRows = approving ? 6 : 0;
  const transcriptRows = Math.max(
    4,
    (rows || 30) - CHROME_ROWS - composerRows - railRows - todoRows - approvalRows - (latestMcpTool ? MCP_OUTPUT_PANEL_ROWS : 0)
  );
  const dashboardItems = [
    {
      key: "system",
      title: "System",
      hint: status ? "live" : "connecting\u2026",
      cells: [
        { label: "phase", value: status ? status.phase : "\u2014", color: "cyan" },
        { label: "connected", value: status ? status.connected ? "yes" : "no" : "\u2014", color: status && status.connected ? "green" : "red" },
        { label: "server model", value: status ? status.model : "\u2014" },
        { label: "trust", value: status ? status.trust : "\u2014" }
      ]
    },
    {
      key: "session",
      title: "Session",
      hint: "3s refresh",
      cells: [
        { label: "tokens", value: ctxUsed },
        { label: "model", value: model, color: "yellow" },
        { label: "ad requests", value: import_ad_client2.default.adSessionSnapshot().adsServed, color: "cyan" },
        { label: "ads held", value: import_ad_client2.default.adSessionSnapshot().adsHeld }
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
  return /* @__PURE__ */ jsxs11("box", { style: { flexDirection: "column", width: cols || 100, height: rows || 30, overflow: "hidden" }, children: [
    /* @__PURE__ */ jsxs11("box", { style: { width: panelW, justifyContent: "space-between", flexShrink: 0 }, children: [
      /* @__PURE__ */ jsx11("text", { fg: "cyan", attributes: TextAttributes8.BOLD, children: "haksterAi" }),
      /* @__PURE__ */ jsx11("text", { fg: "gray", children: `tui ${version} \xB7 ${view} \xB7 ${model} \xB7 ctx ${Math.round(ctxMax / 1e3)}K` })
    ] }),
    statusErr ? /* @__PURE__ */ jsx11("box", { style: { width: panelW, border: true, borderStyle: "rounded", borderColor: "red", paddingLeft: 1, paddingRight: 1 }, children: /* @__PURE__ */ jsxs11("text", { fg: "red", children: [
      "server unreachable \u2014 ",
      statusErr
    ] }) }) : null,
    view === "models" ? /* @__PURE__ */ jsx11(GridPanel_default, { title: "Models", width: panelW, hint: "\u2191\u2193 select \xB7 enter apply \xB7 esc back", children: models.map((m, i) => /* @__PURE__ */ jsx11(
      Cell,
      {
        label: m.vendor,
        value: `${i === modelIdx ? "\u25B8 " : ""}${m.id}`,
        w: Math.max(1, Math.floor((panelW - 6) / 2)),
        color: i === modelIdx ? "yellow" : "white"
      },
      m.id
    )) }) : view === "dashboard" ? /* @__PURE__ */ jsxs11(Fragment2, { children: [
      /* @__PURE__ */ jsx11(
        GridLayout_default,
        {
          items: dashboardItems,
          availableWidth: panelW,
          getItemKey: (item) => item.key,
          renderItem: (item, index, columnWidth) => /* @__PURE__ */ jsx11(GridPanel_default, { title: item.title, width: columnWidth, hint: item.hint, children: item.cells.map((c) => /* @__PURE__ */ jsx11(Cell, { label: c.label, value: c.value, color: c.color, w: Math.max(1, Math.floor((columnWidth - 6) / 2)) }, c.label)) })
        }
      ),
      /* @__PURE__ */ jsxs11(GridPanel_default, { title: "Context", width: panelW, hint: import_catalog.default.labelFor(import_catalog.default.findModel(model) || { id: model, vendor: "local", context: null }), children: [
        /* @__PURE__ */ jsx11("box", { children: /* @__PURE__ */ jsx11(Meter, { value: ctxUsed, max: ctxMax, w: Math.min(40, panelW - 30), color: ctxUsed / ctxMax > 0.8 ? "red" : "green" }) }),
        /* @__PURE__ */ jsx11("box", { style: { marginLeft: 1 }, children: /* @__PURE__ */ jsx11(Spark, { data: history, w: Math.min(30, Math.max(10, panelW - 10)) }) })
      ] })
    ] }) : /* @__PURE__ */ jsxs11(Fragment2, { children: [
      agent.todos.length ? /* @__PURE__ */ jsx11("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx11(
        TodoPanel,
        {
          todos: agent.todos,
          width: panelW,
          hint: "the agent's checklist \xB7 updates live",
          maxVisibleRows: Math.min(agent.todos.length, 6)
        }
      ) }) : null,
      /* @__PURE__ */ jsx11("box", { style: { flexGrow: 1, flexShrink: 1, overflow: "hidden" }, children: /* @__PURE__ */ jsx11(
        Transcript,
        {
          messages: agent.messages,
          width: panelW,
          height: transcriptRows,
          emptyHint: "Type a task and the agent runs it with tools. Tab moves focus to the ad slot; esc stops a run."
        }
      ) }),
      latestMcpTool ? /* @__PURE__ */ jsx11(
        GridPanel_default,
        {
          title: `MCP Output \xB7 ${String(latestMcpTool.name || "").split("__")[1] || "server"}`,
          width: panelW,
          borderColor: "magenta",
          hint: `${Math.min(mcpOutputOffset + 1, mcpOutputLines.length)}-${Math.min(mcpOutputOffset + MCP_OUTPUT_LINES, mcpOutputLines.length)}/${mcpOutputLines.length} \xB7 Ctrl+\u2191/\u2193`,
          children: /* @__PURE__ */ jsx11("box", { style: { flexDirection: "column", width: Math.max(1, panelW - 4) }, children: visibleMcpOutput.map((line, index) => {
            return /* @__PURE__ */ jsx11("text", { fg: "white", children: String(line || " ") }, `mcp-output-${index}`);
          }) })
        }
      ) : null,
      showCrushStatus ? /* @__PURE__ */ jsx11("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx11(
        CrushStatus,
        {
          width: panelW,
          phase: crushPhase,
          activity: activeTool?.name || "",
          elapsedMs: agent.elapsedMs
        }
      ) }) : null,
      /* @__PURE__ */ jsx11("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx11(
        DockAd,
        {
          width: panelW,
          placementId: import_ad_client2.default.PLACEMENTS.tuiRail,
          enabled: adsOn,
          focused: focus === "ad",
          expanded: dockExpanded
        }
      ) }),
      approving ? /* @__PURE__ */ jsx11("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx11(
        ApprovalPrompt,
        {
          width: panelW,
          request: agent.pendingConfirm,
          onAnswer: answerApproval
        }
      ) }) : null,
      /* @__PURE__ */ jsx11("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx11(
        Composer,
        {
          width: panelW,
          value: draft,
          onChange: setDraft,
          onSubmit: submit,
          focused: focus === "composer" && !approving,
          disabled: agent.busy,
          hint: approving ? "answer the request above \u2014 it is holding the run" : agent.busy ? "esc stop \xB7 the run is streaming" : "enter send \xB7 tab focus \xB7 a ads \xB7 d dashboard \xB7 m models \xB7 c clear \xB7 q quit",
          adSlot: /* @__PURE__ */ jsx11(
            DockAd,
            {
              width: Math.max(8, panelW - 4),
              placementId: import_ad_client2.default.PLACEMENTS.tuiComposer,
              enabled: adsOn,
              focused: false,
              expanded: false
            }
          )
        }
      ) })
    ] }),
    /* @__PURE__ */ jsx11("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx11(
      StatusBar,
      {
        width: panelW,
        status: agent.status,
        model,
        cols: cols || 100,
        focus,
        adsOn,
        elapsedMs: agent.elapsedMs,
        hint: focus === "ad" ? "enter opens \xB7 ^O details" : null
      }
    ) })
  ] });
}

// src/index.jsx
var root = null;
var renderer = null;
async function start({ version = "0.1.0" } = {}) {
  if (root) return null;
  renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    hideCursor: true
  });
  root = createRoot(renderer);
  root.render(React12.createElement(App, { version }));
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
