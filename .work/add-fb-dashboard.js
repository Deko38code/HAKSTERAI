#!/usr/bin/env node
/* Add a Freebuff terminal entry to the dashboard, and report terminal wiring. */
const fs = require("fs");
const path = require("path");
const APP = "/home/ghost694/workspace/dekekenneth840@gmail.com";

for (const name of ["index.html", "dashboard.html"]) {
  const F = path.join(APP, name);
  if (!fs.existsSync(F)) continue;
  let s = fs.readFileSync(F, "utf8");

  console.log("=== " + name + " ===");
  const hits = s.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /terminal\?|kiro|openTerminal|xterm/i.test(l));
  hits.slice(0, 12).forEach(([n, l]) => console.log("L" + n + ": " + l.trim().slice(0, 150)));

  if (!s.includes("cli=freebuff")) {
    // find an existing terminal link/button to clone
    const m = s.match(/<[^>]*(?:terminal\?|openTerminal)[^>]*>/i);
    if (m) {
      const clone = m[0]
        .replace(/home=[^&"']*/i, "home=real")
        .replace(/cli=[^&"']*/i, "");
      let btn = clone;
      if (/href=/.test(btn)) {
        btn = btn.replace(/href="([^"]*)"/, (x, u) => 'href="' + u.split("?")[0] + "?cli=freebuff&home=real" + '"');
      } else if (/onclick=/.test(btn)) {
        btn = btn.replace(/onclick="([^"]*)"/, (x, js) => 'onclick="' + js + '"');
      }
      btn = btn.replace(/<([a-z]+)/i, "<$1 style=\"margin-left:8px\"");
      const label = '<a href="/terminal.html?cli=freebuff&home=real" target="_blank" class="btn" style="margin-left:8px;text-decoration:none">Freebuff CLI</a>';
      // insert after the matched element
      s = s.replace(m[0], m[0] + "\n" + label);
      fs.writeFileSync(F, s);
      console.log(">> ADDED Freebuff CLI button after: " + m[0].trim().slice(0, 100));
    } else {
      console.log(">> no terminal anchor found to clone");
    }
  } else console.log(">> freebuff link already present");
}
