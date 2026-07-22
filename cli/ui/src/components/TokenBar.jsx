import React from 'react';
import { Box, Text } from 'ink';

export default function TokenBar({ used = 0, chars = 0, max = 128000, cols = 80 }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  const barWidth = Math.max(10, cols - 30);
  const filled = Math.floor((pct / 100) * barWidth);
  const bar = '█'.repeat(filled).padEnd(barWidth, '░');
  const color = pct > 85 ? 'red' : pct > 60 ? 'yellow' : 'green';
  const label = `${(used / 1000).toFixed(1)}K/${(max / 1000).toFixed(0)}K`;
  const charLabel = chars > 0 ? ` · ${(chars / 1000).toFixed(1)}k chars` : '';

  return (
    <Box width={cols} paddingX={1}>
      <Text color="gray" dim>tokens </Text>
      <Text color={color}>[{bar}]</Text>
      <Text color={color} bold> {pct}%</Text>
      <Text color="gray" dim> {label}{charLabel}</Text>
    </Box>
  );
}
