import React from 'react';
import { Box, Text } from 'ink';

export default function PlanDisplay({ plan = null, cols = 80 }) {
  if (!plan) return null;

  const { goal, steps = [], files = [] } = plan;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="blue"
      paddingX={1}
    >
      <Text color="blue" bold underline>
        📋 Plan
      </Text>
      {goal && (
        <Text color="white">
          Goal: <Text color="cyan">{goal}</Text>
        </Text>
      )}
      {steps.length > 0 && (
        <Box flexDirection="column" marginTop={0}>
          {steps.map((step, i) => {
            const done = step.status === 'done';
            const active = step.status === 'active';
            const icon = done ? '✓' : active ? '◉' : '○';
            const color = done ? 'green' : active ? 'yellow' : 'gray';
            return (
              <Text key={i} color={color}>
                {icon} [{i + 1}] {step.text || step.desc || step}
              </Text>
            );
          })}
        </Box>
      )}
      {files.length > 0 && (
        <Box marginTop={0}>
          <Text color="magenta" dim>
            Files: {files.join(', ')}
          </Text>
        </Box>
      )}
    </Box>
  );
}