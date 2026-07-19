import React from 'react';
import { Box, Text } from 'ink';

export default function DiffPreview({ diff, cols = 80, onApprove, onDeny }) {
  if (!diff) return null;

  const lines = diff.split('\n').slice(0, 20); // cap at 20 lines

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="yellow" bold>
          ⚠ Diff Preview — Review Before Apply
        </Text>
        <Text color="gray" dim>
          Y=approve │ N=deny │ V=view more
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {lines.map((line, i) => {
          let color = 'gray';
          let prefix = ' ';
          if (line.startsWith('+') && !line.startsWith('+++')) {
            color = 'green';
            prefix = '+';
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            color = 'red';
            prefix = '-';
          } else if (line.startsWith('@@')) {
            color = 'cyan';
            prefix = '@';
          } else if (line.startsWith('diff') || line.startsWith('---') || line.startsWith('+++')) {
            color = 'magenta';
            prefix = ' ';
          }
          return (
            <Text key={i} color={color} wrap="truncate">
              {prefix} {line.slice(0, cols - 4)}
            </Text>
          );
        })}
        {diff.split('\n').length > 20 && (
          <Text color="gray" dim>
            ... {diff.split('\n').length - 20} more lines (press V to view)
          </Text>
        )}
      </Box>
      <Box marginTop={0}>
        <Text color="green" bold>[Y]</Text>
        <Text color="gray"> approve │ </Text>
        <Text color="red" bold>[N]</Text>
        <Text color="gray"> deny │ </Text>
        <Text color="blue" bold>[V]</Text>
        <Text color="gray"> view full</Text>
      </Box>
    </Box>
  );
}