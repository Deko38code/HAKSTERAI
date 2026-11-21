#!/usr/bin/env node
/* Regex-tolerant: override argv when cli=freebuff. */
const fs = require("fs");
const F = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor-server.js";
let s = fs.readFileSync(F, "utf8");

if (s.includes("FREE_OVERRIDE_OK")) { console.log("already patched"); process.exit(0); }

// find the parseArgs line, whatever its exact punctuation
const re = /^([ \t]*)(var|let|const)[ \t]+argv[ \t]*=[ \t]*parseArgs\([^)]*\)[ \t]*;?[ \t]*$/m;
const m = s.match(re);
if (!m) {
  console.log("!! parseArgs line not found. Nearby candidates:");
  s.split("\n").forEach((l, i) => { if (/parseArgs|argv\s*=/.test(l)) console.log("L" + (i + 1) + ": " + JSON.stringify(l)); });
  process.exit(1);
}
console.log("found: " + JSON.stringify(m[0]));

s = s.replace(re, m[0] + "\n" + m[1] + "if (useFreebuff) { argv = [FREEBUFF_BIN]; } /* FREE_OVERRIDE_OK */");
fs.writeFileSync(F, s);
console.log("OK argv override added");
