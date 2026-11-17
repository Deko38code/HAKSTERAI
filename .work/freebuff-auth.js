"use strict";
/**
 * Freebuff auth for the Email Monitor (parrot / :9191).
 *
 * Mirrors the kiro-cli integration already in this server:
 *   - spawns the REAL freebuff binary (never calls their API directly)
 *   - isolated HOME per session so it never touches real user credentials
 *   - device/approval URL scraped from the CLI's own stdout
 *
 * BAN SAFETY: all traffic to freebuff originates from the genuine CLI, with
 * its own fingerprint + analytics. No custom HTTP client, no scripted API calls.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const FREEBUFF_BIN = process.env.FREEBUFF_BIN || "/home/ghost694/.npm-global/bin/freebuff";
const FB_BASE = path.join(__dirname, "..", "data", "freebuff-accounts");
const PROFILE_PATH = path.join(FB_BASE, "profile.json");

function readProfile() {
  try {
    if (!fs.existsSync(PROFILE_PATH)) return null;
    return JSON.parse(fs.readFileSync(PROFILE_PATH, "utf8"));
  } catch (e) { return null; }
}

function writeProfile(p) {
  try {
    fs.mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 2));
    return true;
  } catch (e) { return false; }
}
const SESSIONS = {}; // id -> {id,url,proc,fakeHome,status,created,email,error}
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7;
const LOGIN_TIMEOUT = 1000 * 60 * 5;

function resolveBin() {
  const cands = [
    FREEBUFF_BIN,
    "/home/ghost694/.npm-global/bin/freebuff",
    "/home/ghost694/.local/bin/freebuff",
    "/usr/local/bin/freebuff",
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return "freebuff";
}

/** Start `freebuff login` in an isolated HOME; resolve with the approval URL. */
function startDeviceFlow(email) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const fakeHome = path.join(FB_BASE, "home-" + Date.now() + "-" + id.slice(0, 8));
    try {
      fs.mkdirSync(path.join(fakeHome, ".config", "manicode"), { recursive: true });
      fs.mkdirSync(path.join(fakeHome, ".config", "codebuff"), { recursive: true });
    } catch (e) { return reject(e); }

    const env = Object.assign({}, process.env, {
      HOME: fakeHome,
      BROWSER: "none",
      NO_OPEN_BROWSER: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    });

    let proc;
    try {
      proc = spawn(resolveBin(), ["login"], { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { return reject(e); }

    const sess = {
      id, url: null, code: null, proc, fakeHome,
      status: "pending", created: Date.now(), email: email || null, error: null,
    };
    SESSIONS[id] = sess;

    let output = "";
    const scan = (d) => {
      output += d.toString();
      if (!sess.url) {
        const m = output.match(/https?:\/\/[^\s"'<>]+/g);
        if (m) {
          const u = m.find((x) => /login|auth|verify|approve/i.test(x)) || m[0];
          if (u) {
            sess.url = u.replace(/[),.]+$/, "");
            const cm = sess.url.match(/auth_code=([A-Za-z0-9_-]+)/);
            if (cm) sess.code = cm[1];
          }
        }
      }
      if (output.length > 20000) output = output.slice(-8000);
    };

    proc.stdout.on("data", scan);
    proc.stderr.on("data", scan);

    proc.on("error", (e) => {
      sess.status = "error";
      sess.error = e.message;
      reject(e);
    });

    proc.on("exit", (code) => {
      if (sess.status !== "pending") return;
      if (code === 0) {
        sess.status = "success";
        const creds = readCreds(fakeHome);
        if (creds && creds.email) sess.email = creds.email;
        if (sess.email) {
          const p = readProfile() || {};
          p.email = sess.email;
          p.lastLoginAt = new Date().toISOString();
          writeProfile(p);
        }
      } else {
        sess.status = "error";
        sess.error = output.trim().slice(-300) || ("freebuff login exited " + code);
      }
    });

    setTimeout(() => {
      if (sess.status === "pending") {
        try { proc.kill("SIGTERM"); } catch (e) {}
        sess.status = "expired";
      }
    }, LOGIN_TIMEOUT).unref();

    const t0 = Date.now();
    const iv = setInterval(() => {
      if (sess.url || sess.status === "error" || Date.now() - t0 > 15000) {
        clearInterval(iv);
        if (sess.url) resolve({ session: sess, url: sess.url, code: sess.code });
        else reject(new Error(sess.error || "freebuff did not print a login URL"));
      }
    }, 200);
  });
}

/** Read identity the CLI wrote into the given HOME.
 *  NOTE: freebuff (manicode) does NOT write credentials.json. Its device
 *  identity lives in .config/manicode/analytics-id.json; settings.json holds
 *  mode/model prefs. Account linkage is via the analytics id.
 */
function readCreds(fakeHome) {
  const mdir = path.join(fakeHome, ".config", "manicode");
  const out = { email: null, id: null, path: null, analyticsId: null };
  try {
    const aidPath = path.join(mdir, "analytics-id.json");
    if (fs.existsSync(aidPath)) {
      const a = JSON.parse(fs.readFileSync(aidPath, "utf8"));
      out.analyticsId = a.id || a.analyticsId || a.uuid || null;
      out.path = aidPath;
      // Some builds stash the account email alongside the id
      out.email = a.email || a.emailAddress || null;
      out.id = out.analyticsId;
    }
  } catch (e) {}
  // Fallback: any legacy codebuff cred files, if a future build adds them
  const legacy = [
    path.join(fakeHome, ".config/codebuff/credentials.json"),
    path.join(fakeHome, ".config/codebuff/auth.json"),
    path.join(fakeHome, ".codebuff/credentials.json"),
  ];
  for (const p of legacy) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      const u = j.user || j;
      out.email = out.email || u.email || u.emailAddress || null;
      out.id = out.id || u.id || u.userId || null;
      out.path = out.path || p;
    } catch (e) {}
  }
  return (out.path || out.email || out.id) ? out : null;
}

function sweep() {
  const now = Date.now();
  for (const k of Object.keys(SESSIONS)) {
    const s = SESSIONS[k];
    if (s.status === "pending" && now - s.created > LOGIN_TIMEOUT) {
      try { s.proc.kill("SIGTERM"); } catch (e) {}
      s.status = "expired";
    }
  }
}

/** Mount routes on the existing express app. */
function mount(app) {
  app.post("/api/freebuff/start", async (req, res) => {
    try {
      const email = (req.body && req.body.email) || null;
      const r = await startDeviceFlow(email);
      res.json({ ok: true, id: r.session.id, url: r.url, code: r.code, email: r.session.email });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/freebuff/status", (req, res) => {
    sweep();
    const s = SESSIONS[req.query.id];
    if (!s) return res.status(404).json({ ok: false, error: "unknown id" });
    res.json({
      ok: true, id: s.id, status: s.status, url: s.url, code: s.code,
      email: s.email, error: s.error,
    });
  });

  app.post("/api/freebuff/cancel", (req, res) => {
    const s = SESSIONS[req.body && req.body.id];
    if (s) { try { s.proc.kill("SIGTERM"); } catch (e) {} delete SESSIONS[s.id]; }
    res.json({ ok: true });
  });

  // Profile: stored email used for auto-start
  app.get("/api/freebuff/profile", (req, res) => {
    res.json({ ok: true, profile: readProfile() });
  });

  app.post("/api/freebuff/profile", async (req, res) => {
    const email = req.body && req.body.email;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
      return res.status(400).json({ ok: false, error: "valid email required" });
    }
    const p = readProfile() || {};
    p.email = String(email).trim();
    p.updatedAt = new Date().toISOString();
    writeProfile(p);
    try {
      const r = await startDeviceFlow(p.email);
      return res.json({ ok: true, profile: p, id: r.session.id, url: r.url, code: r.code, auto: true });
    } catch (e) {
      return res.status(500).json({ ok: false, profile: p, error: e.message });
    }
  });

  // Auto-start from stored profile (no click)
  app.post("/api/freebuff/autostart", async (req, res) => {
    const p = readProfile();
    if (!p || !p.email) return res.status(400).json({ ok: false, error: "no profile email set" });
    try {
      const r = await startDeviceFlow(p.email);
      res.json({ ok: true, id: r.session.id, url: r.url, code: r.code, email: p.email, auto: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/freebuff/accounts", (req, res) => {
    sweep();
    const list = Object.values(SESSIONS).map((s) => ({
      id: s.id, status: s.status, email: s.email, created: s.created, url: s.url,
    }));
    res.json({ ok: true, accounts: list });
  });

  // Warm up at boot: if a profile email is stored, start a flow immediately.
  setTimeout(() => {
    try {
      const p = readProfile();
      if (p && p.email) {
        startDeviceFlow(p.email).then((r) => {
          console.log("[freebuff] auto-start ready:", r.url);
        }).catch((e) => {
          console.error("[freebuff] auto-start failed:", e.message);
        });
      }
    } catch (e) {}
  }, 2000).unref();
}

module.exports = { mount, startDeviceFlow, readCreds, SESSIONS, resolveBin, readProfile, writeProfile };
