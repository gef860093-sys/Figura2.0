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

import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface AvatarVersion {
  versionId: string;   // "<timestamp>_<hash8>"
  hash: string;        // full SHA-256 of the file
  sizeBytes: number;
  createdAt: string;   // ISO timestamp
  filename: string;    // basename on disk
}

export interface VersioningConfig {
  versionsDir: string;   // root dir for all version subdirs
  maxVersions: number;   // max versions to keep per user (default 10)
}

export interface AvatarVersioningSystem {
  /** Called after a successful upload — snapshots the current file as a new version */
  snapshot(uuid: string, currentFilePath: string, hash: string, sizeBytes: number): Promise<void>;
  /** List all stored versions for a user, newest first */
  listVersions(uuid: string): Promise<AvatarVersion[]>;
  /** Restore a specific version — copies it back to currentFilePath */
  restoreVersion(uuid: string, versionId: string, currentFilePath: string): Promise<AvatarVersion>;
  /** Delete a specific version */
  deleteVersion(uuid: string, versionId: string): Promise<void>;
  /** Delete all versions for a user */
  deleteAllVersions(uuid: string): Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function userVersionDir(versionsDir: string, uuid: string): string {
  return path.join(versionsDir, uuid);
}

function metaFile(versionsDir: string, uuid: string): string {
  return path.join(userVersionDir(versionsDir, uuid), 'versions.json');
}

async function readMeta(versionsDir: string, uuid: string): Promise<AvatarVersion[]> {
  try {
    const raw = await fsp.readFile(metaFile(versionsDir, uuid), 'utf8');
    return JSON.parse(raw) as AvatarVersion[];
  } catch {
    return [];
  }
}

async function writeMeta(versionsDir: string, uuid: string, versions: AvatarVersion[]): Promise<void> {
  await fsp.mkdir(userVersionDir(versionsDir, uuid), { recursive: true });
  await fsp.writeFile(metaFile(versionsDir, uuid), JSON.stringify(versions, null, 2));
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createAvatarVersioningSystem(config: VersioningConfig): AvatarVersioningSystem {
  const { versionsDir, maxVersions } = config;

  return {
    async snapshot(uuid, currentFilePath, hash, sizeBytes) {
      // Ensure the current file exists before snapshotting
      try {
        await fsp.access(currentFilePath);
      } catch {
        return; // nothing to snapshot
      }

      const dir = userVersionDir(versionsDir, uuid);
      await fsp.mkdir(dir, { recursive: true });

      const timestamp = Date.now();
      const hash8 = hash.slice(0, 8);
      const versionId = `${timestamp}_${hash8}`;
      const filename = `${versionId}.moon`;
      const destPath = path.join(dir, filename);

      // Copy current file to version dir
      await fsp.copyFile(currentFilePath, destPath);

      const version: AvatarVersion = {
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
          await fsp.unlink(path.join(dir, old.filename)).catch(() => {});
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
      if (!version) throw new Error(`Version ${versionId} not found`);

      const srcPath = path.join(userVersionDir(versionsDir, uuid), version.filename);
      await fsp.access(srcPath); // throws if file missing
      await fsp.copyFile(srcPath, currentFilePath);
      return version;
    },

    async deleteVersion(uuid, versionId) {
      const versions = await readMeta(versionsDir, uuid);
      const idx = versions.findIndex(v => v.versionId === versionId);
      if (idx === -1) throw new Error(`Version ${versionId} not found`);

      const [removed] = versions.splice(idx, 1);
      await fsp.unlink(
        path.join(userVersionDir(versionsDir, uuid), removed.filename)
      ).catch(() => {});
      await writeMeta(versionsDir, uuid, versions);
    },

    async deleteAllVersions(uuid) {
      const dir = userVersionDir(versionsDir, uuid);
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}
