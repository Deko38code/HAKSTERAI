/**
 * Media Studio — sandboxed media-only terminal agent.
 *
 * Runs Codex CLI or OMP inside a bubblewrap sandbox that can only see a
 * dedicated media workspace. Everything else on the host (project folders,
 * .env secrets, ~/.ssh, ~/.claude, mint-backup, pm2, tunnels) is not mounted.
 *
 * Engines are used headlessly:
 *   omp   -> omp -p --cwd <dir> --append-system-prompt <media role> <prompt>
 *   codex -> codex exec --skip-git-repo-check --ephemeral -s workspace-write ...
 *
 * The engine's own config files are re-mounted read-only on top of its state
 * directory so a run can keep session state but cannot rewrite model config.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MEDIA_ROOT = path.join(__dirname, '..', '..', 'data', 'media-studio');
const PROJECTS_DIR = path.join(MEDIA_ROOT, 'projects');
const EXPORTS_DIR = path.join(MEDIA_ROOT, 'exports');
const ASSETS_DIR = path.join(MEDIA_ROOT, 'assets');

const OMP_BIN = '/home/ghost/.local/bin/omp';
const CODEX_BIN = '/home/ghost/.local/bin/codex';
const BWRAP_BIN = '/usr/bin/bwrap';

const HOME = '/home/ghost';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

const MEDIA_SYSTEM_PROMPT = [
  'You are HaksterAI Media Studio, a sandboxed terminal agent.',
  'Your only job is media production: reels, shorts, videos, movie/trailer edits,',
  'and editing or regenerating images.',
  '',
  'Rules:',
  '- Work only inside the current working directory. It is the only writable place.',
  '- Use ffmpeg and ffprobe for all video/audio work. They are installed.',
  '- Produce real, playable output files (mp4, webm, gif, png, jpg, wav, mp3).',
  '- Never fabricate media, metrics, or claims. If a source clip or image is missing,',
  '  generate a clearly-labelled placeholder with ffmpeg and say so.',
  '- You have no internet browsing tools and no access to host projects or secrets.',
  '- Do not attempt to read anything outside the working directory.',
  '- Finish by listing every output file you created, with its relative path and duration/size.',
].join('\n');

const ENGINE_LABELS = { omp: 'OMP 17.4', codex: 'Codex CLI' };

function ensureDirs() {
  for (const dir of [MEDIA_ROOT, PROJECTS_DIR, EXPORTS_DIR, ASSETS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeProject(name) {
  const raw = String(name || '').trim().toLowerCase();
  const slug = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'untitled';
}

function projectDir(project) {
  const slug = safeProject(project);
  const dir = path.join(PROJECTS_DIR, slug);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  return { slug, dir };
}

function buildSandboxArgs({ engine, workspace }) {
  const engineCfg = [];
  if (engine === 'codex') {
    engineCfg.push(
      '--bind', path.join(HOME, '.codex'), path.join(HOME, '.codex'),
      '--ro-bind', path.join(HOME, '.codex', 'config.toml'), path.join(HOME, '.codex', 'config.toml'),
    );
  } else {
    engineCfg.push(
      '--bind', path.join(HOME, '.omp'), path.join(HOME, '.omp'),
      '--ro-bind', path.join(HOME, '.omp', 'agent', 'config.yml'), path.join(HOME, '.omp', 'agent', 'config.yml'),
      '--ro-bind', path.join(HOME, '.omp', 'agent', 'mcp.json'), path.join(HOME, '.omp', 'agent', 'mcp.json'),
    );
  }

  return [
    BWRAP_BIN,
    '--die-with-parent',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc',
    // /etc is readable for fonts/ld.so/ssl, but tunnel and key material stays hidden.
    ...(fs.existsSync('/etc/cloudflared') ? ['--tmpfs', '/etc/cloudflared'] : []),
    '--ro-bind', '/run', '/run',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--bind', MEDIA_ROOT, MEDIA_ROOT,
    '--ro-bind', path.join(HOME, '.local', 'bin'), path.join(HOME, '.local', 'bin'),
    ...engineCfg,
    '--clearenv',
    '--setenv', 'HOME', HOME,
    '--setenv', 'PATH', `${path.join(HOME, '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin`,
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'NO_COLOR', '1',
    '--setenv', 'TERM', 'dumb',
    '--chdir', workspace,
  ];
}

function engineArgs({ engine, prompt, workspace }) {
  if (engine === 'codex') {
    return [
      CODEX_BIN, 'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'workspace-write',
      '--config', 'mcp_servers={}',
      `${prompt}\n\nMEDIA STUDIO RULES:\n${MEDIA_SYSTEM_PROMPT}`,
    ];
  }
  return [
    OMP_BIN, '-p',
    '--cwd', workspace,
    '--append-system-prompt', MEDIA_SYSTEM_PROMPT,
    prompt,
  ];
}

function walkFiles(root, maxDepth = 3) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(full);
          out.push({
            path: path.relative(root, full),
            bytes: st.size,
            mtime: st.mtimeMs,
          });
        } catch {}
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Run a media task. Returns a promise resolving to a summary.
 * onEvent receives {type:'start'|'log'|'done'|'error', ...}
 */
function runMediaAgent({ engine = 'omp', prompt, project, timeoutMs, onEvent = () => {} }) {
  ensureDirs();
  const safeEngine = engine === 'codex' ? 'codex' : 'omp';
  const { slug, dir } = projectDir(project);
  const startedAt = Date.now();
  const before = new Set(walkFiles(dir).map(f => f.path));

  return new Promise((resolve) => {
    let settled = false;
    const args = [...buildSandboxArgs({ engine: safeEngine, workspace: dir }), ...engineArgs({ engine: safeEngine, prompt, workspace: dir })];

    let child;
    try {
      // stdin must be /dev/null: with an inherited pipe the engines block forever
      // in their startup "readPipedInput" phase waiting for EOF.
      child = spawn(args[0], args.slice(1), {
        cwd: dir,
        env: { PATH: '/usr/bin:/bin' },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      onEvent({ type: 'error', message: `Could not start sandbox: ${err.message}` });
      return resolve({ ok: false, error: err.message });
    }

    const limit = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 30000), MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      finish({ ok: false, error: `Timed out after ${Math.round(limit / 1000)}s` });
    }, limit);

    const emitLines = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) onEvent({ type: 'log', line });
      }
    };

    child.stdout.on('data', emitLines);
    child.stderr.on('data', emitLines);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const after = walkFiles(dir);
      const created = after.filter(f => !before.has(f.path));
      const summary = {
        ok: result.ok,
        error: result.error || null,
        engine: safeEngine,
        engineLabel: ENGINE_LABELS[safeEngine],
        project: slug,
        elapsedMs: Date.now() - startedAt,
        files: after,
        created,
      };
      try {
        const runsDir = path.join(dir, '.runs');
        fs.mkdirSync(runsDir, { recursive: true });
        fs.writeFileSync(
          path.join(runsDir, `${Date.now()}.json`),
          JSON.stringify({ ...summary, prompt: prompt.slice(0, 2000) }, null, 2),
        );
      } catch {}
      onEvent({ type: result.ok ? 'done' : 'error', ...summary });
      resolve(summary);
    };

    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.on('close', (code, signal) => {
      finish({ ok: code === 0, error: code === 0 ? null : `Agent exited with code ${code}${signal ? ` (${signal})` : ''}` });
    });

    onEvent({ type: 'start', engine: safeEngine, engineLabel: ENGINE_LABELS[safeEngine], project: slug, workspace: dir });
  });
}

function listProjects() {
  ensureDirs();
  return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      const dir = path.join(PROJECTS_DIR, e.name);
      const st = fs.statSync(dir);
      return { project: e.name, mtime: st.mtimeMs, files: walkFiles(dir, 1).length };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function listProjectFiles(project) {
  const { dir } = projectDir(project);
  return walkFiles(dir, 3).filter(f => !f.path.startsWith('.runs' + path.sep) && !f.path.startsWith('.runs/'));
}

function resolveProjectFile(project, relPath) {
  const { dir } = projectDir(project);
  const target = path.resolve(dir, String(relPath || ''));
  if (!target.startsWith(dir + path.sep)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  return target;
}

module.exports = {
  MEDIA_ROOT,
  PROJECTS_DIR,
  EXPORTS_DIR,
  ASSETS_DIR,
  MEDIA_SYSTEM_PROMPT,
  ENGINE_LABELS,
  runMediaAgent,
  listProjects,
  listProjectFiles,
  projectDir,
  resolveProjectFile,
  safeProject,
};
