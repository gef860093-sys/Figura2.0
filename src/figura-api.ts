/**
 * Figura Backend API
 *
 * Implements the full Figura mod backend API spec:
 * https://github.com/FiguraMC/FiguraRewriteReborn
 *
 * Endpoints:
 *   GET  /figura/v1/motd                    — MOTD message
 *   GET  /figura/v1/version                 — server version info
 *   GET  /figura/v1/limits                  — upload/rate limits
 *   GET  /figura/v1/auth                    — Mojang auth (step 1: get server ID)
 *   GET  /figura/v1/auth/verify             — Mojang auth (step 2: verify + get token)
 *   GET  /figura/v1/user/:uuid              — user profile + equipped avatar hash
 *   GET  /figura/v1/avatar/:uuid            — download avatar binary
 *   PUT  /figura/v1/avatar                  — upload avatar (auth required)
 *   DELETE /figura/v1/avatar               — delete avatar (auth required)
 *   POST /figura/v1/equip                   — equip/unequip avatar (auth required)
 *   GET  /figura/v1/badges/:uuid            — get badges for a user
 *   POST /figura/v1/badges                  — set badges (auth required)
 */

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import path from 'path';
import fsp from 'fs/promises';
import axios from 'axios';
import http from 'http';
import https from 'https';

import { LRUCache } from './lru-cache';
import { Logger } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FiguraUserInfo {
  uuid: string;
  hexUuid: string;
  hexUuidBuffer: Buffer;
  username: string;
  usernameLower: string;
  lastSize: number;
  lastAccess: number;
  createdAt: number;
  equippedBadges: { special: number[]; pride: number[] };
  activeSockets: Set<any>;
}

export interface FiguraApiConfig {
  avatarsDir: string;
  tempDir: string;
  maxFileSizeBytes: number;
  allowedMimeTypes: string[];
  serverVersion: string;
  enableWhitelist: boolean;
  tokenMaxAgeMs: number;
}

export interface FiguraBroadcastFn {
  (uuid: string, buffer: Buffer): void;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createFiguraRouter(
  config: FiguraApiConfig,
  tokens: Map<string, FiguraUserInfo>,
  serverIds: LRUCache<string, { username: string; time: number }>,
  hashCache: LRUCache<string, string>,
  apiJsonCache: LRUCache<string, object>,
  blacklist: () => Set<string>,
  whitelist: () => Set<string>,
  maintenanceMode: () => boolean,
  broadcastGlobal: FiguraBroadcastFn,
  uploadPipeline: any,
  logger: Logger
): Router {
  const router = Router();

  const fastAxios = axios.create({
    timeout: 15000,
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 500 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 500 }),
  });

  const isValidUUID = (uuid: string) => /^[0-9a-fA-F-]{32,36}$/.test(uuid);

  const formatUuid = (uuid: string): string => {
    if (!uuid) return '';
    const clean = uuid.replace(/-/g, '').toLowerCase();
    return clean.length === 32
      ? `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`
      : uuid;
  };

  // Auth middleware for Figura routes
  const figuraAuth = (req: Request, res: Response, next: NextFunction) => {
    const token = (req.headers['token'] || req.headers['authorization']?.replace('Bearer ', '')) as string;
    const userInfo = tokens.get(token);
    if (!userInfo) return res.status(401).json({ error: 'Unauthorized' });
    (req as any).figuraUser = userInfo;
    next();
  };

  // ── GET /figura/v1/motd ────────────────────────────────────────────────────

  router.get('/motd', (_req: Request, res: Response) => {
    res.json({
      motd: process.env.MOTD_MESSAGE || '§bBigAvatar Cloud §7- §aOnline',
    });
  });

  // ── GET /figura/v1/version ─────────────────────────────────────────────────

  router.get('/version', (_req: Request, res: Response) => {
    res.json({
      release: config.serverVersion,
      prerelease: config.serverVersion,
    });
  });

  // ── GET /figura/v1/limits ──────────────────────────────────────────────────

  router.get('/limits', (_req: Request, res: Response) => {
    res.json({
      rate: {
        pingSize: 1048576,
        pingRate: 4096,
        equip: 0,
        download: 999999999999,
        upload: 99999999999,
      },
      limits: {
        maxAvatarSize: config.maxFileSizeBytes,
        maxAvatars: 100,
        allowedBadges: {
          special: Array(15).fill(0),
          pride: Array(30).fill(0),
        },
      },
    });
  });

  // ── GET /figura/v1/auth ────────────────────────────────────────────────────
  // Step 1: Client requests a server ID to use with Mojang hasJoined

  router.get('/auth', (req: Request, res: Response) => {
    const username = req.query.username as string;
    if (!username) return res.status(400).json({ error: 'Missing username' });

    const uname = username.toLowerCase();

    if (maintenanceMode())
      return res.status(503).json({ error: '§e⚠ Server maintenance' });
    if (blacklist().has(uname))
      return res.status(403).json({ error: '§c✖ Account banned' });
    if (config.enableWhitelist && !whitelist().has(uname))
      return res.status(403).json({ error: '§c✖ Not whitelisted' });

    const serverID = crypto.randomBytes(16).toString('hex');
    serverIds.set(serverID, { username, time: Date.now() });

    res.json({ id: serverID });
  });

  // ── GET /figura/v1/auth/verify ─────────────────────────────────────────────
  // Step 2: Verify with Mojang and issue a session token

  router.get('/auth/verify', async (req: Request, res: Response) => {
    try {
      const sid = req.query.id as string;
      if (!sid) return res.status(400).json({ error: 'Missing id' });

      const sessionData = serverIds.get(sid);
      if (!sessionData) return res.status(404).json({ error: 'Auth session not found' });

      const response = await fastAxios.get(
        'https://sessionserver.mojang.com/session/minecraft/hasJoined',
        { params: { username: sessionData.username, serverId: sid } }
      );

      if (!response.data?.id) return res.status(403).json({ error: 'Mojang auth failed' });

      serverIds.delete(sid);

      const token = crypto.randomBytes(16).toString('hex');
      const hexUuid = response.data.id as string;
      const premiumUuid = formatUuid(hexUuid);
      const hexUuidBuffer = Buffer.from(hexUuid, 'hex');

      tokens.set(token, {
        uuid: premiumUuid,
        hexUuid,
        hexUuidBuffer,
        username: response.data.name,
        usernameLower: (response.data.name as string).toLowerCase(),
        lastSize: 0,
        lastAccess: Date.now(),
        createdAt: Date.now(),
        equippedBadges: { special: Array(15).fill(0), pride: Array(30).fill(0) },
        activeSockets: new Set(),
      });

      logger.info('Figura login', { username: response.data.name, uuid: premiumUuid });
      res.json({ token });
    } catch (err) {
      logger.error('Figura auth verify error', { error: String(err) });
      res.status(500).json({ error: 'Auth error' });
    }
  });

  // ── GET /figura/v1/user/:uuid ──────────────────────────────────────────────
  // Returns user profile with equipped avatar hash and badges

  router.get('/user/:uuid', async (req: Request, res: Response) => {
    const uuidStr = req.params.uuid;
    if (!isValidUUID(uuidStr)) return res.status(404).json({ error: 'Invalid UUID' });

    const uuid = formatUuid(uuidStr);
    const cached = apiJsonCache.get(`figura:${uuid}`);
    if (cached) return res.json(cached);

    const data: any = {
      uuid,
      rank: 'default',
      equipped: [],
      lastUsed: new Date().toISOString(),
      equippedBadges: { special: Array(15).fill(0), pride: Array(30).fill(0) },
      version: config.serverVersion,
      banned: blacklist().has(uuid),
    };

    // Check if user has an avatar
    let fileHash = hashCache.get(uuid);
    if (!fileHash) {
      try {
        const fileBuffer = await fsp.readFile(path.join(config.avatarsDir, `${uuid}.moon`));
        fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        hashCache.set(uuid, fileHash);
      } catch { /* no avatar */ }
    }

    if (fileHash) {
      data.equipped.push({ id: 'avatar', owner: uuid, hash: fileHash });
    }

    // Merge in-memory badge data if user is online
    for (const userInfo of tokens.values()) {
      if (userInfo.uuid === uuid) {
        data.equippedBadges = userInfo.equippedBadges;
        break;
      }
    }

    apiJsonCache.set(`figura:${uuid}`, data);
    res.json(data);
  });

  // ── GET /figura/v1/avatar/:uuid ────────────────────────────────────────────
  // Download avatar binary file with ETag support (304 if unchanged)

  router.get('/avatar/:uuid', async (req: Request, res: Response) => {
    const uuidStr = req.params.uuid;
    if (!isValidUUID(uuidStr)) return res.status(404).end();

    const uuid = formatUuid(uuidStr);
    const avatarFile = path.resolve(config.avatarsDir, `${uuid}.moon`);

    try {
      await fsp.access(avatarFile);

      // Compute or retrieve hash for ETag
      let fileHash = hashCache.get(uuid);
      if (!fileHash) {
        const fileBuffer = await fsp.readFile(avatarFile);
        fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        hashCache.set(uuid, fileHash);
      }

      const etag = `"${fileHash}"`;
      res.setHeader('ETag', etag);

      // Conditional GET — return 304 if client already has this version
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.sendFile(avatarFile);
    } catch {
      res.status(404).end();
    }
  });

  // ── PUT /figura/v1/avatar ──────────────────────────────────────────────────
  // Upload avatar (requires auth)

  router.put('/avatar', figuraAuth, async (req: Request, res: Response) => {
    const userInfo = (req as any).figuraUser as FiguraUserInfo;
    userInfo.lastAccess = Date.now();

    const tempPath = path.join(config.tempDir, `${userInfo.uuid}_${Date.now()}.tmp`);
    const finalPath = path.join(config.avatarsDir, `${userInfo.uuid}.moon`);
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);

    const result = await uploadPipeline.handleUpload(req, res, tempPath, finalPath);
    if (result) {
      userInfo.lastSize = contentLength || 0;
      hashCache.set(userInfo.uuid, result.hash);
      apiJsonCache.delete(userInfo.uuid);
      apiJsonCache.delete(`figura:${userInfo.uuid}`);

      // Broadcast equip event
      const buffer = Buffer.allocUnsafe(17);
      buffer.writeUInt8(2, 0);
      userInfo.hexUuidBuffer.copy(buffer, 1);
      broadcastGlobal(userInfo.uuid, buffer);

      logger.info('Figura avatar uploaded', { uuid: userInfo.uuid, hash: result.hash });
    }
  });

  // ── DELETE /figura/v1/avatar ───────────────────────────────────────────────
  // Delete avatar (requires auth)

  router.delete('/avatar', figuraAuth, async (req: Request, res: Response) => {
    const userInfo = (req as any).figuraUser as FiguraUserInfo;
    try {
      userInfo.lastAccess = Date.now();
      await fsp.unlink(path.join(config.avatarsDir, `${userInfo.uuid}.moon`));
      hashCache.delete(userInfo.uuid);
      apiJsonCache.delete(userInfo.uuid);
      apiJsonCache.delete(`figura:${userInfo.uuid}`);

      const buffer = Buffer.allocUnsafe(17);
      buffer.writeUInt8(2, 0);
      userInfo.hexUuidBuffer.copy(buffer, 1);
      broadcastGlobal(userInfo.uuid, buffer);

      res.json({ success: true });
    } catch {
      res.status(404).json({ error: 'No avatar found' });
    }
  });

  // ── POST /figura/v1/equip ──────────────────────────────────────────────────
  // Equip/unequip avatar — broadcasts to all watchers

  router.post('/equip', figuraAuth, (req: Request, res: Response) => {
    const userInfo = (req as any).figuraUser as FiguraUserInfo;
    userInfo.lastAccess = Date.now();

    const buffer = Buffer.allocUnsafe(17);
    buffer.writeUInt8(2, 0);
    userInfo.hexUuidBuffer.copy(buffer, 1);
    broadcastGlobal(userInfo.uuid, buffer);

    res.json({ success: true });
  });

  // ── GET /figura/v1/badges/:uuid ────────────────────────────────────────────
  // Get badges for a user

  router.get('/badges/:uuid', async (req: Request, res: Response) => {
    const uuidStr = req.params.uuid;
    if (!isValidUUID(uuidStr)) return res.status(404).json({ error: 'Invalid UUID' });

    const uuid = formatUuid(uuidStr);

    // Check in-memory first (online users)
    for (const userInfo of tokens.values()) {
      if (userInfo.uuid === uuid) {
        return res.json({ uuid, badges: userInfo.equippedBadges });
      }
    }

    // Load from badge file if exists
    const badgeFile = path.join(config.avatarsDir, `${uuid}.badges.json`);
    try {
      const raw = await fsp.readFile(badgeFile, 'utf8');
      const badges = JSON.parse(raw);
      return res.json({ uuid, badges });
    } catch {
      // Return empty badges
      return res.json({
        uuid,
        badges: { special: Array(15).fill(0), pride: Array(30).fill(0) },
      });
    }
  });

  // ── POST /figura/v1/badges ─────────────────────────────────────────────────
  // Set badges for authenticated user

  router.post('/badges', figuraAuth, async (req: Request, res: Response) => {
    const userInfo = (req as any).figuraUser as FiguraUserInfo;

    // Support both pre-parsed JSON (if express.json() is used) and raw stream
    let body: any = req.body || {};
    if (!req.body || Object.keys(req.body).length === 0) {
      try {
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', resolve);
          req.on('error', reject);
        });
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw) body = JSON.parse(raw);
      } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
    }

    const special = Array.isArray(body.special) ? body.special.slice(0, 15).map(Number) : Array(15).fill(0);
    const pride = Array.isArray(body.pride) ? body.pride.slice(0, 30).map(Number) : Array(30).fill(0);

    userInfo.equippedBadges = { special, pride };
    apiJsonCache.delete(`figura:${userInfo.uuid}`);

    // Persist to disk
    const badgeFile = path.join(config.avatarsDir, `${userInfo.uuid}.badges.json`);
    await fsp.writeFile(badgeFile, JSON.stringify({ special, pride })).catch(() => {});

    res.json({ success: true, badges: userInfo.equippedBadges });
  });

  // ── GET /figura/v1/user/bulk ───────────────────────────────────────────────
  // Batch fetch profiles for multiple UUIDs
  // Query: ?uuids=uuid1,uuid2,uuid3

  router.get('/user/bulk', async (req: Request, res: Response) => {
    const raw = req.query.uuids as string;
    if (!raw) return res.status(400).json({ error: 'Missing uuids query param' });

    const uuids = raw.split(',').map(u => u.trim()).filter(isValidUUID).slice(0, 50);
    if (uuids.length === 0) return res.status(400).json({ error: 'No valid UUIDs provided' });

    const results: Record<string, any> = {};

    await Promise.all(uuids.map(async (uuidStr) => {
      const uuid = formatUuid(uuidStr);

      const cached = apiJsonCache.get(`figura:${uuid}`);
      if (cached) { results[uuid] = cached; return; }

      const data: any = {
        uuid,
        rank: 'default',
        equipped: [],
        lastUsed: new Date().toISOString(),
        equippedBadges: { special: Array(15).fill(0), pride: Array(30).fill(0) },
        version: config.serverVersion,
        banned: blacklist().has(uuid),
      };

      let fileHash = hashCache.get(uuid);
      if (!fileHash) {
        try {
          const fileBuffer = await fsp.readFile(path.join(config.avatarsDir, `${uuid}.moon`));
          fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
          hashCache.set(uuid, fileHash);
        } catch { /* no avatar */ }
      }
      if (fileHash) data.equipped.push({ id: 'avatar', owner: uuid, hash: fileHash });

      // Load badges from disk if not online
      let badgesLoaded = false;
      for (const userInfo of tokens.values()) {
        if (userInfo.uuid === uuid) {
          data.equippedBadges = userInfo.equippedBadges;
          badgesLoaded = true;
          break;
        }
      }
      if (!badgesLoaded) {
        try {
          const raw = await fsp.readFile(path.join(config.avatarsDir, `${uuid}.badges.json`), 'utf8');
          data.equippedBadges = JSON.parse(raw);
        } catch { /* use defaults */ }
      }

      apiJsonCache.set(`figura:${uuid}`, data);
      results[uuid] = data;
    }));

    res.json(results);
  });

  return router;
}
