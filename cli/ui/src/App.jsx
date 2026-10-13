import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { TextAttributes } from '@opentui/core';
import AdRailSlot from './components/DockAd.jsx';
import ApprovalPrompt from './components/ApprovalPrompt.jsx';
import Composer from './components/Composer.jsx';
import GridLayout from './components/GridLayout.jsx';
import GridPanel, { Cell, Meter, Spark } from './components/GridPanel.jsx';
import StatusBar from './components/StatusBar.jsx';
import TodoPanel from './components/TodoPanel.jsx';
import Transcript from './components/Transcript.jsx';
import useAgentStream from './hooks/useAgentStream.js';
import catalog from '../../src/models/catalog.js';
import ads from '../../src/ads/ad-client.js';

const API = process.env.HAKSTER_API_URL || 'http://localhost:3579';
const SYSTEM = process.env.HAKSTER_TUI_SYSTEM
  || 'You are haksterAi running inside a terminal dashboard. Answer briefly and use tools when they are needed.';

/* The harness TUI.
 *
 * Layout is the Freebuff shape — a header, a body, and a status bar pinned to
 * the foot — but every value comes from this harness's own server, and the ad
 * slots are served by the local ad service in server/src/ads.js.
 *
 * Two ideas hold this file together:
 *
 * 1. Focus decides what a plain letter means. While the composer holds focus
 *    every printable key belongs to the input, and the `a`/`d`/`m`/`q` shortcuts
 *    are reachable only once focus moves away (Tab). The alternative — global
 *    single-letter shortcuts that also let you type — is not implementable, and
 *    a shortcut that steals a keystroke mid-sentence is worse than no shortcut.
 *
 * 2. Row budget is computed, not guessed. The renderer fills a full-screen tree,
 *    so a panel that grows by one row does not scroll the transcript, it pushes
 *    the status bar off the bottom. Each chrome element's height is derived
 *    below and the transcript receives exactly what is left.
 */
export default function App({ version = '0.1.0' }) {
  const renderer = useRenderer();
  const { width: cols, height: rows } = useTerminalDimensions();

  const [view, setView] = useState('chat'); // chat | dashboard | models
  const [focus, setFocus] = useState('composer'); // composer | ad
  const [adsOn, setAdsOn] = useState(true);
  const [dockExpanded, setDockExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState(process.env.HAKSTER_MODEL || 'glm-5.2:cloud');
  const [modelIdx, setModelIdx] = useState(0);

  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState(null);
  const [history, setHistory] = useState([]);

  const agent = useAgentStream({
    api: API,
    model,
    provider: process.env.HAKSTER_PROVIDER || 'ollama',
    system: SYSTEM,
    cwd: process.env.HAKSTER_AGENT_CWD || null,
  });

  // ── Machine status: unchanged contract with the server's /api/tui/status ──
  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/tui/status`, { signal: AbortSignal.timeout(4000), headers: { ...(process.env.HAKSTER_API_KEY ? { 'x-api-key': process.env.HAKSTER_API_KEY } : {}) } });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const j = await r.json();
      setStatus(j);
      setStatusErr(null);
      setHistory((h) => [...h.slice(-59), Number(j.tokens || j.messages || 0)]);
    } catch (e) {
      setStatusErr(e.message);
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const models = catalog.REFERENCE_CATALOG || [];
  const ctxMax = catalog.contextMaxFor(model) || 1;
  const ctxUsed = Number((status && (status.tokens || status.contextUsed)) || 0);

  const submit = useCallback(
    (text) => {
      const v = String(text == null ? '' : text).trim();
      if (!v || agent.busy) return;
      setDraft('');
      agent.send(v);
    },
    [agent],
  );

  // A pending approval blocks the run, so it takes the keyboard. Both halves are
  // needed: the composer stops accepting input, AND the shortcut layer stands
  // down below. The renderer runs every useKeyboard handler, so without the
  // stand-down a `y` meant for the prompt would also reach the shortcut switch.
  const approving = !!agent.pendingConfirm;

  const answerApproval = useCallback(
    (approved, opts) => {
      agent.answerConfirm(approved, opts);
    },
    [agent],
  );

  const cycleFocus = useCallback(() => {
    setFocus((f) => (f === 'composer' ? 'ad' : 'composer'));
  }, []);

  useKeyboard((key) => {
    // Ctrl+C always exits, from anywhere.
    if (key.ctrl && key.name === 'c') {
      agent.abort();
      renderer.destroy();
      return;
    }

    // While an approval is pending it owns every key but Ctrl+C (handled
    // above); ApprovalPrompt reads the answer itself.
    if (approving) return;

    if (view === 'models') {
      if (key.name === 'escape' || key.name === 'm') {
        setView('dashboard');
        return;
      }
      if (models.length) {
        if (key.name === 'up') setModelIdx((i) => (i - 1 + models.length) % models.length);
        if (key.name === 'down') setModelIdx((i) => (i + 1) % models.length);
        if (key.name === 'return') {
          setModel(models[modelIdx].id);
          setView('chat');
        }
      }
      return;
    }

    if (key.name === 'tab') {
      cycleFocus();
      return;
    }

    if (key.name === 'escape') {
      if (agent.busy) agent.abort();
      else if (focus !== 'composer') setFocus('composer');
      return;
    }

    // While the composer has focus, printable keys belong to the input and the
    // shortcut layer below must stay out of the way.
    if (focus === 'composer' && !key.ctrl && !key.meta) return;

    if (key.ctrl && key.name === 'o') {
      setDockExpanded((v) => !v);
      return;
    }

    switch (key.name) {
      case 'a':
        setAdsOn((v) => !v);
        break;
      case 'd':
        setView((v) => (v === 'chat' ? 'dashboard' : 'chat'));
        break;
      case 'm':
        setModelIdx(Math.max(0, models.findIndex((x) => x.id === model)));
        setView('models');
        break;
      case 'c':
        agent.clear();
        break;
      case 'r':
        load();
        break;
      case 'q':
        agent.abort();
        renderer.destroy();
        break;
      default:
        break;
    }
  });

  const panelW = Math.max(40, Math.min((cols || 100) - 2, 140));

  // ── Row budget ────────────────────────────────────────────────────────────
  // header 1 · status bar 1 · composer 5 (border 2, input 1, inline ad 1, hint 1)
  // · rail 1 collapsed or 7 expanded · todos: border 2 + header 1 + rows + hint 1
  const CHROME_ROWS = 1 + 1;
  const composerRows = 5;
  const railRows = dockExpanded ? 7 : 1;
  const todoRows = agent.todos.length ? Math.min(agent.todos.length, 6) + 4 : 0;
  // approval: border 2 + header 1 + reason 1 + command 1 + answer row 1
  const approvalRows = approving ? 6 : 0;
  const transcriptRows = Math.max(
    4,
    (rows || 30) - CHROME_ROWS - composerRows - railRows - todoRows - approvalRows,
  );

  const dashboardItems = [
    {
      key: 'system',
      title: 'System',
      hint: status ? 'live' : 'connecting…',
      cells: [
        { label: 'phase', value: status ? status.phase : '—', color: 'cyan' },
        { label: 'connected', value: status ? (status.connected ? 'yes' : 'no') : '—', color: status && status.connected ? 'green' : 'red' },
        { label: 'server model', value: status ? status.model : '—' },
        { label: 'trust', value: status ? status.trust : '—' },
      ],
    },
    {
      key: 'session',
      title: 'Session',
      hint: '3s refresh',
      cells: [
        { label: 'tokens', value: ctxUsed },
        { label: 'model', value: model, color: 'yellow' },
        { label: 'ad requests', value: ads.adSessionSnapshot().adsServed, color: 'cyan' },
        { label: 'ads held', value: ads.adSessionSnapshot().adsHeld },
      ],
    },
    {
      key: 'agent',
      title: 'Agent',
      hint: agent.status,
      cells: [
        { label: 'state', value: agent.status, color: agent.status === 'error' ? 'red' : 'green' },
        { label: 'turns', value: agent.messages.filter((m) => m.role === 'user').length },
        { label: 'todos done', value: `${agent.todos.filter((t) => t.done).length}/${agent.todos.length}` },
        { label: 'elapsed', value: `${(agent.elapsedMs / 1000).toFixed(1)}s` },
      ],
    },
  ];

  return (
    <box style={{ flexDirection: 'column', width: cols || 100, height: rows || 30, overflow: 'hidden' }}>
      {/* header */}
      <box style={{ width: panelW, justifyContent: 'space-between', flexShrink: 0 }}>
        <text fg="cyan" attributes={TextAttributes.BOLD}>
          haksterAi
        </text>
        <text fg="gray">{`tui ${version} · ${view} · ${model} · ctx ${Math.round(ctxMax / 1000)}K`}</text>
      </box>

      {statusErr ? (
        <box style={{ width: panelW, border: true, borderStyle: 'rounded', borderColor: 'red', paddingLeft: 1, paddingRight: 1 }}>
          <text fg="red">server unreachable — {statusErr}</text>
        </box>
      ) : null}

      {view === 'models' ? (
        <GridPanel title="Models" width={panelW} hint="↑↓ select · enter apply · esc back">
          {models.map((m, i) => (
            <Cell
              key={m.id}
              label={m.vendor}
              value={`${i === modelIdx ? '▸ ' : ''}${m.id}`}
              w={Math.max(20, Math.floor((panelW - 4) / 2))}
              color={i === modelIdx ? 'yellow' : 'white'}
            />
          ))}
        </GridPanel>
      ) : view === 'dashboard' ? (
        <>
          <GridLayout
            items={dashboardItems}
            availableWidth={panelW}
            getItemKey={(item) => item.key}
            renderItem={(item, index, columnWidth) => (
              <GridPanel title={item.title} width={columnWidth} hint={item.hint}>
                {item.cells.map((c) => (
                  <Cell key={c.label} label={c.label} value={c.value} color={c.color} w={Math.max(14, Math.floor((columnWidth - 4) / 2))} />
                ))}
              </GridPanel>
            )}
          />
          <GridPanel title="Context" width={panelW} hint={catalog.labelFor(catalog.findModel(model) || { id: model, vendor: 'local', context: null })}>
            <box>
              <Meter value={ctxUsed} max={ctxMax} w={Math.min(40, panelW - 30)} color={ctxUsed / ctxMax > 0.8 ? 'red' : 'green'} />
            </box>
            <box style={{ marginLeft: 1 }}>
              <Spark data={history} w={Math.min(30, Math.max(10, panelW - 10))} />
            </box>
          </GridPanel>
        </>
      ) : (
        <>
          {agent.todos.length ? (
            <box style={{ flexShrink: 0 }}>
              <TodoPanel
                todos={agent.todos}
                width={panelW}
                hint="the agent's checklist · updates live"
                maxVisibleRows={Math.min(agent.todos.length, 6)}
              />
            </box>
          ) : null}

          <box style={{ flexGrow: 1, flexShrink: 1, overflow: 'hidden' }}>
            <Transcript
              messages={agent.messages}
              width={panelW}
              height={transcriptRows}
              emptyHint="Type a task and the agent runs it with tools. Tab moves focus to the ad slot; esc stops a run."
            />
          </box>

          <box style={{ flexShrink: 0 }}>
            <AdRailSlot
              width={panelW}
              placementId={ads.PLACEMENTS.tuiRail}
              enabled={adsOn}
              focused={focus === 'ad'}
              expanded={dockExpanded}
            />
          </box>

          {approving ? (
            <box style={{ flexShrink: 0 }}>
              <ApprovalPrompt
                width={panelW}
                request={agent.pendingConfirm}
                onAnswer={answerApproval}
              />
            </box>
          ) : null}

          <box style={{ flexShrink: 0 }}>
            <Composer
              width={panelW}
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              focused={focus === 'composer' && !approving}
              disabled={agent.busy}
              hint={
                approving
                  ? 'answer the request above — it is holding the run'
                  : agent.busy
                    ? 'esc stop · the run is streaming'
                    : 'enter send · tab focus · a ads · d dashboard · m models · c clear · q quit'
              }
              adSlot={
                <AdRailSlot
                  width={Math.max(8, panelW - 4)}
                  placementId={ads.PLACEMENTS.tuiComposer}
                  enabled={adsOn}
                  focused={false}
                  expanded={false}
                />
              }
            />
          </box>
        </>
      )}

      <box style={{ flexShrink: 0 }}>
        <StatusBar
          width={panelW}
          status={agent.status}
          model={model}
          cols={cols || 100}
          focus={focus}
          adsOn={adsOn}
          elapsedMs={agent.elapsedMs}
          hint={focus === 'ad' ? 'enter opens · ^O details' : null}
        />
      </box>
    </box>
  );
}