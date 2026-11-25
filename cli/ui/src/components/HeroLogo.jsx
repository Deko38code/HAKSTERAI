import React from 'react';
import { TextAttributes } from '@opentui/core';

/* HeroLogo — the startup hero mark, reused wherever the CLI introduces itself.
 *
 * Owner, 2026-11-25: "add the hero logo i have as my startup on the popout menu
 * and dangerous command window to if you can with his name". The real artwork
 * (haksterai-hero.art.json / haksterai-hero.png) is a full-screen backdrop and
 * belongs to DecodeSplash; a popout or a gate is a few rows tall, so what fits
 * there is the same block wordmark the splash falls back to, plus the name.
 *
 * There is one glyph table and one wordmark in the codebase, and this file owns
 * them: DecodeSplash imports them from here, so the start screen, the /menu
 * popout and the approval gate can never drift into three different logos.
 *
 * Width honesty: the wordmark is exactly HERO_W cells wide. A panel narrower
 * than that draws the one-line `◆ HAKSTERAI` name instead of clipping block
 * letters into noise. `heroRowCount(width)` lets a caller budget the rows
 * before it builds its layout.
 */
export const HERO_FONT = {
  H: ['█   █', '█   █', '█████', '█   █', '█   █'],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  K: ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
};

export const HERO_WORD = 'HAKSTER';
export const HERO_NAME = 'HAKSTERAI';
export const HERO_GREEN = '#00ff41';

// Built from the glyph table so every row is exactly the same width — a
// hand-aligned block wordmark drifts by a cell and reads as noise.
export const HERO_WORDMARK = [0, 1, 2, 3, 4].map((row) =>
  HERO_WORD.split('')
    .map((ch) => HERO_FONT[ch][row])
    .join(' '),
);
export const HERO_W = Math.max(...HERO_WORDMARK.map((l) => l.length));

/** True when a panel `width` cells wide can hold the block wordmark. */
export function heroFits(width) {
  return Math.max(0, Number(width) || 0) >= HERO_W;
}

/** Rows `HeroLogo` will draw at this width: the wordmark plus the name line. */
export function heroRowCount(width) {
  return (heroFits(width) ? HERO_WORDMARK.length : 0) + 1;
}

export default function HeroLogo({ width = 60, indent = 0, subtitle = '', name = true }) {
  const pad = ' '.repeat(Math.max(0, indent));
  const blocks = heroFits((Number(width) || 60) - indent);
  const rows = [];
  if (blocks) {
    HERO_WORDMARK.forEach((row, i) => {
      rows.push(
        <box key={`hero:${i}`} style={{ flexDirection: 'row', flexShrink: 0 }}>
          <text fg={HERO_GREEN} attributes={TextAttributes.BOLD}>{pad + row}</text>
        </box>,
      );
    });
  }
  if (name) {
    rows.push(
      <box key="hero:name" style={{ flexDirection: 'row', flexShrink: 0 }}>
        <text fg={HERO_GREEN} attributes={TextAttributes.BOLD}>
          {pad + (blocks ? '' : '◆ ') + HERO_NAME}
        </text>
        {subtitle ? <text fg="gray">{`  ${subtitle}`}</text> : null}
      </box>,
    );
  }
  return <box style={{ flexDirection: 'column', flexShrink: 0 }}>{rows}</box>;
}
