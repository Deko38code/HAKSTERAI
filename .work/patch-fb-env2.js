#!/usr/bin/env node
/* Inject tmux/tor env sanitization right before the actual pty.spawn line. */
const fs = require("fs");
const F = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor-server.js";
let s = fs.readFileSync(F, "utf8");

if (s.includes("FB_ENV_SANITIZED")) { console.log("already sanitized"); process.exit(0); }

const lines = s.split("\n");
const i = lines.findIndex((l) => l.includes("pty.spawn(CLI_BIN"));
if (i === -1) { console.log("!! pty.spawn(CLI_BIN line not found"); process.exit(1); }

const indent = (lines[i].match(/^[ \t]*/) || [""])[0];
const inject = [
  indent + "if (useFreebuff) { /* FB_ENV_SANITIZED */",
  indent + "  delete env.TMUX; delete env.TMUX_PANE; delete env.TERM_PROGRAM;",
  indent + "  delete env.TERM_PROGRAM_VERSION; delete env.TERM_SESSION_ID;",
  indent + "  delete env.ITERM_SESSION_ID; delete env.WT_SESSION; delete env.VSCODE_INJECTION;",
  indent + "  delete env.STY; delete env.WINDOW; delete env.CI; delete env.CONTINUOUS_INTEGRATION;",
  indent + "  delete env.TORSOCKS; delete env.TOR_SOCKS_PORT; delete env.TOR_PROXY;",
  indent + "  [\"http_proxy\",\"https_proxy\",\"all_proxy\",\"HTTP_PROXY\",\"HTTPS_PROXY\",\"ALL_PROXY\"].forEach(function(k){ delete env[k]; });",
  indent + "  env.TERM = \"xterm-256color\"; env.COLORTERM = \"truecolor\";",
  indent + "}",
];
lines.splice(i, 0, ...inject);
fs.writeFileSync(F, lines.join("\n"));
console.log("OK env sanitized before pty.spawn (line " + (i + 1) + ")");
