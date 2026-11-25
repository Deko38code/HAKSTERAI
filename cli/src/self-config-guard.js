'use strict';
/* ════════════════════════════════════════════════════════════════════════
 * Self-config guard — hakster may FIX and PATCH, never break his own config.
 *
 * Owner (2026-11-25): "add a guard where hakster can break himself only fix
 * patch but never do what he just did break his own config". The break being
 * guarded against is the one that shipped as CLI 0.3.36: a speed change made
 * the ollama direct lane the default, tool rounds stopped answering, and the
 * agent kept re-calling the same tool until the loop guard stopped the run.
 *
 * What is locked (CLAUDE.md §22 / §35 — the name HAKSTERAI-FLASH is a label
 * over exactly this wire config, and nothing about it may move by accident):
 *
 *   wire model   deepseek-v4.1-flash:cloud      cli/src/models/ladder.js
 *   provider     ollama  @ 127.0.0.1:11434      cli/src/models/ladder.js
 *   ladder       claude-cli → ollama → codex    cli/src/models/ladder.js
 *   prefs        model / provider               cli/src/prefs.js
 *   runtime cfg  server, apiKey, model          ~/.hakster/config.json
 *   env model    DEFAULT_MODEL / HAKSTER_MODEL  .env (this repo and cli/)
 *
 * The guard is a REFUSAL, never a rewrite: it returns a message and does not
 * touch anything (§22.5 — drift is reported, never auto-corrected; §11 — no
 * self-healing writes).
 *
 * An explicit owner decision is the only way through: re-run with
 * HAKSTER_ALLOW_SELF_CONFIG=1 (§22.4 — a config change is its own decision,
 * made deliberately, never as a side effect of another task).
 *
 * Used by both tool surfaces:
 *   cli/tools.js                   — the CLI's local XML tool loop
 *   server/src/providers.js        — executeAgentTool, the server's tool loop
 * ════════════════════════════════════════════════════════════════════════ */

const path = require('path');

const HOME = process.env.HOME || '/home/ghost';
const REPO = path.resolve(__dirname, '..', '..'); // <repo>/cli/src -> <repo>

/* Files whose CONTENT is the locked config. Matched two ways so the guard
 * holds in the live tree and in an installed copy:
 *   - exact resolved path under this repo
 *   - a path suffix, for any install root
 */
const PROTECTED_FILES = [
  { path: path.join(REPO, 'cli', 'src', 'models', 'ladder.js'), suffix: '/cli/src/models/ladder.js', aliases: ['models/ladder.js', 'ladder.js'], what: 'the model ladder (wire model, provider, lane order)' },
  { path: path.join(REPO, 'cli', 'src', 'prefs.js'), suffix: '/cli/src/prefs.js', aliases: ['src/prefs.js', 'prefs.js'], what: 'the CLI preferences store' },
  { path: path.join(HOME, '.hakster', 'config.json'), suffix: '/.hakster/config.json', aliases: ['.hakster/config.json'], what: 'the CLI runtime config (server, api key, model)' },
  { path: path.join(REPO, '.env'), suffix: '/haksterAi/.env', aliases: ['.env'], what: 'the server environment (model, provider, relay)' },
  { path: path.join(REPO, 'cli', '.env'), suffix: '/haksterAi/cli/.env', aliases: ['.env'], what: 'the CLI environment' },
];

/* Model/route variables. Writing one of these INTO A FILE (env file, shell
 * profile, pm2 env file) is a config change. Passing one in front of a single
 * command ("DEFAULT_MODEL=x npm start") is a one-off run, not a config write,
 * so that is left alone.
 */
const MODEL_ENV_NAMES = [
  'DEFAULT_MODEL', 'DEFAULT_PROVIDER',
  'HAKSTER_MODEL', 'HAKSTER_PROVIDER', 'HAKSTER_MODEL_FALLBACK',
  'OLLAMA_HOST', 'OLLAMA_BASE_URL',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
];
const ENV_FILE_TARGETS = /(\.env(?:\.[\w.-]+)?|\.bashrc|\.bash_profile|\.profile|\.zshrc|ecosystem\.config\.(?:js|cjs|json)|\.pm2[\/\w.-]*)/i;

const FILE_WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'replace_in_file', 'apply_patch', 'patch_file',
  'multi_patch', 'multi_edit', 'hak_write', 'hak_edit',
]);
const SHELL_TOOLS = new Set(['exec_shell', 'shell_bg', 'run_command', 'hak_run']);

const WRITE_VERB = /(^|[\s;&|(])(sed\s+-i|perl\s+-[a-z]*i|tee|cp|mv|install|rm|truncate|dd|chmod|chown|ln|rsync|patch)\b|>>?|\bpython3?\s+-c\b|\bnode\s+-e\b|\bcat\s*>|\bed\s+/;

/** Absolute, normalised path for a tool's `path`/`file` argument. */
function resolveTarget(file, cwd) {
  const raw = String(file || '').trim();
  if (!raw) return '';
  const expanded = raw.startsWith('~') ? raw.replace(/^~/, HOME) : raw;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd || process.cwd(), expanded);
}

/** Which protected file (if any) a path names. */
function protectedTarget(file, cwd) {
  const abs = resolveTarget(file, cwd);
  if (!abs) return null;
  const norm = abs.replace(/\\/g, '/');
  for (const entry of PROTECTED_FILES) {
    if (abs === entry.path) return entry;
    // Suffix match, but only on a real path boundary (never "evil-ladder.js").
    if (norm.endsWith(entry.suffix) && (norm.length === entry.suffix.length || norm[norm.length - entry.suffix.length - 1] === '/')) {
      return entry;
    }
  }
  return null;
}

/** Does a shell command rewrite the model config into a file? */
function rewritesModelEnv(command) {
  const cmd = String(command || '');
  if (!cmd) return false;
  const names = MODEL_ENV_NAMES.filter((n) => new RegExp(`\\b${n}\\b`).test(cmd));
  if (!names.length) return false;
  // Only a write into a config file counts — not a one-off `VAR=x cmd`.
  return ENV_FILE_TARGETS.test(cmd) && />>?\s*\S|sed\s+-i|tee\b|echo\s+.+\s*>>?/.test(cmd);
}

function refusal(what, detail) {
  return [
    `⛔ BLOCKED by the self-config guard: ${detail}.`,
    `${what} is hakster's own locked model config (CLAUDE.md §22/§35): wire model deepseek-v4.1-flash:cloud,`,
    'provider ollama on 127.0.0.1:11434, ladder claude-cli → ollama → codex-cli → waterfall.',
    'Hakster may fix and patch code — but not rewrite the config he runs on. This is the exact surface that',
    'broke tool calling on 2026-11-25 (§22.4: a config change is a separate, explicit owner decision).',
    'If the owner has approved it, re-run that one action with HAKSTER_ALLOW_SELF_CONFIG=1.',
  ].join('\n');
}

/**
 * Check one tool call before it runs.
 *
 * @param {string} name  tool name
 * @param {object} args  tool arguments
 * @param {string} cwd   working directory the tool resolves relative paths against
 * @returns {string|null} a refusal message to return instead of executing, or null to allow
 */
function guardSelfConfig(name, args, cwd) {
  if (process.env.HAKSTER_ALLOW_SELF_CONFIG === '1') return null;
  const a = args || {};

  // 1) File tools aimed at a protected file.
  if (FILE_WRITE_TOOLS.has(name)) {
    const hit = protectedTarget(a.file || a.path || a.target, cwd);
    if (hit) return refusal(hit.what, `a ${name} would overwrite ${hit.what}`);
    return null;
  }

  // 2) Shell commands that write a protected file or a model var into env.
  if (SHELL_TOOLS.has(name)) {
    const cmd = String(a.command || a.cmd || '');
    if (!cmd) return null;
    for (const entry of PROTECTED_FILES) {
      const namesIt = [entry.path, entry.suffix, ...(entry.aliases || [])].some((needle) => needle && cmd.includes(needle));
      if (namesIt && WRITE_VERB.test(cmd)) {
        return refusal(entry.what, `a shell command would write ${entry.what}`);
      }
    }
    if (rewritesModelEnv(cmd)) {
      return refusal('The model/provider environment', 'a shell command would write the model config into an env file');
    }
    return null;
  }

  return null;
}

module.exports = { guardSelfConfig, protectedTarget, rewritesModelEnv, PROTECTED_FILES, MODEL_ENV_NAMES };
