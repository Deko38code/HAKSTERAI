import React, { useEffect, useRef, useState } from 'react';
import fs from 'node:fs';
import { useRenderer } from '@opentui/react';
import { deleteImage, deletePlacement, isSupported, moveCursor, placeById, placeImage, pngSize } from '../../../src/kitty-graphics.js';
import { materialize } from '../../../src/live-image.js';
import { clip } from './LiveSidebar.jsx';

/* LiveImageViewer — the picture behind live-URL work, shown in the output panel.
 *
 * Owner 2026-11-23: "we need the live image viewer in the output panels when
 * showing live url work". A screenshot a tool produced (local path, image URL
 * or inline data:) is drawn with the kitty graphics protocol over exactly the
 * rows this component was budgeted, so no panel above it moves.
 *
 * Plain terminals are never faked: when the protocol is not available, or the
 * source turns out not to be an image, the same rows carry the name, the real
 * reason and the URL/path — which is what the operator can actually open.
 *
 * Placement follows DecodeSplash's proven pattern: pause the renderer while the
 * base64 stream goes out, place at z=-1 over the reserved cells, re-place on
 * every 'frame' (a repaint erases what covered the cells), and delete by id on
 * the way out.
 */
export default function LiveImageViewer({
  width = 40,
  height = 6,
  source = null,
  graphics = true,
  label = '',
}) {
  const w = Math.max(8, Number(width) || 40);
  const h = Math.max(2, Number(height) || 6);
  const renderer = useRenderer();
  const boxRef = useRef(null);
  const [state, setState] = useState({ status: 'waiting' });
  const ref = source && source.ref ? String(source.ref) : '';

  // Fetch/resolve the picture whenever the source changes. A late answer for a
  // source that is no longer on screen is dropped, never shown.
  useEffect(() => {
    let cancelled = false;
    if (!source || !source.ref) {
      setState({ status: 'none' });
      return undefined;
    }
    setState({ status: 'loading' });
    materialize(source).then((r) => {
      if (cancelled) return;
      setState(r && r.ok ? { status: 'ready', file: r.file, name: r.name } : { status: 'error', reason: (r && r.reason) || 'unavailable' });
    }).catch((e) => {
      if (!cancelled) setState({ status: 'error', reason: (e && e.message) || 'unavailable' });
    });
    return () => { cancelled = true; };
  }, [ref]);

  const supported = graphics && isSupported(process.env, process.stdout);
  const ready = state.status === 'ready' && supported;

  // Transmit + place. Re-placing is two short sequences per frame, so a live
  // view costs nothing between images.
  useEffect(() => {
    if (!ready || !state.file) return undefined;
    let placed = null;
    let onFrame = null;
    let disposed = false;
    const withPaused = (fn) => {
      try {
        if (renderer && typeof renderer.pause === 'function') renderer.pause();
        return fn();
      } finally {
        try {
          if (renderer && typeof renderer.resume === 'function') renderer.resume();
        } catch {
          /* graphics must never break the session */
        }
      }
    };
    const spot = () => {
      const box = boxRef.current;
      if (!box) return null;
      const x = Number(typeof box.screenX === 'function' ? box.screenX() : box.screenX);
      const y = Number(typeof box.screenY === 'function' ? box.screenY() : box.screenY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { row: Math.max(1, Math.round(y) + 1), col: Math.max(1, Math.round(x) + 1) };
    };
    const settle = () => {
      if (disposed) return;
      const at = spot();
      if (!at) return;
      let size = null;
      try { size = pngSize(fs.readFileSync(state.file)); } catch { size = null; }
      let cols = w;
      let rows = h;
      if (size && size.width > 0 && size.height > 0) {
        // A terminal cell is about twice as tall as it is wide (8×16 px), so a
        // pixel aspect fits when cols/rows ≈ 2·w/h.
        rows = h;
        cols = Math.round((rows * size.width) / (size.height * 2));
        if (cols > w) { cols = w; rows = Math.max(1, Math.round((cols * size.height * 2) / size.width)); }
        if (cols < 4) cols = Math.min(w, 4);
        if (rows < 1) rows = 1;
        if (rows > h) rows = h;
      }
      withPaused(() => {
        const write = (s) => process.stdout.write(s);
        moveCursor(at.row, at.col, write);
        if (placed) deletePlacement({ placementId: 1, write });
        if (!placed) placed = placeImage({ file: state.file, cols, rows, zIndex: -1 });
        else placeById({ id: placed.id, placementId: 1, zIndex: -1, write });
      });
      if (!onFrame && placed && renderer && typeof renderer.on === 'function') {
        onFrame = () => { if (placed) { const at2 = spot(); if (at2) withPaused(() => { const write = (s) => process.stdout.write(s); moveCursor(at2.row, at2.col, write); placeById({ id: placed.id, placementId: 1, zIndex: -1, write }); }); } };
        try { renderer.on('frame', onFrame); } catch { onFrame = null; }
      }
    };
    const timer = setTimeout(settle, 40);
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (onFrame) { try { renderer.off('frame', onFrame); } catch { /* ignore */ } }
      if (placed) withPaused(() => deleteImage(placed.id));
    };
  }, [ready, state.file, w, h, renderer]);

  // Text fallback (and the honest state while loading): same rows, same width.
  const line = (text, fg) => (
    <box style={{ width: w, flexShrink: 0 }}>
      <text fg={fg}>{clip(text, w)}</text>
    </box>
  );
  const pad = (n) => Array.from({ length: Math.max(0, n) }, (_, i) => (
    <box key={`pad:${i}`} style={{ width: w, flexShrink: 0 }}><text> </text></box>
  ));

  if (ready) {
    return <box ref={boxRef} style={{ width: w, height: h, flexShrink: 0 }} />;
  }
  const head = state.status === 'error'
    ? `▦ ${state.reason}`
    : state.status === 'loading'
      ? '▦ loading…'
      : '▦ image';
  const name = label || (source && source.name) || '';
  const where = source && source.ref ? String(source.ref) : '';
  const rows = [
    [head, 'yellow'],
    [name ? `image: ${name}` : '', 'white'],
    [where ? (supported ? 'in terminal: kitty graphics' : 'no graphics here — open this link:') : '', 'gray'],
    [where, 'cyan'],
  ];
  return (
    <>
      {rows.slice(0, h).map(([text, fg], i) => line(text, i === 0 ? fg : fg))}
      {pad(h - rows.length)}
    </>
  );
}
