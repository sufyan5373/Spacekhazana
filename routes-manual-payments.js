'use strict';
/* SpaceKhazana – manual payments (EasyPaisa / JazzCash / IBAN + screenshot).
   Flow: user picks a plan -> details + CNIC images (/start) -> pays -> uploads
   screenshot (/:ref/proof) -> admin approves -> storageLimitGB is raised for
   TERM_DAYS, then drops back automatically.
   Images + request records live in SK_PAYMENTS_DIR (default ~/SpaceKhazanaPayments),
   OUTSIDE the folder express.static serves, and are only readable via the admin API. */
const express = require('express'), multer = require('multer'), fs = require('fs'),
      path = require('path'), os = require('os'), crypto = require('crypto');

/* ───────── EDIT THESE ───────── */
const TERM_DAYS = 30;
const PLANS = [
  { id: 'plus', name: 'Plus', storageGB: 100,  price: 499,  features: ['100 GB storage', 'Priority uploads', 'Email support'] },
  { id: 'pro',  name: 'Pro',  storageGB: 500,  price: 1499, popular: true, features: ['500 GB storage', 'Large file sharing', 'Priority uploads'] },
  { id: 'max',  name: 'Max',  storageGB: 2048, price: 3999, features: ['2 TB storage', 'Fastest uploads', 'Priority support'] }
];
const E = process.env;
const PAY = {
  accountTitle: E.SK_PAY_TITLE || 'SpaceKhazana',
  iban: E.SK_PAY_IBAN || 'PK00 XXXX 0000 0000 0000 0000',
  bank: E.SK_PAY_BANK || 'Your bank name',
  // qrUrl: put your real EasyPaisa/JazzCash QR images in /icons and set e.g. /icons/pay-easypaisa.png
  easypaisa: { number: E.SK_PAY_EASYPAISA || '03XX XXXXXXX', qrUrl: E.SK_PAY_EASYPAISA_QR || '' },
  jazzcash:  { number: E.SK_PAY_JAZZCASH  || '03XX XXXXXXX', qrUrl: E.SK_PAY_JAZZCASH_QR  || '' }
};
/* ─────────────────────────────── */

module.exports = function createManualPayments({ readUsers, writeUsers, requireAuth, requireAdmin }) {
  const DIR = E.SK_PAYMENTS_DIR || path.join(os.homedir(), 'SpaceKhazanaPayments');
  const FILES = path.join(DIR, 'proofs');
  fs.mkdirSync(FILES, { recursive: true, mode: 0o700 });
  const DB = path.join(DIR, 'requests.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return []; } };
  const save = (d) => { fs.writeFileSync(DB + '.tmp', JSON.stringify(d, null, 2), { mode: 0o600 }); fs.renameSync(DB + '.tmp', DB); };

  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 2, fields: 12 } });
  const run = (mw) => (req, res, next) => mw(req, res, (e) => e
    ? res.status(400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'Each image must be under 6 MB.' : 'Upload failed. Please try again.' })
    : next());
  // Trust the bytes, never the filename or mimetype the browser claims.
  const sniff = (b) => b.length < 12 ? null
    : (b[0] === 0xFF && b[1] === 0xD8) ? 'jpg'
    : b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47])) ? 'png'
    : (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') ? 'webp' : null;
  const saveImg = (f) => {
    const ext = sniff(f.buffer); if (!ext) return null;
    const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(FILES, name), f.buffer, { mode: 0o600 }); return name;
  };
  const rm = (...names) => names.forEach((n) => n && fs.unlink(path.join(FILES, n), () => {}));
  const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
  const pub = (r) => ({ ref: r.ref, planName: r.planName, amount: r.amount, storageGB: r.storageGB, method: r.method,
    status: r.status, createdAt: r.createdAt, submittedAt: r.submittedAt, reviewedAt: r.reviewedAt, reviewNote: r.reviewNote || '' });
  const OPEN = ['awaiting_proof', 'pending_review'];

  /* ───────── user routes (/api/manual-payments) ───────── */
  const user = express.Router();
  user.use(requireAuth);

  user.get('/plans', (req, res) => {
    const u = readUsers().find((x) => x.id === req.userId) || {};
    res.json({ plans: PLANS, payment: PAY, termDays: TERM_DAYS, currentLimitGB: u.storageLimitGB || 30,
      planId: u.planId || null, planExpiresAt: u.planExpiresAt || null });
  });

  user.get('/mine', (req, res) =>
    res.json(load().filter((r) => r.userId === req.userId).sort((a, b) => b.createdAt - a.createdAt).map(pub)));

  // Step 1: plan + details + CNIC images. Price is taken from PLANS, never from the client.
  user.post('/start', run(up.fields([{ name: 'cnicFront', maxCount: 1 }, { name: 'cnicBack', maxCount: 1 }])), (req, res) => {
    const b = req.body || {}, plan = PLANS.find((p) => p.id === b.planId);
    if (!plan) return res.status(400).json({ error: 'Choose a plan.' });
    const name = clean(b.name, 80), email = clean(b.email, 120), phone = clean(b.phone, 20).replace(/[\s-]/g, ''), cnic = clean(b.cnic, 15);
    if (name.split(/\s+/).filter(Boolean).length < 2) return res.status(400).json({ error: 'Enter your full name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    if (!/^(03\d{9}|\+923\d{9})$/.test(phone)) return res.status(400).json({ error: 'Enter a valid Pakistani mobile number.' });
    if (!/^\d{5}-\d{7}-\d$/.test(cnic)) return res.status(400).json({ error: 'CNIC must look like 12345-1234567-1.' });
    const f = req.files || {};
    if (!f.cnicFront || !f.cnicBack) return res.status(400).json({ error: 'Upload both sides of your CNIC.' });
    const all = load();
    if (all.filter((r) => r.userId === req.userId && OPEN.includes(r.status)).length >= 3)
      return res.status(429).json({ error: 'You already have open payments waiting. Please wait for them to be reviewed.' });
    const front = saveImg(f.cnicFront[0]), back = saveImg(f.cnicBack[0]);
    if (!front || !back) { rm(front, back); return res.status(400).json({ error: 'CNIC images must be JPG, PNG or WebP.' }); }
    const u = readUsers().find((x) => x.id === req.userId) || {};
    const rec = { ref: 'SK-' + crypto.randomBytes(4).toString('hex').toUpperCase(), userId: req.userId, username: u.username,
      planId: plan.id, planName: plan.name, storageGB: plan.storageGB, amount: plan.price, name, email, phone, cnic,
      files: { cnicFront: front, cnicBack: back }, status: 'awaiting_proof', createdAt: Date.now() };
    all.push(rec); save(all);
    res.json({ ref: rec.ref, amount: rec.amount, planName: rec.planName });
  });

  // Step 3: transaction screenshot -> pending review.
  user.post('/:ref/proof', run(up.single('screenshot')), (req, res) => {
    const all = load(), r = all.find((x) => x.ref === req.params.ref && x.userId === req.userId);
    if (!r) return res.status(404).json({ error: 'Payment not found.' });
    if (r.status !== 'awaiting_proof') return res.status(409).json({ error: 'Screenshot already submitted.' });
    const method = req.body && req.body.method;
    if (!['easypaisa', 'jazzcash', 'bank'].includes(method)) return res.status(400).json({ error: 'Choose how you paid.' });
    if (!req.file) return res.status(400).json({ error: 'Attach your transaction screenshot.' });
    const s = saveImg(req.file);
    if (!s) return res.status(400).json({ error: 'Screenshot must be JPG, PNG or WebP.' });
    r.files.screenshot = s; r.method = method; r.txnId = clean(req.body.txnId, 40);
    r.status = 'pending_review'; r.submittedAt = Date.now(); save(all);
    res.json(pub(r));
  });

  /* ───────── admin routes (/api/admin/manual-payments) ───────── */
  const admin = express.Router();
  admin.use(requireAdmin);

  admin.get('/', (req, res) => {
    const s = req.query.status;
    res.json(load().filter((r) => !s || r.status === s).sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({ ...pub(r), userId: r.userId, username: r.username, name: r.name, email: r.email,
        phone: r.phone, cnic: r.cnic, txnId: r.txnId || '', files: Object.keys(r.files) })));
  });

  // Fetch with the x-admin-key header and show as a blob; never cached.
  admin.get('/:ref/file/:kind', (req, res) => {
    const r = load().find((x) => x.ref === req.params.ref);
    const fn = r && Object.prototype.hasOwnProperty.call(r.files, req.params.kind) ? r.files[req.params.kind] : null;
    if (!fn || !/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(fn)) return res.status(404).end();
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.sendFile(path.join(FILES, fn));
  });

  admin.post('/:ref/approve', (req, res) => {
    const all = load(), r = all.find((x) => x.ref === req.params.ref);
    if (!r) return res.status(404).json({ error: 'Not found.' });
    if (r.status !== 'pending_review') return res.status(409).json({ error: 'Only payments pending review can be approved.' });
    const plan = PLANS.find((p) => p.id === r.planId), users = readUsers(), u = users.find((x) => x.id === r.userId);
    if (!plan || !u) return res.status(404).json({ error: 'Plan or user no longer exists.' });
    const now = Date.now(), active = u.planExpiresAt && u.planExpiresAt > now;
    if (!active) u.baseStorageLimitGB = u.storageLimitGB || 30;          // remembered so expiry can restore it
    u.storageLimitGB = Math.max(u.baseStorageLimitGB || 30, plan.storageGB);
    u.planId = plan.id;
    u.planExpiresAt = (active ? u.planExpiresAt : now) + TERM_DAYS * 864e5; // renewals stack on remaining time
    writeUsers(users);
    r.status = 'approved'; r.reviewedAt = now; save(all);
    res.json({ success: true, storageLimitGB: u.storageLimitGB, planExpiresAt: u.planExpiresAt });
  });

  admin.post('/:ref/reject', (req, res) => {
    const all = load(), r = all.find((x) => x.ref === req.params.ref);
    if (!r) return res.status(404).json({ error: 'Not found.' });
    if (!OPEN.includes(r.status)) return res.status(409).json({ error: 'Already reviewed.' });
    r.status = 'rejected'; r.reviewedAt = Date.now(); r.reviewNote = clean((req.body || {}).note, 200); save(all);
    res.json({ success: true });
  });

  /* ───────── plan expiry: put quota back when a month runs out ───────── */
  const expire = () => {
    try {
      const users = readUsers(), now = Date.now(); let changed = false;
      users.forEach((u) => {
        if (u.planExpiresAt && u.planExpiresAt <= now) {
          u.storageLimitGB = u.baseStorageLimitGB || 30;
          delete u.planId; delete u.planExpiresAt; delete u.baseStorageLimitGB; changed = true;
        }
      });
      if (changed) writeUsers(users);
    } catch (e) { console.error('[manual-payments] expiry check failed:', e.message); }
  };
  expire(); setInterval(expire, 60 * 60 * 1000).unref();

  return { userRouter: user, adminRouter: admin };
};
