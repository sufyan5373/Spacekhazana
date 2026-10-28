/**
 * SpaceKhazana – Ultimate Core Backend Infrastructure Server
 * with Per-User Authentication & Isolated Drive Support
 */

// Load .env (R2 keys, ports, etc.) before anything reads process.env
try { require('dotenv').config(); } catch (e) { console.warn('[env] dotenv not installed (npm install dotenv) - .env was NOT loaded'); }

const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const multer     = require('multer');
const net        = require('net');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const os         = require('os');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const bcrypt     = require('bcryptjs');
// npm install google-auth-library — Google OAuth account-binding (see google-auth.js)
const initGoogleAuth = require('./google-auth');
// Device access key — per-account 128-digit key required at login (see device-key.js)
const initDeviceKey = require('./device-key');
// Encrypted password vault storage for the browser extension (see vault-routes.js)
const initVault = require('./vault-routes');
// npm install @simplewebauthn/server  (v13+) — provides passkey/WebAuthn support
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse
} = require('@simplewebauthn/server');

// ─── WEBAUTHN / PASSKEYS — relying-party config ─────────────────────────────
// rpID must be a registrable domain that matches the origin serving the page
// (www.spacekhazana.com → rpID 'spacekhazana.com' covers it). It can never
// change later without invalidating every passkey already issued. Override
// both via env vars for local development (e.g. rpID 'localhost').
const WEBAUTHN_RP_NAME = process.env.SPACEKHAZANA_RP_NAME || 'SpaceKhazana';
const WEBAUTHN_RP_ID   = process.env.SPACEKHAZANA_RP_ID   || 'spacekhazana.com';
const WEBAUTHN_ORIGIN  = process.env.SPACEKHAZANA_ORIGIN  || 'https://www.spacekhazana.com';

// ─── SECURITY: secrets management ───────────────────────────────────────────
// Every secret below now comes from environment variables instead of being
// hardcoded in source. Hardcoded secrets stop being secret the moment this
// file is shared, backed up, committed, or pasted anywhere — anyone with a
// copy instantly has full access.
//
// For any secret left unset, we auto-generate a strong random value and
// persist it to data/.secrets.json (keep this file private, do not commit
// or share it) so it survives restarts, and we log a warning once so you
// know to move it into a real .env file. Set these explicitly via
// environment variables in production.
// Desktop app: SPACEKHAZANA_DATA points at a writable per-user folder (the
// install folder is read-only on most systems). Falls back to ./data.
const DATA_ROOT = process.env.SPACEKHAZANA_DATA
    ? path.resolve(process.env.SPACEKHAZANA_DATA)
    : path.join(__dirname, 'data');
const SECRETS_FILE = path.join(DATA_ROOT, '.secrets.json');
function loadOrCreateSecrets() {
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch {}
    let changed = false;
    const need = (key, bytes) => {
        if (process.env[key]) return process.env[key];
        if (stored[key]) return stored[key];
        const val = crypto.randomBytes(bytes).toString('hex');
        stored[key] = val;
        changed = true;
        console.warn(`[SECURITY] ${key} not set in environment — generated a random value and saved it to data/.secrets.json. Set it explicitly via environment variables in production.`);
        return val;
    };
    const result = {
        ADMIN_KEY:    need('ADMIN_KEY', 24),
        VAULT_SECRET: need('VAULT_SECRET', 32),
    };
    if (changed) {
        try {
            fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
            fs.writeFileSync(SECRETS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
        } catch (e) { console.error('Could not persist generated secrets:', e.message); }
    }
    return result;
}
const GENERATED_SECRETS = loadOrCreateSecrets();

// ─── STABILITY: never let one failed request take the whole site down ──────
// Without these two handlers, an error thrown inside an async route that
// nobody wraps in try/catch becomes an "unhandled promise rejection" — and
// modern Node's default behaviour for that is to CRASH THE ENTIRE PROCESS,
// not just fail that one request. That's what "1-2 uploads fail and the
// whole site goes offline" actually was: one bad file/thumbnail/request
// killed the Node process, PM2 restarted it a couple seconds later, and
// every other user on the tunnel got dropped in the meantime.
// These two handlers turn a crash into a logged error + a normal failed
// request for just the person who hit it. Keep them as close to the top
// of the file as possible so they're registered before anything else runs.
process.on('uncaughtException', (err) => {
    console.error('[FATAL-CAUGHT] Uncaught exception — server kept running:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL-CAUGHT] Unhandled promise rejection — server kept running:', reason);
});

// ─── Gmail OTP Config ────────────────────────────────────────────────────────
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_PASS = process.env.GMAIL_PASS || '';
if (!GMAIL_USER || !GMAIL_PASS) {
    console.warn('[SECURITY] GMAIL_USER / GMAIL_PASS are not set. OTP emails will fail until you set them as environment variables. Never hardcode email credentials in source.');
}
const mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
});

// In-memory OTP store: { email: { otp, expiresAt, username, password } }
const otpStore = {};

const app         = express();

// ─── Payments (Safepay) — MUST mount before app.use(express.json(...)) below,
//  so the /webhook and /safepay-return sub-routes can read the raw/urlencoded
//  request body Safepay signs. readUsers/writeUsers/requireAuth are function
//  declarations further down this file; referencing them here is safe since
//  they're hoisted.
const { createPaymentsRouter } = require('./routes-safepay');
app.use('/api/payments', createPaymentsRouter({
    readUsers:   (...a) => readUsers(...a),
    writeUsers:  (...a) => writeUsers(...a),
    requireAuth: (...a) => requireAuth(...a)
}));

// Render/Railway/Fly inject PORT; SPACEKHAZANA_PORT still wins for local use.
const PORT        = Number(process.env.SPACEKHAZANA_PORT || process.env.PORT || 3006);
const DATA_DIR    = DATA_ROOT;
// ─── STORAGE PATH — set SPACEKHAZANA_STORAGE env variable to store files
//  anywhere on your PC, e.g.:
//    Windows:  set SPACEKHAZANA_STORAGE=C:\Users\ok\Documents\SpaceKhazana
//    Mac/Linux: export SPACEKHAZANA_STORAGE=/home/ok/SpaceKhazana
//  If not set, defaults to  <server folder>/data/uploads  (original behaviour).
const WINDOWS_USER_ROOT = os.homedir();
const LEGACY_UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DEFAULT_UPLOADS_DIR = fs.existsSync(LEGACY_UPLOADS_DIR)
    ? LEGACY_UPLOADS_DIR
    : path.join(WINDOWS_USER_ROOT, 'SpaceKhazanaUploads');
const UPLOADS_DIR = process.env.SPACEKHAZANA_STORAGE
    ? path.resolve(process.env.SPACEKHAZANA_STORAGE)
    : DEFAULT_UPLOADS_DIR;
const USERS_FILE  = path.join(DATA_DIR, 'users.json');

function ensureDirectory(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) throw new Error(`Storage path is not a directory: ${dir}`);
}

function assertStorageUnderUserRoot(dir) {
    const relative = path.relative(WINDOWS_USER_ROOT, dir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`SPACEKHAZANA_STORAGE must be inside ${WINDOWS_USER_ROOT}. Current value: ${dir}`);
    }
}

[DATA_DIR, UPLOADS_DIR].forEach(d => ensureDirectory(d));
// In Docker/Render the persistent disk lives outside the home folder (e.g. /var/data),
// so the home-folder guard is skipped when SPACEKHAZANA_ALLOW_ANY_STORAGE=true.
if (String(process.env.SPACEKHAZANA_ALLOW_ANY_STORAGE || '').toLowerCase() !== 'true') {
    assertStorageUnderUserRoot(UPLOADS_DIR);
}

// Chunked uploads no longer stage chunks in a separate temp folder -- see
// the /api/files/upload/* handlers below. Each chunk is written directly
// into its final byte offset in the destination file (positional writes),
// so there's no per-chunk temp storage and no "stitch it all together at
// the end" pass to wait through after the transfer finishes.

const jf  = n   => path.join(DATA_DIR, n + '.json');
const rj  = (n, def) => { try { return JSON.parse(fs.readFileSync(jf(n), 'utf8')); } catch { return def; } };
const wj  = (n, d)   => fs.writeFileSync(jf(n), JSON.stringify(d, null, 2), 'utf8');

// Per-user node store helpers
const userNodesFile = (uid) => path.join(DATA_DIR, `nodes_${uid}.json`);
// CLOUD-ONLY: files that live on this PC's disk (legacy 'local' uploads) are never
// listed, counted against quota, or served. Their entries stay untouched in the
// JSON file (merged back on every write) so nothing is lost if you ever migrate them.
const isLocalDiskFile = (n) => !!n && !n.isFolder &&
    (n.storageProvider === 'local' || (!n.storageProvider && typeof n.storagePath === 'string' && n.storagePath.startsWith('/uploads/')));
const readAllNodesRaw = (uid) => { try { return JSON.parse(fs.readFileSync(userNodesFile(uid), 'utf8')); } catch { return []; } };
const readUserNodes = (uid) => readAllNodesRaw(uid).filter(n => !isLocalDiskFile(n));
const writeUserNodes = (uid, d) => {
    const ids = new Set(d.map(n => n && n.id));
    const hidden = readAllNodesRaw(uid).filter(n => isLocalDiskFile(n) && !ids.has(n.id));
    fs.writeFileSync(userNodesFile(uid), JSON.stringify(d.concat(hidden), null, 2), 'utf8');
};

// Shared files store: { sharedId, nodeId, ownerId, ownerUsername, recipientId, sharedAt, name, fileType, byteSize, storagePath }
const SHARED_FILE  = path.join(DATA_DIR, 'shared.json');
const readShared   = () => { try { return JSON.parse(fs.readFileSync(SHARED_FILE, 'utf8')); } catch { return []; } };
const writeShared  = (d) => fs.writeFileSync(SHARED_FILE, JSON.stringify(d, null, 2), 'utf8');

// Trash store: per-user trash items with deletedAt timestamp
const trashFile = (uid) => path.join(DATA_DIR, `trash_${uid}.json`);
const readTrash  = (uid) => { try { return JSON.parse(fs.readFileSync(trashFile(uid), 'utf8')); } catch { return []; } };
const writeTrash = (uid, d) => fs.writeFileSync(trashFile(uid), JSON.stringify(d, null, 2), 'utf8');

// Auto-purge trash items older than 3 days every hour
const TRASH_TTL_MS = 3 * 24 * 60 * 60 * 1000;
function purgeExpiredTrash() {
    const now = Date.now();
    const users = readUsers();
    users.forEach(u => {
        let trash = readTrash(u.id);
        const toDelete = trash.filter(t => now - t.deletedAt > TRASH_TTL_MS);
        toDelete.forEach(t => {
            purgeNodeFile(t);
        });
        trash = trash.filter(t => now - t.deletedAt <= TRASH_TTL_MS);
        writeTrash(u.id, trash);
    });
}
setInterval(purgeExpiredTrash, 60 * 60 * 1000);
setTimeout(purgeExpiredTrash, 5000); // also run shortly after boot

// Initialize users store
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2), 'utf8');
const readUsers = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; } };
const writeUsers = (d) => fs.writeFileSync(USERS_FILE, JSON.stringify(d, null, 2), 'utf8');

// ─── AFFILIATE PROGRAM ───────────────────────────────────────────────────
//  One record per user, stored in data/affiliates.json:
//  { userId, code, clicks, referrals, earnings, pending, createdAt }
const AFFILIATES_FILE = path.join(DATA_DIR, 'affiliates.json');
const readAffiliates  = () => { try { return JSON.parse(fs.readFileSync(AFFILIATES_FILE, 'utf8')); } catch { return []; } };
const writeAffiliates = (d) => fs.writeFileSync(AFFILIATES_FILE, JSON.stringify(d, null, 2), 'utf8');

// Withdrawal requests — one row per payout request an affiliate makes.
// { id, userId, method: 'JazzCash'|'EasyPaisa', account, amount, status: 'pending'|'paid'|'rejected', note, requestedAt, updatedAt }
const AFF_WITHDRAWALS_FILE = path.join(DATA_DIR, 'affiliate_withdrawals.json');
const readAffWithdrawals   = () => { try { return JSON.parse(fs.readFileSync(AFF_WITHDRAWALS_FILE, 'utf8')); } catch { return []; } };
const writeAffWithdrawals  = (d) => fs.writeFileSync(AFF_WITHDRAWALS_FILE, JSON.stringify(d, null, 2), 'utf8');

// Ledger — append-only activity feed backing the "tracking" view on the
// affiliate dashboard: every commission earned and every withdrawal state
// change gets one row here, newest first when read.
// { id, userId, type: 'signup' | 'withdraw_requested' | 'withdraw_paid' | 'withdraw_rejected', amount, note, createdAt }
const AFF_LEDGER_FILE = path.join(DATA_DIR, 'affiliate_ledger.json');
const readAffLedger    = () => { try { return JSON.parse(fs.readFileSync(AFF_LEDGER_FILE, 'utf8')); } catch { return []; } };
const writeAffLedger   = (d) => fs.writeFileSync(AFF_LEDGER_FILE, JSON.stringify(d, null, 2), 'utf8');
function logAffiliateEvent(userId, type, amount, note) {
  const ledger = readAffLedger();
  ledger.push({ id: crypto.randomBytes(8).toString('hex'), userId, type, amount, note: note || '', createdAt: Date.now() });
  writeAffLedger(ledger);
}

// Ads board — a shared, peer-to-peer space on the affiliate dashboard
// sidebar where an affiliate can post a promo link (their own referral
// link, a landing page, a banner URL, whatever) for every other affiliate
// to see and click. No payment or approval flow — just a flat shared
// list, same storage pattern as the rest of this feature.
// { id, userId, username, title, url, note, createdAt }
const AFF_ADS_FILE = path.join(DATA_DIR, 'affiliate_ads.json');
const readAffAds    = () => { try { return JSON.parse(fs.readFileSync(AFF_ADS_FILE, 'utf8')); } catch { return []; } };
const writeAffAds   = (d) => fs.writeFileSync(AFF_ADS_FILE, JSON.stringify(d, null, 2), 'utf8');
const AFF_AD_MAX_PER_USER = 5; // cap so the board can't be spammed by a single affiliate

function isSafeHttpUrl(u) {
    try {
        const parsed = new URL(u);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch { return false; }
}

const AFFILIATE_COMMISSION  = 5;  // credited to the referrer's pending balance per new signup
const AFF_MIN_WITHDRAWAL    = 20; // smallest payout an affiliate can request
const AFF_PAYOUT_METHODS    = ['JazzCash', 'EasyPaisa'];
const AFF_ACCOUNT_REGEX     = /^03\d{9}$/; // Pakistani mobile wallet account number

function makeAffiliateCode(username, existingCodes) {
    const base = String(username || 'AFF').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase() || 'AFF';
    let code;
    do { code = base + Math.floor(100 + Math.random() * 900); } while (existingCodes.has(code));
    return code;
}

function getOrCreateAffiliate(userId, username) {
    const affiliates = readAffiliates();
    let aff = affiliates.find(a => a.userId === userId);
    if (aff) return aff;
    aff = {
        userId, code: makeAffiliateCode(username, new Set(affiliates.map(a => a.code))),
        clicks: 0, referrals: 0, earnings: 0, pending: 0, createdAt: Date.now()
    };
    affiliates.push(aff);
    writeAffiliates(affiliates);
    return aff;
}

// No cookie-parser middleware is mounted, so cookies are read manually here.
function getCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    const hit = header.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
    return hit ? decodeURIComponent(hit.split('=')[1]) : null;
}

// Called right after a brand-new account is created — credits whoever
// referred them (tracked via the sk_ref cookie set by /ref) with a pending
// commission. Silently no-ops if there's no valid referral cookie.
function creditReferralIfAny(req, res, newUserId) {
    const refCode = getCookie(req, 'sk_ref');
    if (!refCode) return;
    const affiliates = readAffiliates();
    const aff = affiliates.find(a => a.code.toUpperCase() === refCode.toUpperCase());
    if (!aff || aff.userId === newUserId) return;
    aff.referrals += 1;
    aff.earnings  += AFFILIATE_COMMISSION;
    aff.pending   += AFFILIATE_COMMISSION;
    writeAffiliates(affiliates);
    logAffiliateEvent(aff.userId, 'signup', AFFILIATE_COMMISSION, 'New referral signed up');
    res.clearCookie('sk_ref', { path: '/' });
}

// ─── SESSIONS — persisted to disk so they survive server restarts ───────────
//  File: data/sessions.json  →  { "token": "userId", ... }
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function loadSessions() {
    try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; }
}
function saveSessions(s) {
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch (e) { console.error('Failed to save sessions:', e); }
}

// In-memory map, hydrated from disk on boot
const sessions = loadSessions();

// Wrap set / delete so every change is immediately persisted
function sessionSet(token, userId) {
    sessions[token] = userId;
    saveSessions(sessions);
}
function sessionDelete(token) {
    delete sessions[token];
    restrictedSessions.delete(token);
    saveSessions(sessions);
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── DEVICE TRACKING — one account per device (best-effort deterrent) ─────
//  File: data/devices.json → { "<deviceId>": { ownerId, ownerUsername,
//    registeredAt, seenUserIds: [userId, ...] } }
//
//  IMPORTANT: this is NOT a security boundary. deviceId comes from a
//  cookie/localStorage value the client sends us — anyone who clears site
//  data, uses a private window, or switches browsers gets a fresh one.
//  Treat this purely as friction against casual multi-accounting, not as
//  something to rely on for abuse-proofing.
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');

function loadDevices() {
    try { return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')); } catch { return {}; }
}
function saveDevices(d) {
    try { fs.writeFileSync(DEVICES_FILE, JSON.stringify(d, null, 2), 'utf8'); } catch (e) { console.error('Failed to save devices:', e); }
}
const devices = loadDevices();

// Tokens whose account is NOT the "owner" account of the device they logged
// in from. requireAuth reads this into req.deviceRestricted so route
// handlers (and the frontend, via /api/auth/verify) can react to it.
const restrictedSessions = new Set();

function getDeviceId(req) {
    const id = req.headers['x-device-id'];
    return (typeof id === 'string' && id.trim()) ? id.trim().slice(0, 128) : null;
}

// True if this device already has an account tied to it (any account —
// including the one currently logging in). Used to block *creating a new*
// account from an already-claimed device.
function deviceHasAccount(deviceId) {
    return !!(deviceId && devices[deviceId]);
}

// Records that `userId` has signed in on `deviceId`. The first account ever
// seen on a device becomes its "owner". Returns whether userId is that
// owner — false means "you're sharing this device with another account",
// which is what flags the session as restricted.
function touchDevice(deviceId, userId, username) {
    if (!deviceId) return { isOwner: true }; // no device id sent — fail open, can't enforce
    let rec = devices[deviceId];
    if (!rec) {
        rec = { ownerId: userId, ownerUsername: username, registeredAt: Date.now(), seenUserIds: [userId] };
        devices[deviceId] = rec;
        saveDevices(devices);
        return { isOwner: true };
    }
    if (!rec.seenUserIds.includes(userId)) {
        rec.seenUserIds.push(userId);
        saveDevices(devices);
    }
    return { isOwner: rec.ownerId === userId };
}

// Drop this on any route you want soft-locked for restricted sessions.
// Currently wired up to /api/drop-rooms (create) and the music Browse
// publish endpoint below — add it to more routes as you decide what
// "some features" should mean.
function blockIfDeviceRestricted(req, res, next) {
    if (req.deviceRestricted) {
        return res.status(403).json({
            error: 'This feature is limited because another account is already signed in on this device.',
            code: 'DEVICE_RESTRICTED'
        });
    }
    next();
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── WEBAUTHN / PASSKEY CREDENTIAL STORE ────────────────────────────────────
//  File: data/webauthn-credentials.json → array of:
//  { id (base64url credential ID), userId, publicKey (base64), counter,
//    transports, label, createdAt }
const WEBAUTHN_CREDS_FILE = path.join(DATA_DIR, 'webauthn-credentials.json');

function readWebauthnCreds() {
    try { return JSON.parse(fs.readFileSync(WEBAUTHN_CREDS_FILE, 'utf8')); } catch { return []; }
}
function writeWebauthnCreds(creds) {
    try { fs.writeFileSync(WEBAUTHN_CREDS_FILE, JSON.stringify(creds, null, 2), 'utf8'); } catch (e) { console.error('Failed to save webauthn credentials:', e); }
}

// Short-lived challenge stores. Registration challenges are keyed by userId
// (the person is already logged in). Login challenges have no logged-in
// user yet, so they're keyed by a random, one-time challengeId handed to
// the browser and echoed back on verify. Both expire after 5 minutes.
const webauthnRegChallenges   = {}; // userId      -> { challenge, expiresAt }
const webauthnLoginChallenges = {}; // challengeId -> { challenge, expiresAt }
const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function pruneExpired(store) {
    const now = Date.now();
    for (const k of Object.keys(store)) {
        if (store[k].expiresAt < now) delete store[k];
    }
}

// Per-user storage cap: 30 GB
const STORAGE_LIMIT_BYTES = 30 * 1024 * 1024 * 1024;

// Sum all file byteSizes for a user
function getUserUsedBytes(userId) {
    const nodes = readUserNodes(userId);
    return nodes.filter(n => !n.isFolder).reduce((sum, n) => sum + (n.byteSize || 0), 0);
}

// Per-user storage cap in bytes, respecting the individual quota granted by
// an admin override or a paid subscription (see routes-payments.js). Falls
// back to the global 30GB default for users who have neither.
function getUserLimitBytes(userId) {
    const users = readUsers();
    const user = users.find(u => u.id === userId);
    const limitGB = (user && user.storageLimitGB) || 30;
    return limitGB * 1024 * 1024 * 1024;
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

// ─── SECURITY: password hashing ─────────────────────────────────────────
// bcrypt is slow-by-design and salts automatically per password, which is
// what makes it resistant to GPU cracking and rainbow tables. The previous
// approach — SHA-256 with one fixed salt shared by every user — is fast
// enough to brute-force billions of guesses per second and, because the
// salt is a constant baked into this file, precomputed rainbow tables work
// against every account at once. hashLegacySha256 is kept ONLY so existing
// accounts created under the old scheme can still log in; verifyPassword
// upgrades them to bcrypt automatically the moment they do.
function hashPassword(pw) {
    return bcrypt.hashSync(String(pw), 12);
}
function hashLegacySha256(pw) {
    return crypto.createHash('sha256').update(pw + 'spacekhazana_salt_2024').digest('hex');
}
function verifyPassword(pw, user) {
    if (!user || !user.passwordHash) return { ok: false };
    if (user.passwordHash.startsWith('$2')) {
        return { ok: bcrypt.compareSync(String(pw), user.passwordHash) };
    }
    // Legacy sha256 hash: verify against it, then signal the caller to
    // upgrade this user's record to a proper bcrypt hash.
    const ok = user.passwordHash === hashLegacySha256(pw);
    return { ok, upgradeHash: ok ? hashPassword(pw) : null };
}

// Auth middleware
function requireAuth(req, res, next) {
    const token = req.headers['x-auth-token'] || req.query.token;
    if (!token || !sessions[token]) return res.status(401).json({ error: 'Unauthorized. Please log in.' });
    req.userId = sessions[token];
    req.userToken = token;
    req.deviceRestricted = restrictedSessions.has(token);
    next();
}

// ─── DEVICE ACCESS KEY ────────────────────────────────────────────────────
// Initialized before Google auth below so its issueDeviceKeyFor() can be
// handed to the Google auto-register path too.
const deviceKey = initDeviceKey({
    readUsers, writeUsers, sessionSet, generateToken, requireAuth,
    mailer, GMAIL_USER, verifyPassword
});
const { issueDeviceKeyFor, verifyLoginDeviceKey } = deviceKey;
app.use(deviceKey.router);
// ─────────────────────────────────────────────────────────────────────────

// ─── GOOGLE OAUTH ACCOUNT BINDING ────────────────────────────────────────
// See google-auth.js — mirrors the device-restriction pattern above but
// keyed on Google identity instead of device fingerprint.
const googleAuth = initGoogleAuth({
    readUsers, writeUsers, sessionSet, generateToken, getCookie, requireAuth,
    sessions, DATA_DIR, UPLOADS_DIR, issueDeviceKeyFor
});
const { enforceFeatureAccess, checkGoogleBinding } = googleAuth;
app.use(googleAuth.router);
// ─────────────────────────────────────────────────────────────────────────

// ─── PASSWORD VAULT (browser extension) ────────────────────────────────
const vault = initVault({ requireAuth, DATA_DIR });
app.use(vault.router);
// ─────────────────────────────────────────────────────────────────────────

/* ── Storage Configuration ── */
function safeOriginalName(name) {
    const base = path.basename(String(name || 'upload.bin'));
    return base.replace(/[^a-zA-Z0-9._ -]+/g, '_').replace(/\s+/g, ' ').slice(0, 180) || 'upload.bin';
}

function removeUploadedFile(file) {
    if (!file) return;
    if (file.key) {   // object already streamed to R2: delete it again
        deleteR2Key(file.key, file.bucket).catch((err) => console.warn('R2 upload cleanup failed:', err.message));
        return;
    }
    if (!file.path) return;
    fs.unlink(file.path, (err) => {
        if (err && err.code !== 'ENOENT') console.warn('Upload cleanup failed:', err.message);
    });
}

function contentTypeForName(name) {
    const ext = path.extname(String(name || '')).toLowerCase();
    const types = {
        '.mp4': 'video/mp4',
        '.m4v': 'video/mp4',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
        '.ogg': 'video/ogg',
        '.ogv': 'video/ogg',
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.wav': 'audio/wav',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.heic': 'image/heic',
        '.heif': 'image/heif',
        '.bmp': 'image/bmp',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain; charset=utf-8',
        '.json': 'application/json; charset=utf-8'
    };
    return types[ext] || 'application/octet-stream';
}

function resolveLocalUploadPath(storagePath) {
    return null; // CLOUD-ONLY: files on this PC's disk are never resolved or served.
    // eslint-disable-next-line no-unreachable
    if (!storagePath || /^https?:\/\//i.test(storagePath)) return null;
    const rel = String(storagePath).replace(/^\/+/, '').replace(/^uploads[\\/]/, '');
    const resolved = path.resolve(UPLOADS_DIR, rel);
    const root = path.resolve(UPLOADS_DIR);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return resolved;
}

function attachmentName(name) {
    return safeOriginalName(name || 'download.bin').replace(/"/g, '_');
}

function streamLocalFile(req, res, filePath, displayName, options = {}) {
    fs.stat(filePath, (statErr, stat) => {
        if (statErr || !stat.isFile()) {
            if (!res.headersSent) res.status(404).send('File missing on disk.');
            return;
        }

        const total = stat.size;
        const download = options.download === true;
        const contentType = download ? 'application/octet-stream' : contentTypeForName(displayName || filePath);

        if (download) {
            res.setHeader('Content-Disposition', `attachment; filename="${attachmentName(displayName)}"`);
        }

        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', download ? 'no-store' : 'public, max-age=86400');
        res.setHeader('Content-Type', contentType);

        const range = req.headers.range;
        let start = 0;
        let end = total > 0 ? total - 1 : 0;
        let statusCode = 200;

        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match) {
                res.setHeader('Content-Range', `bytes */${total}`);
                return res.status(416).end();
            }

            if (match[1] === '' && match[2] !== '') {
                const suffixLength = Math.min(parseInt(match[2], 10), total);
                start = Math.max(total - suffixLength, 0);
            } else {
                start = parseInt(match[1] || '0', 10);
                if (match[2] !== '') end = parseInt(match[2], 10);
            }

            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= total) {
                res.setHeader('Content-Range', `bytes */${total}`);
                return res.status(416).end();
            }

            end = Math.min(end, total - 1);
            statusCode = 206;
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        } else {
            res.status(200);
        }

        const chunkSize = total === 0 ? 0 : (end - start + 1);
        res.setHeader('Content-Length', chunkSize);

        if (req.method === 'HEAD') return res.end();
        if (total === 0) return res.end();

        const stream = fs.createReadStream(filePath, { start, end });
        let closed = false;

        const cleanup = () => {
            if (closed) return;
            closed = true;
            stream.destroy();
        };

        req.on('aborted', cleanup);
        res.on('close', () => {
            if (!res.writableEnded) cleanup();
        });

        stream.on('error', (err) => {
            console.error('File stream failed:', err.message);
            if (!res.headersSent) res.status(500).send('Could not stream file.');
            else res.destroy(err);
        });

        stream.on('end', () => {
            closed = true;
        });

        stream.pipe(res);
    });
}

// Uploads are streamed straight to Cloudflare R2 -- nothing is written to
// this computer's disk. (createObjectKey is defined further down.)
// --- Cloudflare R2 helpers (built into this file: nothing else to deploy) ---
let _r2ClientSingleton = null;
function r2Client() {
    if (_r2ClientSingleton) return _r2ClientSingleton;
    const { S3Client } = loadS3MultipartSDK();      // 503 with install hint if the SDK is missing
    const cfg = getS3Config();                      // 503 if .env R2 keys are missing
    _r2ClientSingleton = new S3Client({
        region: cfg.region,
        endpoint: cfg.endpoint,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED'
    });
    return _r2ClientSingleton;
}
function deleteR2Key(key, bucket) {
    if (!key) return Promise.resolve();
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    return r2Client().send(new DeleteObjectCommand({ Bucket: bucket || getS3Config().bucket, Key: key }));
}
// Permanent delete of a node's file: R2 object only. Never touches this PC's disk.
// Duplicated / shared copies can point at the same R2 object, so only delete it
// when no other file or trash entry (of any user) still references the key.
function r2KeyStillReferenced(key, exceptId) {
    try {
        for (const u of readUsers()) {
            if (readAllNodesRaw(u.id).some(x => x.storageKey === key && x.id !== exceptId)) return true;
            if (readTrash(u.id).some(x => x.storageKey === key && x.id !== exceptId)) return true;
        }
        return false;
    } catch { return true; }   // when unsure, keep the object
}
function purgeNodeFile(n) {
    if (n && !n.isFolder && n.storageProvider === 's3' && n.storageKey && !r2KeyStillReferenced(n.storageKey, n.id)) {
        deleteR2Key(n.storageKey).catch((e) => console.warn('[R2] delete failed for', n.storageKey, e.message));
    }
}
// multer storage engine: streams the upload body straight to R2, never to disk.
class R2StorageEngine {
    constructor({ getKey }) { this.getKey = getKey; }
    _handleFile(req, file, cb) {
        let client, cfg, key, Upload;
        try {
            ({ Upload } = require('@aws-sdk/lib-storage'));
            client = r2Client(); cfg = getS3Config(); key = this.getKey(req, file);
        } catch (err) {
            if (err && err.code === 'MODULE_NOT_FOUND') { err.status = 503; err.message = 'Missing package. Run: npm install @aws-sdk/lib-storage'; }
            return cb(err);
        }
        const { Transform } = require('stream');
        let size = 0;
        const counter = new Transform({ transform(chunk, _e, done) { size += chunk.length; done(null, chunk); } });
        file.stream.on('error', (err) => counter.destroy(err));
        file.stream.pipe(counter);
        new Upload({
            client,
            params: { Bucket: cfg.bucket, Key: key, Body: counter, ContentType: file.mimetype || 'application/octet-stream' },
            queueSize: 4, partSize: 16 * 1024 * 1024, leavePartsOnError: false
        }).done()
            .then((out) => cb(null, { key, bucket: cfg.bucket, size, etag: out && out.ETag, filename: path.posix.basename(key) }))
            .catch(cb);
    }
    _removeFile(req, file, cb) { deleteR2Key(file.key, file.bucket).then(() => cb(null), () => cb(null)); }
}
const r2Storage = new R2StorageEngine({
    getKey: (req, file) => createObjectKey(req.userId || 'unknown', file.originalname)
});

const upload = multer({
    storage: r2Storage,
    limits: {
        fileSize: Number(process.env.SPACEKHAZANA_MAX_UPLOAD_BYTES || 100 * 1024 ** 3),
        files: 1
    }
});

// ─── Chunked Uploads ───────────────────────────────────────────────────────
// Large files sent as one giant POST are fragile on mobile connections --
// a single dropped packet mid-stream loses the entire request, and there is
// only ever one TCP stream doing the work. Splitting a file into small
// chunks lets a dropped connection cost one small retry instead of the
// whole file, and lets several chunks travel in parallel.
//
// Each chunk is written straight into its final byte offset in the
// destination file via a positional write (pwrite), instead of being
// staged as its own temp file and stitched together afterward. That old
// stitch pass re-read and re-wrote every byte a second time on the local
// disk *after* the transfer had already finished, which is real wall-clock
// time users were sitting through on top of the upload itself -- for a
// multi-GB video that's not negligible. Writing positionally removes that
// second pass entirely: once the last chunk lands, the file is already
// complete.
//
// uploadId -> { userId, filename, fileSize, totalChunks, receivedChunks: Set,
//               parentFolderId, relativePath, contentType, createdAt,
//               destPath, finalName, fd }
// In-memory only, which is fine for a single-process PM2 deployment. If this
// server is ever run with more than one cluster worker, move this to a
// shared store (e.g. a small JSON file or Redis) instead.
const activeChunkUploads = new Map();

function cleanupChunkSession(uploadId, meta, removeFinal) {
    activeChunkUploads.delete(uploadId);
    if (!meta || typeof meta.fd !== 'number') return;
    fs.close(meta.fd, () => {
        if (removeFinal) fs.unlink(meta.destPath, () => {});
    });
}

// Sweep abandoned chunk sessions (tab closed mid-upload, phone locked and
// never came back online, etc.) so partial uploads don't pile up on disk.
const CHUNK_UPLOAD_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
setInterval(() => {
    const now = Date.now();
    for (const [uploadId, meta] of activeChunkUploads.entries()) {
        if (now - meta.createdAt > CHUNK_UPLOAD_TTL_MS) {
            cleanupChunkSession(uploadId, meta, true);
        }
    }
}, 30 * 60 * 1000).unref();

// We're behind Cloudflare Tunnel, so trust the first hop for req.ip / X-Forwarded-For.
// This must be set before any rate limiter is created — otherwise every request
// looks like it comes from the same proxy IP and one visitor could exhaust the
// limit for everyone.
app.set('trust proxy', 1);

// ─── SECURITY: baseline HTTP headers ────────────────────────────────────────
// Sets X-Content-Type-Options, X-Frame-Options, Referrer-Policy, HSTS, removes
// X-Powered-By, etc. CSP is left off by default because index.html relies on
// inline onclick handlers; turning CSP on without first moving those to
// addEventListener would break the app. Enabling a strict CSP is the single
// highest-value follow-up if you do that refactor later.
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' } // uploaded media needs to load from other origins/tabs
}));

const ALLOWED_ORIGINS = new Set([
    'https://spacekhazana.com',
    'https://www.spacekhazana.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
]);
// Frontend origins (e.g. your Vercel domain) come from FRONTEND_ORIGINS,
// comma-separated: https://spacekhazana.vercel.app,https://www.example.com
String(process.env.FRONTEND_ORIGINS || '').split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean)
    .forEach(o => ALLOWED_ORIGINS.add(o));

app.use((req, res, next) => {
    const origin = req.headers.origin;
    // Admin routes are deliberately exempted from the origin allow-list below.
    // They're meant to be called from a local-only admin.html that never gets
    // deployed to the public server — it might be opened as a bare file
    // (Origin: null) or served from some arbitrary local dev port, neither of
    // which can be predicted or added to a fixed allow-list. That's fine: the
    // x-admin-key check in requireAdmin() is the actual security boundary for
    // these routes, not CORS — CORS is a browser-enforced convenience, not a
    // substitute for real auth, so relaxing it here doesn't weaken anything.
    if (req.path.startsWith('/api/admin/')) {
        res.header('Access-Control-Allow-Origin', origin || '*');
        if (origin) res.header('Vary', 'Origin');
    } else if (origin && ALLOWED_ORIGINS.has(origin)) {
        // Only ever echo back an explicitly allow-listed origin. Requests with
        // no Origin header (native apps, curl, server-to-server) aren't
        // browsers, so CORS doesn't apply to them either way — we simply
        // don't set the header, instead of falling back to '*' which used to
        // let ANY website's JS call these APIs using a visitor's token.
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin');
        // Required for credentialed requests (fetch(..., { credentials: 'include' })).
        // Without this, the browser accepts the preflight but then silently
        // discards the actual response on any request that needs cookies to
        // be sent/set cross-origin — which is exactly what /api/auth/google
        // needs to set the sk_google_session cookie from www.spacekhazana.com
        // against api.spacekhazana.com. Safe to set unconditionally here
        // because it only ever applies to origins already on the allow-list,
        // never to the '*' fallback used above for admin routes.
        res.header('Access-Control-Allow-Credentials', 'true');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-auth-token, x-admin-key, Authorization');
    // Lets the PDF viewer (pdf.js) see Content-Range / Content-Length /
    // Accept-Ranges on cross-origin requests so it can stream big PDFs page
    // by page instead of downloading the whole file first.
    res.header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.header('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});
app.use(express.json({ limit: '2mb' }));

// ─── SECURITY: rate limiting ─────────────────────────────────────────────
// General ceiling on all API traffic so no single client can hammer the
// server or run it up a bandwidth/CPU bill.
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    // Chunked uploads (see /api/files/upload/chunk below) can legitimately
    // fire thousands of small requests for a single large video -- counting
    // those against the same 600-request/15-min budget as everything else
    // meant a video big enough to need more than ~600 chunks (well within
    // the file sizes this app is built to support) would start getting
    // 429'd partway through. Retrying doesn't help, since the 15-minute
    // window doesn't reset on the client's timeline, so the upload just
    // stalls or fails outright. That endpoint gets its own limiter below,
    // sized for how chunked uploads actually behave.
    skip: (req) => req.originalUrl.startsWith('/api/files/upload/chunk') ||
                   // Khazana-Hole polls its job every ~0.7s while a song converts; the
                   // router enforces its own per-user limits on search/download.
                   req.originalUrl.startsWith('/api/khazana-hole/jobs'),
    message: { error: 'Too many requests. Please slow down and try again shortly.' }
});
app.use('/api/', apiLimiter);

// Dedicated limiter for chunk uploads. Sized around the largest file this
// app supports (30GB) at the client's current 4MB chunk size (~7,700
// chunks), plus headroom for retries and more than one file per session.
// Still a real ceiling against abuse -- just one that matches how a
// legitimate large upload actually behaves instead of the general one.
const chunkUploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many chunk uploads. Please slow down and try again shortly.' }
});
app.use('/api/files/upload/chunk', chunkUploadLimiter);

// Much tighter limit specifically on auth endpoints — these are the ones a
// hacker would script against to guess passwords or spam OTP emails.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait 15 minutes and try again.' }
});
app.use(['/api/auth/login', '/api/auth/register', '/api/auth/send-otp', '/api/auth/verify-otp'], authLimiter);

// Separate, generous-but-bounded limit on admin routes. The x-admin-key is a
// long random value so guessing it is already infeasible, but this puts a
// hard ceiling on how many guesses per IP are even possible in a 15-minute
// window, on top of that.
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many admin requests from this IP. Please wait and try again.' }
});
app.use('/api/admin/', adminLimiter);

// Per-account brute-force lockout, on top of the per-IP limiter above — this
// stops credential-stuffing even from a botnet spread across many IPs.
const failedLoginAttempts = new Map(); // username -> { count, lockedUntil }
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
function isLoginLocked(username) {
    const rec = failedLoginAttempts.get(username);
    if (!rec) return false;
    if (rec.lockedUntil && rec.lockedUntil > Date.now()) return true;
    if (rec.lockedUntil && rec.lockedUntil <= Date.now()) failedLoginAttempts.delete(username);
    return false;
}
function recordFailedLogin(username) {
    const rec = failedLoginAttempts.get(username) || { count: 0, lockedUntil: 0 };
    rec.count += 1;
    if (rec.count >= LOGIN_MAX_ATTEMPTS) rec.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    failedLoginAttempts.set(username, rec);
}
function clearFailedLogins(username) {
    failedLoginAttempts.delete(username);
}

// PWA files
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});
app.use('/icons', express.static(path.join(__dirname, 'icons')));
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache');
    // Tag the cache VERSION so browsers holding the old cached app shell
    // (which still uploaded to local disk) install a fresh one.
    fs.readFile(path.join(__dirname, 'sw.js'), 'utf8', (err, src) => {
        if (err) return res.status(404).end();
        res.send(src.replace(/const VERSION = '([^']*?)(-r2)?'/, (m, v) => `const VERSION = '${v}-r2'`));
    });
});

// Looks up whether a raw /uploads/<userId>/<filename> path corresponds to a
// node that isn't cleared for serving yet (pending scan, infected, or scan
// error). This route has no auth and serves straight from disk, so without
// this check it would bypass every other scan gate in the app — it's the
// one every <video>/<img> tag hits directly, and exactly the kind of gap
// that would let an unscanned file be reachable during its scan window.
function findNodeByStoragePath(userId, storagePath) {
    return readUserNodes(userId).find(n => n.storagePath === storagePath) || null;
}

// Uploaded asset delivery with explicit HTTP Range support for iOS/Safari media playback.
app.get('/uploads/:userId/:filename', (req, res) => res.status(404).send('Local file serving is disabled. Files are stored in cloud storage.'));
app.get('/__disabled_local_uploads_get/:userId/:filename', (req, res) => {
    const storagePath = `/uploads/${req.params.userId}/${req.params.filename}`;
    const node = findNodeByStoragePath(req.params.userId, storagePath);
    const blockReason = scanBlockReason(node);
    if (blockReason) return res.status(403).send(blockReason);
    const physicalPath = resolveLocalUploadPath(storagePath);
    if (!physicalPath) return res.status(400).send('Invalid storage path.');
    streamLocalFile(req, res, physicalPath, req.params.filename);
});

app.head('/uploads/:userId/:filename', (req, res) => res.status(404).end());
app.head('/__disabled_local_uploads_head/:userId/:filename', (req, res) => {
    const storagePath = `/uploads/${req.params.userId}/${req.params.filename}`;
    const node = findNodeByStoragePath(req.params.userId, storagePath);
    const blockReason = scanBlockReason(node);
    if (blockReason) return res.status(403).end();
    const physicalPath = resolveLocalUploadPath(storagePath);
    if (!physicalPath) return res.status(400).end();
    streamLocalFile(req, res, physicalPath, req.params.filename);
});

// Custom secret admin URL (BEFORE static; @ symbol requires app.use not app.get)
app.use((req, res, next) => {
    if (req.path === '/sufyanadmin53738043115373804iaccessgrantadminpannelusersinfopakistan5373') {
        const p = path.join(__dirname, 'admin.html');
        if (fs.existsSync(p)) return res.sendFile(p);
        return res.redirect('/');
    }
    next();
});

/* ══════════════════════════════════════════════════════════════
   PASSWORD VAULT  –  MUST be before express.static so these
   routes aren't swallowed by the index.html fallback.
   Passwords stored AES-256-GCM encrypted on disk.
   File: data/passwords_<userId>.json
══════════════════════════════════════════════════════════════ */
const VAULT_SECRET = GENERATED_SECRETS.VAULT_SECRET;

function vaultKey(uid) {
    return crypto.createHash('sha256').update(VAULT_SECRET + ':' + uid).digest();
}
function encryptPwd(uid, plain) {
    const iv     = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(uid), iv);
    const enc    = Buffer.concat([cipher.update(String(plain || ''), 'utf8'), cipher.final()]);
    return { iv: iv.toString('hex'), enc: enc.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}
function decryptPwd(uid, iv, enc, tag) {
    try {
        const dc = crypto.createDecipheriv('aes-256-gcm', vaultKey(uid), Buffer.from(iv, 'hex'));
        dc.setAuthTag(Buffer.from(tag, 'hex'));
        return Buffer.concat([dc.update(Buffer.from(enc, 'hex')), dc.final()]).toString('utf8');
    } catch { return ''; }
}
const pwdFile  = (uid) => path.join(DATA_DIR, `passwords_${uid}.json`);
const readPwds = (uid) => { try { return JSON.parse(fs.readFileSync(pwdFile(uid), 'utf8')); } catch { return []; } };
const savePwds = (uid, d) => fs.writeFileSync(pwdFile(uid), JSON.stringify(d, null, 2));
function pwdOut(uid, e) {
    return {
        id: e.id, label: e.label, url: e.url || '', username: e.username || '',
        password: e.iv ? decryptPwd(uid, e.iv, e.enc, e.tag) : '',
        notes: e.notes || '', createdAt: e.createdAt, updatedAt: e.updatedAt
    };
}

// GET /api/passwords — list all (decrypted for the authenticated user only)
app.get('/api/passwords', requireAuth, (req, res) => {
    res.json(readPwds(req.userId).map(e => pwdOut(req.userId, e)));
});

// POST /api/passwords — create
app.post('/api/passwords', requireAuth, (req, res) => {
    const { label, url, username, password, notes } = req.body || {};
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'Label required.' });
    const { iv, enc, tag } = encryptPwd(req.userId, password);
    const entry = {
        id:       `pwd_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        label:    String(label).slice(0, 100),
        url:      String(url      || '').slice(0, 500),
        username: String(username || '').slice(0, 200),
        notes:    String(notes    || '').slice(0, 1000),
        iv, enc, tag,
        createdAt: Date.now(), updatedAt: Date.now()
    };
    const list = readPwds(req.userId);
    list.unshift(entry);
    savePwds(req.userId, list);
    res.json(pwdOut(req.userId, entry));
});

// PUT /api/passwords/:id — update
app.put('/api/passwords/:id', requireAuth, (req, res) => {
    const list  = readPwds(req.userId);
    const entry = list.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found.' });
    const { label, url, username, password, notes } = req.body || {};
    if (label    !== undefined) entry.label    = String(label).slice(0, 100);
    if (url      !== undefined) entry.url      = String(url).slice(0, 500);
    if (username !== undefined) entry.username = String(username).slice(0, 200);
    if (notes    !== undefined) entry.notes    = String(notes).slice(0, 1000);
    if (password !== undefined) {
        const r = encryptPwd(req.userId, password);
        entry.iv = r.iv; entry.enc = r.enc; entry.tag = r.tag;
    }
    entry.updatedAt = Date.now();
    savePwds(req.userId, list);
    res.json(pwdOut(req.userId, entry));
});

// DELETE /api/passwords/:id
app.delete('/api/passwords/:id', requireAuth, (req, res) => {
    const list = readPwds(req.userId);
    if (!list.find(e => e.id === req.params.id))
        return res.status(404).json({ error: 'Entry not found.' });
    savePwds(req.userId, list.filter(e => e.id !== req.params.id));
    res.json({ success: true });
});

// Serve index.html, site.html and admin.html — look in same dir as server.js.
// { index: false } is required here: express.static's default behavior is to
// auto-serve index.html for any '/' or directory request, which would silently
// pre-empt the explicit '/' route below (the one that serves site.html) since
// this middleware is registered first.
// SECURITY: express.static(__dirname) would otherwise serve the whole project
// folder, including data/*.json (users, sessions), server.js and its modules.
app.use((req, res, next) => {
    let p; try { p = decodeURIComponent(req.path).toLowerCase(); } catch { return res.status(400).end(); }
    if (/^\/(data|node_modules|\.git|desktop|mobile|scripts|dist)(\/|$)/.test(p) ||
        /^\/(server|google-auth|device-key|vault-routes|khazana-hole-routes|routes-[\w-]+)\.js$/.test(p) ||
        /^\/package(-lock)?\.json$/.test(p)) return res.status(404).end();
    next();
});
// Installers: always sent as attachments so a click starts a real download.
app.use('/downloads', express.static(path.join(__dirname, 'downloads'), {
    index: false,
    setHeaders: (res, file) => {
        res.setHeader('Cache-Control', 'no-cache');
        if (/\.json$/i.test(file)) return;
        res.setHeader('Content-Disposition', 'attachment');
        if (/\.apk$/i.test(file)) res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    }
}));
app.use(express.static(__dirname, { index: false }));

// Root domain always lands on the marketing/landing page (site.html) first.
// site.html itself checks localStorage for an active session and redirects
// straight through to /app when one exists, so a returning logged-in visitor
// never actually sees the landing page — it's just a redirect hop.
app.get('/', (req, res) => {
    const p = path.join(__dirname, 'site.html');
    if (fs.existsSync(p)) return res.sendFile(p);
    // Fall back to the app directly if site.html hasn't been deployed yet.
    const appPage = path.join(__dirname, 'index.html');
    if (fs.existsSync(appPage)) return res.sendFile(appPage);
    res.send(`
        <html><head><style>
            body{font-family:sans-serif;background:#0f0c1b;color:#e2e0ff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;flex-direction:column;gap:16px;}
            h2{color:#a78bfa;} code{background:#1e1b4b;padding:4px 10px;border-radius:6px;color:#c4b5fd;font-size:14px;}
            p{color:#6b7280;font-size:14px;text-align:center;}
        </style></head><body>
            <h2>🚀 SpaceKhazana Server is Running</h2>
            <p>Place <code>index.html</code> in the same folder as <code>server.js</code><br>then visit this page again.</p>
            <p style="margin-top:8px;">API is live on <code id="api-host-display"></code></p>
            <script>
                const API_HOST = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
                    ? "http://localhost:3006"
                    : \`\${window.location.protocol}//\${window.location.hostname}\`;
                document.getElementById('api-host-display').textContent = API_HOST;
            </script>
        </body></html>
    `);
});

// The actual app (drive, uploads, everything in index.html) lives at /app.
// Reached from site.html once a visitor logs in/signs up, or straight away
// on repeat visits if a session is already saved in localStorage.
app.get('/app', (req, res) => {
    const p = path.join(__dirname, 'index.html');
    if (fs.existsSync(p)) return res.sendFile(p);
    res.redirect('/');
});

app.get('/admin', (req, res) => {
    const p = path.join(__dirname, 'admin.html');
    if (fs.existsSync(p)) return res.sendFile(p);
    res.redirect('/');
});

// Standalone checkout page — reached from the "Upgrade" button in the app.
// Note: as of this deploy, checkout.html is a static frontend only and is
// not yet wired to routes-safepay.js (create-checkout-session etc.) — that
// integration is still to be done.
app.get('/checkout', (req, res) => {
    const p = path.join(__dirname, 'checkout.html');
    if (fs.existsSync(p)) return res.sendFile(p);
    res.redirect('/');
});

// Manual payments (EasyPaisa / JazzCash / IBAN + screenshot, admin-approved).
// See routes-manual-payments.js — edit PLANS and the account details there
// (or via SK_PAY_* env vars). Admin routes live under /api/admin/ so they use
// the same x-admin-key check and CORS handling as the rest of the admin API.
const manualPay = require('./routes-manual-payments')({
    readUsers:    (...a) => readUsers(...a),
    writeUsers:   (...a) => writeUsers(...a),
    requireAuth:  (...a) => requireAuth(...a),
    requireAdmin: (...a) => requireAdmin(...a)
});
app.use('/api/manual-payments', manualPay.userRouter);
app.use('/api/admin/manual-payments', manualPay.adminRouter);

// Affiliate dashboard page — www.spacekhazana.com/affiliate
app.get('/affiliate', (req, res) => {
    const p = path.join(__dirname, 'affiliate.html');
    if (fs.existsSync(p)) return res.sendFile(p);
    res.redirect('/');
});

// Referral click tracker — www.spacekhazana.com/ref?code=USER123
// Increments the affiliate's click count, drops a 30-day cookie so a
// signup that follows gets credited to them, then sends the visitor on
// to the normal homepage.
app.get('/ref', (req, res) => {
    const code = String(req.query.code || '').trim();
    if (code) {
        const affiliates = readAffiliates();
        const aff = affiliates.find(a => a.code.toUpperCase() === code.toUpperCase());
        if (aff) {
            aff.clicks += 1;
            writeAffiliates(affiliates);
            res.cookie('sk_ref', aff.code, { maxAge: 30 * 24 * 60 * 60 * 1000, path: '/', sameSite: 'Lax' });
        }
    }
    res.redirect('/');
});



/* ── AUTH ROUTES ── */

// Send OTP — called before register
app.post('/api/auth/send-otp', async (req, res) => {
    const { email, username, password } = req.body;
    if (!email || !username || !password) return res.status(400).json({ error: 'Email, username and password required.' });

    const trimmedUser = username.trim().toLowerCase();
    if (trimmedUser.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    if (deviceHasAccount(getDeviceId(req))) {
        return res.status(409).json({ error: 'Only one account can be created per device.', code: 'DEVICE_LIMIT' });
    }

    const users = readUsers();
    if (users.find(u => u.username === trimmedUser)) {
        return res.status(409).json({ error: 'Username already taken.' });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    otpStore[email] = { otp, expiresAt, username: trimmedUser, password };

    try {
        await mailer.sendMail({
            from: `"SpaceKhazana" <${GMAIL_USER}>`,
            to: email,
            subject: 'Your SpaceKhazana Verification Code',
            html: `
                <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0f0c1b;border-radius:16px;padding:32px;color:white;">
                    <div style="text-align:center;margin-bottom:24px;">
                        <h2 style="color:#a78bfa;margin:0;">SpaceKhazana</h2>
                        <p style="color:rgba(255,255,255,0.6);font-size:13px;margin-top:6px;">Your personal orbital storage vault</p>
                    </div>
                    <p style="color:rgba(255,255,255,0.85);font-size:15px;">Hi <b>${trimmedUser}</b>, here is your verification code:</p>
                    <div style="background:#1e1b4b;border:1px solid #4a3aff;border-radius:12px;padding:24px;text-align:center;margin:20px 0;">
                        <span style="font-size:40px;font-weight:800;letter-spacing:10px;color:#a78bfa;">${otp}</span>
                    </div>
                    <p style="color:rgba(255,255,255,0.5);font-size:12px;text-align:center;">This code expires in <b>5 minutes</b>. Do not share it with anyone.</p>
                </div>
            `
        });
        res.json({ success: true });
    } catch (err) {
        console.error('OTP email error:', err);
        res.status(500).json({ error: 'Failed to send email. Check server Gmail config.' });
    }
});

// Verify OTP + complete registration
app.post('/api/auth/verify-otp', (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required.' });

    const record = otpStore[email];
    if (!record) return res.status(400).json({ error: 'No OTP found for this email. Please request a new one.' });
    if (Date.now() > record.expiresAt) {
        delete otpStore[email];
        return res.status(400).json({ error: 'OTP has expired. Please register again.' });
    }
    if (record.otp !== otp.toString().trim()) {
        return res.status(400).json({ error: 'Invalid OTP. Please try again.' });
    }

    // OTP correct — create the account
    const deviceId = getDeviceId(req);
    if (deviceHasAccount(deviceId)) {
        delete otpStore[email];
        return res.status(409).json({ error: 'Only one account can be created per device.', code: 'DEVICE_LIMIT' });
    }
    delete otpStore[email];

    const users = readUsers();
    if (users.find(u => u.username === record.username)) {
        return res.status(409).json({ error: 'Username already taken.' });
    }

    const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const token  = generateToken();

    const newUser = {
        id: userId,
        username: record.username,
        email,
        passwordHash: hashPassword(record.password),
        createdAt: Date.now()
    };
    const rawDeviceKey = issueDeviceKeyFor(newUser); // mints newUser.deviceKeyHash
    users.push(newUser);
    writeUsers(users);

    /* cloud-only: no per-user folder on this PC */
    sessionSet(token, userId);
    touchDevice(deviceId, userId, record.username);
    creditReferralIfAny(req, res, userId);

    res.json({
        success: true,
        token,
        user: { id: userId, username: record.username },
        deviceKey: rawDeviceKey // shown once — frontend must trigger the download immediately
    });
});

// Register new user
app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

    const trimmedUser = username.trim().toLowerCase();
    if (trimmedUser.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const deviceId = getDeviceId(req);
    if (deviceHasAccount(deviceId)) {
        return res.status(409).json({ error: 'Only one account can be created per device.', code: 'DEVICE_LIMIT' });
    }

    const users = readUsers();
    if (users.find(u => u.username === trimmedUser)) {
        return res.status(409).json({ error: 'Username already taken.' });
    }

    const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const token  = generateToken();

    const newUser = {
        id: userId,
        username: trimmedUser,
        passwordHash: hashPassword(password),
        createdAt: Date.now()
    };
    // No email on file for this legacy no-OTP path, so the emailed device-key
    // recovery flow won't work for this account until they add one (e.g. via
    // account settings) — flag that in the response so the frontend can warn.
    const rawDeviceKey = issueDeviceKeyFor(newUser);
    users.push(newUser);
    writeUsers(users);

    // Initialize empty drive for new user
    /* cloud-only: no per-user folder on this PC */

    sessionSet(token, userId);
    touchDevice(deviceId, userId, trimmedUser);
    creditReferralIfAny(req, res, userId);

    res.json({
        success: true,
        token,
        deviceKey: rawDeviceKey,
        noRecoveryEmail: true,
        user: { id: userId, username: trimmedUser }
    });
});

// Login existing user
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

    const trimmedUser = username.trim().toLowerCase();

    if (isLoginLocked(trimmedUser)) {
        return res.status(429).json({ error: 'Too many failed attempts on this account. Please try again in 15 minutes.' });
    }

    const users = readUsers();
    const user = users.find(u => u.username === trimmedUser);
    const { ok, upgradeHash } = verifyPassword(password, user);

    if (!user || !ok) {
        recordFailedLogin(trimmedUser);
        return res.status(401).json({ error: 'Invalid username or password.' });
    }
    clearFailedLogins(trimmedUser);

    // Transparently migrate old sha256 hashes to bcrypt now that we know the password was correct.
    if (upgradeHash) {
        user.passwordHash = upgradeHash;
        writeUsers(users);
    }

    // Device access key: a hard gate, not a soft restriction — no key (or
    // the wrong key), no session. req.body.deviceKey is the 128-digit
    // string read client-side from the downloaded .skkey file.
    const deviceKeyCheck = verifyLoginDeviceKey(user, req.body.deviceKey);
    if (!deviceKeyCheck.ok) {
        return res.status(401).json({ error: deviceKeyCheck.error, code: deviceKeyCheck.code });
    }

    const token = generateToken();
    sessionSet(token, user.id);

    const deviceId = getDeviceId(req);
    const { isOwner } = touchDevice(deviceId, user.id, user.username);
    if (isOwner) restrictedSessions.delete(token);
    else restrictedSessions.add(token);

    // Google account-binding check (step 3 of the Google OAuth spec): flags
    // this drive session as restricted if Account A's linked googleId
    // doesn't match whatever Google identity is currently active in this
    // browser (e.g. signed into Gmail B via the landing gate).
    const { isRestricted: googleRestricted, reason: googleRestrictedReason } = checkGoogleBinding(req, token, user);

    res.json({
        success: true,
        token,
        user: { id: user.id, username: user.username },
        deviceRestricted: !isOwner,
        googleRestricted,
        googleRestrictedReason
    });
});

// Logout
app.post('/api/auth/logout', requireAuth, (req, res) => {
    sessionDelete(req.userToken);
    res.json({ success: true });
});

// Verify token
app.get('/api/auth/verify', requireAuth, (req, res) => {
    const users = readUsers();
    const user = users.find(u => u.id === req.userId);
    res.json({
        valid: true,
        user: { id: req.userId, username: user?.username },
        deviceRestricted: req.deviceRestricted,
        googleRestricted: googleAuth.googleRestrictedSessions.has(req.userToken)
    });
});

/* ── WEBAUTHN / PASSKEYS ── */

// List the logged-in user's registered passkeys.
app.get('/api/webauthn/credentials', requireAuth, (req, res) => {
    const creds = readWebauthnCreds().filter(c => c.userId === req.userId);
    res.json({
        credentials: creds.map(c => ({ id: c.id, label: c.label, createdAt: c.createdAt }))
    });
});

// Remove one of the logged-in user's passkeys.
app.delete('/api/webauthn/credentials/:id', requireAuth, (req, res) => {
    const creds = readWebauthnCreds();
    const next = creds.filter(c => !(c.id === req.params.id && c.userId === req.userId));
    if (next.length === creds.length) return res.status(404).json({ error: 'Passkey not found.' });
    writeWebauthnCreds(next);
    res.json({ success: true });
});

// Step 1 of adding a passkey to the logged-in account: generate a challenge.
app.post('/api/webauthn/register-options', requireAuth, async (req, res) => {
    const users = readUsers();
    const user = users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const existing = readWebauthnCreds().filter(c => c.userId === req.userId);

    const options = await generateRegistrationOptions({
        rpName: WEBAUTHN_RP_NAME,
        rpID: WEBAUTHN_RP_ID,
        userID: new TextEncoder().encode(user.id),
        userName: user.username,
        attestationType: 'none',
        excludeCredentials: existing.map(c => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
    });

    pruneExpired(webauthnRegChallenges);
    webauthnRegChallenges[req.userId] = { challenge: options.challenge, expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS };

    res.json(options);
});

// Step 2: verify the browser's attestation and save the new credential.
app.post('/api/webauthn/register-verify', requireAuth, async (req, res) => {
    const pending = webauthnRegChallenges[req.userId];
    if (!pending || pending.expiresAt < Date.now()) {
        return res.status(400).json({ error: 'Passkey setup expired. Please try again.' });
    }

    let verification;
    try {
        verification = await verifyRegistrationResponse({
            response: req.body.response,
            expectedChallenge: pending.challenge,
            expectedOrigin: WEBAUTHN_ORIGIN,
            expectedRPID: WEBAUTHN_RP_ID
        });
    } catch (err) {
        return res.status(400).json({ error: 'Could not verify the passkey: ' + err.message });
    }

    delete webauthnRegChallenges[req.userId];
    if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: 'Passkey verification failed.' });
    }

    const { credential } = verification.registrationInfo;
    const creds = readWebauthnCreds();
    creds.push({
        id: credential.id,
        userId: req.userId,
        publicKey: Buffer.from(credential.publicKey).toString('base64'),
        counter: credential.counter,
        transports: credential.transports || [],
        label: 'Passkey',
        createdAt: Date.now()
    });
    writeWebauthnCreds(creds);

    res.json({ success: true });
});

// Step 1 of signing in with a passkey: no username needed (discoverable
// credential), just hand back a challenge the browser's authenticator can
// answer with whichever resident key matches this site.
app.post('/api/webauthn/login-options', async (req, res) => {
    const options = await generateAuthenticationOptions({
        rpID: WEBAUTHN_RP_ID,
        userVerification: 'preferred'
    });

    const challengeId = generateToken();
    pruneExpired(webauthnLoginChallenges);
    webauthnLoginChallenges[challengeId] = { challenge: options.challenge, expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS };

    res.json({ options, challengeId });
});

// Step 2: verify the assertion, identify the credential's owner, and log
// them in exactly like a password login would.
app.post('/api/webauthn/login-verify', async (req, res) => {
    const { challengeId, response } = req.body;
    const pending = challengeId && webauthnLoginChallenges[challengeId];
    if (!pending || pending.expiresAt < Date.now()) {
        return res.status(400).json({ error: 'Passkey sign-in expired. Please try again.' });
    }

    const creds = readWebauthnCreds();
    const stored = creds.find(c => c.id === (response && response.id));
    if (!stored) return res.status(400).json({ error: 'That passkey is not registered here.' });

    let verification;
    try {
        verification = await verifyAuthenticationResponse({
            response,
            expectedChallenge: pending.challenge,
            expectedOrigin: WEBAUTHN_ORIGIN,
            expectedRPID: WEBAUTHN_RP_ID,
            credential: {
                id: stored.id,
                publicKey: Buffer.from(stored.publicKey, 'base64'),
                counter: stored.counter,
                transports: stored.transports
            }
        });
    } catch (err) {
        return res.status(400).json({ error: 'Could not verify the passkey: ' + err.message });
    }

    delete webauthnLoginChallenges[challengeId];
    if (!verification.verified) return res.status(400).json({ error: 'Passkey verification failed.' });

    // Replay protection: persist the authenticator's new signature counter.
    stored.counter = verification.authenticationInfo.newCounter;
    writeWebauthnCreds(creds);

    const users = readUsers();
    const user = users.find(u => u.id === stored.userId);
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const token = generateToken();
    sessionSet(token, user.id);

    const deviceId = getDeviceId(req);
    const { isOwner } = touchDevice(deviceId, user.id, user.username);
    if (isOwner) restrictedSessions.delete(token);
    else restrictedSessions.add(token);

    res.json({
        success: true,
        token,
        user: { id: user.id, username: user.username },
        deviceRestricted: !isOwner
    });
});

/* ── AFFILIATE PROGRAM ── */

// GET own affiliate profile (auto-creates one on first visit)
app.get('/api/affiliate/me', requireAuth, (req, res) => {
    const users = readUsers();
    const user = users.find(u => u.id === req.userId);
    const aff = getOrCreateAffiliate(req.userId, user?.username || 'affiliate');
    const conversionRate = aff.clicks > 0 ? +(aff.referrals / aff.clicks * 100).toFixed(1) : 0;
    res.json({ ...aff, username: user?.username, conversionRate });
});

// POST a custom referral keyword, e.g. { keyword: "NOVA25" }
app.post('/api/affiliate/code', requireAuth, (req, res) => {
    const clean = String((req.body && req.body.keyword) || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 20);
    if (clean.length < 3) return res.status(400).json({ error: 'Keyword must be at least 3 letters/numbers.' });

    const affiliates = readAffiliates();
    const mine = affiliates.find(a => a.userId === req.userId);
    if (!mine) return res.status(404).json({ error: 'Affiliate profile not found.' });
    if (affiliates.some(a => a.code.toUpperCase() === clean && a.userId !== req.userId)) {
        return res.status(409).json({ error: 'That keyword is already taken — try another.' });
    }
    mine.code = clean;
    writeAffiliates(affiliates);
    res.json({ success: true, code: mine.code });
});

// GET leaderboard of all affiliates, ranked by revenue generated
app.get('/api/affiliate/overview', requireAuth, (req, res) => {
    const users = readUsers();
    const rows = readAffiliates()
        .map(a => ({
            username: users.find(u => u.id === a.userId)?.username || 'unknown',
            code: a.code, clicks: a.clicks, referrals: a.referrals, earnings: a.earnings,
            createdAt: a.createdAt, isYou: a.userId === req.userId
        }))
        .sort((a, b) => b.earnings - a.earnings)
        .slice(0, 50);
    res.json(rows);
});

// GET own activity feed — commissions earned + withdrawal state changes,
// newest first. Backs the "tracking" section of the affiliate dashboard.
app.get('/api/affiliate/ledger', requireAuth, (req, res) => {
    const rows = readAffLedger()
        .filter(l => l.userId === req.userId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 100);
    res.json(rows);
});

// GET own withdrawal history, newest first
app.get('/api/affiliate/withdrawals', requireAuth, (req, res) => {
    const rows = readAffWithdrawals()
        .filter(w => w.userId === req.userId)
        .sort((a, b) => b.requestedAt - a.requestedAt);
    res.json(rows);
});

// POST a withdrawal request — { method: 'JazzCash'|'EasyPaisa', account: '03XXXXXXXXX', amount }
// Deducts from the affiliate's pending balance immediately so the same
// balance can't be requested twice while a payout is awaiting review; a
// rejection by an admin refunds it (see the admin route below).
app.post('/api/affiliate/withdraw', requireAuth, (req, res) => {
    const { method, account, amount } = req.body || {};
    const amt = Number(amount);

    if (!AFF_PAYOUT_METHODS.includes(method)) {
        return res.status(400).json({ error: 'Choose JazzCash or EasyPaisa.' });
    }
    if (!AFF_ACCOUNT_REGEX.test(String(account || '').trim())) {
        return res.status(400).json({ error: 'Enter a valid mobile account number, e.g. 03XXXXXXXXX.' });
    }
    if (!amt || amt <= 0) {
        return res.status(400).json({ error: 'Enter a withdrawal amount greater than 0.' });
    }
    if (amt < AFF_MIN_WITHDRAWAL) {
        return res.status(400).json({ error: `Minimum withdrawal is $${AFF_MIN_WITHDRAWAL}.` });
    }

    const affiliates = readAffiliates();
    const aff = affiliates.find(a => a.userId === req.userId);
    if (!aff) return res.status(404).json({ error: 'Affiliate profile not found.' });
    if (amt > aff.pending) {
        return res.status(400).json({ error: `You can withdraw up to your pending balance of $${aff.pending.toFixed(2)}.` });
    }

    aff.pending -= amt;
    writeAffiliates(affiliates);

    const withdrawals = readAffWithdrawals();
    const record = {
        id: crypto.randomBytes(8).toString('hex'),
        userId: req.userId, method, account: String(account).trim(), amount: amt,
        status: 'pending', note: '', requestedAt: Date.now(), updatedAt: Date.now()
    };
    withdrawals.push(record);
    writeAffWithdrawals(withdrawals);
    logAffiliateEvent(req.userId, 'withdraw_requested', amt, `Requested via ${method}`);

    res.json({ success: true, withdrawal: record, pending: aff.pending });
});

// ── Affiliate ads board ── shared across all affiliates, not admin-gated.
// GET the board, newest first. Any authenticated affiliate can browse.
app.get('/api/affiliate/ads', requireAuth, (req, res) => {
    const rows = readAffAds()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(a => ({ ...a, isYou: a.userId === req.userId }));
    res.json(rows);
});

// POST a new ad — { title, url, note }
app.post('/api/affiliate/ads', requireAuth, (req, res) => {
    const title = String((req.body && req.body.title) || '').trim().slice(0, 80);
    const url   = String((req.body && req.body.url) || '').trim();
    const note  = String((req.body && req.body.note) || '').trim().slice(0, 200);

    if (title.length < 3) return res.status(400).json({ error: 'Give your ad a short title (3+ characters).' });
    if (!isSafeHttpUrl(url)) return res.status(400).json({ error: 'Enter a valid link starting with http:// or https://.' });

    const ads = readAffAds();
    if (ads.filter(a => a.userId === req.userId).length >= AFF_AD_MAX_PER_USER) {
        return res.status(400).json({ error: `You can post up to ${AFF_AD_MAX_PER_USER} ads at a time — remove one to add another.` });
    }

    const users = readUsers();
    const user = users.find(u => u.id === req.userId);
    const record = {
        id: crypto.randomBytes(8).toString('hex'),
        userId: req.userId, username: user?.username || 'affiliate',
        title, url, note, createdAt: Date.now()
    };
    ads.push(record);
    writeAffAds(ads);
    res.json({ success: true, ad: { ...record, isYou: true } });
});

// DELETE an ad — affiliates can only remove their own.
app.delete('/api/affiliate/ads/:id', requireAuth, (req, res) => {
    const ads = readAffAds();
    const idx = ads.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Ad not found.' });
    if (ads[idx].userId !== req.userId) return res.status(403).json({ error: 'You can only remove your own ads.' });
    ads.splice(idx, 1);
    writeAffAds(ads);
    res.json({ success: true });
});

// ── Admin: review affiliate withdrawal requests ── protected by x-admin-key
// GET all withdrawals (optionally ?status=pending|paid|rejected), newest first
app.get('/api/admin/affiliate/withdrawals', requireAdmin, (req, res) => {
    const users = readUsers();
    const affiliates = readAffiliates();
    let rows = readAffWithdrawals();
    if (req.query.status) rows = rows.filter(w => w.status === req.query.status);
    rows = rows
        .map(w => ({
            ...w,
            username: users.find(u => u.id === w.userId)?.username || 'unknown',
            code: affiliates.find(a => a.userId === w.userId)?.code || ''
        }))
        .sort((a, b) => b.requestedAt - a.requestedAt);
    res.json(rows);
});

// PUT mark a withdrawal 'paid' or 'rejected'. Rejecting refunds the amount
// back onto the affiliate's pending balance so it can be requested again.
app.put('/api/admin/affiliate/withdrawals/:id', requireAdmin, (req, res) => {
    const { status, note } = req.body || {};
    if (!['paid', 'rejected'].includes(status)) {
        return res.status(400).json({ error: "Status must be 'paid' or 'rejected'." });
    }
    const withdrawals = readAffWithdrawals();
    const record = withdrawals.find(w => w.id === req.params.id);
    if (!record) return res.status(404).json({ error: 'Withdrawal not found.' });
    if (record.status !== 'pending') return res.status(409).json({ error: `Already marked ${record.status}.` });

    record.status = status;
    record.note = note || '';
    record.updatedAt = Date.now();
    writeAffWithdrawals(withdrawals);

    if (status === 'rejected') {
        const affiliates = readAffiliates();
        const aff = affiliates.find(a => a.userId === record.userId);
        if (aff) { aff.pending += record.amount; writeAffiliates(affiliates); }
        logAffiliateEvent(record.userId, 'withdraw_rejected', record.amount, note || 'Withdrawal rejected — refunded to pending');
    } else {
        logAffiliateEvent(record.userId, 'withdraw_paid', record.amount, `Paid via ${record.method}`);
    }

    res.json({ success: true, withdrawal: record });
});

// Change password for the currently logged-in user (self-service — distinct
// from the admin-only PUT /api/admin/users/:userId/password route above).
app.put('/api/account/password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current and new password are required.' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    const users = readUsers();
    const user = users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (!verifyPassword(currentPassword, user).ok) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    user.passwordHash = hashPassword(newPassword);
    writeUsers(users);

    res.json({ success: true });
});

// Storage usage for current user (includes files in "Shared With Me" folder)
app.get('/api/storage/usage', requireAuth, (req, res) => {
    const users  = readUsers();
    const user   = users.find(u => u.id === req.userId);
    const used   = getUserUsedBytes(req.userId);
    const limitBytes = ((user?.storageLimitGB) || 30) * 1024 * 1024 * 1024;
    res.json({ used, limit: limitBytes, available: Math.max(0, limitBytes - used) });
});

/* ── FILE / FOLDER REST APIs (all require auth) ── */

// Get nodes filtered by parent for the logged-in user
// Folders the app itself creates and manages (as opposed to ones the user made).
function isSystemContainerNode(n) {
    return !!(n.sharedInbox || n.sharedOutbox || n.dropRoomFolder ||
              n.musicRoot || n.educationRoot || n.isAlbum || n.isSubject);
}
// Anything in the tree that the user did not create or upload themselves.
function isSystemNode(n) {
    return isSystemContainerNode(n) || !!(n.droppedViaRoomId || n.isYoutube || n.youtubeId || n.sharedFrom);
}

app.get('/api/files', requireAuth, (req, res) => {
    const parentFolderId = req.query.parentFolderId || null;
    const allNodes = readUserNodes(req.userId);
    // My Drive shows only what the user made or uploaded themselves. System-made
    // items (Education/Music roots, albums, subjects, Shared inbox/outbox, drop-room
    // folders, guest uploads, YouTube entries, files shared in by others) are hidden.
    // When the user is *inside* one of those system folders (e.g. a drop-room folder
    // or an Education subject) its contents are listed as-is.
    const parent = parentFolderId ? allNodes.find(n => n.id === parentFolderId) : null;
    const inSystemContainer = !!(parent && isSystemContainerNode(parent));
    const filtered = allNodes.filter(n =>
        n.parentFolderId === parentFolderId && (inSystemContainer || !isSystemNode(n))
    );
    res.json(filtered);
});

// Get all nodes (flat) for the logged-in user — used by search
app.get('/api/files/all', requireAuth, (req, res) => {
    res.json(readUserNodes(req.userId));
});

function resolveUploadParent(userId, parentFolderId, relativePath, allNodes) {
    let resolvedParentId = parentFolderId;
    if (!relativePath || !relativePath.includes('/')) return resolvedParentId;

    const parts = relativePath.split('/').slice(0, -1);
    let currentParent = parentFolderId;

    for (const rawSegment of parts) {
        const segment = safeOriginalName(rawSegment).trim();
        if (!segment) continue;
        let foundFolder = allNodes.find(n => n.isFolder && n.name === segment && n.parentFolderId === currentParent);
        if (!foundFolder) {
            foundFolder = {
                id: `folder_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
                name: segment,
                isFolder: true,
                parentFolderId: currentParent,
                createdAt: Date.now()
            };
            allNodes.push(foundFolder);
        }
        currentParent = foundFolder.id;
    }
    return currentParent;
}

const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac']);

// Formats sharp/libvips can actually decode for a resize. SVG is already
// tiny/vector (no benefit to thumbnailing) so it's served as-is.
// HEIC/HEIF (the default iPhone photo format) IS included: converting it to
// a JPEG thumbnail is what makes it viewable in every browser at all, since
// only Safari/WebKit can decode raw HEIC — Chrome, Firefox, and Android
// can't display it no matter what Content-Type header is sent. If the
// server's sharp/libvips build lacks HEIF support, generation just fails
// and falls back to the raw original (same as before this existed).
const THUMBNAILABLE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif']);

// Thumbnails live in their own cache folder, mirroring the uploads dir
// structure, so they're trivial to wipe/regenerate without touching
// originals and never collide with a real filename.
const THUMBNAILS_DIR = path.join(DATA_DIR, 'thumbnails');
ensureDirectory(THUMBNAILS_DIR);

function loadSharp() {
    try {
        return require('sharp');
    } catch {
        return null;
    }
}

function thumbnailPathFor(userId, filename) {
    // Content-addressed-ish by filename+userId is enough here since multer
    // already gives each upload a unique generated filename.
    const safeUser = String(userId || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '_');
    return path.join(THUMBNAILS_DIR, safeUser, `${filename}.thumb.jpg`);
}

// Fire-and-forget: called right after a local image upload finishes. Upload
// responses shouldn't wait on this — the grid falls back to generating (or
// re-generating) the thumbnail on first request anyway, so a slow/failed
// generation here never blocks the user's upload.
function generateThumbnailInBackground(userId, physicalPath, filename) {
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    if (!THUMBNAILABLE_EXTS.has(ext)) return;
    const sharp = loadSharp();
    if (!sharp) return; // `npm install sharp` not done — originals still work, just unoptimized

    const outPath = thumbnailPathFor(userId, filename);
    ensureDirectory(path.dirname(outPath));
    sharp(physicalPath)
        .rotate() // respect EXIF orientation (iPhone photos rely on this)
        .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 72 })
        .toFile(outPath)
        .catch((err) => console.warn('Thumbnail generation failed for', filename, err.message));
}

// Serves a cached thumbnail if present; generates one on demand (and caches
// it) if not — covers files uploaded before this feature existed, or where
// background generation hadn't finished/failed.
async function serveOrBuildThumbnail(req, res, userId, physicalPath, filename) {
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    if (!THUMBNAILABLE_EXTS.has(ext)) return streamLocalFile(req, res, physicalPath, filename, { download: false });

    const thumbPath = thumbnailPathFor(userId, filename);
    if (fs.existsSync(thumbPath)) {
        return streamLocalFile(req, res, thumbPath, filename, { download: false });
    }

    const sharp = loadSharp();
    if (!sharp) return streamLocalFile(req, res, physicalPath, filename, { download: false });

    try {
        ensureDirectory(path.dirname(thumbPath));
        await sharp(physicalPath)
            .rotate()
            .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 72 })
            .toFile(thumbPath);
        return streamLocalFile(req, res, thumbPath, filename, { download: false });
    } catch (err) {
        console.warn('On-demand thumbnail failed for', filename, err.message);
        return streamLocalFile(req, res, physicalPath, filename, { download: false });
    }
}

// ─── Virus scanning (ClamAV via clamd) ──────────────────────────────────
// Every locally-stored upload gets scanned right after it lands, the same
// fire-and-forget way thumbnails are generated above: the upload response
// doesn't wait on it, the node just starts life as scanStatus:'pending'
// and flips to 'clean'/'infected'/'error' a moment later once clamd
// replies. The file list already polls/refreshes on its own, so the
// status shows up in the UI without any extra plumbing.
//
// Requires a clamd daemon reachable over TCP (set CLAMD_HOST/CLAMD_PORT if
// it's not on localhost:3310 — clamd's default config only listens on a
// unix socket, so `TCPSocket 3310` / `TCPAddr 127.0.0.1` need to be enabled
// in /etc/clamav/clamd.conf and the daemon restarted for this to connect).
// ClamAV scanning is OFF by default. Set CLAMAV_SCAN=true in .env to turn it back on.
const CLAMAV_SCAN_ENABLED = String(process.env.CLAMAV_SCAN || '').toLowerCase() === 'true';
const CLAMD_HOST = process.env.CLAMD_HOST || '127.0.0.1';
const CLAMD_PORT = Number(process.env.CLAMD_PORT || 3310);

const QUARANTINE_DIR = path.join(DATA_DIR, 'quarantine');
ensureDirectory(QUARANTINE_DIR);

// Speaks clamd's INSTREAM protocol directly over a plain TCP socket — no
// extra npm dependency needed. Protocol: send "zINSTREAM\0", then the file
// as a series of <4-byte big-endian length><chunk bytes> frames, then a
// zero-length frame to signal end-of-stream, then read back one line like
// "stream: OK" / "stream: Eicar-Test-Signature FOUND" / "stream: ERROR".
function scanStreamWithClamd(filePath) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let responseBuf = Buffer.alloc(0);
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch {}
            resolve(result);
        };

        // Was 120s — on a box where clamd isn't actually reachable (no
        // daemon running, firewall silently dropping the connection
        // instead of refusing it), every single upload used to sit here
        // for the full two minutes before giving up. With more than a
        // handful of files queued that adds up to hours of nothing
        // happening. 8s is plenty of slack for a real clamd reply and
        // fails fast otherwise.
        socket.setTimeout(8000, () => finish({ status: 'error', message: 'ClamAV scan timed out.' }));
        socket.on('error', (err) => finish({ status: 'error', message: `Could not reach ClamAV daemon (${CLAMD_HOST}:${CLAMD_PORT}): ${err.message}` }));

        socket.connect(CLAMD_PORT, CLAMD_HOST, () => {
            socket.write('zINSTREAM\0');
            const readStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
            readStream.on('error', (err) => finish({ status: 'error', message: `Could not read file for scanning: ${err.message}` }));
            readStream.on('data', (chunk) => {
                const sizeBuf = Buffer.alloc(4);
                sizeBuf.writeUInt32BE(chunk.length, 0);
                socket.write(sizeBuf);
                socket.write(chunk);
            });
            readStream.on('end', () => {
                socket.write(Buffer.alloc(4)); // zero-length frame = end of stream
            });
        });

        socket.on('data', (chunk) => { responseBuf = Buffer.concat([responseBuf, chunk]); });
        socket.on('close', () => {
            if (settled) return;
            const reply = responseBuf.toString('utf8').replace(/\0/g, '').trim();
            if (!reply) return finish({ status: 'error', message: 'No response from ClamAV daemon.' });
            if (/\bOK$/.test(reply)) return finish({ status: 'clean', message: reply });
            const foundMatch = reply.match(/:\s*(.+?)\s+FOUND$/);
            if (foundMatch) return finish({ status: 'infected', signature: foundMatch[1], message: reply });
            return finish({ status: 'error', message: reply });
        });
    });
}

function updateFileNode(userId, fileId, patch) {
    const nodes = readUserNodes(userId);
    const idx = nodes.findIndex((n) => n.id === fileId);
    if (idx === -1) return null;
    nodes[idx] = { ...nodes[idx], ...patch };
    writeUserNodes(userId, nodes);
    return nodes[idx];
}

// Fire-and-forget, called right after a local upload finishes registering.
// On a hit, the infected file is moved out of /uploads into a per-user
// quarantine folder (so it's physically unreachable from any download/
// stream route) and the node is flagged so the UI can warn the owner.
// Thumbnails are generated separately, right at upload time — they no
// longer wait on this to finish (see the callers).
function scanFileInBackground(userId, fileId, physicalPath) {
    if (!CLAMAV_SCAN_ENABLED) return; // scanning disabled: leave the node as 'skipped'
    scanStreamWithClamd(physicalPath).then((result) => {
        if (result.status === 'infected') {
            const quarantinePath = path.join(QUARANTINE_DIR, String(userId), path.basename(physicalPath));
            ensureDirectory(path.dirname(quarantinePath));
            fs.rename(physicalPath, quarantinePath, (err) => {
                if (err) console.error('Could not quarantine infected file:', err.message);
                updateFileNode(userId, fileId, {
                    scanStatus: 'infected',
                    scanSignature: result.signature || 'unknown threat',
                    scannedAt: Date.now(),
                    quarantined: !err
                });
                console.warn(`[virus-scan] Infected file quarantined for user ${userId}: ${result.signature}`);
            });
        } else if (result.status === 'clean') {
            updateFileNode(userId, fileId, { scanStatus: 'clean', scannedAt: Date.now() });
        } else {
            // clamd unreachable/misconfigured, or a read error. The node is
            // flagged 'error' for visibility (and a later rescan can still
            // clear it), but scanBlockReason no longer treats this as a
            // reason to withhold the file — see the note there.
            updateFileNode(userId, fileId, { scanStatus: 'error', scanError: result.message, scannedAt: Date.now() });
            console.warn('[virus-scan] scan error for', fileId, '-', result.message);
        }
    }).catch((err) => {
        updateFileNode(userId, fileId, { scanStatus: 'error', scanError: err.message, scannedAt: Date.now() });
    });
}

function deriveFileType(name) {
    const ext = path.extname(String(name || '')).toLowerCase().replace('.', '');
    if (VIDEO_EXTS.has(ext)) return 'VIDEO';
    if (IMAGE_EXTS.has(ext)) return 'IMAGE';
    if (AUDIO_EXTS.has(ext)) return 'AUDIO';
    return 'OTHER';
}

function registerFileNode(userId, metadata) {
    const parentFolderId = metadata.parentFolderId === 'null' || !metadata.parentFolderId ? null : metadata.parentFolderId;
    const allNodes = readUserNodes(userId);
    const resolvedParentId = resolveUploadParent(userId, parentFolderId, metadata.relativePath || '', allNodes);
    const name = safeOriginalName(metadata.name || metadata.filename);
    const fileNode = {
        id: `file_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        name,
        isFolder: false,
        parentFolderId: resolvedParentId,
        byteSize: Number(metadata.byteSize || 0),
        storagePath: metadata.storagePath,
        storageProvider: metadata.storageProvider || 'local',
        storageKey: metadata.storageKey || null,
        contentType: metadata.contentType || null,
        fileType: deriveFileType(name),
        etag: metadata.etag || null,
        createdAt: Date.now(),
        // Only files we actually store on this server's disk get scanned —
        // remote (S3/R2) objects are out of scope for a local clamd.
        scanStatus: (CLAMAV_SCAN_ENABLED && (metadata.storageProvider || 'local') === 'local') ? 'pending' : 'skipped'
    };
    allNodes.push(fileNode);
    writeUserNodes(userId, allNodes);
    return fileNode;
}

function handleMulterUpload(req, res) {
    let requestAborted = false;
    req.on('aborted', () => {
        requestAborted = true;
        removeUploadedFile(req.file);
    });

    upload.single('file')(req, res, (err) => {
        if (requestAborted) {
            removeUploadedFile(req.file);
            return;
        }
        if (err) {
            removeUploadedFile(req.file);
            const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
            return res.status(status).json({ error: err.message || 'Upload stream failed.' });
        }
        if (!req.file) return res.status(400).json({ error: 'No payload stream captured.' });

        const used = getUserUsedBytes(req.userId);
        const limitBytes = getUserLimitBytes(req.userId);
        if (used + req.file.size > limitBytes) {
            removeUploadedFile(req.file);
            return res.status(413).json({ error: `Storage limit reached. You have used ${(used / (1024**3)).toFixed(2)} GB of your ${(limitBytes / (1024**3)).toFixed(0)} GB quota.` });
        }

        try {
            const fileNode = registerFileNode(req.userId, {
                name: req.file.originalname,
                byteSize: req.file.size,
                parentFolderId: req.body.parentFolderId,
                relativePath: req.body.relativePath,
                storagePath: req.file.key,
                storageProvider: 's3',
                storageKey: req.file.key,
                contentType: req.file.mimetype,
                etag: req.file.etag
            });
            return res.json({ success: true, node: fileNode });
        } catch (nodeErr) {
            removeUploadedFile(req.file);
            console.error('Upload registration failed:', nodeErr);
            return res.status(500).json({ error: 'Upload saved but metadata registration failed. Temporary file was removed.' });
        }
    });
}

// Local-disk chunked uploads are permanently disabled: files only go to Cloudflare R2.
// (An old cached page that still calls these gets a clear message instead of writing to disk.)
app.all(['/api/files/upload/init', '/api/files/upload/chunk', '/api/files/upload/complete', '/api/files/upload/abort'], (req, res) => {
    res.status(410).json({ error: 'Local-disk uploads are disabled. Files upload directly to cloud storage - please hard-refresh the page (Ctrl+Shift+R) and try again.' });
});

app.post('/api/files/upload', requireAuth, enforceFeatureAccess, handleMulterUpload);

// ── Step 1: start a chunked upload session, reserve the space up front, and
//    open the real destination file so chunks can land directly in it. ──
app.post('/api/files/upload/init', requireAuth, enforceFeatureAccess, (req, res) => {
    const { filename, fileSize, totalChunks, parentFolderId, relativePath, contentType } = req.body || {};
    const size = Number(fileSize);
    const chunks = Number(totalChunks);
    if (!filename || !Number.isFinite(size) || size <= 0 || !Number.isFinite(chunks) || chunks <= 0) {
        return res.status(400).json({ error: 'Missing or invalid upload metadata.' });
    }

    const used = getUserUsedBytes(req.userId);
    const limitBytes = getUserLimitBytes(req.userId);
    if (used + size > limitBytes) {
        return res.status(413).json({ error: `Storage limit reached. You have used ${(used / (1024 ** 3)).toFixed(2)} GB of your ${(limitBytes / (1024 ** 3)).toFixed(0)} GB quota.` });
    }

    const uploadId = crypto.randomUUID();
    const destDir = path.join(UPLOADS_DIR, req.userId);
    const finalName = `${Date.now()}_${uploadId}_${safeOriginalName(filename)}`;
    const destPath = path.join(destDir, finalName);

    fs.mkdir(destDir, { recursive: true }, (mkErr) => {
        if (mkErr) {
            console.error('Chunk session init failed:', mkErr.message);
            return res.status(500).json({ error: 'Could not prepare storage folder.' });
        }
        fs.open(destPath, 'w', (openErr, fd) => {
            if (openErr) {
                console.error('Chunk session init failed:', openErr.message);
                return res.status(500).json({ error: 'Could not start chunked upload.' });
            }
            // Preallocating the full size makes this a sparse file on any
            // filesystem worth running a server on -- effectively instant,
            // no bytes actually written -- and it means every chunk's
            // positional write below always lands inside an already-sized
            // file, so out-of-order or concurrent chunk arrival is safe.
            fs.ftruncate(fd, size, (truncErr) => {
                if (truncErr) {
                    console.error('Chunk session init failed:', truncErr.message);
                    fs.close(fd, () => {});
                    return res.status(500).json({ error: 'Could not reserve space for upload.' });
                }
                activeChunkUploads.set(uploadId, {
                    userId: req.userId,
                    filename: safeOriginalName(filename),
                    fileSize: size,
                    totalChunks: chunks,
                    receivedChunks: new Set(),
                    parentFolderId: parentFolderId || '',
                    relativePath: relativePath || '',
                    contentType: contentType || null,
                    createdAt: Date.now(),
                    destPath,
                    finalName,
                    fd
                });
                res.json({ uploadId });
            });
        });
    });
});

// ── Step 2: receive one chunk. Body is raw bytes, not multipart -- cheaper
//    to parse and several of these can be in flight at once per file. The
//    client tells us exactly which byte offset this chunk starts at, and
//    we pwrite it straight into the destination file at that position --
//    concurrent chunks for the same file never collide since each writes
//    to its own non-overlapping range. ──
app.post('/api/files/upload/chunk', requireAuth, enforceFeatureAccess, express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
    const uploadId = req.query.uploadId;
    const index = Number(req.query.index);
    const offset = Number(req.query.offset);
    const meta = activeChunkUploads.get(uploadId);
    if (!meta || meta.userId !== req.userId) return res.status(404).json({ error: 'Upload session not found or expired.' });
    if (!Number.isFinite(index) || index < 0 || index >= meta.totalChunks) return res.status(400).json({ error: 'Invalid chunk index.' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Empty chunk received.' });
    if (!Number.isFinite(offset) || offset < 0 || offset + req.body.length > meta.fileSize) {
        return res.status(400).json({ error: 'Invalid chunk offset.' });
    }

    fs.write(meta.fd, req.body, 0, req.body.length, offset, (err) => {
        if (err) {
            console.error('Chunk write failed:', err.message);
            return res.status(500).json({ error: 'Could not save chunk.' });
        }
        meta.receivedChunks.add(index);
        res.json({ success: true, index, received: meta.receivedChunks.size, totalChunks: meta.totalChunks });
    });
});

// ── Step 3: all chunks are in. Since every chunk was already written
//    straight into its final byte offset (see /chunk above), there's
//    nothing left to assemble -- just close the file handle, do the quota
//    check, and register it exactly like a normal upload. This is what
//    removes the old post-transfer "stitch everything back together"
//    delay: completion is now effectively instant regardless of file
//    size. ──
app.post('/api/files/upload/complete', requireAuth, enforceFeatureAccess, (req, res) => {
    const { uploadId } = req.body || {};
    const meta = activeChunkUploads.get(uploadId);
    if (!meta || meta.userId !== req.userId) return res.status(404).json({ error: 'Upload session not found or expired.' });
    if (meta.receivedChunks.size !== meta.totalChunks) {
        return res.status(409).json({ error: `Upload incomplete: received ${meta.receivedChunks.size} of ${meta.totalChunks} chunks.` });
    }

    fs.close(meta.fd, (closeErr) => {
        if (closeErr) {
            console.error('Could not finalize upload file:', closeErr.message);
            cleanupChunkSession(uploadId, meta, true);
            return res.status(500).json({ error: 'Could not finalize uploaded file.' });
        }

        const used = getUserUsedBytes(req.userId);
        const limitBytes = getUserLimitBytes(req.userId);
        if (used + meta.fileSize > limitBytes) {
            activeChunkUploads.delete(uploadId);
            fs.unlink(meta.destPath, () => {});
            return res.status(413).json({ error: `Storage limit reached. You have used ${(used / (1024 ** 3)).toFixed(2)} GB of your ${(limitBytes / (1024 ** 3)).toFixed(0)} GB quota.` });
        }

        try {
            const fileNode = registerFileNode(req.userId, {
                name: meta.filename,
                byteSize: meta.fileSize,
                parentFolderId: meta.parentFolderId,
                relativePath: meta.relativePath,
                storagePath: `/uploads/${req.userId}/${meta.finalName}`,
                storageProvider: 'local',
                contentType: meta.contentType
            });
            if (fileNode.fileType === 'IMAGE') {
                generateThumbnailInBackground(req.userId, meta.destPath, meta.finalName);
            }
            scanFileInBackground(req.userId, fileNode.id, meta.destPath);
            activeChunkUploads.delete(uploadId);
            return res.json({ success: true, node: fileNode });
        } catch (nodeErr) {
            console.error('Upload registration failed:', nodeErr.message);
            activeChunkUploads.delete(uploadId);
            fs.unlink(meta.destPath, () => {});
            return res.status(500).json({ error: 'Upload saved but metadata registration failed.' });
        }
    });
});

// ── One-click cancel: drop whatever made it to disk for this session.
//    Safe to call even if the session already finished. ──
app.post('/api/files/upload/abort', requireAuth, (req, res) => {
    const { uploadId } = req.body || {};
    const meta = activeChunkUploads.get(uploadId);
    if (meta && meta.userId !== req.userId) return res.status(404).json({ error: 'Upload session not found.' });
    if (meta) cleanupChunkSession(uploadId, meta, true);
    res.json({ success: true });
});

function loadS3Presigner() {
    try {
        const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
        const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
        return { S3Client, PutObjectCommand, getSignedUrl };
    } catch (err) {
        const e = new Error('S3 SDK packages are not installed. Run: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner');
        e.status = 503;
        throw e;
    }
}

function getS3Config() {
    const cfg = {
        endpoint: process.env.S3_ENDPOINT || process.env.R2_ENDPOINT,
        region: process.env.S3_REGION || 'auto',
        bucket: process.env.S3_BUCKET || process.env.R2_BUCKET,
        accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY,
        publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || process.env.R2_PUBLIC_BASE_URL || ''
    };
    const missing = Object.entries(cfg).filter(([key, value]) => key !== 'publicBaseUrl' && !value).map(([key]) => key);
    if (missing.length) {
        const e = new Error(`Object storage is not configured. Missing: ${missing.join(', ')}`);
        e.status = 503;
        throw e;
    }
    return cfg;
}

function createObjectKey(userId, filename) {
    const day = new Date().toISOString().slice(0, 10);
    return `users/${userId}/${day}/${crypto.randomUUID()}_${safeOriginalName(filename)}`;
}

async function generatePresignedUrl(req, res) {
    try {
        const { filename, fileType } = req.body || {};
        if (!filename || !fileType) return res.status(400).json({ error: 'filename and fileType are required.' });
        const { S3Client, PutObjectCommand, getSignedUrl } = loadS3Presigner();
        const cfg = getS3Config();
        const client = new S3Client({
        // R2 rejects the CRC32 checksum params newer AWS SDK versions add to presigned URLs
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
            region: cfg.region,
            endpoint: cfg.endpoint,
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
            credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
        });
        const key = createObjectKey(req.userId, filename);
        const command = new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: fileType });
        const uploadUrl = await getSignedUrl(client, command, { expiresIn: 600 });
        const publicUrl = cfg.publicBaseUrl ? `${cfg.publicBaseUrl.replace(/\/$/, '')}/${key}` : null;
        res.json({ uploadUrl, key, bucket: cfg.bucket, expiresIn: 600, method: 'PUT', headers: { 'Content-Type': fileType }, publicUrl });
    } catch (err) {
        console.error('Presigned URL generation failed:', err.message);
        res.status(err.status || 500).json({ error: err.message || 'Failed to generate upload URL.' });
    }
}

app.post(['/api/generate-presigned-url', '/generate-presigned-url'], requireAuth, generatePresignedUrl);

/* ════════════════════════════════════════════════════════════════════════
 *  S3 MULTIPART UPLOADS
 *  A single PutObject PUT for a large file has the same problem as a
 *  single-request local upload: one dropped connection loses the whole
 *  transfer, and only one stream is doing the work. S3's multipart API
 *  fixes both -- the file is split into parts (each its own presigned PUT),
 *  several parts travel to the bucket at once, a failed part only needs
 *  that one part retried, and the object only exists once every part is
 *  explicitly assembled via CompleteMultipartUpload.
 * ════════════════════════════════════════════════════════════════════════ */
function loadS3MultipartSDK() {
    try {
        const {
            S3Client,
            CreateMultipartUploadCommand,
            UploadPartCommand,
            CompleteMultipartUploadCommand,
            AbortMultipartUploadCommand
        } = require('@aws-sdk/client-s3');
        const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
        return { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, getSignedUrl };
    } catch (err) {
        const e = new Error('S3 SDK packages are not installed. Run: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner');
        e.status = 503;
        throw e;
    }
}

function buildS3Client(S3Client, cfg) {
    return new S3Client({
        // R2 rejects the CRC32 checksum params newer AWS SDK versions add to presigned URLs
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        region: cfg.region,
        endpoint: cfg.endpoint,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
    });
}

// S3 requires every part except the last to be at least 5MB, and caps a
// single object at 10,000 parts -- the client picks a part size that stays
// under that ceiling for very large files.
const S3_MIN_PART_BYTES = 5 * 1024 * 1024;
const S3_MAX_PARTS = 10000;

// ── Step 1: open a multipart session and hand back the upload ID + key ──
app.post('/api/cloud/multipart/init', requireAuth, async (req, res) => {
    try {
        const { filename, fileType, fileSize } = req.body || {};
        if (!filename || !fileType) return res.status(400).json({ error: 'filename and fileType are required.' });

        const size = Number(fileSize || 0);
        if (size > 0) {
            const used = getUserUsedBytes(req.userId);
            const limitBytes = getUserLimitBytes(req.userId);
            if (used + size > limitBytes) {
                return res.status(413).json({ error: `Storage limit reached. You have used ${(used / (1024 ** 3)).toFixed(2)} GB of your ${(limitBytes / (1024 ** 3)).toFixed(0)} GB quota.` });
            }
        }

        const { S3Client, CreateMultipartUploadCommand } = loadS3MultipartSDK();
        const cfg = getS3Config();
        const client = buildS3Client(S3Client, cfg);
        const key = createObjectKey(req.userId, filename);
        const command = new CreateMultipartUploadCommand({ Bucket: cfg.bucket, Key: key, ContentType: fileType });
        const result = await client.send(command);

        res.json({ uploadId: result.UploadId, key, bucket: cfg.bucket });
    } catch (err) {
        console.error('Multipart init failed:', err.message);
        res.status(err.status || 500).json({ error: err.message || 'Could not start cloud multipart upload.' });
    }
});

// ── Step 2: presign one PUT URL per part. Accepts a batch of part numbers
//    so the client can fetch several signed URLs in one round trip instead
//    of one request per part. ──
app.post('/api/cloud/multipart/presign-part', requireAuth, async (req, res) => {
    try {
        const { key, uploadId, partNumbers } = req.body || {};
        const numbers = Array.isArray(partNumbers) ? partNumbers.map(Number) : [];
        if (!key || !uploadId || !numbers.length) return res.status(400).json({ error: 'key, uploadId, and partNumbers are required.' });
        if (numbers.some((n) => !Number.isInteger(n) || n < 1 || n > S3_MAX_PARTS)) {
            return res.status(400).json({ error: `partNumbers must be integers between 1 and ${S3_MAX_PARTS}.` });
        }

        const { S3Client, UploadPartCommand, getSignedUrl } = loadS3MultipartSDK();
        const cfg = getS3Config();
        const client = buildS3Client(S3Client, cfg);

        const parts = await Promise.all(numbers.map(async (partNumber) => {
            const command = new UploadPartCommand({ Bucket: cfg.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber });
            const url = await getSignedUrl(client, command, { expiresIn: 900 });
            return { partNumber, url };
        }));

        res.json({ parts });
    } catch (err) {
        console.error('Multipart part presign failed:', err.message);
        res.status(err.status || 500).json({ error: err.message || 'Could not presign upload part.' });
    }
});

// ── Step 3: every part is on S3 -- tell S3 to assemble them into the
//    final object, then register the file node exactly like any other
//    cloud upload. ──
app.post('/api/cloud/multipart/complete', requireAuth, async (req, res) => {
    try {
        const { key, uploadId, parts, filename, fileType, byteSize, parentFolderId, relativePath } = req.body || {};
        if (!key || !uploadId || !Array.isArray(parts) || !parts.length || !filename) {
            return res.status(400).json({ error: 'key, uploadId, parts, and filename are required.' });
        }

        const { S3Client, CompleteMultipartUploadCommand } = loadS3MultipartSDK();
        const cfg = getS3Config();
        const client = buildS3Client(S3Client, cfg);

        const sortedParts = parts
            .map((p) => ({ ETag: p.ETag || p.etag, PartNumber: Number(p.PartNumber ?? p.partNumber) }))
            .sort((a, b) => a.PartNumber - b.PartNumber);

        const command = new CompleteMultipartUploadCommand({
            Bucket: cfg.bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: sortedParts }
        });
        await client.send(command);

        const used = getUserUsedBytes(req.userId);
        const limitBytes = getUserLimitBytes(req.userId);
        if (used + Number(byteSize || 0) > limitBytes) {
            return res.status(413).json({ error: 'Storage limit reached after cloud upload. Delete the cloud object manually or retry after freeing space.' });
        }

        const publicUrl = cfg.publicBaseUrl ? `${cfg.publicBaseUrl.replace(/\/$/, '')}/${key}` : key;
        const fileNode = registerFileNode(req.userId, {
            name: filename,
            byteSize,
            parentFolderId,
            relativePath,
            storagePath: publicUrl,
            storageProvider: 's3',
            storageKey: key,
            contentType: fileType
        });
        res.json({ success: true, node: fileNode });
    } catch (err) {
        console.error('Multipart complete failed:', err.message);
        res.status(err.status || 500).json({ error: err.message || 'Could not finalize cloud multipart upload.' });
    }
});

// ── One-click cancel: tell S3 to drop every part uploaded so far for this
//    session so it doesn't sit around accruing storage cost. ──
app.post('/api/cloud/multipart/abort', requireAuth, async (req, res) => {
    try {
        const { key, uploadId } = req.body || {};
        if (!key || !uploadId) return res.status(400).json({ error: 'key and uploadId are required.' });
        const { S3Client, AbortMultipartUploadCommand } = loadS3MultipartSDK();
        const cfg = getS3Config();
        const client = buildS3Client(S3Client, cfg);
        await client.send(new AbortMultipartUploadCommand({ Bucket: cfg.bucket, Key: key, UploadId: uploadId }));
        res.json({ success: true });
    } catch (err) {
        // Aborting is best-effort cleanup -- don't fail the user-facing
        // Stop action just because the bucket-side cleanup had trouble.
        console.warn('Multipart abort failed:', err.message);
        res.json({ success: true });
    }
});

// Generates a short-lived signed GET URL for an R2/S3-stored object, forcing
// a "Save As" download via ResponseContentDisposition (works even if the
// bucket/object isn't publicly readable).
async function getSignedDownloadUrl(storageKey, displayName) {
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const cfg = getS3Config();
    const client = new S3Client({
        // R2 rejects the CRC32 checksum params newer AWS SDK versions add to presigned URLs
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        region: cfg.region,
        endpoint: cfg.endpoint,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
    });
    const command = new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: storageKey,
        ResponseContentDisposition: `attachment; filename="${attachmentName(displayName)}"`
    });
    return getSignedUrl(client, command, { expiresIn: 300 });
}

// Streams or redirects a node's underlying file to the client, regardless of
// whether it lives on local disk or in R2/S3. `options.download` forces a
// Save-As; without it, the file streams/serves inline (used by media players).
// Gate used by every route that serves file bytes. Reverted back to only
// blocking a CONFIRMED infection — 'pending' and 'error' used to also
// block serving ("fail closed until proven clean"), but that meant every
// thumbnail and download sat behind however long the scan took, and if
// clamd was slow/unreachable that was minutes-to-hours of nothing loading.
// An infected file is still physically unreachable regardless of this
// function, since scanFileInBackground moves it into quarantine the
// moment it's flagged — this just stops 'pending'/'error' from blocking
// everything else in the meantime, same as before the scan feature existed.
function scanBlockReason(node) {
    if (!node) return null;
    if (node.scanStatus === 'infected') {
        return `This file was flagged by the virus scan (${node.scanSignature || 'threat detected'}) and has been quarantined.`;
    }
    return null; // 'pending', 'error', 'clean', 'skipped', or unset — servable
}

async function deliverNode(req, res, node, options = {}) {
    if (!node || node.isFolder) return res.status(404).send('Node streaming target unavailable.');
    const blockReason = scanBlockReason(node);
    if (blockReason) return res.status(403).json({ error: blockReason });

    const isRemote = node.storageProvider === 's3' || /^https?:\/\//i.test(node.storagePath || '');

    if (!isRemote) {
        const physicalPath = resolveLocalUploadPath(node.storagePath);
        if (!physicalPath) return res.status(400).send('Could not resolve file on local disk.');
        return streamLocalFile(req, res, physicalPath, node.name, options);
    }

    // Remote (R2/S3) object.
    if (!options.download) {
        // Inline playback/preview: the object's public URL already works
        // directly in <video>/<img> tags (and supports Range natively via
        // R2), so just redirect the browser straight to it.
        if (!node.storageKey) return res.redirect(node.storagePath);
        try {
            const url = await getSignedDownloadUrlInline(node.storageKey);
            return res.redirect(url);
        } catch {
            return res.redirect(node.storagePath);
        }
    }

    if (!node.storageKey) {
        // No key on record (e.g. legacy node) — best effort: send the
        // browser to the public URL directly rather than hard-failing.
        return res.redirect(node.storagePath);
    }

    try {
        const url = await getSignedDownloadUrl(node.storageKey, node.name);
        return res.redirect(url);
    } catch (err) {
        console.error('Presigned download URL generation failed:', err.message);
        return res.status(502).send('Could not generate a download link for this cloud-stored file.');
    }
}

async function getSignedDownloadUrlInline(storageKey) {
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const cfg = getS3Config();
    const client = new S3Client({
        // R2 rejects the CRC32 checksum params newer AWS SDK versions add to presigned URLs
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        region: cfg.region,
        endpoint: cfg.endpoint,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
    });
    const command = new GetObjectCommand({ Bucket: cfg.bucket, Key: storageKey });
    return getSignedUrl(client, command, { expiresIn: 300 });
}


app.post(['/api/upload-success', '/upload-success'], requireAuth, (req, res) => {
    try {
        const { key, filename, fileType, byteSize, parentFolderId, relativePath, publicUrl, etag } = req.body || {};
        if (!key || !filename) return res.status(400).json({ error: 'key and filename are required.' });
        const used = getUserUsedBytes(req.userId);
        const limitBytes = getUserLimitBytes(req.userId);
        if (used + Number(byteSize || 0) > limitBytes) {
            return res.status(413).json({ error: 'Storage limit reached after cloud upload. Delete the cloud object manually or retry after freeing space.' });
        }
        const cfg = (() => { try { return getS3Config(); } catch { return { publicBaseUrl: '' }; } })();
        const resolvedUrl = publicUrl || (cfg.publicBaseUrl ? `${cfg.publicBaseUrl.replace(/\/$/, '')}/${key}` : key);
        const fileNode = registerFileNode(req.userId, {
            name: filename,
            byteSize,
            parentFolderId,
            relativePath,
            storagePath: resolvedUrl,
            storageProvider: 's3',
            storageKey: key,
            contentType: fileType,
            etag
        });
        res.json({ success: true, node: fileNode });
    } catch (err) {
        console.error('Cloud upload registration failed:', err);
        res.status(500).json({ error: 'Cloud upload completed, but metadata registration failed.' });
    }
});

// Create folder
app.post('/api/folders/create', requireAuth, (req, res) => {
    const { name, parentFolderId } = req.body;
    const allNodes = readUserNodes(req.userId);
    const now = Date.now();
    const newFolder = {
        id: `folder_${now}_${Math.random().toString(36).slice(2, 7)}`,
        name: name || 'Untitled Folder',
        isFolder: true,
        parentFolderId: parentFolderId || null,
        folderColor: null,   // hex string (e.g. '#4a3aff') once the user assigns one; null = default
        createdAt: now,
        modifiedAt: now
    };
    allNodes.push(newFolder);
    writeUserNodes(req.userId, allNodes);
    res.json(newFolder);
});

// A short list of preset badge colors the client offers by default. Kept
// server-side too so validation and the UI can't silently drift apart.
const FOLDER_COLOR_PRESETS = ['#4a3aff', '#ef4444', '#f59e0b', '#10b981', '#0ea5e9', '#ec4899', '#6b7280'];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Set (or clear) a folder's color badge. Accepts any valid 6-digit hex
// string, not just the presets, so a future color-picker isn't blocked.
app.post('/api/folders/color/:id', requireAuth, (req, res) => {
    const { color } = req.body; // string hex color, or null/'' to reset to default
    const allNodes = readUserNodes(req.userId);
    const node = allNodes.find(n => n.id === req.params.id);
    if (!node) return res.status(404).json({ error: 'Folder not found.' });
    if (!node.isFolder) return res.status(400).json({ error: 'Only folders can have a color assigned.' });

    if (color === null || color === undefined || color === '') {
        node.folderColor = null;
    } else if (typeof color === 'string' && HEX_COLOR_RE.test(color)) {
        node.folderColor = color;
    } else {
        return res.status(400).json({ error: 'Color must be a 6-digit hex string like #4a3aff.' });
    }

    node.modifiedAt = Date.now();
    writeUserNodes(req.userId, allNodes);
    res.json({ success: true, node });
});

/* ════════════════════════════════════════════════════════════════════
 *  MUSIC SECTION
 *  Albums are just regular folder nodes (isFolder:true) flagged with
 *  isAlbum:true and an optional albumThumbnail (base64 data URL) living
 *  under a single auto-created "🎵 Music" root folder per user — the
 *  same pattern already used for the "📥 Shared With Me" inbox folder.
 *  Tracks inside an album are either:
 *    - regular uploaded video files (registered via the normal
 *      /api/files/upload route with parentFolderId = the album id —
 *      no special-casing needed there), or
 *    - YouTube links, stored as metadata-only nodes (isYoutube:true,
 *      youtubeId/youtubeUrl, no storagePath) since we never download
 *      or re-host YouTube's video data.
 *  Renaming/deleting albums and tracks reuses the existing generic
 *  /api/files/rename/:id and /api/files/remove/:id routes — they're
 *  ordinary nodes, so nothing extra is required there.
 * ════════════════════════════════════════════════════════════════════ */
function extractYoutubeId(url) {
    if (!url) return null;
    const str = String(url).trim();
    const m = str.match(/(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

function ensureMusicRoot(userId, allNodes) {
    const ROOT_ID = `music_root_${userId}`;
    let root = allNodes.find(n => n.id === ROOT_ID);
    if (!root) {
        root = {
            id: ROOT_ID,
            name: '🎵 Music',
            isFolder: true,
            parentFolderId: null,
            createdAt: Date.now(),
            musicRoot: true
        };
        allNodes.push(root);
    }
    return root;
}

const MAX_THUMB_BYTES = 2 * 1024 * 1024; // 2MB base64 data-URL cap for album covers

/* ════════════════════════════════════════════════════════════════════
 *  EDUCATION SECTION
 *  Same pattern as Music above: subject "folders" are ordinary folder
 *  nodes (isFolder:true, isSubject:true) living under a single
 *  auto-created "📚 Education" root folder per user. Materials inside a
 *  subject are just regular files uploaded via the existing
 *  /api/files/upload (or chunked/cloud) routes with
 *  parentFolderId = the subject folder's id — no special-casing needed
 *  there, and rename/move/delete/preview all reuse the generic
 *  /api/files/* routes for free.
 * ════════════════════════════════════════════════════════════════════ */
function ensureEducationRoot(userId, allNodes) {
    const ROOT_ID = `education_root_${userId}`;
    let root = allNodes.find(n => n.id === ROOT_ID);
    if (!root) {
        root = {
            id: ROOT_ID,
            name: '📚 Education',
            isFolder: true,
            parentFolderId: null,
            createdAt: Date.now(),
            educationRoot: true
        };
        allNodes.push(root);
    }
    return root;
}

app.get('/api/education/root', requireAuth, (req, res) => {
    const allNodes = readUserNodes(req.userId);
    const root = ensureEducationRoot(req.userId, allNodes);
    writeUserNodes(req.userId, allNodes);
    res.json({ rootId: root.id });
});

app.get('/api/education/subjects', requireAuth, (req, res) => {
    const allNodes = readUserNodes(req.userId);
    const root = ensureEducationRoot(req.userId, allNodes);
    writeUserNodes(req.userId, allNodes);
    const subjects = allNodes.filter(n => n.isFolder && n.parentFolderId === root.id);
    // Count every file inside each subject, including files in nested folders.
    const childrenOf = new Map();
    allNodes.forEach(n => {
        if (!childrenOf.has(n.parentFolderId)) childrenOf.set(n.parentFolderId, []);
        childrenOf.get(n.parentFolderId).push(n);
    });
    const countFiles = (folderId) => {
        let total = 0;
        (childrenOf.get(folderId) || []).forEach(n => {
            total += n.isFolder ? countFiles(n.id) : 1;
        });
        return total;
    };
    res.json(subjects.map(sub => ({ ...sub, fileCount: countFiles(sub.id) })));
});

// What a folder inside Education is meant to hold. Drives its thumbnail/colour
// on the client; stored on the folder node as `eduCategory`.
const EDU_CATEGORIES = ['course', 'notes', 'documents', 'videos', 'pastpapers', 'assignments', 'books', 'projects', 'general'];
function cleanEduCategory(c, fallback) {
    return EDU_CATEGORIES.includes(c) ? c : (fallback || 'general');
}
// True when `id` is the Education root or sits anywhere beneath it.
function isInEduTree(allNodes, id) {
    const byId = new Map(allNodes.map(n => [n.id, n]));
    let cur = byId.get(id), guard = 0;
    while (cur && guard++ < 500) {
        if (cur.educationRoot) return true;
        cur = cur.parentFolderId ? byId.get(cur.parentFolderId) : null;
    }
    return false;
}

app.post('/api/education/subjects', requireAuth, (req, res) => {
    const { name, category } = req.body || {};
    const allNodes = readUserNodes(req.userId);
    const root = ensureEducationRoot(req.userId, allNodes);
    const now = Date.now();
    const cleanName = (name || '').trim() || 'New Subject';
    const subject = {
        id: `folder_${now}_${Math.random().toString(36).slice(2, 7)}`,
        name: cleanName,
        isFolder: true,
        parentFolderId: root.id,
        isSubject: true,
        eduCategory: cleanEduCategory(category, 'course'),
        folderColor: null,
        createdAt: now,
        modifiedAt: now
    };
    allNodes.push(subject);
    writeUserNodes(req.userId, allNodes);
    res.json(subject);
});

// Create a folder (any depth) inside Education, with a category.
app.post('/api/education/folders', requireAuth, (req, res) => {
    const { name, parentFolderId, category } = req.body || {};
    const allNodes = readUserNodes(req.userId);
    const parent = allNodes.find(n => n.id === parentFolderId && n.isFolder);
    if (!parent || !isInEduTree(allNodes, parent.id)) {
        return res.status(400).json({ error: 'Parent must be a folder inside Education.' });
    }
    const now = Date.now();
    const folder = {
        id: `folder_${now}_${Math.random().toString(36).slice(2, 7)}`,
        name: (name || '').trim() || 'New Folder',
        isFolder: true,
        parentFolderId: parent.id,
        eduCategory: cleanEduCategory(category, 'general'),
        folderColor: null,
        createdAt: now,
        modifiedAt: now
    };
    allNodes.push(folder);
    writeUserNodes(req.userId, allNodes);
    res.json(folder);
});

// Change what an Education folder is for (and therefore its thumbnail).
app.post('/api/education/folders/:id/category', requireAuth, (req, res) => {
    const allNodes = readUserNodes(req.userId);
    const node = allNodes.find(n => n.id === req.params.id && n.isFolder);
    if (!node || node.educationRoot || !isInEduTree(allNodes, node.id)) {
        return res.status(404).json({ error: 'Folder not found in Education.' });
    }
    node.eduCategory = cleanEduCategory((req.body || {}).category, node.isSubject ? 'course' : 'general');
    node.modifiedAt = Date.now();
    writeUserNodes(req.userId, allNodes);
    res.json(node);
});

// Everything the Education folder page needs in one call: the folder, its
// breadcrumb path, its direct children (folders carry recursive file counts)
// and totals.
app.get('/api/education/folder/:id', requireAuth, (req, res) => {
    const allNodes = readUserNodes(req.userId);
    const byId = new Map(allNodes.map(n => [n.id, n]));
    const folder = byId.get(req.params.id);
    if (!folder || !folder.isFolder || folder.educationRoot || !isInEduTree(allNodes, folder.id)) {
        return res.status(404).json({ error: 'Folder not found in Education.' });
    }
    const childrenOf = new Map();
    allNodes.forEach(n => {
        if (!childrenOf.has(n.parentFolderId)) childrenOf.set(n.parentFolderId, []);
        childrenOf.get(n.parentFolderId).push(n);
    });
    const tally = (id) => {
        let files = 0, bytes = 0;
        (childrenOf.get(id) || []).forEach(n => {
            if (n.isFolder) { const t = tally(n.id); files += t.files; bytes += t.bytes; }
            else { files += 1; bytes += Number(n.byteSize) || 0; }
        });
        return { files, bytes };
    };
    const path = [];
    for (let cur = folder, guard = 0; cur && !cur.educationRoot && guard < 500; cur = cur.parentFolderId ? byId.get(cur.parentFolderId) : null, guard++) {
        path.unshift({ id: cur.id, name: cur.name, eduCategory: cur.eduCategory || null, isSubject: !!cur.isSubject });
    }
    const items = (childrenOf.get(folder.id) || []).map(n => {
        if (!n.isFolder) return n;
        const t = tally(n.id);
        return { ...n, fileCount: t.files, itemCount: (childrenOf.get(n.id) || []).length };
    });
    const total = tally(folder.id);
    res.json({
        folder,
        path,
        items,
        stats: {
            files: items.filter(i => !i.isFolder).length,
            folders: items.filter(i => i.isFolder).length,
            totalFiles: total.files,
            bytes: total.bytes
        }
    });
});

// ─── Khazana-Hole: search YouTube / paste a link → tagged MP3 ──────────────
// Powers the song search bar on the Music page. Runs yt-dlp + ffmpeg on this
// machine (see khazana-hole-routes.js). The finished MP3 is handed to the
// browser, which uploads it through the normal /api/files/upload route — so
// quotas, storage provider and indexing behave exactly like a manual upload.
// Wrapped so a missing file/binary can never stop the rest of the server booting.
try {
    app.use('/api/khazana-hole', require('./khazana-hole-routes')({ requireAuth }));
} catch (e) {
    console.warn('[khazana-hole] not loaded:', e.message);
}

// ─── Cloudflare R2: upload / stream / delete ───────────────────────────────
// POST /api/r2/upload, GET|DELETE /api/r2/files/:filename (see routes/r2.js).
// Wrapped so a missing package or file can never stop the rest of the server booting.
try {
    app.use('/api/r2', require('./routes/r2')({ requireAuth, registerFileNode }));
} catch (e) {
    console.warn('[r2] not loaded:', e.message);
}

app.get('/api/music/root', requireAuth, (req, res) => {
    const allNodes = readUserNodes(req.userId);
    const root = ensureMusicRoot(req.userId, allNodes);
    writeUserNodes(req.userId, allNodes);
    res.json({ rootId: root.id });
});

app.get('/api/music/albums', requireAuth, (req, res) => {
    const allNodes = readUserNodes(req.userId);
    const root = ensureMusicRoot(req.userId, allNodes);
    writeUserNodes(req.userId, allNodes);
    const albums = allNodes.filter(n => n.isFolder && n.isAlbum && n.parentFolderId === root.id);
    res.json(albums);
});

app.post('/api/music/albums', requireAuth, (req, res) => {
    const { name, thumbnail } = req.body || {};
    if (thumbnail && Buffer.byteLength(String(thumbnail), 'utf8') > MAX_THUMB_BYTES) {
        return res.status(413).json({ error: 'Cover image is too large. Please use a smaller image.' });
    }
    const allNodes = readUserNodes(req.userId);
    const root = ensureMusicRoot(req.userId, allNodes);
    const album = {
        id: `folder_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        name: (name || '').trim() || 'Untitled Album',
        isFolder: true,
        isAlbum: true,
        parentFolderId: root.id,
        albumThumbnail: thumbnail || null,
        createdAt: Date.now()
    };
    allNodes.push(album);
    writeUserNodes(req.userId, allNodes);
    res.json(album);
});

app.patch('/api/music/albums/:id', requireAuth, (req, res) => {
    const allNodes = readUserNodes(req.userId);
    const album = allNodes.find(n => n.id === req.params.id && n.isAlbum);
    if (!album) return res.status(404).json({ error: 'Album not found.' });
    const { name, thumbnail } = req.body || {};
    if (typeof name === 'string' && name.trim()) album.name = name.trim();
    if (typeof thumbnail === 'string') {
        if (Buffer.byteLength(thumbnail, 'utf8') > MAX_THUMB_BYTES) {
            return res.status(413).json({ error: 'Cover image is too large. Please use a smaller image.' });
        }
        album.albumThumbnail = thumbnail;
    }
    writeUserNodes(req.userId, allNodes);
    res.json(album);
});

app.get('/api/music/albums/:id/tracks', requireAuth, (req, res) => {
    const allNodes = readUserNodes(req.userId);
    const album = allNodes.find(n => n.id === req.params.id && n.isAlbum);
    if (!album) return res.status(404).json({ error: 'Album not found.' });
    const tracks = allNodes.filter(n => !n.isFolder && n.parentFolderId === album.id);
    res.json(tracks);
});

// Attaches a client-generated thumbnail (a still frame grabbed from the
// middle of an uploaded video, as a small base64 data URL) to a music
// track. Video files have no useful embedded cover art the way audio
// sometimes does, so the client extracts one itself via <video>+<canvas>
// right after upload finishes and sends it here.
app.patch('/api/music/tracks/:id/thumbnail', requireAuth, (req, res) => {
    const { thumbnail } = req.body || {};
    if (typeof thumbnail !== 'string' || !thumbnail.startsWith('data:image/')) {
        return res.status(400).json({ error: 'Invalid thumbnail.' });
    }
    if (Buffer.byteLength(thumbnail, 'utf8') > MAX_THUMB_BYTES) {
        return res.status(413).json({ error: 'Thumbnail is too large.' });
    }
    const allNodes = readUserNodes(req.userId);
    const track = allNodes.find(n => n.id === req.params.id && !n.isFolder);
    if (!track) return res.status(404).json({ error: 'Track not found.' });
    track.videoThumbnail = thumbnail;
    writeUserNodes(req.userId, allNodes);
    res.json({ success: true, videoThumbnail: thumbnail });
});

app.post('/api/music/youtube', requireAuth, (req, res) => {
    const { albumId, url, title } = req.body || {};
    const youtubeId = extractYoutubeId(url);
    if (!youtubeId) return res.status(400).json({ error: 'Could not find a valid YouTube video ID in that link.' });
    const allNodes = readUserNodes(req.userId);
    const album = allNodes.find(n => n.id === albumId && n.isAlbum);
    if (!album) return res.status(404).json({ error: 'Album not found.' });
    const track = {
        id: `yt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        name: (title && title.trim()) || 'YouTube Video',
        isFolder: false,
        isYoutube: true,
        youtubeId,
        youtubeUrl: url,
        parentFolderId: album.id,
        fileType: 'YOUTUBE',
        byteSize: 0,
        createdAt: Date.now()
    };
    allNodes.push(track);
    writeUserNodes(req.userId, allNodes);
    res.json(track);
});

/* ── Music Browse (community library) ──
 *  Lets any user publish an audio/video track from one of their own
 *  Music albums into a public library that every other user can search,
 *  stream, and copy into their own library. Publishing only flips a
 *  flag on the track's existing node — the underlying file never moves
 *  — so un-publishing removes it from Browse instantly with nothing to
 *  clean up. YouTube tracks aren't publishable since they're just a
 *  link, not a file we host.
 * ──────────────────────────────────────────────────────────────────── */

// Toggle whether a track is visible in the community Browse library
app.post('/api/music/browse/publish/:trackId', requireAuth, blockIfDeviceRestricted, (req, res) => {
    const { publish } = req.body || {};
    const allNodes = readUserNodes(req.userId);
    const track = allNodes.find(n => n.id === req.params.trackId && !n.isFolder);
    if (!track) return res.status(404).json({ error: 'Track not found.' });
    if (track.isYoutube) return res.status(400).json({ error: "YouTube links can't be published — share the link instead." });
    track.publicToBrowse = !!publish;
    writeUserNodes(req.userId, allNodes);
    res.json({ success: true, publicToBrowse: track.publicToBrowse });
});

// List every publicly-published track across all users, newest first,
// with an optional ?q= search across the track name and uploader name.
app.get('/api/music/browse', requireAuth, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const users = readUsers();
    const results = [];
    users.forEach(u => {
        const nodes = readUserNodes(u.id);
        nodes.filter(n => !n.isFolder && n.publicToBrowse).forEach(n => {
            results.push({
                id: n.id,
                ownerId: u.id,
                ownerUsername: u.username,
                name: n.name,
                fileType: n.fileType || null,
                byteSize: n.byteSize || 0,
                createdAt: n.createdAt || 0
            });
        });
    });
    const filtered = q
        ? results.filter(r => r.name.toLowerCase().includes(q) || (r.ownerUsername || '').toLowerCase().includes(q))
        : results;
    filtered.sort((a, b) => b.createdAt - a.createdAt);
    res.json(filtered);
});

// Stream (inline playback) a published track belonging to any user
app.get('/api/music/browse/stream/:ownerId/:trackId', requireAuth, (req, res) => {
    const nodes = readUserNodes(req.params.ownerId);
    const track = nodes.find(n => n.id === req.params.trackId && !n.isFolder && n.publicToBrowse);
    if (!track) return res.status(404).send('Track not found or no longer public.');
    deliverNode(req, res, track, { download: false });
});

// Download a published track belonging to any user
app.get('/api/music/browse/download/:ownerId/:trackId', requireAuth, (req, res) => {
    const nodes = readUserNodes(req.params.ownerId);
    const track = nodes.find(n => n.id === req.params.trackId && !n.isFolder && n.publicToBrowse);
    if (!track) return res.status(404).json({ error: 'Track not found or no longer public.' });
    deliverNode(req, res, track, { download: true });
});

// Copy a published track into the current user's own Music library (a
// dedicated "⬇️ From Browse" album), so it shows up and plays alongside
// their own uploads. Counts against their storage quota like any upload.
app.post('/api/music/browse/save/:ownerId/:trackId', requireAuth, (req, res) => {
    const ownerNodes = readUserNodes(req.params.ownerId);
    const track = ownerNodes.find(n => n.id === req.params.trackId && !n.isFolder && n.publicToBrowse);
    if (!track) return res.status(404).json({ error: 'Track not found or no longer public.' });

    const used = getUserUsedBytes(req.userId);
    const limitBytes = getUserLimitBytes(req.userId);
    if (used + (track.byteSize || 0) > limitBytes) {
        return res.status(413).json({ error: 'Storage limit reached. Free up space before saving this track.' });
    }

    const srcAbs = resolveLocalUploadPath(track.storagePath);
    if (!srcAbs || !fs.existsSync(srcAbs)) {
        return res.status(502).json({ error: "Could not read the source file (cloud-stored tracks aren't supported for saving yet)." });
    }

    const allNodes = readUserNodes(req.userId);
    const root = ensureMusicRoot(req.userId, allNodes);
    const ALBUM_ID = `browse_saved_${req.userId}`;
    let album = allNodes.find(n => n.id === ALBUM_ID);
    if (!album) {
        album = {
            id: ALBUM_ID,
            name: '⬇️ From Browse',
            isFolder: true,
            isAlbum: true,
            parentFolderId: root.id,
            albumThumbnail: null,
            createdAt: Date.now()
        };
        allNodes.push(album);
    }

    const users = readUsers();
    const ownerUser = users.find(u => u.id === req.params.ownerId);
    const filename = `file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${path.basename(srcAbs)}`;
    const destDir = path.join(UPLOADS_DIR, req.userId);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcAbs, path.join(destDir, filename));

    const copy = {
        id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: track.name,
        isFolder: false,
        parentFolderId: album.id,
        fileType: track.fileType || null,
        byteSize: track.byteSize || 0,
        storagePath: `/uploads/${req.userId}/${filename}`,
        createdAt: Date.now(),
        browsedFrom: ownerUser?.username || null
    };
    allNodes.push(copy);
    writeUserNodes(req.userId, allNodes);
    res.json({ success: true, track: copy, albumId: album.id });
});

// Create blank file / text document
app.post('/api/files/create-blank', requireAuth, async (req, res) => {
    try {
        const { name, parentFolderId, content } = req.body || {};
        const safeName = safeOriginalName(name || 'document.txt');
        const body = Buffer.from(content || '', 'utf8');

        // Enforce storage quota
        const used = getUserUsedBytes(req.userId);
        const limitBytes = getUserLimitBytes(req.userId);
        if (used + body.length > limitBytes) {
            return res.status(413).json({ error: `Storage limit reached. You have used ${(used / (1024**3)).toFixed(2)} GB of your ${(limitBytes / (1024**3)).toFixed(0)} GB quota.` });
        }

        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        const key = createObjectKey(req.userId, safeName);
        const contentType = contentTypeForName(safeName);
        await r2Client().send(new PutObjectCommand({ Bucket: getS3Config().bucket, Key: key, Body: body, ContentType: contentType }));

        const newFile = registerFileNode(req.userId, {
            name: safeName,
            byteSize: body.length,
            parentFolderId,
            storagePath: key,
            storageProvider: 's3',
            storageKey: key,
            contentType
        });
        res.json(newFile);
    } catch (err) {
        console.error('create-blank to R2 failed:', err.message);
        res.status(err.status || 500).json({ error: err.message || 'Could not create file in cloud storage.' });
    }
});

// Rename node
app.post('/api/files/rename/:id', requireAuth, (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required.' });
    const allNodes = readUserNodes(req.userId);
    const node = allNodes.find(n => n.id === req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found.' });
    node.name = name.trim();
    node.modifiedAt = Date.now();
    writeUserNodes(req.userId, allNodes);
    res.json({ success: true, node });
});

// Move node
app.post('/api/files/move', requireAuth, (req, res) => {

    const { itemId, destinationFolderId } = req.body;
    const allNodes = readUserNodes(req.userId);
    const node = allNodes.find(n => n.id === itemId);

    if (!node) return res.status(404).json({ error: 'Target component missing' });

    node.parentFolderId = destinationFolderId || null;
    node.modifiedAt = Date.now();
    writeUserNodes(req.userId, allNodes);
    res.json({ success: true });
});

// Inline view/playback (images, video, audio, text preview). Unlike download,
// this serves the file inline (no Content-Disposition: attachment) and is
// what <video>/<img> tags should point at instead of a raw storagePath —
// critical for R2-stored files, where the raw object URL may not be public.
app.get('/api/files/view/:id', requireAuth, (req, res) => {
    const allNodes = readUserNodes(req.userId);
    const node = allNodes.find(n => n.id === req.params.id);
    if (!node || node.isFolder) return res.status(404).send('Node streaming target unavailable.');
    deliverNode(req, res, node, { download: false });
});

// Small cached preview for grid/carousel thumbnails. Locally-stored images
// get a real resized JPEG (~480px, cached to disk after first request) so
// scrolling the file grid doesn't pull down full-resolution originals —
// this is what was making freshly uploaded iPhone photos feel slow to load,
// since every thumbnail was silently loading the full original file.
// Non-image nodes and cloud (R2/S3) files fall back to /view's behavior,
// since thumbnailing a remote object is out of scope here.
app.get('/api/files/thumbnail/:id', requireAuth, async (req, res) => {
    const allNodes = readUserNodes(req.userId);
    const node = allNodes.find(n => n.id === req.params.id);
    if (!node || node.isFolder) return res.status(404).send('Node streaming target unavailable.');
    const blockReason = scanBlockReason(node);
    if (blockReason) return res.status(403).json({ error: blockReason });

    const isRemote = node.storageProvider === 's3' || /^https?:\/\//i.test(node.storagePath || '');
    if (isRemote || node.fileType !== 'IMAGE') {
        return deliverNode(req, res, node, { download: false });
    }

    const physicalPath = resolveLocalUploadPath(node.storagePath);
    if (!physicalPath) return res.status(400).send('Could not resolve file on local disk.');
    return serveOrBuildThumbnail(req, res, req.userId, physicalPath, path.basename(physicalPath));
});

// Download file
app.get('/api/files/download/:id', requireAuth, (req, res) => {
    const allNodes = readUserNodes(req.userId);
    const node = allNodes.find(n => n.id === req.params.id);
    if (!node || node.isFolder) return res.status(404).send('Node streaming target unavailable.');
    deliverNode(req, res, node, { download: true });
});

// Soft-delete node(s) → move to Trash (3-day TTL)
app.delete('/api/files/remove/:id', requireAuth, enforceFeatureAccess, (req, res) => {
    let allNodes = readUserNodes(req.userId);
    const targetId = req.params.id;

    function gatherChildren(id) {
        let childs = allNodes.filter(n => n.parentFolderId === id);
        let subChilds = [];
        childs.forEach(c => {
            if (c.isFolder) subChilds = subChilds.concat(gatherChildren(c.id));
        });
        return childs.concat(subChilds);
    }

    const primaryTarget = allNodes.find(n => n.id === targetId);
    if (!primaryTarget) return res.status(404).json({ error: 'Node absent.' });

    let targetsToRemove = [primaryTarget];
    if (primaryTarget.isFolder) {
        targetsToRemove = targetsToRemove.concat(gatherChildren(primaryTarget.id));
    }

    // Move to trash instead of hard-deleting
    const trash = readTrash(req.userId);
    const now = Date.now();
    targetsToRemove.forEach(node => {
        trash.push({ ...node, deletedAt: now, originalParent: node.parentFolderId });
    });
    writeTrash(req.userId, trash);

    const removeIds = new Set(targetsToRemove.map(t => t.id));
    allNodes = allNodes.filter(n => !removeIds.has(n.id));
    writeUserNodes(req.userId, allNodes);
    res.json({ success: true, discardedCount: removeIds.size });
});

// Small cached preview for a trashed item — mirrors /api/files/thumbnail/:id
// above, but reads from this user's Trash instead of their live node list
// (soft-deleted nodes are moved out of readUserNodes entirely, so the live
// thumbnail route can never find them). Same on-disk cache, same resize
// pipeline — a file's thumbnail doesn't need regenerating just because the
// file got trashed.
app.get('/api/trash/thumbnail/:id', requireAuth, async (req, res) => {
    const trash = readTrash(req.userId);
    const node = trash.find(n => n.id === req.params.id);
    if (!node || node.isFolder) return res.status(404).send('Node streaming target unavailable.');
    const blockReason = scanBlockReason(node);
    if (blockReason) return res.status(403).json({ error: blockReason });

    const isRemote = node.storageProvider === 's3' || /^https?:\/\//i.test(node.storagePath || '');
    if (isRemote || node.fileType !== 'IMAGE') {
        return deliverNode(req, res, node, { download: false });
    }

    const physicalPath = resolveLocalUploadPath(node.storagePath);
    if (!physicalPath) return res.status(400).send('Could not resolve file on local disk.');
    return serveOrBuildThumbnail(req, res, req.userId, physicalPath, path.basename(physicalPath));
});

// Get trash items for current user
app.get('/api/trash', requireAuth, (req, res) => {
    const trash = readTrash(req.userId);
    const now = Date.now();
    // Enrich each item with daysLeft
    const enriched = trash.map(t => ({
        ...t,
        daysLeft: Math.ceil((TRASH_TTL_MS - (now - t.deletedAt)) / (24 * 60 * 60 * 1000))
    }));
    res.json(enriched);
});

// Restore item from trash
app.post('/api/trash/restore/:id', requireAuth, (req, res) => {
    let trash = readTrash(req.userId);
    let allNodes = readUserNodes(req.userId);

    const item = trash.find(t => t.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Trash item not found.' });

    // Collect this item + its children (if folder)
    const ids = [item.id];
    if (item.isFolder) {
        // gather all descendants from trash
        function gatherTrashChildren(parentId) {
            trash.filter(t => t.originalParent === parentId || t.parentFolderId === parentId)
                 .forEach(t => { if (!ids.includes(t.id)) { ids.push(t.id); if (t.isFolder) gatherTrashChildren(t.id); } });
        }
        gatherTrashChildren(item.id);
    }

    const toRestore = trash.filter(t => ids.includes(t.id));
    toRestore.forEach(t => {
        const { deletedAt, daysLeft, originalParent, ...node } = t;
        allNodes.push(node);
    });
    trash = trash.filter(t => !ids.includes(t.id));

    writeUserNodes(req.userId, allNodes);
    writeTrash(req.userId, trash);
    res.json({ success: true, restored: toRestore.length });
});

// Permanently delete item from trash
app.delete('/api/trash/purge/:id', requireAuth, (req, res) => {
    let trash = readTrash(req.userId);
    const item = trash.find(t => t.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Trash item not found.' });

    const ids = [item.id];
    if (item.isFolder) {
        function gatherTrashChildren2(parentId) {
            trash.filter(t => t.parentFolderId === parentId).forEach(t => { ids.push(t.id); if (t.isFolder) gatherTrashChildren2(t.id); });
        }
        gatherTrashChildren2(item.id);
    }

    trash.filter(t => ids.includes(t.id)).forEach(t => {
        purgeNodeFile(t);
    });
    trash = trash.filter(t => !ids.includes(t.id));
    writeTrash(req.userId, trash);
    res.json({ success: true });
});

// Empty entire trash
app.delete('/api/trash/empty', requireAuth, (req, res) => {
    const trash = readTrash(req.userId);
    trash.forEach(t => {
        purgeNodeFile(t);
    });
    writeTrash(req.userId, []);
    res.json({ success: true });
});

// Copy node(s) to a destination folder
app.post('/api/files/copy', requireAuth, (req, res) => {
    const { ids, destinationFolderId } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No ids provided.' });

    let allNodes = readUserNodes(req.userId);
    const destId = destinationFolderId || null;

    // Recursively deep-copy a node (and its children if folder)
    function deepCopy(nodeId, newParentId) {
        const original = allNodes.find(n => n.id === nodeId);
        if (!original) return;
        const newId = (original.isFolder ? 'folder' : 'file') + `_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
        const copy = {
            ...original,
            id: newId,
            name: original.isFolder ? original.name + ' (copy)' : (() => {
                const dotIdx = original.name.lastIndexOf('.');
                return dotIdx > 0
                    ? original.name.slice(0, dotIdx) + ' (copy)' + original.name.slice(dotIdx)
                    : original.name + ' (copy)';
            })(),
            parentFolderId: newParentId,
            createdAt: Date.now()
        };
        // For files: duplicate the physical file on disk
        if (!original.isFolder && original.storagePath) {
            try {
                const srcAbs = path.join(DATA_DIR, original.storagePath.replace(/^\//, ''));
                if (fs.existsSync(srcAbs)) {
                    const filename = `file_${Date.now()}_${Math.random().toString(36).slice(2,7)}_${path.basename(srcAbs)}`;
                    const destDir  = path.join(UPLOADS_DIR, req.userId);
                    fs.mkdirSync(destDir, { recursive: true });
                    const destAbs  = path.join(destDir, filename);
                    fs.copyFileSync(srcAbs, destAbs);
                    copy.storagePath = `/uploads/${req.userId}/${filename}`;
                }
            } catch(e) { /* silently skip if file missing */ }
        }
        allNodes.push(copy);
        // Recurse for folder children
        if (original.isFolder) {
            const children = allNodes.filter(n => n.parentFolderId === original.id && n.id !== copy.id);
            children.forEach(child => deepCopy(child.id, copy.id));
        }
        return copy;
    }

    const copied = [];
    ids.forEach(id => {
        const c = deepCopy(id, destId);
        if (c) copied.push(c);
    });

    writeUserNodes(req.userId, allNodes);
    res.json({ success: true, copied: copied.length });
});

// List all users except the current one (for share modal)
app.get('/api/users', requireAuth, (req, res) => {
    const users = readUsers();
    const list = users
        .filter(u => u.id !== req.userId)
        .map(u => ({ id: u.id, username: u.username }));
    res.json(list);
});

// Share a file/folder with another user
// The shared item is COPIED into the recipient's drive and counts against their storage quota.
app.post('/api/files/share', requireAuth, enforceFeatureAccess, (req, res) => {
    const { nodeId, recipientId } = req.body;
    if (!nodeId || !recipientId) return res.status(400).json({ error: 'nodeId and recipientId required.' });

    const users = readUsers();
    const sender = users.find(u => u.id === req.userId);
    const recipient = users.find(u => u.id === recipientId);
    if (!recipient) return res.status(404).json({ error: 'Recipient not found.' });

    const ownerNodes = readUserNodes(req.userId);
    const node = ownerNodes.find(n => n.id === nodeId);
    if (!node) return res.status(404).json({ error: 'Node not found.' });

    const shared = readShared();
    const already = shared.find(s => s.nodeId === nodeId && s.ownerId === req.userId && s.recipientId === recipientId);
    if (already) return res.status(409).json({ error: 'Already shared with this user.' });

    // ── Calculate total size of everything being shared ──
    function gatherSize(nId) {
        const n = ownerNodes.find(x => x.id === nId);
        if (!n) return 0;
        if (!n.isFolder) return n.byteSize || 0;
        return ownerNodes.filter(x => x.parentFolderId === nId).reduce((s, c) => s + gatherSize(c.id), 0);
    }
    const totalSize = gatherSize(nodeId);

    // ── Check recipient has enough free storage ──
    const recipientUsed = getUserUsedBytes(recipientId);
    const recipientLimitBytes = ((recipient.storageLimitGB) || 30) * 1024 * 1024 * 1024;
    if (recipientUsed + totalSize > recipientLimitBytes) {
        const needsGB  = (totalSize / (1024 ** 3)).toFixed(2);
        const freeGB   = Math.max(0, (recipientLimitBytes - recipientUsed) / (1024 ** 3)).toFixed(2);
        return res.status(413).json({
            error: `${recipient.username} doesn't have enough storage. Sharing needs ${needsGB} GB but they only have ${freeGB} GB free.`
        });
    }

    // ── Ensure "📥 Shared With Me" root folder exists in recipient's drive ──
    let recipientNodes = readUserNodes(recipientId);
    const INBOX_ID = `shared_inbox_${recipientId}`;
    if (!recipientNodes.find(n => n.id === INBOX_ID)) {
        recipientNodes.push({
            id: INBOX_ID,
            name: '📥 Shared With Me',
            isFolder: true,
            parentFolderId: null,
            createdAt: Date.now(),
            sharedInbox: true
        });
    }

    // ── Recursively copy the node tree into recipient's drive ──
    function copyNodeToRecipient(srcNodeId, destParentId) {
        const src = ownerNodes.find(n => n.id === srcNodeId);
        if (!src) return null;

        const newId = (src.isFolder ? 'folder' : 'file') + `_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const copy  = {
            ...src,
            id: newId,
            parentFolderId: destParentId,
            createdAt: Date.now(),
            sharedFrom: sender?.username || 'unknown',
            sharedFromId: req.userId
        };

        if (!src.isFolder && src.storagePath) {
            try {
                const srcAbs = path.join(DATA_DIR, src.storagePath.replace(/^\//, ''));
                if (fs.existsSync(srcAbs)) {
                    const filename = `file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${path.basename(srcAbs)}`;
                    const destDir  = path.join(UPLOADS_DIR, recipientId);
                    fs.mkdirSync(destDir, { recursive: true });
                    fs.copyFileSync(srcAbs, path.join(destDir, filename));
                    copy.storagePath = `/uploads/${recipientId}/${filename}`;
                }
            } catch (e) { console.error('share copy error:', e); }
        }

        recipientNodes.push(copy);

        if (src.isFolder) {
            ownerNodes.filter(n => n.parentFolderId === src.id)
                      .forEach(child => copyNodeToRecipient(child.id, newId));
        }
        return copy;
    }

    const copiedRoot = copyNodeToRecipient(nodeId, INBOX_ID);
    writeUserNodes(recipientId, recipientNodes);

    // ── Also copy into the sender's own "📤 Shared by Me" folder ──
    const OUTBOX_ID = `shared_outbox_${req.userId}`;
    let ownerNodesMut = readUserNodes(req.userId);
    if (!ownerNodesMut.find(n => n.id === OUTBOX_ID)) {
        ownerNodesMut.push({ id: OUTBOX_ID, name: '📤 Shared by Me', isFolder: true, parentFolderId: null, createdAt: Date.now(), sharedOutbox: true });
    }
    function copyNodeToSender(srcNodeId, destParentId) {
        const src = ownerNodesMut.find(n => n.id === srcNodeId) || ownerNodes.find(n => n.id === srcNodeId);
        if (!src) return;
        const newId = (src.isFolder ? 'folder' : 'file') + `_snd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const copy = { ...src, id: newId, parentFolderId: destParentId, createdAt: Date.now(), sharedToId: recipientId, sharedTo: recipient.username };
        if (!src.isFolder && src.storagePath) {
            try {
                const srcAbs = path.join(DATA_DIR, src.storagePath.replace(/^\//, ''));
                if (fs.existsSync(srcAbs)) {
                    const filename = `file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${path.basename(srcAbs)}`;
                    const destDir  = path.join(UPLOADS_DIR, req.userId);
                    fs.mkdirSync(destDir, { recursive: true });
                    fs.copyFileSync(srcAbs, path.join(destDir, filename));
                    copy.storagePath = `/uploads/${req.userId}/${filename}`;
                }
            } catch (e) { console.error('sender copy error:', e); }
        }
        ownerNodesMut.push(copy);
        if (src.isFolder) {
            ownerNodes.filter(n => n.parentFolderId === src.id).forEach(child => copyNodeToSender(child.id, newId));
        }
    }
    copyNodeToSender(nodeId, OUTBOX_ID);
    writeUserNodes(req.userId, ownerNodesMut);

    // ── Record in shared.json for the "Shared" section ──
    const entry = {
        sharedId: `share_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        nodeId,
        recipientNodeId: copiedRoot?.id || null,   // the copy in recipient's drive
        ownerId: req.userId,
        ownerUsername: sender?.username || 'unknown',
        recipientId,
        sharedAt: Date.now(),
        name: node.name,
        isFolder: node.isFolder || false,
        fileType: node.fileType || null,
        byteSize: totalSize,
        storagePath: node.storagePath || null
    };
    shared.push(entry);
    writeShared(shared);

    res.json({ success: true, entry });
});

// Get files shared with the current user
app.get('/api/files/shared-with-me', requireAuth, (req, res) => {
    const shared = readShared();
    const mine = shared.filter(s => s.recipientId === req.userId);
    const recipientNodes = readUserNodes(req.userId);

    const enriched = mine.map(s => {
        // Prefer the recipient's own copy (new behaviour)
        if (s.recipientNodeId) {
            const ownCopy = recipientNodes.find(n => n.id === s.recipientNodeId);
            if (ownCopy) {
                return { ...s, name: ownCopy.name, byteSize: ownCopy.byteSize || 0, storagePath: ownCopy.storagePath, fileType: ownCopy.fileType };
            }
        }
        // Legacy fallback: look in owner's drive (old shared.json entries without recipientNodeId)
        const ownerNodes = readUserNodes(s.ownerId);
        const live = ownerNodes.find(n => n.id === s.nodeId);
        if (live) {
            return { ...s, name: live.name, byteSize: live.byteSize || 0, storagePath: live.storagePath, fileType: live.fileType };
        }
        return { ...s, _deleted: true };
    });
    res.json(enriched.filter(s => !s._deleted));
});

// The reverse view: everything the current user has shared OUT to other
// people. Same shared.json store, just filtered by ownerId instead of
// recipientId, and enriched with the recipient's username instead of the
// owner's (the frontend shows "To: <name>" here instead of "From: <name>").
app.get('/api/files/shared-by-me', requireAuth, (req, res) => {
    const shared = readShared();
    const mine = shared.filter(s => s.ownerId === req.userId);
    const ownerNodes = readUserNodes(req.userId);
    const users = readUsers();

    const enriched = mine.map(s => {
        const live = ownerNodes.find(n => n.id === s.nodeId);
        const recipient = users.find(u => u.id === s.recipientId);
        const recipientUsername = recipient ? recipient.username : (s.recipientUsername || 'a deleted user');
        if (live) {
            return { ...s, name: live.name, byteSize: live.byteSize || 0, storagePath: live.storagePath, fileType: live.fileType, isFolder: live.isFolder, recipientUsername };
        }
        return { ...s, _deleted: true, recipientUsername };
    });
    res.json(enriched.filter(s => !s._deleted));
});

// Download a shared file (recipient access)
app.get('/api/files/shared-download/:sharedId', requireAuth, async (req, res) => {
    const shared = readShared();
    const entry = shared.find(s => s.sharedId === req.params.sharedId && s.recipientId === req.userId);
    if (!entry) return res.status(404).json({ error: 'Shared entry not found.' });

    if (entry.recipientNodeId) {
        const recipientNodes = readUserNodes(req.userId);
        const ownCopy = recipientNodes.find(n => n.id === entry.recipientNodeId && !n.isFolder);
        if (ownCopy && ownCopy.storagePath) {
            return deliverNode(req, res, ownCopy, { download: true });
        }
    }

    const ownerNodes = readUserNodes(entry.ownerId);
    const node = ownerNodes.find(n => n.id === entry.nodeId);
    if (!node || node.isFolder) return res.status(404).json({ error: 'File not found.' });
    deliverNode(req, res, node, { download: true });
});

/* ════════════════════════════════════════════════════════════════════
 *  DROP ROOMS — temporary guest-upload links
 *  A room is a public, tokenized upload link an owner can hand to anyone
 *  (no SpaceKhazana account needed). Guests can only ever POST a file in —
 *  they never get read access to the owner's drive. Every accepted upload
 *  lands as a normal file node in the owner's own storage (counts against
 *  their quota) inside a dedicated folder, tagged with which room it came
 *  through so the owner can tell dropped files apart from their own.
 * ════════════════════════════════════════════════════════════════════ */
const DROP_ROOMS_FILE = path.join(DATA_DIR, 'drop_rooms.json');
const readDropRooms   = () => { try { return JSON.parse(fs.readFileSync(DROP_ROOMS_FILE, 'utf8')); } catch { return []; } };
const writeDropRooms  = (d) => fs.writeFileSync(DROP_ROOMS_FILE, JSON.stringify(d, null, 2), 'utf8');

const DROP_ROOM_DEFAULT_MAX_FILE_MB = 500;   // per-file cap if the owner doesn't set one
const DROP_ROOM_MAX_FILE_MB_CEILING = 5000;  // absolute ceiling no room can exceed
const DROP_ROOM_MAX_UPLOADS_CEILING = 5000;  // absolute ceiling on "max uploads" setting

function dropRoomPublicView(room, ownerUsername) {
    const now = Date.now();
    const expired = !!(room.expiresAt && now > room.expiresAt);
    const full = !!(room.maxUploads && room.uploadCount >= room.maxUploads);
    return {
        token: room.token,
        name: room.name,
        ownerUsername,
        open: room.active && !expired && !full,
        expired,
        full,
        expiresAt: room.expiresAt || null,
        maxFileMB: room.maxFileMB,
        uploadCount: room.uploadCount,
        maxUploads: room.maxUploads || null,
        visibility: room.visibility === 'public' ? 'public' : 'private'
    };
}

// Create a new drop room
app.post('/api/drop-rooms', requireAuth, blockIfDeviceRestricted, (req, res) => {
    const { name, parentFolderId, expiresInHours, maxUploads, maxFileMB, visibility } = req.body || {};
    const roomName = String(name || 'Drop Room').trim().slice(0, 80) || 'Drop Room';
    const roomVisibility = visibility === 'public' ? 'public' : 'private';

    let folderId = parentFolderId || null;
    let targetFolderName = null;
    // No target folder given → create a dedicated one, so guest uploads land
    // somewhere findable instead of dumped loose at the drive root.
    if (!folderId) {
        const nodes = readUserNodes(req.userId);
        const folder = {
            id: `folder_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            name: `📥 ${roomName}`,
            isFolder: true,
            parentFolderId: null,
            createdAt: Date.now(),
            dropRoomFolder: true
        };
        nodes.push(folder);
        writeUserNodes(req.userId, nodes);
        folderId = folder.id;
        targetFolderName = folder.name;
    } else {
        const existing = readUserNodes(req.userId).find(n => n.id === folderId && n.isFolder);
        targetFolderName = existing ? existing.name : roomName;
    }

    const room = {
        id: `room_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        token: crypto.randomBytes(16).toString('hex'),
        ownerId: req.userId,
        name: roomName,
        targetFolderId: folderId,
        targetFolderName,
        active: true,
        visibility: roomVisibility, // 'private' (default, owner-only) or 'public' (anyone with the link can see the drop box's contents)
        createdAt: Date.now(),
        expiresAt: expiresInHours ? Date.now() + Number(expiresInHours) * 3600 * 1000 : null,
        maxUploads: maxUploads ? Math.min(Number(maxUploads), DROP_ROOM_MAX_UPLOADS_CEILING) : null,
        maxFileMB: maxFileMB ? Math.min(Number(maxFileMB), DROP_ROOM_MAX_FILE_MB_CEILING) : DROP_ROOM_DEFAULT_MAX_FILE_MB,
        uploadCount: 0
    };

    const rooms = readDropRooms();
    rooms.push(room);
    writeDropRooms(rooms);

    res.json({ success: true, room, url: `/drop/${room.token}` });
});

// List the current user's drop rooms
app.get('/api/drop-rooms', requireAuth, (req, res) => {
    res.json(readDropRooms().filter(r => r.ownerId === req.userId));
});

// Update a room: rename, toggle on/off, change expiry/limits
app.patch('/api/drop-rooms/:id', requireAuth, (req, res) => {
    const rooms = readDropRooms();
    const room = rooms.find(r => r.id === req.params.id && r.ownerId === req.userId);
    if (!room) return res.status(404).json({ error: 'Drop room not found.' });

    const { name, active, expiresInHours, maxUploads, maxFileMB, visibility } = req.body || {};
    if (name !== undefined) room.name = String(name).trim().slice(0, 80) || room.name;
    if (active !== undefined) room.active = !!active;
    if (expiresInHours !== undefined) room.expiresAt = expiresInHours ? Date.now() + Number(expiresInHours) * 3600 * 1000 : null;
    if (maxUploads !== undefined) room.maxUploads = maxUploads ? Math.min(Number(maxUploads), DROP_ROOM_MAX_UPLOADS_CEILING) : null;
    if (maxFileMB !== undefined) room.maxFileMB = maxFileMB ? Math.min(Number(maxFileMB), DROP_ROOM_MAX_FILE_MB_CEILING) : room.maxFileMB;
    if (visibility !== undefined) room.visibility = visibility === 'public' ? 'public' : 'private';

    writeDropRooms(rooms);
    res.json({ success: true, room });
});

// Revoke a room. Files already dropped stay in the owner's drive — this
// only closes the door for future guest uploads.
app.delete('/api/drop-rooms/:id', requireAuth, (req, res) => {
    const rooms = readDropRooms();
    const room = rooms.find(r => r.id === req.params.id && r.ownerId === req.userId);
    if (!room) return res.status(404).json({ error: 'Drop room not found.' });
    writeDropRooms(rooms.filter(r => r.id !== room.id));
    res.json({ success: true });
});

// Files a specific room has collected so far (owner-only)
app.get('/api/drop-rooms/:id/uploads', requireAuth, (req, res) => {
    const rooms = readDropRooms();
    const room = rooms.find(r => r.id === req.params.id && r.ownerId === req.userId);
    if (!room) return res.status(404).json({ error: 'Drop room not found.' });
    res.json(readUserNodes(req.userId).filter(n => n.droppedViaRoomId === room.id));
});

// ── Public: guest-facing room info — no auth, just the token ──
app.get('/api/drop-rooms/public/:token', (req, res) => {
    const room = readDropRooms().find(r => r.token === req.params.token);
    if (!room) return res.status(404).json({ error: 'This drop link is invalid.' });
    const owner = readUsers().find(u => u.id === room.ownerId);
    res.json(dropRoomPublicView(room, owner?.username || 'someone'));
});

// ── Public: the drop box's contents — ONLY when the owner has set this
//    room's visibility to "public". Includes grade/feedback so uploaders can
//    see each other's remarks, per the room's settings, but never a guest's
//    email address — that stays owner-only regardless of visibility. ──
app.get('/api/drop-rooms/:token/public-files', (req, res) => {
    const room = readDropRooms().find(r => r.token === req.params.token);
    if (!room) return res.status(404).json({ error: 'This drop link is invalid.' });
    if (room.visibility !== 'public') return res.status(403).json({ error: 'This drop box is private.' });

    const nodes = readUserNodes(room.ownerId).filter(n => n.droppedViaRoomId === room.id);
    res.json(nodes.map(n => ({
        id: n.id,
        name: n.name,
        byteSize: n.byteSize || 0,
        fileType: n.fileType || 'OTHER',
        guestName: n.guestName || null,
        uploadedAt: n.createdAt,
        grade: n.grade || null,
        feedback: n.feedback || null,
        gradedAt: n.gradedAt || null
    })));
});

// ── Public: download a single file from a public drop box. Still requires
//    visibility === 'public' and that the file actually came through this
//    room — a guest (or anyone with the link) can never reach into the rest
//    of the owner's drive through this route. ──
app.get('/api/drop-rooms/:token/public-files/:nodeId/download', async (req, res) => {
    const room = readDropRooms().find(r => r.token === req.params.token);
    if (!room) return res.status(404).send('This drop link is invalid.');
    if (room.visibility !== 'public') return res.status(403).send('This drop box is private.');

    const nodes = readUserNodes(room.ownerId);
    const node = nodes.find(n => n.id === req.params.nodeId && n.droppedViaRoomId === room.id);
    if (!node) return res.status(404).send('File not found.');

    deliverNode(req, res, node, { download: true });
});

// Dedicated limiter for the public guest-upload endpoint. This route is
// reachable by anyone with the link and no account at all, so it needs its
// own tighter, independent ceiling on top of the general API limiter.
const dropRoomUploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many uploads from this connection. Please slow down and try again shortly.' }
});

const dropRoomUpload = multer({
    storage: new R2StorageEngine({
        getKey: (req, file) => createObjectKey(req._dropRoom ? req._dropRoom.ownerId : 'unknown', file.originalname)
    }),
    limits: { files: 1, fileSize: DROP_ROOM_MAX_FILE_MB_CEILING * 1024 * 1024 }
});

// ── Public: guest upload — no account needed, just the room token ──
app.post('/api/drop-rooms/:token/upload', dropRoomUploadLimiter, (req, res, next) => {
    const room = readDropRooms().find(r => r.token === req.params.token);
    if (!room) return res.status(404).json({ error: 'This drop link is invalid.' });

    const now = Date.now();
    if (!room.active) return res.status(403).json({ error: 'This drop link has been turned off by its owner.' });
    if (room.expiresAt && now > room.expiresAt) return res.status(403).json({ error: 'This drop link has expired.' });
    if (room.maxUploads && room.uploadCount >= room.maxUploads) return res.status(403).json({ error: 'This drop link has reached its upload limit.' });

    req._dropRoom = room;
    next();
}, (req, res) => {
    const room = req._dropRoom;

    dropRoomUpload.single('file')(req, res, (err) => {
        if (err) {
            removeUploadedFile(req.file);
            const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
            return res.status(status).json({ error: err.message || 'Upload failed.' });
        }
        if (!req.file) return res.status(400).json({ error: 'No file received.' });

        // Each room can set a per-file cap stricter than multer's hard ceiling above.
        if (req.file.size > room.maxFileMB * 1024 * 1024) {
            removeUploadedFile(req.file);
            return res.status(413).json({ error: `File too large. This drop link accepts files up to ${room.maxFileMB} MB.` });
        }

        // Guest uploads still count against the room owner's storage quota.
        const used = getUserUsedBytes(room.ownerId);
        const limitBytes = getUserLimitBytes(room.ownerId);
        if (used + req.file.size > limitBytes) {
            removeUploadedFile(req.file);
            return res.status(413).json({ error: 'The owner of this drop link is out of storage space right now.' });
        }

        try {
            const guestName = String((req.body && req.body.guestName) || '').trim().slice(0, 60);
            const guestEmailRaw = String((req.body && req.body.guestEmail) || '').trim().slice(0, 200);
            const guestEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmailRaw) ? guestEmailRaw : null;
            const guestUsername = String((req.body && req.body.guestUsername) || '').trim().slice(0, 60);
            // Loose phone validation — accepts digits, spaces, +, -, ()
            // since guests may enter numbers in all sorts of local formats.
            const guestPhoneRaw = String((req.body && req.body.guestPhone) || '').trim().slice(0, 30);
            const guestPhone = /^[+\d][\d\s().-]{5,29}$/.test(guestPhoneRaw) ? guestPhoneRaw : null;
            // Cloudflare Tunnel puts the real client IP in cf-connecting-ip;
            // fall back through the standard proxy chain, then the raw
            // socket address for direct connections.
            const uploaderIp = req.headers['cf-connecting-ip']
                || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
                || req.socket.remoteAddress
                || null;
            const submissionToken = crypto.randomBytes(12).toString('hex');

            const fileNode = registerFileNode(room.ownerId, {
                name: req.file.originalname,
                byteSize: req.file.size,
                parentFolderId: room.targetFolderId,
                storagePath: req.file.key,
                storageProvider: 's3',
                storageKey: req.file.key,
                contentType: req.file.mimetype,
                etag: req.file.etag
            });

            // Tag the node with where it came from, then persist those extra fields.
            const nodes = readUserNodes(room.ownerId);
            const idx = nodes.findIndex(n => n.id === fileNode.id);
            if (idx !== -1) {
                nodes[idx].droppedViaRoomId = room.id;
                nodes[idx].droppedByGuest = true;
                nodes[idx].submissionToken = submissionToken;
                nodes[idx].droppedAt = Date.now();
                if (guestName) nodes[idx].guestName = guestName;
                if (guestEmail) nodes[idx].guestEmail = guestEmail;
                if (guestUsername) nodes[idx].guestUsername = guestUsername;
                if (guestPhone) nodes[idx].guestPhone = guestPhone;
                if (uploaderIp) nodes[idx].uploaderIp = uploaderIp;
                writeUserNodes(room.ownerId, nodes);
            }

            const rooms2 = readDropRooms();
            const r2 = rooms2.find(r => r.id === room.id);
            if (r2) { r2.uploadCount = (r2.uploadCount || 0) + 1; writeDropRooms(rooms2); }

            return res.json({ success: true, name: fileNode.name, submissionToken });
        } catch (nodeErr) {
            removeUploadedFile(req.file);
            console.error('Drop room upload registration failed:', nodeErr);
            return res.status(500).json({ error: 'Upload saved but could not be registered. Please try again.' });
        }
    });
});

// ── Public: a guest checks their own submission's grade/feedback using the
//    private submissionToken they were given right after uploading. This
//    never exposes anything about the room owner's other files. ──
app.get('/api/drop-rooms/submission/:submissionToken', (req, res) => {
    const rooms = readDropRooms();
    for (const room of rooms) {
        const nodes = readUserNodes(room.ownerId);
        const node = nodes.find(n => n.submissionToken === req.params.submissionToken);
        if (node) {
            return res.json({
                name: node.name,
                roomName: room.name,
                uploadedAt: node.createdAt,
                grade: node.grade || null,
                feedback: node.feedback || null,
                gradedAt: node.gradedAt || null,
                // Lets the status page offer a "View all uploads" button back
                // to the room — only meaningful (and only ever rendered) when
                // the room's visibility is public, same rule enforced by
                // /api/drop-rooms/:token/public-files itself.
                roomToken: room.token,
                roomVisibility: room.visibility === 'public' ? 'public' : 'private'
            });
        }
    }
    res.status(404).json({ error: 'Submission not found. Check the link and try again.' });
});

// ── Owner: grade / reply to a specific dropped submission. Emails the
//    guest (if they left an address) so they're notified without needing
//    an account of their own. ──
app.patch('/api/drop-rooms/:roomId/uploads/:nodeId/grade', requireAuth, async (req, res) => {
    const rooms = readDropRooms();
    const room = rooms.find(r => r.id === req.params.roomId && r.ownerId === req.userId);
    if (!room) return res.status(404).json({ error: 'Drop room not found.' });

    const nodes = readUserNodes(req.userId);
    const idx = nodes.findIndex(n => n.id === req.params.nodeId && n.droppedViaRoomId === room.id);
    if (idx === -1) return res.status(404).json({ error: 'Submission not found in this room.' });

    const { grade, feedback } = req.body || {};
    nodes[idx].grade = grade !== undefined ? String(grade).trim().slice(0, 40) : (nodes[idx].grade || null);
    nodes[idx].feedback = feedback !== undefined ? String(feedback).trim().slice(0, 2000) : (nodes[idx].feedback || null);
    nodes[idx].gradedAt = Date.now();
    writeUserNodes(req.userId, nodes);

    const node = nodes[idx];
    let emailSent = false;
    if (node.guestEmail && GMAIL_USER && GMAIL_PASS) {
        try {
            const statusUrl = `${req.protocol}://${req.get('host')}/drop/status/${node.submissionToken}`;
            await mailer.sendMail({
                from: GMAIL_USER,
                to: node.guestEmail,
                subject: `Your submission "${node.name}" was graded`,
                text: `Hi${node.guestName ? ' ' + node.guestName : ''},\n\n` +
                      `Your file "${node.name}" in "${room.name}" was just reviewed.\n` +
                      (node.grade ? `Grade: ${node.grade}\n` : '') +
                      (node.feedback ? `Feedback: ${node.feedback}\n` : '') +
                      `\nView it anytime here: ${statusUrl}\n`
            });
            emailSent = true;
        } catch (e) {
            console.error('Grading email failed:', e.message);
        }
    }

    res.json({ success: true, node, emailSent });
});

// Serve the guest-facing upload page for any drop link (same page for every
// token — it reads the token from the URL client-side and calls the two

// public endpoints above).
app.get('/drop/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'drop.html'));
});

// Guest-facing "check my grade/feedback" page, keyed by the private
// submissionToken handed back right after upload (not the room token).
app.get('/drop/status/:submissionToken', (req, res) => {
    res.sendFile(path.join(__dirname, 'drop-status.html'));
});

/* ════════════════════════════════════════════════════════════════════
 *  SMART TAGS & INSTANT SEARCH
 *  Files can carry a small set of free-form tags in addition to (not
 *  instead of) folder placement. /api/smart-groups buckets a user's whole
 *  drive by file type, by tag, and by recent activity — a "workspace" view
 *  that doesn't require any folder to already exist.
 * ════════════════════════════════════════════════════════════════════ */
const MAX_TAGS_PER_FILE = 15;
const MAX_TAG_LENGTH    = 30;

function normalizeTags(tags) {
    if (!Array.isArray(tags)) return null;
    return [...new Set(
        tags.map(t => String(t).trim().toLowerCase().slice(0, MAX_TAG_LENGTH)).filter(Boolean)
    )].slice(0, MAX_TAGS_PER_FILE);
}

// Replace the full tag list for a node
app.patch('/api/files/:id/tags', requireAuth, (req, res) => {
    const clean = normalizeTags(req.body && req.body.tags);
    if (clean === null) return res.status(400).json({ error: 'tags must be an array of strings.' });

    const nodes = readUserNodes(req.userId);
    const node = nodes.find(n => n.id === req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found.' });

    node.tags = clean;
    writeUserNodes(req.userId, nodes);
    res.json({ success: true, node });
});

// Bucket the user's files by type, by tag, and by recent activity — no
// folder hierarchy required.
app.get('/api/smart-groups', requireAuth, (req, res) => {
    const nodes = readUserNodes(req.userId).filter(n => !n.isFolder);

    const byType = {};
    const byTag  = {};
    nodes.forEach(n => {
        const type = n.fileType || 'OTHER';
        (byType[type] = byType[type] || []).push(n);
        (n.tags || []).forEach(tag => (byTag[tag] = byTag[tag] || []).push(n));
    });

    const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const recent = nodes
        .filter(n => now - (n.createdAt || 0) <= RECENT_WINDOW_MS)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    res.json({
        byType,
        tags: Object.keys(byTag).sort().map(tag => ({ tag, count: byTag[tag].length, files: byTag[tag] })),
        recent
    });
});

// Instant search across file name and tags
app.get('/api/files/search', requireAuth, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json([]);
    const nodes = readUserNodes(req.userId).filter(n => !n.isFolder);
    res.json(nodes.filter(n =>
        n.name.toLowerCase().includes(q) || (n.tags || []).some(t => t.includes(q))
    ));
});

// Health check
app.get('/api/ping', (req, res) => res.json({ ok: true }));

/* ─── SITE-WIDE UPDATE ANNOUNCEMENT ────────────────────────────────────────
   Lets the admin broadcast a "new version is live" notice to every visitor
   (logged in or still on the login screen). Stored as a single JSON record
   — { id, message, createdAt } — with `id` acting as the version marker: a
   new broadcast simply writes a fresh (larger) id, so clients can tell "have
   I already shown/handled this one?" by comparing ids rather than relying on
   any kind of read receipt list. There's deliberately no per-user tracking
   on the server side — same lightweight pattern the app already uses for its
   notification bell (derive from live state, no notifications table).
   ──────────────────────────────────────────────────────────────────────── */
const readAnnouncement  = () => rj('announcement', null);
const writeAnnouncement = (d) => wj('announcement', d);

// GET /api/announcement/latest – public, unauthenticated. Polled by every
// open tab (logged in or not) so a broadcast reaches everyone on the site,
// not just users who happen to be logged in at the moment it's sent.
app.get('/api/announcement/latest', (req, res) => {
    res.json(readAnnouncement() || null);
});

/* ═══════════════════════════════════════════════════════════
   ADMIN ROUTES  –  protected by x-admin-key header
   ═══════════════════════════════════════════════════════════
   NOTE: this used to be a hardcoded 'KHAZANA-CTRL-7700' string right here in
   source — anyone with a copy of this file had full admin access (create/
   delete any user, reset passwords, browse every file). It now comes from
   GENERATED_SECRETS (env var ADMIN_KEY, or an auto-generated value logged to
   the console and saved to data/.secrets.json on first run — see top of file).
   admin.html previously also had its own separate 'admin'/'5373' login gate;
   if that check lives in admin.html's own JavaScript, it's trivially bypassed
   by viewing page source, so that page needs its own auth fix — see the
   summary at the end of this conversation for what to check there. */
let ADMIN_KEY = GENERATED_SECRETS.ADMIN_KEY;
const STORAGE_LIMIT_GB = 30;

function persistAdminKey(newKey) {
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch {}
    stored.ADMIN_KEY = newKey;
    fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
}

function requireAdmin(req, res, next) {
    const provided = req.headers['x-admin-key'] || '';
    const expected = ADMIN_KEY;
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expected));
    // Constant-time comparison — a plain !== check leaks timing information
    // that can be used to guess the key one byte at a time.
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!match) {
        return res.status(403).json({ error: 'Forbidden.' });
    }
    next();
}

// POST /api/admin/rotate-key — called by admin.html right after a successful
// login. The key that was just used to authenticate this request is replaced
// with a brand-new random one before the response goes out, so every admin
// session runs on a key that's never been used to log in before, and the key
// that got you in this time is dead the instant this call completes.
app.post('/api/admin/rotate-key', requireAdmin, (req, res) => {
    ADMIN_KEY = crypto.randomBytes(24).toString('hex');
    persistAdminKey(ADMIN_KEY);
    res.json({ adminKey: ADMIN_KEY });
});

// Helper: sum all bytes for a user
function calcUsedBytes(userId) {
    return readUserNodes(userId)
        .filter(n => !n.isFolder)
        .reduce((s, n) => s + (n.byteSize || 0), 0);
}

// GET /api/admin/users  – list all users + usage. Passwords are hashed with
// bcrypt and are never stored in the clear, so there is no plaintext value to
// show here anymore — use PUT /api/admin/users/:userId/password to set a new
// one for a user instead of trying to reveal their existing one.
app.get('/api/admin/users', requireAdmin, (req, res) => {
    const users = readUsers();
    const result = users.map(u => {
        const usedBytes = calcUsedBytes(u.id);
        // Load per-user quota override if set
        const limitGB = u.storageLimitGB || STORAGE_LIMIT_GB;
        return {
            id:             u.id,
            username:       u.username,
            storageLimitGB: limitGB,
            usedBytes,
            createdAt:      u.createdAt,
            fileCount:      readUserNodes(u.id).filter(n => !n.isFolder).length,
            folderCount:    readUserNodes(u.id).filter(n => n.isFolder).length,
        };
    });
    res.json(result);
});

// GET /api/admin/files  – every file across all users (flat list)
app.get('/api/admin/files', requireAdmin, (req, res) => {
    const users = readUsers();
    const allFiles = [];
    users.forEach(u => {
        const nodes = readUserNodes(u.id).filter(n => !n.isFolder);
        nodes.forEach(n => {
            allFiles.push({ ...n, ownerId: u.id, ownerUsername: u.username });
        });
    });
    // Sort newest first
    allFiles.sort((a, b) => b.createdAt - a.createdAt);
    res.json(allFiles);
});

// GET /api/admin/folders  – every folder across all users
app.get('/api/admin/folders', requireAdmin, (req, res) => {
    const users = readUsers();
    const allFolders = [];
    users.forEach(u => {
        const nodes = readUserNodes(u.id).filter(n => n.isFolder);
        nodes.forEach(n => {
            allFolders.push({ ...n, ownerId: u.id, ownerUsername: u.username });
        });
    });
    res.json(allFolders);
});

// GET /api/admin/stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const users = readUsers();
    let totalBytes = 0, totalFiles = 0, totalFolders = 0;
    users.forEach(u => {
        const nodes = readUserNodes(u.id);
        nodes.forEach(n => {
            if (n.isFolder) totalFolders++;
            else { totalFiles++; totalBytes += (n.byteSize || 0); }
        });
    });
    res.json({ totalUsers: users.length, totalFiles, totalFolders, totalBytes });
});

// POST /api/admin/broadcast-update – push a "new update launched" notice to
// every visitor currently on the site (or who loads it before it's cleared).
// Body: { message?: string }. Writing a fresh, larger `id` each time is what
// makes clients treat this as a *new* broadcast even if the message text is
// identical to the last one.
app.post('/api/admin/broadcast-update', requireAdmin, (req, res) => {
    const message = (req.body && typeof req.body.message === 'string' && req.body.message.trim())
        ? req.body.message.trim().slice(0, 500)
        : 'A new update has been launched. Update now to get the latest version.';
    const announcement = { id: Date.now(), message, createdAt: Date.now() };
    writeAnnouncement(announcement);
    res.json(announcement);
});

// DELETE /api/admin/broadcast-update – retract the current announcement so
// it stops popping up for anyone who hasn't seen/updated yet.
app.delete('/api/admin/broadcast-update', requireAdmin, (req, res) => {
    writeAnnouncement(null);
    res.json({ ok: true });
});

// GET /api/admin/users/:userId/files  – all nodes for one user (for storage browser)
app.get('/api/admin/users/:userId/files', requireAdmin, (req, res) => {
    const nodes = readUserNodes(req.params.userId);
    res.json({ nodes });
});

// PUT /api/admin/users/:userId/quota  – change storage quota
app.put('/api/admin/users/:userId/quota', requireAdmin, (req, res) => {
    const users = readUsers();
    const user  = users.find(u => u.id === req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    user.storageLimitGB = Math.max(1, parseInt(req.body.limitGB) || 30);
    writeUsers(users);
    res.json({ success: true, storageLimitGB: user.storageLimitGB });
});

// PUT /api/admin/users/:userId/password  – reset a user's password
app.put('/api/admin/users/:userId/password', requireAdmin, (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required.' });
    const users = readUsers();
    const user  = users.find(u => u.id === req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    user.passwordHash = hashPassword(password);
    writeUsers(users);
    res.json({ success: true });
});

// POST /api/admin/users  – create user from admin panel
app.post('/api/admin/users', requireAdmin, (req, res) => {
    const { username, password, storageLimitGB } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    const trimmed = username.trim().toLowerCase();
    const users = readUsers();
    if (users.find(u => u.username === trimmed)) return res.status(409).json({ error: 'Username taken.' });
    const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    users.push({
        id: userId,
        username: trimmed,
        passwordHash:  hashPassword(password),
        storageLimitGB: storageLimitGB || 30,
        createdAt: Date.now()
    });
    writeUsers(users);
    /* cloud-only: no per-user folder on this PC */
    res.json({ success: true, id: userId, username: trimmed });
});

// POST /api/admin/users/:userId/session  – create impersonation token
app.post('/api/admin/users/:userId/session', requireAdmin, (req, res) => {
    const users = readUsers();
    const user  = users.find(u => u.id === req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const token = generateToken();
    sessionSet(token, user.id);
    res.json({ token, userId: user.id, username: user.username });
});

// DELETE /api/admin/users/:userId  – delete user + all data
app.delete('/api/admin/users/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    let users = readUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Delete all physical files
    const nodes = readUserNodes(userId).filter(n => !n.isFolder);
    nodes.forEach(n => {
        purgeNodeFile(n);
    });
    // Remove user folder
    // Remove node file
    try { fs.unlinkSync(userNodesFile(userId)); } catch {}
    // Remove from users list
    users = users.filter(u => u.id !== userId);
    writeUsers(users);
    // Invalidate sessions
    Object.keys(sessions).forEach(t => { if (sessions[t] === userId) sessionDelete(t); });
    res.json({ success: true });
});

// DELETE /api/admin/files/:ownerId/:nodeId  – admin delete any node
app.delete('/api/admin/files/:ownerId/:nodeId', requireAdmin, (req, res) => {
    const { ownerId, nodeId } = req.params;
    let nodes = readUserNodes(ownerId);

    function gatherChildren(id) {
        let kids = nodes.filter(n => n.parentFolderId === id);
        let sub  = [];
        kids.forEach(k => { if (k.isFolder) sub = sub.concat(gatherChildren(k.id)); });
        return kids.concat(sub);
    }

    const target = nodes.find(n => n.id === nodeId);
    if (!target) return res.status(404).json({ error: 'Node not found.' });

    let toRemove = [target];
    if (target.isFolder) toRemove = toRemove.concat(gatherChildren(target.id));

    toRemove.forEach(n => {
        purgeNodeFile(n);
    });

    const removeIds = new Set(toRemove.map(n => n.id));
    nodes = nodes.filter(n => !removeIds.has(n.id));
    writeUserNodes(ownerId, nodes);
    res.json({ success: true, removed: toRemove.length });
});

// ─── Catch-all error handler ─────────────────────────────────────────────
// Must be registered last, after every route. Anything that calls
// next(err) — including from the try/catch blocks added to the upload-
// adjacent routes above — lands here instead of the request hanging until
// the client times out. This is a second, independent layer on top of the
// process-level handlers above: those stop a crash from taking the whole
// server down; this makes sure the ONE request that actually failed still
// gets a proper error response instead of silently hanging.
app.use((err, req, res, next) => {
    console.error('[REQUEST ERROR]', req.method, req.originalUrl, err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || 'Something went wrong on the server.' });
});

// SPACEKHAZANA_HOST=127.0.0.1 keeps the desktop app's server private to this PC.
const LISTEN_ARGS = process.env.SPACEKHAZANA_HOST ? [PORT, process.env.SPACEKHAZANA_HOST] : [PORT];
const httpServer = app.listen(...LISTEN_ARGS, () => {
    console.log(`\n🚀 SpaceKhazana Engine Booted → http://localhost:${PORT}`);
    console.log(`📁 File storage path : ${UPLOADS_DIR}`);
    console.log(`   (set SPACEKHAZANA_STORAGE env var to change this)`);
    console.log(`🔐 Sessions persisted: ${SESSIONS_FILE}\n`);
});

httpServer.on('error', (err) => {
    console.error('[LISTEN ERROR]', err.message);
    if (!process.versions.electron) process.exit(1);
});

module.exports = { app, httpServer, PORT };
