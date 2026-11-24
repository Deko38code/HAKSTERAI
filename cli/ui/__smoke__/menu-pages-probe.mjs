/* Probe: the /menu popout's two full pages — every CLI setting (/settings,
 * the terminal's `/config`) and the MCP server manager (/mcp) — plus the
 * chat frame's single status line.
 *
 * Renders the real App against a mocked server so no live services are touched.
 */
import React from 'react';
process.env.HOME = '/tmp/probe-home';
process.env.HAKSTER_NO_INTRO = '1';
process.env.HAKSTER_NO_HISTORY = '1';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('../src/App.jsx');
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const ROWS = Number(process.env.PROBE_ROWS || 34);
const COLS = Number(process.env.PROBE_COLS || 120);

globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/api/tui/status')) return json({ phase: 'ACT', connected: true, model: 'glm-5.2:cloud', trust: 3, tokens: 41000 });
  if (u.includes('/api/agent/mcp-status')) return json({
    servers: [
      { name: 'filesystem', toolCount: 12, initialized: true, tools: ['read_file', 'write_file', 'list_dir', 'search_files', 'move_file', 'get_file_info', 'directory_tree', 'read_text_file', 'read_media_file', 'edit_file', 'create_directory', 'list_allowed_directories'] },
      { name: 'nmap', toolCount: 9, initialized: true, tools: ['nmap_basic_scan', 'nmap_port_scan', 'nmap_service_detection', 'nmap_os_detection', 'nmap_vulnerability_scan', 'nmap_ping_scan', 'nmap_script_scan', 'nmap_custom_scan', 'nmap_mdns_discovery'] },
      { name: 'sqlite', toolCount: 5, initialized: true, pid: 4321, tools: ['list_tables', 'describe_table', 'create_table', 'read_query', 'write_query'] },
      { name: 'hermes', toolCount: 0, initialized: false },
      { name: 'playwright', toolCount: 21, initialized: true, lazy: true },
    ],
  });
  if (u.includes('/api/ads')) return json({ creatives: [] });
  return json({});
};

const setup = await createTestRenderer({ width: COLS, height: ROWS });
const root = createRoot(setup.renderer);
flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
await setup.flush();
await settle(500);
const type = async (s) => { for (const ch of s) flushSync(() => setup.mockInput.pressKey(ch)); await setup.flush(); };
const shot = (label) => { console.log(`\n===== ${label} =====`); console.log(setup.captureCharFrame()); };

shot('CHAT (status line must appear once)');

// Catalog filtered to settings, then the settings page, then the MCP page.
flushSync(() => setup.mockInput.pressKey('p', { ctrl: true })); await setup.flush(); await settle(150);
await type('setting'); await settle(120);
shot('CATALOG filter=setting');
flushSync(() => setup.mockInput.pressKey('escape')); await setup.flush();
for (let i = 0; i < 12; i += 1) flushSync(() => setup.mockInput.pressBackspace());
await setup.flush();

await type('/settings'); flushSync(() => setup.mockInput.pressEnter()); await setup.flush(); await settle(300);
shot('SETTINGS page');
for (let i = 0; i < 3; i += 1) flushSync(() => setup.mockInput.pressArrow('down'));
await setup.flush(); await settle(100);
flushSync(() => setup.mockInput.pressEnter()); await setup.flush(); await settle(250);
shot('SETTINGS after enter on a switch');

flushSync(() => setup.mockInput.pressEscape()); await setup.flush(); await settle(100);
await type('/mcp'); flushSync(() => setup.mockInput.pressEnter()); await setup.flush(); await settle(300);
shot('MCP page');
flushSync(() => setup.mockInput.pressArrow('down')); await setup.flush(); await settle(120);
shot('MCP after ↓');
flushSync(() => setup.mockInput.pressEscape()); await setup.flush(); await settle(100);
root.unmount();
process.exit(0);
