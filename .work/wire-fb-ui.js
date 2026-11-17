#!/usr/bin/env node
/* Wire a Freebuff CLI toggle into the email-monitor dashboard terminal. */
const fs = require("fs");
const path = require("path");
const APP = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor";
const log = [];

// ---------- 1. app.js : find terminal websocket construction ----------
const appJs = path.join(APP, "app.js");
let a = fs.readFileSync(appJs, "utf8");
const termLines = a.split("\n").map((l, i) => [i + 1, l])
  .filter(([, l]) => /\/terminal|WebSocket\(|ws:\/\/|wss:\/\//.test(l));
log.push("=== app.js terminal lines ===");
termLines.slice(0, 15).forEach(([n, l]) => log.push("L" + n + ": " + l.trim().slice(0, 170)));

if (!a.includes("FREEBUFF_SELECTOR")) {
  // find the ws url build
  const m = a.match(/((?:var|let|const)\s+\w*(?:term|ws)\w*\s*=\s*new\s+WebSocket\([^)]*\))/i);
  if (m) {
    log.push("FOUND WS: " + m[1].slice(0, 200));
  } else {
    const m2 = a.match(/new\s+WebSocket\(([^)]*)\)/);
    if (m2) log.push("FOUND WS URL EXPR: " + m2[1].slice(0, 200));
  }
  // detect the url expression referencing /terminal
  const urlMatch = a.match(/["'`]([^"'`]*\/terminal[^"'`]*)["'`]/);
  if (urlMatch) {
    log.push("TERMINAL URL LITERAL: " + urlMatch[1]);
    const orig = urlMatch[1];
    let patched = orig;
    if (!/cli=/.test(patched)) {
      patched = patched + (patched.includes("?") ? "&" : "?") + "cli=";
      // append the selector expression
      a = a.replace(urlMatch[0], "`" + patched + "${window.__CV_CLI || 'kiro'}`");
      fs.writeFileSync(appJs, a);
      log.push("OK app.js terminal url now carries cli= selector");
    } else {
      log.push("app.js url already has cli=");
    }
  }
} else log.push("app.js already patched");

// ---------- 2. index.html : add the toggle ----------
const idxF = path.join(APP, "index.html");
let h = fs.readFileSync(idxF, "utf8");
if (!h.includes("FREEBUFF_TOGGLE")) {
  const btn = `
<div id="cli-switch" style="position:fixed;top:8px;right:8px;z-index:99999;display:flex;gap:6px;font:12px/1.4 system-ui">
  <button id="cli-kiro" class="cli-btn">Kiro</button>
  <button id="cli-freebuff" class="cli-btn">Freebuff</button>
</div>
<style>
.cli-btn{background:#1b1f24;color:#c8d1d9;border:1px solid #30363d;border-radius:6px;padding:5px 11px;cursor:pointer}
.cli-btn.on{background:#238636;border-color:#2ea043;color:#fff;font-weight:600}
</style>
<script>
/* FREEBUFF_TOGGLE */
window.__CV_CLI = localStorage.getItem('cv_cli') || 'kiro';
function paintCli(){
  var k=document.getElementById('cli-kiro'), f=document.getElementById('cli-freebuff');
  if(!k||!f) return;
  k.classList.toggle('on', window.__CV_CLI!=='freebuff');
  f.classList.toggle('on', window.__CV_CLI==='freebuff');
}
document.addEventListener('DOMContentLoaded', function(){
  paintCli();
  var k=document.getElementById('cli-kiro'), f=document.getElementById('cli-freebuff');
  if(k) k.onclick=function(){ window.__CV_CLI='kiro'; localStorage.setItem('cv_cli','kiro'); paintCli(); if(window.__cvReconnectTerm) window.__cvReconnectTerm(); };
  if(f) f.onclick=function(){ window.__CV_CLI='freebuff'; localStorage.setItem('cv_cli','freebuff'); paintCli(); if(window.__cvReconnectTerm) window.__cvReconnectTerm(); };
});
</script>`;
  h = h.replace(/<\/body>/i, btn + "\n</body>");
  fs.writeFileSync(idxF, h);
  log.push("OK index.html toggle added");
} else log.push("index.html toggle already present");

console.log(log.join("\n"));
