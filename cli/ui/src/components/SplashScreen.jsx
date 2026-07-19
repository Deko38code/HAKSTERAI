import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

const LOGO = [
  ' ╔═╗ ╦ ╦ ╔═╗ ╦╔═ ╔═╗ ╦   ╔╦╗ ╔═╗ ╦ ╦',
  ' ║   ║ ║ ╠═╝ ╠╩╗ ║   ║    ║  ║ ║ ║ ║',
  ' ╚═╝ ╚═╝ ╩   ╩ ╩ ╚═╝ ╚═╝  ╩  ╚═╝ ╚═╝',
];

export default function SplashScreen({ onDone, version = '0.1.0' }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (frame >= LOGO.length + 2) {
      onDone && onDone();
      return;
    }
    const id = setTimeout(() => setFrame(f => f + 1), 120);
    return () => clearTimeout(id);
  }, [frame, onDone]);

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center">
      {LOGO.slice(0, frame).map((line, i) => (
        <Text key={i} color="green" bold>
          {line}
        </Text>
      ))}
      {frame >= LOGO.length && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>
            HaksterAI CLI v{version}
          </Text>
          <Text color="gray" dim>
            Pentester AI Agent · Autonomous Coding · IPTV Ops
          </Text>
          <Text color="magenta" dim>
            Type ? for help · Enter to start · Ctrl+C to exit
          </Text>
        </Box>
      )}
    </Box>
  );
}