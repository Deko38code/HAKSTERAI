import React from 'react';
import { TextAttributes } from '@opentui/core';

/* MenuPalette — the `/menu` popout for the terminal, mirroring HakTerm's
 * command palette (CLI Agents / `#cmd-palette`).
 *
 * Same rules as the browser palette: it never opens by itself, it owns the
 * keyboard only while it is open, and esc closes it without running anything.
 * Every entry is a real command the CLI implements — nothing is listed here
 * that the CLI cannot run.
 */
export const MENU_ITEMS = [
  { cmd: '/model', label: 'Models', detail: 'switch the model for this session' },
  { cmd: '/mcp', label: 'MCP servers', detail: 'live servers and their tool counts' },
  { cmd: '/handoff', label: 'Auto handoff', detail: 'on/off · DeepSeek → Codex → others' },
  { cmd: '/ports', label: 'Ports', detail: 'services and every listening port' },
  { cmd: '/attach', label: 'Attach image', detail: '/attach <path> · sends with your message' },
  { cmd: '/dashboard', label: 'Dashboard', detail: 'system / session / agent panels' },
  { cmd: '/monitor', label: 'Live monitor', detail: 'full-screen feed + output · shift+↑/↓ scroll' },
  { cmd: '/status', label: 'Status', detail: 'server, phase, tokens' },
  { cmd: '/update', label: 'Update', detail: 'check · downloads in-session · applies on restart' },
  { cmd: '/settings', label: 'Settings', detail: "the CLI's own preferences · read one / set one" },
  { cmd: '/clear', label: 'Clear transcript', detail: 'start the conversation over' },
  { cmd: '/help', label: 'Help', detail: 'keys and commands' },
  { cmd: '/quit', label: 'Quit', detail: 'leave the dashboard' },
];

const clip = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + '…';
};

export default function MenuPalette({ width = 60, selected = 0 }) {
  const inner = Math.max(1, width - 4);
  return (
    <box style={{ width, flexDirection: 'column', border: true, borderStyle: 'rounded', borderColor: 'cyan', paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
      <box style={{ width: inner, flexDirection: 'row', justifyContent: 'space-between' }}>
        <text fg="cyan" attributes={TextAttributes.BOLD}>◇ Menu</text>
        <text fg="gray">{clip('↑↓ select · enter run · esc close', inner - 6)}</text>
      </box>
      <box style={{ width: inner, flexDirection: 'column' }}>
        {MENU_ITEMS.map((item, i) => {
          const active = i === selected;
          return (
            <box key={item.cmd} style={{ width: inner, flexDirection: 'row', justifyContent: 'space-between' }}>
              <text fg={active ? 'cyan' : 'white'} attributes={active ? TextAttributes.BOLD : 0}>
                {`${active ? '▸ ' : '  '}${item.cmd.padEnd(11)} ${clip(item.label, 16)}`}
              </text>
              <text fg="gray">{clip(item.detail, Math.max(0, inner - 30))}</text>
            </box>
          );
        })}
      </box>
      <box style={{ width: inner }}>
        <text fg="gray">{clip('type /menu anytime · /help for every command', inner)}</text>
      </box>
    </box>
  );
}
