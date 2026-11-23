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

// ../src/models/ladder.js
var require_ladder = __commonJS({
  "../src/models/ladder.js"(exports, module) {
    "use strict";
    var PRIMARY_MODEL2 = "deepseek-v4.1-flash:cloud";
    var PRIMARY_PROVIDER2 = "ollama";
    var MODEL_LADDER2 = Object.freeze([
      Object.freeze({
        tier: 1,
        provider: PRIMARY_PROVIDER2,
        model: PRIMARY_MODEL2,
        label: "DeepSeek Flash"
      }),
      Object.freeze({
        tier: 2,
        provider: "codex-cli",
        // Empty model: the server fills in the provider's own defaultModel, so the
        // CLI never invents a Codex model string of its own.
        model: "",
        label: "Codex"
      }),
      Object.freeze({
        tier: 3,
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
import React17 from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

// src/App.jsx
import React16, { useCallback as useCallback2, useEffect as useEffect6, useRef as useRef3, useState as useState6 } from "react";
import fs4 from "node:fs";
import path3 from "node:path";
import { useKeyboard as useKeyboard3, useRenderer, useTerminalDimensions } from "@opentui/react";
import { TextAttributes as TextAttributes13 } from "@opentui/core";

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
    /* @__PURE__ */ jsxs5("box", { style: { width: inner, flexDirection: "row", justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsx5("text", { fg: "cyan", attributes: TextAttributes4.BOLD, children: titleText.slice(0, inner) }),
      clippedHint ? /* @__PURE__ */ jsx5("text", { fg: "gray", children: clippedHint }) : null
    ] }),
    /* @__PURE__ */ jsx5("box", { style: { width: inner, flexDirection: "row", flexWrap: "wrap" }, children })
  ] });
}
function Cell({ label, value, w = 18, color = "white" }) {
  const clip6 = (s, n) => {
    const t = String(s == null ? "\u2014" : s);
    return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + "\u2026";
  };
  return /* @__PURE__ */ jsxs5("box", { style: { width: Math.max(1, w), flexDirection: "column", flexShrink: 0, marginRight: 1 }, children: [
    /* @__PURE__ */ jsx5("text", { fg: "gray", children: clip6(label, w) }),
    /* @__PURE__ */ jsx5("text", { fg: color, attributes: TextAttributes4.BOLD, children: clip6(value, w) })
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
import React6 from "react";
import { TextAttributes as TextAttributes5 } from "@opentui/core";
import { jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
var clip = (s, n) => {
  const t = String(s == null ? "\u2014" : s);
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + "\u2026";
};
function Row({ width, k, v, color = "white" }) {
  const kw = Math.min(10, Math.max(4, Math.floor(width / 3)));
  return /* @__PURE__ */ jsxs6("box", { style: { width, flexDirection: "row", justifyContent: "space-between", flexShrink: 0 }, children: [
    /* @__PURE__ */ jsx6("text", { fg: "gray", children: clip(k, kw) }),
    /* @__PURE__ */ jsx6("text", { fg: color, attributes: TextAttributes5.BOLD, children: clip(v, Math.max(1, width - kw - 1)) })
  ] });
}
function Panel({ width, title, hint, children }) {
  const inner = Math.max(1, width - 4);
  return /* @__PURE__ */ jsxs6("box", { style: { width, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: "gray", paddingLeft: 1, paddingRight: 1, flexShrink: 0 }, children: [
    /* @__PURE__ */ jsxs6("box", { style: { width: inner, flexDirection: "row", justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsx6("text", { fg: "cyan", attributes: TextAttributes5.BOLD, children: clip(title, inner) }),
      hint ? /* @__PURE__ */ jsx6("text", { fg: "gray", children: clip(hint, Math.max(0, inner - title.length - 1)) }) : null
    ] }),
    /* @__PURE__ */ jsx6("box", { style: { width: inner, flexDirection: "column" }, children })
  ] });
}
function LiveSidebar({
  width = 30,
  agentStatus = "idle",
  phase = "IDLE",
  tool = "",
  turns = 0,
  elapsedMs = 0,
  model = "",
  version = "0.1.0",
  mcp = null,
  serverOk = false,
  maxServers = 8
}) {
  const inner = Math.max(1, width - 4);
  const servers = mcp && Array.isArray(mcp.servers) ? mcp.servers : [];
  const live = servers.filter((s) => s.initialized || (s.toolCount || 0) > 0).length;
  const ordered = [...servers].sort((a, b) => {
    const rank = (x) => x.initialized || (x.toolCount || 0) > 0 ? 0 : x.lazy ? 1 : 2;
    return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
  });
  const shown = ordered.slice(0, Math.max(0, maxServers));
  const hidden = ordered.length - shown.length;
  return /* @__PURE__ */ jsxs6("box", { style: { width, flexDirection: "column", flexShrink: 0 }, children: [
    /* @__PURE__ */ jsxs6(Panel, { width, title: "\u25C8 Live", hint: serverOk ? "online" : "offline", children: [
      /* @__PURE__ */ jsx6(Row, { width: inner, k: "status", v: agentStatus || "idle", color: agentStatus === "error" ? "red" : agentStatus === "idle" ? "gray" : "green" }),
      /* @__PURE__ */ jsx6(Row, { width: inner, k: "phase", v: phase || "IDLE", color: "cyan" }),
      /* @__PURE__ */ jsx6(Row, { width: inner, k: "tool", v: tool || "\u2014" }),
      /* @__PURE__ */ jsx6(Row, { width: inner, k: "turns", v: turns }),
      /* @__PURE__ */ jsx6(Row, { width: inner, k: "elapsed", v: `${(Number(elapsedMs || 0) / 1e3).toFixed(1)}s` }),
      /* @__PURE__ */ jsx6(Row, { width: inner, k: "model", v: model, color: "yellow" }),
      /* @__PURE__ */ jsx6(Row, { width: inner, k: "version", v: `tui ${version}` })
    ] }),
    /* @__PURE__ */ jsxs6(Panel, { width, title: "\u2B21 MCP servers", hint: servers.length ? `${live}/${servers.length}` : "\u2026", children: [
      shown.length === 0 ? /* @__PURE__ */ jsx6(Row, { width: inner, k: "servers", v: "\u2014", color: "gray" }) : shown.map((s) => {
        const up = !!s.initialized || (s.toolCount || 0) > 0;
        const lazy = !!s.lazy && !up;
        return /* @__PURE__ */ jsx6(
          Row,
          {
            width: inner,
            k: s.name,
            v: up ? `${s.toolCount || 0} tools` : lazy ? "lazy" : "down",
            color: up ? "green" : lazy ? "yellow" : "red"
          },
          s.name
        );
      }),
      hidden > 0 ? /* @__PURE__ */ jsx6(Row, { width: inner, k: "more", v: `+${hidden}`, color: "gray" }) : null
    ] })
  ] });
}

// src/components/MenuPalette.jsx
import React7 from "react";
import { TextAttributes as TextAttributes6 } from "@opentui/core";
import { jsx as jsx7, jsxs as jsxs7 } from "react/jsx-runtime";
var MENU_ITEMS = [
  { cmd: "/model", label: "Models", detail: "switch the model for this session" },
  { cmd: "/mcp", label: "MCP servers", detail: "live servers and their tool counts" },
  { cmd: "/handoff", label: "Auto handoff", detail: "on/off \xB7 DeepSeek \u2192 Codex \u2192 others" },
  { cmd: "/ports", label: "Ports", detail: "services and every listening port" },
  { cmd: "/attach", label: "Attach image", detail: "/attach <path> \xB7 sends with your message" },
  { cmd: "/dashboard", label: "Dashboard", detail: "system / session / agent panels" },
  { cmd: "/status", label: "Status", detail: "server, phase, tokens" },
  { cmd: "/clear", label: "Clear transcript", detail: "start the conversation over" },
  { cmd: "/help", label: "Help", detail: "keys and commands" },
  { cmd: "/quit", label: "Quit", detail: "leave the dashboard" }
];

// src/components/CatalogPopout.jsx
import React8 from "react";
import { TextAttributes as TextAttributes7 } from "@opentui/core";
import { jsx as jsx8, jsxs as jsxs8 } from "react/jsx-runtime";
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
  const bodyRows = Math.max(3, h - 4);
  const selRow = selectable[Math.min(selected, selectable.length - 1)] ?? 0;
  const start2 = Math.max(0, Math.min(selRow - Math.floor(bodyRows / 2), Math.max(0, rows.length - bodyRows)));
  const shown = rows.slice(start2, start2 + bodyRows);
  const hiddenAbove = start2;
  const hiddenBelow = Math.max(0, rows.length - start2 - shown.length);
  return /* @__PURE__ */ jsxs8("box", { style: { width: w, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: "cyan", paddingLeft: 1, paddingRight: 1, flexShrink: 0 }, children: [
    /* @__PURE__ */ jsxs8("box", { style: { width: inner, flexDirection: "row", justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsx8("text", { fg: "cyan", attributes: TextAttributes7.BOLD, children: "\u25C7 Catalog" }),
      /* @__PURE__ */ jsx8("text", { fg: "gray", children: clip2(hiddenAbove || hiddenBelow ? `${hiddenAbove}\u2191 ${hiddenBelow}\u2193 \xB7 \u2191\u2193 \xB7 enter \xB7 esc` : "\u2191\u2193 select \xB7 enter apply \xB7 esc close", inner - 10) })
    ] }),
    /* @__PURE__ */ jsxs8("box", { style: { width: inner, flexDirection: "row" }, children: [
      /* @__PURE__ */ jsx8("text", { fg: "yellow", children: "\u2315 " }),
      /* @__PURE__ */ jsx8("text", { fg: "white", children: clip2(query, inner - 2) })
    ] }),
    /* @__PURE__ */ jsx8("box", { style: { width: inner, flexDirection: "column" }, children: shown.length === 0 ? /* @__PURE__ */ jsx8("text", { fg: "gray", children: clip2("no match \u2014 backspace to widen, esc to close", inner) }) : shown.map((row, i) => {
      const abs = start2 + i;
      if (row.kind === "header") {
        return /* @__PURE__ */ jsx8("box", { style: { width: inner, flexDirection: "row" }, children: /* @__PURE__ */ jsx8("text", { fg: "gray", attributes: TextAttributes7.BOLD, children: clip2(`\u2014 ${row.label} \u2014`, inner) }) }, `h:${row.label}`);
      }
      const isSel = abs === selRow;
      const color = KIND_COLOR[row.kind] || "white";
      const detail = row.detail || "";
      const valueW = Math.min(detail.length, Math.max(0, Math.floor(inner / 2)));
      return /* @__PURE__ */ jsxs8("box", { style: { width: inner, flexDirection: "row", justifyContent: "space-between" }, children: [
        /* @__PURE__ */ jsx8("text", { fg: isSel ? "yellow" : color, attributes: isSel ? TextAttributes7.BOLD : 0, children: clip2(`${isSel ? "\u25B8 " : "  "}${row.label}`, Math.max(8, inner - valueW - 1)) }),
        /* @__PURE__ */ jsx8("text", { fg: isSel ? "white" : "gray", children: clip2(detail, valueW) })
      ] }, `${row.kind}:${row.label}`);
    }) }),
    /* @__PURE__ */ jsx8("box", { style: { width: inner, flexDirection: "row" }, children: /* @__PURE__ */ jsx8("text", { fg: "gray", children: clip2(filter || "type to filter \xB7 a model row switches this session \xB7 esc closes", inner) }) })
  ] });
}

// src/components/ServicesPanel.jsx
import React9 from "react";
import { TextAttributes as TextAttributes8 } from "@opentui/core";

// ../smartness.mjs
import fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
var CLI_DIR = path2.dirname(fileURLToPath(import.meta.url));
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
    const file = path2.join(os2.homedir(), ".hakster", "perf_history.json");
    const rows = JSON.parse(fs2.readFileSync(file, "utf8"));
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
function fileGuard(root2 = path2.resolve(CLI_DIR, "..")) {
  const present = [];
  const missing = [];
  for (const rel of IMPORTANT_FILES) {
    try {
      if (fs2.existsSync(path2.join(root2, rel))) present.push(rel);
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
import { jsx as jsx9, jsxs as jsxs9 } from "react/jsx-runtime";
var CELL_W = 16;
function servicesGridRows(width, count) {
  const inner = Math.max(1, (Number(width) || 80) - 4);
  const perRow = Math.max(1, Math.floor(inner / (CELL_W + 1)));
  const rows = Math.max(1, Math.ceil(Math.max(1, Number(count) || 1) / perRow));
  return 2 + rows * 2;
}
var clip3 = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}\u2026`;
};
function ServicesPanel({
  width = 100,
  services = [],
  scan = null,
  showAll = false
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
    return /* @__PURE__ */ jsx9("box", { style: { width: w, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: "gray", paddingLeft: 1, paddingRight: 1, flexShrink: 0 }, children: /* @__PURE__ */ jsxs9("text", { children: [
      /* @__PURE__ */ jsx9("span", { fg: "cyan", attributes: TextAttributes8.BOLD, children: "Services " }),
      /* @__PURE__ */ jsx9("span", { fg: allUp ? "green" : up > 0 ? "yellow" : "red", children: `${up}/${list.length} online  ` }),
      shown.map((s) => /* @__PURE__ */ jsx9("span", { fg: s.up ? "green" : "red", children: s.text }, s.port)),
      /* @__PURE__ */ jsx9("span", { fg: scanOk ? "gray" : "yellow", children: tail })
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
  } else if (others.length) {
    cells.push({
      key: "more",
      label: "other",
      value: `+${others.length} ports`,
      color: "cyan"
    });
  }
  return /* @__PURE__ */ jsx9(
    GridPanel_default,
    {
      title: "\u25A3 Services on ports",
      width: w,
      borderColor: "gray",
      hint: clip3(
        `${up}/${list.length} online${others.length ? ` \xB7 ${others.length} other ports` : ""}${scanOk ? "" : " \xB7 scan unavailable"}`,
        Math.max(6, w - 24)
      ),
      children: cells.map((c) => /* @__PURE__ */ jsx9(Cell, { label: c.label, value: c.value, w: CELL_W, color: c.color }, c.key))
    }
  );
}

// src/components/StatusBar.jsx
import React10 from "react";
import { TextAttributes as TextAttributes9 } from "@opentui/core";
import { jsx as jsx10, jsxs as jsxs10 } from "react/jsx-runtime";
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
function StatusBar({ width, status, model, cols, focus, adsOn, elapsedMs, hint, handoff }) {
  const known = status ? STATUS_STYLES[status] : null;
  const label = known ? known.text : status ? String(status) : "";
  const elapsed = status === "streaming" || status === "thinking" || status === "approval" ? formatElapsed(elapsedMs) : null;
  const right = [];
  if (label) {
    right.push(
      /* @__PURE__ */ jsx10("text", { fg: known ? known.color : "gray", children: label }, "status")
    );
  }
  if (elapsed) {
    right.push(/* @__PURE__ */ jsx10("text", { fg: "gray", children: elapsed }, "elapsed"));
  }
  if (model) {
    right.push(/* @__PURE__ */ jsx10("text", { fg: "yellow", children: model }, "model"));
  }
  if (handoff !== void 0 && handoff !== null) {
    right.push(
      /* @__PURE__ */ jsx10("text", { fg: handoff ? "green" : "red", children: handoff ? "handoff auto" : "handoff off" }, "handoff")
    );
  }
  if (cols !== void 0 && cols !== null) {
    right.push(/* @__PURE__ */ jsx10("text", { fg: "gray", children: `${cols}c` }, "cols"));
  }
  right.push(
    /* @__PURE__ */ jsx10("text", { fg: adsOn ? "green" : "red", children: adsOn ? "ads on" : "ads off" }, "ads")
  );
  const rightNodes = [];
  right.forEach((node, i) => {
    if (i > 0) {
      rightNodes.push(/* @__PURE__ */ jsx10("text", { fg: "gray", children: " \xB7 " }, `sep-${i}`));
    }
    rightNodes.push(node);
  });
  return /* @__PURE__ */ jsxs10("box", { style: { width, flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 }, children: [
    /* @__PURE__ */ jsxs10("box", { style: { flexDirection: "row" }, children: [
      focus === "ad" ? /* @__PURE__ */ jsx10("text", { fg: "cyan", attributes: TextAttributes9.BOLD, children: "\u27EA ad \u27EB" }) : /* @__PURE__ */ jsx10("text", { fg: "gray", children: "\u27EA composer \u27EB" }),
      hint ? /* @__PURE__ */ jsx10("text", { fg: "gray", children: `  ${hint}` }) : null
    ] }),
    /* @__PURE__ */ jsx10("box", { style: { flexDirection: "row" }, children: rightNodes })
  ] });
}

// src/components/SystemPanel.jsx
import React11 from "react";
import { TextAttributes as TextAttributes10 } from "@opentui/core";
import { jsx as jsx11, jsxs as jsxs11 } from "react/jsx-runtime";
var clip4 = (s, n) => {
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
    return /* @__PURE__ */ jsx11("box", { style: { width: w, flexDirection: "column", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }, children: /* @__PURE__ */ jsxs11("text", { children: [
      /* @__PURE__ */ jsx11("span", { fg: barColor("smart", score), attributes: TextAttributes10.BOLD, children: "\u{1F9E0} " }),
      /* @__PURE__ */ jsx11("span", { fg: barColor("smart", score), children: "\u2588".repeat(sc.filled) }),
      /* @__PURE__ */ jsx11("span", { fg: "gray", children: "\u2591".repeat(sc.empty) }),
      /* @__PURE__ */ jsx11("span", { fg: "white", attributes: TextAttributes10.BOLD, children: ` ${score}% ` }),
      /* @__PURE__ */ jsx11("span", { fg: arrowColor, children: arrow }),
      /* @__PURE__ */ jsx11("span", { fg: "gray", children: ` ${smartLabel(score)}` }),
      /* @__PURE__ */ jsx11("span", { fg: "gray", children: "   " }),
      /* @__PURE__ */ jsx11("span", { fg: barColor("points", points), attributes: TextAttributes10.BOLD, children: "\u2726 " }),
      /* @__PURE__ */ jsx11("span", { fg: barColor("points", points), children: "\u2588".repeat(ac.filled) }),
      /* @__PURE__ */ jsx11("span", { fg: "gray", children: "\u2591".repeat(ac.empty) }),
      /* @__PURE__ */ jsx11("span", { fg: "white", attributes: TextAttributes10.BOLD, children: ` ${points}p` }),
      /* @__PURE__ */ jsx11("span", { fg: "gray", children: " autolearn   " }),
      /* @__PURE__ */ jsx11("span", { fg: ctxPct > 85 ? "red" : ctxPct > 60 ? "yellow" : "green", children: "ctx " }),
      /* @__PURE__ */ jsx11("span", { fg: ctxPct > 85 ? "red" : ctxPct > 60 ? "yellow" : "green", children: "\u2588".repeat(cc.filled) }),
      /* @__PURE__ */ jsx11("span", { fg: "gray", children: "\u2591".repeat(cc.empty) }),
      /* @__PURE__ */ jsx11("span", { fg: "white", children: ` ${ctxPct}%` }),
      hostTxt ? /* @__PURE__ */ jsx11("span", { fg: "gray", children: "   " }) : null,
      hostTxt ? /* @__PURE__ */ jsx11("span", { fg: heat(cpuPct), children: `cpu ${cpuPct == null ? "\u2014" : `${cpuPct}%`}` }) : null,
      hostTxt ? /* @__PURE__ */ jsx11("span", { fg: heat(memPct), children: `  ram ${memPct == null ? "\u2014" : `${memPct}%`}` }) : null,
      hostTxt ? /* @__PURE__ */ jsx11("span", { fg: heat(swapPct), children: `  swap ${swapPct == null ? "\u2014" : `${swapPct}%`}` }) : null
    ] }) });
  }
  return /* @__PURE__ */ jsx11("box", { style: { width: w, flexDirection: "column", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }, children: /* @__PURE__ */ jsx11("text", { children: /* @__PURE__ */ jsx11("span", { fg: barColor("smart", score), attributes: TextAttributes10.BOLD, children: clip4(compact.length <= w ? compact : terse, Math.max(10, w - 2)) }) }) });
}

// src/components/CrushStatus.jsx
import React12, { useEffect as useEffect3, useState as useState3 } from "react";
import { jsx as jsx12, jsxs as jsxs12 } from "react/jsx-runtime";
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
  return /* @__PURE__ */ jsx12("box", { style: { width, flexDirection: "row", paddingLeft: 1, overflow: "hidden" }, children: /* @__PURE__ */ jsxs12("text", { children: [
    /* @__PURE__ */ jsx12("span", { fg: gradColor, children: "\u27E6" }),
    /* @__PURE__ */ jsx12("span", { fg: color, children: FRAMES[frame % FRAMES.length] }),
    /* @__PURE__ */ jsx12("span", { fg: gradColor, children: "\u27E7" }),
    " ",
    /* @__PURE__ */ jsx12("span", { children: info.emoji }),
    " ",
    /* @__PURE__ */ jsx12("span", { fg: info.color, children: normalizedPhase }),
    " ",
    /* @__PURE__ */ jsx12("span", { fg: "#a5b4c3", children: phrase }),
    " ",
    /* @__PURE__ */ jsx12("span", { fg: gradColor, children: shimmer }),
    " ",
    /* @__PURE__ */ jsx12("span", { fg: "gray", children: formatElapsed2(elapsedMs) })
  ] }) });
}

// src/components/TodoPanel.jsx
import React13 from "react";
import { TextAttributes as TextAttributes11 } from "@opentui/core";
import { jsx as jsx13, jsxs as jsxs13 } from "react/jsx-runtime";
var GLYPH_DONE = "\u2713";
var GLYPH_TODO = "\u25CB";
var EMPTY_TEXT = "No todos yet \u2014 the agent's checklist appears here once it creates one.";
function clip5(text, n) {
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
      /* @__PURE__ */ jsx13("text", { fg: "gray", children: clip5(EMPTY_TEXT, inner) }, "empty")
    );
  } else {
    visible.forEach((todo, i) => {
      const done = !!(todo && todo.done);
      const text = clip5(todo && todo.text || "", Math.max(0, inner - 2));
      rows.push(
        /* @__PURE__ */ jsxs13("box", { style: { width: "100%", flexDirection: "row" }, children: [
          /* @__PURE__ */ jsx13("text", { fg: done ? "green" : "gray", attributes: done ? 0 : TextAttributes11.DIM, children: done ? GLYPH_DONE : GLYPH_TODO }),
          /* @__PURE__ */ jsx13("text", { fg: done ? "white" : "gray", children: ` ${text}` })
        ] }, `row-${i}`)
      );
    });
    if (overflow > 0) {
      rows.push(
        /* @__PURE__ */ jsx13("text", { fg: "gray", children: `+${overflow} more` }, "more")
      );
    }
  }
  return /* @__PURE__ */ jsxs13("box", { style: { width, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: "gray", paddingLeft: 1, paddingRight: 1 }, children: [
    /* @__PURE__ */ jsx13("text", { fg: "cyan", attributes: TextAttributes11.BOLD, children: `Todos \u2014 ${completed}/${list.length} completed` }),
    rows,
    hint ? /* @__PURE__ */ jsx13("text", { fg: "gray", children: hint }) : null
  ] });
}

// src/components/Transcript.jsx
import React15 from "react";

// src/components/MessageBlock.jsx
import React14 from "react";
import { TextAttributes as TextAttributes12 } from "@opentui/core";
import { jsx as jsx14, jsxs as jsxs14 } from "react/jsx-runtime";
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
  const args = tool.args && Object.keys(tool.args).length ? ` ${JSON.stringify(tool.args).slice(0, 80)}` : "";
  return /* @__PURE__ */ jsxs14("box", { style: { flexDirection: "column", width }, children: [
    /* @__PURE__ */ jsxs14("text", { children: [
      /* @__PURE__ */ jsxs14("span", { fg: colour, children: [
        glyph,
        " "
      ] }),
      /* @__PURE__ */ jsx14("span", { fg: "white", children: tool.name || "tool" }),
      args ? /* @__PURE__ */ jsx14("span", { fg: "gray", children: args }) : null
    ] }),
    tool.result != null ? (
      // The whole result the server sent (it caps long output itself) —
      // a clipped 120-char preview hid what the agent actually saw.
      /* @__PURE__ */ jsx14("text", { fg: "gray", children: String(tool.result) })
    ) : null
  ] });
}
function MessageBlock({ message, width }) {
  if (!message) return null;
  const roleStyle = ROLE_STYLE[message.role] || ROLE_STYLE.system;
  const border = message.role === "system" && message.tone ? TONE_COLOR[message.tone] || roleStyle.border : roleStyle.border;
  const inner = Math.max(8, (width || 80) - 4);
  if (message.role === "system") {
    return /* @__PURE__ */ jsx14("box", { style: { width, border: true, borderStyle: "rounded", borderColor: border, paddingLeft: 1, paddingRight: 1 }, children: /* @__PURE__ */ jsx14("text", { fg: border, children: String(message.text || "") }) });
  }
  const tools = Array.isArray(message.tools) ? message.tools : [];
  return /* @__PURE__ */ jsxs14("box", { style: { width, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: border, paddingLeft: 1, paddingRight: 1 }, children: [
    /* @__PURE__ */ jsx14("text", { fg: border, attributes: TextAttributes12.BOLD, children: roleStyle.label }),
    message.thinking ? /* @__PURE__ */ jsx14("text", { fg: "gray", children: String(message.thinking) }) : null,
    message.images ? /* @__PURE__ */ jsx14("text", { fg: "gray", children: `\u{1F4CE} ${message.imageName || `${message.images} image`}` }) : null,
    message.text ? /* @__PURE__ */ jsx14("text", { fg: "white", children: String(message.text) }) : !message.thinking && tools.length === 0 ? /* @__PURE__ */ jsx14("text", { fg: "gray", children: "thinking\u2026" }) : null,
    tools.map((tool, i) => /* @__PURE__ */ jsx14(ToolRow, { tool, width: inner }, `tool-${i}`))
  ] });
}

// src/components/Transcript.jsx
import { jsx as jsx15, jsxs as jsxs15 } from "react/jsx-runtime";
var MAX_TURNS = 80;
function Transcript({ messages = [], width, height, emptyHint, scrollRef }) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) {
    return /* @__PURE__ */ jsx15("box", { style: { width, flexDirection: "column" }, children: /* @__PURE__ */ jsx15("text", { fg: "gray", children: emptyHint || "Ask for something and the agent runs it." }) });
  }
  const budget = Math.max(1, Number(height) || 20);
  const capped = list.slice(-MAX_TURNS);
  const hidden = list.length - capped.length;
  const contentW = Math.max(8, (Number(width) || 80) - 1);
  return /* @__PURE__ */ jsx15("box", { style: { width, height: budget, flexShrink: 0, overflow: "hidden" }, children: /* @__PURE__ */ jsxs15(
    "scrollbox",
    {
      ref: scrollRef,
      style: {
        width,
        height: budget,
        stickyScroll: true,
        stickyStart: "bottom",
        scrollY: true,
        scrollX: false,
        viewportCulling: true
      },
      children: [
        hidden > 0 ? /* @__PURE__ */ jsx15("text", { fg: "gray", children: `\u2026 ${hidden} earlier turn${hidden === 1 ? "" : "s"} (PgUp)` }) : null,
        /* @__PURE__ */ jsx15("box", { style: { flexDirection: "column", width: contentW }, children: capped.map((message) => /* @__PURE__ */ jsx15("box", { style: { marginBottom: 1 }, children: /* @__PURE__ */ jsx15(MessageBlock, { message, width: contentW }) }, message.id)) })
      ]
    }
  ) });
}

// src/hooks/useAgentStream.js
import { useCallback, useEffect as useEffect4, useRef, useState as useState4 } from "react";
var import_ladder = __toESM(require_ladder());
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
  approvalMode,
  // Owner's switch (2026-11-23): when a run fails before producing anything,
  // move to the next entry of the ladder (src/models/ladder.js). Off means the
  // run fails where it failed — no silent model change.
  autoHandoff = true
} = {}) {
  const [messages, setMessages] = useState4([]);
  const [todos, setTodos] = useState4([]);
  const [status, setStatus] = useState4("idle");
  const [error, setError] = useState4(null);
  const [elapsedMs, setElapsedMs] = useState4(0);
  const [pendingConfirm, setPendingConfirm] = useState4(null);
  const pendingConfirmRef = useRef(null);
  const meterRef = useRef(null);
  if (!meterRef.current) meterRef.current = createMeter();
  const [meters, setMeters] = useState4(() => meterRef.current.snapshot());
  const toolMetaRef = useRef(/* @__PURE__ */ new Map());
  const lastToolRef = useRef(null);
  const syncMeters = useCallback(() => setMeters(meterRef.current.snapshot()), []);
  const scoreTool = useCallback((name, args, result) => {
    try {
      const text = String(result == null ? "" : result).trim();
      const ok = !/^Error[:\n]|^❌/i.test(text);
      meterRef.current.tool(name || "tool", args || {}, ok, text);
      syncMeters();
    } catch {
    }
  }, [syncMeters]);
  const setPending = useCallback((value) => {
    pendingConfirmRef.current = value;
    setPendingConfirm(value);
  }, []);
  const abortRef = useRef(null);
  const userAbortRef = useRef(false);
  const attemptCtxRef = useRef({ produced: false, sawError: null, status: null });
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
  const drop = useCallback((id) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);
  const abort = useCallback(() => {
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
            patch(assistantId, (m) => ({ ...m, text: m.text + (evt.content || "") }));
            break;
          case "thinking_start":
            setStatusBoth("thinking");
            patch(assistantId, (m) => ({ ...m, thinking: "" }));
            break;
          case "thinking":
            setStatusBoth("thinking");
            attemptCtxRef.current.produced = true;
            patch(assistantId, (m) => ({ ...m, thinking: m.thinking + (evt.content || "") }));
            break;
          case "thinking_end":
            break;
          case "phase":
            if (evt.phase) patch(assistantId, (m) => ({ ...m, phase: evt.phase }));
            break;
          case "tool_call_start": {
            const name = evt.tool_name || "unknown";
            lastToolRef.current = { name, args: evt.tool_args || {} };
            if (evt.tool_call_id) toolMetaRef.current.set(evt.tool_call_id, lastToolRef.current);
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
            const meta = evt.tool_call_id && toolMetaRef.current.get(evt.tool_call_id) || lastToolRef.current;
            if (meta) scoreTool(meta.name, meta.args, result);
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
            const meta = evt.tool_call_id && toolMetaRef.current.get(evt.tool_call_id) || lastToolRef.current;
            if (meta) scoreTool(meta.name, meta.args, result);
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
            try {
              meterRef.current.bump(-10);
              syncMeters();
            } catch {
            }
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
            setStatusBoth("error");
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
      const runAttempt = async (target) => {
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
                {
                  role: "user",
                  content: images.length ? [{ type: "text", text: prompt }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] : prompt
                }
              ],
              stream: true,
              // Tier 3 sends neither, so the server's own waterfall decides —
              // that is what "others last" means here.
              ...target.provider ? { provider: target.provider } : {},
              ...target.model ? { model: target.model } : {},
              ...cwd ? { cwd } : {},
              ...sessionId ? { sessionId } : {},
              ...approvalMode ? { approvalMode } : {}
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
      setPending(null);
      setElapsedMs(startedAtRef.current ? Date.now() - startedAtRef.current : 0);
    },
    [api, append, approvalMode, autoHandoff, cwd, drop, model, patch, provider, sessionId, setPending, setStatusBoth, system]
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
    meters,
    pendingConfirm,
    answerConfirm,
    send,
    abort,
    clear
  };
}
var useAgentStream_default = useAgentStream;

// src/hooks/useHostStats.js
import { useEffect as useEffect5, useRef as useRef2, useState as useState5 } from "react";
import os3 from "node:os";
import fs3 from "node:fs";
var readText = (p) => {
  try {
    return fs3.readFileSync(p, "utf8");
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
    const s = fs3.statfsSync("/");
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    if (!Number.isFinite(total) || total <= 0) return null;
    return { total, free, pct: Math.round((1 - free / total) * 100) };
  } catch {
    return null;
  }
}
function useHostStats(intervalMs = 5e3) {
  const [stats, setStats] = useState5(null);
  const prevRef = useRef2(null);
  useEffect5(() => {
    const cores = Math.max(1, (os3.cpus() || []).length);
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
      const memTotal = mi.MemTotal || os3.totalmem();
      const memAvail = mi.MemAvailable != null ? mi.MemAvailable : os3.freemem();
      const swapTotal = mi.SwapTotal || 0;
      const swapFree = mi.SwapFree || 0;
      const d = disk();
      setStats({
        cores,
        cpuPct,
        load1: Math.round(((os3.loadavg() || [0])[0] || 0) * 100) / 100,
        memPct: memTotal ? Math.max(0, Math.min(100, Math.round((1 - memAvail / memTotal) * 100))) : null,
        memUsedGb: memTotal ? (memTotal - memAvail) / 1e9 : null,
        memTotalGb: memTotal ? memTotal / 1e9 : null,
        swapPct: swapTotal ? Math.max(0, Math.min(100, Math.round((1 - swapFree / swapTotal) * 100))) : null,
        swapUsedMb: swapTotal ? Math.round((swapTotal - swapFree) / 1e6) : null,
        swapTotalMb: swapTotal ? Math.round(swapTotal / 1e6) : null,
        diskPct: d ? d.pct : null,
        diskFreeGb: d ? d.free / 1e9 : null,
        diskTotalGb: d ? d.total / 1e9 : null,
        uptimeS: Math.round(os3.uptime())
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

// src/App.jsx
var import_ladder2 = __toESM(require_ladder());
var import_catalog = __toESM(require_catalog());
var import_ad_client2 = __toESM(require_ad_client());
import { Fragment as Fragment2, jsx as jsx16, jsxs as jsxs16 } from "react/jsx-runtime";
var API = process.env.HAKSTER_API_URL || "http://localhost:3579";
var MCP_OUTPUT_LINES = 4;
var MCP_OUTPUT_PANEL_ROWS = MCP_OUTPUT_LINES + 3;
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
var PREFS_PATH = path3.join(process.env.HOME || "/home/ghost", ".hakster", "tui-prefs.json");
function readPrefs() {
  try {
    return JSON.parse(fs4.readFileSync(PREFS_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}
function writePrefs(patch) {
  try {
    const next = { ...readPrefs(), ...patch };
    fs4.mkdirSync(path3.dirname(PREFS_PATH), { recursive: true });
    fs4.writeFileSync(PREFS_PATH, `${JSON.stringify(next, null, 2)}
`);
  } catch {
  }
}
var CRUSH_CONFIG_PATHS = [
  path3.join(process.env.HOME || "/home/ghost", ".crush.json"),
  path3.join(process.env.HOME || "/home/ghost", ".config", "crush", "crush.json")
];
function readCrushModels() {
  for (const p of CRUSH_CONFIG_PATHS) {
    try {
      const j = JSON.parse(fs4.readFileSync(p, "utf8"));
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
var clipLine = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}\u2026`;
};
function readImageAttachment(file) {
  const raw = String(file || "").trim();
  if (!raw) throw new Error("no file given");
  const abs = path3.resolve(raw.replace(/^~(?=\/)/, process.env.HOME || ""));
  const mime = IMAGE_MIME[path3.extname(abs).toLowerCase()];
  if (!mime) throw new Error("not an image (png, jpg, webp, gif, bmp)");
  const st = fs4.statSync(abs);
  if (!st.isFile()) throw new Error("not a file");
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(`too large (${Math.round(st.size / 1024 / 1024)}MB, max 12MB)`);
  }
  const buf = fs4.readFileSync(abs);
  return {
    path: abs,
    name: path3.basename(abs),
    bytes: buf.length,
    dataUrl: `data:${mime};base64,${buf.toString("base64")}`
  };
}
function App({ version = "0.1.0" }) {
  const renderer2 = useRenderer();
  const { width: cols, height: rows } = useTerminalDimensions();
  const [view, setView] = useState6("chat");
  const [focus, setFocus] = useState6("composer");
  const [adsOn, setAdsOn] = useState6(true);
  const [dockExpanded, setDockExpanded] = useState6(false);
  const [draft, setDraft] = useState6("");
  const [model, setModel] = useState6(process.env.HAKSTER_MODEL && !/^glm/i.test(process.env.HAKSTER_MODEL) ? process.env.HAKSTER_MODEL : import_ladder2.PRIMARY_MODEL);
  const [provider, setProvider] = useState6(process.env.HAKSTER_PROVIDER || import_ladder2.PRIMARY_PROVIDER);
  const [modelIdx, setModelIdx] = useState6(0);
  const prefsRef = useRef3(null);
  if (!prefsRef.current) prefsRef.current = readPrefs();
  const [handoffOn, setHandoffOn] = useState6(() => prefsRef.current.autoHandoff !== false);
  const [status, setStatus] = useState6(null);
  const [statusErr, setStatusErr] = useState6(null);
  const [mcp, setMcp] = useState6(null);
  const [history, setHistory] = useState6([]);
  const [mcpOutputOffset, setMcpOutputOffset] = useState6(0);
  const [menuOpen, setMenuOpen] = useState6(false);
  const [menuIndex, setMenuIndex] = useState6(0);
  const [menuQuery, setMenuQuery] = useState6("");
  const [notice, setNotice] = useState6(null);
  const [scan, setScan] = useState6({ ok: false, ports: [], procs: {}, at: 0 });
  const [guard, setGuard] = useState6(null);
  const [pointsHistory, setPointsHistory] = useState6([]);
  const [attachment, setAttachment] = useState6(null);
  const scrollRef = useRef3(null);
  const agent = useAgentStream_default({
    api: API,
    model,
    provider,
    system: SYSTEM,
    cwd: process.env.HAKSTER_AGENT_CWD || null,
    autoHandoff: handoffOn
  });
  useEffect6(() => {
    writePrefs({ autoHandoff: handoffOn });
  }, [handoffOn]);
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
  useEffect6(() => {
    load();
    const t = setInterval(load, 3e3);
    return () => clearInterval(t);
  }, [load]);
  useEffect6(() => {
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
    tick();
    const t = setInterval(tick, 3e4);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  useEffect6(() => {
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
  useEffect6(() => {
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
  useEffect6(() => {
    setPointsHistory((h) => [...h.slice(-59), meterPoints]);
  }, [meterPoints]);
  const models = import_catalog.default.REFERENCE_CATALOG || [];
  const pickerModels = [
    { key: "__claude", vendor: "Claude", value: `Claude \xB7 ${import_ladder2.PRIMARY_MODEL}`, model: import_ladder2.PRIMARY_MODEL, provider: import_ladder2.PRIMARY_PROVIDER },
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
  const host = useHostStats(5e3);
  const services = serviceStates(scan);
  const otherPorts = otherListening(scan);
  const showNotice = useCallback2((text) => {
    setNotice(text);
    setTimeout(() => setNotice((cur) => cur === text ? null : cur), 6e3);
  }, []);
  const runCommand = useCallback2((raw) => {
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
        const live = list.filter((x) => x.initialized || (x.toolCount || 0) > 0).length;
        const tools = list.reduce((n, x) => n + (Number(x.toolCount) || 0), 0);
        const names = list.filter((x) => x.initialized || (x.toolCount || 0) > 0).slice(0, 5).map((x) => `${x.name}(${x.toolCount || 0})`).join(" \xB7 ");
        showNotice(`MCP ${live}/${list.length} live \xB7 ${tools} tools \xB7 ${names}${list.length > 5 ? " \u2026" : ""}`);
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
      case "/status":
        showNotice(status ? `phase ${status.phase} \xB7 model ${status.model} \xB7 tokens ${status.tokens} \xB7 trust ${status.trust} \xB7 ${status.connected ? "connected" : "offline"}` : `server ${statusErr || "connecting\u2026"}`);
        return;
      case "/clear":
        agent.clear();
        showNotice("transcript cleared");
        return;
      case "/help":
        showNotice("keys: tab focus \xB7 pgup/pgdn scroll \xB7 ^P catalog \xB7 h handoff \xB7 d dashboard \xB7 m models \xB7 c clear \xB7 q quit \xB7 esc stop \u2014 commands: /menu /model /mcp /handoff /ports /attach /dashboard /status /clear /quit");
        return;
      case "/quit":
      case "/exit":
        agent.abort();
        renderer2.destroy();
        return;
      default:
        showNotice(`unknown command ${cmd} \u2014 /menu lists them`);
    }
  }, [agent, models, model, mcp, status, statusErr, renderer2, showNotice, services, otherPorts, scan, handoffOn]);
  const crushModelList = useRef3(null);
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
      label: s.name,
      detail: `${s.toolCount == null ? "?" : s.toolCount} tools${s.initialized === false ? " \xB7 down" : ""}`,
      action: { cmd: "/mcp" }
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
  const applyCatalogRow = useCallback2((row) => {
    if (!row || !row.action) return;
    if ("model" in row.action) {
      setModel(row.action.model || "");
      setProvider(row.action.provider || import_ladder2.PRIMARY_PROVIDER);
      showNotice(`model \u2192 ${row.action.model || row.label} \xB7 provider ${row.action.provider || import_ladder2.PRIMARY_PROVIDER}`);
      return;
    }
    if (row.action.cmd) runCommand(row.action.cmd);
  }, [runCommand, showNotice]);
  const submit = useCallback2(
    (text) => {
      const v = String(text == null ? "" : text).trim();
      if (!v) return;
      if (v.startsWith("/")) {
        setDraft("");
        runCommand(v);
        return;
      }
      if (agent.busy) return;
      const att = attachment;
      setDraft("");
      setAttachment(null);
      agent.send(v, att ? { images: [att.dataUrl], imageName: att.name } : void 0);
    },
    [agent, attachment, runCommand]
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
  useEffect6(() => {
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
    if (process.env.HAKSTER_TUI_KEYLOG) {
      try {
        fs4.appendFileSync(process.env.HAKSTER_TUI_KEYLOG, JSON.stringify({ name: key.name, ctrl: !!key.ctrl, meta: !!key.meta, shift: !!key.shift }) + "\n");
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
          setView("chat");
          showNotice(`model \u2192 ${pick.value} \xB7 provider ${pick.provider || import_ladder2.PRIMARY_PROVIDER}`);
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
    if (key.name === "pageup" || key.name === "pagedown") {
      const box = scrollRef.current;
      if (box && typeof box.scrollBy === "function") {
        box.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
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
    if (key.ctrl && latestMcpTool && (key.name === "up" || key.name === "down")) {
      setMcpOutputOffset((offset) => Math.max(0, Math.min(mcpMaxOffset, offset + (key.name === "up" ? -1 : 1))));
      return;
    }
    if (key.ctrl || key.meta) return;
    switch (key.name) {
      case "a":
        setAdsOn((v) => !v);
        break;
      case "h": {
        const want = !handoffOn;
        setHandoffOn(want);
        showNotice(want ? `auto handoff ON \u2014 ${import_ladder2.MODEL_LADDER.map((e) => e.label).join(" \u2192 ")}` : "auto handoff OFF \u2014 a failed run stays on its model");
        break;
      }
      case "d":
        setView((v) => v === "chat" ? "dashboard" : "chat");
        break;
      case "m":
        setModelIdx(pickerIndexFor(model, provider));
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
  const headerState = statusErr ? "OFFLINE" : status ? "ONLINE" : "connecting\u2026";
  const ctxK = Math.round(ctxMax / 1e3);
  const ctxPart = model ? `ctx ${ctxK}K` : null;
  const headerRightVariants = [
    ["tui " + version, view, modelText, ctxPart].filter(Boolean).join(" \xB7 "),
    [view, modelText, ctxPart].filter(Boolean).join(" \xB7 "),
    [view, modelText].filter(Boolean).join(" \xB7 "),
    [view, ctxPart].filter(Boolean).join(" \xB7 "),
    view
  ];
  const headerInner = panelW - 2;
  const guardTxt = guard ? `${guard.present}/${guard.total} files` : "";
  const headerLeftLen = (withFiles) => `\u25CF \u25C6 haksterAi \xB7 ${headerState}`.length + (withFiles && guardTxt ? `   ${guardTxt}`.length : 0);
  const showGuard = !!guardTxt && headerLeftLen(true) + 8 <= headerInner;
  const headerFiles = showGuard ? guardTxt : "";
  const headerLeftText = headerLeftLen(showGuard);
  const headerRight = headerRightVariants.find((t) => headerLeftText + t.length + 2 <= headerInner) || "";
  const sideW = (cols || 100) >= 96 ? 30 : 0;
  const mainW = panelW - (sideW ? sideW + 2 : 0);
  const systemRows = 1;
  const servicesCellCount = services.length + (otherPorts.length ? 1 : 0);
  const servicesRows = mainW < 96 ? 3 : servicesGridRows(mainW, servicesCellCount);
  const sidebarBudget = Math.max(0, (rows || 30) - 1 - 1 - 5 - 2 - 7 - 2 - systemRows - servicesRows);
  const maxServers = Math.max(0, Math.min(8, sidebarBudget));
  const CHROME_ROWS = 1 + 1 + (showCrushStatus ? 1 : 0);
  const MENU_ROWS = Math.max(10, Math.min(26, (rows || 30) - 12));
  const composerRows = menuOpen ? MENU_ROWS : 5;
  const noticeRows = notice ? 1 : 0;
  const railRows = dockExpanded ? 7 : 1;
  const todoRows = agent.todos.length ? Math.min(agent.todos.length, 6) + 4 : 0;
  const approvalRows = approving ? 6 : 0;
  const transcriptRows = Math.max(
    4,
    (rows || 30) - CHROME_ROWS - noticeRows - composerRows - railRows - todoRows - approvalRows - systemRows - servicesRows - (latestMcpTool ? MCP_OUTPUT_PANEL_ROWS : 0)
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
        { label: "model", value: modelText, color: "yellow" },
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
  return /* @__PURE__ */ jsxs16("box", { style: { flexDirection: "column", width: cols || 100, height: rows || 30, overflow: "hidden" }, children: [
    /* @__PURE__ */ jsxs16("box", { style: { width: panelW, flexDirection: "row", justifyContent: "space-between", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }, children: [
      /* @__PURE__ */ jsxs16("box", { style: { flexDirection: "row" }, children: [
        /* @__PURE__ */ jsx16("text", { fg: status ? statusErr ? "red" : "green" : "yellow", attributes: TextAttributes13.BOLD, children: statusErr ? "\u25CB " : status ? "\u25CF " : "\u25CC " }),
        /* @__PURE__ */ jsx16("text", { fg: "cyan", attributes: TextAttributes13.BOLD, children: "\u25C6 haksterAi" }),
        /* @__PURE__ */ jsx16("text", { fg: statusErr ? "red" : status ? "green" : "yellow", children: ` \xB7 ${headerState}` }),
        headerFiles ? /* @__PURE__ */ jsx16("text", { fg: guard.missing && guard.missing.length ? "red" : "gray", children: `   ${headerFiles}` }) : null
      ] }),
      headerRight ? /* @__PURE__ */ jsx16("text", { fg: "gray", children: headerRight }) : null
    ] }),
    statusErr ? /* @__PURE__ */ jsx16("box", { style: { width: panelW, border: true, borderStyle: "rounded", borderColor: "red", paddingLeft: 1, paddingRight: 1 }, children: /* @__PURE__ */ jsxs16("text", { fg: "red", children: [
      "server unreachable \u2014 ",
      statusErr
    ] }) }) : null,
    view === "models" ? /* @__PURE__ */ jsx16(GridPanel_default, { title: "Models", width: panelW, hint: "\u2191\u2193 select \xB7 enter apply \xB7 esc back", children: pickerModels.map((m, i) => /* @__PURE__ */ jsx16(
      Cell,
      {
        label: m.vendor,
        value: `${i === modelIdx ? "\u25B8 " : ""}${m.value}`,
        w: Math.max(1, Math.floor((panelW - 6) / 2)),
        color: i === modelIdx ? "yellow" : "white"
      },
      m.key
    )) }) : view === "dashboard" ? /* @__PURE__ */ jsxs16(Fragment2, { children: [
      /* @__PURE__ */ jsx16(
        GridLayout_default,
        {
          items: dashboardItems,
          availableWidth: panelW,
          getItemKey: (item) => item.key,
          renderItem: (item, index, columnWidth) => /* @__PURE__ */ jsx16(GridPanel_default, { title: item.title, width: columnWidth, hint: item.hint, children: item.cells.map((c) => /* @__PURE__ */ jsx16(Cell, { label: c.label, value: c.value, color: c.color, w: Math.max(1, Math.floor((columnWidth - 6) / 2)) }, c.label)) })
        }
      ),
      /* @__PURE__ */ jsxs16(
        GridPanel_default,
        {
          title: "\u25C9 Meters",
          width: panelW,
          hint: `${smartLabel(meters ? meters.score : 0)} \xB7 ${meterPoints}p autolearn \xB7 ${import_catalog.default.labelFor(import_catalog.default.findModel(model) || { id: modelText, vendor: "local", context: null })}`,
          children: [
            /* @__PURE__ */ jsxs16("box", { style: { width: Math.max(10, panelW - 4), flexDirection: "row", flexShrink: 0 }, children: [
              /* @__PURE__ */ jsx16("text", { fg: "gray", children: "smartness   " }),
              /* @__PURE__ */ jsx16(Meter, { value: meters ? meters.score : 0, max: 100, w: Math.min(40, Math.max(10, panelW - 40)), color: barColor("smart", meters ? meters.score : 0) }),
              /* @__PURE__ */ jsx16("text", { fg: "white", children: ` ${meters ? meters.score : 0}% ${meters && meters.delta > 0 ? "\u25B2" : meters && meters.delta < 0 ? "\u25BC" : "\u25C6"} ${smartLabel(meters ? meters.score : 0)}` })
            ] }),
            /* @__PURE__ */ jsxs16("box", { style: { width: Math.max(10, panelW - 4), flexDirection: "row", flexShrink: 0 }, children: [
              /* @__PURE__ */ jsx16("text", { fg: "gray", children: "autolearn   " }),
              /* @__PURE__ */ jsx16(Meter, { value: Math.min(100, meterPoints), max: 100, w: Math.min(40, Math.max(10, panelW - 40)), color: barColor("points", meterPoints) }),
              /* @__PURE__ */ jsx16("text", { fg: "white", children: ` ${meterPoints}p` }),
              /* @__PURE__ */ jsx16("box", { style: { marginLeft: 2 }, children: /* @__PURE__ */ jsx16(Spark, { data: pointsHistory, w: Math.min(24, Math.max(8, panelW - 70)) }) })
            ] }),
            /* @__PURE__ */ jsxs16("box", { style: { width: Math.max(10, panelW - 4), flexDirection: "row", flexShrink: 0 }, children: [
              /* @__PURE__ */ jsx16("text", { fg: "gray", children: "context     " }),
              /* @__PURE__ */ jsx16(Meter, { value: ctxUsed, max: ctxMax, w: Math.min(40, Math.max(10, panelW - 40)), color: ctxUsed / ctxMax > 0.8 ? "red" : "green" }),
              /* @__PURE__ */ jsx16("text", { fg: "white", children: ` ${Math.round(ctxUsed / ctxMax * 100)}%` })
            ] })
          ]
        }
      ),
      /* @__PURE__ */ jsx16(ServicesPanel, { width: panelW, services, scan, showAll: true })
    ] }) : /* @__PURE__ */ jsxs16("box", { style: { flexDirection: "row", width: panelW, flexGrow: 1, flexShrink: 1, overflow: "hidden" }, children: [
      /* @__PURE__ */ jsxs16("box", { style: { width: mainW, flexDirection: "column", flexShrink: 0, overflow: "hidden" }, children: [
        agent.todos.length ? /* @__PURE__ */ jsx16("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx16(
          TodoPanel,
          {
            todos: agent.todos,
            width: mainW,
            hint: "the agent's checklist \xB7 updates live",
            maxVisibleRows: Math.min(agent.todos.length, 6)
          }
        ) }) : null,
        /* @__PURE__ */ jsx16("box", { style: { flexGrow: 1, flexShrink: 1, overflow: "hidden" }, children: /* @__PURE__ */ jsx16(
          Transcript,
          {
            messages: agent.messages,
            width: mainW,
            height: transcriptRows,
            scrollRef,
            emptyHint: "Type a task and the agent runs it with tools. /attach <path> sends an image. PgUp/PgDn scroll the transcript; esc stops a run."
          }
        ) }),
        latestMcpTool ? /* @__PURE__ */ jsx16(
          GridPanel_default,
          {
            title: `MCP Output \xB7 ${String(latestMcpTool.name || "").split("__")[1] || "server"}`,
            width: mainW,
            borderColor: "magenta",
            hint: `${Math.min(mcpOutputOffset + 1, mcpOutputLines.length)}-${Math.min(mcpOutputOffset + MCP_OUTPUT_LINES, mcpOutputLines.length)}/${mcpOutputLines.length} \xB7 Ctrl+\u2191/\u2193`,
            children: /* @__PURE__ */ jsx16("box", { style: { flexDirection: "column", width: Math.max(1, mainW - 4) }, children: visibleMcpOutput.map((line, index) => {
              return /* @__PURE__ */ jsx16("text", { fg: "white", children: String(line || " ") }, `mcp-output-${index}`);
            }) })
          }
        ) : null,
        showCrushStatus ? /* @__PURE__ */ jsx16("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx16(
          CrushStatus,
          {
            width: mainW,
            phase: crushPhase,
            activity: activeTool?.name || "",
            elapsedMs: agent.elapsedMs
          }
        ) }) : null,
        /* @__PURE__ */ jsx16("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx16(
          DockAd,
          {
            width: mainW,
            placementId: import_ad_client2.default.PLACEMENTS.tuiRail,
            enabled: adsOn,
            focused: focus === "ad",
            expanded: dockExpanded
          }
        ) }),
        approving ? /* @__PURE__ */ jsx16("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx16(
          ApprovalPrompt,
          {
            width: mainW,
            request: agent.pendingConfirm,
            onAnswer: answerApproval
          }
        ) }) : null,
        notice ? /* @__PURE__ */ jsx16("box", { style: { flexShrink: 0, width: mainW }, children: /* @__PURE__ */ jsx16("text", { fg: "cyan", children: clipLine(`\u25C6 ${notice}`, Math.max(8, mainW - 2)) }) }) : null,
        /* @__PURE__ */ jsx16(SystemPanel, { width: mainW, meters, ctxUsed, ctxMax, host }),
        /* @__PURE__ */ jsx16(ServicesPanel, { width: mainW, services, scan }),
        /* @__PURE__ */ jsx16("box", { style: { flexShrink: 0 }, children: menuOpen ? /* @__PURE__ */ jsx16(
          CatalogPopout,
          {
            width: Math.min(mainW, 76),
            height: MENU_ROWS,
            rows: catalogRows,
            selectable: catalogSelectable,
            selected: menuIndex,
            query: menuQuery
          }
        ) : /* @__PURE__ */ jsx16(
          Composer,
          {
            width: mainW,
            value: draft,
            onChange: setDraft,
            onSubmit: submit,
            focused: focus === "composer" && !approving,
            disabled: agent.busy,
            hint: approving ? "answer the request above \u2014 it is holding the run" : agent.busy ? "esc stop \xB7 the run is streaming" : attachment ? `\u{1F4CE} ${attachment.name} ${Math.round(attachment.bytes / 1024)}K \xB7 enter sends it \xB7 /attach clear` : "enter send \xB7 /menu commands \xB7 /attach image \xB7 pgup scroll \xB7 q quit",
            adSlot: /* @__PURE__ */ jsx16(
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
        ) })
      ] }),
      sideW ? /* @__PURE__ */ jsx16("box", { style: { marginLeft: 1 }, children: /* @__PURE__ */ jsx16(
        LiveSidebar,
        {
          width: sideW,
          agentStatus: agent.status,
          phase: crushPhase,
          tool: activeTool?.name || "",
          turns: agent.messages.filter((m) => m.role === "user").length,
          elapsedMs: agent.elapsedMs,
          model,
          version,
          mcp,
          serverOk: !statusErr && !!status,
          maxServers
        }
      ) }) : null
    ] }),
    /* @__PURE__ */ jsx16("box", { style: { flexShrink: 0 }, children: /* @__PURE__ */ jsx16(
      StatusBar,
      {
        width: panelW,
        status: agent.status,
        model: modelText,
        cols: cols || 100,
        focus,
        adsOn,
        elapsedMs: agent.elapsedMs,
        handoff: handoffOn,
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
  root.render(React17.createElement(App, { version }));
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
