'use strict';

/**
 * haksterAi License Verification API
 * 
 * This endpoint runs on haksterai.com to verify license keys.
 * Deploy this on your website's server.
 * 
 * License keys are stored in a database (PostgreSQL/SQLite).
 * Each key is tied to a machine fingerprint (1 key = 1 machine by default,
 * or N machines for team plans).
 */

const crypto = require('crypto');

// In production, use a real database. This is a simple example.
// CREATE TABLE licenses (
//   key TEXT PRIMARY KEY,
//   email TEXT NOT NULL,
//   plan TEXT NOT NULL DEFAULT 'pro',
//   max_machines INTEGER DEFAULT 1,
//   active BOOLEAN DEFAULT TRUE,
//   created_at TIMESTAMP DEFAULT NOW(),
//   expires_at TIMESTAMP
// );
// 
// CREATE TABLE license_machines (
//   key TEXT REFERENCES licenses(key),
//   fingerprint TEXT NOT NULL,
//   activated_at TIMESTAMP DEFAULT NOW(),
//   PRIMARY KEY (key, fingerprint)
// );

/**
 * Generate a new license key
 * Format: HAK-XXXX-XXXX-XXXX-XXXX
 */
function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = 'HAK';
  for (let i = 0; i < 4; i++) {
    key += '-';
    for (let j = 0; j < 4; j++) {
      key += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  return key;
}

/**
 * Verify a license key against the database
 * Call this from your website API at POST /api/license/verify
 * 
 * Request body: { key: string, fingerprint: string }
 * Response: { valid: boolean, plan?: string, email?: string, reason?: string }
 */
async function verifyLicense(key, fingerprint, db) {
  if (!key || !fingerprint) {
    return { valid: false, reason: 'Missing key or fingerprint' };
  }

  // Look up license
  const license = await db.query('SELECT * FROM licenses WHERE key = $1 AND active = TRUE', [key]);
  if (!license || license.length === 0) {
    return { valid: false, reason: 'Key not found or deactivated' };
  }

  // Check expiry
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return { valid: false, reason: 'License expired' };
  }

  // Check machine count
  const machines = await db.query('SELECT * FROM license_machines WHERE key = $1', [key]);
  const registeredFingerprints = machines.map(m => m.fingerprint);

  if (registeredFingerprints.includes(fingerprint)) {
    // Already registered on this machine — valid
    return { valid: true, plan: license.plan, email: license.email };
  }

  if (registeredFingerprints.length >= license.max_machines) {
    return { valid: false, reason: `Machine limit reached (${license.max_machines}). Contact support to transfer.` };
  }

  // Register this machine
  await db.query('INSERT INTO license_machines (key, fingerprint) VALUES ($1, $2)', [key, fingerprint]);
  return { valid: true, plan: license.plan, email: license.email };
}

/**
 * Express route handler for POST /api/license/verify
 */
function verifyRoute(req, res) {
  const { key, fingerprint } = req.body;
  
  // Simple rate limiting
  const clientIp = req.ip || req.connection.remoteAddress;
  const rateKey = `license_verify_${clientIp}`;
  // In production: use Redis rate limiting (max 10 attempts per minute)
  
  verifyLicense(key, fingerprint, req.app.locals.db)
    .then(result => res.json(result))
    .catch(err => {
      console.error('License verify error:', err);
      res.status(500).json({ valid: false, reason: 'Server error' });
    });
}

/**
 * Express route handler for POST /api/license/activate (website purchase flow)
 * Creates a new license key after payment
 */
function activateRoute(req, res) {
  const { email, plan, paymentId } = req.body;
  
  if (!email || !plan) {
    return res.status(400).json({ error: 'Missing email or plan' });
  }
  
  // Verify payment with Stripe/PayPal
  // const paymentValid = await verifyPayment(paymentId);
  // if (!paymentValid) return res.status(402).json({ error: 'Payment not verified' });
  
  const key = generateLicenseKey();
  
  // Save to database
  // await db.query('INSERT INTO licenses (key, email, plan) VALUES ($1, $2, $3)', [key, email, plan]);
  
  // Send email with license key
  // await sendEmail(email, 'Your haksterAi License', `Your key: ${key}`);
  
  res.json({ 
    key, 
    plan, 
    email,
    message: 'License created. Check your email for the key.' 
  });
}

/**
 * Express route handler for POST /api/license/deactivate
 * Deactivates a license (for refunds or cancellations)
 */
function deactivateRoute(req, res) {
  const { key, adminToken } = req.body;
  
  // Verify admin token
  if (adminToken !== process.env.HAKSTER_ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  // await db.query('UPDATE licenses SET active = FALSE WHERE key = $1', [key]);
  res.json({ success: true, message: 'License deactivated' });
}

module.exports = {
  generateLicenseKey,
  verifyLicense,
  verifyRoute,
  activateRoute,
  deactivateRoute,
};