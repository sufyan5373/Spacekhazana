/**
 * SpaceKhazana – Payments Router (Stripe)
 * ----------------------------------------------------------------------
 * Handles:
 *   POST /api/payments/create-checkout-session   (auth required)
 *   POST /api/payments/webhook                    (Stripe signature verified)
 *   GET  /api/payments/session/:sessionId          (auth required — for the
 *                                                    success page to confirm state)
 *
 * Design notes:
 *  - No card data ever touches this server. Stripe Checkout hosts the
 *    entire payment form; we only create a Session and consume webhooks.
 *  - The webhook route MUST receive the raw request body (not JSON-parsed)
 *    because Stripe's signature is computed over the exact raw bytes.
 *    See server-integration.md for where this router must be mounted
 *    relative to your existing `app.use(express.json(...))` call.
 *  - Storage quota provisioning is idempotent: re-delivered webhooks
 *    (Stripe retries on non-2xx) will not double-grant storage.
 * ----------------------------------------------------------------------
 */

const express = require('express');
const Stripe = require('stripe');

// ─── Stripe client (lazy/guarded init) ──────────────────────────────────
// Constructing Stripe with no apiKey throws synchronously, and since this
// happens at module-require time, it used to crash the whole process on
// boot (PM2 crash-loop) whenever STRIPE_SECRET_KEY wasn't set yet.
// Fix: log a warning and leave `stripe` as null instead of throwing. Every
// route below checks for that via requireStripe() and returns a clean 503
// rather than letting the app die.
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
} else {
  console.warn(
    '⚠️  STRIPE_SECRET_KEY is not set. Payment routes are disabled and will ' +
    'return 503 until this env var is configured.'
  );
}

// Small helper so every handler can bail out the same way.
function requireStripe(res) {
  if (!stripe) {
    res.status(503).json({ error: 'Payments are temporarily unavailable. Please try again later.' });
    return false;
  }
  return true;
}

// ─── Subscription tiers ──────────────────────────────────────────────────
// storageLimitGB is what gets written onto the user record on successful
// payment. priceId must be created in the Stripe Dashboard (Product > Price)
// and referenced via env vars so nothing is hardcoded per-environment.
const TIERS = {
  free: {
    name: 'Free',
    storageLimitGB: 5,
    priceId: null, // free tier never hits Stripe
  },
  plus: {
    name: 'Plus',
    storageLimitGB: 100,
    priceId: process.env.STRIPE_PRICE_PLUS,
  },
  pro: {
    name: 'Pro',
    storageLimitGB: 500,
    priceId: process.env.STRIPE_PRICE_PRO,
  },
  premium: {
    name: 'Premium',
    storageLimitGB: 2048,
    priceId: process.env.STRIPE_PRICE_PREMIUM,
  },
};

/**
 * Factory function so this router can reuse your existing data-layer
 * helpers instead of re-implementing user storage.
 *
 * @param {object} deps
 * @param {Function} deps.readUsers   - () => Array<user>
 * @param {Function} deps.writeUsers  - (users) => void
 * @param {Function} deps.requireAuth - Express middleware, sets req.userId
 */
function createPaymentsRouter({ readUsers, writeUsers, requireAuth }) {
  const router = express.Router();

  // ── 1. Create Checkout Session ─────────────────────────────────────────
  // Body-parsed JSON is fine here — this route is NOT the webhook route.
  router.post(
    '/create-checkout-session',
    express.json(),
    requireAuth,
    async (req, res) => {
      if (!requireStripe(res)) return;
      try {
        const { tier } = req.body;
        const tierConfig = TIERS[tier];

        if (!tierConfig || !tierConfig.priceId) {
          return res.status(400).json({ error: 'Invalid or unsupported subscription tier.' });
        }

        const users = readUsers();
        const user = users.find((u) => u.id === req.userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        // Reuse an existing Stripe customer if we already created one for
        // this user, so Stripe's dashboard/history stays consolidated.
        let customerId = user.stripeCustomerId;
        if (!customerId) {
          const customer = await stripe.customers.create({
            email: user.email || undefined,
            name: user.username,
            metadata: { spacekhazanaUserId: user.id },
          });
          customerId = customer.id;
          user.stripeCustomerId = customerId;
          writeUsers(users);
        }

        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer: customerId,
          line_items: [{ price: tierConfig.priceId, quantity: 1 }],
          // SpaceKhazana's frontend (index.html) is a single-page app with no
          // client-side router, so we redirect back to the root with a query
          // param instead of a dedicated /payment/success path. See
          // handlePaymentRedirect() in index.html, called from enterApp().
          success_url: `${process.env.APP_BASE_URL}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.APP_BASE_URL}/?payment=cancel`,
          // client_reference_id + metadata: two independent ways to recover
          // the user/tier in the webhook, in case one is ever stripped.
          client_reference_id: user.id,
          metadata: {
            spacekhazanaUserId: user.id,
            tier,
          },
          subscription_data: {
            metadata: {
              spacekhazanaUserId: user.id,
              tier,
            },
          },
        });

        return res.json({ url: session.url });
      } catch (err) {
        console.error('create-checkout-session error:', err.message);
        return res.status(500).json({ error: 'Could not start checkout. Please try again.' });
      }
    }
  );

  // ── 2. Confirm session status (used by the success page) ──────────────
  // Optional but recommended: don't trust the redirect alone, since a user
  // can land on /payment/success without ever completing payment (back
  // button, manually typed URL, etc). The webhook is still the source of
  // truth for provisioning — this is purely for UI feedback.
  router.get('/session/:sessionId', express.json(), requireAuth, async (req, res) => {
    if (!requireStripe(res)) return;
    try {
      const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
      if (session.client_reference_id !== req.userId) {
        return res.status(403).json({ error: 'Session does not belong to this user.' });
      }
      return res.json({
        status: session.status, // 'complete' | 'open' | 'expired'
        paymentStatus: session.payment_status, // 'paid' | 'unpaid' | 'no_payment_required'
      });
    } catch (err) {
      console.error('session lookup error:', err.message);
      return res.status(404).json({ error: 'Session not found.' });
    }
  });

  // ── 3. Webhook ──────────────────────────────────────────────────────────
  // express.raw() is REQUIRED here — Stripe signs the exact raw bytes of
  // the body. If express.json() runs first, req.body becomes a parsed
  // object and signature verification will always fail.
  router.post(
    '/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      if (!requireStripe(res)) return;
      const signature = req.headers['stripe-signature'];
      let event;

      try {
        event = stripe.webhooks.constructEvent(
          req.body, // raw Buffer
          signature,
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      try {
        switch (event.type) {
          case 'checkout.session.completed': {
            const session = event.data.object;
            await provisionSubscription({
              readUsers,
              writeUsers,
              userId: session.client_reference_id || session.metadata?.spacekhazanaUserId,
              tier: session.metadata?.tier,
              stripeCustomerId: session.customer,
              stripeSubscriptionId: session.subscription,
              status: 'active',
            });
            break;
          }

          // Recurring payments: keep quota if renewal succeeds.
          case 'invoice.payment_succeeded': {
            const invoice = event.data.object;
            if (invoice.subscription) {
              await markSubscriptionStatus({
                readUsers,
                writeUsers,
                stripeSubscriptionId: invoice.subscription,
                status: 'active',
              });
            }
            break;
          }

          // Failed renewal — flag the account, don't nuke storage
          // immediately (grace period is a product decision).
          case 'invoice.payment_failed': {
            const invoice = event.data.object;
            if (invoice.subscription) {
              await markSubscriptionStatus({
                readUsers,
                writeUsers,
                stripeSubscriptionId: invoice.subscription,
                status: 'past_due',
              });
            }
            break;
          }

          // Cancellation (user-initiated or dunning exhausted) — downgrade
          // back to Free tier quota.
          case 'customer.subscription.deleted': {
            const subscription = event.data.object;
            await downgradeToFree({
              readUsers,
              writeUsers,
              stripeSubscriptionId: subscription.id,
            });
            break;
          }

          default:
            // Unhandled event types are fine to ignore — just ack them.
            break;
        }

        // Always 200 once verified + processed, so Stripe stops retrying.
        return res.json({ received: true });
      } catch (err) {
        console.error(`Webhook handler error for ${event.type}:`, err);
        // 500 tells Stripe to retry — appropriate for a transient DB/write error.
        return res.status(500).json({ error: 'Webhook handler failed.' });
      }
    }
  );

  return router;
}

// ─── Provisioning helpers ────────────────────────────────────────────────

/**
 * Grants the paid tier's storage quota to a user. Idempotent: if the user
 * is already on this subscription with this tier, it's a no-op write.
 */
async function provisionSubscription({ readUsers, writeUsers, userId, tier, stripeCustomerId, stripeSubscriptionId, status }) {
  const tierConfig = TIERS[tier];
  if (!userId || !tierConfig) {
    console.error('provisionSubscription: missing userId or unknown tier', { userId, tier });
    return;
  }

  const users = readUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) {
    console.error('provisionSubscription: user not found', userId);
    return;
  }

  user.stripeCustomerId = stripeCustomerId || user.stripeCustomerId;
  user.stripeSubscriptionId = stripeSubscriptionId || user.stripeSubscriptionId;
  user.subscriptionTier = tier;
  user.subscriptionStatus = status;
  user.storageLimitGB = tierConfig.storageLimitGB;
  user.subscriptionUpdatedAt = Date.now();

  writeUsers(users);
  console.log(`✅ Provisioned "${tier}" (${tierConfig.storageLimitGB}GB) for user ${userId}`);
}

async function markSubscriptionStatus({ readUsers, writeUsers, stripeSubscriptionId, status }) {
  const users = readUsers();
  const user = users.find((u) => u.stripeSubscriptionId === stripeSubscriptionId);
  if (!user) {
    console.warn('markSubscriptionStatus: no user for subscription', stripeSubscriptionId);
    return;
  }
  user.subscriptionStatus = status;
  user.subscriptionUpdatedAt = Date.now();
  writeUsers(users);
}

async function downgradeToFree({ readUsers, writeUsers, stripeSubscriptionId }) {
  const users = readUsers();
  const user = users.find((u) => u.stripeSubscriptionId === stripeSubscriptionId);
  if (!user) {
    console.warn('downgradeToFree: no user for subscription', stripeSubscriptionId);
    return;
  }
  user.subscriptionTier = 'free';
  user.subscriptionStatus = 'canceled';
  user.storageLimitGB = TIERS.free.storageLimitGB;
  user.subscriptionUpdatedAt = Date.now();
  writeUsers(users);
  console.log(`⬇️  Downgraded user ${user.id} to Free after subscription cancellation`);
}

module.exports = { createPaymentsRouter, TIERS };