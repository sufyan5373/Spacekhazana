/**
 * SpaceKhazana – Firebase Cloud Function (2nd gen) exposing the Express API
 * with Google Drive as the upload store.
 *
 *   POST /api/upload          multipart field "file"  -> Drive folder (<= 30 MB)
 *   POST /api/upload/session  JSON {name,mimeType,size} -> resumable upload URL
 *                             so the browser can send big files straight to Drive
 *   GET  /api/files           list files in the Drive folder
 *
 * Auth to Drive: no key file is bundled. The function RUNS AS your
 * spacekhazana-drive service account (see `serviceAccount` below), so Google
 * hands it credentials automatically (Application Default Credentials).
 * Locally, point GOOGLE_APPLICATION_CREDENTIALS at your key file instead.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const { onRequest } = require('firebase-functions/v2/https');
const { defineString, defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

const DRIVE_FOLDER_ID = defineString('DRIVE_FOLDER_ID');
const UPLOAD_API_KEY = defineSecret('UPLOAD_API_KEY');

const SERVICE_ACCOUNT = 'spacekhazana-drive@spacekhazana.iam.gserviceaccount.com';
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // Functions request cap is 32 MB
const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === 'true';

// ── Google Drive client (lazy, so params resolve at request time) ───────────
let driveClient;
let authClient;
function getAuth() {
  if (!authClient) {
    authClient = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive']
    });
  }
  return authClient;
}
function getDrive() {
  if (!driveClient) driveClient = google.drive({ version: 'v3', auth: getAuth() });
  return driveClient;
}

// ── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: true }));
// JSON only; multipart is handled by multer and must not be pre-parsed.
app.use((req, res, next) => {
  if ((req.headers['content-type'] || '').startsWith('multipart/form-data')) return next();
  express.json({ limit: '1mb' })(req, res, next);
});

// Replace with your own JWT check (x-auth-token) when you merge this into
// the main server. Until then: a shared key, or open only in the emulator.
function requireAuth(req, res, next) {
  const expected = UPLOAD_API_KEY.value();
  if (!expected) {
    if (IS_EMULATOR) return next();
    return res.status(503).json({ error: 'Upload auth is not configured.' });
  }
  const given = Buffer.from(String(req.get('x-api-key') || ''));
  const want = Buffer.from(expected);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next();
  return res.status(401).json({ error: 'Unauthorized.' });
}

// ── Cloud Functions pre-reads the body into req.rawBody, so multer's normal
//    req.pipe(busboy) would receive nothing (0-byte files). Re-feed it. ──────
function restoreBodyStream(req, res, next) {
  if (req.rawBody) {
    const raw = req.rawBody;
    req.pipe = (dest) => {
      dest.end(raw);
      return dest;
    };
  }
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()), // /tmp is in-memory on Functions
    filename: (req, file, cb) => cb(null, `${Date.now()}_${crypto.randomUUID()}.upload`)
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
});

function safeName(name) {
  return (
    path
      .basename(String(name || 'file'))
      .replace(/[\x00-\x1f<>:"/\\|?*]+/g, '_')
      .slice(0, 200) || 'file'
  );
}

function removeTemp(file) {
  if (file && file.path) fs.unlink(file.path, () => {});
}

// ── POST /api/upload ────────────────────────────────────────────────────────
app.post('/api/upload', requireAuth, restoreBodyStream, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      removeTemp(req.file);
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig
          ? `File too large for this endpoint (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB). Use /api/upload/session for big files.`
          : err.message || 'Upload failed.'
      });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received (field name must be "file").' });

    try {
      const { data } = await getDrive().files.create({
        requestBody: {
          name: safeName(req.file.originalname),
          parents: [DRIVE_FOLDER_ID.value()]
        },
        media: {
          mimeType: req.file.mimetype || 'application/octet-stream',
          body: fs.createReadStream(req.file.path) // streamed from /tmp, not buffered
        },
        fields: 'id,name,mimeType,size,createdTime,webViewLink',
        supportsAllDrives: true
      });
      return res.status(201).json({ success: true, file: data });
    } catch (e) {
      logger.error('Drive upload failed', e);
      return res.status(502).json({ error: 'Could not store the file in Google Drive.', detail: e.message });
    } finally {
      removeTemp(req.file); // always free /tmp (it counts against function memory)
    }
  });
});

// ── POST /api/upload/session  (large files: browser -> Drive directly) ──────
// Returns a one-time resumable upload URL. The client then PUTs the file (in
// chunks if it likes) straight to Google, bypassing the 32 MB / 60 s limits.
app.post('/api/upload/session', requireAuth, async (req, res) => {
  try {
    const { name, mimeType, size } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required.' });

    const client = await getAuth().getClient();
    const { token } = await client.getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType || 'application/octet-stream'
    };
    if (size) headers['X-Upload-Content-Length'] = String(size);
    // Lets that browser origin PUT to the returned URL (CORS).
    if (req.get('origin')) headers.Origin = req.get('origin');

    const r = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: safeName(name), parents: [DRIVE_FOLDER_ID.value()] })
      }
    );
    if (!r.ok) throw new Error(`Drive returned ${r.status}: ${await r.text()}`);
    return res.json({ uploadUrl: r.headers.get('location') });
  } catch (e) {
    logger.error('Could not start resumable session', e);
    return res.status(502).json({ error: 'Could not start upload session.', detail: e.message });
  }
});

// ── GET /api/files ──────────────────────────────────────────────────────────
app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 100, 1), 1000);
    const { data } = await getDrive().files.list({
      q: `'${DRIVE_FOLDER_ID.value()}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,thumbnailLink)',
      orderBy: 'createdTime desc',
      pageSize,
      pageToken: req.query.pageToken || undefined,
      corpora: 'allDrives',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    return res.json({ files: data.files || [], nextPageToken: data.nextPageToken || null });
  } catch (e) {
    logger.error('Drive list failed', e);
    return res.status(502).json({ error: 'Could not list files from Google Drive.', detail: e.message });
  }
});

app.get('/api/ping', (req, res) => res.json({ ok: true }));

// Final error handler
app.use((err, req, res, next) => {
  logger.error('Request error', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
});

// ── Export: this is `exports.api = functions.https.onRequest(app)` for v2 ───
exports.api = onRequest(
  {
    region: 'us-central1',
    serviceAccount: SERVICE_ACCOUNT, // function runs AS the Drive service account
    secrets: [UPLOAD_API_KEY],
    memory: '512MiB',
    timeoutSeconds: 60, // Hosting rewrites cut off at 60 s regardless
    maxInstances: 10
  },
  app
);
