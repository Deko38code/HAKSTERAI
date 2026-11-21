'use strict';

/**
 * haksterAi Stripe → License Integration
 * 
 * Wires existing Stripe price IDs to the license system.
 * When a customer pays, Stripe webhook auto-generates a license key,
 * saves to DB, and returns it to the checkout session.
 * 
 * Does NOT touch existing Stripe code — this is additive.
 */

const crypto = require('crypto');

// Generate license key: HAK-XXXX-XXXX-XXXX-XXXX
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

// Map Stripe price IDs to plan names
function priceIdToPlan(priceId) {
  const map = {
    [process.env.STRIPE_PRICE_FREE || 'free']: { plan: 'free', maxMachines: 1 },
    [process.env.STRIPE_PRICE_STARTER_MONTHLY || 'starter']: { plan: 'starter', maxMachines: 1 },
    [process.env.STRIPE_PRICE_PRO_MONTHLY || 'pro_m']: { plan: 'pro', maxMachines: 3 },
    [process.env.STRIPE_PRICE_PRO_YEARLY || 'pro_y']: { plan: 'pro', maxMachines: 3 },
    [process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY || 'ent_m']: { plan: 'enterprise', maxMachines: 10 },
    [process.env.STRIPE_PRICE_ENTERPRISE_YEARLY || 'ent_y']: { plan: 'enterprise', maxMachines: 10 },
  };
  return map[priceId] || { plan: 'starter', maxMachines: 1 };
}

/**
 * Initialize license tables in the existing SQLite DB
 */
function initLicenseTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      key TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'starter',
      max_machines INTEGER DEFAULT 1,
      active INTEGER DEFAULT 1,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS license_machines (
      key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      activated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (key, fingerprint),
      FOREIGN KEY (key) REFERENCES licenses(key)
    );
  `);
  console.log(' ✓ License tables initialized');
}

/**
 * Create a license after successful Stripe payment
 */
function createLicense(db, { email, plan, maxMachines, stripeCustomerId, stripeSubscriptionId, expiresAt }) {
  const key = generateLicenseKey();
  db.prepare(`
    INSERT INTO licenses (key, email, plan, max_machines, active, stripe_customer_id, stripe_subscription_id, expires_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `).run(key, email, plan, maxMachines, stripeCustomerId || null, stripeSubscriptionId || null, expiresAt || null);
  return key;
}

/**
 * Verify a license key + machine fingerprint
 * Called by the CLI/TUI at startup via POST /api/license/verify
 */
function verifyLicense(db, key, fingerprint) {
  if (!key || !fingerprint) {
    return { valid: false, reason: 'Missing key or fingerprint' };
  }

  const license = db.prepare('SELECT * FROM licenses WHERE key = ? AND active = 1').get(key);
  if (!license) {
    return { valid: false, reason: 'Key not found or deactivated' };
  }

  // Check expiry
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return { valid: false, reason: 'License expired' };
  }

  // Check machine bindings
  const machines = db.prepare('SELECT * FROM license_machines WHERE key = ?').all(key);
  const registered = machines.map(m => m.fingerprint);

  if (registered.includes(fingerprint)) {
    return { valid: true, plan: license.plan, email: license.email };
  }

  if (registered.length >= license.max_machines) {
    return { valid: false, reason: `Machine limit reached (${license.max_machines}). Contact support@haksterai.com` };
  }

  // Register this machine
  db.prepare('INSERT INTO license_machines (key, fingerprint) VALUES (?, ?)').run(key, fingerprint);
  return { valid: true, plan: license.plan, email: license.email };
}

/**
 * Deactivate a license (refund/cancel)
 */
function deactivateLicense(db, key) {
  db.prepare('UPDATE licenses SET active = 0 WHERE key = ?').run(key);
}

/**
 * Stripe webhook handler — called when payment succeeds
 * Wire this to: app.post('/api/stripe/webhook', stripeWebhookHandler)
 */
function stripeWebhookHandler(db, stripeInstance) {
  return async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripeInstance.webhooks.constructEvent(
        req.rawBody || JSON.stringify(req.body),
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('[stripe-webhook] Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`[stripe-webhook] Event: ${event.type}`);

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const email = session.customer_details?.email || session.customer_email;
          const priceId = session.metadata?.priceId || '';
          const { plan, maxMachines } = priceIdToPlan(priceId);

          if (plan === 'free') {
            console.log('[stripe-webhook] Free plan, no license needed');
            break;
          }

          // Calculate expiry (30 days for monthly, 365 for yearly)
          const expiresAt = new Date();
          if (plan === 'pro' && priceId.includes('yearly')) {
            expiresAt.setDate(expiresAt.getDate() + 365);
          } else if (plan === 'enterprise' && priceId.includes('yearly')) {
            expiresAt.setDate(expiresAt.getDate() + 365);
          } else {
            expiresAt.setDate(expiresAt.getDate() + 30);
          }

          const key = createLicense(db, {
            email,
            plan,
            maxMachines,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            expiresAt: expiresAt.toISOString(),
          });

          console.log(`[stripe-webhook] License created: ${key} for ${email} (${plan})`);

          // TODO: Send email with license key
          // For now, store in session metadata so frontend can display it
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const license = db.prepare('SELECT * FROM licenses WHERE stripe_subscription_id = ?').get(sub.id);
          if (license) {
            deactivateLicense(db, license.key);
            console.log(`[stripe-webhook] License deactivated: ${license.key}`);
          }
          break;
        }

        case 'customer.subscription.updated': {
          const sub = event.data.object;
          const license = db.prepare('SELECT * FROM licenses WHERE stripe_subscription_id = ?').get(sub.id);
          if (license) {
            // Update expiry
            const expiresAt = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
            db.prepare('UPDATE licenses SET expires_at = ? WHERE key = ?').run(expiresAt, license.key);
            console.log(`[stripe-webhook] License renewed: ${license.key}, expires: ${expiresAt}`);
          }
          break;
        }

        case 'charge.refunded': {
          const charge = event.data.object;
          const license = db.prepare('SELECT * FROM licenses WHERE stripe_customer_id = ?').get(charge.customer);
          if (license) {
            deactivateLicense(db, license.key);
            console.log(`[stripe-webhook] License deactivated (refund): ${license.key}`);
          }
          break;
        }

        default:
          console.log(`[stripe-webhook] Unhandled event: ${event.type}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error('[stripe-webhook] Error processing event:', err);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  };
}

/**
 * Create a Stripe checkout session for a plan
 * Called by the frontend when user clicks "Buy"
 */
function createCheckoutSession(stripeInstance) {
  return async (req, res) => {
    const { priceId, email } = req.body;

    if (!priceId) {
      return res.status(400).json({ error: 'Missing priceId' });
    }

    try {
      const session = await stripeInstance.checkout.sessions.create({
        mode: process.env.STRIPE_PRICE_FREE === priceId ? 'payment' : 'subscription',
        customer_email: email,
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { priceId },
        success_url: `${process.env.PUBLIC_URL || 'https://haksterai.com'}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.PUBLIC_URL || 'https://haksterai.com'}/pricing`,
      });

      res.json({ url: session.url });
    } catch (err) {
      console.error('[stripe-checkout] Error:', err);
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  };
}

/**
 * Get license key after successful payment (called from success page)
 */
function getLicenseFromSession(db) {
  return async (req, res) => {
    const { sessionId } = req.query;

    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId' });
    }

    // Look up license by stripe customer
    // The webhook should have already created it
    const Stripe = require('stripe');
 const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const email = session.customer_details?.email;
      
      const license = db.prepare('SELECT * FROM licenses WHERE email = ? ORDER BY created_at DESC LIMIT 1').get(email);
      
      if (license) {
        res.json({ 
          key: license.key, 
          plan: license.plan, 
          email: license.email,
          instructions: `Run: export HAKSTER_LICENSE_KEY=${license.key}` 
        });
      } else {
        res.json({ 
          pending: true, 
          message: 'License is being generated. Check your email shortly.' 
        });
      }
    } catch (err) {
      console.error('[license-lookup] Error:', err);
      res.status(500).json({ error: 'Failed to retrieve license' });
    }
  };
}

module.exports = {
  initLicenseTables,
  createLicense,
  verifyLicense,
  deactivateLicense,
  stripeWebhookHandler,
  createCheckoutSession,
  getLicenseFromSession,
  generateLicenseKey,
};