"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAvatarPreview = getAvatarPreview;
exports.formatAvatarCard = formatAvatarCard;
/**
 * Avatar Preview/Thumbnail — metadata card (no image processing)
 * .moon files are binary Figura avatars, not images
 */
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const lru_cache_1 = require("./lru-cache");
const previewCache = new lru_cache_1.LRUCache(1000, 5 * 60 * 1000); // 5min TTL
async function getAvatarPreview(uuid, avatarsDir, versionsDir, hashCache) {
    const cached = previewCache.get(uuid);
    if (cached)
        return cached;
    const avatarFile = path_1.default.join(avatarsDir, `${uuid}.moon`);
    let hash = null;
    let sizeBytes = 0;
    let uploadedAt = null;
    let hasAvatar = false;
    try {
        const stat = await promises_1.default.stat(avatarFile);
        sizeBytes = stat.size;
        uploadedAt = stat.mtime.toISOString();
        hasAvatar = true;
        hash = hashCache.get(uuid) ?? null;
        if (!hash) {
            const buf = await promises_1.default.readFile(avatarFile);
            hash = crypto_1.default.createHash('sha256').update(buf).digest('hex');
            hashCache.set(uuid, hash);
        }
    }
    catch { /* no avatar */ }
    // Count versions
    let versions = 0;
    try {
        const versionMeta = path_1.default.join(versionsDir, uuid, 'versions.json');
        const raw = await promises_1.default.readFile(versionMeta, 'utf8');
        versions = JSON.parse(raw).length;
    }
    catch { /* no versions */ }
    const preview = {
        uuid,
        hash,
        sizeBytes,
        sizeMB: (sizeBytes / 1048576).toFixed(3),
        uploadedAt,
        versions,
        hasAvatar,
    };
    previewCache.set(uuid, preview);
    return preview;
}
function formatAvatarCard(p) {
    return [
        `╔══════════════════════════════════╗`,
        `║  BigAvatar Cloud — Avatar Card   ║`,
        `╠══════════════════════════════════╣`,
        `║ UUID    : ${p.uuid.slice(0, 22)}... ║`,
        `║ Has Avatar: ${p.hasAvatar ? 'Yes' : 'No '}                    ║`,
        `║ Size    : ${p.sizeMB} MB                  ║`,
        `║ Versions: ${String(p.versions).padEnd(3)}                       ║`,
        `║ Updated : ${(p.uploadedAt || 'N/A').slice(0, 19)}       ║`,
        `╚══════════════════════════════════╝`,
    ].join('\n');
}
//# sourceMappingURL=avatar-preview.js.map