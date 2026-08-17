# Stealth-Bot Upgrade Bug Report
*Date: 2026-08-17*

## Bug #1: Duplicate execSync Import (FIXED)

**File**: `/home/ghost/haksterAi/pentest-agents/stealth-bot-mcp.cjs`
**Severity**: Critical — crashed server on startup
**Error**: `SyntaxError: Identifier 'execSync' has already been declared`
**Root Cause**: Patch added `const { execSync } = require('child_process')` at line 30, but line 37 already had `const { spawn, execSync, execFileSync } = require('child_process')`
**Fix**: Removed duplicate import from patch. Server now loads: `[stealth-bot] stealth-bot-mcp ready (v22) (headless)`
**Status**: ✅ FIXED

## Bug #2: patchright Global Install Not Resolved (FIXED)

**File**: Node.js module resolution
**Severity**: Medium — patchright not found by require()
**Error**: `Cannot find module 'patchright'`
**Root Cause**: `npm install -g patchright` installed globally but Node couldn't find it from /tmp or other dirs
**Fix**: `npm install patchright` locally in pentest-agents/ directory
**Status**: ✅ FIXED

## Bug #3: patchright Chromium Not Installed (FIXED)

**Severity**: Medium — browser navigation timed out
**Error**: `page.goto: Timeout 15000ms exceeded`
**Root Cause**: patchright uses its own Chromium binary, separate from Playwright's
**Fix**: `npx patchright install chromium` (downloaded fallback build for ubuntu24.04)
**Status**: ✅ FIXED

## Bug #4: ESM/CJS Conflict (FIXED)

**Severity**: Low — test file only
**Error**: `ReferenceError: require is not defined in ES module scope`
**Root Cause**: haksterAi package.json has `"type": "module"`, so .js files are treated as ESM
**Fix**: Renamed test file to .cjs extension
**Status**: ✅ FIXED

## Bug #5: stealth-bot MCP Not Auto-Reconnecting After Restart (OPEN)

**Severity**: Low — server works standalone, just doesn't reconnect to live session
**Error**: `MCP server "stealth-bot" not connected`
**Root Cause**: After PM2 restart of haksterAI, the stealth-bot MCP server needs a session reconnect. Standalone test passes (14 tools discovered).
**Fix**: Needs manual MCP reconnect or haksterAI session restart
**Status**: ⚠️ OPEN — server works when tested standalone, just needs session reconnect

## Test Results

### cloudscraper_fetch — ✅ PASS
- URL: https://nowsecure.nl (Cloudflare-protected)
- Status: 200 OK
- CF-Ray: a2c5a396fd4da495-SMF (confirmed Cloudflare bypassed)
- Body: 179,825 bytes, `<title>` found

### patchright stealth — ✅ PASS
- URL: https://example.com
- Title: "Example Domain"
- `navigator.webdriver`: **false** (stealth working — not detected as bot)

### MCP standalone test — ✅ PASS
- 14 tools discovered: stealth_navigate, solve_captcha, human_type, human_click, fill_form, screenshot, get_page_content, **cloudscraper_fetch**, solve_cloudflare, solve_recaptcha, solve_image_captcha, stealth_session, bypass_check, kimi_vision
- Init + tools/list handshake succeeded in 1008ms