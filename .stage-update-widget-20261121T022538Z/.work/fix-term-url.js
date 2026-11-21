#!/usr/bin/env node
/* Repair the terminal ws URL: keep home param intact, append cli cleanly. */
const fs = require("fs");
const F = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor/app.js";
let s = fs.readFileSync(F, "utf8");

// Current broken form (from the previous patch)
const broken = /`\/terminal\?home=&cli=\$\{window\.__CV_CLI \|\| 'kiro'\}`/;
if (broken.test(s)) {
  s = s.replace(broken, '"/terminal?home=" + encodeURIComponent(cliTerm.homeId || "real") + "&cli=" + (window.__CV_CLI || "kiro")');
  console.log("OK repaired broken URL form");
} else {
  // generic repair: any /terminal?home= literal -> proper concat
  const re = /["'`]\/terminal\?home=(["'`])\s*\+\s*encodeURIComponent\(cliTerm\.homeId \|\| "real"\)/;
  if (re.test(s)) {
    s = s.replace(re, '"/terminal?home=" + encodeURIComponent(cliTerm.homeId || "real") + "&cli=" + (window.__CV_CLI || "kiro")');
    console.log("OK repaired via generic form");
  } else if (s.includes('"&cli=" + (window.__CV_CLI')) {
    console.log("already correct");
  } else {
    console.log("!! no recognizable terminal URL form");
    s.split("\n").forEach((l, i) => { if (/\/terminal\?home=/.test(l)) console.log("L" + (i + 1) + ": " + l.trim()); });
    process.exit(1);
  }
}

// expose reconnect hook so the Kiro/Freebuff toggle restarts the PTY
if (!s.includes("__cvReconnectTerm = openCliTerminal")) {
  const m = s.match(/^function openCliTerminal\(\) \{/m);
  if (m) {
    s = s.replace(/^function openCliTerminal\(\) \{/m,
      "function openCliTerminal() {");
    s = s.replace(/^function openCliTerminal\(\) \{/m,
      "window.__cvReconnectTerm = function(){ try { openCliTerminal(); } catch(_){} };\nfunction openCliTerminal() {");
    console.log("OK reconnect hook exposed");
  } else console.log("!! openCliTerminal not found");
} else console.log("reconnect hook already present");

fs.writeFileSync(F, s);
