"use strict";
/**
 * Avatar Thumbnail / Preview
 *
 * Generates metadata previews for .moon avatar files (no image processing).
 *
 * Routes (registered in server.ts):
 *   GET /api/:uuid/preview          → JSON metadata preview
 *   GET /figura/v1/avatar/:uuid/preview → same
 *   GET /api/:uuid/card             → plain-text "card"
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAvatarThumbnailRouter = createAvatarThumbnailRouter;
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
function createAvatarThumbnailRouter(avatarsDir, versionsDir, hashCache) {
    const router = (0, express_1.Router)();
    const isValidUUID = (uuid) => /^[0-9a-fA-F-]{32,36}$/.test(uuid);
    const formatUuid = (uuid) => {
        if (!uuid)
            return '';
        const clean = uuid.replace(/-/g, '').toLowerCase();
        return clean.length === 32
            ? `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`
            : uuid;
    };
    async function buildPreview(uuidStr) {
        if (!isValidUUID(uuidStr))
            return null;
        const uuid = formatUuid(uuidStr);
        const avatarFile = path_1.default.resolve(avatarsDir, `${uuid}.moon`);
        let stat;
        try {
            stat = await promises_1.default.stat(avatarFile);
        }
        catch {
            return null;
        }
        let hash = hashCache.get(uuid);
        if (!hash) {
            const buf = await promises_1.default.readFile(avatarFile);
            hash = crypto_1.default.createHash('sha256').update(buf).digest('hex');
            hashCache.set(uuid, hash);
        }
        // Count versions
        let versions = 0;
        try {
            const uuidVersionsDir = path_1.default.join(versionsDir, uuid);
            const entries = await promises_1.default.readdir(uuidVersionsDir);
            versions = entries.filter((f) => f.endsWith('.moon')).length;
        }
        catch { /* no versions dir */ }
        return {
            uuid,
            hash,
            sizeBytes: stat.size,
            uploadedAt: stat.mtime.toISOString(),
            versions,
        };
    }
    // ── GET /api/:uuid/preview ─────────────────────────────────────────────────
    router.get('/api/:uuid/preview', async (req, res) => {
        const preview = await buildPreview(req.params.uuid);
        if (!preview)
            return res.status(404).json({ error: 'Avatar not found' });
        res.json(preview);
    });
    // ── GET /figura/v1/avatar/:uuid/preview ────────────────────────────────────
    router.get('/figura/v1/avatar/:uuid/preview', async (req, res) => {
        const preview = await buildPreview(req.params.uuid);
        if (!preview)
            return res.status(404).json({ error: 'Avatar not found' });
        res.json(preview);
    });
    // ── GET /api/:uuid/card ────────────────────────────────────────────────────
    router.get('/api/:uuid/card', async (req, res) => {
        const preview = await buildPreview(req.params.uuid);
        if (!preview)
            return res.status(404).type('text/plain').send('Avatar not found');
        const sizeMB = (preview.sizeBytes / 1024 / 1024).toFixed(3);
        const card = [
            '┌─────────────────────────────────────────┐',
            '│           BigAvatar Cloud               │',
            '├─────────────────────────────────────────┤',
            `│ UUID     : ${preview.uuid.padEnd(29)} │`,
            `│ Hash     : ${preview.hash.slice(0, 16)}...${' '.repeat(10)} │`,
            `│ Size     : ${sizeMB} MB${' '.repeat(25 - sizeMB.length)} │`,
            `│ Uploaded : ${preview.uploadedAt.slice(0, 19).replace('T', ' ')}${' '.repeat(10)} │`,
            `│ Versions : ${String(preview.versions).padEnd(29)} │`,
            '└─────────────────────────────────────────┘',
        ].join('\n');
        res.type('text/plain').send(card);
    });
    return router;
}
//# sourceMappingURL=avatar-thumbnail.js.map