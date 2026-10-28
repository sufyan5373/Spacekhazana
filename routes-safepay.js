/**
 * SpaceKhazana – Payments Router (Safepay)
 * ----------------------------------------------------------------------
 * Replaces routes-payments.js (Stripe). Stripe doesn't support
 * Pakistan-registered merchants — Safepay does, and its hosted checkout
 * offers JazzCash, Easypaisa, and cards side by side without any extra
 * code on our end (those payment methods are toggled on in the Safepay
 * merchant dashboard, not chosen here).
 *
 * Endpoint shape is kept IDENTICAL to the old Stripe router on purpose,
 * so index.html's startCheckout() / handlePaymentRedirect() needed zero
 * functional changes:
 *   POST /api/payments/create-checkout-session   (auth required)
 *   GET  /api/payments/session/:orderId           (auth required)
 *   POST /api/payments/safepay-return              (Safepay → browser redirect, signed)
 *   POST /api/payments/webhook                     (Safepay → server-to-server, signed)
 *
 * Design notes:
 *  - This is a ONE-TIME PAYMENT flow (Safepay's Order API), not a
 *    recurring subscription. A paid tier is granted immediately and does
 *    NOT auto-renew or auto-expire. True recurring billing needs Safepay's
 *    separate Subscriptions/Plans product (a planId per tier, created in
 *    their dashboard) — that's a follow-up, not wired in here.
 *  - No card/wallet credentials ever touch this server — Safepay's hosted
 *    checkout page handles JazzCash MPIN, Easypaisa, and card entry.
 *  - Two independent confirmation paths, both idempotent:
 *      1) safepay-return — the browser lands here after checkout; good for
 *         instant UI feedback, but a closed tab means it never fires.
 *      2) webhook — server-to-server, the real source of truth.
 *    Whichever arrives first provisions the order; the second is a no-op.
 * ----------------------------------------------------------------------
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ─── Safepay client (lazy/guarded init) ─────────────────────────────────
// Same crash-safety pattern as the old Stripe router: constructing the SDK
// with no key must never throw at require-time, or a missing env var
// crash-loops the whole process under PM2. Every route below checks
// requireSafepay() and returns a clean 503 instead.
let safepay = null;
try {
  const { Safepay } = require('@sfpy/node-sdk');
  if (process.env.SAFEPAY_API_KEY) {
    safepay = new Safepay({
      // The SDK's Environment enum compiles down to these exact strings,
      // and isn't exported from the package's main entry point — passing
      // the literal avoids an import that silently resolves to undefined.
      environment: process.env.SAFEPAY_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production',
      apiKey: process.env.SAFEPAY_API_KEY,
      v1Secret: process.env.SAFEPAY_V1_SECRET || '',
      webhookSecret: process.env.SAFEPAY_WEBHOOK_SECRET || '',
    });
  } else {
    console.warn(
      '⚠️  SAFEPAY_API_KEY is not set. Payment routes are disabled and will ' +
      'return 503 until this env var is configured.'
    );
  }
} catch (err) {
  console.warn('⚠️  @sfpy/node-sdk failed to load — run `npm install` after pulling this change.', err.message);
}

function requireSafepay(res) {
  if (!safepay) {
    res.status(503).json({ error: 'Payments are temporarily unavailable. Please try again later.' });
    return false;
  }
  return true;
}

// ─── Subscription tiers ──────────────────────────────────────────────────
// storageLimitGB is what gets written onto the user record on successful
// payment. amountPKR comes from env vars so pricing can change without a
// code deploy — set these on your server (see server-integration notes).
const TIERS = {
  free: {
    name: 'Free',
    storageLimitGB: 5,
    amountPKR: null, // free tier never hits Safepay
  },
  plus: {
    name: 'Plus',
    storageLimitGB: 100,
    amountPKR: parseFloat(process.env.SAFEPAY_PRICE_PLUS_PKR) || null,
  },
  pro: {
    name: 'Pro',
    storageLimitGB: 500,
    amountPKR: parseFloat(process.env.SAFEPAY_PRICE_PRO_PKR) || null,
  },
  premium: {
    name: 'Premium',
    storageLimitGB: 2048,
    amountPKR: parseFloat(process.env.SAFEPAY_PRICE_PREMIUM_PKR) || null,
  },
};

// ─── Local order store ────────────────────────────────────────────────────
// Safepay's Order API doesn't hand us a database — we track our own
// pending/paid orders the same way the rest of this app tracks state:
// a flat JSON file. { orderId, userId, tier, token, amount, status, createdAt, updatedAt }
const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'safepay_orders.json');
const readOrders = () => { try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { return []; } };
const writeOrders = (d) => fs.writeFileSync(ORDERS_FILE, JSON.stringify(d, null, 2), 'utf8');

/**
 * Factory function so this router can reuse your existing data-layer
 * helpers instead of re-implementing user storage. Same interface as the
 * old Stripe router — server.js's mount line barely changes.
 *
 * @param {object} deps
 * @param {Function} deps.readUsers   - () => Array<user>
 * @param {Function} deps.writeUsers  - (users) => void
 * @param {Function} deps.requireAuth - Express middleware, sets req.userId
 */
function createPaymentsRouter({ readUsers, writeUsers, requireAuth }) {
  const router = express.Router();
  const APP_BASE_URL = process.env.APP_BASE_URL || 'https://www.spacekhazana.com';

  // ── 1. Create a Safepay order + hosted checkout link ──────────────────
  router.post(
    '/create-checkout-session',
    express.json(),
    requireAuth,
    async (req, res) => {
      if (!requireSafepay(res)) return;
      try {
        const { tier } = req.body;
        const tierConfig = TIERS[tier];

        if (!tierConfig || !tierConfig.amountPKR) {
          return res.status(400).json({ error: 'Invalid or unsupported subscription tier.' });
        }

        const users = readUsers();
        const user = users.find((u) => u.id === req.userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const orderId = `sk_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        // Step 1: create a payment token for this amount.
        const { token } = await safepay.payments.create({
          amount: tierConfig.amountPKR,
          currency: 'PKR',
        });

        // Step 2: build the hosted checkout link. This is where the buyer
        // picks JazzCash, Easypaisa, or card — that method list is
        // controlled in the Safepay dashboard, not by this code.
        const url = safepay.checkout.create({
          token,
          orderId,
          source: 'custom',
          webhooks: true,
          redirectUrl: `${APP_BASE_URL}/api/payments/safepay-return`,
          cancelUrl: `${APP_BASE_URL}/?payment=cancel`,
        });

        const orders = readOrders();
        orders.push({
          orderId, userId: user.id, tier, token,
          amount: tierConfig.amountPKR, currency: 'PKR',
          status: 'pending', createdAt: Date.now(), updatedAt: Date.now(),
        });
        writeOrders(orders);

        return res.json({ url });
      } catch (err) {
        console.error('create-checkout-session error:', err.message);
        return res.status(500).json({ error: 'Could not start checkout. Please try again.' });
      }
    }
  );

  // ── 2. Confirm order status (used by the success page) ────────────────
  // Mirrors the old Stripe session-lookup shape (status / paymentStatus)
  // so handlePaymentRedirect() in index.html needed no changes.
  router.get('/session/:orderId', requireAuth, (req, res) => {
    const orders = readOrders();
    const order = orders.find((o) => o.orderId === req.params.orderId);
    if (!order || order.userId !== req.userId) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    return res.json({
      status: order.status === 'paid' ? 'complete' : 'open',
      paymentStatus: order.status === 'paid' ? 'paid' : 'pending',
    });
  });

  // ── 3. Browser return — Safepay POSTs the buyer's browser here after
  //      checkout with a signed form body (order_id, reference, tracker,
  //      signature). Good for instant feedback; the webhook below is the
  //      real source of truth. ──────────────────────────────────────────
  router.post(
    '/safepay-return',
    express.urlencoded({ extended: true }),
    (req, res) => {
      if (!safepay) return res.redirect(`${APP_BASE_URL}/?payment=cancel`);

      const isValid = safepay.verify.signature({ body: req.body, headers: req.headers });
      const orderId = req.body.order_id || req.body.orderId;

      if (!isValid || !orderId) {
        console.warn('safepay-return: invalid signature or missing order_id', req.body);
        return res.redirect(`${APP_BASE_URL}/?payment=cancel`);
      }

      const provisioned = provisionOrder({ readUsers, writeUsers, orderId });
      if (!provisioned) return res.redirect(`${APP_BASE_URL}/?payment=cancel`);

      return res.redirect(`${APP_BASE_URL}/?payment=success&session_id=${encodeURIComponent(orderId)}`);
    }
  );

  // ── 4. Server-to-server webhook — the authoritative confirmation, fires
  //      even if the buyer closes the tab before the redirect completes.
  router.post('/webhook', express.json(), (req, res) => {
    if (!safepay) return res.status(503).json({ error: 'Payments unavailable.' });

    const isValid = safepay.verify.webhook({ body: req.body, headers: req.headers });
    if (!isValid) {
      console.warn('webhook: signature verification failed');
      return res.status(400).json({ error: 'Invalid signature.' });
    }

    const orderId = req.body.order_id || req.body.orderId || req.body?.data?.order_id;
    if (!orderId) return res.status(200).json({ received: true }); // ack, nothing to do

    provisionOrder({ readUsers, writeUsers, orderId });
    return res.json({ received: true });
  });

  return router;
}

// ─── Provisioning helper ──────────────────────────────────────────────────
// Idempotent: an order already marked "paid" is left alone, so it's safe
// for both the browser-return route and the webhook to call this for the
// same order without double-granting storage.
function provisionOrder({ readUsers, writeUsers, orderId }) {
  const orders = readOrders();
  const order = orders.find((o) => o.orderId === orderId);
  if (!order) {
    console.error('provisionOrder: unknown orderId', orderId);
    return false;
  }
  if (order.status === 'paid') return true; // already provisioned

  const tierConfig = TIERS[order.tier];
  if (!tierConfig) {
    console.error('provisionOrder: unknown tier on order', order.tier);
    return false;
  }

  const users = readUsers();
  const user = users.find((u) => u.id === order.userId);
  if (!user) {
    console.error('provisionOrder: user not found', order.userId);
    return false;
  }

  user.paymentProvider = 'safepay';
  user.subscriptionTier = order.tier;
  user.subscriptionStatus = 'active';
  user.storageLimitGB = tierConfig.storageLimitGB;
  user.subscriptionUpdatedAt = Date.now();
  writeUsers(users);

  order.status = 'paid';
  order.updatedAt = Date.now();
  writeOrders(orders);

  console.log(`✅ Provisioned "${order.tier}" (${tierConfig.storageLimitGB}GB) for user ${order.userId} via Safepay`);
  return true;
}

module.exports = { createPaymentsRouter, TIERS };
