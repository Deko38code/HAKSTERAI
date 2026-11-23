import { useCallback, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import {
  clampStart,
  gutterChar,
  keyMatches,
  maxStartOf,
  nearestStart,
  scrollHint,
  stepOffset,
} from '../utils/panel-scroll.js';

/* usePanelScroll — the one scroll state every panel shares.
 *
 * The renderer runs every useKeyboard handler that is mounted, so the panel
 * that owns a key has to be chosen by the binding, not by focus: Activity and
 * Output use shift+arrows, the MCP list alt+arrows, the MCP output ctrl+arrows,
 * and the transcript PgUp/PgDn is handled by App. A panel passes only its own
 * binding map, so two panels can never answer the same chord.
 *
 * `offset === null` is the auto-follow state: the window sits on the newest
 * rows and stays there while a run streams. Scrolling back parks it; reaching
 * the bottom again hands it back to auto-follow (`stepOffset` returns null).
 *
 * `selected` switches the window from follow-tail to keep-the-cursor-visible,
 * which is what the models picker and the catalog popout need.
 */
export function usePanelScroll({
  total = 0,
  rows = 0,
  bindings = null,
  enabled = true,
  initial = 'follow',
  selected = null,
}) {
  const [offset, setOffsetState] = useState(initial === 'top' ? 0 : null);

  const n = Math.max(0, Math.trunc(Number(total) || 0));
  const r = Math.max(0, Math.trunc(Number(rows) || 0));
  const start = selected == null ? clampStart(offset, n, r) : nearestStart(selected, n, r);
  const following = selected != null ? true : offset == null;

  const setOffset = useCallback((value) => {
    setOffsetState((cur) => (typeof value === 'function' ? value(cur) : value));
  }, []);

  const scrollBy = useCallback(
    (delta) => {
      setOffsetState((cur) => stepOffset(cur, n, r, delta));
    },
    [n, r],
  );

  const toTop = useCallback(() => setOffsetState(0), []);
  const toBottom = useCallback(() => setOffsetState(null), []);

  useKeyboard((key) => {
    if (!enabled || !bindings || !r) return;
    const names = ['up', 'down', 'pageup', 'pagedown', 'home', 'end', 'left', 'right'];
    for (const name of names) {
      const mod = bindings[name];
      if (!mod || !keyMatches(key, name, mod)) continue;
      if (name === 'home') return toTop();
      if (name === 'end') return toBottom();
      const page = name === 'pageup' || name === 'pagedown';
      const back = name === 'up' || name === 'pageup' || name === 'left';
      const delta = page ? (back ? -Math.max(1, r) : Math.max(1, r)) : back ? -1 : 1;
      return scrollBy(delta);
    }
  });

  return {
    offset,
    setOffset,
    start,
    following,
    total: n,
    rows: r,
    maxStart: maxStartOf(n, r),
    gutter: (i) => (selected == null && n > r ? gutterChar(i, r, n, start) : null),
    hint: (fallback = '') => (n === 0 ? fallback : scrollHint(n, r, start, following)),
    scrollBy,
    toTop,
    toBottom,
  };
}

export default usePanelScroll;
