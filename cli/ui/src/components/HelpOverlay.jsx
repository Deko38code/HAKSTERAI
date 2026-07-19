import React from 'react';
import { Box, Text } from 'ink';

const SLASH_COMMANDS = [
  { cmd: '/help', desc: 'Show this help overlay' },
  { cmd: '/status', desc: 'Show server status (model, trust, uptime)' },
  { cmd: '/model [name]', desc: 'Switch model (e.g. /model gpt-5.2)' },
  { cmd: '/provider [name]', desc: 'Switch provider (ollama, openai, anthropic, glm)' },
  { cmd: '/trust [level]', desc: 'Set trust level (0=suggest, 10=auto-edit, 30=full-auto)' },
  { cmd: '/approve', desc: 'Approve pending action' },
  { cmd: '/deny', desc: 'Deny pending action' },
  { cmd: '/clear', desc: 'Clear output buffer' },
  { cmd: '/compact', desc: 'Compact context window' },
  { cmd: '/diff', desc: 'Toggle diff preview before edits' },
  { cmd: '/review', desc: 'Run code review on current changes' },
  { cmd: '/plan', desc: 'Show/hide plan panel' },
  { cmd: '/sessions', desc: 'List saved sessions' },
  { cmd: '/resume [id]', desc: 'Resume a session by ID' },
  { cmd: '/save', desc: 'Save current session' },
  { cmd: '/memory', desc: 'Show memory summary' },
  { cmd: '/skills', desc: 'List available skills' },
  { cmd: '/theme [name]', desc: 'Switch color theme (default, dark, light, cyberpunk)' },
  { cmd: '/fast [on|off]', desc: 'Toggle fast mode' },
  { cmd: '/health', desc: 'Check server health' },
  { cmd: '/undo', desc: 'Undo last file edit' },
  { cmd: '/exit', desc: 'Exit haksterAi CLI' },
];

const KEYBINDINGS = [
  { key: 'Enter', desc: 'Send message' },
  { key: 'Ctrl+C', desc: 'Exit' },
  { key: 'Ctrl+L', desc: 'Clear screen' },
  { key: 'Ctrl+U', desc: 'Clear input line' },
  { key: 'Ctrl+D', desc: 'Exit (EOF)' },
  { key: 'Ctrl+P / ↑', desc: 'Previous message (history)' },
  { key: 'Ctrl+N / ↓', desc: 'Next message (history)' },
  { key: 'Ctrl+↑', desc: 'Scroll output up' },
  { key: 'Ctrl+↓', desc: 'Scroll output down' },
  { key: 'PageUp', desc: 'Scroll output up (page)' },
  { key: 'PageDown', desc: 'Scroll output down (page)' },
  { key: 'Tab', desc: 'Autocomplete slash command' },
  { key: 'Esc', desc: 'Close overlay / cancel action' },
  { key: '?', desc: 'Toggle this help overlay' },
];

export default function HelpOverlay({ cols = 80, rows = 24, onDismiss }) {
  const half = Math.ceil(SLASH_COMMANDS.length / 2);
  const leftCol = SLASH_COMMANDS.slice(0, half);
  const rightCol = SLASH_COMMANDS.slice(half);
  const cmdWidth = cols > 100 ? 48 : cols - 30;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      width={Math.min(cols, 100)}
    >
      <Box justifyContent="center">
        <Text color="cyan" bold>
          ┌─ haksterAi CLI — Help ─┐
        </Text>
      </Box>

      {/* Slash Commands */}
      <Box marginTop={1}>
        <Text color="yellow" bold underline>
          Slash Commands
        </Text>
      </Box>
      <Box flexDirection="row" gap={4} marginTop={0}>
        <Box flexDirection="column">
          {leftCol.map((c, i) => (
            <Box key={i}>
              <Text color="green" bold>
                {c.cmd.padEnd(18)}
              </Text>
              <Text color="gray">
                {c.desc.slice(0, cmdWidth - 20)}
              </Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column">
          {rightCol.map((c, i) => (
            <Box key={i}>
              <Text color="green" bold>
                {c.cmd.padEnd(18)}
              </Text>
              <Text color="gray">
                {c.desc.slice(0, cmdWidth - 20)}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Keybindings */}
      <Box marginTop={1}>
        <Text color="yellow" bold underline>
          Keybindings
        </Text>
      </Box>
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column">
          {KEYBINDINGS.slice(0, Math.ceil(KEYBINDINGS.length / 2)).map((k, i) => (
            <Box key={i}>
              <Text color="magenta" bold>
                {k.key.padEnd(16)}
              </Text>
              <Text color="gray">{k.desc}</Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column">
          {KEYBINDINGS.slice(Math.ceil(KEYBINDINGS.length / 2)).map((k, i) => (
            <Box key={i}>
              <Text color="magenta" bold>
                {k.key.padEnd(16)}
              </Text>
              <Text color="gray">{k.desc}</Text>
            </Box>
          ))}
        </Box>
      </Box>

      <Box marginTop={1} justifyContent="center">
        <Text color="gray" dim>
          Press Esc or ? to dismiss
        </Text>
      </Box>
    </Box>
  );
}