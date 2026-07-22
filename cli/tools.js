'use strict';

// ──────────────────────────────────────────────────────────────────────────
// haksterAi CLI — Local XML Tool Execution System
// Ported from phantom-cli.js (lines 409–1928, 2623–3153, 3422–3577)
// Rebranded: phantom_read → hak_read, phantom_run → hak_run, etc.
// Backward compat: old phantom_ prefixes still accepted as aliases.
//
// Exports:
//   parseTools(text)                    → array of {name, args, raw}
//   stripTools(text)                    → cleaned text
//   stripFences(text)                   → cleaned text
//   stripHtmlArtifacts(text)            → cleaned text
//   isReasoningText(text)               → boolean
//   cliExecuteTool(name, args, trustCfg) → {ok, output, error}
//   execTools(tools, trustCfg, rl)       → {results, actions}
//   TOOL_DEFINITIONS                     → array of {name, description, usage}
// ──────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const { exec, execSync, spawn } = require('child_process');
const readline = require('readline');

// ── Constants ──────────────────────────────────────────────────────────────
const HOME     = process.env.HOME || '/home/ghost';
const CLI_ROOT = path.dirname(fs.realpathSync(__filename));

// ── ANSI colors (mirrors phantom-cli.js C object) ──────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  purple: '\x1b[35m', lpurp: '\x1b[95m', green: '\x1b[32m',
  lgreen: '\x1b[92m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', white: '\x1b[97m', gray: '\x1b[90m',
  blue: '\x1b[34m', lblue: '\x1b[94m',
  lpurp: '\x1b[95m',
  lgreen2: '\x1b[92m',
};

// Convenience output helpers
const p    = (color, ...a) => process.stdout.write(color + a.join(' ') + C.reset);
const pl   = (color, ...a) => console.log(color + a.join(' ') + C.reset);
const dim  = (...a) => pl(C.gray, ...a);
const err  = (...a) => pl(C.red, '✗', ...a);
const ok   = (...a) => pl(C.lgreen, '✓', ...a);
const warn = (...a) => pl(C.yellow, '⚠', ...a);

// ══════════════════════════════════════════════════════════════════════════
// ── Persistent Shell — cd, export, alias persist across commands ──
// ══════════════════════════════════════════════════════════════════════════
class PersistentShell {
  constructor() {
    this._cwd = HOME;
    this._env = {};
    this._aliases = {};
    this._prevCwd = null;
  }

  async run(cmd, opts = {}) {
    const timeout = opts.timeout || 30000;
    const trimmed = cmd.trim();
    const cdMatch = trimmed.match(/^cd\s+(.+)$/);
    const exportMatch = trimmed.match(/^export\s+([\w]+)=(.*)$/);
    const aliasMatch = trimmed.match(/^alias\s+([\w]+)=(.+)$/);

    if (cdMatch) {
      const target = cdMatch[1].replace(/^['"]|['"]$/g, '').replace(/^~\//, HOME + '/');
      let newCwd;
      if (target === '-') {
        newCwd = this._prevCwd || HOME;
      } else {
        newCwd = path.isAbsolute(target) ? target : path.resolve(this._cwd, target);
      }
      try {
        const stat = fs.statSync(newCwd);
        if (stat.isDirectory()) {
          this._prevCwd = this._cwd;
          this._cwd = newCwd;
          return { stdout: '', stderr: '', code: 0 };
        }
      } catch {}
    }

    if (exportMatch) {
      const [, key, val] = exportMatch;
      this._env[key] = val.replace(/^['"]|['"]$/g, '');
    }

    if (aliasMatch) {
      const [, name, expansion] = aliasMatch;
      this._aliases[name] = expansion.replace(/^['"]|['"]$/g, '');
    }

    const aliasDefs = Object.entries(this._aliases).map(([k,v]) => `alias ${k}=${JSON.stringify(v)}`).join(';');
    const envExports = Object.entries(this._env).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    const prefixParts = [`cd ${JSON.stringify(this._cwd)}`];
    if (envExports) prefixParts.push(`export ${envExports}`);
    if (aliasDefs) prefixParts.push(aliasDefs);
    const fullCmd = prefixParts.join('; ') + '; ' + cmd;

    return new Promise(resolve => {
      const mergedEnv = { ...process.env, ...this._env };
      exec(fullCmd, {
        cwd: this._cwd,
        timeout,
        maxBuffer: 5 * 1024 * 1024,
        env: mergedEnv,
        shell: '/bin/bash',
      }, (e, out, er) => {
        const output = (out || '').trim();
        const error = (er || e?.message || '').trim();
        const code = e?.code ?? 0;
        resolve({ stdout: output, stderr: error, code });
      });
    });
  }

  cwd() { return this._cwd; }

  setCwd(newCwd) {
    try {
      const resolved = path.resolve(this._cwd, newCwd);
      fs.statSync(resolved);
      this._prevCwd = this._cwd;
      this._cwd = resolved;
      return true;
    } catch { return false; }
  }

  setEnv(key, value) { this._env[key] = value; }
  env() { return { ...this._env }; }
  aliases() { return { ...this._aliases }; }

  close() {
    this._cwd = HOME;
    this._env = {};
    this._aliases = {};
  }
}

const pshell = new PersistentShell();

// ── runCmd — execute via persistent shell ──────────────────────────────────
function runCmd(cmd, cwd) {
  return pshell.run(cmd, { timeout: 30000 });
}

// ── runCmdStream — streaming output, live like Claude Code ─────────────────
function runCmdStream(cmd, cwd) {
  return new Promise(resolve => {
    const aliasDefs = Object.entries(pshell.aliases()).map(([k,v]) => `alias ${k}=${JSON.stringify(v)}`).join(';');
    const envExports = Object.entries(pshell.env()).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    const prefixParts = [`cd ${JSON.stringify(pshell.cwd())}`];
    if (envExports) prefixParts.push(`export ${envExports}`);
    if (aliasDefs) prefixParts.push(aliasDefs);
    const fullCmd = prefixParts.join('; ') + '; ' + cmd;
    const mergedEnv = { ...process.env, ...pshell.env() };

    const child = spawn('bash', ['-c', fullCmd], {
      cwd: pshell.cwd(),
      stdio: ['inherit', 'pipe', 'pipe'],
      env: mergedEnv,
      detached: true, // own process group -> timeout kills the whole tree, not just bash
    });
    let stdout = '', stderr = '';
    const killGroup = (signal) => { try { process.kill(-child.pid, signal); } catch (_) { try { child.kill(signal); } catch {} } };
    child.stdout.on('data', d => { const s = d.toString(); stdout += s; process.stdout.write(s); });
    child.stderr.on('data', d => { const s = d.toString(); stderr += s; process.stderr.write(s); });
    child.on('close', code => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 }));
    child.on('error', e => resolve({ stdout: '', stderr: e.message, code: 1 }));
    // Hard backstop: group-kill (SIGTERM then SIGKILL) so descendants holding the
    // pipe can't keep the promise alive. Resolves regardless -> CLI never hangs.
    setTimeout(() => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 1000);
      resolve({ stdout: stdout.trim(), stderr: 'timeout', code: 124 });
    }, 120000);
  });
}

// ── Path resolution ────────────────────────────────────────────────────────
function resolveTaskPath(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return raw;
  if (path.isAbsolute(raw)) return path.resolve(raw);
  const homeCandidate = path.join(HOME, raw);
  if (fs.existsSync(homeCandidate)) return path.resolve(homeCandidate);
  const cliCandidate = path.join(CLI_ROOT, raw);
  if (fs.existsSync(cliCandidate)) return path.resolve(cliCandidate);
  return path.resolve(raw);
}

// ── Trust check ────────────────────────────────────────────────────────────
function isTrusted(filePath, cfg) {
  if (!cfg || !cfg.trusted) return true; // default: trusted if no config
  const abs = path.resolve(filePath);
  return cfg.trusted.some(t => abs.startsWith(path.resolve(t)));
}

// ── Ask user yes/no ────────────────────────────────────────────────────────
function askYN(question) {
  return new Promise(resolve => {
    const r = readline.createInterface({ input: process.stdin, output: process.stdout });
    r.question(C.yellow + question + ' [y/N] ' + C.reset, ans => {
      r.close();
      resolve(ans.trim().toLowerCase() === 'y');
    });
  });
}

// ── Safe write with anti-wipe, backup, trust check ─────────────────────────
const OVERWRITE_PROTECTED = []; // empty = no file protection (GODMODE)

async function safeWrite(filePath, content, trustCfg) {
  const abs = path.resolve(filePath);

  // Disk space guard
  try {
    const avail = parseInt(execSync(`df --output=avail -B1 ${JSON.stringify(path.dirname(abs))} 2>/dev/null | tail -1`).toString().trim(), 10);
    if (avail < 100 * 1024 * 1024) {
      warn('✗ Write blocked: less than 100MB free — free up disk space first.');
      return false;
    }
  } catch {}

  // Hard block: protected files
  if (OVERWRITE_PROTECTED.includes(abs)) {
    warn(`🔒 PROTECTED: ${path.basename(abs)} cannot be overwritten. Use surgical edit instead.`);
    return false;
  }

  // Anti-wipe check
  if (fs.existsSync(abs)) {
    const existing = fs.readFileSync(abs, 'utf8');
    const existingLines = existing.split('\n').length;
    const newLines = content.split('\n').length;
    if (existingLines > 50 && newLines < existingLines * 0.5) {
      warn(`🛑 WIPE BLOCKED: ${path.basename(abs)}`);
      warn(`   Existing: ${existingLines} lines → New: ${newLines} lines (${Math.round(newLines/existingLines*100)}% of original)`);
      return false;
    }
    // Backup before write
    const backupDir = path.join(HOME, 'hakster-backups');
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,16);
      fs.writeFileSync(path.join(backupDir, path.basename(abs) + '.' + ts + '.bak'), existing, 'utf8');
    } catch {}
  }

  if (!isTrusted(abs, trustCfg)) {
    warn(`File not in a trusted folder: ${abs}`);
    const yes = await askYN(`Allow hakster to write this file?`);
    if (!yes) { pl(C.gray, '  skipped.'); return false; }
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    fs.writeFileSync(abs, content, 'utf8');
  } catch (e) {
    if (e.code === 'EACCES') {
      try {
        if (fs.existsSync(abs)) fs.chmodSync(abs, 0o644);
        fs.writeFileSync(abs, content, 'utf8');
        ok(`Wrote (via chmod retry): ${abs}`);
        return true;
      } catch(e2) {
        try {
          execSync(`cat > ${JSON.stringify(abs)}`, { input: content, timeout: 10000, maxBuffer: 50 * 1024 * 1024 });
          ok(`Wrote (via cat fallback): ${abs}`);
          return true;
        } catch(e3) {
          warn(`✗ Permission denied: ${abs}`);
          return false;
        }
      }
    }
    throw e;
  }
  ok(`Wrote: ${abs}`);
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// ── Reasoning detection (line 409 in phantom-cli.js) ──────────────────────
// ══════════════════════════════════════════════════════════════════════════

// Detect if text looks like chain-of-thought reasoning (numbered steps / reasoning patterns)
function isReasoningText(text) {
  if (!text || text.length < 200) return false;
  return /^(let me (think|reason|work|analyze|break)|first,\s+i('ll| will)|reasoning:|thinking:|step 1[:\s])/i.test(text.trim())
    || (/<think>[\s\S]*?<\/think>|<\/think>/.test(text));
}

// ══════════════════════════════════════════════════════════════════════════
// ── Text cleaning utilities ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

// ── Strip markdown fences (line 1687) ──────────────────────────────────────
function stripFences(text) {
  return text.replace(/^```[a-z]*\n?/gm, '').replace(/^```$/gm, '').trim();
}

// ── Strip HTML artifacts (line 1928) ───────────────────────────────────────
function stripHtmlArtifacts(text) {
  return text
    .replace(/<\/?[^>\n]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ══════════════════════════════════════════════════════════════════════════
// ── XML Tool Tag System ───────────────────────────────────────────────────
//
// Tag name mapping: hak_* (primary) with phantom_* (backward-compat alias)
// ══════════════════════════════════════════════════════════════════════════

// Maps each tool type to its primary and alias XML tag prefixes
const TAG_MAP = {
  read:       { primary: 'hak_read',       alias: 'phantom_read' },
  write:      { primary: 'hak_write',      alias: 'phantom_write' },
  edit:       { primary: 'hak_edit',       alias: 'phantom_edit' },
  patch:      { primary: 'hak_patch',      alias: 'phantom_patch' },
  run:        { primary: 'hak_run',        alias: 'phantom_run' },
  search:     { primary: 'hak_search',     alias: 'phantom_search' },
  glob:       { primary: 'hak_glob',       alias: 'phantom_glob' },
  verify:     { primary: 'hak_verify',     alias: 'phantom_verify' },
  plan:       { primary: 'hak_plan',       alias: 'phantom_plan' },
  task:       { primary: 'hak_task',       alias: 'phantom_task' },
  ask:        { primary: 'hak_ask',        alias: 'phantom_ask' },
  usb:        { primary: 'hak_usb',        alias: 'phantom_usb' },
  fetch:      { primary: 'hak_fetch',      alias: 'phantom_fetch' },
  web:        { primary: 'hak_web',        alias: 'phantom_web' },
  diff_content:{ primary: 'hak_diff',      alias: 'phantom_diff' },
  append:     { primary: 'hak_append',     alias: 'phantom_append' },
  multi_edit: { primary: 'hak_multi_edit', alias: 'phantom_multi_edit' },
  skeleton:   { primary: 'hak_skeleton',   alias: 'phantom_skeleton' },
};

// Build a regex alternation that matches either the hak_ or phantom_ prefix
function tagAlt(type) {
  const { primary, alias } = TAG_MAP[type];
  return `(?:${primary}|${alias})`;
}

// ── Parse tool calls from AI response (line 1756) ──────────────────────────
// Returns array of {name, args, raw} where name is the canonical type
// and args is the parsed tool-specific argument object.
function parseTools(text) {
  const tools = [];

  // ── Path validation: reject hallucinated garbage paths ──
  const isValidPath = p => {
    if (!p || p.length < 3) return false;
    if (/^(path|file|dir|cmd|command|url|query|pattern|search|target)$/i.test(p)) return false;
    if (/^[a-z]$/i.test(p)) return false;
    return true;
  };
  const isValidCmd = c => {
    if (!c || c.length < 2) return false;
    if (/^(cmd|command|run|shell|exec|script)$/i.test(c.trim())) return false;
    const words = c.trim().split(/\s+/);
    if (words.length > 8 && /\b(tool|allow|allows?|me|execute|provide|output|this|that|will|can|the|a|an|to|for|with|using)\b/i.test(c)) return false;
    if (/^(tool\.?|this tool|the tool|hak_run|phantom_run)\b/i.test(c.trim())) return false;
    return true;
  };
  // Sanitize commands — fix common LLM escaping mistakes
  const sanitizeCmd = c => {
    let s = c;
    s = s.replace(/\\(["'])/g, '$1');
    s = s.replace(/<<['"]?(\w+)['"]?\\n/g, (match, delim) => `<<'${delim}'\n`);
    s = s.replace(/\bpython\s+-\s+<<</, 'python3 - <<<');
    return s.trim();
  };

  // read (supports offset/limit)
  const readTag = tagAlt('read');
  for (const m of text.matchAll(new RegExp(`<${readTag}(?:\\s+offset="(\\d+)")?(?:\\s+limit="(\\d+)")?>([\\s\\S]*?)<\\/${readTag}>`, 'g'))) {
    const p = m[3].trim();
    if (!isValidPath(p)) continue;
    tools.push({ name: 'read', args: { path: p, offset: m[1] ? parseInt(m[1]) : 0, limit: m[2] ? parseInt(m[2]) : 0 }, raw: m[0] });
  }

  // write
  const writeTag = tagAlt('write');
  for (const m of text.matchAll(new RegExp(`<${writeTag}\\s+path="([^"]+)">([\\s\\S]*?)<\\/${writeTag}>`, 'g'))) {
    if (!isValidPath(m[1].trim())) continue;
    tools.push({ name: 'write', args: { path: m[1].trim(), content: m[2] }, raw: m[0] });
  }

  // edit (old_str → new_str)
  const editTag = tagAlt('edit');
  for (const m of text.matchAll(new RegExp(`<${editTag}\\s+path="([^"]+)">([\\s\\S]*?)<\\/${editTag}>`, 'g'))) {
    if (!isValidPath(m[1].trim())) continue;
    const inner = m[2];
    const oldM = inner.match(/<old>([\s\S]*?)<\/old>/);
    const newM = inner.match(/<new>([\s\S]*?)<\/new>/);
    if (oldM && newM) tools.push({ name: 'edit', args: { path: m[1].trim(), old: oldM[1], new: newM[1] }, raw: m[0] });
  }

  // patch (unified diff with explicit path)
  const patchTag = tagAlt('patch');
  for (const m of text.matchAll(new RegExp(`<${patchTag}\\s+path="([^"]+)">([\\s\\S]*?)<\\/${patchTag}>`, 'g')))
    tools.push({ name: 'patch', args: { path: m[1].trim(), patch: m[2] }, raw: m[0] });
  // patch (path inferred from diff header)
  for (const m of text.matchAll(new RegExp(`<${patchTag}>([\\s\\S]*?)<\\/${patchTag}>`, 'g'))) {
    const patchBody = m[1] || '';
    const hdr = patchBody.match(/^\+\+\+\s+(?:b\/)?([^\n\r\t]+)\s*$/m) || patchBody.match(/^---\s+(?:a\/)?([^\n\r\t]+)\s*$/m);
    if (hdr && hdr[1]) tools.push({ name: 'patch', args: { path: hdr[1].trim(), patch: patchBody }, raw: m[0] });
  }

  // run
  const runTag = tagAlt('run');
  for (const m of text.matchAll(new RegExp(`<${runTag}>([\\s\\S]*?)<\\/${runTag}>`, 'g'))) {
    const raw = m[1].trim();
    if (!isValidCmd(raw)) continue;
    const cmd = sanitizeCmd(raw);
    tools.push({ name: 'run', args: { cmd }, raw: m[0] });
  }

  // search (grep in file or dir)
  const searchTag = tagAlt('search');
  for (const m of text.matchAll(new RegExp(`<${searchTag}\\s+(?:path|file|dir)="([^"]+)"(?:\\s+pattern="([^"]+)")?>([\\s\\S]*?)<\\/${searchTag}>`, 'g'))) {
    const target = m[1].trim();
    const pattern = (m[2] || m[3] || '').trim();
    if (!isValidPath(target) || pattern.length < 2) continue;
    tools.push({ name: 'search', args: { target, pattern }, raw: m[0] });
  }
  // self-closing / attribute-only search
  for (const m of text.matchAll(new RegExp(`<${searchTag}\\s+(?:path|file|dir)="([^"]+)"\\s+pattern="([^"]+)"\\s*\\/?>`, 'g'))) {
    const target = m[1].trim();
    const pattern = m[2].trim();
    if (!isValidPath(target) || pattern.length < 2) continue;
    if (!tools.find(t => t.name === 'search' && t.args.target === target && t.args.pattern === pattern))
      tools.push({ name: 'search', args: { target, pattern }, raw: m[0] });
  }

  // glob (list files matching pattern)
  const globTag = tagAlt('glob');
  for (const m of text.matchAll(new RegExp(`<${globTag}\\s+dir="([^"]*)">([\\s\\S]*?)<\\/${globTag}>`, 'g')))
    tools.push({ name: 'glob', args: { dir: m[1].trim() || HOME, pattern: m[2].trim() }, raw: m[0] });

  // verify
  const verifyTag = tagAlt('verify');
  for (const m of text.matchAll(new RegExp(`<${verifyTag}\\s+path="([^"]+)">([\\s\\S]*?)<\\/${verifyTag}>`, 'g')))
    tools.push({ name: 'verify', args: { path: m[1].trim(), text: m[2].trim() }, raw: m[0] });

  // plan
  const planTag = tagAlt('plan');
  for (const m of text.matchAll(new RegExp(`<${planTag}>([\\s\\S]*?)<\\/${planTag}>`, 'g'))) {
    const steps = m[1].trim().split('\n').map(s => s.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
    tools.push({ name: 'plan', args: { steps }, raw: m[0] });
  }

  // task_update
  const taskTag = tagAlt('task');
  for (const m of text.matchAll(new RegExp(`<${taskTag}\\s+step="(\\d+)"\\s*>`, 'g')))
    tools.push({ name: 'task', args: { step: parseInt(m[1]) }, raw: m[0] });

  // ask
  const askTag = tagAlt('ask');
  for (const m of text.matchAll(new RegExp(`<${askTag}>([\\s\\S]*?)<\\/${askTag}>`, 'g')))
    tools.push({ name: 'ask', args: { question: m[1].trim() }, raw: m[0] });

  // usb sync
  const usbTag = tagAlt('usb');
  for (const m of text.matchAll(new RegExp(`<${usbTag}>([\\s\\S]*?)<\\/${usbTag}>`, 'g')))
    tools.push({ name: 'usb', args: { files: m[1].trim().split(',').map(f => f.trim()).filter(Boolean) }, raw: m[0] });

  // web fetch
  const fetchTag = tagAlt('fetch');
  for (const m of text.matchAll(new RegExp(`<${fetchTag}>([\\s\\S]*?)<\\/${fetchTag}>`, 'g')))
    tools.push({ name: 'fetch', args: { url: m[1].trim() }, raw: m[0] });

  // web search
  const webTag = tagAlt('web');
  for (const m of text.matchAll(new RegExp(`<${webTag}>([\\s\\S]*?)<\\/${webTag}>`, 'g')))
    tools.push({ name: 'web', args: { query: m[1].trim() }, raw: m[0] });

  // diff_content
  const diffTag = tagAlt('diff_content');
  for (const m of text.matchAll(new RegExp(`<${diffTag}\\s+path="([^"]+)">([\\s\\S]*?)<\\/${diffTag}>`, 'g')))
    tools.push({ name: 'diff_content', args: { path: m[1].trim(), content: m[2] }, raw: m[0] });

  // append
  const appendTag = tagAlt('append');
  for (const m of text.matchAll(new RegExp(`<${appendTag}\\s+path="([^"]+)">([\\s\\S]*?)<\\/${appendTag}>`, 'g')))
    tools.push({ name: 'append', args: { path: m[1].trim(), content: m[2] }, raw: m[0] });

  // multi_edit
  const multiEditTag = tagAlt('multi_edit');
  for (const m of text.matchAll(new RegExp(`<${multiEditTag}\\s+path="([^"]+)">([\\s\\S]*?)<\\/${multiEditTag}>`, 'g'))) {
    const inner = m[2];
    const edits = [];
    const patchRE = /<patch\s+old="([^"]*)"\s+new="([^"]*)"\s*\/>/g;
    for (const pm of inner.matchAll(patchRE)) {
      edits.push({ old: pm[1], new: pm[2] });
    }
    if (edits.length > 0) tools.push({ name: 'multi_edit', args: { path: m[1].trim(), edits }, raw: m[0] });
  }

  // skeleton
  const skeletonTag = tagAlt('skeleton');
  for (const m of text.matchAll(new RegExp(`<${skeletonTag}(?:\\s+name="([^"]*)")?\\s*>`, 'g')))
    tools.push({ name: 'skeleton', args: { name: m[1] ? m[1].trim() : null }, raw: m[0] });

  return tools;
}

// ── Strip tool tags from response text (line 1887) ─────────────────────────
function stripTools(text) {
  let result = text;

  // Strip each tool type's tags (both hak_ and phantom_ prefixes)
  for (const type of Object.keys(TAG_MAP)) {
    const { primary, alias } = TAG_MAP[type];
    // Match both prefixed forms
    const tagRE = `(?:${primary}|${alias})`;
    // Content tags with attributes
    result = result.replace(new RegExp(`<${tagRE}\\s+[^>]*>[\\s\\S]*?<\\/${tagRE}>`, 'g'), '');
    // Content tags without attributes
    result = result.replace(new RegExp(`<${tagRE}>[\\s\\S]*?<\\/${tagRE}>`, 'g'), '');
    // Self-closing / standalone tags (task, skeleton)
    result = result.replace(new RegExp(`<${tagRE}[^>]*>`, 'g'), '');
    // Closing tags
    result = result.replace(new RegExp(`<\\/${tagRE}>`, 'g'), '');
  }

  // Catch any remaining malformed/unclosed phantom_ or hak_ tags
  result = result.replace(/<phantom_\w+[^>]*>/g, '')
    .replace(/<\/phantom_\w+>/g, '')
    .replace(/<hak_\w+[^>]*>/g, '')
    .replace(/<\/hak_\w+>/g, '');

  // Strip memory_ XML tags that leak from model output
  result = result.replace(/<memory_read\s*\/>/g, '')
    .replace(/<memory_read[^>]*>[\s\S]*?<\/memory_read>/g, '')
    .replace(/<memory_\w+\s*[^>]*\/>/g, '')
    .replace(/<memory_\w+[^>]*>[\s\S]*?<\/memory_\w+>/g, '')
    .replace(/<\/?memory_\w+>/g, '');

  // Strip tool_ XML tags
  result = result.replace(/<tool_\w+\s*[^>]*>/g, '')
    .replace(/<\/tool_\w+>/g, '');

  // Strip kimi/ollama specific tags
  result = result.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<\/?tool_call>/g, '')
    .replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, '')
    .replace(/<\|im_start\|>/g, '')
    .replace(/<\|im_end\|>/g, '');

  return result.trim();
}

// ══════════════════════════════════════════════════════════════════════════
// ── Tool Definitions (for system prompt injection) ─────────────────────────
// ══════════════════════════════════════════════════════════════════════════

const TOOL_DEFINITIONS = [
  { name: 'hak_read', description: 'Read file contents in paged chunks. Supports offset and limit attributes for paging large files.',
    usage: '<hak_read offset="0" limit="200">path/to/file.js</hak_read>' },
  { name: 'hak_write', description: 'Write full content to a file (create or overwrite). Anti-wipe protection active.',
    usage: '<hak_write path="path/to/file.js">file content here</hak_write>' },
  { name: 'hak_edit', description: 'Surgically replace exact text in a file using <old> and <new> sub-tags. Always read first.',
    usage: '<hak_edit path="file.js"><old>exact old text</old><new>new text</new></hak_edit>' },
  { name: 'hak_patch', description: 'Apply a unified diff patch to a file. Path can be explicit or inferred from diff header.',
    usage: '<hak_patch path="file.js">--- a/file.js\n+++ b/file.js\n@@ -1,3 +1,3 @@\n-old\n+new</hak_patch>' },
  { name: 'hak_run', description: 'Run a shell command. Returns stdout, stderr, and exit code.',
    usage: '<hak_run>ls -la /home/ghost</hak_run>' },
  { name: 'hak_search', description: 'Search for a regex pattern in files or directories. Uses ripgrep with grep fallback.',
    usage: '<hak_search path="/home/ghost/project" pattern="function">optional inline pattern</hak_search>' },
  { name: 'hak_glob', description: 'List files matching a name pattern in a directory.',
    usage: '<hak_glob dir="/home/ghost">*.js</hak_glob>' },
  { name: 'hak_verify', description: 'Verify that specific text exists in a file before editing.',
    usage: '<hak_verify path="file.js">text to verify</hak_verify>' },
  { name: 'hak_plan', description: 'Declare a multi-step plan. Each line is a step.',
    usage: '<hak_plan>\n1. Read the file\n2. Fix the bug\n3. Test the fix\n</hak_plan>' },
  { name: 'hak_task', description: 'Mark a plan step as done.',
    usage: '<hak_task step="1">' },
  { name: 'hak_ask', description: 'Ask the user a question and wait for their answer.',
    usage: '<hak_ask>What file should I edit?</hak_ask>' },
  { name: 'hak_fetch', description: 'Fetch content from a URL via curl.',
    usage: '<hak_fetch>https://example.com/api</hak_fetch>' },
  { name: 'hak_web', description: 'Search the web using DuckDuckGo.',
    usage: '<hak_web>how to parse JSON in node.js</hak_web>' },
  { name: 'hak_diff', description: 'Show line-by-line diff between proposed content and current file.',
    usage: '<hak_diff path="file.js">proposed content</hak_diff>' },
  { name: 'hak_append', description: 'Append text to the end of a file.',
    usage: '<hak_append path="file.js">text to append</hak_append>' },
  { name: 'hak_multi_edit', description: 'Apply multiple surgical old→new patches to one file in one pass.',
    usage: '<hak_multi_edit path="file.js"><patch old="foo" new="bar" /><patch old="baz" new="qux" /></hak_multi_edit>' },
  { name: 'hak_skeleton', description: 'Fetch agent skill template skeletons.',
    usage: '<hak_skeleton name="browser-recon" />' },
  { name: 'codebase_index', description: 'Return persistent project inventory and direct file:line anchors for known projects.',
    usage: '<codebase_index project="haksterAi" maxAnchors="120" />' },
];

// ── Claude native tool schemas (for API tool_use format) ───────────────────
const CLI_CLAUDE_TOOLS = [
  { name:'read_file', description:'Read file contents in paged chunks. Returns up to 1200 lines by default. Use start/end or max_lines to page through large files.',
    input_schema:{ type:'object', properties:{ file:{type:'string',description:'Absolute or relative path'}, start:{type:'number',description:'Start line (1-based)'}, end:{type:'number',description:'End line (inclusive)'}, max_lines:{type:'number',description:'Max lines to return (default 1200, max 50000)'} }, required:['file'] } },
  { name:'edit_file', description:'Surgically replace exact text in a file. old_str must be character-perfect. Always read first.',
    input_schema:{ type:'object', properties:{ file:{type:'string'}, old_str:{type:'string',description:'Exact text to replace'}, new_str:{type:'string',description:'Replacement text'} }, required:['file','old_str','new_str'] } },
  { name:'write_file', description:'Write full content to a file (create or overwrite).',
    input_schema:{ type:'object', properties:{ file:{type:'string'}, content:{type:'string'} }, required:['file','content'] } },
  { name:'append_file', description:'Append text to end of file.',
    input_schema:{ type:'object', properties:{ file:{type:'string'}, content:{type:'string'} }, required:['file','content'] } },
  { name:'grep', description:'Search regex pattern in files.',
    input_schema:{ type:'object', properties:{ pattern:{type:'string'}, dir:{type:'string',description:'Directory to search'}, ext:{type:'string',description:'File extension filter e.g. js'} }, required:['pattern'] } },
  { name:'glob', description:'Find files by name pattern.',
    input_schema:{ type:'object', properties:{ pattern:{type:'string',description:'e.g. *.js'}, dir:{type:'string'} }, required:['pattern'] } },
  { name:'run_command', description:'Run a shell command. Returns stdout+stderr.',
    input_schema:{ type:'object', properties:{ command:{type:'string'}, cwd:{type:'string'} }, required:['command'] } },
  { name:'list_dir', description:'List files in a directory.',
    input_schema:{ type:'object', properties:{ dir:{type:'string',description:'Directory path'} }, required:[] } },
  { name:'fetch_url', description:'Fetch content from a URL.',
    input_schema:{ type:'object', properties:{ url:{type:'string'} }, required:['url'] } },
  { name:'search_web', description:'Search the web.',
    input_schema:{ type:'object', properties:{ query:{type:'string'} }, required:['query'] } },
  { name:'diff_content', description:'Show line-by-line diff between proposed content and current file before editing.',
    input_schema:{ type:'object', properties:{ file:{type:'string'}, content:{type:'string'} }, required:['file','content'] } },
  { name:'multi_edit', description:'Apply multiple surgical old->new patches to one file in one pass.',
    input_schema:{ type:'object', properties:{ file:{type:'string'}, patches:{type:'array',items:{type:'object',properties:{old_str:{type:'string'},new_str:{type:'string'}},required:['old_str','new_str']}} }, required:['file','patches'] } },
  { name:'skeleton', description:'Fetch agent skill template skeletons from server DB.',
    input_schema:{ type:'object', properties:{ name:{type:'string',description:'Optional skill name filter'} }, required:[] } },
  { name:'codebase_index', description:'Return persistent project inventory and direct file:line anchors for known projects.',
    input_schema:{ type:'object', properties:{ project:{type:'string'}, query:{type:'string'}, maxAnchors:{type:'number'}, refresh:{type:'boolean'} }, required:[] } },
];

// ══════════════════════════════════════════════════════════════════════════
// ── cliExecuteTool — execute a single tool by name (line 3456) ─────────────
// Returns {ok, output, error}
// ══════════════════════════════════════════════════════════════════════════

async function cliExecuteTool(name, args, trustCfg) {
  try {
    switch (name) {
      case 'read_file':
      case 'hak_read': {
        const filePath = args.file || args.path;
        if (!filePath) return { ok: false, output: '', error: 'Missing file path' };
        const abs = path.resolve(filePath.startsWith('/') ? filePath : path.join(HOME, filePath));
        if (!fs.existsSync(abs)) return { ok: false, output: '', error: `File not found: ${abs}` };
        const stat = fs.statSync(abs);
        // Stream large files to avoid OOM
        if (stat.size > 5 * 1024 * 1024 && !args.start && !args.end && !args.offset) {
          const wc = execSync(`wc -l < ${JSON.stringify(abs)}`).toString().trim();
          return { ok: true, output: `[File too large to read fully: ${(stat.size/1024/1024).toFixed(1)}MB, ${wc} lines. Use start/end to read sections.]`, error: null };
        }
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        const maxL = Math.min(args.max_lines || args.limit || 1200, 50000);
        const s = Math.max(0, (args.start || (args.offset ? args.offset + 1 : 1)) - 1);
        const e2 = args.end ? Math.min(lines.length, args.end) : Math.min(lines.length, s + maxL);
        let out = lines.slice(s, e2).map((l, i) => `${s + i + 1}: ${l}`).join('\n');
        // Cap at 60K chars
        const CAP = 60000;
        if (out.length > CAP) {
          out = out.slice(0, CAP) + `\n[... truncated — ${out.length - CAP} more chars. Use start:${s + out.slice(0, CAP).split('\n').length} to continue]`;
        }
        const more = e2 < lines.length ? `\n[showing lines ${s+1}-${e2} of ${lines.length} — use start:${e2+1} to continue]` : `\n[${lines.length} lines total]`;
        return { ok: true, output: out + more, error: null };
      }

      case 'grep':
      case 'hak_search':
      case 'search_files': {
        const pattern = args.pattern || args.query;
        if (!pattern) return { ok: false, output: '', error: 'Missing search pattern' };
        const searchPath = args.path || args.dir || args.target || HOME;
        const target = JSON.stringify(searchPath);
        const ext = args.ext ? `--include="*.${args.ext}"` : '';
        const maxR = args.maxResults || 500;
        const r = await runCmd(`grep -r -n ${ext} -E ${JSON.stringify(pattern)} ${target} 2>/dev/null | head -${maxR}`);
        return { ok: true, output: r.stdout || 'No matches', error: null };
      }

      case 'glob':
      case 'hak_glob':
      case 'glob_search': {
        const dir = JSON.stringify(args.dir || HOME);
        const pat = JSON.stringify(args.pattern || '*');
        const maxR = args.maxResults || 500;
        const r = await runCmd(`find ${dir} -name ${pat} -maxdepth 10 2>/dev/null | head -${maxR}`);
        return { ok: true, output: r.stdout || 'No files found', error: null };
      }

      case 'run_command':
      case 'hak_run':
      case 'exec_shell': {
        const command = args.command || args.cmd;
        if (!command) return { ok: false, output: '', error: 'Missing command' };
        console.log(`\n${C.gray}  $ ${command}${C.reset}`);
        const timeoutMs = args.timeout_ms || args.timeout || 60000;
        const timeoutS = Math.min(Math.ceil(timeoutMs / 1000), 600);
        const { stdout, stderr, code } = await runCmdStream(`timeout ${timeoutS} nice -n10 bash -c ${JSON.stringify(command)}`, args.cwd || HOME);
        const out = (stdout + (stderr ? '\nSTDERR: ' + stderr : '')).trim() + (code ? `\nexit: ${code}` : '');
        return { ok: (!code || code === 0), output: out, error: code ? `exit: ${code}` : null };
      }

      case 'write_file':
      case 'hak_write': {
        const filePath = args.file || args.path;
        if (!filePath) return { ok: false, output: '', error: 'Missing file path' };
        const okResult = await safeWrite(filePath, args.content || '', trustCfg);
        return { ok: okResult, output: okResult ? `Written: ${filePath}` : 'Write blocked or failed', error: okResult ? null : 'Write blocked' };
      }

      case 'edit_file':
      case 'hak_edit': {
        const filePath = args.file || args.path;
        if (!filePath) return { ok: false, output: '', error: 'Missing file path' };
        const abs = path.resolve(filePath.startsWith('/') ? filePath : path.join(HOME, filePath));
        if (!fs.existsSync(abs)) return { ok: false, output: '', error: `File not found: ${abs}` };
        const content = fs.readFileSync(abs, 'utf8');
        const lfContent = content.replace(/\r\n/g, '\n');
        const lfOld = String(args.old_str || args.old || '').replace(/\r\n/g, '\n');
        const newStr = args.new_str || args.new || '';
        const trimRight = s => s.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
        let updated = null;
        let editMode = 'exact';
        if (content.includes(args.old_str || args.old)) {
          updated = content.replace(args.old_str || args.old, newStr);
        } else if (lfContent.includes(lfOld)) {
          updated = lfContent.replace(lfOld, newStr);
          editMode = 'lf-normalized';
        } else {
          const trContent = trimRight(lfContent);
          const trOld = trimRight(lfOld);
          if (trContent.includes(trOld)) {
            updated = trContent.replace(trOld, newStr);
            editMode = 'trim-right-normalized';
          }
        }
        if (!updated) return { ok: false, output: '', error: `Edit failed: old_str not found in ${path.basename(abs)}. Use read_file first to get exact current text.` };
        // Anti-wipe
        if (updated.length < content.length * 0.8) return { ok: false, output: '', error: `Edit blocked: result would shrink file by >${Math.round((1 - updated.length / content.length) * 100)}% — too destructive.` };
        const writeOk = await safeWrite(filePath, updated, trustCfg);
        if (!writeOk) return { ok: false, output: '', error: 'Write blocked during edit' };
        // Show diff
        const oldLines = (args.old_str || args.old || '').split('\n');
        const newLines = newStr.split('\n');
        const diffOut = [
          `\n${C.bold}  ✎ ${path.basename(abs)}${C.reset}`,
          ...oldLines.slice(0, 8).map(l => `${C.red}  - ${l}${C.reset}`),
          ...newLines.slice(0, 8).map(l => `${C.green}  + ${l}${C.reset}`),
        ].join('\n');
        process.stdout.write(diffOut + '\n');
        return { ok: true, output: `Edited: ${path.basename(abs)} (${editMode})`, error: null };
      }

      case 'append_file':
      case 'hak_append': {
        const filePath = args.file || args.path;
        if (!filePath) return { ok: false, output: '', error: 'Missing file path' };
        const abs = path.resolve(filePath.startsWith('/') ? filePath : path.join(HOME, filePath));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.appendFileSync(abs, args.content || '');
        return { ok: true, output: `Appended to: ${abs}`, error: null };
      }

      case 'list_dir': {
        const r = await runCmd(`ls -la ${JSON.stringify(args.dir || HOME)} 2>/dev/null`);
        return { ok: true, output: r.stdout || 'Empty or not found', error: null };
      }

      case 'fetch_url':
      case 'hak_fetch':
      case 'web_fetch': {
        if (!args.url) return { ok: false, output: '', error: 'Missing URL' };
        const r = await runCmd(`curl -sL --max-time 15 ${JSON.stringify(args.url)} 2>/dev/null | head -c 8000`);
        return { ok: true, output: r.stdout || 'No content', error: null };
      }

      case 'search_web':
      case 'hak_web':
      case 'web_search': {
        const q = encodeURIComponent(args.query || '');
        const r = await runCmd(`curl -sL "https://api.duckduckgo.com/?q=${q}&format=json" 2>/dev/null`);
        try {
          const j = JSON.parse(r.stdout || '{}');
          const results = (j.RelatedTopics || []).slice(0, 5).map(t => t.Text || '').filter(Boolean);
          return { ok: true, output: (j.AbstractText || '') + (results.length ? '\n' + results.join('\n') : '') || 'No results', error: null };
        } catch {
          return { ok: true, output: (r.stdout || '').slice(0, 500) || 'No results', error: null };
        }
      }

      case 'firecrawl':
      case 'firecrawl_scrape':
      case 'firecrawl_search': {
        const http = require('http');
        const isSearch = name === 'firecrawl_search' || (args.action === 'search');
        const body = JSON.stringify(isSearch
          ? { action: 'search', query: args.query || args.q || '' }
          : { action: 'scrape', url: args.url || '' });
        const raw = await new Promise(resolve => {
          const req = http.request({ hostname: '127.0.0.1', port: 3579, path: '/api/agent/firecrawl', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
          });
          req.on('error', e => resolve({ status: 0, body: JSON.stringify({ ok: false, error: e.message }) }));
          req.write(body); req.end();
        });
        try {
          const parsed = JSON.parse(raw.body || '{}');
          if (parsed.ok) return { ok: true, output: parsed.output || 'No content', error: null };
          return { ok: false, output: '', error: parsed.error || `Firecrawl request failed (${raw.status})` };
        } catch (e) {
          return { ok: false, output: '', error: `Firecrawl proxy error: ${e.message}` };
        }
      }

      case 'save_memory': {
        // Save to server memory API
        const http = require('http');
        const data = JSON.stringify({ category: args.category || 'general', key: args.key, value: args.value });
        const result = await new Promise(resolve => {
          const req = http.request({ hostname: '127.0.0.1', port: 3579, path: '/api/agent/memory', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
          });
          req.on('error', () => resolve('{"ok":false}')); req.write(data); req.end();
        });
        return { ok: true, output: `Memory saved: ${args.key}`, error: null };
      }

      case 'recall_memory': {
        const http = require('http');
        const q = encodeURIComponent(args.query || '');
        const raw = await new Promise(resolve => {
          const req = http.request({ hostname: '127.0.0.1', port: 3579, path: `/api/agent/memory?q=${q}`, method: 'GET' }, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
          });
          req.on('error', () => resolve('[]')); req.end();
        });
        return { ok: true, output: raw || 'No memories found', error: null };
      }

      case 'list_skills': {
        const skillsDir = '/home/ghost/haksterAi/server/data/skills';
        try {
          const files = [];
          function walk(dir, depth) {
            if (depth > 3) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (entry.name.startsWith('.')) continue;
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) walk(full, depth + 1);
              else if (entry.name.endsWith('.md')) files.push(full);
            }
          }
          walk(skillsDir, 0);
          const filter = args.search || args.category;
          const filtered = filter ? files.filter(f => f.toLowerCase().includes(filter.toLowerCase())) : files;
          const out = filtered.slice(0, 100).map((f, i) => `${i+1}. ${f.replace(skillsDir + '/', '')}`).join('\n');
          return { ok: true, output: out || 'No skills found', error: null };
        } catch (e) {
          return { ok: true, output: `Skills directory not accessible: ${e.message}`, error: null };
        }
      }

      case 'read_skill': {
        const skillName = args.name || '';
        if (!skillName) return { ok: false, output: '', error: 'Missing skill name' };
        const skillsDir = '/home/ghost/haksterAi/server/data/skills';
        const candidates = [
          path.join(skillsDir, skillName),
          path.join(skillsDir, skillName + '.md'),
          path.join(skillsDir, 'pentest-agents', 'skills', skillName),
          path.join(skillsDir, 'pentest-agents', 'skills', skillName + '.md'),
        ];
        for (const c of candidates) {
          if (fs.existsSync(c)) {
            const content = fs.readFileSync(c, 'utf8');
            return { ok: true, output: content.slice(0, 60000), error: null };
          }
        }
        // Try recursive search
        try {
          function findSkill(dir, name) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) { const r = findSkill(full, name); if (r) return r; }
              else if (entry.name === name || entry.name === name + '.md') return full;
            }
            return null;
          }
          const found = findSkill(skillsDir, skillName);
          if (found) return { ok: true, output: fs.readFileSync(found, 'utf8').slice(0, 60000), error: null };
        } catch {}
        return { ok: false, output: '', error: `Skill not found: ${skillName}` };
      }

      case 'replace_in_file': {
        const filePath = args.file || args.path;
        if (!filePath) return { ok: false, output: '', error: 'Missing file path' };
        const abs = path.resolve(filePath.startsWith('/') ? filePath : path.join(HOME, filePath));
        if (!fs.existsSync(abs)) {
          if (args.createIfMissing) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, ''); }
          else return { ok: false, output: '', error: `File not found: ${abs}` };
        }
        let content = fs.readFileSync(abs, 'utf8');
        const replacements = args.replacements || [];
        let applied = 0, failed = 0;
        for (const { old, new: newS } of replacements) {
          if (content.includes(old)) { content = content.replace(old, newS); applied++; }
          else failed++;
        }
        if (failed > 0) return { ok: false, output: `${applied} applied, ${failed} failed`, error: `${failed} replacements failed` };
        const writeOk = await safeWrite(filePath, content, trustCfg);
        return { ok: writeOk, output: `Replaced ${applied} in ${path.basename(abs)}`, error: writeOk ? null : 'Write blocked' };
      }

      case 'shell_bg': {
        const command = args.command;
        if (!command) return { ok: false, output: '', error: 'Missing command' };
        const { spawn } = require('child_process');
        const cwd = args.cwd || HOME;
        const child = spawn('bash', ['-c', command], { cwd, detached: true, stdio: 'ignore' });
        child.unref();
        return { ok: true, output: `Background process started (pid: ${child.pid})${args.label ? ` — ${args.label}` : ''}`, error: null };
      }

      case 'diff_preview': {
        const filePath = args.file || args.path;
        if (!filePath) return { ok: false, output: '', error: 'Missing file path' };
        const abs = path.resolve(filePath.startsWith('/') ? filePath : path.join(HOME, filePath));
        if (!fs.existsSync(abs)) return { ok: false, output: '', error: 'File not found' };
        let content = fs.readFileSync(abs, 'utf8');
        const replacements = args.replacements || [];
        let preview = `=== DIFF PREVIEW: ${filePath} ===\n`;
        for (const { old, new: newS } of replacements) {
          if (content.includes(old)) {
            const oldLines = old.split('\n').slice(0, 5);
            const newLines = newS.split('\n').slice(0, 5);
            preview += oldLines.map(l => `${C.red}- ${l}${C.reset}`).join('\n') + '\n';
            preview += newLines.map(l => `${C.green}+ ${l}${C.reset}`).join('\n') + '\n';
          } else {
            preview += `${C.red}⚠ "old" text not found — this replacement would fail${C.reset}\n`;
          }
        }
        return { ok: true, output: preview, error: null };
      }

      case 'codebase_map': {
        const targetDir = args.focus ? path.resolve(HOME, args.focus) : HOME;
        const maxDepth = args.maxDepth || 4;
        const maxFiles = args.maxFiles || 200;
        try {
          const r = await runCmd(`find ${JSON.stringify(targetDir)} -maxdepth ${maxDepth} -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.pm2/*' -type f 2>/dev/null | head -${maxFiles} | sort`);
          const files = (r.stdout || '').split('\n').filter(Boolean);
          const byDir = {};
          for (const f of files) {
            const dir = path.dirname(f).replace(targetDir, '.');
            byDir[dir] = (byDir[dir] || 0) + 1;
          }
          const dirSummary = Object.entries(byDir).sort((a,b) => b[1] - a[1]).map(([d, c]) => `  ${d}/ (${c} files)`).join('\n');
          return { ok: true, output: `Codebase map for ${targetDir} (${files.length} files):\n${dirSummary}`, error: null };
        } catch (e) {
          return { ok: true, output: `Map error: ${e.message}`, error: null };
        }
      }

      case 'codebase_index': {
        try {
          const { formatCodebaseIndex } = require('../server/src/projectInventory');
          return {
            ok: true,
            output: formatCodebaseIndex({
              project: args.project,
              query: args.query,
              maxAnchors: args.maxAnchors || 120,
              refresh: !!args.refresh,
            }),
            error: null,
          };
        } catch (e) {
          return { ok: false, output: '', error: e.message };
        }
      }

      case 'context_compaction': {
        return { ok: true, output: '[Context compaction is handled automatically by the server. No action needed.]', error: null };
      }

      case 'diff_content':
      case 'hak_diff': {
        const filePath = args.file || args.path;
        if (!filePath) return { ok: false, output: '', error: 'Missing file path' };
        const abs = path.resolve(filePath);
        const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
        if (!current) return { ok: false, output: '', error: 'File not found' };
        const modelLines = (args.content || '').split('\n');
        const fileLines = current.split('\n');
        const diffLines = [`=== DIFF: ${filePath} ===`, `[Model proposed ${modelLines.length} lines, file has ${fileLines.length} lines]`, ''];
        const maxLen = Math.max(modelLines.length, fileLines.length);
        for (let i = 0; i < maxLen; i++) {
          const mLine = i < modelLines.length ? modelLines[i] : null;
          const fLine = i < fileLines.length ? fileLines[i] : null;
          if (mLine === fLine) {
            diffLines.push(`  ${String(i+1).padStart(4)}: ${fLine || ''}`);
          } else {
            if (fLine !== null) diffLines.push(`- ${String(i+1).padStart(4)}: ${fLine}`);
            if (mLine !== null) diffLines.push(`+ ${String(i+1).padStart(4)}: ${mLine}`);
          }
        }
        return { ok: true, output: diffLines.join('\n'), error: null };
      }

      case 'multi_edit':
      case 'hak_multi_edit': {
        const filePath = args.file || args.path;
        if (!filePath) return { ok: false, output: '', error: 'Missing file path' };
        const abs = path.resolve(filePath.startsWith('/') ? filePath : path.join(HOME, filePath));
        let content = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
        if (!content) return { ok: false, output: '', error: 'File not found' };
        const patches = args.patches || args.edits || [];
        let applied = 0, failed = 0;
        for (const { old_str, old, new_str, new: newS } of patches) {
          const oldVal = old_str || old;
          const newVal = new_str || newS;
          const lfContent = content.replace(/\r\n/g, '\n');
          const lfOld = String(oldVal || '').replace(/\r\n/g, '\n');
          if (content.includes(oldVal)) {
            content = content.replace(oldVal, newVal);
            applied++;
          } else if (lfContent.includes(lfOld)) {
            content = lfContent.replace(lfOld, newVal);
            applied++;
          } else {
            failed++;
            pl(C.red, `     ⚠ patch ${applied+failed}: old_str not found — skipping`);
          }
        }
        if (failed > 0) return { ok: false, output: `⚠ ${failed} failed, ${applied} applied — re-read file and retry failed patches`, error: `${failed} patches failed` };
        if (applied === 0) return { ok: false, output: 'No patches applied', error: 'No patches applied' };
        const writeOk = await safeWrite(filePath, content, trustCfg);
        if (!writeOk) return { ok: false, output: '', error: 'Write blocked during multi_edit' };
        return { ok: true, output: `Edited: ${path.basename(abs)} (${applied} patches applied)`, error: null };
      }

      case 'skeleton':
      case 'hak_skeleton': {
        // Fetch from server DB if available, otherwise return empty
        const http = require('http');
        const url = args.name ? `/api/agent-skills?name=${encodeURIComponent(args.name)}` : '/api/agent-skills';
        const serverUrl = new URL(process.env.HAKSTER_SERVER || process.env.HAKSTER_API || 'http://127.0.0.1:3579');
        const raw = await new Promise(resolve => {
          const req = http.request({ hostname: serverUrl.hostname, port: serverUrl.port || 80, path: url, method: 'GET' }, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
          });
          req.on('error', () => resolve('{}')); req.end();
        });
        try {
          const data = JSON.parse(raw || '{}');
          const skills = Array.isArray(data.skills) ? data.skills.filter(Boolean).slice(0, 24) : [];
          const out = `[AGENT SKELETONS]:\n${skills.map((s, i) => `${i+1}. ${s.name || 'unnamed'} — ${s.description || 'no description'}`).join('\n')}`;
          return { ok: true, output: out, error: null };
        } catch (e) {
          return { ok: true, output: `[AGENT SKELETONS]: none available (${e.message})`, error: null };
        }
      }

      case 'verify':
      case 'hak_verify': {
        if (!args.path) return { ok: false, output: '', error: 'Missing file path' };
        const abs = path.resolve(args.path);
        const content = fs.existsSync(abs) ? (() => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } })() : null;
        const found = content ? content.includes(args.text) : false;
        return { ok: true, output: `[VERIFY ${args.path}]: found=${found}`, error: null };
      }

      default:
        return { ok: false, output: '', error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { ok: false, output: '', error: `Tool error: ${e.message}` };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ── execTools — execute multiple tools from parseTools() output ────────────
// (line 2623 in phantom-cli.js)
//
// Returns {results: array, actions: Set}
// ══════════════════════════════════════════════════════════════════════════

async function execTools(tools, trustCfg, rl) {
  const executedActions = new Set();

  // Tolerant replace for edit reliability
  const tryRobustReplace = (content, oldStr, newStr) => {
    if (content.includes(oldStr)) {
      return { ok: true, updated: content.replace(oldStr, newStr), mode: 'exact' };
    }
    const lfContent = content.replace(/\r\n/g, '\n');
    const lfOld = String(oldStr || '').replace(/\r\n/g, '\n');
    if (lfContent.includes(lfOld)) {
      return { ok: true, updated: lfContent.replace(lfOld, newStr), mode: 'lf-normalized' };
    }
    const trimRight = s => s.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
    const trContent = trimRight(lfContent);
    const trOld = trimRight(lfOld);
    if (trContent.includes(trOld)) {
      return { ok: true, updated: trContent.replace(trOld, newStr), mode: 'trim-right-normalized' };
    }
    return { ok: false, updated: null, mode: 'not-found' };
  };

  // Action hash for dedup detection
  const actionHash = (tool) => {
    const key = tool.name;
    const a = tool.args || {};
    if (a.path) return key + ':' + a.path;
    if (a.pattern && a.target) return key + ':' + a.pattern + '@' + a.target;
    if (a.cmd) return key + ':' + a.cmd;
    if (a.command) return key + ':' + a.command;
    return key + ':' + JSON.stringify(a).slice(0, 60);
  };

  // Normalize tools to {name, args} format (parseTools already outputs this)
  const normalized = tools.map(t => ({
    name: t.name,
    args: t.args || t,
    raw: t.raw,
  }));

  // Separate reads (parallel) from writes/runs (sequential)
  const READ_TYPES = new Set(['read', 'search', 'glob', 'verify', 'fetch', 'web']);
  const reads  = normalized.filter(t => READ_TYPES.has(t.name));
  const writes = normalized.filter(t => !READ_TYPES.has(t.name));

  const resultMap = new Map(); // index → result string
  const currentRoundHashes = new Set();

  // ── Parallel reads ───────────────────────────────────────────────────────
  await Promise.all(reads.map(async tool => {
    const idx = normalized.indexOf(tool);
    const hash = actionHash(tool);
    if (currentRoundHashes.has(hash)) {
      resultMap.set(idx, `[${tool.name.toUpperCase()}]: SKIPPED — duplicate tool call in same round`);
      return;
    }
    currentRoundHashes.add(hash);

    // Use cliExecuteTool for each read type
    const nameMap = {
      read: 'hak_read', search: 'hak_search', glob: 'hak_glob',
      verify: 'hak_verify', fetch: 'hak_fetch', web: 'hak_web',
    };
    const cliName = nameMap[tool.name] || tool.name;
    const result = await cliExecuteTool(cliName, tool.args, trustCfg);

    if (tool.name === 'read') {
      const abs = resolveTaskPath(tool.args.path);
      executedActions.add('read:' + abs);
      if (!result.ok) {
        warn(`     ✗ not found: ${tool.args.path}`);
      } else {
        dim(`     ${result.output.split('\n').length} lines`);
      }
    } else if (tool.name === 'search') {
      executedActions.add(hash);
      if (executedActions.has(hash)) { /* already tracked */ }
    } else if (tool.name === 'glob') {
      executedActions.add(hash);
    } else if (tool.name === 'verify') {
      executedActions.add(hash);
    }

    resultMap.set(idx, result.ok ? result.output : `[${tool.name.toUpperCase()}]: ${result.error || 'failed'}`);
  }));

  // ── Sequential writes/runs ───────────────────────────────────────────────
  for (const tool of writes) {
    const idx = normalized.indexOf(tool);
    const hash = actionHash(tool);

    // Map internal names to cliExecuteTool names
    const nameMap = {
      write: 'hak_write', edit: 'hak_edit', patch: 'hak_patch',
      run: 'hak_run', append: 'hak_append', multi_edit: 'hak_multi_edit',
      diff_content: 'hak_diff', plan: 'hak_plan', task: 'hak_task',
      ask: 'hak_ask', usb: 'hak_usb', skeleton: 'hak_skeleton',
    };

    if (['write', 'edit', 'patch', 'append', 'multi_edit'].includes(tool.name)) {
      if (executedActions.has(hash)) {
        pl(C.gray, `  ✏️  ${path.basename(tool.args.path || '')} (cached)`);
        resultMap.set(idx, `[${tool.name.toUpperCase()} ${tool.args.path}]: SKIPPED — already done in previous round`);
        continue;
      }
      executedActions.add(hash);
    }

    if (tool.name === 'run') {
      // Anti-redundancy: skip cat/sed/head/tail of files already read
      const readFileMatch = tool.args.cmd.match(/^(?:cat|sed|head|tail|less|more|nl)\s+(?:-[^\s]+\s+)*([^\s|>;]+)/);
      if (readFileMatch) {
        const filePath = readFileMatch[1].replace(/['"]/g, '').trim();
        const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(pshell.cwd(), filePath);
        if (executedActions.has('read:' + absPath)) {
          pl(C.gray, `  ♻ ${path.basename(absPath)} already read — skipping re-read`);
          resultMap.set(idx, `[RUN SKIPPED]: ${path.basename(absPath)} was already read via hak_read — use the content from that read instead of re-reading.`);
          continue;
        }
      }
      // Block wasteful ls -R / find on home
      const wastefulLs = /^(?:ls\s+-[a-z]*R?|find\s+\/home\/ghost\s+-maxdepth\s+1)\s/.test(tool.args.cmd);
      if (wastefulLs && !/specific|grep|rg|\.git/.test(tool.args.cmd)) {
        pl(C.yellow, `  ⚠ BLOCKED: wasteful directory listing — use hak_glob or hak_search instead`);
        resultMap.set(idx, `[RUN BLOCKED]: ls -R / ls -l / find on large dirs wastes context. Use <hak_glob dir="/path">*.js</hak_glob> for file listings or <hak_search path="/path">pattern</hak_search> for content search.`);
        continue;
      }
    }

    if (tool.name === 'plan') {
      resultMap.set(idx, `[PLAN]: ${tool.args.steps.length} steps set`);
      continue;
    }

    if (tool.name === 'task') {
      resultMap.set(idx, `[TASK step ${tool.args.step}]: marked done`);
      continue;
    }

    if (tool.name === 'ask') {
      if (!rl) {
        resultMap.set(idx, `[ASK]: No readline available — skipping question: ${tool.args.question}`);
        continue;
      }
      warn(`  Hakster asks: ${tool.args.question}`);
      const answer = await new Promise(r => rl.question(C.cyan + '  your answer: ' + C.reset, r));
      resultMap.set(idx, `[ASK]: User answered: ${answer}`);
      continue;
    }

    if (tool.name === 'usb') {
      resultMap.set(idx, `[USB]: USB sync not available in standalone mode`);
      continue;
    }

    // For all other tools, use cliExecuteTool
    const cliName = nameMap[tool.name] || tool.name;
    const _t0 = Date.now();
    const result = await cliExecuteTool(cliName, tool.args, trustCfg);
    const elapsed = Date.now() - _t0;

    if (result.ok) {
      dim(`     ✓ ${elapsed}ms`);
    } else {
      // For edit failures, allow retry
      if (tool.name === 'edit' || tool.name === 'multi_edit') {
        executedActions.delete(hash);
      }
      warn(`     ✗ ${result.error || 'failed'} · ${elapsed}ms`);
    }

    resultMap.set(idx, result.ok ? result.output : `[${tool.name.toUpperCase()}]: ${result.error || 'failed'}`);
  }

  // Return results in original tool order
  const results = normalized.map((_, i) => resultMap.get(i) || '');
  return { results, actions: executedActions };
}

// ══════════════════════════════════════════════════════════════════════════
// ── Exports ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Core parsing/cleaning functions
  parseTools,
  stripTools,
  stripFences,
  stripHtmlArtifacts,
  isReasoningText,

  // Tool execution
  cliExecuteTool,
  execTools,

  // Tool definitions and schemas
  TOOL_DEFINITIONS,
  CLI_CLAUDE_TOOLS,

  // Tag mapping (for external reference)
  TAG_MAP,

  // Exposed helpers (useful for callers)
  runCmd,
  runCmdStream,
  resolveTaskPath,
  isTrusted,
  safeWrite,

  // Persistent shell instance (shared)
  pshell,
};
