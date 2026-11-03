/**
 * r2-datastore.js - makes Cloudflare R2 the persistent store for ALL app data.
 *
 *  1. On boot (synchronously, before server.js reads anything) it restores every
 *     file under "data/" from R2 into the local working folder.
 *  2. It then wraps fs write/delete calls so every change made inside the data
 *     folder (users.json, sessions.json, nodes_*.json, trash, shares, passwords,
 *     .secrets.json, webauthn, affiliates ...) is mirrored to R2 under "data/<path>".
 *
 * No route/handler code changes: the whole app keeps using the same files, but
 * R2 holds the real copy, so nothing is lost on Render redeploys/restarts.
 * Uploaded user files already stream straight to R2 (users/<id>/...).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_ROOT = process.env.SPACEKHAZANA_DATA
    ? path.resolve(process.env.SPACEKHAZANA_DATA)
    : path.join(__dirname, 'data');
const PREFIX = 'data/';
// Local-only scratch/cache folders that must never be mirrored.
const EXCLUDED_TOP = new Set(['uploads', 'thumbnails', 'quarantine', 'tmp']);

const endpoint = process.env.S3_ENDPOINT || process.env.R2_ENDPOINT;
const bucket = process.env.S3_BUCKET || process.env.R2_BUCKET || process.env.R2_BUCKET_NAME;
const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY;

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    console.error('[r2-datastore] R2 credentials missing (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY). Refusing to start without cloud storage.');
    process.exit(1);
}

// ── 1. restore from R2 before anything else runs ──
try {
    execFileSync(process.execPath, [path.join(__dirname, 'r2-hydrate.js')], { stdio: 'inherit', env: process.env, timeout: 120000 });
} catch (e) {
    console.error('[r2-datastore] Could not restore data from R2. Exiting so existing cloud data is never overwritten with empty files.');
    process.exit(1);
}

// ── 2. mirror every write/delete to R2 ──
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const client = new S3Client({
    region: 'auto', endpoint,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
});

const origRead = fs.readFileSync.bind(fs);
const pending = new Map();   // key -> timer
const inflight = new Set();

function keyFor(p) {
    if (typeof p !== 'string' && !(p instanceof URL)) return null;
    const abs = path.resolve(String(p instanceof URL ? p.pathname : p));
    if (!abs.startsWith(DATA_ROOT + path.sep)) return null;
    const rel = path.relative(DATA_ROOT, abs).split(path.sep).join('/');
    if (EXCLUDED_TOP.has(rel.split('/')[0])) return null;
    return { abs, rel };
}

async function pushKey(k) {
    let body;
    try { body = origRead(k.abs); } catch { return; } // vanished - delete path handles it
    const job = client.send(new PutObjectCommand({
        Bucket: bucket, Key: PREFIX + k.rel, Body: body, ContentType: 'application/octet-stream'
    })).catch((e) => console.error('[r2-datastore] upload failed for', k.rel, e.message));
    inflight.add(job);
    job.finally(() => inflight.delete(job));
    return job;
}

function scheduleUpload(p) {
    const k = keyFor(p);
    if (!k) return;
    clearTimeout(pending.get(k.rel));
    pending.set(k.rel, setTimeout(() => { pending.delete(k.rel); pushKey(k); }, 600));
}

function scheduleDelete(p) {
    const k = keyFor(p);
    if (!k) return;
    clearTimeout(pending.get(k.rel));
    pending.delete(k.rel);
    const job = client.send(new DeleteObjectCommand({ Bucket: bucket, Key: PREFIX + k.rel }))
        .catch((e) => console.error('[r2-datastore] delete failed for', k.rel, e.message));
    inflight.add(job);
    job.finally(() => inflight.delete(job));
}

function wrap(name, onCall) {
    const orig = fs[name];
    fs[name] = function (...args) {
        const r = orig.apply(this, args);
        try { onCall(args); } catch (e) { /* mirroring must never break a request */ }
        return r;
    };
}
// Async variants: mirror once the callback fires successfully.
function wrapAsync(name, onOk) {
    const orig = fs[name];
    fs[name] = function (...args) {
        const cbIdx = args.length - 1;
        if (typeof args[cbIdx] === 'function') {
            const cb = args[cbIdx];
            args[cbIdx] = function (err, ...rest) { if (!err) { try { onOk(args); } catch (e) {} } return cb.call(this, err, ...rest); };
        }
        return orig.apply(this, args);
    };
}

wrap('writeFileSync', (a) => scheduleUpload(a[0]));
wrap('appendFileSync', (a) => scheduleUpload(a[0]));
wrap('unlinkSync', (a) => scheduleDelete(a[0]));
wrap('renameSync', (a) => { scheduleDelete(a[0]); scheduleUpload(a[1]); });
wrap('copyFileSync', (a) => scheduleUpload(a[1]));
wrapAsync('writeFile', (a) => scheduleUpload(a[0]));
wrapAsync('appendFile', (a) => scheduleUpload(a[0]));
wrapAsync('unlink', (a) => scheduleDelete(a[0]));
wrapAsync('rename', (a) => { scheduleDelete(a[0]); scheduleUpload(a[1]); });

// Flush everything still queued, then wait for in-flight uploads (deploys send SIGTERM).
async function flushAll() {
    for (const [rel, t] of pending) {
        clearTimeout(t);
        pending.delete(rel);
        await pushKey({ abs: path.join(DATA_ROOT, ...rel.split('/')), rel });
    }
    await Promise.allSettled([...inflight]);
}
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
        if (shuttingDown) return;
        shuttingDown = true;
        flushAll().finally(() => process.exit(0));
    });
}
process.on('beforeExit', () => { flushAll(); });

// Safety net: re-push anything dirty every 30s (covers writes made by other libraries).
setInterval(() => { flushAll().catch(() => {}); }, 30000).unref();

console.log(`[r2-datastore] active: app data in "${DATA_ROOT}" is mirrored to R2 bucket "${bucket}" under "${PREFIX}".`);
module.exports = { flushAll };
