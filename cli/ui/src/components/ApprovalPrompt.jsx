import React from 'react';
import { Box, Text, useInput } from 'ink';

export default function ApprovalPrompt({
  action = '',
  command = '',
  risk = 'medium', // low, medium, high, critical
  reason = '',
  onApprove,
  onDeny,
  onAllowlist,
}) {
  const isSudo = typeof risk === 'string' && risk === 'critical';
  const riskConfig = {
    low: { color: 'green', icon: '✓', label: 'LOW' },
    medium: { color: 'yellow', icon: '⚠️', label: 'MEDIUM' },
    high: { color: 'red', icon: '⚠️', label: 'HIGH' },
    critical: { color: 'red', icon: '🔑', label: 'SUDO' },
  };
  const rc = riskConfig[risk] || riskConfig.medium;

  useInput((raw, key) => {
    if (key.escape || raw === 'n' || raw === 'N') { onDeny?.(); return; }
    if (raw === 'y' || raw === 'Y') { onApprove?.(); return; }
    if (raw === 'a' || raw === 'A') { onAllowlist?.(); return; }
  });

  const displayCommand = (command || '').slice(0, 120) + ((command || '').length > 120 ? '…' : '');
  const displayReason = (reason || (isSudo ? 'SUDO ELEVATED COMMAND' : 'Dangerous command detected')).slice(0, 90);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={rc.color}
      paddingX={2}
      paddingY={1}
      width={Math.min(90, 48)}
    >
      <Box justifyContent="space-between">
        <Text color={rc.color} bold>
          {rc.icon} {rc.label} — Approval Required
        </Text>
        <Text color="gray" dim>[ Esc = deny ]</Text>
      </Box>
      <Box marginTop={0}>
        <Text color="white">
          {isSudo ? '🔑 SUDO ' : '⚠️ '}{displayReason}
        </Text>
      </Box>
      {command && (
        <Box marginTop={0}>
          <Text color="gray">$ {displayCommand}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="green" bold>[Y]</Text>
        <Text color="gray"> Approve this run │ </Text>
        <Text color="red" bold>[N]</Text>
        <Text color="gray"> Deny │ </Text>
        <Text color="yellow" bold>[A]</Text>
        <Text color="gray"> Approve &amp; Add to allowlist</Text>
      </Box>
    </Box>
  );
}