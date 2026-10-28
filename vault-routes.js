/* ─── PASSWORD VAULT STORAGE ──────────────────────────────────────────────
 * The server NEVER sees a plaintext password. Every entry that reaches
 * these routes is already { ciphertext, iv } produced client-side by the
 * extension (see extension/crypto.js) — this module just persists and
 * returns those opaque blobs per-user, the same way the rest of the app
 * persists JSON to flat files.
 * ──────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');
const express = require('express');

module.exports = function initVault({ requireAuth, DATA_DIR }) {
    const VAULT_FILE = path.join(DATA_DIR, 'vault.json');
    const readVault = () => { try { return JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')); } catch { return []; } };
    const writeVault = (v) => fs.writeFileSync(VAULT_FILE, JSON.stringify(v, null, 2), 'utf8');

    const router = express.Router();

    router.get('/api/vault/entries', requireAuth, (req, res) => {
        const entries = readVault().filter(e => e.userId === req.userId);
        // Never expose userId back to the client — origin/ciphertext/iv/id only.
        res.json(entries.map(({ id, origin, ciphertext, iv }) => ({ id, origin, ciphertext, iv })));
    });

    router.post('/api/vault/entries', requireAuth, (req, res) => {
        const { origin, ciphertext, iv } = req.body || {};
        if (!origin || !ciphertext || !iv) return res.status(400).json({ error: 'origin, ciphertext and iv are required.' });

        const entries = readVault();
        const entry = {
            id: `vault_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            userId: req.userId,
            origin,
            ciphertext,
            iv,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        entries.push(entry);
        writeVault(entries);
        res.json({ id: entry.id });
    });

    router.put('/api/vault/entries/:id', requireAuth, (req, res) => {
        const { origin, ciphertext, iv } = req.body || {};
        if (!ciphertext || !iv) return res.status(400).json({ error: 'ciphertext and iv are required.' });

        const entries = readVault();
        const entry = entries.find(e => e.id === req.params.id && e.userId === req.userId);
        if (!entry) return res.status(404).json({ error: 'Entry not found.' });

        if (origin) entry.origin = origin;
        entry.ciphertext = ciphertext;
        entry.iv = iv;
        entry.updatedAt = Date.now();
        writeVault(entries);
        res.json({ success: true });
    });

    router.delete('/api/vault/entries/:id', requireAuth, (req, res) => {
        const entries = readVault();
        const next = entries.filter(e => !(e.id === req.params.id && e.userId === req.userId));
        if (next.length === entries.length) return res.status(404).json({ error: 'Entry not found.' });
        writeVault(next);
        res.json({ success: true });
    });

    return { router };
};
