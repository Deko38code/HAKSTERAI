import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import Spinner from './Spinner.jsx';

// Horizontal marquee scroll: thinking text scrolls left across the screen
export default function ThinkingBox({ thinking = '', phase = '', cols = 80, theme }) {
  const [offset, setOffset] = useState(0);
  const [dots, setDots] = useState(0);
  const textRef = useRef('');

  // Update the reference text when thinking changes
  useEffect(() => {
    textRef.current = thinking ? thinking.trim() : '';
    setOffset(0); // reset scroll position when text changes
  }, [thinking]);

  // Marquee scroll: shift offset left every 120ms
  useEffect(() => {
    if (!textRef.current) return;
    const id = setInterval(() => {
      setOffset(o => {
        const textLen = textRef.current.length;
        const maxOffset = textLen + 20; // pad with spaces before looping
        return o >= maxOffset ? 0 : o + 1;
      });
    }, 120);
    return () => clearInterval(id);
  }, [thinking]);

  // Animated dots for phase indicator
  useEffect(() => {
    if (!phase) return;
    const id = setInterval(() => setDots(d => (d + 1) % 4), 400);
    return () => clearInterval(id);
  }, [phase]);

  if (!thinking && !phase) return null;

  // Build the marquee viewport: extract a window of text starting at offset
  const fullText = textRef.current;
  const availWidth = Math.max(0, cols - 22); // leave room for spinner + label
  let viewport = '';

  if (fullText) {
    // Pad text with spaces on both sides for smooth loop
    const padded = '   ' + fullText + '   ';
    if (padded.length <= availWidth) {
      // Text fits — no scrolling needed
      viewport = padded.trim();
    } else {
      // Extract window from padded text at current offset, wrap around
      let window = '';
      for (let i = 0; i < availWidth; i++) {
        const idx = (offset + i) % padded.length;
        window += padded[idx];
      }
      viewport = window;
    }
  }

  const phaseLabel = phase ? ` ${phase}${'.'.repeat(dots)}` : '';
  const accentColor = theme?.accent || theme?.primary || 'cyan';

  return (
    <Box flexDirection="row" alignItems="center">
      <Box marginRight={1}>
        <Spinner />
      </Box>
      <Text color={accentColor} bold>
        {'⟡'}
      </Text>
      <Text color="gray" dim>
        {' thinking'}
      </Text>
      <Text color={accentColor}>
        {phaseLabel ? ` ${phaseLabel}` : ''}
      </Text>
      <Box flexGrow={1} marginLeft={1} overflow="hidden">
        <Text color="gray" wrap="truncate">
          {viewport}
        </Text>
      </Box>
    </Box>
  );
}