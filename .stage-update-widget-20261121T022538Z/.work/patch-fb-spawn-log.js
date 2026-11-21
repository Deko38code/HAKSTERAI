#!/usr/bin/env node
/* Make the terminal spawn path observable + robust: log binary, catch spawn errors, forward them. */
const fs = require("fs");
const F = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor-server.js";
let s = fs.readFileSync(F, "utf8");
const log = [];

const lines = s.split("\n");
const si = lines.findIndex((l) => l.includes("pty.spawn(CLI_BIN"));
if (si === -1) { console.log("!! spawn line missing"); process.exit(1); }
const indent = (lines[si].match(/^[ \t]*/) || [""])[0];

if (!s.includes("FB_SPAWN_LOG")) {
  const pre = [
    indent + "/* FB_SPAWN_LOG */",
    indent + "try { console.log('[term] cli=' + (useFreebuff?'freebuff':'kiro') + ' bin=' + CLI_BIN + ' argv=' + JSON.stringify(argv) + ' cwd=' + cwd); } catch(_) {}",
    indent + "try { require('fs').appendFileSync('/tmp/em-term.log', new Date().toISOString()+' cli='+(useFreebuff?'freebuff':'kiro')+' bin='+CLI_BIN+' argv='+JSON.stringify(argv)+'\\n'); } catch(_) {}",
  ];
  lines.splice(si, 0, ...pre);
  s = lines.join("\n");
  log.push("OK spawn logging added before line " + (si + 1));
} else log.push("spawn logging already present");

// Wrap the spawn in try/catch so failures reach the websocket instead of dying silently
const spawnLineRe = /^([ \t]*)var p = pty\.spawn\(CLI_BIN, argv\.slice\(1\), \{[^}]*\}\);[ \t]*$/m;
const m = s.match(spawnLineRe);
if (m && !s.includes("FB_SPAWN_GUARD")) {
  const ind = m[1];
  const guarded =
    ind + "/* FB_SPAWN_GUARD */\n" +
    ind + "var p;\n" +
    ind + "try {\n" +
    ind + "  p = pty.spawn(CLI_BIN, argv.slice(1), { name: \"xterm-256color\", cols: cols, rows: rows, cwd: cwd, env: env });\n" +
    ind + "} catch (e) {\n" +
    ind + "  try { console.log('[term] spawn failed: ' + e.message); } catch(_) {}\n" +
    ind + "  try { ws.send(JSON.stringify({ t: \"o\", d: \"\\r\\n[spawn failed] \" + e.message + \"\\r\\n\" })); } catch(_) {}\n" +
    ind + "  try { ws.close(1011, \"spawn failed\"); } catch(_) {}\n" +
    ind + "  return;\n" +
    ind + "}";
  s = s.replace(spawnLineRe, guarded);
  log.push("OK spawn guarded with try/catch");
} else if (s.includes("FB_SPAWN_GUARD")) log.push("spawn already guarded");
else log.push("!! spawn statement did not match for guarding");

fs.writeFileSync(F, s);
console.log(log.join("\n"));
