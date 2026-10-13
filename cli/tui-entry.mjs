/* Bun entry point for the OpenTUI TUI.
 *
 * cli/index.js spawns `bun tui-entry.mjs` when `hakster tui` is invoked under
 * Node, because @opentui/core loads a native Zig binary via Bun's FFI. When
 * the CLI is already running under Bun, index.js imports ui-fb.mjs directly
 * instead.
 */
import { start } from './ui-fb.mjs';

start({ version: process.env.HAKSTER_TUI_VERSION || '0.1.0' });