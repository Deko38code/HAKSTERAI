#!/usr/bin/env node
/* Patch email-monitor-server.js so the dashboard xterm terminal can run freebuff. */
const fs = require("fs");
const F = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor-server.js";
let s = fs.readFileSync(F, "utf8");
const orig = s;
const log = [];

// 1. Freebuff binary constant next to the kiro one
if (!s.includes("FREEBUFF_BIN")) {
  const m = s.match(/^const\s+KIRO_CLI\s*=.*$/m);
  if (m) {
    s = s.replace(m[0], m[0] + '\nconst FREEBUFF_BIN = process.env.FREEBUFF_BIN || "/home/ghost694/.local/bin/freebuff";');
    log.push("added FREEBUFF_BIN");
  } else log.push("!! KIRO_CLI const not found");
}

// 2. In openKiroTerminal: pick CLI from ?cli= param
if (!s.includes("useFreebuff")) {
  const anchor = 'var homeId = u.searchParams.get("home") || "real";';
  if (s.includes(anchor)) {
    s = s.replace(anchor,
      'var homeId = u.searchParams.get("home") || "real";\n' +
      '  var useFreebuff = u.searchParams.get("cli") === "freebuff";\n' +
      '  var CLI_BIN = useFreebuff ? FREEBUFF_BIN : KIRO_CLI;');
    log.push("added cli selector");
  } else log.push("!! homeId anchor not found");
}

// 3. Existence check + spawn target use CLI_BIN
const before = s;
s = s.replace(/if \(!fs\.existsSync\(KIRO_CLI\)\) \{\s*try \{ ws\.close\(1011, "kiro-cli not installed"\); \} catch \(_\) \{\} return; \}/,
  'if (!fs.existsSync(CLI_BIN)) { try { ws.close(1011, (useFreebuff ? "freebuff" : "kiro-cli") + " not installed"); } catch (_) {} return; }');
if (s !== before) log.push("existsSync -> CLI_BIN"); else log.push("!! existsSync pattern not matched");

// 4. argv: freebuff takes no args
const b2 = s;
s = s.replace(/var argv = \[/g, 'var argv = useFreebuff ? [] : [');
if (s !== b2) log.push("argv override"); else log.push("!! argv pattern not matched");

// 5. spawn the chosen binary
const b3 = s;
s = s.replace(/pty\.spawn\(KIRO_CLI/g, 'pty.spawn(CLI_BIN');
if (s !== b3) log.push("pty.spawn -> CLI_BIN"); else log.push("!! pty.spawn(KIRO_CLI not matched");

if (s === orig) { console.log("NO CHANGES MADE\n" + log.join("\n")); process.exit(1); }
fs.writeFileSync(F, s);
console.log("PATCHED\n" + log.join("\n"));
