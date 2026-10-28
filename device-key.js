/* ─── DEVICE ACCESS KEY ────────────────────────────────────────────────────
 * Per-account 128-digit key, generated once at signup, delivered as a
 * downloadable file. Logging in requires this key in addition to the
 * password. If it's missing, the account can't be accessed until the key
 * is recovered via an emailed OTP (reusing the existing send-otp mailer).
 *
 * HONEST LIMITATION, read before wiring this in: a browser cannot watch
 * the user's filesystem and detect the moment they delete a downloaded
 * file — that's outside what any website (or even most desktop apps) can
 * do without installed native software. What this DOES do: the key is
 * required on every login attempt, so the *next* time they try to log in
 * without it, the app knows it's missing and prompts them to recover it.
 * That's the real, deliverable version of "give another message to
 * download it again" — it happens at the next login, not the instant the
 * file is deleted on disk.
 *
 * SECURITY / PRODUCT NOTE: this key becomes a second password. If you
 * make it mandatory with no recovery path, losing the file = permanent
 * account lockout — including for you, testing this. The recovery flow
 * below (username+password prove ownership, then an emailed OTP) exists
 * specifically so that isn't a dead end. Don't remove it without another
 * recovery path in place.
 * ──────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const nodemailer = require('nodemailer'); // already a dependency of server.js

const KEY_LENGTH_DIGITS = 128;

function generateDeviceKey() {
    let digits = '';
    for (let i = 0; i < KEY_LENGTH_DIGITS; i++) digits += crypto.randomInt(0, 10);
    return digits;
}

function hashDeviceKey(rawKey) {
    return crypto.createHash('sha256').update(String(rawKey)).digest('hex');
}

function deviceKeyMatches(user, rawKey) {
    if (!user || !user.deviceKeyHash || !rawKey) return false;
    // Constant-time compare to avoid leaking key-prefix info via timing.
    const a = Buffer.from(hashDeviceKey(rawKey));
    const b = Buffer.from(user.deviceKeyHash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * @param {object} deps
 * @param {() => Array} deps.readUsers
 * @param {(users: Array) => void} deps.writeUsers
 * @param {(token: string, userId: string) => void} deps.sessionSet
 * @param {() => string} deps.generateToken
 * @param {(req,res,next)=>void} deps.requireAuth
 * @param {import('nodemailer').Transporter} deps.mailer
 * @param {string} deps.GMAIL_USER
 */
module.exports = function initDeviceKey(deps) {
    const { readUsers, writeUsers, sessionSet, generateToken, requireAuth, mailer, GMAIL_USER } = deps;
    const express = require('express');
    const router = express.Router();

    // Short-lived recovery OTPs, separate from the signup otpStore in
    // server.js so a stale registration attempt can never satisfy a
    // recovery check or vice versa.
    const recoveryOtpStore = {}; // userId -> { otp, expiresAt }

    function sendRecoveryEmail(email, username, otp) {
        return mailer.sendMail({
            from: `"SpaceKhazana" <${GMAIL_USER}>`,
            to: email,
            subject: 'Recover your SpaceKhazana Device Key',
            html: `
                <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0f0c1b;border-radius:16px;padding:32px;color:white;">
                    <div style="text-align:center;margin-bottom:24px;">
                        <h2 style="color:#a78bfa;margin:0;">SpaceKhazana</h2>
                        <p style="color:rgba(255,255,255,0.6);font-size:13px;margin-top:6px;">Device key recovery</p>
                    </div>
                    <p style="color:rgba(255,255,255,0.85);font-size:15px;">Hi <b>${username}</b>, someone (hopefully you) requested a new device key for your account. Enter this code to confirm and download a replacement key:</p>
                    <div style="background:#1e1b4b;border:1px solid #4a3aff;border-radius:12px;padding:24px;text-align:center;margin:20px 0;">
                        <span style="font-size:40px;font-weight:800;letter-spacing:10px;color:#a78bfa;">${otp}</span>
                    </div>
                    <p style="color:rgba(255,255,255,0.5);font-size:12px;text-align:center;">This code expires in <b>10 minutes</b>. Your old device key will stop working the moment a new one is issued.</p>
                </div>
            `
        });
    }

    // Called from the registration success paths (verify-otp, register,
    // google auto-register) to mint a key for a brand-new user. Returns
    // the RAW key — this is the only time it's ever available; only its
    // hash is persisted.
    function issueDeviceKeyFor(user) {
        const rawKey = generateDeviceKey();
        user.deviceKeyHash = hashDeviceKey(rawKey);
        user.deviceKeyIssuedAt = Date.now();
        return rawKey;
    }

    // Called from /api/auth/login (see server.js integration) BEFORE
    // issuing a session. Returns { ok: true } or { ok: false, code, error }.
    function verifyLoginDeviceKey(user, providedKey) {
        if (!user.deviceKeyHash) return { ok: true }; // account predates this feature — don't lock existing users out
        if (!providedKey) {
            return { ok: false, code: 'DEVICE_KEY_MISSING', error: 'Device key not found. Please download it again to access your account.' };
        }
        if (!deviceKeyMatches(user, providedKey)) {
            return { ok: false, code: 'DEVICE_KEY_INVALID', error: 'This device key does not match your account. Please download the correct key, or recover a new one.' };
        }
        return { ok: true };
    }

    // Step 1 of recovery: prove you own the account (password), then a
    // fresh OTP goes to the account's registered email.
    router.post('/api/auth/device-key/recover', async (req, res) => {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

        const users = readUsers();
        const user = users.find(u => u.username === String(username).trim().toLowerCase());

        // NOTE: reuses the same verifyPassword() exported from server.js in
        // the wiring below — kept out of this module to avoid duplicating
        // the bcrypt/legacy-sha256 upgrade logic that already lives there.
        const verifyPassword = deps.verifyPassword;
        const { ok } = user ? verifyPassword(password, user) : { ok: false };
        if (!user || !ok) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }
        if (!user.email) {
            return res.status(400).json({ error: 'This account has no recovery email on file. Contact support to regain access.' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        recoveryOtpStore[user.id] = { otp, expiresAt: Date.now() + 10 * 60 * 1000 };

        try {
            await sendRecoveryEmail(user.email, user.username, otp);
            res.json({ success: true, message: `A recovery code was sent to ${user.email.replace(/(.{2}).+(@.+)/, '$1***$2')}.` });
        } catch (err) {
            console.error('Device key recovery email error:', err);
            res.status(500).json({ error: 'Failed to send recovery email.' });
        }
    });

    // Step 2 of recovery: confirm the OTP, mint a new key (old one is
    // invalidated the instant this runs), log the user in, and hand back
    // the raw key for immediate download.
    router.post('/api/auth/device-key/recover/confirm', (req, res) => {
        const { username, otp } = req.body || {};
        if (!username || !otp) return res.status(400).json({ error: 'Username and code required.' });

        const users = readUsers();
        const user = users.find(u => u.username === String(username).trim().toLowerCase());
        if (!user) return res.status(401).json({ error: 'Invalid username or code.' });

        const record = recoveryOtpStore[user.id];
        if (!record) return res.status(400).json({ error: 'No recovery in progress for this account. Please start over.' });
        if (Date.now() > record.expiresAt) {
            delete recoveryOtpStore[user.id];
            return res.status(400).json({ error: 'Recovery code expired. Please request a new one.' });
        }
        if (record.otp !== String(otp).trim()) {
            return res.status(400).json({ error: 'Incorrect code.' });
        }
        delete recoveryOtpStore[user.id];

        const rawKey = issueDeviceKeyFor(user);
        writeUsers(users);

        const token = generateToken();
        sessionSet(token, user.id);

        res.json({
            success: true,
            token,
            user: { id: user.id, username: user.username },
            deviceKey: rawKey // shown once — frontend must trigger the download immediately
        });
    });

    return { router, issueDeviceKeyFor, verifyLoginDeviceKey, generateDeviceKey, hashDeviceKey };
};
