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

  var trackStyle = 'position:fixed;z-index:' + Z + ';pointer-events:none;background:rgba(20,20,29,.92);border-radius:999px;transition:opacity .15s ease;';
  var thumbStyle = 'position:absolute;background:#7c3aed;border-radius:999px;pointer-events:auto;cursor:grab;';

  var tracked = [];
  var raf = 0;

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
  function skip(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.closest('.xterm')) return true; // xterm draws its own bar
    if (el === document.body || el === document.documentElement) return false;
    var r = el.getBoundingClientRect();
    return r.width < 40 || r.height < 24;
  }

  function collect() {
    var out = [];
    var de = document.documentElement;
    if (de.scrollHeight - window.innerHeight > MIN_OVERFLOW) out.push({ el: document.scrollingElement || de, axis: 'y', page: true });
    if (de.scrollWidth - window.innerWidth > MIN_OVERFLOW) out.push({ el: document.scrollingElement || de, axis: 'x', page: true });
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (skip(el)) continue;
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
  function rescan() { track(collect()); }

  var scanTimer = 0;
  function rescanSoon() { clearTimeout(scanTimer); scanTimer = setTimeout(rescan, 250); }

  window.addEventListener('resize', rescanSoon, { passive: true });
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  if (window.MutationObserver) {
    new MutationObserver(rescanSoon).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'],
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rescan);
  else rescan();
  setTimeout(rescan, 600);
  setTimeout(rescan, 2000);
})();
