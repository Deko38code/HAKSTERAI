import React from 'react';
import { Box, Text } from 'ink';

const SIDE_BY_SIDE_MIN_COLS = 100; // two columns need real width — narrower falls back to unified

// Turn a unified diff into { left, right } row pairs: consecutive '-' lines paired against
// the consecutive '+' lines that follow them (classic side-by-side diff pairing), context
// lines mirrored on both sides, unpaired remainder padded with a blank cell on the other side.
function pairDiffRows(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff') || line.startsWith('---') || line.startsWith('+++')) {
      rows.push({ left: { text: line, kind: 'meta' }, right: { text: line, kind: 'meta' } });
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      rows.push({ left: { text: line, kind: 'hunk' }, right: { text: line, kind: 'hunk' } });
      i++;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      const removed = [];
      while (i < lines.length && lines[i].startsWith('-') && !lines[i].startsWith('---')) { removed.push(lines[i].slice(1)); i++; }
      const added = [];
      while (i < lines.length && lines[i].startsWith('+') && !lines[i].startsWith('+++')) { added.push(lines[i].slice(1)); i++; }
      const n = Math.max(removed.length, added.length);
      for (let r = 0; r < n; r++) {
        rows.push({
          left: r < removed.length ? { text: removed[r], kind: 'del' } : { text: '', kind: 'blank' },
          right: r < added.length ? { text: added[r], kind: 'add' } : { text: '', kind: 'blank' },
        });
      }
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      // '+' with no preceding '-' — pure addition, nothing on the left
      rows.push({ left: { text: '', kind: 'blank' }, right: { text: line.slice(1), kind: 'add' } });
      i++;
      continue;
    }
    // Context line (unchanged) — same on both sides
    const text = line.startsWith(' ') ? line.slice(1) : line;
    rows.push({ left: { text, kind: 'ctx' }, right: { text, kind: 'ctx' } });
    i++;
  }
  return rows;
}

const KIND_COLOR = { del: 'red', add: 'green', hunk: 'cyan', meta: 'magenta', ctx: 'gray', blank: 'gray' };
const KIND_PREFIX = { del: '-', add: '+', hunk: '@', meta: ' ', ctx: ' ', blank: ' ' };

function Cell({ cell, width }) {
  const color = KIND_COLOR[cell.kind] || 'gray';
  const prefix = KIND_PREFIX[cell.kind] || ' ';
  const dim = cell.kind === 'ctx' || cell.kind === 'blank';
  return (
    <Text color={color} dim={dim} wrap="truncate">
      {prefix} {cell.text.slice(0, Math.max(0, width - 2))}
    </Text>
  );
}

export default function DiffPreview({ diff, cols = 80, onApprove, onDeny }) {
  if (!diff) return null;

  const allLines = diff.split('\n');
  const capped = allLines.slice(0, 40); // side-by-side reads fine a bit deeper than the old 20-line unified cap
  const sideBySide = cols >= SIDE_BY_SIDE_MIN_COLS;
  const colWidth = Math.floor((cols - 6) / 2);

  const rows = sideBySide ? pairDiffRows(capped) : null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="yellow" bold>
          ⚠ Diff Preview {sideBySide ? '— old │ new' : '(unified)'} — Review Before Apply
        </Text>
        <Text color="gray" dim>
          Y=approve │ N=deny │ V=view more
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {sideBySide ? (
          rows.map((row, i) => (
            <Box key={i} flexDirection="row">
              <Box width={colWidth}><Cell cell={row.left} width={colWidth} /></Box>
              <Text color="gray" dim> │ </Text>
              <Box width={colWidth}><Cell cell={row.right} width={colWidth} /></Box>
            </Box>
          ))
        ) : (
          capped.map((line, i) => {
            let color = 'gray';
            let prefix = ' ';
            if (line.startsWith('+') && !line.startsWith('+++')) { color = 'green'; prefix = '+'; }
            else if (line.startsWith('-') && !line.startsWith('---')) { color = 'red'; prefix = '-'; }
            else if (line.startsWith('@@')) { color = 'cyan'; prefix = '@'; }
            else if (line.startsWith('diff') || line.startsWith('---') || line.startsWith('+++')) { color = 'magenta'; prefix = ' '; }
            return (
              <Text key={i} color={color} wrap="truncate">
                {prefix} {line.slice(0, cols - 4)}
              </Text>
            );
          })
        )}
        {allLines.length > capped.length && (
          <Text color="gray" dim>
            ... {allLines.length - capped.length} more lines (press V to view)
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
