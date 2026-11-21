#!/usr/bin/env node
/* Set the argv fallback to freebuff when cli=freebuff. */
const fs = require("fs");
const F = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor-server.js";
let s = fs.readFileSync(F, "utf8");

if (s.includes("FREE_OVERRIDE_OK")) { console.log("already patched"); process.exit(0); }

const old = '  if (!argv.length) argv = ["kiro-wrapper"];';
if (!s.includes(old)) {
  console.log("!! exact fallback line missing");
  s.split("\n").forEach((l, i) => { if (/kiro-wrapper/.test(l)) console.log("L" + (i + 1) + ": " + JSON.stringify(l)); });
  process.exit(1);
}
s = s.replace(old, '  if (!argv.length) argv = [useFreebuff ? FREEBUFF_BIN : "kiro-wrapper"]; /* FREE_OVERRIDE_OK */');
fs.writeFileSync(F, s);
console.log("OK fallback -> freebuff when cli=freebuff");
