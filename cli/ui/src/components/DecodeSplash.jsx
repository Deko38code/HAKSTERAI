import React, { useEffect, useRef, useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { TextAttributes } from '@opentui/core';
import { useRenderer } from '@opentui/react';
import { deleteImage, deletePlacement, heroPath, isSupported, moveCursor, placeById, placeImage, splashPath } from '../../../src/kitty-graphics.js';
import { isSourceCheckout } from '../../../src/updater.js';
import { HERO_WORDMARK, HERO_W, HERO_GREEN } from './HeroLogo.jsx';
import { scScramble } from '../utils/crush-scrambler.js';

/* DecodeSplash — the CLI's start screen: five lines decode at the same time.
 *
 * Owner, 2026-11-23: "the decoder feat … decodes 5 lines simultaneously".
 * Each line starts as scrambled letters and digits, keeps its real spaces and
 * punctuation, and reveals itself left to right — all five lines together, then
 * the screen hands over to the dashboard. Nothing here is decorative fiction:
 * the five lines are the CLI's real name, version, model, server state and the
 * keys that work. `/settings intro off` skips it.
 */
/* The startup hero when the terminal cannot show the PNG.
 *
 * Owner, 2026-11-23: "make sure the hero logo show on startup in our cli". The
 * hero artwork is a Kitty-graphics image, and a plain terminal (no kitty /
 * Ghostty / WezTerm) paints nothing — so the whole start screen had no logo.
 * This block wordmark is drawn whenever the image cannot be: it is the same
 * green, the same name, and it costs five rows. `HERO_W` is its exact width;
 * narrower terminals fall back to the "◆ haksterAi" line the splash already
 * decodes.
 */
// The block wordmark lives in HeroLogo.jsx — one glyph table for the whole CLI
// (owner, 2026-11-25: the same logo on the start screen, the /menu popout and
// the approval gate). See the import at the top of this file.

/* The Matrix rain behind the start screen.
 *
 * Owner, 2026-11-23: "need the matrix hacker intro on startup". Green glyphs
 * fall in columns behind the hero wordmark and the decoding lines, the way the
 * film's title sequence reads. Everything is derived from the splash's own
 * frame counter (no second timer, no extra work between renders), and only the
 * lit cells are emitted as spans — a handful per row — so the animation costs
 * almost nothing while the intro is up.
 */
const RAIN_GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789';
const RAIN_COLORS = { head: '#d8ffe6', near: '#00ff41', tail: '#0a5c22' };

function rainHash(a, b, c) {
  let h = Math.imul(a + 1, 374761393) + Math.imul(b + 1, 668265263) + Math.imul(c + 1, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** One falling stream per column, its head row and trail length for this frame. */
function rainColumns(width, height, frame) {
  const cols = Math.max(1, Math.floor(width / 2)); // one glyph per two cells
  const period = height + 12; // a head is off-screen for part of the cycle
  const streams = [];
  for (let c = 0; c < cols; c += 1) {
    const speed = 0.45 + (rainHash(c, 7, 1) % 100) / 90; // rows per frame
    const phase = rainHash(c, 11, 2) % period;
    const trail = 3 + (rainHash(c, 13, 3) % 7);
    const head = Math.floor(((frame * speed + phase) % period)) - 8;
    streams.push({ c, head, trail });
  }
  return { streams, cols };
}

function MatrixRain({ width, height, frame }) {
  const w = Math.max(2, Number(width) || 80);
  const h = Math.max(1, Number(height) || 20);
  const { streams } = rainColumns(w, h, frame);
  const rows = [];
  for (let r = 0; r < h; r += 1) {
    const parts = [];
    let pending = 0;
    for (const s of streams) {
      const dist = s.head - r;
      const lit = dist >= 0 && dist < s.trail;
      if (!lit) {
        pending += 2;
        continue;
      }
      if (pending) {
        parts.push(<span key={`p${parts.length}`}>{' '.repeat(pending)}</span>);
        pending = 0;
      }
      const glyph = RAIN_GLYPHS[rainHash(s.c, r, Math.floor(frame / 2)) % RAIN_GLYPHS.length];
      const color = dist === 0 ? RAIN_COLORS.head : dist <= 2 ? RAIN_COLORS.near : RAIN_COLORS.tail;
      parts.push(<span key={`g${parts.length}`} fg={color}>{glyph}</span>);
      pending = 1; // the cell beside each glyph stays blank
    }
    if (pending) parts.push(<span key={`t${parts.length}`}>{' '.repeat(pending)}</span>);
    rows.push(
      <box key={`rain:${r}`} style={{ width: w, flexDirection: 'row', flexShrink: 0, height: 1 }}>
        <text>{parts}</text>
      </box>,
    );
  }
  return (
    <box style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, flexDirection: 'column', overflow: 'hidden' }}>
      {rows}
    </box>
  );
}

/* The real artwork on a terminal without Kitty graphics.
 *
 * Owner, 2026-11-23: "i want that logo in cli" — pointing at the hacker-desk
 * HaksterAI artwork that ships as assets/haksterai-hero.png. Kitty-class
 * terminals get that PNG; everywhere else the same picture is drawn from a
 * pre-computed 80x60 pixel grid (scripts/make-hero-art.mjs) as half-block
 * cells, so the actual logo appears in any truecolor terminal. The Matrix rain
 * is composited into the same cells — one row of spans per text row, so the
 * animation never costs a second full-screen pass.
 */
const _artCache = new Map();
function loadHeroArt(imageFile) {
  const png = imageFile || heroPath();
  if (_artCache.has(png)) return _artCache.get(png);
  let art = null;
  try {
    // `haksterai-hero.png` → `haksterai-hero.art.json`; the backdrop has its
    // own grid generated from the same picture the Guake profile paints.
    const file = png.replace(/\.png$/i, '.art.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const px = Buffer.from(String(json.rgbBase64 || ''), 'base64');
    art = px.length === json.width * json.height * 3
      ? { width: json.width, height: json.height, px }
      : null;
  } catch {
    art = null;
  }
  _artCache.set(png, art);
  return art;
}

/** The start screen's own picture.
 *
 *  Owner, 2026-11-26: "i want that as my background in cli when users install
 *  our to the hacker theme image on startup use that one dont change my
 *  startup". An installed copy starts on the hacker-theme backdrop — the same
 *  PNG his Guake drop-down paints behind the TUI — while a source checkout
 *  (his own dev tree, §8) keeps exactly the startup it has always had. The
 *  shipped hero remains the fallback when the backdrop is absent.
 */
function splashImage() {
  let checkout = true; // an install we cannot read keeps the hero, not a guess
  try {
    checkout = isSourceCheckout();
  } catch {
    /* an unknown install keeps the hero */
  }
  return splashPath({ checkout });
}

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
const rgbHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

function HeroBackdrop({ cols, rows, frame, left = 0, top = 0, imageFile = '' }) {
  const art = loadHeroArt(imageFile || undefined);
  if (!art || cols < 8 || rows < 4) return null;
  const stepX = art.width / cols;
  const stepY = art.height / (rows * 2);
  const pixel = (c, py) => {
    const x = Math.min(art.width - 1, Math.floor(c * stepX + stepX / 2));
    const y = Math.min(art.height - 1, Math.floor(py * stepY + stepY / 2));
    const o = (y * art.width + x) * 3;
    return rgbHex(art.px[o], art.px[o + 1], art.px[o + 2]);
  };
  const { streams } = rainColumns(cols * 2, rows, frame);
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    const parts = [];
    let run = null;
    let runN = 0;
    const flush = () => {
      if (run && runN) parts.push(<span key={`a${parts.length}`} fg={run.fg} bg={run.bg}>{'▀'.repeat(runN)}</span>);
      run = null;
      runN = 0;
    };
    for (let c = 0; c < cols; c += 1) {
      const s = streams[c];
      const dist = s ? s.head - r : 99;
      if (s && dist >= 0 && dist < s.trail) {
        flush();
        const glyph = RAIN_GLYPHS[rainHash(c, r, Math.floor(frame / 2)) % RAIN_GLYPHS.length];
        const color = dist === 0 ? RAIN_COLORS.head : dist <= 2 ? RAIN_COLORS.near : RAIN_COLORS.tail;
        parts.push(<span key={`r${parts.length}`} fg={color} bg={pixel(c, r * 2 + 1)}>{glyph}</span>);
      } else {
        const fg = pixel(c, r * 2);
        const bg = pixel(c, r * 2 + 1);
        if (run && run.fg === fg && run.bg === bg) runN += 1;
        else {
          flush();
          run = { fg, bg };
          runN = 1;
        }
      }
    }
    flush();
    out.push(
      <box key={`hb:${r}`} style={{ width: cols, height: 1, flexShrink: 0 }}>
        <text>{parts}</text>
      </box>,
    );
  }
  return (
    <box style={{ position: 'absolute', left, top, width: cols, height: rows, flexDirection: 'column', overflow: 'hidden' }}>
      {out}
    </box>
  );
}

/** Fit the art inside a box while keeping the picture's own 4:3 shape; one
 *  cell is one pixel wide and two pixels tall. */
function artSize(width, height, reservedRows, imageFile = '') {
  const art = loadHeroArt(imageFile || undefined);
  if (!art) return { cols: 0, rows: 0 };
  const maxRows = Math.min(art.height / 2, height - reservedRows);
  const maxCols = Math.min(art.width, width - 2);
  if (maxRows < 8 || maxCols < 24) return { cols: 0, rows: 0 };
  let rows = maxRows;
  let cols = Math.round(rows * 2 * (art.width / art.height));
  if (cols > maxCols) {
    cols = maxCols;
    rows = Math.max(4, Math.round((cols * art.height) / art.width / 2));
  }
  return { cols, rows };
}

/* The splash scramble is CrushTerminal's own `scScramble` (utils/crush-
 * scrambler.js), so the start screen and the reasoning block scramble with one
 * function — same letters, same case, spaces and punctuation untouched. Only
 * the part still to the right of the reveal is scrambled; the revealed prefix
 * is the real text (owner, 2026-11-23: "decodes 5 lines simultaneously"). */
function scrambleLine(text, reveal, frame) {
  const t = String(text == null ? '' : text);
  const head = t.slice(0, Math.max(0, reveal));
  return head + scScramble(t.slice(head.length), head.length, frame + 1);
}

export default function DecodeSplash({ width = 80, height = 24, lines = [], onDone, stepMs = 55, graphics = true }) {
  const [frame, setFrame] = useState(0);
  const renderer = useRenderer();
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const longest = lines.reduce((n, l) => Math.max(n, String(l.text || '').length), 1);
  // ~2.4 characters reveal per frame: the longest line settles in about a
  // second, and every line decodes at the same time (owner: "decodes 5 lines
  // simultaneously"). Then a short hold shows the settled text.
  const revealStep = 2.4;
  const settleAt = Math.ceil(longest / revealStep) + 1;
  const reveal = Math.min(longest, Math.floor(frame * revealStep));
  const done = frame >= settleAt;

  // Can the hero PNG actually be drawn here? The protocol must be supported,
  // graphics not switched off, and the shipped artwork must exist. When any
  // part of that is false the block wordmark takes its place, so a start
  // screen always carries the logo (owner, 2026-11-23).
  const imageAllowed = Boolean(graphics) && isSupported(process.env, process.stdout);
  // The picture this start screen paints: the hacker-theme backdrop on an
  // installed copy, the hero on a source checkout (see splashImage above).
  const imageFile = splashImage();
  let heroAsset = false;
  try { heroAsset = imageAllowed && fs.existsSync(imageFile); } catch { heroAsset = false; }
  const [heroFailed, setHeroFailed] = useState(false);
  // No Kitty image here (or it failed to place): draw the actual artwork as
  // half-block cells. Only when even that cannot fit do we fall back to the
  // block wordmark — the start screen always carries the logo.
  const artFit = !imageAllowed || heroFailed ? artSize(width, height, lines.length + 3, imageFile) : { cols: 0, rows: 0 };
  const showArt = artFit.cols >= 24 && artFit.rows >= 8;
  const showWordmark = !showArt && (!heroAsset || heroFailed);

  useEffect(() => {
    if (done) return undefined;
    const id = setInterval(() => {
      setFrame((f) => (f + 1 >= settleAt ? settleAt : f + 1));
    }, stepMs);
    return () => clearInterval(id);
  }, [done, settleAt, stepMs]);

  // Hold the settled text briefly, then hand over — once. The callback lives in
  // a ref so a parent re-render cannot restart the timeout.
  useEffect(() => {
    if (!done) return undefined;
    const id = setTimeout(() => {
      if (typeof doneRef.current === 'function') doneRef.current();
    }, 260);
    return () => clearTimeout(id);
  }, [done]);

  // Kitty graphics: the hero artwork behind the decoding lines, when the
  // terminal speaks the protocol (kitty / Ghostty / WezTerm) and the owner has
  // not turned it off. Placement happens while the renderer is paused so no
  // repaint can interleave with the base64 stream, and the image is deleted by
  // id on the way out — it must never linger over the dashboard.
  useEffect(() => {
    if (!graphics || !isSupported(process.env, process.stdout)) return undefined;
    let placed = null;
    let row = 1;
    let col = 1;
    let onFrame = null;
    const withPausedRenderer = (fn) => {
      try {
        if (renderer && typeof renderer.pause === 'function') renderer.pause();
        return fn();
      } finally {
        try {
          if (renderer && typeof renderer.resume === 'function') renderer.resume();
        } catch {
          /* never let graphics break the session */
        }
      }
    };
    // Repaints erase images from the cells they covered, so the picture is
    // re-placed after every frame — two short sequences, no data resent.
    const placeAgain = () => {
      if (!placed) return;
      const write = (s) => process.stdout.write(s);
      moveCursor(row, col, write);
      deletePlacement({ placementId: 1, write });
      placeById({ id: placed.id, placementId: 1, write });
    };
    const timer = setTimeout(() => {
      withPausedRenderer(() => {
        // The hero is the owner's hacker-desk artwork, filling nearly the whole
        // screen *behind* the decoding lines (owner, 2026-11-23: "make the hero
        // show bigger behind would be doper"). The text paints over it because
        // the image is placed at z=-1. The asset is 4:3 and a cell is about
        // twice as tall as it is wide, so it wants 8/3 columns per row.
        let heroRows = Math.max(6, Math.floor(height * 0.94));
        let heroCols = Math.round((heroRows * 8) / 3);
        if (heroCols > width - 2) {
          heroCols = Math.max(8, width - 2);
          heroRows = Math.max(6, Math.round((heroCols * 3) / 8));
        }
        row = Math.max(1, Math.floor((height - heroRows) / 2) + 1);
        col = Math.max(1, Math.floor((width - heroCols) / 2) + 1);
        moveCursor(row, col);
        placed = placeImage({ file: imageFile, cols: heroCols, rows: heroRows });
        // A missing/unreadable asset returns null and paints nothing; the block
        // wordmark then takes over on the next render.
        if (!placed) setHeroFailed(true);
      });
      if (placed && renderer && typeof renderer.on === 'function') {
        onFrame = () => placeAgain();
        try {
          renderer.on('frame', onFrame);
        } catch {
          onFrame = null;
        }
      }
    }, 60);
    return () => {
      clearTimeout(timer);
      if (onFrame) {
        try {
          renderer.off('frame', onFrame);
        } catch {
          /* ignore */
        }
      }
      if (placed) withPausedRenderer(() => deleteImage(placed.id));
    };
  }, [graphics, renderer, width, height, lines.length, imageFile]);

  return (
    <box
      style={{
        width,
        height,
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        overflow: 'hidden',
      }}
    >
      {/* The Matrix rain sits behind everything; the content column above it is
          absolutely placed so the rain never moves it. */}
      <MatrixRain width={width} height={height} frame={frame} />
      {showArt ? (
        <HeroBackdrop
          cols={artFit.cols}
          rows={artFit.rows}
          frame={frame}
          imageFile={imageFile}
          left={Math.max(0, Math.floor((width - artFit.cols) / 2))}
          top={Math.max(0, Math.floor((height - artFit.rows) / 2))}
        />
      ) : null}
      <box
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width,
          height,
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
      {showWordmark && width >= HERO_W && height >= 14 ? (
        <>
          {HERO_WORDMARK.map((row, i) => (
            <box key={`hero:${i}`} style={{ flexDirection: 'row', flexShrink: 0 }}>
              <text fg={HERO_GREEN} attributes={TextAttributes.BOLD}>{row}</text>
            </box>
          ))}
          <box style={{ height: 1, flexShrink: 0 }} />
        </>
      ) : null}
      {lines.map((line, i) => (
        <box key={`d:${i}`} style={{ flexDirection: 'row', flexShrink: 0 }}>
          <text fg={line.color || 'gray'} attributes={line.bold ? TextAttributes.BOLD : 0}>
            {scrambleLine(line.text, reveal, frame + i)}
          </text>
        </box>
      ))}
      <box style={{ flexDirection: 'row', flexShrink: 0 }}>
        <text fg="gray">{done ? ' ' : scrambleLine('▚▚▚▚▚▚▚▚', frame, frame)}</text>
      </box>
      </box>
    </box>
  );
}
