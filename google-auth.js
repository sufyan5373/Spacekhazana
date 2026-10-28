/* ─── GOOGLE OAUTH ACCOUNT BINDING ────────────────────────────────────────
 * Drop-in module implementing:
 *   1. Google OAuth login + strict 1:1 (googleId ↔ SpaceKhazana account) binding
 *   2. A "Landing Gate" hop after Google verification
 *   3. Mismatch detection when a SpaceKhazana account is opened under a
 *      different Google identity than the one active in the browser
 *   4. enforceFeatureAccess middleware to lock down write routes for
 *      mismatched ("restricted") sessions
 *   5. /api/session/status for the frontend nag modal
 *
 * NOTE ON ARCHITECTURE: the spec this was requested against assumed Prisma
 * + express-session. SpaceKhazana's actual server.js uses flat JSON files
 * (users.json, sessions.json) and opaque bearer tokens (x-auth-token) — the
 * same pattern already powers the existing device-restriction feature
 * (`restrictedSessions`, `blockIfDeviceRestricted`). This module mirrors
 * that exact pattern instead of introducing a second, incompatible auth
 * stack. If you actually want Prisma/Postgres down the line, the shape of
 * the data below (a `googleId`/`googleEmail` pair per user, unique) ports
 * over directly.
 *
 * Requires: npm install google-auth-library
 * Env vars: GOOGLE_CLIENT_ID=<your OAuth web client id>.apps.googleusercontent.com
 * ────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
if (!GOOGLE_CLIENT_ID) {
    console.warn('[google-auth] GOOGLE_CLIENT_ID is not set — /api/auth/google will reject every request.');
}
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/**
 * @param {object} deps
 * @param {() => Array}            deps.readUsers        - existing readUsers() from server.js
 * @param {(users: Array) => void} deps.writeUsers        - existing writeUsers() from server.js
 * @param {(token: string, userId: string) => void} deps.sessionSet - existing sessionSet()
 * @param {() => string}           deps.generateToken     - existing generateToken()
 * @param {(req, name: string) => string|null} deps.getCookie - existing manual cookie reader
 * @param {(req,res,next)=>void}   deps.requireAuth       - existing requireAuth middleware
 * @param {object}                 deps.sessions           - existing in-memory `sessions` map (token -> userId)
 * @param {string}                 deps.DATA_DIR           - existing DATA_DIR constant
 * @param {string}                 deps.UPLOADS_DIR        - existing UPLOADS_DIR constant
 * @param {(user: object) => string} [deps.issueDeviceKeyFor] - optional device-key minting hook (see device-key.js); mints a key for newly auto-registered Google accounts too
 */
module.exports = function initGoogleAuth(deps) {
    const { readUsers, writeUsers, sessionSet, generateToken, getCookie, requireAuth, sessions, DATA_DIR, UPLOADS_DIR, issueDeviceKeyFor } = deps;

    // ── "Active Google identity in this browser" store ──────────────────
    // Separate from the SpaceKhazana session store on purpose: a browser
    // can hold a verified Google identity (from the landing gate) BEFORE
    // it has any SpaceKhazana drive session at all, and the two lifetimes
    // don't have to match (Google session outlives a single drive login).
    const GOOGLE_SESSIONS_FILE = path.join(DATA_DIR, 'google-sessions.json');
    const loadGoogleSessions = () => { try { return JSON.parse(fs.readFileSync(GOOGLE_SESSIONS_FILE, 'utf8')); } catch { return {}; } };
    const saveGoogleSessions = (s) => { try { fs.writeFileSync(GOOGLE_SESSIONS_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch (e) { console.error('[google-auth] failed to save google-sessions.json:', e); } };
    const googleSessions = loadGoogleSessions(); // googleSessionToken -> { googleId, googleEmail, createdAt }

    const GOOGLE_SESSION_COOKIE = 'sk_google_session';
    const GOOGLE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    // Drive session tokens (the normal x-auth-token) whose account's
    // googleId does NOT match the googleId currently active in the
    // browser. Mirrors `restrictedSessions` for device-restriction.
    const googleRestrictedSessions = new Set();

    function setGoogleSessionCookie(res, googleSessionToken) {
        res.cookie(GOOGLE_SESSION_COOKIE, googleSessionToken, {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            maxAge: GOOGLE_SESSION_TTL_MS,
            path: '/'
        });
    }

    // Reads the Google identity currently active in this browser, if any.
    // Fails open (returns null) exactly like getDeviceId/touchDevice do
    // when nothing is present — this is a UX/anti-bypass layer, not a
    // hard security boundary, same caveat as the device tracker.
    function getActiveGoogleIdentity(req) {
        const token = getCookie(req, GOOGLE_SESSION_COOKIE);
        if (!token) return null;
        const rec = googleSessions[token];
        if (!rec) return null;
        if (Date.now() - rec.createdAt > GOOGLE_SESSION_TTL_MS) {
            delete googleSessions[token];
            saveGoogleSessions(googleSessions);
            return null;
        }
        return rec;
    }

    function findUserByGoogleId(users, googleId) {
        return users.find(u => u.googleId === googleId);
    }

    function usernameFromEmail(email, users) {
        const base = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 24) || 'user';
        let candidate = base;
        let n = 1;
        const taken = new Set(users.map(u => u.username));
        while (taken.has(candidate)) candidate = `${base}${n++}`;
        return candidate;
    }

    /**
     * Called from the existing /api/auth/login handler (same spot the
     * device-ownership check already runs) right after a normal
     * username/password login succeeds. Compares the account's linked
     * googleId against whatever Google identity is active in this
     * browser and flags the new drive token as restricted on mismatch.
     *
     * Returns { isRestricted, reason } so the login route can fold it
     * into its JSON response the same way it already does for
     * `deviceRestricted`.
     */
    function checkGoogleBinding(req, token, user) {
        const active = getActiveGoogleIdentity(req);

        // No Google identity in this browser at all (user never went
        // through Google sign-in / landing gate) — nothing to compare
        // against, so we fail open. This matches the existing device
        // check's behavior when no x-device-id is sent.
        if (!active) {
            googleRestrictedSessions.delete(token);
            return { isRestricted: false, reason: null };
        }

        // Account has never been linked to any Google identity — no
        // conflict to flag yet (they can link one later); don't punish
        // pre-Google accounts just because a browser happens to have an
        // unrelated Google session open.
        if (!user.googleId) {
            googleRestrictedSessions.delete(token);
            return { isRestricted: false, reason: null };
        }

        if (user.googleId !== active.googleId) {
            googleRestrictedSessions.add(token);
            return { isRestricted: true, reason: 'RESTRICTED_SECONDARY_SESSION' };
        }

        googleRestrictedSessions.delete(token);
        return { isRestricted: false, reason: null };
    }

    // ── Middleware: blocks write/sensitive routes for mismatched sessions ──
    // Apply AFTER requireAuth, e.g.:
    //   app.post('/api/files/upload', requireAuth, enforceFeatureAccess, handler)
    function enforceFeatureAccess(req, res, next) {
        if (req.userToken && googleRestrictedSessions.has(req.userToken)) {
            return res.status(403).json({
                error: 'This action is limited because this account is linked to a different Gmail than the one currently signed in on this browser.',
                code: 'RESTRICTED_SECONDARY_SESSION'
            });
        }
        next();
    }

    // ── Routes ────────────────────────────────────────────────────────────
    const router = express.Router();

    // Step 1: Google OAuth verification + auto-registration + binding.
    // Client sends the ID token credential from Google Identity Services
    // (google.accounts.id.initialize / renderButton -> callback receives
    // { credential }).
    router.post('/api/auth/google', async (req, res) => {
        const { credential } = req.body || {};
        if (!credential) return res.status(400).json({ error: 'Missing Google credential.' });
        if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });

        let payload;
        try {
            const ticket = await oauthClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
            payload = ticket.getPayload();
        } catch (err) {
            return res.status(401).json({ error: 'Invalid or expired Google credential.' });
        }

        if (!payload || !payload.sub || !payload.email) {
            return res.status(401).json({ error: 'Google account did not return the required profile fields.' });
        }
        if (!payload.email_verified) {
            return res.status(403).json({ error: 'Your Google email is not verified.' });
        }

        const googleId = payload.sub;
        const googleEmail = payload.email.toLowerCase();

        const users = readUsers();
        let user = findUserByGoogleId(users, googleId);
        let isNewAccount = false;
        let rawDeviceKey = null;

        if (!user) {
            // Strict 1:1: this Google account has never been linked to any
            // SpaceKhazana account -> auto-register a fresh one and lock
            // the googleId to it immediately.
            const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            user = {
                id: userId,
                username: usernameFromEmail(googleEmail, users),
                passwordHash: null, // Google-only account; can add a password later from settings
                googleId,
                googleEmail,
                googleLinkedAt: Date.now(),
                createdAt: Date.now()
            };
            if (issueDeviceKeyFor) rawDeviceKey = issueDeviceKeyFor(user); // mints user.deviceKeyHash
            users.push(user);
            writeUsers(users);
            fs.mkdirSync(path.join(UPLOADS_DIR, userId), { recursive: true });
            isNewAccount = true;
        }

        // Establish (or refresh) this browser's active Google identity.
        const googleSessionToken = generateToken();
        googleSessions[googleSessionToken] = { googleId, googleEmail, createdAt: Date.now() };
        saveGoogleSessions(googleSessions);
        setGoogleSessionCookie(res, googleSessionToken);

        res.json({
            success: true,
            isNewAccount,
            googleEmail,
            deviceKey: rawDeviceKey, // only set for brand-new accounts — shown once
            redirectTo: '/landing-gate.html'
        });
    });

    // Step 3 (on-demand form): re-check the CURRENT drive session's
    // googleId against whatever Google identity is active in the browser
    // right now. Useful right after landing on drive.html, or to re-verify
    // after switching Google accounts in another tab without forcing a
    // fresh login.
    router.get('/api/auth/verify-drive-login', requireAuth, (req, res) => {
        const users = readUsers();
        const user = users.find(u => u.id === req.userId);
        if (!user) return res.status(401).json({ error: 'Unauthorized. Please log in.' });

        const { isRestricted, reason } = checkGoogleBinding(req, req.userToken, user);
        res.json({
            isRestricted,
            reason,
            driveAccountGoogleEmail: user.googleEmail || null,
            activeGoogleEmail: (getActiveGoogleIdentity(req) || {}).googleEmail || null
        });
    });

    // Step 5 support: single endpoint the frontend polls/reads on load to
    // decide whether to show the red overlay.
    router.get('/api/session/status', requireAuth, (req, res) => {
        const users = readUsers();
        const user = users.find(u => u.id === req.userId);
        const active = getActiveGoogleIdentity(req);
        res.json({
            loggedIn: true,
            username: user ? user.username : null,
            isRestricted: googleRestrictedSessions.has(req.userToken) || !!req.deviceRestricted,
            googleRestricted: googleRestrictedSessions.has(req.userToken),
            deviceRestricted: !!req.deviceRestricted,
            driveAccountGoogleEmail: user ? (user.googleEmail || null) : null,
            activeGoogleEmail: active ? active.googleEmail : null
        });
    });

    return { router, enforceFeatureAccess, checkGoogleBinding, googleRestrictedSessions, getActiveGoogleIdentity };
};
