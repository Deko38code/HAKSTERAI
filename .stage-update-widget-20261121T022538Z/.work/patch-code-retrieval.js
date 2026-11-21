#!/usr/bin/env node
/* Robust Gmail code retrieval + stealth, additive & syntax-safe. */
const fs = require("fs");
const F = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor-server.js";
let s = fs.readFileSync(F, "utf8");
const out = [];

/* ---------- 1. Replace kiroCheckEmailCode with a polling, relevance-scored version ---------- */
const START = "async function kiroCheckEmailCode(emailPage) {";
const si = s.indexOf(START);
if (si === -1) {
  out.push("!! function start not found");
} else if (s.includes("ROBUST_CODE_V2")) {
  out.push("already patched (ROBUST_CODE_V2 present)");
} else {
  // brace-match the existing function
  let i = s.indexOf("{", si), depth = 0, end = -1;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end === -1) out.push("!! could not brace-match function");
  else {
    const NEW = `async function kiroCheckEmailCode(emailPage, log) { /* ROBUST_CODE_V2 */
  var say = (typeof log === "function") ? log : function () {};
  var DEADLINE = Date.now() + 120000;
  var CODE_RES = [
    /(?:verification\\s*code|security\\s*code|one[- ]?time\\s*(?:password|code)|passcode|your\\s*code|code)\\D{0,40}?(\\d{4,8})/i,
    /\\b(\\d{6})\\b/,
    /\\b(\\d{4,8})\\b/
  ];
  var REL = /aws|amazon|kiro|builder|verify|verification|confirm|sign[- ]?in|log[- ]?in|code/i;

  function pick(text) {
    if (!text) return null;
    for (var r = 0; r < CODE_RES.length; r++) {
      var m = text.match(CODE_RES[r]);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  var attempt = 0;
  while (Date.now() < DEADLINE) {
    attempt++;
    try {
      if (attempt === 1 || attempt % 4 === 0) {
        try { await emailPage.reload({ waitUntil: "domcontentloaded", timeout: 20000 }); } catch (e) {}
        await sleep(2500);
      }

      var body = await emailPage.evaluate(function () { return document.body ? document.body.innerText || "" : ""; });
      var loose = pick(body);
      if (loose && REL.test(body)) { say("code found on inbox page: " + loose); return loose; }

      var rows = await emailPage.$$("tr, .email-row, [class*=message], [class*=inbox] > div, li, [class*=email], [data-email], button[class*=email]");
      var best = -1;
      for (var i = 0; i < rows.length && i < 30; i++) {
        var rt = "";
        try { rt = await emailPage.evaluate(function (el) { return (el.innerText || "").trim().slice(0, 300); }, rows[i]); } catch (e) {}
        if (REL.test(rt)) { best = i; break; }
      }

      if (best >= 0) {
        try { await emailPage.evaluate(function (el) { el.click(); }, rows[best]); } catch (e) {}
        await sleep(3000);
        var exp = await emailPage.evaluate(function () { return document.body ? document.body.innerText || "" : ""; });
        var ec = pick(exp);
        if (ec) { say("code found in opened message: " + ec); return ec; }
      }

      if (loose) { say("code found (loose match): " + loose); return loose; }

      say("waiting for verification email (" + attempt + ")");
      await sleep(5000);
    } catch (e) {
      say("code check retry: " + (e && e.message ? e.message : e));
      await sleep(4000);
    }
  }
  say("no verification code found before timeout");
  return null;
}`;
    s = s.slice(0, si) + NEW + s.slice(end);
    out.push("OK kiroCheckEmailCode replaced with polling version");
  }
}

/* ---------- 2. Pass log into the call site so codes surface in the monitor ---------- */
const callRe = /kiroCheckEmailCode\(\s*emailPage\s*\)/g;
const before = (s.match(callRe) || []).length;
if (before > 0 && !s.includes("kiroCheckEmailCode(emailPage, log)")) {
  s = s.replace(callRe, "kiroCheckEmailCode(emailPage, log)");
  out.push("OK call site(s) updated to pass log: " + before);
} else out.push("call site: no change (" + before + " bare call(s))");

/* ---------- 3. Hide automation from the auth flow (webdriver + UA) ---------- */
if (!s.includes("STEALTH_INIT_V1")) {
  const pageRe = /(var|let|const)\s+emailPage\s*=\s*await\s+([A-Za-z_$][\w$]*\.newPage\(\));/;
  const pm = s.match(pageRe);
  if (pm) {
    const ind = "  ";
    const inject = pm[0] + `
${ind}/* STEALTH_INIT_V1 */
${ind}try {
${ind}  await emailPage.addInitScript(function () {
${ind}    try { Object.defineProperty(navigator, "webdriver", { get: function () { return undefined; } }); } catch (e) {}
${ind}    try { delete Object.getPrototypeOf(navigator).webdriver; } catch (e) {}
${ind}    try { window.chrome = window.chrome || { runtime: {} }; } catch (e) {}
${ind}    try {
${ind}      Object.defineProperty(navigator, "plugins", { get: function () { return [1, 2, 3, 4, 5]; } });
${ind}      Object.defineProperty(navigator, "languages", { get: function () { return ["en-US", "en"]; } });
${ind}    } catch (e) {}
${ind}  });
${ind}  await emailPage.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
${ind}  await emailPage.setViewportSize({ width: 1440, height: 900 });
${ind}} catch (e) { console.log("[stealth] init skipped: " + e.message); }`;
    s = s.replace(pm[0], inject);
    out.push("OK stealth init injected after emailPage creation");
  } else out.push("!! emailPage newPage() pattern not found (stealth skipped)");
} else out.push("stealth already present");

fs.writeFileSync(F, s);
console.log(out.join("\n"));
