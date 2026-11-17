#!/usr/bin/env node
/* Second pass: fix argv + pty.spawn generically. Prints what it finds. */
const fs = require("fs");
const F = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor-server.js";
let s = fs.readFileSync(F, "utf8");
const log = [];

// Show the relevant region for diagnosis
const idx = s.indexOf("function openKiroTerminal");
const region = s.slice(idx, idx + 3000);
const lines = region.split("\n");
lines.forEach((l, i) => {
  if (/argv|pty\.spawn|KIRO_CLI|CLI_BIN|useFreebuff/.test(l)) log.push("L" + i + ": " + l.trim().slice(0, 160));
});

// --- argv: match "argv" declaration of any form
const argvRe = /(\bvar\s+argv\s*=\s*)([^;]+);/;
const am = s.match(argvRe);
if (am) {
  if (!am[2].includes("useFreebuff")) {
    s = s.replace(argvRe, (m0, p1, p2) => p1 + "useFreebuff ? [] : (" + p2 + ");");
    log.push("OK argv wrapped");
  } else log.push("argv already ok");
} else log.push("!! no argv decl found");

// --- pty.spawn: match any spawn call inside the function
const spawnRe = /(pty\.spawn\(\s*)([A-Za-z_$][\w$]*)/;
const sm = s.match(spawnRe);
if (sm) {
  if (sm[2] !== "CLI_BIN") {
    s = s.replace(spawnRe, "$1CLI_BIN");
    log.push("OK pty.spawn -> CLI_BIN (was " + sm[2] + ")");
  } else log.push("pty.spawn already CLI_BIN");
} else log.push("!! no pty.spawn found");

fs.writeFileSync(F, s);
console.log(log.join("\n"));
