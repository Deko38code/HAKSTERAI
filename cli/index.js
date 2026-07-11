#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

const pkg = require('./package.json');
const { showIntro, C } = require('./logo');

// Show intro on every launch
showIntro(pkg.version);

// ── Config ────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), '.hakster');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  console.log(`Config saved to ${CONFIG_FILE}`);
}

function getConfig() {
  const cfg = loadConfig();
  if (!cfg.server) {
    console.error('No server configured. Run: hakster config set server http://your-server:3579');
    process.exit(1);
  }
  return cfg;
}

// ── HTTP helper ───────────────────────────────────────────────────
function fetchUrl(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method, headers }, (res) => {
      if (res.statusCode >= 400) {
        let errBody = '';
        res.on('data', (d) => (errBody += d));
        res.on('end', () => reject(new Error(`${res.statusCode} ${errBody || res.statusMessage}`)));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchJson(url, opts) {
  const res = await fetchUrl(url, opts);
  let data = '';
  for await (const chunk of res) data += chunk;
  return JSON.parse(data);
}

// ── Commands ──────────────────────────────────────────────────────

const program = new Command();

program
  .name('hakster')
  .description('haksterAi CLI — manage files, sessions, and agent interactions from the terminal')
  .version(pkg.version);

// ── config ────────────────────────────────────────────────────────
const configCmd = program.command('config').description('Manage CLI configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a config value (e.g. server URL)')
  .action((key, value) => {
    const cfg = loadConfig();
    cfg[key] = value;
    saveConfig(cfg);
  });

configCmd
  .command('get <key>')
  .description('Get a config value')
  .action((key) => {
    const cfg = loadConfig();
    console.log(cfg[key] || '(not set)');
  });

configCmd
  .command('list')
  .description('Show all config')
  .action(() => {
    const cfg = loadConfig();
    if (Object.keys(cfg).length === 0) {
      console.log('(empty — run: hakster config set server http://your-server:3579)');
    } else {
      for (const [k, v] of Object.entries(cfg)) console.log(`${k} = ${v}`);
    }
  });

// ── ls ────────────────────────────────────────────────────────────
program
  .command('ls [path]')
  .description('List files in server workspace')
  .action(async (dirPath = '/') => {
    const { server } = getConfig();
    try {
      const data = await fetchJson(`${server}/api/fs/list?path=${encodeURIComponent(dirPath)}`);
      if (Array.isArray(data)) {
        for (const item of data) {
          const type = item.type === 'dir' ? 'd' : 'f';
          const size = item.size ? String(item.size).padStart(8) : '       -';
          console.log(`${type} ${size}  ${item.name}`);
        }
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
  });

// ── download ──────────────────────────────────────────────────────
program
  .command('download <path>')
  .description('Download a file from the server')
  .option('-o, --output <file>', 'Save to specific file path')
  .action(async (filePath, opts) => {
    const { server } = getConfig();
    try {
      const res = await fetchUrl(`${server}/api/fs/download?path=${encodeURIComponent(filePath)}`);
      const fileName = opts.output || path.basename(filePath);
      const outPath = path.resolve(fileName);
      const writeStream = fs.createWriteStream(outPath);
      res.pipe(writeStream);
      writeStream.on('finish', () => {
        const size = fs.statSync(outPath).size;
        console.log(`Downloaded ${fileName} (${size} bytes) -> ${outPath}`);
      });
      writeStream.on('error', (err) => console.error(`Write error: ${err.message}`));
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
  });

// ── health ────────────────────────────────────────────────────────
program
  .command('health')
  .description('Check if server is online')
  .action(async () => {
    const { server } = getConfig();
    try {
      const data = await fetchJson(`${server}/api/health`);
      console.log(`Server: ${server}`);
      console.log(`Status: ${data.status}`);
      console.log(`Providers: ${(data.providers || []).join(', ')}`);
    } catch (err) {
      console.error(`Server unreachable: ${err.message}`);
      process.exit(1);
    }
  });

// ── status ────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show CLI config and server connection status')
  .action(async () => {
    const cfg = loadConfig();
    console.log('Config:');
    if (Object.keys(cfg).length === 0) {
      console.log('  (empty — run: hakster config set server http://your-server:3579)');
    } else {
      for (const [k, v] of Object.entries(cfg)) console.log(`  ${k} = ${v}`);
    }
    if (cfg.server) {
      try {
        const data = await fetchJson(`${cfg.server}/api/health`);
        console.log(`\nServer: ${cfg.server}`);
        console.log(`Status: ${data.status}`);
      } catch {
        console.log(`\nServer: ${cfg.server} (unreachable)`);
      }
    }
  });

// ── guardian ──────────────────────────────────────────────────────
program
  .command('guardian [args...]')
  .description('Run Guardian pentest CLI commands (scan, recon, analyze, report, workflow)')
  .option('-t, --timeout <ms>', 'Timeout in ms (default 120000)')
  .allowUnknownOption()
  .action(async (args, opts) => {
    const { execFileSync } = require('child_process');
    const wrapper = '/home/ghost/.local/bin/guardian-wrapper';
    if (!fs.existsSync(wrapper)) {
      console.error('guardian-wrapper not found. Install guardian-cli first.');
      process.exit(1);
    }
    const timeout = parseInt(opts.timeout || '120000', 10);
    const cmdArgs = args.join(' ');
    if (!cmdArgs) {
      console.log('Usage: hakster guardian <command> [options]');
      console.log('');
      console.log('Commands:');
      console.log('  init         Initialize Guardian configuration');
      console.log('  scan         Quick port scan using Nmap (e.g. scan --target 10.10.10.1)');
      console.log('  recon        Run reconnaissance workflow (e.g. recon --target example.com)');
      console.log('  analyze      Analyze scan results using AI');
      console.log('  report       Generate penetration testing report');
      console.log('  workflow     Run or list pentest workflows');
      console.log('  ai           Explain AI decisions and reasoning');
      console.log('  models       List available AI models');
      console.log('  version      Show Guardian version');
      console.log('  kb           Knowledge base maintenance');
      console.log('');
      console.log('Examples:');
      console.log('  hakster guardian scan --target 10.10.10.1');
      console.log('  hakster guardian recon --target example.com');
      console.log('  hakster guardian workflow --list');
      console.log('  hakster guardian report --format html');
      return;
    }
    try {
      const output = execFileSync(wrapper, args, {
        encoding: 'utf8',
        timeout,
        maxBuffer: 6 * 1024 * 1024,
        env: { ...process.env, CI: '1' },
      });
      console.log(output);
    } catch (err) {
      if (err.killed) {
        console.error(`Guardian timed out after ${timeout}ms`);
      } else {
        const stdout = (err.stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
        const stderr = (err.stderr || '').replace(/\x1b\[[0-9;]*m/g, '');
        if (stdout) console.log(stdout);
        if (stderr) console.error(stderr);
        if (!stdout && !stderr) console.error(`Guardian error: ${err.message}`);
      }
      process.exit(err.status || 1);
    }
  });

program.parse();