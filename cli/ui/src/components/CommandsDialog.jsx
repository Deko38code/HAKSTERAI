import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';

// System commands — map to hakster agent actions / slash commands.
const SYSTEM_COMMANDS = [
  { id: 'new_session',      title: 'New Session',        desc: 'Start a fresh session',           shortcut: 'ctrl+n' },
  { id: 'switch_session',   title: 'Switch Session',     desc: 'List and resume a session',       shortcut: 'ctrl+s' },
  { id: 'switch_model',      title: 'Switch Model',       desc: 'Open the model selector popup',   shortcut: '' },
  { id: 'summarize',         title: 'Summarize Session',  desc: 'Compact context into a summary',  shortcut: '' },
  { id: 'toggle_thinking',   title: 'Toggle Thinking',    desc: 'Show/hide reasoning stream',      shortcut: '' },
  { id: 'toggle_diff',       title: 'Toggle Diff Preview',desc: 'Preview edits before applying',  shortcut: '' },
  { id: 'toggle_plan',       title: 'Toggle Plan Panel',  desc: 'Show/hide the plan display',       shortcut: '' },
  { id: 'toggle_help',       title: 'Toggle Help',        desc: 'Show the help overlay',            shortcut: 'ctrl+g' },
  { id: 'file_picker',       title: 'Open File Picker',   desc: 'Attach a file to the prompt',      shortcut: 'ctrl+f' },
  { id: 'toggle_yolo',       title: 'Toggle Yolo Mode',   desc: 'Auto-approve all tool calls',      shortcut: '' },
  { id: 'review',            title: 'Code Review',        desc: 'Review current changes',           shortcut: '' },
  { id: 'health',            title: 'Health Check',       desc: 'Check server + services',          shortcut: '' },
  { id: 'init',              title: 'Initialize Project', desc: 'Create/Update CRUSH.md memory',    shortcut: '' },
  { id: 'quit',              title: 'Quit',              desc: 'Exit haksterAi CLI',               shortcut: 'ctrl+c' },
];

// User commands — the live slash-command set (mirror of SlashMenu/HelpOverlay).
const USER_COMMANDS = [
  { id: '/help',    title: '/help',    desc: 'Show help overlay' },
  { id: '/status',  title: '/status',  desc: 'Server status' },
  { id: '/model',   title: '/model',   desc: 'Switch model' },
  { id: '/provider',title: '/provider',desc: 'Switch provider' },
  { id: '/trust',   title: '/trust',   desc: 'Set trust level' },
  { id: '/approve', title: '/approve', desc: 'Approve pending' },
  { id: '/deny',    title: '/deny',    desc: 'Deny pending' },
  { id: '/clear',   title: '/clear',   desc: 'Clear output' },
  { id: '/compact', title: '/compact', desc: 'Compact context' },
  { id: '/diff',    title: '/diff',    desc: 'Toggle diff preview' },
  { id: '/review',  title: '/review',  desc: 'Code review' },
  { id: '/plan',    title: '/plan',    desc: 'Show/hide plan' },
  { id: '/sessions',title: '/sessions',desc: 'List sessions' },
  { id: '/resume',  title: '/resume',  desc: 'Resume session' },
  { id: '/save',    title: '/save',    desc: 'Save session' },
  { id: '/memory',  title: '/memory',  desc: 'Memory summary' },
  { id: '/skills',  title: '/skills',  desc: 'List skills' },
  { id: '/theme',   title: '/theme',   desc: 'Switch theme' },
  { id: '/fast',    title: '/fast',    desc: 'Toggle fast mode' },
  { id: '/health',  title: '/health',  desc: 'Server health' },
  { id: '/undo',    title: '/undo',    desc: 'Undo last edit' },
  { id: '/exit',    title: '/exit',    desc: 'Exit CLI' },
];

const WIDTH = 70;

export default function CommandsDialog({ cols = 80, rows = 24, onSelect, onDismiss }) {
  const [filter, setFilter] = useState('');
  const [idx, setIdx] = useState(0);
  const [tab, setTab] = useState('system'); // 'system' | 'user'

  const list = tab === 'system' ? SYSTEM_COMMANDS : USER_COMMANDS;
  const matches = useMemo(() => {
    const q = filter.toLowerCase();
    if (!q) return list;
    return list.filter(c =>
      c.title.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)
    );
  }, [filter, list]);

  useInput((raw, key) => {
    if (key.escape) { onDismiss?.(); return; }
    if (key.return) {
      const c = matches[idx];
      if (c) onSelect?.(c.id);
      return;
    }
    if (key.tab) { setTab(t => (t === 'system' ? 'user' : 'system')); setFilter(''); setIdx(0); return; }
    if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx(i => Math.min(matches.length - 1, i + 1)); return; }
    if (key.backspace || key.delete) { setFilter(p => p.slice(0, -1)); setIdx(0); return; }
    if (raw && !key.ctrl && !key.meta && raw.length === 1) { setFilter(p => p + raw); setIdx(0); return; }
  });

  const radio = tab === 'system' ? '◉ System  ○ User' : '○ System  ◉ User';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" width={WIDTH} paddingX={2} paddingY={1}>
      <Box justifyContent="space-between">
        <Text color="magenta" bold>Commands</Text>
        <Text color="gray" dim>{radio}</Text>
      </Box>

        <Box marginTop={1}>
          <Text color="gray" dim>{'>'.padEnd(2)} </Text>
          <Text color="green">{filter || '<filter commands>'}</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {matches.length === 0 ? (
            <Text color="gray" dim>No commands match "{filter}"</Text>
          ) : (
            matches.map((c, i) => (
              <Box key={c.id}>
                <Text color={i === idx ? 'green' : 'gray'} bold={i === idx}>
                  {i === idx ? '❯ ' : '  '}{c.title.padEnd(22).slice(0, 22)}
                </Text>
                <Text color="gray" dim>{c.desc.padEnd(36).slice(0, 36)}</Text>
                {c.shortcut ? <Text color="cyan" dim> {c.shortcut}</Text> : null}
              </Box>
            ))
          )}
        </Box>

        <Box marginTop={1}>
          <Text color="gray" dim>↑↓ navigate · Enter run · Tab system/user · Esc close</Text>
        </Box>
    </Box>
  );
}