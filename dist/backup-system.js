"use strict";
/**
 * Backup System
 *
 * Automatically backs up all avatar files on a configurable schedule.
 * Backups are stored as timestamped zip archives.
 *
 * Layout:
 *   backups/
 *     backup_<ISO-timestamp>.zip   ← full snapshot of avatars dir
 *     backup.index.json            ← metadata index
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBackupSystem = createBackupSystem;
const promises_1 = __importDefault(require("fs/promises"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const fs_2 = require("fs");
const zlib_1 = require("zlib");
// ─── Helpers ──────────────────────────────────────────────────────────────────
function indexFile(backupDir) {
    return path_1.default.join(backupDir, 'backup.index.json');
}
async function readIndex(backupDir) {
    try {
        const raw = await promises_1.default.readFile(indexFile(backupDir), 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return [];
    }
}
async function writeIndex(backupDir, entries) {
    await promises_1.default.writeFile(indexFile(backupDir), JSON.stringify(entries, null, 2));
}
/**
 * Creates a simple tar-like archive:
 * Each file is stored as:
 *   [4 bytes: filename length][filename bytes][8 bytes: file size][file bytes]
 * The whole stream is gzip-compressed.
 */
async function createArchive(sourceDir, destPath) {
    const files = (await promises_1.default.readdir(sourceDir)).filter(f => f.endsWith('.moon'));
    if (files.length === 0)
        return 0;
    const gzip = (0, zlib_1.createGzip)({ level: 6 });
    const out = (0, fs_2.createWriteStream)(destPath);
    await new Promise((resolve, reject) => {
        gzip.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        gzip.on('error', reject);
        (async () => {
            for (const file of files) {
                const filePath = path_1.default.join(sourceDir, file);
                const stat = await promises_1.default.stat(filePath).catch(() => null);
                if (!stat)
                    continue;
                // Write header: [4-byte name len][name][8-byte file size]
                const nameBuf = Buffer.from(file, 'utf8');
                const header = Buffer.allocUnsafe(4 + nameBuf.length + 8);
                header.writeUInt32BE(nameBuf.length, 0);
                nameBuf.copy(header, 4);
                header.writeBigUInt64BE(BigInt(stat.size), 4 + nameBuf.length);
                gzip.write(header);
                // Stream file content
                const readStream = (0, fs_2.createReadStream)(filePath);
                await new Promise((res, rej) => {
                    readStream.on('data', chunk => gzip.write(chunk));
                    readStream.on('end', res);
                    readStream.on('error', rej);
                });
            }
            gzip.end();
        })().catch(reject);
    });
    return files.length;
}
/**
 * Extracts an archive created by createArchive back into destDir.
 */
async function extractArchive(archivePath, destDir) {
    await promises_1.default.mkdir(destDir, { recursive: true });
    const gunzip = (0, zlib_1.createGunzip)();
    const readStream = (0, fs_2.createReadStream)(archivePath);
    let restoredFiles = 0;
    await new Promise((resolve, reject) => {
        const chunks = [];
        let buf = Buffer.alloc(0);
        readStream.pipe(gunzip);
        gunzip.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            // Parse as many records as possible from buf
            while (true) {
                if (buf.length < 4)
                    break;
                const nameLen = buf.readUInt32BE(0);
                if (buf.length < 4 + nameLen + 8)
                    break;
                const filename = buf.slice(4, 4 + nameLen).toString('utf8');
                const fileSize = Number(buf.readBigUInt64BE(4 + nameLen));
                const headerSize = 4 + nameLen + 8;
                if (buf.length < headerSize + fileSize)
                    break;
                const fileData = buf.slice(headerSize, headerSize + fileSize);
                buf = buf.slice(headerSize + fileSize);
                // Write file to destDir (fire-and-forget within the sync loop)
                const destPath = path_1.default.join(destDir, filename);
                fs_1.default.writeFileSync(destPath, fileData);
                restoredFiles++;
            }
        });
        gunzip.on('end', resolve);
        gunzip.on('error', reject);
        readStream.on('error', reject);
    });
    return restoredFiles;
}
// ─── Factory ──────────────────────────────────────────────────────────────────
function createBackupSystem(config, onError) {
    const { avatarsDir, backupDir, intervalMs, maxBackups } = config;
    let timer = null;
    const log = (msg) => console.log(`[Backup] ${msg}`);
    const err = (e) => { onError ? onError(e) : console.error('[Backup Error]', e.message); };
    return {
        start() {
            if (timer)
                return;
            timer = setInterval(() => {
                this.runBackup().catch(err);
            }, intervalMs);
            log(`Auto-backup started (every ${Math.round(intervalMs / 60000)} min, keep ${maxBackups})`);
        },
        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            log('Auto-backup stopped');
        },
        async runBackup() {
            await promises_1.default.mkdir(backupDir, { recursive: true });
            const timestamp = Date.now();
            const backupId = `backup_${timestamp}`;
            const filename = `${backupId}.tar.gz`;
            const destPath = path_1.default.join(backupDir, filename);
            const fileCount = await createArchive(avatarsDir, destPath);
            const stat = await promises_1.default.stat(destPath);
            const entry = {
                backupId,
                filename,
                createdAt: new Date(timestamp).toISOString(),
                fileCount,
                sizeBytes: stat.size,
            };
            // Update index
            let entries = await readIndex(backupDir);
            entries.unshift(entry);
            // Prune old backups
            if (entries.length > maxBackups) {
                const toDelete = entries.splice(maxBackups);
                for (const old of toDelete) {
                    await promises_1.default.unlink(path_1.default.join(backupDir, old.filename)).catch(() => { });
                }
            }
            await writeIndex(backupDir, entries);
            log(`Backup complete: ${filename} (${fileCount} files, ${(stat.size / 1024).toFixed(1)} KB)`);
            return entry;
        },
        async listBackups() {
            return readIndex(backupDir);
        },
        async restoreBackup(backupId) {
            const entries = await readIndex(backupDir);
            const entry = entries.find(e => e.backupId === backupId);
            if (!entry)
                throw new Error(`Backup ${backupId} not found`);
            const archivePath = path_1.default.join(backupDir, entry.filename);
            await promises_1.default.access(archivePath);
            const restoredFiles = await extractArchive(archivePath, avatarsDir);
            log(`Restored ${restoredFiles} files from ${entry.filename}`);
            return { restoredFiles };
        },
        async deleteBackup(backupId) {
            const entries = await readIndex(backupDir);
            const idx = entries.findIndex(e => e.backupId === backupId);
            if (idx === -1)
                throw new Error(`Backup ${backupId} not found`);
            const [removed] = entries.splice(idx, 1);
            await promises_1.default.unlink(path_1.default.join(backupDir, removed.filename)).catch(() => { });
            await writeIndex(backupDir, entries);
            log(`Deleted backup: ${removed.filename}`);
        },
    };
}
//# sourceMappingURL=backup-system.js.map