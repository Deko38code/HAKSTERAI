'use strict';

/**
 * haksterAi License Verification System
 *
 * Entitlement is tied to the user's haksterAi account (the same api_key
 * issued at Google sign-in / `hakster init`), not a separate machine-locked
 * key. The CLI/TUI/server check the account's plan via the real, already-live
 * Stripe checkout+webhook path (users.plan / GET /api/auth/me) — the same
 * system the website dashboard uses. No key to copy-paste, no separate
 * `licenses` table to keep in sync.
 *
 * Users without a paid plan (or not yet signed in) get a local 3-day trial.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

const LICENSE_SERVER = 'https://haksterai.com/api/auth/me';
const CLI_CONFIG_FILE = path.join(os.homedir(), '.hakster', 'config.json');
const CACHE_FILE = path.join(os.homedir(), '.hakster', 'license.json');
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const TRIAL_DURATION = 3 * 24 * 60 * 60 * 1000; // 3-day trial

// Read the CLI's configured API key (set via `hakster init` / Google sign-in)
function readCliApiKey() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CLI_CONFIG_FILE, 'utf8'));
    return cfg.apiKey || null;
  } catch {
    return null;
  }
}

// Read cached account status
function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Write cached account status
function writeCache(data) {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

// Fetch account plan/status from the haksterai.com backend
function fetchAccountStatus(apiKey) {
  return new Promise((resolve, reject) => {
    const url = new URL(LICENSE_SERVER);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 10000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch {
            reject(new Error('Invalid server response'));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('License server timeout'));
    });
    req.end();
  });
}

// Check if user has a local trial active (used pre-signup and for free-plan accounts)
function checkTrial() {
  const trialFile = path.join(os.homedir(), '.hakster', '.trial');
  try {
    const trialStart = parseInt(fs.readFileSync(trialFile, 'utf8'));
    const elapsed = Date.now() - trialStart;
    if (elapsed < TRIAL_DURATION) {
      return { active: true, remaining: Math.ceil((TRIAL_DURATION - elapsed) / (24 * 60 * 60 * 1000)) };
    }
    return { active: false, remaining: 0 };
  } catch {
    return null; // No trial file = never started
  }
}

// Start a new trial
function startTrial() {
  const trialFile = path.join(os.homedir(), '.hakster', '.trial');
  const dir = path.dirname(trialFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(trialFile, Date.now().toString());
  return { active: true, remaining: 3 };
}

// Shared trial gate — used when there's no api key, or the signed-in account is on the free plan
function trialGate(allowTrial, prefix) {
  const lead = prefix ? prefix + '\n   ' : '';
  if (!allowTrial) {
    return { valid: false, message: `❌ ${lead}No paid plan found.\n   Purchase at https://haksterai.com/pricing` };
  }
  let trial = checkTrial();
  if (trial === null) {
    trial = startTrial();
    return {
      valid: true,
      message: `🎉 Welcome to haksterAi! Your 3-day free trial has started.\n   ${trial.remaining} days remaining.\n   ${lead}Purchase a plan at https://haksterai.com/pricing to continue after trial.`,
      trial,
    };
  }
  if (trial.active) {
    return {
      valid: true,
      message: `⏳ ${lead}Trial active: ${trial.remaining} day(s) remaining.\n   Purchase at https://haksterai.com/pricing`,
      trial,
    };
  }
  return {
    valid: false,
    message: `❌ ${lead}Your 3-day trial has expired.\n   Purchase a plan at https://haksterai.com/pricing\n   Then run: hakster init`,
  };
}

/**
 * Main license check — call at startup of CLI, TUI, and server
 * @param {boolean} allowTrial - Whether to allow 3-day trial if not on a paid plan
 * @returns {Promise<{valid: boolean, message: string, plan?: string, email?: string, trial?: object}>}
 */
async function checkLicense(allowTrial = true) {
  const apiKey = readCliApiKey();

  // Not signed in at all — local trial only
  if (!apiKey) {
    return trialGate(allowTrial, 'Not signed in — run `hakster init` after purchasing at https://haksterai.com/pricing.');
  }

  const cache = readCache();

  // Cached account status still fresh — skip the network round trip
  if (cache && cache.apiKey === apiKey) {
    const age = Date.now() - cache.validatedAt;
    if (age < CACHE_DURATION) {
      if (cache.paid) {
        return { valid: true, message: `✅ Signed in — ${cache.plan} plan.`, plan: cache.plan, email: cache.email };
      }
      return trialGate(allowTrial, `Signed in as ${cache.email || 'your account'} (${cache.plan || 'free'} plan).`);
    }
  }

  // Validate against the account backend
  try {
    const { status, data } = await fetchAccountStatus(apiKey);

    if (status === 200 && data && data.user) {
      const { plan, status: acctStatus, email } = data.user;
      const paid = acctStatus === 'active' && (plan === 'pro' || plan === 'enterprise');
      writeCache({ apiKey, paid, plan, email, validatedAt: Date.now() });

      if (paid) {
        return { valid: true, message: `✅ Signed in — ${plan} plan.`, plan, email };
      }
      return trialGate(allowTrial, `Signed in as ${email} (${plan} plan).`);
    }

    // Bad/unknown API key
    return {
      valid: false,
      message: `❌ API key not recognized.\n   Run: hakster init\n   Or purchase a plan at https://haksterai.com/pricing`,
    };
  } catch (err) {
    // Server unreachable — fall back to cached account status if we have one
    if (cache && cache.apiKey === apiKey) {
      const age = Date.now() - cache.validatedAt;
      if (age < CACHE_DURATION * 3) { // 72-hour offline grace period
        if (cache.paid) {
          return { valid: true, message: '⚠️ Server unreachable — using cached account status (grace period).', plan: cache.plan };
        }
        return trialGate(allowTrial, '⚠️ Server unreachable — using cached account status (grace period).');
      }
    }
    return trialGate(allowTrial, `⚠️ Could not verify account (${err.message}).`);
  }
}

/**
 * Express middleware for server-side license check
 */
function licenseMiddleware(req, res, next) {
  // Skip for health checks and license endpoints
  if (req.path === '/health' || req.path === '/api/license') {
    return next();
  }
  // License check is done at server startup, not per-request
  // This middleware is for API consumers if needed later
  next();
}

module.exports = {
  checkLicense,
  licenseMiddleware,
  startTrial,
  checkTrial,
};
