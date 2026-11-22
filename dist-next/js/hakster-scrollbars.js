/* hakster-scrollbars.js — always-visible scrollbars, everywhere they are needed.
 *
 * Why this exists: Chrome/Chromium on Linux ships *overlay* scrollbars. They stay
 * invisible until you hover near the edge, and while overlay mode is on the
 * browser ignores `::-webkit-scrollbar` styling. Firefox honours
 * `scrollbar-width` / `scrollbar-color`, so it already draws real bars — that part
 * is CSS (src/styles/global.css).
 *
 * This script closes the gap for overlay-scrollbar browsers:
 *   • it measures each scrollable element and, ONLY when the browser is not
 *     already reserving layout space for a native bar, draws a slim fixed bar that
 *     tracks that element (page, dashboard tab strip, tables, logs, panes),
 *   • the thumb is draggable and the bar re-measures on resize / DOM change,
 *   • it never wraps or moves your content, and skips xterm (which draws its own)
 *     and anything with less than 24px of overflow.
 *
 * No dependencies. No data leaves the page.
 */
(function () {
  'use strict';
  if (window.__haksterScrollbars) return;
  window.__haksterScrollbars = true;

  var BAR = 10;          // thickness of our bar, px
  var MIN_OVERFLOW = 24; // ignore boxes with less than this to scroll
  var MIN_VISIBLE = 24;  // hide a bar when its box is mostly off screen
  var Z = 2147483000;
  // Element kinds that can be a scroll container. Anything else (span, b, i,
  // svg, path, img, a …) is never measured — reading its scrollHeight would
  // still force a layout, and there are thousands of them on a dashboard.
  // A real scroll container of another kind opts in with data-hk-scroll.
  var SCROLL_HOSTS = {
    DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, ASIDE: 1, NAV: 1, HEADER: 1, FOOTER: 1,
    PRE: 1, OL: 1, UL: 1, TABLE: 1, TBODY: 1, THEAD: 1, TFOOT: 1, TD: 1, TH: 1,
    TEXTAREA: 1, FORM: 1, FIELDSET: 1, BLOCKQUOTE: 1, DL: 1, DD: 1, DIALOG: 1, DETAILS: 1,
  };

  var trackStyle = 'position:fixed;z-index:' + Z + ';pointer-events:none;background:rgba(20,20,29,.92);border-radius:999px;transition:opacity .15s ease;';
  var thumbStyle = 'position:absolute;background:#7c3aed;border-radius:999px;pointer-events:auto;cursor:grab;';

  var tracked = [];
  var raf = 0;

  // Incremental scanning state (see collect()). `visited` remembers nodes that
  // were measured and did not scroll; `dirtySet` holds the ancestors of nodes
  // that changed and must be looked at again.
  function newSeen() {
    if (typeof WeakSet === 'function') return new WeakSet();
    return { has: function () { return false; }, add: function () {} };
  }
  var visited = null;
  var dirtySet = newSeen();
  var lastFullScan = 0;
  var FULL_SCAN_MS = 60000;

  function makeBar(axis) {
    var bar = document.createElement('div');
    bar.setAttribute('data-hk-scrollbar', axis);
    bar.style.cssText = trackStyle + (axis === 'y' ? 'width:' + BAR + 'px;' : 'height:' + BAR + 'px;') + 'opacity:0;';
    var thumb = document.createElement('div');
    thumb.style.cssText = thumbStyle + (axis === 'y' ? 'width:100%;' : 'height:100%;');
    bar.appendChild(thumb);
    document.body.appendChild(bar);
    return { bar: bar, thumb: thumb };
  }

  function scrollsAxis(el, axis) {
    var o = getComputedStyle(el)[axis === 'y' ? 'overflowY' : 'overflowX'];
    return o === 'auto' || o === 'scroll' || o === 'overlay';
  }
  function overflows(el, axis) {
    return (axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth) > MIN_OVERFLOW;
  }
  // A native bar that reserves layout space means the browser already shows one.
  function hasNativeBar(el, axis) {
    return (axis === 'y' ? el.offsetWidth - el.clientWidth : el.offsetHeight - el.clientHeight) > 4;
  }

  function collect() {
    var out = [];
    var de = document.documentElement;
    if (de.scrollHeight - window.innerHeight > MIN_OVERFLOW) out.push({ el: document.scrollingElement || de, axis: 'y', page: true });
    if (de.scrollWidth - window.innerWidth > MIN_OVERFLOW) out.push({ el: document.scrollingElement || de, axis: 'x', page: true });
    var all = document.querySelectorAll('*');
    // 2026-11-21 (owner: "haksterai admin dash is lagging freezing find
    // culprit"): this loop used to call getBoundingClientRect() and
    // getComputedStyle() for EVERY element. On the owner dashboard (~4,400
    // nodes) the live cards rewrite their DOM every few seconds, which fired a
    // rescan and forced a full-document layout thousands of times — 7.5 s of
    // main-thread time in 25 s, with individual freezes over a second.
    // Second pass (same day, the profile still showed collect() at ~340 ms per
    // scan): only element kinds that can actually be a scroll container are
    // measured at all, and elements already tracked stay tracked. Reading
    // scrollHeight forces a layout, so the whole document must never be read.
    // Third pass: a node that was already measured and did not scroll is not
    // measured again on every beat — only new nodes, the ancestors of a DOM
    // change, and currently tracked elements are. A full re-measure runs on a
    // resize and once a minute, so nothing can stay missed for long.
    var full = !visited || Date.now() - lastFullScan > FULL_SCAN_MS;
    if (full) { visited = newSeen(); lastFullScan = Date.now(); }
    var dirtyNow = dirtySet;
    dirtySet = newSeen();
    var keepEls = [];
    for (var k = 0; k < tracked.length; k++) keepEls.push(tracked[k].el);
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!el || el.nodeType !== 1) continue;
      if (el === document.body || el === document.documentElement) continue;
      var known = keepEls.indexOf(el) >= 0;
      if (!full && !known && !dirtyNow.has(el) && visited.has(el)) continue;
      if (visited.add) visited.add(el);
      var tag = el.tagName;
      if (!SCROLL_HOSTS[tag] && !known && !(el.hasAttribute && (el.hasAttribute('data-hk-scroll') || el.hasAttribute('data-scroll')))) continue;
      if (el.scrollHeight - el.clientHeight <= MIN_OVERFLOW && el.scrollWidth - el.clientWidth <= MIN_OVERFLOW) continue;
      if (el.closest && el.closest('.xterm')) continue; // xterm draws its own bar
      if (scrollsAxis(el, 'y') && overflows(el, 'y') && !hasNativeBar(el, 'y')) out.push({ el: el, axis: 'y' });
      if (scrollsAxis(el, 'x') && overflows(el, 'x') && !hasNativeBar(el, 'x')) out.push({ el: el, axis: 'x' });
    }
    return out;
  }

  function track(list) {
    var keep = [];
    for (var i = 0; i < tracked.length; i++) {
      var t = tracked[i];
      var still = list.some(function (d) { return d.el === t.el && d.axis === t.axis; });
      if (still) keep.push(t);
      else if (t.bar.parentNode) t.bar.parentNode.removeChild(t.bar);
    }
    list.forEach(function (d) {
      var hit = keep.find(function (t) { return t.el === d.el && t.axis === d.axis; });
      if (!hit) {
        var made = makeBar(d.axis);
        hit = { el: d.el, axis: d.axis, page: !!d.page, bar: made.bar, thumb: made.thumb };
        wireDrag(hit);
        keep.push(hit);
      }
    });
    tracked = keep;
    paint();
  }

  function wireDrag(t) {
    t.thumb.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      t.drag = { start: t.axis === 'y' ? ev.clientY : ev.clientX, from: t.axis === 'y' ? t.el.scrollTop : t.el.scrollLeft };
      t.thumb.style.cursor = 'grabbing';
      try { t.thumb.setPointerCapture(ev.pointerId); } catch (e) {}
    });
    t.thumb.addEventListener('pointermove', function (ev) {
      if (!t.drag) return;
      var view = t.axis === 'y' ? t.el.clientHeight : t.el.clientWidth;
      var total = t.axis === 'y' ? t.el.scrollHeight : t.el.scrollWidth;
      var thumbLen = t.axis === 'y' ? t.thumb.offsetHeight : t.thumb.offsetWidth;
      var trackLen = (t.axis === 'y' ? t.bar.offsetHeight : t.bar.offsetWidth) - thumbLen;
      if (trackLen <= 0 || total <= view) return;
      var moved = ((t.axis === 'y' ? ev.clientY : ev.clientX) - t.drag.start) * ((total - view) / trackLen);
      if (t.axis === 'y') t.el.scrollTop = t.drag.from + moved;
      else t.el.scrollLeft = t.drag.from + moved;
    });
    ['pointerup', 'pointercancel'].forEach(function (name) {
      t.thumb.addEventListener(name, function () { t.drag = null; t.thumb.style.cursor = 'grab'; });
    });
  }

  function place(t, view, total, pos, trackLen, barTop, barLeft, horizontal) {
    if (total - view <= 4 || trackLen < MIN_VISIBLE) { t.bar.style.opacity = '0'; return; }
    var thumbLen = Math.max(28, Math.round(trackLen * (view / total)));
    var offset = Math.round((trackLen - thumbLen) * Math.min(1, Math.max(0, pos / (total - view))));
    if (horizontal) {
      t.bar.style.top = Math.round(barTop) + 'px';
      t.bar.style.left = Math.round(barLeft) + 'px';
      t.bar.style.width = Math.round(trackLen) + 'px';
      t.thumb.style.left = offset + 'px';
      t.thumb.style.top = '0';
      t.thumb.style.width = thumbLen + 'px';
      t.thumb.style.height = '100%';
    } else {
      t.bar.style.top = Math.round(barTop) + 'px';
      t.bar.style.left = Math.round(barLeft) + 'px';
      t.bar.style.height = Math.round(trackLen) + 'px';
      t.thumb.style.top = offset + 'px';
      t.thumb.style.left = '0';
      t.thumb.style.height = thumbLen + 'px';
      t.thumb.style.width = '100%';
    }
    t.bar.style.opacity = '1';
  }

  function paint() {
    for (var i = 0; i < tracked.length; i++) {
      var t = tracked[i];
      var el = t.el;

      if (t.page) {
        if (t.axis === 'y') {
          place(t, window.innerHeight, el.scrollHeight, window.scrollY, window.innerHeight,
            0, window.innerWidth - BAR - 2, false);
        } else {
          place(t, window.innerWidth, el.scrollWidth, window.scrollX, window.innerWidth,
            window.innerHeight - BAR - 2, 0, true);
        }
        continue;
      }

      var rect = el.getBoundingClientRect();
      if (t.axis === 'y') {
        // Only draw for a box that is fully on screen; otherwise it would need
        // clipping maths that make the thumb lie about position.
        if (rect.top < 0 || rect.bottom > window.innerHeight || rect.height < MIN_VISIBLE) {
          t.bar.style.opacity = '0';
          continue;
        }
        place(t, el.clientHeight, el.scrollHeight, el.scrollTop, rect.height,
          rect.top, rect.right - BAR - 2, false);
      } else {
        if (rect.left < 0 || rect.right > window.innerWidth || rect.width < MIN_VISIBLE) {
          t.bar.style.opacity = '0';
          continue;
        }
        place(t, el.clientWidth, el.scrollWidth, el.scrollLeft, rect.width,
          rect.bottom - BAR - 2, rect.left, true);
      }
    }
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; paint(); });
  }
  var scanTimer = 0;
  var lastScan = 0;
  function rescan() { lastScan = Date.now(); track(collect()); }
  // Coalesce bursts of DOM changes into one scan, and never scan more than
  // once every two seconds. The live dashboard mutates hundreds of nodes every
  // beat; without this cap the rescan was effectively continuous, and each
  // scan forces a layout over the whole page.
  var SCAN_DEBOUNCE_MS = 800;
  var SCAN_MIN_GAP_MS = 2000;
  function rescanSoon() {
    clearTimeout(scanTimer);
    var wait = Math.max(SCAN_DEBOUNCE_MS, SCAN_MIN_GAP_MS - (Date.now() - lastScan));
    scanTimer = setTimeout(rescan, wait);
  }

  window.addEventListener('resize', function () { visited = null; rescanSoon(); }, { passive: true });
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  if (window.MutationObserver) {
    // childList only: class/style toggles inside the live cards fired this
    // observer constantly and never change what can scroll. The parent of each
    // changed subtree is looked at again on the next scan even if its nodes
    // were already measured — a log pane that just grew must not be skipped.
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target;
        if (t && t.nodeType === 1) dirtySet.add(t);
      }
      rescanSoon();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rescan);
  else rescan();
  setTimeout(rescan, 600);
  setTimeout(rescan, 2000);
})();
