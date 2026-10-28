/**
 * Cloudflare R2 (S3-compatible) client configuration.
 * The client is created lazily so a missing env var returns a clean 503
 * from the route instead of crashing the whole server at boot.
 */
try { require('dotenv').config(); } catch { /* dotenv optional */ }

let client = null;

function readConfig() {
    const accountId       = process.env.CLOUDFLARE_ACCOUNT_ID;
    const accessKeyId     = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    // R2_BUCKET is accepted too: your existing presigned-upload code reads it.
    const bucket          = process.env.R2_BUCKET_NAME || process.env.R2_BUCKET;
    const endpoint        = process.env.R2_ENDPOINT ||
        (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');

    const missing = Object.entries({
        CLOUDFLARE_ACCOUNT_ID: accountId || endpoint,
        R2_ACCESS_KEY_ID: accessKeyId,
        R2_SECRET_ACCESS_KEY: secretAccessKey,
        R2_BUCKET_NAME: bucket
    }).filter(([, v]) => !v).map(([k]) => k);

    if (missing.length) {
        const err = new Error(`Cloudflare R2 is not configured. Missing: ${missing.join(', ')}`);
        err.status = 503;
        throw err;
    }
    return { endpoint, accessKeyId, secretAccessKey, bucket };
}

function getR2Client() {
    if (client) return client;
    const cfg = readConfig();
    let S3Client;
    try { ({ S3Client } = require('@aws-sdk/client-s3')); }
    catch { const e = new Error('Missing package. Run: npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner'); e.status = 503; throw e; }
    client = new S3Client({
        region: 'auto',                 // R2 always uses "auto"
        endpoint: cfg.endpoint,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
        // Newer SDK v3 releases add CRC32 checksums to every request by
        // default; only send them when an operation actually requires one.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED'
    });
    return client;
}

function getBucket() {
    return readConfig().bucket;
}

module.exports = { getR2Client, getBucket };
