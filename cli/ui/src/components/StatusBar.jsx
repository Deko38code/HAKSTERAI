import React from 'react';
import { Box, Text } from 'ink';

const TRUST_LABELS = {
  0: { label: 'SUGGEST', color: 'yellow' },
  10: { label: 'AUTO_EDIT', color: 'cyan' },
  30: { label: 'FULL_AUTO', color: 'green' },
};

export function getTrustInfo(level = 0) {
  if (level >= 30) return TRUST_LABELS[30];
  if (level >= 10) return TRUST_LABELS[10];
  return TRUST_LABELS[0];
}

export default function StatusBar({
  model = 'unknown',
  provider = 'unknown',
  trustLevel = 0,
  approvalMode = 'on-request',
  contextUsed = 0,
  contextMax = 128000,
  phase = 'IDLE',
  cols = 80,
  sessionId = '',
}) {
  const trust = getTrustInfo(trustLevel);
  const ctxPct = Math.round((contextUsed / contextMax) * 100);
  const ctxColor = ctxPct > 85 ? 'red' : ctxPct > 60 ? 'yellow' : 'green';
  const ctxBar = '█'.repeat(Math.floor(ctxPct / 5)).padEnd(20, '░');

  // Left side: model + provider
  const left = `${model}│${provider}`;

  // Right side: trust + approval + context
  const right = `${trust.label}│${approvalMode}│ctx ${ctxPct}%`;

  // Session ID (short)
  const sid = sessionId ? sessionId.slice(0, 8) : '--------';
  const phaseStr = `[${phase}]`;

  return (
    <Box flexDirection="column">
      {/* Top row: model | phase | session */}
      <Box width={cols} paddingX={1} justifyContent="space-between">
        <Text color="cyan" bold>
          {left}
        </Text>
        <Text color="magenta" bold>
          {phaseStr}
        </Text>
        <Text color="gray" dim>
          session:{sid}
        </Text>
      </Box>
      {/* Bottom row: trust | approval | context bar */}
      <Box width={cols} paddingX={1} justifyContent="space-between">
        <Text color={trust.color} bold>
          {right}
        </Text>
        <Text color={ctxColor}>
          [{ctxBar}]
        </Text>
      </Box>
    </Box>
  );
}