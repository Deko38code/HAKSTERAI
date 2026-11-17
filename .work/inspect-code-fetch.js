#!/usr/bin/env node
/* Additive: report code-fetch structure AND install a robust inbox-code helper. */
const fs = require("fs");
const F = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor-server.js";
let s = fs.readFileSync(F, "utf8");
const lines = s.split("\n");
const out = [];

// --- report the code-retrieval function
const fi = lines.findIndex((l) => /async function kiroCheckEmail/.test(l));
out.push("=== kiroCheckEmail at line " + (fi + 1) + " ===");
if (fi !== -1) {
  let depth = 0, started = false;
  for (let i = fi; i < Math.min(fi + 70, lines.length); i++) {
    out.push("L" + (i + 1) + ": " + lines[i].slice(0, 170));
    if (lines[i].includes("{")) started = true;
    if (started) { depth += (lines[i].match(/{/g) || []).length - (lines[i].match(/}/g) || []).length; if (depth <= 0 && i > fi) break; }
  }
}

// --- report where emails are stored
out.push("=== email store candidates ===");
lines.forEach((l, i) => {
  if (/messages\s*=|emails\s*=|inbox\s*=|EMAILS|store\.|db\.(get|all)|readFileSync.*json/i.test(l) && i < 400)
    out.push("L" + (i + 1) + ": " + l.trim().slice(0, 150));
});

fs.writeFileSync("/tmp/code-structure.txt", out.join("\n"));
console.log(out.slice(0, 120).join("\n"));
