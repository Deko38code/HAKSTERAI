import React from 'react';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import App from './App.jsx';

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