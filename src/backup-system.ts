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

import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createGzip, createGunzip } from 'zlib';
import crypto from 'crypto';

export interface BackupEntry {
  backupId: string;       // "backup_<timestamp>"
  filename: string;       // basename of the archive
  createdAt: string;      // ISO timestamp
  fileCount: number;      // number of avatar files included
  sizeBytes: number;      // compressed archive size
}

export interface BackupConfig {
  avatarsDir: string;     // source directory to back up
  backupDir: string;      // where to store backup archives
  intervalMs: number;     // how often to run auto-backup (ms)
  maxBackups: number;     // max archives to retain
}

export interface BackupSystem {
  start(): void;
  stop(): void;
  /** Run a backup immediately, returns the new BackupEntry */
  runBackup(): Promise<BackupEntry>;
  /** List all stored backups, newest first */
  listBackups(): Promise<BackupEntry[]>;
  /** Restore all avatar files from a backup archive */
  restoreBackup(backupId: string): Promise<{ restoredFiles: number }>;
  /** Delete a specific backup */
  deleteBackup(backupId: string): Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function indexFile(backupDir: string): string {
  return path.join(backupDir, 'backup.index.json');
}

async function readIndex(backupDir: string): Promise<BackupEntry[]> {
  try {
    const raw = await fsp.readFile(indexFile(backupDir), 'utf8');
    return JSON.parse(raw) as BackupEntry[];
  } catch {
    return [];
  }
}

async function writeIndex(backupDir: string, entries: BackupEntry[]): Promise<void> {
  await fsp.writeFile(indexFile(backupDir), JSON.stringify(entries, null, 2));
}

/**
 * Creates a simple tar-like archive:
 * Each file is stored as:
 *   [4 bytes: filename length][filename bytes][8 bytes: file size][file bytes]
 * The whole stream is gzip-compressed.
 */
async function createArchive(sourceDir: string, destPath: string): Promise<number> {
  const files = (await fsp.readdir(sourceDir)).filter(f => f.endsWith('.moon'));
  if (files.length === 0) return 0;

  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(destPath);

  await new Promise<void>((resolve, reject) => {
    gzip.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    gzip.on('error', reject);

    (async () => {
      for (const file of files) {
        const filePath = path.join(sourceDir, file);
        const stat = await fsp.stat(filePath).catch(() => null);
        if (!stat) continue;

        // Write header: [4-byte name len][name][8-byte file size]
        const nameBuf = Buffer.from(file, 'utf8');
        const header = Buffer.allocUnsafe(4 + nameBuf.length + 8);
        header.writeUInt32BE(nameBuf.length, 0);
        nameBuf.copy(header, 4);
        header.writeBigUInt64BE(BigInt(stat.size), 4 + nameBuf.length);
        gzip.write(header);

        // Stream file content
        const readStream = createReadStream(filePath);
        await new Promise<void>((res, rej) => {
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
async function extractArchive(archivePath: string, destDir: string): Promise<number> {
  await fsp.mkdir(destDir, { recursive: true });

  const gunzip = createGunzip();
  const readStream = createReadStream(archivePath);

  let restoredFiles = 0;

  await new Promise<void>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let buf = Buffer.alloc(0);

    readStream.pipe(gunzip);

    gunzip.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      // Parse as many records as possible from buf
      while (true) {
        if (buf.length < 4) break;
        const nameLen = buf.readUInt32BE(0);
        if (buf.length < 4 + nameLen + 8) break;
        const filename = buf.slice(4, 4 + nameLen).toString('utf8');
        const fileSize = Number(buf.readBigUInt64BE(4 + nameLen));
        const headerSize = 4 + nameLen + 8;
        if (buf.length < headerSize + fileSize) break;

        const fileData = buf.slice(headerSize, headerSize + fileSize);
        buf = buf.slice(headerSize + fileSize);

        // Write file to destDir (fire-and-forget within the sync loop)
        const destPath = path.join(destDir, filename);
        fs.writeFileSync(destPath, fileData);
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

export function createBackupSystem(
  config: BackupConfig,
  onError?: (err: Error) => void
): BackupSystem {
  const { avatarsDir, backupDir, intervalMs, maxBackups } = config;
  let timer: NodeJS.Timeout | null = null;

  const log = (msg: string) => console.log(`[Backup] ${msg}`);
  const err = (e: Error) => { onError ? onError(e) : console.error('[Backup Error]', e.message); };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        this.runBackup().catch(err);
      }, intervalMs);
      log(`Auto-backup started (every ${Math.round(intervalMs / 60000)} min, keep ${maxBackups})`);
    },

    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      log('Auto-backup stopped');
    },

    async runBackup(): Promise<BackupEntry> {
      await fsp.mkdir(backupDir, { recursive: true });

      const timestamp = Date.now();
      const backupId = `backup_${timestamp}`;
      const filename = `${backupId}.tar.gz`;
      const destPath = path.join(backupDir, filename);

      const fileCount = await createArchive(avatarsDir, destPath);
      const stat = await fsp.stat(destPath);

      const entry: BackupEntry = {
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
          await fsp.unlink(path.join(backupDir, old.filename)).catch(() => {});
        }
      }

      await writeIndex(backupDir, entries);
      log(`Backup complete: ${filename} (${fileCount} files, ${(stat.size / 1024).toFixed(1)} KB)`);
      return entry;
    },

    async listBackups(): Promise<BackupEntry[]> {
      return readIndex(backupDir);
    },

    async restoreBackup(backupId: string): Promise<{ restoredFiles: number }> {
      const entries = await readIndex(backupDir);
      const entry = entries.find(e => e.backupId === backupId);
      if (!entry) throw new Error(`Backup ${backupId} not found`);

      const archivePath = path.join(backupDir, entry.filename);
      await fsp.access(archivePath);

      const restoredFiles = await extractArchive(archivePath, avatarsDir);
      log(`Restored ${restoredFiles} files from ${entry.filename}`);
      return { restoredFiles };
    },

    async deleteBackup(backupId: string): Promise<void> {
      const entries = await readIndex(backupDir);
      const idx = entries.findIndex(e => e.backupId === backupId);
      if (idx === -1) throw new Error(`Backup ${backupId} not found`);

      const [removed] = entries.splice(idx, 1);
      await fsp.unlink(path.join(backupDir, removed.filename)).catch(() => {});
      await writeIndex(backupDir, entries);
      log(`Deleted backup: ${removed.filename}`);
    },
  };
}
