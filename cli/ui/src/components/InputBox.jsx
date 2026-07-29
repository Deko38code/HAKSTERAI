import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

export default function InputBox({
  value = '',
  onChange,
  onSubmit,
  placeholder = 'Type a message… (Enter to send, Shift+Enter for newline)',
  cols = 80,
  disabled = false,
  queueCount = 0,
  theme,
}) {
  const { isRawModeSupported } = useStdin();
  const cursorRef = useRef(value.length);

  useInput((input, key) => {
    if (disabled) return;

    if (key.return && !key.shift) {
      if (onSubmit) onSubmit(value);
      return;
    }

    if (key.backspace || key.delete) {
      const newVal = value.slice(0, -1);
      if (onChange) onChange(newVal);
      return;
    }

    if (key.ctrl && input === 'u') {
      if (onChange) onChange('');
      return;
    }

    if (key.ctrl && input === 'w') {
      const parts = value.split(/\s+/);
      parts.pop();
      const newVal = parts.join(' ');
      if (onChange) onChange(newVal);
      return;
    }

    if (input && !key.ctrl && !key.meta && !key.escape && input.length === 1) {
      const newVal = value + input;
      if (onChange) onChange(newVal);
      return;
    }
  });

  const borderColor = disabled ? 'gray' : (theme?.primary || 'green');
  const labelColor = disabled ? 'gray' : (theme?.primary || 'green');
  const promptChar = disabled ? '○' : '▶';
  const displayValue = value || '';
  const showCursor = !disabled;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      width={cols}
      flexShrink={0}
    >
      {/* Queue indicator line */}
      {queueCount > 0 && (
        <Box justifyContent="space-between">
          <Text color="cyan" bold>
            📨 {queueCount} message{queueCount > 1 ? 's' : ''} queued
          </Text>
          <Text color="gray" dim>
            press Tab to cycle
          </Text>
        </Box>
      )}

      {/* Input line */}
      <Box>
        <Text color={labelColor} bold>
          {promptChar}{' '}
        </Text>
        <Text color={disabled ? 'gray' : 'white'}>
          {displayValue}
        </Text>
        {showCursor && displayValue.length < cols - 6 && (
          <Text color={labelColor}>█</Text>
        )}
        {!displayValue && (
          <Text color="gray" dim>
            {placeholder}
          </Text>
        )}
      </Box>

      {/* Hint line */}
      <Box justifyContent="space-between">
        <Text color="gray" dim>
          ↵ send  ⇧↵ newline  ⌃U clear  ⌃W del-word  /commands  ?help
        </Text>
        <Text color="gray" dim>
          {disabled ? '⏸ busy' : '● ready'}
        </Text>
      </Box>
    </Box>
  );
}