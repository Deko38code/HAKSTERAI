import React from 'react';
import { Box, Text } from 'ink';

// Renders a message in a nice bordered card with role badge
export default function MessageGrid({ messages = [], cols = 80, theme }) {
  if (!messages.length) return null;

  const borderColor = theme?.border || 'green';
  const maxContentWidth = cols - 4; // account for border padding

  return (
    <Box flexDirection="column" width={cols}>
      {messages.map((msg, i) => {
        const isUser = msg.role === 'user';
        const isAssistant = msg.role === 'assistant' || msg.role === 'model';
        const isTool = msg.role === 'tool' || msg.role === 'system';
        const isThinking = msg.role === 'thinking';

        const roleLabel = isUser ? '👤 YOU' : isAssistant ? '🤖 AI' : isTool ? '🔧 TOOL' : isThinking ? '🧠 THINK' : '◆';
        const roleColor = isUser ? (theme?.primary || 'green') : isAssistant ? (theme?.secondary || 'cyan') : isThinking ? 'yellow' : 'gray';
        const cardBorder = isUser ? (theme?.primary || 'green') : isThinking ? 'yellow' : (theme?.secondary || 'cyan');

        // Truncate long content
        let content = msg.content || msg.text || '';
        if (typeof content === 'object') content = JSON.stringify(content);
        const lines = content.split('\n');
        const maxLines = isThinking ? 4 : 20;
        const truncated = lines.length > maxLines;
        const shownLines = lines.slice(0, maxLines);
        const shownContent = shownLines.join('\n') + (truncated ? `\n… +${lines.length - maxLines} more lines` : '');

        return (
          <Box
            key={i}
            flexDirection="column"
            borderStyle={isThinking ? 'single' : 'round'}
            borderColor={cardBorder}
            paddingX={1}
            width={cols}
            marginBottom={0}
            marginTop={0}
          >
            {/* Header bar */}
            <Box justifyContent="space-between" alignItems="center">
              <Text color={roleColor} bold>
                {roleLabel}
              </Text>
              {msg.model && (
                <Text color="gray" dim>
                  {msg.model}
                </Text>
              )}
              {msg.timestamp && (
                <Text color="gray" dim>
                  {msg.timestamp}
                </Text>
              )}
            </Box>
            {/* Content */}
            <Box marginTop={0}>
              <Text
                color={isThinking ? 'gray' : 'white'}
                dim={isThinking}
                wrap="truncate"
              >
                {shownContent}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}