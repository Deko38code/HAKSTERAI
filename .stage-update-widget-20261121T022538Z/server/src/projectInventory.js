'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PROJECTS = [
  { name: 'haksterAi', path: '/home/ghost/haksterAi', desc: 'AI agent platform, CLI, web API on port 3579, PM2 process haksterAi' },
  { name: 'CineVault live', path: '/home/ghost/cine-vault-live', desc: 'IPTV/movie streaming platform, Express/JS app, PM2 process cinevault' },
  { name: 'CineVault movie site', path: '/home/ghost/cine-vault-movie-site', desc: 'alternate/local CineVault movie site copy' },
  { name: 'Hakster cloud app', path: '/home/ghost/hakster-cloud', desc: 'Hakster cloud project if present' },
  { name: 'PhantomIDE', path: '/home/ghost/phantom-ide', desc: 'Phantom IDE project if present' },
  { name: 'movie-server', path: '/home/ghost/movie-server', desc: 'movie server/source resolver if present' },
  { name: 'kiro-gateway', path: '/home/ghost/kiro-gateway', desc: 'Kiro gateway, FastAPI if present' },
  { name: 'bugbounty', path: '/home/ghost/bugbounty', desc: 'bug bounty tooling and reports if present' },
  { name: 'Agent skills', path: '/home/ghost/.agents', desc: 'local agent skills and skill bundles' },
  { name: 'Hakster skills', path: '/home/ghost/haksterAi/.hakster/skills', desc: 'HaksterAI runtime skills' },
];

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.astro', 'coverage', '.cache',
  '__pycache__', 'vendor', 'data', 'logs', 'tmp', 'outputs', '.firecrawl',
]);

const CODE_EXTS = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.astro', '.py', '.sh', '.css',
  '.json', '.md', '.html', '.yml', '.yaml',
]);

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 60 * 1000;

function safeRead(file, maxBytes = 240000) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return '';
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return '';
  }
}

function readJson(file) {
  const raw = safeRead(file, 500000);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function walkFiles(root, opts = {}) {
  const maxFiles = opts.maxFiles || 700;
  const maxDepth = opts.maxDepth || 5;
  const out = [];

  function walk(dir, depth) {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.name.startsWith('.') && !['.env.example', '.hakster'].includes(entry.name)) continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!CODE_EXTS.has(ext)) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.size > 800000) continue;
        out.push(full);
      } catch (_) {}
    }
  }

  walk(root, 0);
  return out;
}

function detectTech(root, pkg) {
  const tech = [];
  if (pkg) {
    tech.push('Node');
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const name of ['astro', 'express', 'react', 'vite', 'tailwindcss', 'better-sqlite3', 'sqlite3']) {
      if (deps[name]) tech.push(name);
    }
  }
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt'))) tech.push('Python');
  if (fs.existsSync(path.join(root, 'Dockerfile')) || fs.existsSync(path.join(root, 'docker-compose.yml'))) tech.push('Docker');
  return Array.from(new Set(tech));
}

function addAnchor(anchors, root, file, line, kind, name) {
  if (!name || anchors.length >= 180) return;
  anchors.push({
    file: path.relative(root, file) || path.basename(file),
    line,
    kind,
    name: String(name).slice(0, 120),
  });
}

function extractAnchors(root, file) {
  const ext = path.extname(file).toLowerCase();
  const rel = path.relative(root, file);
  const content = safeRead(file, 350000);
  if (!content) return [];
  const lines = content.split('\n');
  const anchors = [];

  if (/(^|\/)(pages|routes|api)\//.test(rel) || /\.(astro|html)$/.test(rel)) {
    addAnchor(anchors, root, file, 1, 'file', rel);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/\bapp\.(get|post|put|patch|delete|use)\s*\(\s*['"`]([^'"`]+)['"`]/))) {
      addAnchor(anchors, root, file, i + 1, 'route', `${m[1].toUpperCase()} ${m[2]}`);
    }
    if ((m = line.match(/\brouter\.(get|post|put|patch|delete|use)\s*\(\s*['"`]([^'"`]+)['"`]/))) {
      addAnchor(anchors, root, file, i + 1, 'route', `${m[1].toUpperCase()} ${m[2]}`);
    }
    if ((m = line.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/))) {
      addAnchor(anchors, root, file, i + 1, 'function', m[1]);
    }
    if ((m = line.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/))) {
      addAnchor(anchors, root, file, i + 1, 'function', m[1]);
    }
    if ((m = line.match(/\bclass\s+([A-Za-z_$][\w$]*)\b/))) {
      addAnchor(anchors, root, file, i + 1, 'class', m[1]);
    }
    if ((m = line.match(/\bmodule\.exports\s*=\s*([A-Za-z_$][\w$]*)/))) {
      addAnchor(anchors, root, file, i + 1, 'export', m[1]);
    }
    if ((m = line.match(/\bexports\.([A-Za-z_$][\w$]*)\s*=/))) {
      addAnchor(anchors, root, file, i + 1, 'export', m[1]);
    }
    if ((m = line.match(/\bexport\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/))) {
      addAnchor(anchors, root, file, i + 1, 'export', m[1]);
    }
    if (ext === '.py' && (m = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/))) {
      addAnchor(anchors, root, file, i + 1, 'function', m[1]);
    }
    if (ext === '.py' && (m = line.match(/^\s*class\s+([A-Za-z_]\w*)\b/))) {
      addAnchor(anchors, root, file, i + 1, 'class', m[1]);
    }
  }
  return anchors;
}

function summarizeProject(project) {
  const root = project.path;
  const exists = fs.existsSync(root);
  const summary = {
    name: project.name,
    path: root,
    desc: project.desc,
    exists,
    tech: [],
    scripts: {},
    entrypoints: [],
    keyFiles: [],
    anchors: [],
    fileCountSampled: 0,
  };
  if (!exists) return summary;

  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg) {
    summary.packageName = pkg.name;
    summary.scripts = pkg.scripts || {};
  }
  summary.tech = detectTech(root, pkg);

  const keyCandidates = [
    'package.json', 'server.js', 'index.js', 'src/index.js', 'server/src/index.js',
    'cli/index.js', 'astro.config.mjs', 'vite.config.js', 'README.md', 'AGENTS.md',
    'pyproject.toml', 'requirements.txt', 'app.py', 'main.py',
  ];
  for (const rel of keyCandidates) {
    if (fs.existsSync(path.join(root, rel))) summary.keyFiles.push(rel);
  }

  const files = walkFiles(root);
  summary.fileCountSampled = files.length;
  for (const file of files) {
    const rel = path.relative(root, file);
    if (
      summary.keyFiles.includes(rel) ||
      /(^|\/)(server|src|cli|routes|pages|api)\//.test(rel) ||
      /\.(astro|py)$/.test(rel)
    ) {
      summary.anchors.push(...extractAnchors(root, file));
    }
    if (summary.anchors.length >= 220) break;
  }

  summary.entrypoints = summary.anchors
    .filter(a => ['route', 'file', 'export'].includes(a.kind))
    .slice(0, 30);
  summary.anchors = summary.anchors.slice(0, 220);
  return summary;
}

function getProjectInventory(options = {}) {
  const now = Date.now();
  if (!options.refresh && _cache && now - _cacheAt < CACHE_MS) return _cache;
  const projects = DEFAULT_PROJECTS.map(summarizeProject).filter(p => p.exists);
  _cache = { generatedAt: new Date().toISOString(), projects };
  _cacheAt = now;
  return _cache;
}

function formatProjectInventory(options = {}) {
  const inventory = getProjectInventory(options);
  const maxProjects = options.maxProjects || 10;
  const lines = [`Project inventory generated ${inventory.generatedAt}`];
  for (const p of inventory.projects.slice(0, maxProjects)) {
    const scripts = Object.keys(p.scripts || {}).slice(0, 8).join(', ') || 'none';
    const keyFiles = p.keyFiles.slice(0, 10).join(', ') || 'none';
    const tech = p.tech.join(', ') || 'unknown';
    const anchors = p.entrypoints.slice(0, 8).map(a => `${a.file}:${a.line} ${a.kind} ${a.name}`).join('; ') || 'none';
    lines.push(`- ${p.name}: ${p.path}`);
    lines.push(`  desc: ${p.desc}`);
    lines.push(`  tech: ${tech}; scripts: ${scripts}`);
    lines.push(`  key files: ${keyFiles}`);
    lines.push(`  anchors: ${anchors}`);
  }
  return lines.join('\n');
}

function formatCodebaseIndex(options = {}) {
  const inventory = getProjectInventory({ refresh: options.refresh });
  const q = String(options.project || options.query || '').toLowerCase();
  const maxAnchors = options.maxAnchors || 120;
  const projects = q
    ? inventory.projects.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        p.desc.toLowerCase().includes(q)
      )
    : inventory.projects;

  if (projects.length === 0) return `No indexed project matched "${q}".`;
  const lines = [`Codebase line index (${inventory.generatedAt})`];
  for (const p of projects) {
    lines.push(`\n## ${p.name} — ${p.path}`);
    lines.push(`tech: ${p.tech.join(', ') || 'unknown'}`);
    lines.push(`key files: ${p.keyFiles.join(', ') || 'none'}`);
    const anchors = p.anchors.slice(0, maxAnchors);
    if (anchors.length === 0) {
      lines.push('anchors: none indexed');
    } else {
      for (const a of anchors) lines.push(`${p.path}/${a.file}:${a.line} [${a.kind}] ${a.name}`);
      if (p.anchors.length > anchors.length) lines.push(`... ${p.anchors.length - anchors.length} more anchors; call codebase_index with a narrower project/query.`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_PROJECTS,
  getProjectInventory,
  formatProjectInventory,
  formatCodebaseIndex,
};
