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
import { start } from './ui-fb.mjs';

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

start({ version: process.env.HAKSTER_TUI_VERSION || '0.1.0' });
