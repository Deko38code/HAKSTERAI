#!/usr/bin/env node
/* Diagnose why freebuff PTY yields 0 bytes: dump spawn region + direct node-pty test. */
const fs = require("fs");
const APP = "/home/ghost694/workspace/dekekenneth840@gmail.com";
const SRC = APP + "/email-monitor-server.js";

const s = fs.readFileSync(SRC, "utf8");
const lines = s.split("\n");
console.log("=== CLI_BIN / FREEBUFF_BIN defs ===");
lines.forEach((l, i) => { if (/CLI_BIN|FREEBUFF_BIN|KIRO_BIN/.test(l) && /=/.test(l)) console.log("L" + (i + 1) + ": " + l.trim()); });

console.log("\n=== spawn region (940-975) ===");
for (let i = 939; i < Math.min(975, lines.length); i++) console.log("L" + (i + 1) + ": " + lines[i]);

// Direct node-pty test against freebuff
const path = require("path");
let pty;
for (const p of [APP + "/node_modules/node-pty", APP + "/omp-preview/node_modules/node-pty"]) {
  try { pty = require(p); console.log("\nnode-pty from " + p); break; } catch (e) {}
}
if (!pty) { console.log("\n!! node-pty not loadable"); process.exit(0); }

const bin = "/home/ghost694/.local/bin/freebuff";
const env = Object.assign({}, process.env);
delete env.TMUX; delete env.TMUX_PANE;
env.TERM = "xterm-256color"; env.COLORTERM = "truecolor";
env.HOME = "/home/ghost694";

let out = "";
try {
  const p = pty.spawn(bin, [], { name: "xterm-256color", cols: 120, rows: 32, cwd: "/tmp", env: env });
  p.onData((d) => {
    out += d;
    if (d.includes("\x1b[6n")) p.write("\x1b[1;1R");
    if (d.includes("\x1b[5n")) p.write("\x1b[0n");
    if (d.includes("\x1b[?2026$p")) p.write("\x1b[?2026;2$y");
    if (d.includes("\x1b[?2004$p")) p.write("\x1b[?2004;1$y");
    if (d.includes("\x1b[?1004$p")) p.write("\x1b[?1004;1$y");
  });
  p.onExit((e) => console.log("\nPTY EXIT code=" + e.exitCode + " bytes=" + out.length));
  setTimeout(() => {
    console.log("\n=== DIRECT PTY RESULT === bytes=" + out.length);
    console.log("first600=" + JSON.stringify(out.slice(0, 600)));
    try { p.kill(); } catch (e) {}
    process.exit(0);
  }, 9000);
} catch (e) {
  console.log("!! pty.spawn threw: " + e.message);
}
