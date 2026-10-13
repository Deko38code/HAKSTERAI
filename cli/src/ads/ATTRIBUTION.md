# Attribution — ported modules

The files in this directory, and the TUI chrome tabulated below, are derived
from **Freebuff / Codebuff**, which is licensed under the **Apache License,
Version 2.0**.

- Source: https://github.com/CodebuffAI/freebuff
- Licence: Apache-2.0 (see that repository's `LICENSE`)
- Notice: `Codebuff — Copyright 2025 Codebuff. This product includes software
  developed for the Codebuff project.` (their `NOTICE` file)

## What was derived, and from where

| File here | Derived from (upstream path) |
|---|---|
| `terminal-safe-text.js` | `common/src/util/terminal-safe-text.ts` |
| `inline-ad-layout.js` | `common/src/ads/inline-ad-layout.ts` |
| `ad-cache.js` | `cli/src/ads/partner-ads.ts`, `cli/src/ads/ad-signals.ts` |
| `ad-client.js` | `cli/src/ads/ad-request.ts` |

The dashboard chrome around the ad slots is derived from the same source, and is
tabulated here because it is the other half of the same port:

| File here | Derived from (upstream path) |
|---|---|
| `../ui/src/utils/layout-helpers.js` | `cli/src/utils/layout-helpers.ts` |
| `../ui/src/hooks/useGridLayout.js` | `cli/src/hooks/use-grid-layout.ts` |
| `../ui/src/components/GridLayout.jsx` | `cli/src/components/grid-layout.tsx` |
| `../ui/src/components/StatusBar.jsx` | `cli/src/components/status-bar.tsx` |
| `../ui/src/components/TodoPanel.jsx` | `cli/src/components/todo-panel.tsx` |

Each of those files carries the change notice inline as well, at the top of the
file, as section 4(b) asks.

## Changes made

Per section 4(b) of the Apache-2.0 licence, the modifications are:

1. **Language (the four ad modules)** — TypeScript converted to CommonJS
   JavaScript (`.js`), so these modules can be `require`d by the CommonJS CLI in
   this package as well as bundled into the Ink TUI by esbuild. The chrome files
   in `../ui/src/` are ESM/JSX instead, because they are bundled only; see item
   6 below.
2. **`terminal-safe-text.js`** — behaviour preserved. `sanitizeTerminalStrings`
   narrowed to plain objects and arrays, and extended to drop `__proto__`,
   `constructor` and `prototype` keys so a crafted payload cannot pollute
   prototypes.
3. **`inline-ad-layout.js`** — the Dock V2 expandable-panel layout was dropped
   as unused. `getInlineAdLayout`, `truncateToWidth`, `truncateToLines`,
   `extractDomain`, `getAdDisplayLabel` and `wrapToLines` are preserved.
4. **`ad-cache.js`** — the timing rules (hold, in-flight dedupe, one impression
   per held answer, cache-owner sync, the four refusals) are preserved. The
   placement registry, the policy endpoint, the dock-arm and the telemetry
   shipping were replaced by **injected dependencies**, so the module is
   dependency-free and drivable by a test with a fake clock.
5. **`ad-client.js`** — rewritten against this harness's own endpoint
   (`HAKSTER_ADS_URL`). Freebuff's auth token, device fingerprint, dock arm,
   sponsored-capability probe and provider chain are removed. Only the
   placement, surface and session id are sent.
6. **TUI chrome** — the five files listed under "the other half of the same
   port" above. Freebuff renders its terminal UI with **OpenTUI**
   (`@opentui/core`: `<box>`, `<text>`, `<span>`, `style={{...}}`,
   `TextAttributes`) and this harness now does the same. The pure layout
   maths in `layout-helpers.js` and `useGridLayout.js` port verbatim, and
   `GridLayout.jsx`, `StatusBar.jsx` and `TodoPanel.jsx` are transliterations
   of the upstream OpenTUI components rather than rewrites against a different
   framework. Everything that read from Freebuff's own stores was dropped,
   since this harness has no equivalents: `useChatStore`, `useTheme`,
   `useFreebuffSessionProgress`, the Freebucks and session-countdown logic,
   the BYOK selection store, `ClickableTitleBox`, and the scrollbox.
   `React.memo` was dropped from `GridLayout` as well: its default shallow
   comparison would hide a terminal-width change behind an identity check.
   The TUI runs under **Bun** (not Node) because `@opentui/core` loads a
   native Zig binary via Bun's FFI; `cli/index.js` re-execs under Bun when
   the `tui` subcommand is invoked from Node.

## Not derived

The ad **inventory** is not derived from anywhere. `server/src/ads.js` serves
house creative for sites this harness operates. Nothing was scraped from
Freebuff's ad service, and no third-party advertiser data is included.

## Trademarks

Apache-2.0 grants **no** trademark rights. This harness must not present itself
as Freebuff or Codebuff, or use their names or logos as its own branding.
