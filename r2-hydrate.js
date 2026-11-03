/**
 * r2-hydrate.js - runs once at boot (called synchronously by r2-datastore.js).
 * Downloads every JSON/data file stored under "data/" in the R2 bucket into the
 * local working folder, so Cloudflare R2 is the source of truth for users,
 * sessions, logins, nodes, trash, shares, passwords, secrets, etc.
 */
const fs = require('fs');
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (e) {}
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

const DATA_ROOT = process.env.SPACEKHAZANA_DATA
    ? path.resolve(process.env.SPACEKHAZANA_DATA)
    : path.join(__dirname, 'data');
const PREFIX = 'data/';

const endpoint = process.env.S3_ENDPOINT || process.env.R2_ENDPOINT;
const bucket = process.env.S3_BUCKET || process.env.R2_BUCKET || process.env.R2_BUCKET_NAME;
const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY;

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    console.error('[r2-hydrate] R2 credentials missing - cannot load data from R2.');
    process.exit(2);
}

const client = new S3Client({
    region: 'auto', endpoint,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
});

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

(async () => {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    let token, count = 0;
    do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }));
        for (const obj of page.Contents || []) {
            const rel = obj.Key.slice(PREFIX.length);
            if (!rel || rel.endsWith('/')) continue;
            const dest = path.resolve(DATA_ROOT, rel);
            if (!dest.startsWith(DATA_ROOT + path.sep)) continue; // path-traversal guard
            const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, await streamToBuffer(got.Body));
            count++;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    console.log(`[r2-hydrate] restored ${count} data file(s) from R2 bucket "${bucket}".`);
})().catch((err) => {
    console.error('[r2-hydrate] FAILED:', err.message);
    process.exit(1);
});
