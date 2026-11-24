/* Probe: does the top header row say an update installs on restart?
 *
 *   bun ui/__smoke__/updatebadge-probe.mjs            # a staged update
 *   bun ui/__smoke__/updatebadge-probe.mjs --none     # control: no update
 *   bun ui/__smoke__/updatebadge-probe.mjs --width 60 # one width only
 *
 * The updater keeps its state under ~/.hakster/updates, keyed off os.homedir(),
 * so the whole check is faked by pointing HOME at a throwaway directory BEFORE
 * the bundle is imported — the owner's real update state is never read or
 * written here. `updateCheck: false` in the throwaway prefs stops the background
 * network check from overwriting the staged state we planted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const noUpdate = args.includes('--none');
const oldRecord = args.includes('--old');
const blockedRecord = args.includes('--blocked');
const onlyWidth = args.includes('--width') ? Number(args[args.indexOf('--width') + 1]) : 0;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-badge-'));
const hakster = path.join(home, '.hakster');
fs.mkdirSync(path.join(hakster, 'updates', 'staged', 'cli'), { recursive: true });
fs.writeFileSync(path.join(hakster, 'cli-prefs.json'), JSON.stringify({ updateCheck: false, intro: false }));

if (!noUpdate) {
  const stagedBundle = path.join(hakster, 'updates', 'staged', 'cli', 'ui-fb.mjs');
  fs.writeFileSync(stagedBundle, '// staged test bundle\n');
  fs.writeFileSync(path.join(hakster, 'updates', 'staged', 'cli', 'package.json'), JSON.stringify({ version: '0.3.99' }));
  const bundleSha = crypto.createHash('sha256').update(fs.readFileSync(stagedBundle)).digest('hex');
  // --old plants the record the way an upgrade leaves it: a verified stage from
  // a version now BEHIND the running CLI. It must never read as an update.
  const version = oldRecord ? '0.3.1' : '0.3.99';
  fs.writeFileSync(
    path.join(hakster, 'updates', 'pending.json'),
    JSON.stringify({
      version,
      bundleSha,
      stagedAt: new Date().toISOString(),
      state: blockedRecord ? 'blocked' : 'staged',
      blocked: blockedRecord ? 'source-checkout' : null,
    }),
  );
}

process.env.HOME = home;
// Bun's os.homedir() ignores $HOME (it reads the passwd entry), so the fake home
// has to be installed on the module itself — before the updater/prefs modules
// load and cache their paths from it.
const osMod = (await import('node:os')).default;
osMod.homedir = () => home;
process.env.HAKSTER_NO_INTRO = '1';
process.env.HAKSTER_NO_HISTORY = '1';

const React = (await import('react')).default;
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('../src/App.jsx');

const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/tui/status')) return json({ phase: 'ACT', connected: true, model: 'HAKSTERAI-FLASH', trust: 3, tokens: 41000 });
  if (u.includes('/api/agent/mcp-status')) return json({ servers: [] });
  if (u.includes('ads')) return json({ creatives: [] });
  return json({});
};

// opentui's own error boundary renders through react/jsx-dev-runtime, which is
// undefined under this runtime, so it hides the real failure. A nearer boundary
// catches first and prints the actual error to stderr.
class Catcher extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { console.error('APP ERROR:', err && (err.stack || err.message || err)); }
  render() {
    if (this.state.err) {
      const msg = String((this.state.err && (this.state.err.stack || this.state.err.message)) || this.state.err);
      return React.createElement('text', { fg: 'red' }, msg.split('\n').slice(0, 6).join(' | '));
    }
    return this.props.children;
  }
}

const widths = onlyWidth ? [onlyWidth] : [120, 96, 80, 60, 44];
for (const width of widths) {
  const setup = await createTestRenderer({ width, height: 26 });
  const root = createRoot(setup.renderer);
  flushSync(() => root.render(
    React.createElement(Catcher, null, React.createElement(App, { version: 'probe' })),
  ));
  await setup.flush();
  await new Promise((r) => setTimeout(r, 500));
  await setup.flush();
  const frame = setup.captureCharFrame();
  const lines = frame.split('\n').slice(0, 4);
  console.log(`\n===== width ${width} ${noUpdate ? '(no update)' : oldRecord ? '(stale v0.3.1 record)' : blockedRecord ? '(blocked: source checkout)' : '(staged v0.3.99)'} =====`);
  lines.forEach((l) => console.log(`|${l}|`));
  const badge = /update .*restart|⬆/.test(frame);
  console.log(`badge present: ${badge}`);
  root.unmount();
}
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
