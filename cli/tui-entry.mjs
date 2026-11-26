/* Bun entry point for the OpenTUI TUI.
 *
 * cli/index.js spawns `bun tui-entry.mjs` when `hakster tui` is invoked under
 * Node, because @opentui/core loads a native Zig binary via Bun's FFI. When
 * the CLI is already running under Bun, index.js imports ui-fb.mjs directly
 * instead.
 *
 * Sign-in (owner, 2026-11-23): launched directly, this entry used to skip the
 * config load index.js does, so /api/agent/run ran anonymously and the server
 * answered with its 5 safe tools instead of the owner's full set. The key is
 * read here in-process from the same config.json `hakster init` writes, so a
 * direct launch is signed in exactly like `hakster tui`. The value is never
 * printed, logged or put in argv (§23).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.HAKSTER_API_KEY) {
  try {
    const cfgPath = path.join(os.homedir(), '.hakster', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg && typeof cfg.apiKey === 'string' && cfg.apiKey) {
      process.env.HAKSTER_API_KEY = cfg.apiKey;
    }
  } catch {
    /* no config: run as before, unsigned — the caller sees the reduced tool set */
  }
}

// Update on launch: if an earlier session downloaded and verified a newer CLI,
// swap it in before the bundle is imported, so this session runs the new code
// (the Claude Code model: update in-session, apply on restart). The import is
// dynamic for exactly that reason — a static import would load the old bundle
// before this runs. A failed apply must never stop the TUI.
// The updater is also bundled into ui-fb.mjs, where __dirname is the bundle's
// directory; this entry knows the real CLI directory, so it tells the updater.
process.env.HAKSTER_CLI_DIR = process.env.HAKSTER_CLI_DIR || path.dirname(fileURLToPath(import.meta.url));
try {
  const mod = await import('./src/updater.js');
  const updater = mod && typeof mod.applyPending === 'function' ? mod : mod && mod.default;
  if (updater) {
    // A staged package is applied here before the bundle is imported, without
    // asking (owner, 2026-11-26: "need ours auto like claude does"). The old
    // [i/w] choice is still reachable with HAKSTER_UPDATE_PROMPT=ask.
    let go = true;
    if (typeof updater.promptStagedUpdate === 'function') {
      const choice = await updater.promptStagedUpdate();
      if (choice && choice.action === 'wait') {
        go = false;
        process.stderr.write(`⬆ CLI v${choice.pending.version} is staged — will ask again on the next start.\n`);
      }
    }
    const applied = go && typeof updater.applyPending === 'function' ? updater.applyPending() : null;
    if (applied && applied.applied) {
      process.stderr.write(`✓ CLI updated to v${applied.version} (was v${applied.from})\n`);
    } else if (applied && applied.superseded) {
      /* The record names a build this install has already passed: there is no
       * update here, so there is nothing to report (§10 — never announce a
       * downgrade, never call a non-update a failed one). */
    } else if (applied && applied.reason && applied.reason !== 'current' && applied.reason !== 'already applied') {
      process.stderr.write(`⬆ update not applied: ${applied.reason}\n`);
    }
  }
} catch {
  /* updater unavailable or stage unusable — open the TUI as it is */
}

// Report the version this copy actually carries — the same package.json the
// installer ships and /cli/latest.json publishes, so the splash, header and
// widget cannot drift apart.
function readVersion() {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

const { start } = await import('./ui-fb.mjs');
start({ version: process.env.HAKSTER_TUI_VERSION || readVersion() });
