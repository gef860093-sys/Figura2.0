/**
 * Avatar Preview/Thumbnail — metadata card (no image processing)
 * .moon files are binary Figura avatars, not images
 */
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { LRUCache } from './lru-cache';

export interface AvatarPreview {
  uuid: string;
  hash: string | null;
  sizeBytes: number;
  sizeMB: string;
  uploadedAt: string | null;
  versions: number;
  hasAvatar: boolean;
}

const previewCache = new LRUCache<string, AvatarPreview>(1000, 5 * 60 * 1000); // 5min TTL

export async function getAvatarPreview(
  uuid: string,
  avatarsDir: string,
  versionsDir: string,
  hashCache: LRUCache<string, string>
): Promise<AvatarPreview> {
  const cached = previewCache.get(uuid);
  if (cached) return cached;

  const avatarFile = path.join(avatarsDir, `${uuid}.moon`);

  let hash: string | null = null;
  let sizeBytes = 0;
  let uploadedAt: string | null = null;
  let hasAvatar = false;

  try {
    const stat = await fsp.stat(avatarFile);
    sizeBytes = stat.size;
    uploadedAt = stat.mtime.toISOString();
    hasAvatar = true;

    hash = hashCache.get(uuid) ?? null;
    if (!hash) {
      const buf = await fsp.readFile(avatarFile);
      hash = crypto.createHash('sha256').update(buf).digest('hex');
      hashCache.set(uuid, hash);
    }
  } catch { /* no avatar */ }

  // Count versions
  let versions = 0;
  try {
    const versionMeta = path.join(versionsDir, uuid, 'versions.json');
    const raw = await fsp.readFile(versionMeta, 'utf8');
    versions = JSON.parse(raw).length;
  } catch { /* no versions */ }

  const preview: AvatarPreview = {
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

export function formatAvatarCard(p: AvatarPreview): string {
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
