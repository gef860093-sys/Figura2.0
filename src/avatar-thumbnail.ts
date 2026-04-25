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

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import path from 'path';
import fsp from 'fs/promises';

export interface AvatarPreview {
  uuid: string;
  hash: string;
  sizeBytes: number;
  uploadedAt: string;
  versions: number;
}

export function createAvatarThumbnailRouter(
  avatarsDir: string,
  versionsDir: string,
  hashCache: { get(k: string): string | undefined; set(k: string, v: string): void }
): Router {
  const router = Router();

  const isValidUUID = (uuid: string) => /^[0-9a-fA-F-]{32,36}$/.test(uuid);

  const formatUuid = (uuid: string): string => {
    if (!uuid) return '';
    const clean = uuid.replace(/-/g, '').toLowerCase();
    return clean.length === 32
      ? `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`
      : uuid;
  };

  async function buildPreview(uuidStr: string): Promise<AvatarPreview | null> {
    if (!isValidUUID(uuidStr)) return null;
    const uuid = formatUuid(uuidStr);
    const avatarFile = path.resolve(avatarsDir, `${uuid}.moon`);

    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(avatarFile);
    } catch {
      return null;
    }

    let hash = hashCache.get(uuid);
    if (!hash) {
      const buf = await fsp.readFile(avatarFile);
      hash = crypto.createHash('sha256').update(buf).digest('hex');
      hashCache.set(uuid, hash);
    }

    // Count versions
    let versions = 0;
    try {
      const uuidVersionsDir = path.join(versionsDir, uuid);
      const entries = await fsp.readdir(uuidVersionsDir);
      versions = entries.filter((f) => f.endsWith('.moon')).length;
    } catch { /* no versions dir */ }

    return {
      uuid,
      hash,
      sizeBytes: stat.size,
      uploadedAt: stat.mtime.toISOString(),
      versions,
    };
  }

  // ── GET /api/:uuid/preview ─────────────────────────────────────────────────
  router.get('/api/:uuid/preview', async (req: Request, res: Response) => {
    const preview = await buildPreview(req.params.uuid);
    if (!preview) return res.status(404).json({ error: 'Avatar not found' });
    res.json(preview);
  });

  // ── GET /figura/v1/avatar/:uuid/preview ────────────────────────────────────
  router.get('/figura/v1/avatar/:uuid/preview', async (req: Request, res: Response) => {
    const preview = await buildPreview(req.params.uuid);
    if (!preview) return res.status(404).json({ error: 'Avatar not found' });
    res.json(preview);
  });

  // ── GET /api/:uuid/card ────────────────────────────────────────────────────
  router.get('/api/:uuid/card', async (req: Request, res: Response) => {
    const preview = await buildPreview(req.params.uuid);
    if (!preview) return res.status(404).type('text/plain').send('Avatar not found');

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
