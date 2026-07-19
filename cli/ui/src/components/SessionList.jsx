import React from 'react';
import { Box, Text } from 'ink';

export default function SessionList({ sessions = [], cols = 80, onSelect }) {
  if (sessions.length === 0) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="gray" dim>No saved sessions. Use /save to save current session.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold underline>
        Saved Sessions
      </Text>
      {sessions.map((s, i) => {
        const date = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : '?';
        const time = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : '';
        return (
          <Box key={s.id || i}>
            <Text color="green" bold>
              [{(i + 1).toString().padStart(2)}]
            </Text>
            <Text color="cyan">
              {' ' + (s.id || '').slice(0, 12)}
            </Text>
            <Text color="gray">
              {' ' + (s.provider || '').padEnd(8)}
            </Text>
            <Text color="magenta">
              {' ' + (s.model || '').padEnd(16)}
            </Text>
            <Text color="gray" dim>
              {' ' + date + ' ' + time}
            </Text>
          </Box>
        );
      })}
      <Text color="gray" dim marginTop={0}>
        Use /resume {'<id>'} to resume a session
      </Text>
    </Box>
  );
}