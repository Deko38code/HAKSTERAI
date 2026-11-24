/* resume-label-probe.mjs — runs the real public/js/hakster-resume.js in a
 * stubbed browser and checks the reconnect banner names the cause it was told.
 *
 * The bug this pins: a planned server apply (process exits 0, PM2 respawns) and
 * a real crash produced the identical "Server is restarting — reconnecting…"
 * line, so a normal update was reported as a crash. The page now calls
 * window.haksterNoteRestart('apply'); the banner must follow that cause — and
 * must NOT invent one when it was never told.
 *
 *   node scripts/__smoke__/resume-label-probe.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../public/js/hakster-resume.js', import.meta.url));
const code = fs.readFileSync(SRC, 'utf8');

const flush = () => new Promise((r) => setImmediate(r));

function makeHarness() {
  const byId = new Map();
  const el = (tag) => {
    const e = {
      tag, style: {}, children: [], attributes: {}, textContent: '', innerHTML: '',
      setAttribute(k, v) { this.attributes[k] = v; },
      append(...kids) { this.children.push(...kids); },
      removeChild(c) { this.children = this.children.filter((k) => k !== c); },
      parentNode: null,
    };
    return e;
  };
  const body = el('body');
  const timers = [];
  let seq = 0;
  const ctx = {
    console,
    __ok: true,
    setTimeout(fn, ms = 0) { const id = ++seq; timers.push({ id, fn, at: Date.now() + ms }); return id; },
    clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    fetch() { return Promise.resolve({ ok: ctx.__ok }); },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    document: {
      visibilityState: 'visible',
      body,
      getElementById: (id) => byId.get(id) || null,
      createElement: (t) => el(t),
      addEventListener() {},
      dispatchEvent() {},
    },
  };
  byId.set('__body', body);
  ctx.document.body.appendChild = (node) => { node.parentNode = body; if (node.id) byId.set(node.id, node); };
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'hakster-resume.js' });

  const fireNextTimer = async () => {
    const t = timers.shift();
    if (!t) throw new Error('no timer queued');
    t.fn();
    await flush();
  };
  const bannerText = () => {
    const b = byId.get('hakster-reconnect-banner');
    if (!b || !b.children || !b.children.length) return '';
    const span = b.children[b.children.length - 1];
    return String(span.textContent || '');
  };
  const bannerTone = () => {
    const b = byId.get('hakster-reconnect-banner');
    return b ? b.style.background : '';
  };
  return { ctx, fireNextTimer, bannerText, bannerTone, setOk: (v) => { ctx.__ok = v; } };
}

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
};

// 1. Server down, no cause reported → the generic line, no invented reason.
{
  const h = makeHarness();
  h.setOk(false);
  await h.fireNextTimer();               // the boot probe
  check('down with no cause says "restarting"',
    h.bannerText() === 'Server is restarting — reconnecting…', h.bannerText());
}

// 2. The page reports an apply → the banner names the apply.
{
  const h = makeHarness();
  h.setOk(false);
  h.ctx.haksterNoteRestart('apply');
  await h.fireNextTimer();
  check('down during an apply says it is applying an update',
    h.bannerText() === 'Server is restarting to apply an update — reconnecting…', h.bannerText());
}

// 3. Back up after an apply → reports the update landed, in the ok tone.
{
  const h = makeHarness();
  h.setOk(false);
  h.ctx.haksterNoteRestart('apply');
  await h.fireNextTimer();               // sees it down
  h.setOk(true);
  await h.fireNextTimer();               // sees it back
  check('return after an apply reports the new build',
    /^Update applied — back on the new build after \d+s\.$/.test(h.bannerText()), h.bannerText());
  check('return is painted in the ok tone',
    /#0f2a1d/.test(h.bannerTone()), h.bannerTone());
}

// 4. Back up with no cause → plain recovery, never claims an update.
{
  const h = makeHarness();
  h.setOk(false);
  await h.fireNextTimer();
  h.setOk(true);
  await h.fireNextTimer();
  check('return with no cause stays generic',
    /^Back online after \d+s\.$/.test(h.bannerText()), h.bannerText());
}

// 5. A stale cause expires instead of mislabelling a later outage.
{
  const h = makeHarness();
  h.setOk(false);
  h.ctx.haksterNoteRestart('apply');
  h.ctx.haksterNoteRestart('');          // the page says: no known cause
  await h.fireNextTimer();
  check('cleared cause falls back to the generic line',
    h.bannerText() === 'Server is restarting — reconnecting…', h.bannerText());
}

const failed = results.filter((r) => !r.ok).length;
console.log('\n' + (results.length - failed) + '/' + results.length + ' pass');
process.exit(failed ? 1 : 0);
