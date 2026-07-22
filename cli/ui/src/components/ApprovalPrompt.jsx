import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

const BUTTONS = [
  { key: 'r', label: 'Allow this run', color: 'green' },
  { key: 's', label: 'Allow this session', color: 'cyan' },
  { key: 'a', label: 'Add to allowlist', color: 'yellow' },
  { key: 'd', label: 'Deny', color: 'red' },
];

const RISK_CONFIG = {
  low: { color: 'green', icon: '✓', label: 'LOW' },
  medium: { color: 'yellow', icon: '⚠', label: 'MEDIUM' },
  high: { color: 'red', icon: '⚠', label: 'HIGH' },
  critical: { color: 'red', icon: '🔑', label: 'SUDO' },
};

export default function ApprovalPrompt({
  command = '',
  risk = 'high',
  reason = '',
  isSudo = false,
  onApprove,
  onApproveSession,
  onAllowlist,
  onDeny,
}) {
  const sudo = !!isSudo || risk === 'critical';
  const rc = RISK_CONFIG[risk] || RISK_CONFIG.high;
  const [focus, setFocus] = useState(0);
  const [pw, setPw] = useState('');

  const actions = [onApprove, onApproveSession, onAllowlist, onDeny];

  useInput((raw, key) => {
    if (key.escape) { onDeny?.(pw); return; }
    if (key.leftArrow) { setFocus(f => (f - 1 + BUTTONS.length) % BUTTONS.length); return; }
    if (key.rightArrow || key.tab) { setFocus(f => (f + 1) % BUTTONS.length); return; }
    if (key.return) { actions[focus]?.(pw); return; }
    if (key.backspace || key.delete) {
      if (sudo) { setPw(p => p.slice(0, -1)); }
      return;
    }
    // Sudo: letters go into the password field (hotkeys disabled so they type)
    if (sudo && raw && raw.length === 1 && !key.ctrl && !key.meta) {
      setPw(p => p + raw);
      return;
    }
    // Non-sudo: r/s/a/d hotkeys act instantly
    if (!sudo && raw && raw.length === 1 && !key.ctrl && !key.meta) {
      const idx = BUTTONS.findIndex(b => b.key === raw.toLowerCase());
      if (idx >= 0) { actions[idx]?.(pw); }
    }
  });

  const displayCommand = (command || '').slice(0, 120) + ((command || '').length > 120 ? '…' : '');
  const displayReason = (reason || (sudo ? 'SUDO ELEVATED COMMAND' : 'Dangerous command detected')).slice(0, 90);

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={rc.color} paddingX={2} paddingY={1} width={Math.min(92, 58)}>
      <Box justifyContent="space-between">
        <Text color={rc.color} bold>{rc.icon} {rc.label} — Approval Required</Text>
        <Text color="gray" dim>[ Esc = deny ]</Text>
      </Box>
      <Box marginTop={0}>
        <Text color="white">{sudo ? '🔑 SUDO ' : '⚠ '}{displayReason}</Text>
      </Box>
      {command && (
        <Box marginTop={0}>
          <Text color="gray">$ {displayCommand}</Text>
        </Box>
      )}
      {sudo && (
        <Box marginTop={1}>
          <Text color="cyan" bold>sudo password: </Text>
          <Text color="white">{'*'.repeat(pw.length)}</Text>
          <Text color="gray" dim>{pw ? '' : ' (type to enter)'}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="row" flexWrap="wrap">
        {BUTTONS.map((b, i) => {
          const focused = i === focus;
          return (
            <Box key={b.key} marginRight={1}>
              <Text backgroundColor={focused ? b.color : undefined} color={focused ? 'black' : b.color} bold>
                {focused ? '❯' : ' '}[{b.key}] {b.label}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dim>←/→/Tab focus · Enter select{sudo ? ' · letters type password' : ' · r/s/a/d hotkeys'}</Text>
      </Box>
    </Box>
  );
}