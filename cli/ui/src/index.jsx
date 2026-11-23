import React from 'react';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import App from './App.jsx';
import prefs from '../../src/prefs.js';

/* Entry point for the `hakster tui` command, mirroring how `hakster ui`
 * imports ../ui.mjs and calls start().
 *
 * The terminal setup (raw mode, alternate screen, restore handlers) is owned
 * by the CliRenderer, which is the OpenTUI equivalent of Ink's render().
 *
 * This module must be loaded under Bun (not Node) because @opentui/core loads
 * a native Zig binary via Bun's FFI. cli/index.js re-execs under Bun when the
 * `tui` subcommand is invoked.
 */
let root = null;
let renderer = null;

export async function start({ version = '0.1.0' } = {}) {
  if (root) return null;

  renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: 'alternate-screen',
    hideCursor: true,
    // Transparent backsplash: the terminal's own background stays visible —
    // Guake's installed HaksterAI wallpaper with `hakster quake`, or any
    // terminal wallpaper. OpenTUI's default background is alpha 0, and saying
    // it here keeps it that way if a future version changes the default.
    // HAKSTER_TUI_OPAQUE=1 paints solid for terminals that smear transparency.
    backgroundColor: process.env.HAKSTER_TUI_OPAQUE || prefs.load().opaqueBackdrop ? '#000000' : 'transparent',
  });

  root = createRoot(renderer);
  root.render(React.createElement(App, { version }));

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
    },
  };
}

export default start;