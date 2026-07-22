import React from 'react';
import { Box, Text } from 'ink';

export default function QueueBox({ items = [], cols = 80 }) {
  if (!items.length) return null;
  const list = Array.isArray(items) ? items : [items];
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} width={cols}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>⏳ Queued messages ({list.length})</Text>
        <Text color="gray" dim>waiting…</Text>
      </Box>
      {list.slice(0, 4).map((it, i) => {
        const text = String(typeof it === 'string' ? it : (it?.text || it?.content || it?.message || JSON.stringify(it)));
        const last = i === list.length - 1;
        return (
          <Box key={i}>
            <Text color={last ? 'cyan' : 'gray'} dim={!last}>{last ? '▸ ' : '  '}</Text>
            <Text color="white">{text.slice(0, Math.max(10, cols - 6))}</Text>
          </Box>
        );
      })}
      {list.length > 4 && (
        <Text color="gray" dim>…and {list.length - 4} more</Text>
      )}
    </Box>
  );
}