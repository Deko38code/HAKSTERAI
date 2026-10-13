'use strict';
/* ════════════════════════════════════════════════════════════════════════
 * Inline ad layout — how an ad is fitted into a FIXED character width.
 *
 * Kept in one place so the CLI that renders an ad and any admin/console
 * preview of that ad cannot drift: a CSS approximation of this would be a
 * lie, because the terminal grid is the contract.
 *
 * NOTE ON WIDTH: `truncateToWidth` measures with `String.length`, which counts
 * UTF-16 code units, not display columns. Emoji and CJK text therefore
 * truncate differently here than a proportional-font preview suggests. That is
 * Freebuff's documented behaviour and is reproduced deliberately.
 *
 * PORTED FROM: CodebuffAI/freebuff `common/src/ads/inline-ad-layout.ts`
 * (Apache-2.0). See ATTRIBUTION.md. Changes: TypeScript -> CommonJS, the
 * Dock V2 panel specifics dropped, `wrapToLines` kept.
 * ════════════════════════════════════════════════════════════════════════ */

const { sanitizeTerminalText } = require('./terminal-safe-text');

/** Widths where inline ad layout actually changes behaviour. */
const MIN_INLINE_WIDTH_WITH_DESTINATION = 48;
/** The narrowest width the transcript renderer draws an inline ad at. */
const MIN_INLINE_AD_WIDTH = 20;
const MAX_DESC_LINES = 2;
const INLINE_AD_DISCLOSURE = 'Ad';
const INLINE_AD_GAP = 2;
const INLINE_AD_LINK_SUFFIX = ' ↗';

function truncateToLines(text, lineWidth, maxLines) {
  if (lineWidth <= 0) return text;
  const maxChars = lineWidth * maxLines;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}

function truncateToWidth(text, width) {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  return text.slice(0, width - 1) + '…';
}

const extractDomain = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // An unparseable value is shown as-is, so it must at least be inert.
    return sanitizeTerminalText(url);
  }
};

/**
 * What the ad shows as its destination. An ad with no destination URL falls
 * back to its title — a headline where a normal ad renders `neon.tech`.
 */
function getAdDisplayLabel(ad) {
  const url = String(ad.url || '').trim();
  if (url) return { text: extractDomain(url), variant: 'domain' };
  return { text: String(ad.title || '').trim() || 'Sponsored', variant: 'title' };
}

/**
 * Fit an ad into `width` columns.
 *
 * Below {@link MIN_INLINE_WIDTH_WITH_DESTINATION} the destination label is
 * dropped entirely — the advertiser's domain is not shown at all. That is the
 * single most surprising thing about narrow terminals.
 */
function getInlineAdLayout(ad, width) {
  const contentWidth = Math.max(0, width - 4); // border + horizontal padding
  const displayLabel = getAdDisplayLabel(ad);
  const headerTrailingWidth = INLINE_AD_GAP + INLINE_AD_DISCLOSURE.length;
  const titleWidth = Math.max(0, contentWidth - headerTrailingWidth);
  const destinationLabel =
    width >= MIN_INLINE_WIDTH_WITH_DESTINATION && displayLabel.variant === 'domain'
      ? displayLabel.text
      : '';
  const maxLabelWidth = Math.max(0, Math.min(24, Math.floor(contentWidth / 3)));
  const label = truncateToWidth(destinationLabel, maxLabelWidth);
  const trailingWidth = label
    ? INLINE_AD_GAP + label.length + INLINE_AD_LINK_SUFFIX.length
    : 0;
  const descriptionWidth = Math.max(0, contentWidth - trailingWidth);

  return {
    title: truncateToWidth(String(ad.title || '').trim() || displayLabel.text, titleWidth),
    description: truncateToWidth(String(ad.adText || '').trim(), descriptionWidth),
    label,
  };
}

/**
 * Word-wrap `text` into at most `maxLines` lines of `width` columns.
 *
 * A word longer than the line is hard-split rather than allowed to overflow —
 * a URL in an advertiser's body must not push a box's border off-screen.
 * Overflow past `maxLines` is truncated with an ellipsis on the last line.
 */
function wrapToLines(text, width, maxLines) {
  if (width <= 0 || maxLines <= 0) return [];
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines = [];
  let current = '';
  const pushCurrent = () => {
    if (current) lines.push(current);
    current = '';
  };

  let overflowed = false;
  for (const word of words) {
    let remaining = word;
    // A single word longer than the line is hard-split.
    while (remaining.length > width) {
      pushCurrent();
      lines.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
      if (lines.length >= maxLines) { overflowed = true; break; }
    }
    if (overflowed) break;
    if (!current) current = remaining;
    else if (current.length + 1 + remaining.length <= width) current += ' ' + remaining;
    else { pushCurrent(); current = remaining; }
    if (lines.length >= maxLines) { overflowed = true; break; }
  }
  pushCurrent();

  if (lines.length > maxLines) lines.length = maxLines;
  if (overflowed && lines.length) {
    const last = lines[lines.length - 1];
    if (last.length >= width) lines[lines.length - 1] = last.slice(0, width - 1) + '…';
  }
  return lines;
}

module.exports = {
  MIN_INLINE_WIDTH_WITH_DESTINATION,
  MIN_INLINE_AD_WIDTH,
  MAX_DESC_LINES,
  INLINE_AD_DISCLOSURE,
  INLINE_AD_GAP,
  INLINE_AD_LINK_SUFFIX,
  truncateToLines,
  truncateToWidth,
  extractDomain,
  getAdDisplayLabel,
  getInlineAdLayout,
  wrapToLines,
};
