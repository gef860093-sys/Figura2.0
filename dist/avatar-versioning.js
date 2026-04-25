"use strict";
/**
 * Avatar Versioning System
 *
 * Stores up to MAX_VERSIONS previous avatar files per user.
 * Layout on disk:
 *   avatars/<uuid>.moon          ← current (managed by upload pipeline)
 *   avatars_versions/<uuid>/     ← version history directory
 *     <timestamp>_<hash>.moon   ← versioned snapshot
 *     versions.json             ← metadata index
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAvatarVersioningSystem = createAvatarVersioningSystem;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
// ─── Helpers ──────────────────────────────────────────────────────────────────
function userVersionDir(versionsDir, uuid) {
    return path_1.default.join(versionsDir, uuid);
}
function metaFile(versionsDir, uuid) {
    return path_1.default.join(userVersionDir(versionsDir, uuid), 'versions.json');
}
async function readMeta(versionsDir, uuid) {
    try {
        const raw = await promises_1.default.readFile(metaFile(versionsDir, uuid), 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return [];
    }
}
async function writeMeta(versionsDir, uuid, versions) {
    await promises_1.default.mkdir(userVersionDir(versionsDir, uuid), { recursive: true });
    await promises_1.default.writeFile(metaFile(versionsDir, uuid), JSON.stringify(versions, null, 2));
}
// ─── Factory ──────────────────────────────────────────────────────────────────
function createAvatarVersioningSystem(config) {
    const { versionsDir, maxVersions } = config;
    return {
        async snapshot(uuid, currentFilePath, hash, sizeBytes) {
            // Ensure the current file exists before snapshotting
            try {
                await promises_1.default.access(currentFilePath);
            }
            catch {
                return; // nothing to snapshot
            }
            const dir = userVersionDir(versionsDir, uuid);
            await promises_1.default.mkdir(dir, { recursive: true });
            const timestamp = Date.now();
            const hash8 = hash.slice(0, 8);
            const versionId = `${timestamp}_${hash8}`;
            const filename = `${versionId}.moon`;
            const destPath = path_1.default.join(dir, filename);
            // Copy current file to version dir
            await promises_1.default.copyFile(currentFilePath, destPath);
            const version = {
                versionId,
                hash,
                sizeBytes,
                createdAt: new Date(timestamp).toISOString(),
                filename,
            };
            // Update metadata — prepend new version, trim to maxVersions
            let versions = await readMeta(versionsDir, uuid);
            versions.unshift(version);
            // Prune oldest versions beyond the limit
            if (versions.length > maxVersions) {
                const toDelete = versions.splice(maxVersions);
                for (const old of toDelete) {
                    await promises_1.default.unlink(path_1.default.join(dir, old.filename)).catch(() => { });
                }
            }
            await writeMeta(versionsDir, uuid, versions);
        },
        async listVersions(uuid) {
            return readMeta(versionsDir, uuid);
        },
        async restoreVersion(uuid, versionId, currentFilePath) {
            const versions = await readMeta(versionsDir, uuid);
            const version = versions.find(v => v.versionId === versionId);
            if (!version)
                throw new Error(`Version ${versionId} not found`);
            const srcPath = path_1.default.join(userVersionDir(versionsDir, uuid), version.filename);
            await promises_1.default.access(srcPath); // throws if file missing
            await promises_1.default.copyFile(srcPath, currentFilePath);
            return version;
        },
        async deleteVersion(uuid, versionId) {
            const versions = await readMeta(versionsDir, uuid);
            const idx = versions.findIndex(v => v.versionId === versionId);
            if (idx === -1)
                throw new Error(`Version ${versionId} not found`);
            const [removed] = versions.splice(idx, 1);
            await promises_1.default.unlink(path_1.default.join(userVersionDir(versionsDir, uuid), removed.filename)).catch(() => { });
            await writeMeta(versionsDir, uuid, versions);
        },
        async deleteAllVersions(uuid) {
            const dir = userVersionDir(versionsDir, uuid);
            await promises_1.default.rm(dir, { recursive: true, force: true });
        },
    };
}
//# sourceMappingURL=avatar-versioning.js.map