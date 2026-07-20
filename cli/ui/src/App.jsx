import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import agent from './agent.jsx';
import StatusBar from './components/StatusBar.jsx';
import SlashMenu from './components/SlashMenu.jsx';
import HelpOverlay from './components/HelpOverlay.jsx';
import ApprovalPrompt from './components/ApprovalPrompt.jsx';
import DiffPreview from './components/DiffPreview.jsx';
import PlanDisplay from './components/PlanDisplay.jsx';
import SessionList from './components/SessionList.jsx';
import Spinner from './components/Spinner.jsx';
import SplashScreen from './components/SplashScreen.jsx';
import TokenBar from './components/TokenBar.jsx';
import { getTheme, THEMES } from './components/ThemeManager.js';

const MAX_OUTPUT = 500;
const MAX_TOOLS = 50;

const REASONING_TYPES = [
  { pattern: /^(?:checking|scanning|looking|reading|inspecting)/i, type: 'inspect', color: 'blue' },
  { pattern: /^(?:found|detected|identified|located)/i, type: 'find', color: 'green' },
  { pattern: /^(?:error|fail|issue|problem|bug|crash|exception)/i, type: 'error', color: 'red' },
  { pattern: /^(?:plan|step|approach|strategy|decide|will|should)/i, type: 'plan', color: 'yellow' },
  { pattern: /^(?:conclusion|therefore|so |thus|result)/i, type: 'conclusion', color: 'yellow' },
  { pattern: /^(?:root cause|the issue is|the problem is)/i, type: 'diagnosis', color: 'orange' },
];

function classifyReasoning(text) {
  for (const r of REASONING_TYPES) {
    if (r.pattern.test(text)) return r;
  }
  return null;
}

export default function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;
  const rows = stdout?.rows || 24;
  const outputHeight = Math.max(5, rows - 10);

  // ─── State ───
  const [showSplash, setShowSplash] = useState(true);
  const [themeName, setThemeName] = useState('default');
  const theme = useMemo(() => THEMES[themeName] || THEMES.default, [themeName]);

  const [output, setOutput] = useState([]);
  const [tools, setTools] = useState([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [status, setStatus] = useState({ task: 'idle', model: agent.model || 'unknown', phase: 'IDLE', tokens: 0, trust: 0, provider: 'ollama' });
  const [phase, setPhase] = useState('IDLE');
  const [queue, setQueue] = useState([]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [blink, setBlink] = useState(false);  // toggles ~2Hz while the agent is working

  // ─── Overlay/UI State ───
  const [showHelp, setShowHelp] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [diffData, setDiffData] = useState(null);
  const [plan, setPlan] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [approval, setApproval] = useState(null); // { action, command, risk, onApprove, onDeny }
  const [contextMax, setContextMax] = useState(128000);
  const [contextChars, setContextChars] = useState(0);

  const inputRef = useRef('');
  const batchRef = useRef({ timer: null, text: '' });

  const maxScroll = Math.max(0, output.length - outputHeight);
  const effectiveOffset = Math.min(maxScroll, scrollOffset);
  // Highlighted-scroll indicators: how many lines are hidden above/below the view.
  const olderAbove = maxScroll - effectiveOffset;   // older lines hidden above
  const newerBelow = effectiveOffset;               // newer lines hidden below (scrolled up)
  const scrollIndicators = (olderAbove > 0 ? 1 : 0) + (newerBelow > 0 ? 1 : 0);
  const visCount = Math.max(1, outputHeight - scrollIndicators);
  const visible = output.slice(
    Math.max(0, output.length - newerBelow - visCount),
    output.length - newerBelow
  );

  // ─── Token batching ───
  const flushTokens = useCallback(() => {
    const b = batchRef.current;
    if (!b.text) return;
    const text = b.text;
    b.text = '';
    b.timer = null;
    setOutput(prev => {
      const last = prev[prev.length - 1];
      if (last && last.type === 'assistant') {
        return [...prev.slice(0, -1), { type: 'assistant', text: last.text + text }].slice(-MAX_OUTPUT);
      }
      return [...prev, { type: 'assistant', text }].slice(-MAX_OUTPUT);
    });
  }, []);

  const appendToken = useCallback((token) => {
    batchRef.current.text += token;
    if (!batchRef.current.timer) {
      batchRef.current.timer = setTimeout(flushTokens, 30);
    }
  }, [flushTokens]);

  // ─── Agent event wiring ───
  // Blink the focus bar while the agent is working (thinking / executing).
  const _working = thinking || ['PLAN','ACT','OBSERVE','REFLECT','CONSOLIDATE','THINK'].includes(phase);
  useEffect(() => {
    if (!_working) { setBlink(false); return; }
    const id = setInterval(() => setBlink(b => !b), 480);
    return () => clearInterval(id);
  }, [_working]);

  useEffect(() => {
    if (showSplash) return; // wait for splash done

    agent.onToken(token => appendToken(token));
    agent.onThinking(text => {
      setThinking(true);
      setOutput(prev => {
        if (prev.length && prev[prev.length - 1].type === 'thinking' && prev[prev.length - 1].text === text) return prev;
        return [...prev, { type: 'thinking', text }].slice(-MAX_OUTPUT);
      });
    });
    agent.onThinkingEnd(() => setThinking(false));
    agent.onToolStart(name => {
      setTools(p => [...p, { name, status: 'running', start: Date.now(), result: '' }].slice(-MAX_TOOLS));
    });
    agent.onToolEnd((name, result) => {
      setTools(p => {
        const idx = [...p].reverse().findIndex(t => t.name === name && t.status === 'running');
        if (idx === -1) return [...p, { name, status: 'done', result: String(result || '').slice(0, 80), start: Date.now() }].slice(-MAX_TOOLS);
        const real = p.length - 1 - idx;
        const next = [...p];
        const ms = Date.now() - next[real].start;
        const dur = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
        next[real] = { name, status: 'done', result: String(result || '').slice(0, 80), duration: dur };
        return next;
      });
    });
    agent.onStatus(s => {
      setStatus(p => ({ ...p, ...s }));
      if (s.phase) setPhase(s.phase);
    });
    agent.onPhase(p => setPhase(p));
    agent.onQueueUpdate(q => setQueue(q || []));
    agent.onPlan(p => setPlan(p));
    agent.onDiff(d => { setDiffData(d); setShowDiff(!!d); });
    agent.onApproval(req => {
      const toolCallId = req.tool_call_id || req.id || '';
      const command = req.command || req.args?.command || '';
      const isSudo = /^\s*sudo\b/i.test(String(command));
      setApproval({
        ...req,
        tool_call_id: toolCallId,
        command,
        action: req.tool_name || req.action || 'dangerous_command',
        risk: isSudo ? 'critical' : (req.risk || 'high'),
        reason: req.reason || 'Approval needed',
        isSudo,
        onApprove: () => {
          agent.respondApproval(toolCallId, true);
          setOutput(p => [...p, { type: 'system', text: `✅ Approved${isSudo ? ' sudo' : ''}: ${command}` }].slice(-MAX_OUTPUT));
        },
        onAllowlist: () => {
          agent.respondApproval(toolCallId, true, true);
          setOutput(p => [...p, { type: 'system', text: `✅ Approved & allowlisted${isSudo ? ' sudo' : ''}: ${command}` }].slice(-MAX_OUTPUT));
        },
        onDeny: () => {
          agent.respondApproval(toolCallId, false);
          setOutput(p => [...p, { type: 'system', text: `🚫 Denied${isSudo ? ' sudo' : ''}: ${command}` }].slice(-MAX_OUTPUT));
        },
      });
    });
    agent.onSessions(list => setSessions(list || []));
    agent.onError(err => {
      setOutput(p => [...p, { type: 'error', text: typeof err === 'string' ? err : (err?.message || 'Unknown error') }].slice(-MAX_OUTPUT));
      setThinking(false);
    });
    agent.onDone(() => {
      setThinking(false);
      setStatus(p => ({ ...p, phase: 'done' }));
    });
    if (agent.contextMax) setContextMax(agent.contextMax);
    // Poll context size lazily: getContextInfo() is cached by message-window signature,
    // and we only setState when the value actually changes so React bails out of the
    // re-render while idle — no pointless token-bar repaints burning CPU every tick.
    const ctxInterval = setInterval(() => {
      try {
        const info = agent.getContextInfo?.();
        if (!info) return;
        setContextChars(prev => (prev === info.chars ? prev : info.chars));
      } catch {}
    }, 2000);

    return () => {
      clearInterval(ctxInterval);
      // agent events are additive; no cleanup API
    };
  }, [showSplash, appendToken]);

  // ─── Slash command handler ───
  const handleSlashCommand = useCallback((cmd) => {
    const parts = cmd.trim().split(/\s+/);
    const command = parts[0];
    const arg = parts.slice(1).join(' ');

    switch (command) {
      case '/help':
        setShowHelp(true);
        break;
      case '/status':
        setOutput(p => [...p, { type: 'system', text: `Model: ${status.model} | Provider: ${status.provider || 'ollama'} | Phase: ${phase} | Trust: ${status.trust} | Tokens: ${status.tokens} | Context chars: ${contextChars.toLocaleString()}` }].slice(-MAX_OUTPUT));
        break;
      case '/model':
        if (arg) { agent.setModel?.(arg); setStatus(p => ({ ...p, model: arg })); }
        break;
      case '/provider':
        if (arg) { agent.setProvider?.(arg); setStatus(p => ({ ...p, provider: arg })); }
        break;
      case '/trust':
        if (arg) { const lvl = parseInt(arg, 10); agent.setTrust?.(lvl); setStatus(p => ({ ...p, trust: lvl })); }
        break;
      case '/approve':
        if (approval?.onApprove) { approval.onApprove(); setApproval(null); }
        break;
      case '/deny':
        if (approval?.onDeny) { approval.onDeny(); setApproval(null); }
        break;
      case '/clear':
        setOutput([]); setTools([]); setScrollOffset(0);
        break;
      case '/compact':
        agent.compact?.(); setOutput(p => [...p, { type: 'system', text: 'Context compacted.' }].slice(-MAX_OUTPUT));
        break;
      case '/diff':
        setShowDiff(prev => !prev);
        break;
      case '/review':
        agent.review?.(); setOutput(p => [...p, { type: 'system', text: 'Running code review...' }].slice(-MAX_OUTPUT));
        break;
      case '/plan':
        setShowPlan(prev => !prev);
        break;
      case '/sessions':
        agent.listSessions?.(); setShowSessions(true);
        break;
      case '/resume':
        if (arg) { agent.resume?.(arg); setShowSessions(false); }
        break;
      case '/save':
        agent.saveSession?.(); setOutput(p => [...p, { type: 'system', text: 'Session saved.' }].slice(-MAX_OUTPUT));
        break;
      case '/memory':
        agent.showMemory?.(); setOutput(p => [...p, { type: 'system', text: 'Memory loaded.' }].slice(-MAX_OUTPUT));
        break;
      case '/skills':
        agent.listSkills?.(); setOutput(p => [...p, { type: 'system', text: 'Skills listed.' }].slice(-MAX_OUTPUT));
        break;
      case '/theme':
        if (arg && THEMES[arg]) { setThemeName(arg); }
        else { setOutput(p => [...p, { type: 'system', text: `Themes: ${Object.keys(THEMES).join(', ')}` }].slice(-MAX_OUTPUT)); }
        break;
      case '/fast':
        agent.toggleFast?.(); setOutput(p => [...p, { type: 'system', text: 'Fast mode toggled.' }].slice(-MAX_OUTPUT));
        break;
      case '/health':
        agent.health?.(); setOutput(p => [...p, { type: 'system', text: 'Health check sent.' }].slice(-MAX_OUTPUT));
        break;
      case '/undo':
        agent.undo?.(); setOutput(p => [...p, { type: 'system', text: 'Undo requested.' }].slice(-MAX_OUTPUT));
        break;
      case '/exit':
        exit();
        break;
      default:
        setOutput(p => [...p, { type: 'system', text: `Unknown command: ${command}` }].slice(-MAX_OUTPUT));
    }
  }, [approval, status, phase, exit]);

  // ─── Input handler ───
  useInput((raw, key) => {
    // Splash screen: any key dismisses
    if (showSplash) return;

    // Help overlay: Esc/q to close
    if (showHelp && (key.escape || raw === 'q')) { setShowHelp(false); return; }
    if (showSessions && (key.escape || raw === 'q')) { setShowSessions(false); return; }

    // Approval prompt: y/n/a
    if (approval) {
      if (raw === 'y' || raw === 'Y') { approval.onApprove?.(); setApproval(null); return; }
      if (raw === 'n' || raw === 'N') { approval.onDeny?.(); setApproval(null); return; }
      if (raw === 'a' || raw === 'A') { approval.onAllowlist?.(); setApproval(null); return; }
      return; // block other input during approval
    }

    // Diff preview: y/n to approve/deny
    if (showDiff && diffData) {
      if (raw === 'y' || raw === 'Y') { diffData.onApprove?.(); setShowDiff(false); setDiffData(null); return; }
      if (raw === 'n' || raw === 'N') { diffData.onDeny?.(); setShowDiff(false); setDiffData(null); return; }
      if (raw === 'v' || raw === 'V') { /* view more — could expand lines */ return; }
      return;
    }

    // Slash menu
    if (raw === '/' && !input) { setShowSlashMenu(true); return; }
    if (showSlashMenu) {
      if (key.escape) { setShowSlashMenu(false); return; }
      if (key.return) {
        handleSlashCommand(input);
        setInput('');
        setShowSlashMenu(false);
        return;
      }
      if (key.backspace || key.delete) { setInput(p => p.slice(0, -1)); return; }
      if (raw && !key.ctrl && !key.meta && raw.length === 1) { setInput(p => p + raw); return; }
      return;
    }

    // Scroll
    if (key.upArrow) { setScrollOffset(o => Math.min(maxScroll + 5, o + 1)); return; }
    if (key.downArrow) { setScrollOffset(o => Math.max(0, o - 1)); return; }
    if (key.shift && key.upArrow) { setScrollOffset(o => Math.min(maxScroll + 5, o + 10)); return; }
    if (key.shift && key.downArrow) { setScrollOffset(o => Math.max(0, o - 10)); return; }

    // Submit
    if (key.return) {
      const text = input;
      if (!text.trim()) return;
      if (text.startsWith('/')) { handleSlashCommand(text); setInput(''); return; }
      setOutput(p => [...p, { type: 'user', text }].slice(-MAX_OUTPUT));
      setInput('');
      // Send to agent
      agent.send?.(text);
      return;
    }

    // Backspace
    if (key.backspace || key.delete) { setInput(p => p.slice(0, -1)); return; }

    // Ctrl+C
    if (key.ctrl && raw === 'c') { exit(); return; }

    // Regular char
    if (raw && !key.ctrl && !key.meta && raw.length === 1) { setInput(p => p + raw); return; }
  });

  // ─── Splash screen ───
  if (showSplash) {
    return <SplashScreen version="0.1.0" onDone={() => setShowSplash(false)} />;
  }

  // ─── Render ───
  return (
    <Box flexDirection="column" height={rows} width={cols}>
      {/* Status Bar */}
      <StatusBar
        model={status.model}
        provider={status.provider || 'ollama'}
        trustLevel={status.trust}
        approvalMode="on-request"
        contextUsed={status.tokens}
        contextMax={contextMax}
        phase={phase}
        cols={cols}
        sessionId={agent.sessionId || ''}
      />

      {/* Output area */}
      <Box flexDirection="column" height={outputHeight + 1} width={cols} overflow="hidden">
        {olderAbove > 0 && (
          <Text color={theme.primary} bold reverse> ↑ {olderAbove} line(s) above (older) — Shift+↑ for more </Text>
        )}
        {visible.map((line, i) => {
          if (line.type === 'user') {
            return <Text key={i} color="green" bold>{'> ' + line.text}</Text>;
          }
          if (line.type === 'assistant') {
            return <Text key={i} color="white">{line.text}</Text>;
          }
          if (line.type === 'thinking') {
            const cls = classifyReasoning(line.text);
            const color = cls ? cls.color : theme.dim;
            return <Text key={i} color={color} dim>  {line.text}</Text>;
          }
          if (line.type === 'system') {
            return <Text key={i} color="cyan" dim>{'[sys] ' + line.text}</Text>;
          }
          return <Text key={i} color="white">{line.text}</Text>;
        })}
        {newerBelow > 0 && (
          <Text color={theme.secondary} bold reverse> ↓ {newerBelow} line(s) below (newer) — ↓ to return to bottom </Text>
        )}
        {thinking && <Spinner label="thinking..." color={theme.primary} />}
      </Box>

      {/* Tools strip */}
      {tools.length > 0 && (
        <Box width={cols} flexDirection="row" overflow="hidden">
          <Text color="gray" dim>tools: </Text>
          {tools.slice(-6).map((t, i) => (
            <Text key={i} color={t.status === 'running' ? 'yellow' : theme.success}>
              {t.status === 'running' ? '◉' : '✓'}{t.name}{t.duration ? `(${t.duration})` : ''}{' '}
            </Text>
          ))}
        </Box>
      )}

      {/* Plan panel */}
      {showPlan && plan && (
        <PlanDisplay plan={plan} cols={cols} />
      )}

      {/* Token bar */}
      <TokenBar used={status.tokens} chars={contextChars} max={contextMax} cols={cols} />

      {/* Diff preview */}
      {showDiff && diffData && (
        <DiffPreview diff={diffData.text || diffData} cols={cols} onApprove={diffData.onApprove} onDeny={diffData.onDeny} />
      )}

      {/* Approval prompt */}
      {approval && (
        <ApprovalPrompt
          action={approval.action}
          command={approval.command}
          reason={approval.reason || ''}
          risk={approval.risk || 'medium'}
          onApprove={() => { approval.onApprove?.(); setApproval(null); }}
          onAllowlist={() => { approval.onAllowlist?.(); setApproval(null); }}
          onDeny={() => { approval.onDeny?.(); setApproval(null); }}
        />
      )}

      {/* Session list */}
      {showSessions && (
        <SessionList sessions={sessions} cols={cols} onSelect={(s) => { agent.resume?.(s.id); setShowSessions(false); }} />
      )}

      {/* Help overlay */}
      {showHelp && <HelpOverlay onDismiss={() => setShowHelp(false)} />}

      {/* Slash menu */}
      {showSlashMenu && <SlashMenu input={input} cols={cols} />}

      {/* Input line — highlighted focus bar (bold primary border + reverse marker,
          matches the highlighted scroll indicators so the focus point stands out) */}
      <Box width={cols} borderStyle="bold" borderColor={_working ? (blink ? theme.secondary : theme.primary) : theme.primary} paddingX={1}>
        <Text color={phase === 'ACT' ? theme.warning : theme.primary} bold reverse>
          {_working ? (blink ? '◆' : '◇') : (phase === 'ACT' ? '◆' : '>')}{' '}
        </Text>
        <Text color="white" bold>{input}{_working ? (blink ? '▍' : ' ') : ''}</Text>
        <Text color="gray" dim>{showSlashMenu ? '' : '  (/help, Tab for commands, Ctrl+C to exit)'}</Text>
      </Box>
    </Box>
  );
}