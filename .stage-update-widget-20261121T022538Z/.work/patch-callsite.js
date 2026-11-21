#!/usr/bin/env node
/* Final: pass log to code check + stealth on the inbox page before it navigates. */
const fs = require("fs");
const F = "/home/ghost694/workspace/dekekenneth840@gmail.com/email-monitor-server.js";
let s = fs.readFileSync(F, "utf8");
const out = [];

/* --- 1. call site: pass log --- */
const oldCall = "code = await kiroCheckEmailCode(inbox.page);";
if (s.includes(oldCall)) {
  s = s.replace(oldCall,
`/* STEALTH_INBOX_V1 */
      try {
        if (inbox.page && inbox.page.addInitScript) {
          await inbox.page.addInitScript(function () {
            try { Object.defineProperty(navigator, "webdriver", { get: function () { return undefined; } }); } catch (e) {}
            try { delete Object.getPrototypeOf(navigator).webdriver; } catch (e) {}
            try { window.chrome = window.chrome || { runtime: {} }; } catch (e) {}
            try {
              Object.defineProperty(navigator, "plugins", { get: function () { return [1, 2, 3, 4, 5]; } });
              Object.defineProperty(navigator, "languages", { get: function () { return ["en-US", "en"]; } });
            } catch (e) {}
          });
          await inbox.page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
        }
      } catch (e) { log("stealth skipped: " + e.message); }
      code = await kiroCheckEmailCode(inbox.page, log);`);
  out.push("OK call site patched with log + stealth");
} else if (s.includes("kiroCheckEmailCode(inbox.page, log)")) {
  out.push("call site already patched");
} else {
  out.push("!! call site pattern not found");
  s.split("\n").forEach((l, i) => { if (l.includes("kiroCheckEmailCode(")) out.push("L" + (i + 1) + ": " + l.trim()); });
}

fs.writeFileSync(F, s);
console.log(out.join("\n"));
