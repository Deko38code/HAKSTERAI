import React, { useState, useMemo, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

// Model catalog mirroring crush's "Switch Model" dialog (internal/ui/dialog/models.go —
// grouped provider list, scrollbar, Tab to toggle Large/Small task) — using hakster's
// providers (cli/providers.js PROVIDER_ORDER). Providers: glm (default/cloud),
// anthropic/claude (key), openai incl. Codex models (key), openrouter incl. Nous/Hermes
// cloud (key), gemini (key), ollama (local, no key, incl. local Hermes3).
const PROVIDERS = [
  {
    id: 'glm', name: 'GLM / Charm Cloud', needsKey: false,
    models: [
      { id: 'glm-5.2:cloud', name: 'GLM 5.2 Cloud' },
      { id: 'thudm/glm-5.1:cloud', name: 'GLM 5.1 Cloud' },
      { id: 'thudm/glm-5.1:cloud-ctx', name: 'GLM 5.1 Cloud (ctx)' },
    ],
  },
  {
    id: 'anthropic', name: 'Anthropic / Claude', needsKey: true,
    models: [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
      { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
      { id: 'claude-haiku-3-5', name: 'Claude Haiku 3.5' },
    ],
  },
  {
    id: 'openai', name: 'OpenAI / Codex', needsKey: true,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'openai/gpt-5.5', name: 'GPT-5.5' },
      { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
      { id: 'codex-mini-latest', name: 'Codex Mini' },
      { id: 'gpt-oss:120b-cloud', name: 'GPT-OSS 120B Cloud' },
      { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B' },
    ],
  },
  {
    id: 'openrouter', name: 'OpenRouter / Nous', needsKey: true,
    models: [
      { id: 'nousresearch/hermes-3-llama-3.1-405b:free', name: 'Nous Hermes 3 405B' },
      { id: 'nousresearch/hermes-3-llama-3.1-70b', name: 'Nous Hermes 3 70B' },
      { id: 'openrouter/free', name: 'OpenRouter Auto (free)' },
    ],
  },
  {
    id: 'gemini', name: 'Gemini', needsKey: true,
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite' },
    ],
  },
  {
    id: 'ollama', name: 'Ollama (local)', needsKey: false,
    models: [
      { id: 'llama3.2:latest', name: 'Llama 3.2 (local)' },
      { id: 'hermes3', name: 'Nous Hermes 3 (local)' },
      { id: 'qwen2.5:32b', name: 'Qwen 2.5 32B (local)' },
    ],
  },
];

const ALL_OPTIONS = PROVIDERS.flatMap(p =>
  p.models.map(m => ({ model: m.id, name: m.name, provider: p.id, providerName: p.name, needsKey: p.needsKey }))
);

const WIDTH = 62;
const VISIBLE_ROWS = 9; // crush uses ~defaultDialogHeight minus chrome; keep the popup short & scrollable
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Decorative dot-grid rule framing the API-key box — a faint blueprint/HUD grid
// line, spaced to roughly match the dialog's inner width.
function gridLine(width) {
  return Array.from({ length: Math.max(1, Math.floor(width / 2)) }, () => '·').join(' ');
}

// Build a flat "display rows" list — a header row before each provider's first
// visible item (crush groups the list by provider with a label above each run),
// plus the underlying selectable item list. Headers are never selectable, but
// they still occupy a row for scroll-window math, same as crush's list.TotalHeight().
function buildRows(matches) {
  const rows = [];
  let lastProvider = null;
  matches.forEach((o, matchIndex) => {
    if (o.provider !== lastProvider) {
      rows.push({ type: 'header', label: o.providerName, key: 'h:' + o.provider + ':' + matchIndex });
      lastProvider = o.provider;
    }
    rows.push({ type: 'item', option: o, matchIndex, key: o.model + ':' + o.provider });
  });
  return rows;
}

export default function ModelDialog({
  cols = 80,
  rows = 24,
  currentModel = '',
  onSelect,
  onDismiss,
  onSetProviderKey,
}) {
  const [filter, setFilter] = useState('');
  const [idx, setIdx] = useState(0);
  const [offset, setOffset] = useState(0);
  const [modelType, setModelType] = useState('large'); // 'large' | 'small'
  const [needsAPIKey, setNeedsAPIKey] = useState(false);
  const [selected, setSelected] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [spinFrame, setSpinFrame] = useState(0);

  const matches = useMemo(() => {
    const q = filter.toLowerCase();
    if (!q) return ALL_OPTIONS;
    return ALL_OPTIONS.filter(o =>
      o.name.toLowerCase().includes(q) || o.model.toLowerCase().includes(q) || o.providerName.toLowerCase().includes(q)
    );
  }, [filter]);

  const displayRows = useMemo(() => buildRows(matches), [matches]);
  const totalRows = displayRows.length;

  // Row index (into displayRows, header rows included) of the current selection —
  // this is what crush's list.Offset()/ScrollToSelected() track internally.
  const selectedRow = useMemo(
    () => displayRows.findIndex(r => r.type === 'item' && r.matchIndex === idx),
    [displayRows, idx]
  );

  // Keep the selected row inside [offset, offset+VISIBLE_ROWS) — same clamp crush's
  // list does on every Next/Previous/filter change (ScrollToSelected / ScrollToTop).
  useEffect(() => {
    if (selectedRow < 0) return;
    setOffset(o => {
      if (selectedRow < o) return selectedRow;
      if (selectedRow > o + VISIBLE_ROWS - 1) return selectedRow - VISIBLE_ROWS + 1;
      return o;
    });
  }, [selectedRow]);

  // Spinner tick while saving a key — cosmetic parity with crush's verifying spinner.
  useEffect(() => {
    if (!saving) return;
    const t = setInterval(() => setSpinFrame(f => (f + 1) % SPIN_FRAMES.length), 80);
    return () => clearInterval(t);
  }, [saving]);

  useInput((raw, key) => {
    if (needsAPIKey) {
      if (saving || saved) return; // ignore input mid-animation
      if (key.escape) { setNeedsAPIKey(false); setSelected(null); setApiKey(''); setKeyError(''); return; }
      if (key.tab) { setReveal(r => !r); return; }
      if (key.return) {
        if (!apiKey.trim()) { setKeyError('API key cannot be empty'); return; }
        setKeyError('');
        setSaving(true);
        // Brief, honest "Saving…" beat (this stores the key locally — it is not
        // network-verified) so the transition doesn't feel like an instant no-op.
        setTimeout(() => {
          const ok = onSetProviderKey ? onSetProviderKey(selected.provider, apiKey.trim()) : true;
          setSaving(false);
          if (ok === false) { setKeyError('Could not save key — try again'); return; }
          setSaved(true);
          setTimeout(() => onSelect?.(selected.model, selected.provider, modelType), 450);
        }, 380);
        return;
      }
      if (key.backspace || key.delete) { setApiKey(p => p.slice(0, -1)); setKeyError(''); return; }
      if (raw && !key.ctrl && !key.meta && raw.length === 1) { setApiKey(p => p + raw); setKeyError(''); return; }
      return;
    }

    if (key.escape) { onDismiss?.(); return; }
    if (key.return) {
      const opt = matches[idx];
      if (!opt) return;
      if (opt.needsKey && onSetProviderKey) { setSelected(opt); setNeedsAPIKey(true); setApiKey(''); setReveal(false); setKeyError(''); setSaved(false); return; }
      onSelect?.(opt.model, opt.provider, modelType);
      return;
    }
    if (key.tab) { setModelType(t => (t === 'large' ? 'small' : 'large')); return; }
    if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx(i => Math.min(matches.length - 1, i + 1)); return; }
    if (key.pageUp) { setIdx(i => Math.max(0, i - VISIBLE_ROWS)); return; }
    if (key.pageDown) { setIdx(i => Math.min(matches.length - 1, i + VISIBLE_ROWS)); return; }
    if (key.backspace || key.delete) { setFilter(p => p.slice(0, -1)); setIdx(0); return; }
    if (raw && !key.ctrl && !key.meta && raw.length === 1) { setFilter(p => p + raw); setIdx(0); return; }
  });

  const radio = modelType === 'large' ? '◉ Large Task  ○ Small Task' : '○ Large Task  ◉ Small Task';

  // ── Scrollbar — same shape as crush's common.Scrollbar: a track column with a
  // thumb sized/positioned proportionally to offset/totalRows. Only shown when
  // the list overflows the visible window.
  const showScrollbar = totalRows > VISIBLE_ROWS;
  let thumbStart = 0, thumbSize = VISIBLE_ROWS;
  if (showScrollbar) {
    thumbSize = Math.max(1, Math.round((VISIBLE_ROWS / totalRows) * VISIBLE_ROWS));
    thumbStart = Math.round((offset / Math.max(1, totalRows - VISIBLE_ROWS)) * (VISIBLE_ROWS - thumbSize));
  }
  const visible = displayRows.slice(offset, offset + VISIBLE_ROWS);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" width={WIDTH} paddingX={2} paddingY={1}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>Switch Model</Text>
        <Text color="gray" dim>{radio}</Text>
      </Box>

        {needsAPIKey ? (
          <>
            <Box marginTop={1}>
              <Text color="yellow" bold>🔑 {selected?.providerName} API key</Text>
            </Box>
            <Box marginTop={1}>
              <Text color="cyan" dim>┌{gridLine(WIDTH - 8)}┐</Text>
            </Box>
            <Box borderStyle="round" borderColor={keyError ? 'red' : (saved ? 'green' : 'yellow')} paddingX={1}>
              <Text color="gray" dim>{saving ? SPIN_FRAMES[spinFrame] : (saved ? '✓' : '❯')} </Text>
              <Text color={saved ? 'green' : 'white'}>
                {apiKey
                  ? (reveal ? apiKey : '•'.repeat(apiKey.length))
                  : <Text color="gray" dim>paste or type your key…</Text>}
              </Text>
            </Box>
            <Box>
              <Text color="cyan" dim>└{gridLine(WIDTH - 8)}┘</Text>
            </Box>
            {keyError ? (
              <Box marginTop={1}><Text color="red" bold>✗ {keyError}</Text></Box>
            ) : saving ? (
              <Box marginTop={1}><Text color="gray" dim>Saving key locally…</Text></Box>
            ) : saved ? (
              <Box marginTop={1}><Text color="green" bold>✓ Saved — switching model…</Text></Box>
            ) : (
              <Box marginTop={1}><Text color="gray" dim>Stored in your local hakster config, never sent anywhere else.</Text></Box>
            )}
            <Box marginTop={1}>
              <Text color="gray" dim>Enter save · Tab {reveal ? 'hide' : 'show'} · Esc back</Text>
            </Box>
          </>
        ) : (
          <>
            <Box marginTop={1}>
              <Text color="gray" dim>{'>'.padEnd(2)} </Text>
              <Text color="green">{filter || '<filter models>'}</Text>
            </Box>
            <Box marginTop={1}>
              {matches.length === 0 ? (
                <Box flexDirection="column"><Text color="gray" dim>No models match "{filter}"</Text></Box>
              ) : (
                <Box flexDirection="row">
                  <Box flexDirection="column" width={WIDTH - (showScrollbar ? 8 : 5)}>
                    {visible.map(r =>
                      r.type === 'header' ? (
                        <Text key={r.key} color="magenta" dim bold>{r.label}</Text>
                      ) : (
                        <Box key={r.key}>
                          <Text color={r.matchIndex === idx ? 'green' : 'gray'} bold={r.matchIndex === idx}>
                            {r.matchIndex === idx ? '❯ ' : '  '}{r.option.name.padEnd(26).slice(0, 26)}
                          </Text>
                          {r.option.model === currentModel ? <Text color="cyan" bold> ✓</Text> : null}
                          {r.option.needsKey ? <Text color="yellow" dim> 🔑</Text> : null}
                        </Box>
                      )
                    )}
                  </Box>
                  {showScrollbar && (
                    <Box flexDirection="column" marginLeft={1}>
                      {Array.from({ length: VISIBLE_ROWS }).map((_, i) => (
                        <Text key={i} color={i >= thumbStart && i < thumbStart + thumbSize ? 'cyan' : 'gray'} dim={!(i >= thumbStart && i < thumbStart + thumbSize)}>
                          {i >= thumbStart && i < thumbStart + thumbSize ? '█' : '│'}
                        </Text>
                      ))}
                    </Box>
                  )}
                </Box>
              )}
            </Box>
            <Box marginTop={1}>
              <Text color="gray" dim>↑↓ navigate · PgUp/PgDn jump · Enter select · Tab toggle task · Esc close</Text>
            </Box>
          </>
        )}
    </Box>
  );
}
