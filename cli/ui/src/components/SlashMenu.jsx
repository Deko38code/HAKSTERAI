import React, { useState, useMemo } from 'react';
import { Box, Text } from 'ink';

const COMMANDS = [
  '/help', '/status', '/model', '/provider', '/trust',
  '/approve', '/deny', '/clear', '/compact', '/diff',
  '/review', '/plan', '/sessions', '/resume', '/save',
  '/memory', '/skills', '/theme', '/fast', '/health',
  '/undo', '/commands', '/exit',
];

const DESCRIPTIONS = {
  '/help': 'Show help overlay',
  '/status': 'Server status',
  '/model': 'Switch model',
  '/provider': 'Switch provider',
  '/trust': 'Set trust level',
  '/approve': 'Approve pending',
  '/deny': 'Deny pending',
  '/clear': 'Clear output',
  '/compact': 'Compact context',
  '/diff': 'Toggle diff preview',
  '/review': 'Code review',
  '/plan': 'Show/hide plan',
  '/sessions': 'List sessions',
  '/resume': 'Resume session',
  '/save': 'Save session',
  '/memory': 'Memory summary',
  '/skills': 'List skills',
  '/theme': 'Switch theme',
  '/fast': 'Toggle fast mode',
  '/commands': 'Open commands palette popup',
  '/health': 'Server health',
  '/undo': 'Undo last edit',
  '/exit': 'Exit CLI',
};

export default function SlashMenu({ query, input, cols = 80, onSelect }) {
  const q = input ?? query ?? '';
  const matches = useMemo(() => {
    if (!q) return COMMANDS;
    const lower = q.toLowerCase();
    return COMMANDS.filter(c => c.startsWith(lower)).slice(0, 12);
  }, [q]);

  if (matches.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      {matches.map((cmd, i) => (
        <Box key={cmd}>
          <Text color={i === 0 ? 'green' : 'gray'} bold={i === 0}>
            {i === 0 ? '❯ ' : '  '}
            {cmd.padEnd(14)}
          </Text>
          <Text color="gray" dim>
            {DESCRIPTIONS[cmd] || ''}
          </Text>
        </Box>
      ))}
    </Box>
  );
}