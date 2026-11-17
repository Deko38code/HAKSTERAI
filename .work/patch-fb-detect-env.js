#!/usr/bin/env node
/* Fix: (1) robust cli=freebuff detection, (2) strip tmux/tor fingerprints from PTY env. */
const fs = require("fs");
const F = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor-server.js";
let s = fs.readFileSync(F, "utf8");
const log = [];

// --- 1. Robust detection: match cli=freebuff anywhere in the query string
const detOld = 'var useFreebuff = u.searchParams.get("cli") === "freebuff";';
const detNew = 'var useFreebuff = /(?:^|[?&])cli=freebuff(?:&|$)/.test(u.search || "") || u.searchParams.get("cli") === "freebuff";';
if (s.includes(detOld)) { s = s.replace(detOld, detNew); log.push("OK robust cli detection"); }
else if (s.includes(detNew)) log.push("cli detection already robust");
else log.push("!! detection line not found");

// --- 2. Sanitize env for freebuff: remove tmux + terminal-identity + proxy/tor leaks
const anchor = 'var p = pty.spawn(argv[0], argv.slice(1),';
const idx = s.indexOf(anchor);
if (idx === -1) log.push("!! pty.spawn anchor missing");
else if (!s.includes("FB_ENV_SANITIZED")) {
  const inject =
    'if (useFreebuff) { /* FB_ENV_SANITIZED */\n' +
    '    delete env.TMUX; delete env.TMUX_PANE; delete env.TERM_PROGRAM;\n' +
    '    delete env.TERM_PROGRAM_VERSION; delete env.TERM_SESSION_ID;\n' +
    '    delete env.ITERM_SESSION_ID; delete env.WT_SESSION; delete env.VSCODE_INJECTION;\n' +
    '    delete env.STY; delete env.WINDOW; delete env.CI; delete env.CONTINUOUS_INTEGRATION;\n' +
    '    ["http_proxy","https_proxy","all_proxy","HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","TORSOCKS"].forEach(function(k){ delete env[k]; });\n' +
    '    env.TERM = "xterm-256color"; env.COLORTERM = "truecolor";\n' +
    '  }\n  ';
  s = s.slice(0, idx) + inject + s.slice(idx);
  log.push("OK env sanitized for freebuff");
} else log.push("env already sanitized");

fs.writeFileSync(F, s);
console.log(log.join("\n"));
