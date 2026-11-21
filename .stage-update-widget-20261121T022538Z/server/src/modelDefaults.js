'use strict';
/**
 * Startup model resolution for the owner's `hakster` command.
 *
 * 2026-11-16 (owner): "need to fix haksterai cli tui ollama to our deepseek not
 * glm" / "with hakster command" / "to start" / "need my claude deepseek config".
 *
 * The owner's Claude Code route is the Ollama integration named "claude" in
 * `~/.ollama/config.json` — currently `deepseek-v4.1-flash:cloud` on
 * 127.0.0.1:11434. The terminal used to open on a GLM default instead
 * (`glm-5.3-flash:cloud` from server/hakster-config.json, `glm-5.2:cloud` from
 * the older TUI bundles). This module mirrors the owner's DeepSeek selection so
 * the CLI, the TUI and the agent entrypoint all start on the same model as
 * Claude Code, without editing any config file.
 *
 * Read-only: it only reads `~/.ollama/config.json` and asks `ollama list` what
 * is actually installed. It never writes config, never changes a provider, and
 * never overrides a runtime `/model` switch.
 *
 * Order:
 *   1. HAKSTER_MODEL                 — an explicit per-process choice always wins.
 *   2. Ollama "claude" integration   — the owner's Claude DeepSeek config.
 *   3. The configured model          — unless it is a GLM default or missing here.
 *   4. DEEPSEEK_MODEL                — built-in fallback.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** The same DeepSeek tag Claude Code runs on this box. */
const DEEPSEEK_MODEL = 'deepseek-v4.1-flash:cloud';

/** Context window used for the DeepSeek tag (owner's Claude Code override). */
const DEEPSEEK_CONTEXT = 1048576;

const GLM_RE = /^glm/i;

let _claudeModels = null;
let _installed = null;

function ollamaConfigPaths() {
  const out = [];
  if (process.env.OLLAMA_CONFIG) out.push(process.env.OLLAMA_CONFIG);
  const home = process.env.HOME || (() => { try { return os.homedir(); } catch (_) { return ''; } })();
  if (home) out.push(path.join(home, '.ollama', 'config.json'));
  return out;
}

/** The models the owner's Claude integration lists (usually one DeepSeek tag). */
function ownerClaudeModels() {
  if (_claudeModels) return _claudeModels;
  for (const file of ollamaConfigPaths()) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const models = cfg && cfg.integrations && cfg.integrations.claude && cfg.integrations.claude.models;
      if (Array.isArray(models) && models.length) {
        _claudeModels = models
          .filter((m) => typeof m === 'string' && m.trim())
          .map((m) => m.trim());
        return _claudeModels;
      }
    } catch (_) { /* not present or unreadable — try the next path */ }
  }
  _claudeModels = [];
  return _claudeModels;
}

/** Tags installed on this box, from `ollama list` (empty set when unknown). */
function installedModels() {
  if (_installed) return _installed;
  try {
    const out = execFileSync('ollama', ['list'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    _installed = new Set(
      out.split('\n').slice(1)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean)
    );
  } catch (_) {
    _installed = new Set();
  }
  return _installed;
}

/**
 * Pick the model the terminal should start on.
 * @param {string} configured  the model from hakster-config.json (may be empty)
 * @returns {{model: string, source: string}}
 */
function resolveStartupModel(configured) {
  // An explicit non-GLM model from the environment always wins. A GLM tag here
  // is the old default the owner is replacing ("i just want my deepseek"), so
  // it falls through instead of pinning the terminal back to GLM. No config
  // file is read or written for this — it is a code-side preference only.
  for (const [name, value] of [
    ['HAKSTER_MODEL', process.env.HAKSTER_MODEL],
    ['OLLAMA_MODEL', process.env.OLLAMA_MODEL],
    ['DEFAULT_MODEL', process.env.DEFAULT_MODEL],
  ]) {
    const m = String(value || '').trim();
    if (m && !GLM_RE.test(m)) return { model: m, source: name };
  }

  const installed = installedModels();
  const available = (m) => !!m && (installed.size === 0 || installed.has(m));

  for (const m of ownerClaudeModels()) {
    if (available(m)) return { model: m, source: "Ollama 'claude' integration (owner DeepSeek config)" };
  }

  const cfg = String(configured || '').trim();
  if (cfg && !GLM_RE.test(cfg) && available(cfg)) return { model: cfg, source: 'hakster-config.json' };

  if (available(DEEPSEEK_MODEL)) return { model: DEEPSEEK_MODEL, source: 'DeepSeek default' };

  return { model: cfg || DEEPSEEK_MODEL, source: cfg ? 'hakster-config.json (last resort)' : 'DeepSeek default (not installed)' };
}

module.exports = {
  DEEPSEEK_MODEL,
  DEEPSEEK_CONTEXT,
  ownerClaudeModels,
  installedModels,
  resolveStartupModel,
};
