#!/usr/bin/env node
/* Final pass: when cli=freebuff, override argv to the freebuff binary. */
const fs = require("fs");
const F = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor-server.js";
let s = fs.readFileSync(F, "utf8");
const log = [];

if (s.includes("FREE_OVERRIDE_OK")) {
  console.log("already patched");
  process.exit(0);
}

const anchor = "var argv = parseArgs(line);";
if (!s.includes(anchor)) { console.log("!! anchor missing"); process.exit(1); }

s = s.replace(anchor,
  anchor + "\n  if (useFreebuff) { argv = [FREEBUFF_BIN]; } /* FREE_OVERRIDE_OK */");

// also drop the stale existsSync guard if it still says kiro-only semantics (it uses CLI_BIN already, fine)
fs.writeFileSync(F, s);
log.push("OK argv override for freebuff");
console.log(log.join("\n"));
