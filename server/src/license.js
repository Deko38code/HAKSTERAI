'use strict';

/**
 * haksterAi License Verification System
 * 
 * Users must purchase a license key from https://haksterai.com
 * The CLI/TUI/server will not start without a valid key.
 * 
 * License keys are validated against the haksterai.com API.
 * Validation is cached locally for 24 hours for offline use.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const LICENSE_SERVER = 'https://haksterai.com/api/license/verify';
const LICENSE_FILE = path.join(os.homedir(), '.hakster', 'license.json');
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const TRIAL_DURATION = 3 * 24 * 60 * 60 * 1000; // 3-day trial

// Machine fingerprint — ties license to hardware
function getMachineFingerprint() {
  const interfaces = os.networkInterfaces();
  let mac = '';
  for (const iface of Object.values(interfaces)) {
    if (iface && iface[0] && !iface[0].internal) {
      mac = iface[0].mac;
      break;
    }
  }
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${os.hostname()}-${mac}-${os.platform()}-${os.arch()}`)
    .digest('hex');
  return fingerprint;
}

// Read cached license
function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
    return data;
  } catch {
    return null;
  }
}

// Write cached license
function writeCache(data) {
  const dir = path.dirname(LICENSE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2));
}

// Validate license key against server
function validateWithServer(licenseKey, fingerprint) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ key: licenseKey, fingerprint });
    const url = new URL(LICENSE_SERVER);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 10000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data);
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
    req.write(postData);
    req.end();
  });
}

// Check if user has a trial active
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

/**
 * Main license check — call at startup of CLI, TUI, and server
 * @param {boolean} allowTrial - Whether to allow 3-day trial if no key
 * @returns {Promise<{valid: boolean, message: string, trial?: object}>}
 */
async function checkLicense(allowTrial = true) {
  const fingerprint = getMachineFingerprint();
  const cache = readCache();

  // Check for license key in env or cache
  let licenseKey = process.env.HAKSTER_LICENSE_KEY;
  if (!licenseKey && cache && cache.key) {
    licenseKey = cache.key;
  }

  // No key found — check trial
  if (!licenseKey) {
    if (allowTrial) {
      let trial = checkTrial();
      if (trial === null) {
        // First run — start trial
        trial = startTrial();
        return {
          valid: true,
          message: `🎉 Welcome to haksterAi! Your 3-day free trial has started.\n   ${trial.remaining} days remaining.\n   Purchase a license at https://haksterai.com to continue after trial.`,
          trial,
        };
      }
      if (trial.active) {
        return {
          valid: true,
          message: `⏳ Trial active: ${trial.remaining} day(s) remaining.\n   Purchase at https://haksterai.com`,
          trial,
        };
      }
      // Trial expired
      return {
        valid: false,
        message: '❌ Your 3-day trial has expired.\n   Purchase a license at https://haksterai.com\n   Set it with: export HAKSTER_LICENSE_KEY=your-key',
      };
    }
    return {
      valid: false,
      message: '❌ No license key found.\n   Purchase at https://haksterai.com\n   Set it with: export HAKSTER_LICENSE_KEY=your-key',
    };
  }

  // Have a key — check cache first
  if (cache && cache.key === licenseKey && cache.fingerprint === fingerprint) {
    const age = Date.now() - cache.validatedAt;
    if (age < CACHE_DURATION && cache.valid) {
      return {
        valid: true,
        message: '✅ License valid (cached).',
        plan: cache.plan,
        email: cache.email,
      };
    }
  }

  // Validate with server
  try {
    const result = await validateWithServer(licenseKey, fingerprint);
    if (result.valid) {
      writeCache({
        key: licenseKey,
        fingerprint,
        valid: true,
        plan: result.plan,
        email: result.email,
        validatedAt: Date.now(),
      });
      return {
        valid: true,
        message: `✅ License valid — ${result.plan} plan.`,
        plan: result.plan,
        email: result.email,
      };
    } else {
      // Server says invalid — but allow cached grace period
      if (cache && cache.key === licenseKey && cache.valid) {
        const age = Date.now() - cache.validatedAt;
        if (age < CACHE_DURATION * 3) { // 72-hour grace period
          return {
            valid: true,
            message: '⚠️ License server unreachable — using cached validation (grace period).',
            plan: cache.plan,
          };
        }
      }
      return {
        valid: false,
        message: `❌ License invalid: ${result.reason || 'key not recognized'}\n   Purchase at https://haksterai.com`,
      };
    }
  } catch (err) {
    // Server unreachable — use cache if available
    if (cache && cache.key === licenseKey && cache.valid) {
      const age = Date.now() - cache.validatedAt;
      if (age < CACHE_DURATION * 3) { // 72-hour offline grace period
        return {
          valid: true,
          message: '⚠️ License server unreachable — using cached validation (offline grace).',
          plan: cache.plan,
        };
      }
      return {
        valid: false,
        message: '❌ License server unreachable and cache expired.\n   Check your connection or contact support@haksterai.com',
      };
    }
    return {
      valid: false,
      message: `❌ Could not validate license: ${err.message}\n   Try again or contact support@haksterai.com`,
    };
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
  getMachineFingerprint,
  startTrial,
  checkTrial,
};