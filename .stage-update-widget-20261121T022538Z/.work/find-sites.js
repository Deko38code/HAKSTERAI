#!/usr/bin/env node
/* Find the real call site + page creation, then patch both. */
const fs = require("fs");
const F = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor-server.js";
let s = fs.readFileSync(F, "utf8");
const out = [];

/* --- report every reference to kiroCheckEmailCode --- */
out.push("=== kiroCheckEmailCode references ===");
s.split("\n").forEach((l, i) => {
  if (l.includes("kiroCheckEmailCode")) out.push("L" + (i + 1) + ": " + l.trim().slice(0, 190));
});

/* --- report page creation --- */
out.push("=== page creation ===");
s.split("\n").forEach((l, i) => {
  if (/newPage\(\)|newContext\(|launch\(/.test(l)) out.push("L" + (i + 1) + ": " + l.trim().slice(0, 190));
});

fs.writeFileSync("/tmp/sites.txt", out.join("\n"));
console.log(out.join("\n"));
