/**
 * Multer storage engine that streams uploads straight to Cloudflare R2.
 * Nothing is ever written to this machine's disk: bytes flow
 * request -> multer -> R2 (multipart upload handled by @aws-sdk/lib-storage).
 *
 * After upload, req.file has:  key, bucket, size, etag, filename (last part of key)
 */
const { Transform } = require('stream');
const path = require('path');
const { getR2Client, getBucket } = require('./config/r2');

const PART_SIZE = 16 * 1024 * 1024;

class R2StorageEngine {
    constructor({ getKey }) {
        if (typeof getKey !== 'function') throw new Error('R2StorageEngine needs { getKey(req, file) }');
        this.getKey = getKey;
    }

    _handleFile(req, file, cb) {
        let client, bucket, key, Upload;
        try {
            ({ Upload } = require('@aws-sdk/lib-storage'));
            client = getR2Client();
            bucket = getBucket();
            key = this.getKey(req, file);
        } catch (err) { return cb(err); }

        let size = 0;
        const counter = new Transform({
            transform(chunk, _enc, done) { size += chunk.length; done(null, chunk); }
        });
        file.stream.on('error', (err) => counter.destroy(err));
        file.stream.pipe(counter);

        const uploader = new Upload({
            client,
            params: {
                Bucket: bucket,
                Key: key,
                Body: counter,
                ContentType: file.mimetype || 'application/octet-stream'
            },
            queueSize: 4,
            partSize: PART_SIZE,
            leavePartsOnError: false   // abort the multipart upload if anything fails
        });

        uploader.done()
            .then((out) => cb(null, {
                key, bucket, size,
                etag: out && out.ETag,
                filename: path.posix.basename(key),
                storageProvider: 's3'
            }))
            .catch((err) => cb(err));
    }

    // Called by multer when a later step of the same request fails.
    _removeFile(req, file, cb) {
        deleteKey(file.key, file.bucket).then(() => cb(null), () => cb(null));
    }
}

function deleteKey(key, bucket) {
    if (!key) return Promise.resolve();
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    return getR2Client().send(new DeleteObjectCommand({ Bucket: bucket || getBucket(), Key: key }));
}

module.exports = { R2StorageEngine, deleteKey };
