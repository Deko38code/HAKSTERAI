import React, { useState, useEffect } from 'react';
import { Text } from 'ink';

const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const FRAMES_DOTS = ['⣾','⣽','⣻','⢿','⡿','⣟','⣯','⣷'];

export default function Spinner({ type = 'braille', label = '', color = 'yellow' }) {
  const [frame, setFrame] = useState(0);
  const frames = type === 'dots' ? FRAMES_DOTS : FRAMES;

  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % frames.length), 80);
    return () => clearInterval(id);
  }, [frames.length]);

  return (
    <Text color={color}>
      {frames[frame]} {label}
    </Text>
  );
}