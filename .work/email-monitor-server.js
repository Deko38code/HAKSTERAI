#!/usr/bin/env node
/**
 * Email Monitor Server — emulator-based inbox monitoring
 * Launches puppeteer browser to watch emailnator/guerrillamail inboxes
 * Serves web dashboard + REST API for email generation and checking
 */
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");
const pty = require("node-pty");
const WebSocket = require("ws");
const KIRO_CLI = "/home/ghost694/.local/bin/kiro-cli";
const KIRO_BASE = path.join(__dirname, "..", "data", "kiro-accounts");
const KIRO_WRAPPER = path.join(__dirname, "email-monitor", "kiro-wrapper");
const KIRO_PROJECT_DIR = path.join(__dirname, "email-monitor");
const KIRO_POOL_DIR = path.join(KIRO_BASE, "kiro-pool");
const KIRO_ACCOUNTS_DIR = path.join(KIRO_POOL_DIR, "accounts");
const KIRO_SESSIONS = {}; // sessionId -> {id,url,code,proc,fakeHome,status,created,checked}

const PORT = 9191;
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
// ─── IDE Proxy: forward /ide/* to localhost:4000 and rewrite Google auth ───
var httpProxy = require("http");
app.use("/ide", (req, res) => {
  var proxyReq = httpProxy.request({
    hostname: "127.0.0.1", port: 4000,
    path: req.url, method: req.method,
    headers: Object.assign({}, req.headers, { host: "127.0.0.1:4000" })
  }, (proxyRes) => {
    // Rewrite redirect locations and Google auth URLs in responses
    var headers = proxyRes.headers;
    if (headers.location) {
      headers.location = headers.location.replace("https://phantomide.com", "");
    }
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", () => { res.status(502).json({ error: "IDE not reachable" }); });
  req.pipe(proxyReq);
});

// Google auth relay — get URL from IDE, rewrite redirect_uri to local
app.get("/api/email-monitor/ide-auth", async (req, res) => {
  try {
    var r = await fetch("http://127.0.0.1:4000/api/auth/social/url?provider=google");
    var d = await r.json();
    if (d.url) {
      // Rewrite redirect_uri from phantomide.com to our callback
      var rewritten = d.url.replace(
        "redirect_uri=https%3A%2F%2Fphantomide.com%2Fapi%2Fauth%2Fgoogle%2Fcallback",
        "redirect_uri=" + encodeURIComponent("http://" + req.headers.host + "/api/email-monitor/ide-callback") +
        "&device_id=" + encodeURIComponent("phantom-em-" + Date.now()) +
        "&device_name=" + encodeURIComponent("PhantomIDE-Monitor")
      );
      res.json({ url: rewritten, original: d.url.slice(0, 100) });
    } else {
      res.json({ error: "Google not configured on IDE", raw: d });
    }
  } catch (e) { res.json({ error: e.message }); }
});
// Google OAuth callback relay — forward to IDE's callback
app.get("/api/email-monitor/ide-callback", async (req, res) => {
  try {
    var r = await fetch("http://127.0.0.1:4000/api/auth/google/callback?" + new URLSearchParams(req.query).toString(), {
      headers: { "x-forwarded-for": req.socket.remoteAddress }
    });
    var body = await r.text();
    // Forward the response (HTML with token)
    res.setHeader("Content-Type", "text/html");
    res.send(body);
  } catch (e) { res.redirect("/?auth=error&msg=callback_failed"); }
});
app.use(express.static(path.join(__dirname, "email-monitor")));

// xterm.js assets for the real kiro CLI terminal
var XTERM_ROOT = path.join(__dirname, "..", "node_modules");
app.get("/vendor/xterm.js", (req, res) => res.sendFile(path.join(XTERM_ROOT, "@xterm/xterm", "lib", "xterm.js")));
app.get("/vendor/xterm.css", (req, res) => res.sendFile(path.join(XTERM_ROOT, "@xterm/xterm", "css", "xterm.css")));
app.get("/vendor/addon-fit.js", (req, res) => res.sendFile(path.join(XTERM_ROOT, "@xterm/addon-fit", "lib", "addon-fit.js")));

const STATE = {
  inboxes: {},  // id -> { email, service, page, browser, emails: [], created }
  browser: null,
};

// ─── WebSocket terminal registry ───
const WS_SERVER = new WebSocket.Server({ noServer: true });
const TERMINALS = {}; // pty pid -> { ws, pty, homeId, real, created }
const MAX_TERMINALS = 8;

// ─── Generate email via emailnator (realistic addresses only) ───
// Rejects emails with "tmp", "test", "temp", "+", or short names
// Retries up to 5 times to get a realistic-looking Gmail address
function isRealisticEmail(email) {
  var local = email.split("@")[0].toLowerCase();
  // Reject suspicious patterns
  if (/\+/.test(local)) return false;           // no plus aliases
  if (/tmp|temp|test|fake|demo|example/.test(local)) return false; // no temp words
  if (/^x[0-9]|^[0-9]{4,}|^[a-z]{1,2}[0-9]/.test(local)) return false; // no short/random
  // Accept: looks like a name (4+ letters, has a name-like pattern)
  if (local.length >= 5 && /^[a-z]/.test(local) && /[a-z]{3,}/.test(local)) return true;
  return local.length >= 6; // fallback: at least 6 chars
}

async function generateEmailnator() {
  var page = await STATE.browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  await page.goto("https://www.emailnator.com", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  var email = null;
  for (var attempt = 0; attempt < 5; attempt++) {
    // Click Generate
    var btns = await page.$$("button");
    for (var i = 0; i < btns.length; i++) {
      var text = await page.evaluate(el => el.innerText.trim(), btns[i]);
      if (/^generate/i.test(text) || /^go$/i.test(text)) {
        await page.evaluate(el => el.click(), btns[i]);
        await new Promise(r => setTimeout(r, 3000));
        break;
      }
    }

    // Extract email
    var pageText = await page.evaluate(() => document.body.innerText);
    var match = pageText.match(/([a-zA-Z0-9._+]+@gmail\.com)/);
    if (!match) {
      var inputs = await page.$$("input");
      for (var j = 0; j < inputs.length; j++) {
        var val = await page.evaluate(el => el.value, inputs[j]);
        if (val && val.indexOf("@gmail.com") >= 0) { match = [val, val]; break; }
      }
    }
    if (match && isRealisticEmail(match[1])) {
      email = match[1];
      console.log("[emailnator] ✅ Accepted: " + email + " (attempt " + (attempt+1) + ")");
      break;
    }
    if (match) {
      console.log("[emailnator] ❌ Rejected: " + match[1] + " (attempt " + (attempt+1) + ") — looks fake");
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!email) {
    // Last resort: use whatever we got, strip the +alias part
    var pageText2 = await page.evaluate(() => document.body.innerText);
    var m2 = pageText2.match(/([a-zA-Z0-9._]+)@gmail\.com/);
    if (m2) email = m2[1].split("+")[0] + "@gmail.com";
  }
  if (!email) throw new Error("Emailnator: no realistic Gmail generated after 5 attempts");
  return { email: email, page: page, service: "emailnator" };
}

// ─── Generate email via guerrillamail ───
// Today's markup: <span id="email-widget">zigx8s+51aosjitw9v54@sharklasers.com</span>
// holds the full alias address (scrambled form of the underlying inbox id).
async function generateGuerrilla() {
  var page = await STATE.browser.newPage();
  await page.setViewport({ width: 900, height: 900 });
  await page.goto("https://www.guerrillamail.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await new Promise((r) => setTimeout(r, 3000));

  var email = await page.evaluate(() => {
    var w = document.getElementById("email-widget");
    return w ? (w.textContent || "").trim() : "";
  });
  if (!email || email.indexOf("@") < 0) {
    var body = await page.evaluate(() => document.body.innerText);
    var m = body.match(/[a-zA-Z0-9._+\-]+@(?:sharklasers|guerrillamail(?:block|info|biz|net|org|de)?|grr\.la|pokemail|spam4\.me)\.[a-z]+/i);
    email = m ? m[0] : "";
  }
  if (!email || email.indexOf("@") < 0) {
    try { await page.close(); } catch (_) {}
    throw new Error("Guerrillamail: no email generated");
  }
  return { email: email, page: page, service: "guerrillamail" };
}

// ─── Guerrillamail inbox check (real DOM) ────────────────────────────────
// List: #email_table > tbody#email_list > tr; mail view after click:
// #inbox > #display_email > .email_page > .email  (subject + From/To/Date + body).
// Codes are extracted from the opened mail body to avoid matching page-wide
// counters ("115146 emails going in / hour").
async function checkInboxGuerrilla(inbox) {
  var page = inbox.page;
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1500));
    var rows = await page.$$("#email_table tr");
    var emails = [];
    for (var i = 0; i < rows.length; i++) {
      var cells = await page.evaluate(function (el) {
        return Array.prototype.map.call(el.children, function (td) {
          return (td.innerText || "").replace(/\s+/g, " ").trim();
        }).filter(Boolean);
      }, rows[i]);
      if (!cells.length) continue;
      var from = cells.find(function (c) { return c.indexOf("@") >= 0; }) || cells[0];
      var subject = cells.length > 1 ? cells[1] : "";
      var preview = cells.slice(from === cells[0] ? 2 : 1).join(" ");
      var code = null;
      var m6 = preview.match(/\b(\d{6})\b/);
      if (m6) code = m6[1];
      if (!code) {
        // Open the mail and read its body for a verification code.
        try {
          await page.click("#email_table tbody tr:nth-child(" + (i + 1) + ") td:nth-child(3)");
          await new Promise((r) => setTimeout(r, 2200));
          var bodyText = await page.evaluate(() => {
            var e = document.querySelector("#inbox #display_email .email_page .email") ||
                    document.querySelector("#display_email .email") ||
                    document.querySelector(".email_page .email");
            return e ? (e.innerText || "") : "";
          });
          if (bodyText) {
            preview = (preview + " " + bodyText).slice(0, 600);
            var cm = bodyText.match(/(?:code|verification|verify|otp|pin)[^0-9]{0,30}(\d{4,8})/i);
            if (cm) code = cm[1];
            else { var bc = bodyText.match(/\b(\d{6})\b/); if (bc) code = bc[1]; }
          }
          // Back to inbox list.
          await page.evaluate(() => {
            var a = document.querySelector('a[href$="/inbox"], a[href*="/inbox"]');
            if (a) a.click();
          });
          await new Promise((r) => setTimeout(r, 1200));
        } catch (_) {}
      }
      emails.push({
        from: from || "Unknown",
        subject: subject || (preview.slice(0, 80) || "(no subject)"),
        body: preview.slice(0, 400),
        code: code,
        time: new Date().toISOString(),
      });
    }
    return emails;
  } catch (e) {
    console.error("[monitor] Guerrilla check error: " + e.message);
    return [];
  }
}

async function checkInbox(inbox) {
  if (inbox.service === "guerrillamail") return checkInboxGuerrilla(inbox);
  try {
    await inbox.page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 2000));

    var pageText = await inbox.page.evaluate(() => document.body.innerText);
    var emails = [];

    // Look for email rows/entries
    var rows = await inbox.page.$$("tr, .email-row, [class*=message], [class*=inbox] > div, li, .mail-item");
    for (var i = 0; i < rows.length; i++) {
      var rowText = await inbox.page.evaluate(el => el.innerText.trim().slice(0, 500), rows[i]);
      if (rowText && rowText.length > 10 && !/^(home|about|faq|contact|privacy)/i.test(rowText)) {
        // Extract code if present
        var codeMatch = rowText.match(/\b(\d{6})\b/);
        var fromMatch = rowText.match(/^(.+?)[\n\r]/);
        var subjectMatch = rowText.match(/(?:subject|re)[:\s]*(.+)/i);
        emails.push({
          from: fromMatch ? fromMatch[1].trim() : "Unknown",
          subject: subjectMatch ? subjectMatch[1].trim() : rowText.slice(0, 80),
          body: rowText.slice(0, 300),
          code: codeMatch ? codeMatch[1] : null,
          time: new Date().toISOString(),
        });
      }
    }

    // If no rows found, check page text for codes
    if (emails.length === 0) {
      var codeInText = pageText.match(/\b(\d{6})\b/);
      if (codeInText) {
        emails.push({
          from: "Unknown",
          subject: "Verification code detected",
          body: pageText.slice(0, 300),
          code: codeInText[1],
          time: new Date().toISOString(),
        });
      }
    }

    return emails;
  } catch(e) {
    console.error("[monitor] Check error: " + e.message);
    return [];
  }
}

// ─── API endpoints ───
app.post("/api/email-monitor/generate", async (req, res) => {
  try {
    var service = req.body.service || "emailnator";
    var result;
    if (service === "guerrillamail") {
      result = await generateGuerrilla();
    } else {
      result = await generateEmailnator();
    }
    var id = crypto.randomUUID();
    STATE.inboxes[id] = {
      id: id,
      email: result.email,
      service: result.service,
      page: result.page,
      emails: [],
      created: new Date().toISOString(),
    };
    console.log("[monitor] Generated: " + result.email + " (" + result.service + ")");
    res.json({ id: id, email: result.email, service: result.service });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/email-monitor/check/:id", async (req, res) => {
  var inbox = STATE.inboxes[req.params.id];
  if (!inbox) return res.status(404).json({ error: "Inbox not found" });
  if (inbox.busy) {
    var codes0 = inbox.emails.filter(e => e.code).map(e => e.code);
    return res.json({ emails: inbox.emails, codes: codes0, busy: true });
  }
  inbox.busy = true;
  try {
    var emails = await checkInbox(inbox);
    if (emails.length > inbox.emails.length) inbox.emails = emails;
    var codes = inbox.emails.filter(e => e.code).map(e => e.code);
    res.json({ emails: inbox.emails, codes: codes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    inbox.busy = false;
  }
});

app.get("/api/email-monitor/inboxes", (req, res) => {
  var list = Object.values(STATE.inboxes).map(ib => ({
    id: ib.id, email: ib.email, service: ib.service,
    emailCount: ib.emails.length, codeCount: ib.emails.filter(e => e.code).length,
    created: ib.created,
  }));
  res.json({ inboxes: list });
});

app.get("/api/email-monitor/stats", (req, res) => {
  var allEmails = Object.values(STATE.inboxes).flatMap(ib => ib.emails);
  res.json({
    accounts: Object.keys(STATE.inboxes).length,
    emails: allEmails.length,
    codes: allEmails.filter(e => e.code).length,
    services: new Set(Object.values(STATE.inboxes).map(ib => ib.service)).size,
  });
});

// ─── Gmail bulk generator (emailnator generation + live-inbox check) ──────
const GMAIL_JOBS = {}; // jobId -> { id, count, progress:{done,valid}, generated:[], done, cancelled, error }

app.post("/api/email-monitor/gmail/generate", express.json(), async (req, res) => {
  try {
    if (!STATE.browser) return res.status(500).json({ error: "Browser emulator not ready" });
    var count = Math.min(Math.max(parseInt(req.body && req.body.count, 10) || 1, 1), 10);
    if (Object.keys(STATE.inboxes).length >= 50) return res.status(429).json({ error: "Inbox limit reached (50) — restart the service or use fewer inboxes" });
    var jobId = crypto.randomUUID();
    var job = { id: jobId, count: count, progress: { done: 0, valid: 0 }, generated: [], done: false, cancelled: false, error: null, created: new Date().toISOString() };
    GMAIL_JOBS[jobId] = job;
    res.json({ jobId: jobId });
    runGmailJob(job);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function runGmailJob(job) {
  var fails = 0;
  for (;;) {
    if (job.cancelled || job.progress.done >= job.count) break;
    try {
      var gen = await generateEmailnator();
      var id = crypto.randomUUID();
      var inbox = { id: id, email: gen.email, service: "emailnator", page: gen.page, emails: [], created: new Date().toISOString() };
      STATE.inboxes[id] = inbox;
      // Validate the inbox is live: reload must return HTTP 200 from emailnator.
      var ok = false;
      inbox.busy = true;
      try {
        var resp = await inbox.page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
        ok = !(resp && resp.status && resp.status() !== 200);
        await new Promise((r) => setTimeout(r, 1200));
      } catch (_) {}
      inbox.busy = false;
      job.generated.push(ok ? { email: gen.email, inboxId: id, valid: true } : { email: gen.email, inboxId: id, valid: false });
      if (ok) { job.progress.valid += 1; fails = 0; }
      else fails++;
      console.log("[gmail-job] generated " + gen.email + (ok ? " (valid 200)" : " (check failed)"));
    } catch (e) {
      job.generated.push({ email: null, valid: false, error: String(e.message || e).slice(0, 120) });
      fails++;
    }
    job.progress.done += 1;
    if (fails >= 3 && job.progress.valid === 0) { job.error = "3 consecutive generations failed"; break; }
  }
  job.done = true;
  console.log("[gmail-job] done: " + job.progress.valid + "/" + job.count + " valid" + (job.error ? " (error: " + job.error + ")" : ""));
}

app.get("/api/email-monitor/gmail/generate/:jobId", (req, res) => {
  var j = GMAIL_JOBS[req.params.jobId];
  if (!j) return res.status(404).json({ error: "Gmail job not found" });
  res.json({ id: j.id, count: j.count, progress: j.progress, generated: j.generated, done: j.done, cancelled: j.cancelled, error: j.error });
});

app.post("/api/email-monitor/gmail/generate/cancel/:jobId", (req, res) => {
  var j = GMAIL_JOBS[req.params.jobId];
  if (!j) return res.status(404).json({ error: "Gmail job not found" });
  j.cancelled = true;
  res.json({ ok: true, progress: j.progress, done: j.done });
});

// ─── Auto-monitor: check all inboxes every 15s ───
setInterval(async () => {
  for (var id in STATE.inboxes) {
    var inbox = STATE.inboxes[id];
    if (inbox.busy) continue;
    inbox.busy = true;
    try {
      var emails = await checkInbox(inbox);
      if (emails.length > inbox.emails.length) {
        console.log("[monitor] " + (emails.length - inbox.emails.length) + " new email(s) for " + inbox.email);
        inbox.emails = emails;
      }
    } catch (e) {
      console.error("[monitor] Auto-check failed for " + id + ": " + e.message);
    } finally {
      inbox.busy = false;
    }
  }
}, 15000);

// ─── Start server ───
(async () => {
  STATE.browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  console.log("[monitor] Browser emulator launched");

  var server = http.createServer(app);
  server.on("upgrade", function (req, socket, head) {
    var u = new URL(req.url, "http://localhost");
    if (u.pathname !== "/terminal") { socket.destroy(); return; }
    WS_SERVER.handleUpgrade(req, socket, head, (ws) => openKiroTerminal(ws, u));
  });
  server.listen(PORT, () => {
    console.log("[monitor] Email Monitor Platform running on http://localhost:" + PORT);
    console.log("[monitor] Dashboard: http://localhost:" + PORT + "/index.html");
  });
})();
// ─── Hackbot chat proxy ───
const https2 = require("https");
const http2 = require("http");

// One round-trip to the local haksterAI gateway (127.0.0.1:5555).
// Parses both SSE chunks (delta.content / message.content) and plain JSON.
function chatOnce(model, messages, maxTokens, stream) {
  return new Promise((resolve) => {
    var body = JSON.stringify({ model: model, stream: stream, max_tokens: maxTokens, messages: messages });
    var opts = {
      hostname: "127.0.0.1", port: 5555, path: "/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer hk-universal-2026", "Content-Length": Buffer.byteLength(body) },
    };
    var req = http2.request(opts, (r) => {
      var raw = "";
      r.on("data", (c) => { raw += c.toString(); });
      r.on("end", () => {
        var content = "", usedModel = model;
        var lines = raw.split("\n");
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try {
              var d = JSON.parse(line.slice(6));
              if (d.model) usedModel = d.model;
              var ch = d.choices && d.choices[0];
              if (ch && ch.delta && ch.delta.content) content += ch.delta.content;
              if (ch && ch.message && ch.message.content) content += ch.message.content;
            } catch (e) {}
          }
        }
        if (!content) {
          try {
            var j = JSON.parse(raw);
            if (j.model) usedModel = j.model;
            var c = j.choices && j.choices[0];
            if (c && c.message && c.message.content) content = c.message.content;
            if (j.error) content = "[upstream] " + (typeof j.error === "string" ? j.error : JSON.stringify(j.error));
          } catch (e) {}
        }
        resolve({ content: content, model: usedModel });
      });
    });
    req.on("error", () => resolve({ content: "", model: model, error: "upstream unavailable" }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ content: "", model: model, error: "timeout" }); });
    req.write(body);
    req.end();
  });
}

var UPSTREAM_ERR_RE = /\bAll bots and direct providers failed\b/i;

app.post("/api/email-monitor/chat", express.json(), async (req, res) => {
  try {
    var model = req.body.model || "no-censor-ai-coding";
    var messages = req.body.messages || [{ role: "user", content: req.body.message || "hi" }];
    var maxTokens = req.body.max_tokens || 256;
    // Streaming reaches the miniapps.ai bots; fall back to non-stream if it yields nothing or errors.
    var r = await chatOnce(model, messages, maxTokens, true);
    if (!r.content || UPSTREAM_ERR_RE.test(r.content)) {
      var r2 = await chatOnce(model, messages, maxTokens, false);
      if (r2.content && !UPSTREAM_ERR_RE.test(r2.content)) r = r2;
    }
    if (!r.content || UPSTREAM_ERR_RE.test(r.content))
      return res.status(502).json({ error: r.error || "Hackbot returned no content" });
    res.json({ choices: [{ message: { role: "assistant", content: r.content } }], model: r.model });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/email-monitor/chat/status", async (req, res) => {
  try {
    var r = await chatOnce("no-censor-ai-coding", [{ role: "user", content: "hi" }], 4, false);
    res.json({ online: !!r.content && !UPSTREAM_ERR_RE.test(r.content), model: r.model || "unknown" });
  } catch (e) { res.json({ online: false }); }
});

// ─── Kiro device-flow auth ───────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Shared device-flow starter. Spawns kiro-cli in an isolated HOME, resolves
// with {session, url, code} once the awsapps device URL is printed.
function kiroStartDeviceFlow() {
  return new Promise((resolve, reject) => {
    var sessionId = crypto.randomUUID();
    var fakeHome = path.join(KIRO_BASE, "home-" + Date.now() + "-" + sessionId.slice(0, 8));
    fs.mkdirSync(path.join(fakeHome, ".local/share/kiro-cli"), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, ".kiro"), { recursive: true });
    var env = Object.assign({}, process.env, { HOME: fakeHome, BROWSER: "none", NO_OPEN_BROWSER: "1" });
    var proc = spawn(KIRO_CLI, ["login", "--use-device-flow", "--license", "free"], { env });
    var output = "";
    proc.stdout.on("data", (d) => { output += d.toString(); });
    proc.stderr.on("data", (d) => { output += d.toString(); });
    var session = { id: sessionId, url: null, code: null, proc: proc, fakeHome: fakeHome, status: "pending", created: new Date().toISOString(), checked: null };
    KIRO_SESSIONS[sessionId] = session;
    console.log("[kiro] Device flow started: " + sessionId + " (home=" + fakeHome + ")");
    var resolved = false;
    var checker = setInterval(() => {
      var m = output.match(/https:\/\/view\.awsapps\.com\/start\/#\/device\?user_code=([A-Z0-9-]+)/);
      if (m && !resolved) {
        resolved = true;
        clearInterval(checker);
        session.url = m[0]; session.code = m[1];
        console.log("[kiro] " + sessionId + " URL: " + m[0]);
        resolve({ session: session, url: m[0], code: m[1] });
      }
    }, 500);
    proc.on("exit", (code) => { clearInterval(checker); session.status = code === 0 ? "completed" : "exited"; });
    setTimeout(() => { if (!resolved) { clearInterval(checker); session.status = "no-url"; reject(new Error("kiro-cli did not emit a device URL")); } }, 25000);
  });
}

app.post("/api/email-monitor/kiro/device-flow", async (req, res) => {
  try {
    if (!fs.existsSync(KIRO_CLI)) return res.status(500).json({ error: "kiro-cli not installed at " + KIRO_CLI });
    fs.mkdirSync(KIRO_BASE, { recursive: true });
    var df = await kiroStartDeviceFlow();
    res.json({ sessionId: df.session.id, url: df.url, code: df.code });
  } catch (e) { res.status(504).json({ error: e.message }); }
});

app.get("/api/email-monitor/kiro/sessions", (req, res) => {
  var list = Object.values(KIRO_SESSIONS).map((s) => ({
    id: s.id, url: s.url, code: s.code, status: s.status, created: s.created, checked: s.checked,
  }));
  res.json({ sessions: list });
});

app.get("/api/email-monitor/kiro/status/:sessionId", (req, res) => {
  var s = KIRO_SESSIONS[req.params.sessionId];
  if (!s) return res.status(404).json({ error: "Kiro session not found" });
  try {
    var out = execSync("HOME=" + s.fakeHome + " BROWSER=none " + KIRO_CLI + " whoami 2>&1", { timeout: 12000 }).toString();
    var ok = out.indexOf("Logged in") >= 0;
    s.checked = new Date().toISOString();
    if (ok) s.status = "authenticated";
    res.json({ authenticated: ok, detail: out.trim(), status: s.status, checked: s.checked });
  } catch (e) {
    s.checked = new Date().toISOString();
    res.json({ authenticated: false, detail: String(e.stdout || e.message).trim().slice(0, 300), status: s.status, checked: s.checked });
  }
});

app.post("/api/email-monitor/kiro/cancel/:sessionId", (req, res) => {
  var s = KIRO_SESSIONS[req.params.sessionId];
  if (!s) return res.status(404).json({ error: "Kiro session not found" });
  try { s.proc.kill(); } catch (_) {}
  s.status = "cancelled";
  res.json({ ok: true, status: s.status });
});

// ─── Kiro auto-pair signup (browser-driven) ──────────────────────────────
// Mirrors kiro-account-farm.js: generate emailnator inbox -> device flow ->
// open AWS Builder ID device URL -> sign up with the email -> poll the
// emailnator inbox for the 6-digit verification code -> enter it + Allow ->
// verify with `kiro-cli whoami`. Runs as a background job.
const KIRO_JOBS = {};

async function clickFirstMatching(page, re, label, log, opts) {
  opts = opts || {};
  var btns = await page.$$("button");
  for (var i = 0; i < btns.length; i++) {
    var text = await page.evaluate((el) => el.innerText.trim(), btns[i]);
    if (opts.maxLength && text.length >= opts.maxLength) continue;
    if (opts.requireEnabled && await page.evaluate((el) => el.disabled, btns[i])) continue;
    if (opts.requireVisible && !await page.evaluate((el) => el.offsetParent !== null, btns[i])) continue;
    if (opts.yMin) { var box = await btns[i].boundingBox(); if (!box || box.y < opts.yMin) continue; }
    if (re.test(text)) {
      await page.evaluate((el) => el.click(), btns[i]);
      log("click " + label + ": " + text);
      await sleep(2000);
      return true;
    }
  }
  log("no " + label + " button");
  return false;
}

// Random name generator for AWS Builder ID signup
var FIRST_NAMES = ["Alex","Sam","Jordan","Taylor","Morgan","Casey","Riley","Quinn","Avery","Blake","Cameron","Drew","Emery","Finley","Hayden","Kendall","Logan","Parker","Reese","Sage"];
var LAST_NAMES = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Wilson","Anderson","Thomas","Lee","Walker","Hall","Allen","Young","King","Wright"];
function randName() { return FIRST_NAMES[Math.floor(Math.random()*FIRST_NAMES.length)] + " " + LAST_NAMES[Math.floor(Math.random()*LAST_NAMES.length)]; }
function randUA() {
  var ver = 120 + Math.floor(Math.random()*8);
  var plat = ["Win32","MacIntel","Linux x86_64"][Math.floor(Math.random()*3)];
  return "Mozilla/5.0 (" + (plat==="Win32"?"Windows NT 10.0":plat==="MacIntel"?"Macintosh; Intel Mac OS X 10_15_7":"X11; Linux x86_64") + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + ver + ".0.0.0 Safari/537.36";
}

async function kiroSignupBrowser(browser, email, deviceUrl, log) {
  var page = await browser.newPage();
  // Clear all cookies for isolation
  try { var cookies = await browser.cookies(); await browser.deleteCookie(...cookies); } catch(_){}
  // Rotate fingerprint: random viewport, user-agent, locale
  var w = 1200 + Math.floor(Math.random()*200);
  var h = 700 + Math.floor(Math.random()*200);
  // Intercept Google OAuth redirects — add prompt=select_account to force account picker
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    var url = req.url();
    if (url.indexOf("accounts.google.com") >= 0 && url.indexOf("prompt=") < 0) {
      var sep = url.indexOf("?") >= 0 ? "&" : "?";
      req.continue({ url: url + sep + "prompt=select_account" });
    } else {
      req.continue();
    }
  });
  await page.setUserAgent(randUA());
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  log("browser open: " + deviceUrl + " (" + w + "x" + h + ")");
  await page.goto(deviceUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(2000);
  // Human-like mouse movement
  await page.mouse.move(200 + Math.random()*400, 300 + Math.random()*200, { steps: 10 });
  await sleep(500);
  await clickFirstMatching(page, /accept all|accept|agree|got it|allow all/i, "cookies", log, { maxLength: 30 });
  await sleep(1000);
  await clickFirstMatching(page, /^continue$/i, "continue", log, { requireEnabled: true });
  await sleep(2500);
  await clickFirstMatching(page, /accept all|accept|agree|got it/i, "cookies2", log, { maxLength: 30 });
  log("email: " + email);
  var emailInput = await page.$("input[type=email]");
  if (!emailInput) throw new Error("No email input on auth page");
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(email, { delay: 80 + Math.random()*60 });
  await sleep(800);
  await page.mouse.move(400 + Math.random()*200, 500 + Math.random()*100, { steps: 8 });
  await clickFirstMatching(page, /^continue$/i, "continue-email", log, { requireEnabled: true, yMin: 200 });
  await sleep(5000);
  var pageText = await page.evaluate(() => {
    var t = ""; document.querySelectorAll("h1,h2,h3,p,label,span").forEach((el) => {
      if (el.offsetParent !== null && el.innerText && el.innerText.length < 200) t += el.innerText + " | ";
    });
    return t.slice(0, 800);
  });
  log("page: " + pageText.slice(0, 200));
  // Name page — MUST enter a name or AWS won't send verification email
  if (/enter your name|name/i.test(pageText)) {
    var fullName = randName();
    log("name page — entering: " + fullName);
    var nameInput = await page.$("input[type=text]");
    if (nameInput) {
      await nameInput.click({ clickCount: 3 });
      await nameInput.type(fullName, { delay: 70 + Math.random()*50 });
      await sleep(500);
    } else {
      // Try any visible text input
      var inputs = await page.$$("input");
      for (var ni = 0; ni < inputs.length; ni++) {
        var info = await page.evaluate(el => ({ type: el.type, visible: el.offsetParent !== null }), inputs[ni]);
        if (info.visible && /text|name/i.test(info.type)) {
          await inputs[ni].click({ clickCount: 3 });
          await inputs[ni].type(fullName, { delay: 70 });
          await sleep(500);
          break;
        }
      }
    }
    await page.mouse.move(400 + Math.random()*200, 500 + Math.random()*100, { steps: 8 });
    await clickFirstMatching(page, /^continue$/i, "continue-name", log, { requireEnabled: true, requireVisible: true });
    await sleep(5000);
  }
  return page;
}

async function kiroEnterCode(page, code, log) {
  log("code: " + code);
  var inputs = await page.$$("input");
  for (var i = 0; i < inputs.length; i++) {
    var info = await page.evaluate((el) => ({ type: el.type, visible: el.offsetParent !== null }), inputs[i]);
    if (info.visible && /text|number|tel/.test(info.type)) {
      await inputs[i].click({ clickCount: 3 });
      await inputs[i].type(code, { delay: 80 });
      log("code entered");
      break;
    }
  }
  await sleep(500);
  await clickFirstMatching(page, /verify|confirm|submit|continue/i, "verify", log, { requireEnabled: true });
  await sleep(3000);
  await sleep(2000);
  await clickFirstMatching(page, /allow|authorize|grant|approve/i, "allow", log, { requireEnabled: true });
}

async function kiroCheckEmailCode(emailPage) {
  try {
    // Try networkidle2 for more complete page load
    await emailPage.reload({ waitUntil: "networkidle2", timeout: 25000 });
    await sleep(3000);
    var pageText = await emailPage.evaluate(() => document.body.innerText);
    // Look for 6-digit code anywhere on page
    var codeMatch = pageText.match(/\b(\d{6})\b/);
    if (codeMatch) return codeMatch[1];
    // AWS-specific patterns
    var awsMatch = pageText.match(/(?:code|verify|verification)[:\s]+(\d{4,8})/i);
    if (awsMatch) return awsMatch[1];
    // Try clicking email rows with broader selectors
    var rows = await emailPage.$$("tr, .email-row, [class*=message], [class*=inbox] > div, li, [class*=email], [data-email], button[class*=email]");
    for (var i = 0; i < rows.length; i++) {
      var rowText = await emailPage.evaluate(el => el.innerText.trim().slice(0, 300), rows[i]);
      if (/aws|amazon|verify|verification|code|builder|confirm/i.test(rowText)) {
        await emailPage.evaluate(el => el.click(), rows[i]);
        await sleep(3000);
        var expanded = await emailPage.evaluate(() => document.body.innerText);
        var ec = expanded.match(/\b(\d{6})\b/);
        if (ec) return ec[1];
        // Also check for 4-8 digit codes in expanded view
        var ec2 = expanded.match(/(?:code|verify|verification)[:\s]+(\d{4,8})/i);
        if (ec2) return ec2[1];
      }
    }
    // Try clicking all visible buttons/links that might expand emails
    var clickables = await emailPage.$$(".inbox-item, .mail-item, [onclick], a[href*=inbox]");
    for (var ci = 0; ci < clickables.length; ci++) {
      await emailPage.evaluate(el => el.click(), clickables[ci]);
      await sleep(2000);
      var bodyText = await emailPage.evaluate(() => document.body.innerText);
      var bc = bodyText.match(/\b(\d{6})\b/);
      if (bc) return bc[1];
    }
    return null;
  } catch (e) { return null; }
}

function kiroCheckAuth(fakeHome) {
  try {
    var out = execSync("HOME=" + fakeHome + " BROWSER=none " + KIRO_CLI + " whoami 2>&1", { timeout: 12000 }).toString();
    return out.indexOf("Logged in") >= 0 ? out.trim() : null;
  } catch (e) { return null; }
}

async function runKiroSignupJob(job, inboxId) {
  function lg(m) { job.log.push("[" + new Date().toISOString().slice(11, 19) + "] " + m); console.log("[kiro-job " + job.id.slice(0, 8) + "] " + m); }
  try {
    var inbox = null;
    if (inboxId) {
      inbox = STATE.inboxes[inboxId];
      if (!inbox) throw new Error("Inbox not found: " + inboxId);
      if (inbox.service !== "emailnator") throw new Error("Auto-pair requires an emailnator inbox");
      job.inboxId = inboxId; job.email = inbox.email;
    } else {
      job.stage = "generating-email";
      lg("generating emailnator inbox");
      var gen = await generateEmailnator();
      var id = crypto.randomUUID();
      inbox = { id: id, email: gen.email, service: "emailnator", page: gen.page, emails: [], created: new Date().toISOString() };
      STATE.inboxes[id] = inbox;
      job.inboxId = id; job.email = gen.email;
    }
    lg("email: " + job.email);
    job.stage = "starting-device-flow";
    lg("starting device flow (Tor-routed, isolated HOME)");
    var df = await kiroStartDeviceFlow();
    job.sessionId = df.session.id; job.url = df.url; job.code = df.code;
    lg("device code: " + df.code + "  url: " + df.url);
    job.stage = "opening-auth-page";
    var page = await kiroSignupBrowser(STATE.browser, job.email, df.url, lg);
    inbox.busy = true;
    job.stage = "waiting-for-verification-email";
    lg("waiting for verification email...");
    var code = null;
    var start = Date.now();
    while (Date.now() - start < 180000 && !job.cancelled) {
      code = await kiroCheckEmailCode(inbox.page);
      if (code) break;
      var elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed % 15 === 0) lg("still waiting... (" + elapsed + "s)");
      await sleep(5000);
    }
    if (job.cancelled) { job.stage = "cancelled"; return; }
    if (!code) throw new Error("No verification email within 180s");
    lg("verify code: " + code);
    job.stage = "entering-code";
    await kiroEnterCode(page, code, lg);
    await sleep(8000);
    job.stage = "checking-auth";
    var auth = kiroCheckAuth(df.session.fakeHome);
    if (!auth) { await sleep(10000); auth = kiroCheckAuth(df.session.fakeHome); }
    if (auth) {
      job.authenticated = true; job.detail = auth; job.stage = "authenticated"; lg("✅ " + auth);
      // Save to kiro-wrapper account pool so the wrapper can rotate to this account
      try {
        fs.mkdirSync(KIRO_ACCOUNTS_DIR, { recursive: true });
        var poolName = "acct-" + String(job.email).split("@")[0].replace(/[^a-z0-9]/gi, "").slice(0, 12) + "-" + job.id.slice(0, 6);
        var poolDir = path.join(KIRO_ACCOUNTS_DIR, poolName);
        fs.mkdirSync(path.join(poolDir, ".local/share/kiro-cli"), { recursive: true });
        fs.mkdirSync(path.join(poolDir, ".kiro"), { recursive: true });
        execSync("cp -r " + df.session.fakeHome + "/.local/share/kiro-cli/. " + poolDir + "/.local/share/kiro-cli/ 2>/dev/null; cp -r " + df.session.fakeHome + "/.kiro/. " + poolDir + "/.kiro/ 2>/dev/null; true");
        fs.writeFileSync(path.join(KIRO_POOL_DIR, "current-account"), poolName);
        lg("📋 saved to account pool: " + poolName);
        job.stage = "ready-to-launch";
        lg("🚀 Ready — kiro-wrapper will launch with this account on restart");
      } catch (pe) { lg("⚠ pool save failed: " + pe.message); }
    }
    else { job.stage = "auth-failed"; lg("❌ auth not completed"); try { await page.screenshot({ path: path.join(KIRO_BASE, "fail-" + job.id.slice(0, 8) + ".png") }); } catch (_) {} }
  } catch (e) {
    job.error = e.message; job.stage = "error"; lg("error: " + e.message);
  } finally {
    if (inbox) inbox.busy = false;
    job.done = true;
  }
}

app.post("/api/email-monitor/kiro/signup", express.json(), async (req, res) => {
  try {
    if (!fs.existsSync(KIRO_CLI)) return res.status(500).json({ error: "kiro-cli not installed" });
    if (!STATE.browser) return res.status(500).json({ error: "Browser emulator not ready" });
    fs.mkdirSync(KIRO_BASE, { recursive: true });
    var jobId = crypto.randomUUID();
    var job = { id: jobId, stage: "queued", email: null, inboxId: null, sessionId: null, url: null, code: null, authenticated: false, detail: null, log: [], error: null, created: new Date().toISOString(), done: false, cancelled: false };
    KIRO_JOBS[jobId] = job;
    res.json({ jobId: jobId });
    runKiroSignupJob(job, req.body.inboxId || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/email-monitor/kiro/signup/:jobId", (req, res) => {
  var j = KIRO_JOBS[req.params.jobId];
  if (!j) return res.status(404).json({ error: "Kiro signup job not found" });
  res.json({ id: j.id, stage: j.stage, email: j.email, inboxId: j.inboxId, sessionId: j.sessionId, url: j.url, code: j.code, authenticated: j.authenticated, detail: j.detail, error: j.error, done: j.done, cancelled: j.cancelled, log: j.log.slice(-40), created: j.created });
});

app.get("/api/email-monitor/kiro/signups", (req, res) => {
  res.json({ jobs: Object.values(KIRO_JOBS).map((j) => ({ id: j.id, stage: j.stage, email: j.email, code: j.code, authenticated: j.authenticated, done: j.done, error: j.error, created: j.created })) });
});

app.post("/api/email-monitor/kiro/signup/cancel/:jobId", (req, res) => {
  var j = KIRO_JOBS[req.params.jobId];
  if (!j) return res.status(404).json({ error: "Kiro signup job not found" });
  j.cancelled = true;
  res.json({ ok: true, stage: j.stage });
});

// ─── Kiro CLI emulator homes ──────────────────────────────────────────────
// Persisted isolated HOMEs for kiro-cli experiments. The dashboard terminal
// uses the machine's real HOME by default and these as alternate candidates.
const KIRO_CLI_HOMES = {}; // homeId -> {id, fakeHome, created}

function newKiroHome() {
  var id = crypto.randomUUID();
  var fakeHome = path.join(KIRO_BASE, "cli-home-" + id.slice(0, 8));
  fs.mkdirSync(path.join(fakeHome, ".local/share/kiro-cli"), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, ".kiro"), { recursive: true });
  KIRO_CLI_HOMES[id] = { id: id, fakeHome: fakeHome, created: new Date().toISOString() };
  return KIRO_CLI_HOMES[id];
}

function parseArgs(line) {
  var args = [];
  var re = /"([^"]*)"|'([^']*)'|(\S+)/g, m;
  while ((m = re.exec(line)) !== null) args.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
  return args;
}
// ─── Real kiro CLI terminal (PTY over WebSocket) ─────────────────────────
// Each dashboard client gets a real PTY. Default HOME is the machine's real
// login (the HOME the CLI is authenticated with); `home=<emulator id>` runs
// the terminal in an isolated fake HOME instead. `cmd` selects the program:
// default is a real login shell; cmd="kiro-cli" starts the Kiro TUI directly.
function openKiroTerminal(ws, u) {
  try {
    if (!fs.existsSync(KIRO_CLI)) { try { ws.close(1011, "kiro-cli not installed"); } catch (_) {} return; }
    if (Object.keys(TERMINALS).length >= MAX_TERMINALS) { try { ws.close(1013, "too many terminals open"); } catch (_) {} return; }
    var homeId = u.searchParams.get("home") || "real";
    var env = Object.assign({}, process.env, { BROWSER: "none", NO_OPEN_BROWSER: "1", TERM: "xterm-256color", KIRO_STATE_DIR: KIRO_POOL_DIR });
    var cwd = KIRO_PROJECT_DIR;
    var real = true;
    if (homeId !== "real") {
      var home = KIRO_CLI_HOMES[homeId];
      if (!home) { try { ws.close(1008, "unknown emulator home: " + homeId); } catch (_) {} return; }
      env.HOME = home.fakeHome;
      real = false;
    }
    var line = (u.searchParams.get("cmd") || "kiro-wrapper").trim();
    var argv = parseArgs(line);
    if (!argv.length) argv = ["kiro-wrapper"];
    if (argv[0] === "kiro-cli") argv[0] = KIRO_CLI;
    if (argv[0] === "kiro-wrapper") argv[0] = KIRO_WRAPPER;
    var cols = Math.min(Math.max(parseInt(u.searchParams.get("cols"), 10) || 120, 20), 500);
    var rows = Math.min(Math.max(parseInt(u.searchParams.get("rows"), 10) || 32, 5), 200);
    var p = pty.spawn(argv[0], argv.slice(1), { name: "xterm-256color", cols: cols, rows: rows, cwd: cwd, env: env });
    var self = { ws: ws, pty: p, homeId: homeId, real: real, created: new Date().toISOString() };
    TERMINALS[p.pid] = self;
    console.log("[monitor] terminal open pid=" + p.pid + " cmd=" + argv.join(" ") + " home=" + (real ? "real" : homeId));
    p.on("data", (d) => { try { ws.send(JSON.stringify({ t: "o", d: d })); } catch (_) {} });
    p.on("exit", (code) => {
      delete TERMINALS[p.pid];
      try { ws.send(JSON.stringify({ t: "x", code: code })); } catch (_) {}
      try { ws.close(1000, "exit " + code); } catch (_) {}
    });
    ws.on("message", (raw) => {
      try {
        var m = JSON.parse(raw.toString());
        if (m.t === "d") p.write(m.d);
        else if (m.t === "r") p.resize(Math.min(Math.max(m.c | 0, 20), 500), Math.min(Math.max(m.r | 0, 5), 200));
      } catch (_) {}
    });
    ws.on("close", () => { if (TERMINALS[p.pid]) { delete TERMINALS[p.pid]; try { p.kill(); } catch (_) {} } });
    ws.on("error", () => { if (TERMINALS[p.pid]) { delete TERMINALS[p.pid]; try { p.kill(); } catch (_) {} } });
    ws.send(JSON.stringify({ t: "ok", home: homeId, real: real, pid: p.pid, cmd: line }));
  } catch (e) {
    console.error("[monitor] terminal error: " + e.message);
    try { ws.close(1011, e.message); } catch (_) {}
  }
}


app.get("/api/email-monitor/kiro/cli/homes", (req, res) => {
  res.json({ homes: Object.values(KIRO_CLI_HOMES).map((h) => ({ id: h.id, created: h.created })) });
});

app.post("/api/email-monitor/kiro/cli/homes", (req, res) => {
  var h = newKiroHome();
  res.json({ homeId: h.id, created: h.created });
});

// ─── Run kiro-cli command (non-interactive) ───
app.post("/api/email-monitor/kiro/cli", express.json(), (req, res) => {
  try {
    var cmd = String((req.body && req.body.cmd) || "whoami").trim();
    var homeId = String((req.body && req.body.homeId) || "real").trim();
    if (!/^[a-zA-Z0-9 _\-./]+$/.test(cmd)) return res.status(400).json({ error: "invalid command" });
    var env = Object.assign({}, process.env, { BROWSER: "none", NO_OPEN_BROWSER: "1", TERM: "dumb", KIRO_STATE_DIR: KIRO_POOL_DIR });
    var cwd = KIRO_PROJECT_DIR;
    if (homeId !== "real") {
      var home = KIRO_CLI_HOMES[homeId];
      if (home) { env.HOME = home.fakeHome; }
    }
    var argv = cmd.split(/\s+/);
    if (argv[0] === "kiro-cli") argv[0] = KIRO_CLI;
    if (argv[0] === "kiro-wrapper") argv[0] = KIRO_WRAPPER;
    var out = execSync([argv[0]].concat(argv.slice(1)).map(a => "'" + a.replace(/'/g, "'\\''") + "'").join(" "), { timeout: 15000, env: env, cwd: cwd, maxBuffer: 1024 * 1024 }).toString();
    var urlMatch = out.match(/https?:\/\/[^\s]+/);
    var codeMatch = out.match(/\b(\d{4,8})\b/);
    res.json({ stdout: out, homeId: homeId, url: urlMatch ? urlMatch[0] : null, code: codeMatch ? codeMatch[1] : null, exitCode: 0 });
  } catch (e) {
    var stderr = (e.stderr || "").toString();
    var stdout = (e.stdout || "").toString();
    res.json({ stdout: stdout + stderr, error: e.message, exitCode: e.status || 1 });
  }
});

// ─── Main kiro-cli account status (uses default HOME) ───
app.get("/api/email-monitor/kiro/whoami", (req, res) => {
  try {
    if (!fs.existsSync(KIRO_CLI)) return res.status(500).json({ error: "kiro-cli not installed" });
    var out = execSync("BROWSER=none timeout 8 " + KIRO_CLI + " whoami 2>&1", { timeout: 12000 }).toString().trim();
    var loggedIn = out.indexOf("Logged in") >= 0;
    var emailMatch = out.match(/Email:\s*(.+)/);
    res.json({ loggedIn: loggedIn, email: emailMatch ? emailMatch[1].trim() : null, raw: out });
  } catch (e) {
    res.json({ loggedIn: false, email: null, raw: e.message });
  }
});

// ─── List kiro account pool dirs ───
app.get("/api/email-monitor/kiro/accounts", (req, res) => {
  try {
    var accounts = [];
    var stateDir = "/home/ghost694/.sessions";
    if (fs.existsSync(stateDir)) {
      var sessions = fs.readdirSync(stateDir);
      for (var i = 0; i < sessions.length; i++) {
        var kiroState = path.join(stateDir, sessions[i], "kiro-state", "accounts");
        if (fs.existsSync(kiroState)) {
          var accts = fs.readdirSync(kiroState);
          for (var j = 0; j < accts.length; j++) {
            accounts.push({ session: sessions[i], account: accts[j] });
          }
        }
      }
    }
    // Also list emulator-created homes
    var emulHomes = Object.values(KIRO_CLI_HOMES).map(function(h) {
      return { session: "emulator", account: h.id };
    });
    res.json({ accounts: accounts, emulatorHomes: emulHomes, total: accounts.length + emulHomes.length });
  } catch (e) {
    res.json({ accounts: [], emulatorHomes: [], total: 0, error: e.message });
  }
});

// ─── Kiro-wrapper account pool ───
app.get("/api/email-monitor/kiro/pool", (req, res) => {
  try {
    var pool = [];
    var currentAccount = "";
    try { currentAccount = fs.readFileSync(path.join(KIRO_POOL_DIR, "current-account"), "utf8").trim(); } catch (_) {}
    if (fs.existsSync(KIRO_ACCOUNTS_DIR)) {
      var dirs = fs.readdirSync(KIRO_ACCOUNTS_DIR);
      for (var i = 0; i < dirs.length; i++) {
        var acctDir = path.join(KIRO_ACCOUNTS_DIR, dirs[i]);
        if (!fs.statSync(acctDir).isDirectory()) continue;
        var loggedIn = false, email = null;
        try {
          var out = execSync("HOME=" + acctDir + " BROWSER=none timeout 5 " + KIRO_CLI + " whoami 2>&1", { timeout: 8000 }).toString().trim();
          loggedIn = out.indexOf("Logged in") >= 0;
          var em = out.match(/Email:\s*(.+)/);
          email = em ? em[1].trim() : null;
        } catch (_) {}
        pool.push({ name: dirs[i], loggedIn: loggedIn, email: email, current: dirs[i] === currentAccount });
      }
    }
    res.json({ pool: pool, current: currentAccount, total: pool.length });
  } catch (e) { res.json({ pool: [], current: "", total: 0, error: e.message }); }
});

app.post("/api/email-monitor/kiro/pool/switch", express.json(), (req, res) => {
  try {
    var name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    var acctDir = path.join(KIRO_ACCOUNTS_DIR, name);
    if (!fs.existsSync(acctDir)) return res.status(404).json({ error: "pool account not found: " + name });
    fs.writeFileSync(path.join(KIRO_POOL_DIR, "current-account"), name);
    res.json({ ok: true, current: name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
