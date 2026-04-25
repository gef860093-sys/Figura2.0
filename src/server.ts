import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import hpp from 'hpp';
import crypto from 'crypto';
import path from 'path';
import axios from 'axios';
import http from 'http';
import https from 'https';
import os from 'os';
import fs from 'fs';
import fsp from 'fs/promises';
import WebSocket, { WebSocketServer } from 'ws';

import { loadConfig } from './config';
import { createLogger } from './log-manager';
import { LRUCache } from './lru-cache';
import { createRedisClient } from './redis-client';
import { createRateLimiters } from './rate-limiter';
import { createUploadPipeline } from './upload-pipeline';
import { createTempFileCleaner } from './temp-file-cleaner';
import { createHealthMonitor } from './health-monitor';
import { createAntiSpamSystem } from './anti-spam';
import { createGracefulShutdownHandler } from './graceful-shutdown';
import { WebSocketManager } from './ws-manager';
import { createAvatarVersioningSystem } from './avatar-versioning';
import { createBackupSystem } from './backup-system';
import { createMetricsAlerting } from './metrics-alerting';
import { createFiguraRouter, FiguraUserInfo } from './figura-api';
import { geolocate } from './ip-geolocation';
import { createAdminAuth } from './admin-auth';
import { createActivityLog } from './activity-log';
import { createWebhookEvents } from './webhook-events';
import { getAvatarPreview, formatAvatarCard } from './avatar-preview';

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const appConfig = loadConfig();
const logger = createLogger(appConfig);

// ─── Global error handlers ────────────────────────────────────────────────────

process.on('uncaughtException', (err: Error) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (url) {
    axios.post(url, {
      embeds: [{
        title: '💥 Uncaught Exception',
        description: `\`\`\`${err.message}\`\`\``,
        color: 0xef4444,
        timestamp: new Date().toISOString(),
      }]
    }).catch(() => {}).finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
  // Do NOT exit — keep server alive on unhandled promise rejections
});

// ─── Environment constants ────────────────────────────────────────────────────

const API_URL = process.env.API_URL || 'https://bigavatar.dpdns.org/api.php';
const API_KEY = process.env.API_KEY || '';
const ENABLE_WHITELIST = process.env.ENABLE_WHITELIST === 'true';
const TOKEN_MAX_AGE_MS = parseInt(process.env.TOKEN_MAX_AGE_MS || '21600000', 10);
const SYNC_INTERVAL_MS = 15000;
const WS_PING_INTERVAL_MS = appConfig.ws.pingIntervalMs;
// Max WS connections based on free RAM: at least 500, at most 5000
const MAX_WS = Math.max(500, Math.min(5000, Math.floor(os.freemem() / 1024 / 1024 / 1.5)));
// Fix #6: default upload max is 50 MB
const UPLOAD_MAX_FILE_SIZE_BYTES = parseInt(
  process.env.UPLOAD_MAX_FILE_SIZE_BYTES || '52428800',
  10
);
const AVATAR_MAX_VERSIONS = parseInt(process.env.AVATAR_MAX_VERSIONS || '10', 10);
const VERSIONS_DIR = process.env.AVATAR_VERSIONS_DIR || './avatars_versions';
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';
const BACKUP_INTERVAL_MS = parseInt(process.env.BACKUP_INTERVAL_MS || '3600000', 10); // 1 hour
const BACKUP_MAX_KEEP = parseInt(process.env.BACKUP_MAX_KEEP || '24', 10);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const ACTIVITY_LOG_MAX_EVENTS = parseInt(process.env.ACTIVITY_LOG_MAX_EVENTS || '1000', 10);

// ─── Module initialisation ────────────────────────────────────────────────────

const hashCache = new LRUCache<string, string>(appConfig.cache.maxEntries, appConfig.cache.defaultTtlMs);
const apiJsonCache = new LRUCache<string, object>(appConfig.cache.maxEntries, appConfig.cache.defaultTtlMs);

const redisWrapper = createRedisClient(appConfig.redis, logger);

const rateLimiters = createRateLimiters(
  redisWrapper?.client ?? null,
  appConfig.rateLimit,
  logger
);

const antiSpam = createAntiSpamSystem(
  redisWrapper?.client ?? null,
  appConfig.antiSpam,
  logger
);

// Override maxFileSizeBytes with the corrected 50 MB default
const uploadPipeline = createUploadPipeline(
  { ...appConfig.upload, maxFileSizeBytes: UPLOAD_MAX_FILE_SIZE_BYTES },
  logger
);

const tempCleaner = createTempFileCleaner(
  {
    tempDir: appConfig.upload.tempDir,
    cleanerIntervalMs: appConfig.upload.cleanerIntervalMs,
    maxTempAgeMs: appConfig.upload.maxTempAgeMs,
  },
  logger
);

// ─── Avatar Versioning ────────────────────────────────────────────────────────

const avatarVersioning = createAvatarVersioningSystem({
  versionsDir: VERSIONS_DIR,
  maxVersions: AVATAR_MAX_VERSIONS,
});

// ─── Backup System ────────────────────────────────────────────────────────────

const backupSystem = createBackupSystem(
  {
    avatarsDir: appConfig.upload.finalDir,
    backupDir: BACKUP_DIR,
    intervalMs: BACKUP_INTERVAL_MS,
    maxBackups: BACKUP_MAX_KEEP,
  },
  (err) => logger.error('Backup error', { error: err.message })
);

// ─── Activity Log ─────────────────────────────────────────────────────────────

const activityLog = createActivityLog({
  maxEvents: ACTIVITY_LOG_MAX_EVENTS,
  logDir: appConfig.log.dir,
});

// ─── Webhook Events ───────────────────────────────────────────────────────────

const webhookEvents = createWebhookEvents(WEBHOOK_URL || undefined, WEBHOOK_SECRET || undefined, logger);

// ─── Admin Auth ───────────────────────────────────────────────────────────────

const adminAuth = createAdminAuth();

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1);

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(hpp());
app.use(compression({ threshold: 512 }) as any);
app.use(express.json({ limit: '1mb' })); // needed for /figura/v1/badges and other JSON endpoints

// Request timeout middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout' });
    }
    req.socket.destroy();
  }, appConfig.requestTimeoutMs);
  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  next();
});

// ─── HTTP server ──────────────────────────────────────────────────────────────

const httpServer = createServer(app);

// ─── BigAvatar-specific helpers ───────────────────────────────────────────────

const isValidUUID = (uuid: string) => /^[0-9a-fA-F-]{32,36}$/.test(uuid);

const formatUuid = (uuid: string): string => {
  if (!uuid) return '';
  const clean = uuid.replace(/-/g, '').toLowerCase();
  return clean.length === 32
    ? `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`
    : uuid;
};

const fastAxios = axios.create({
  timeout: 15000,
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 1000 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 1000 }),
});

const sendToDiscord = (message: string) => {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (url) fastAxios.post(url, { content: message }).catch(() => {});
};

// ─── In-memory state ──────────────────────────────────────────────────────────

/** Per-authenticated-user info, keyed by token string */
interface UserInfo {
  uuid: string;
  hexUuid: string;
  hexUuidBuffer: Buffer;
  username: string;
  usernameLower: string;
  lastSize: number;
  lastAccess: number;
  createdAt: number;
  equippedBadges: { special: number[]; pride: number[] };
  activeSockets: Set<WebSocket>;
}

const tokens = new Map<string, UserInfo>();
const server_ids = new LRUCache<string, { username: string; time: number }>(1000, 5 * 60 * 1000);

// Blacklist/whitelist/maintenance (synced from API every SYNC_INTERVAL_MS)
let sqlBlacklist = new Set<string>();
let sqlWhitelist = new Set<string>();
let isMaintenanceMode = false;

// Server stats (persisted to disk)
const statsFile = path.join(process.cwd(), 'statsDB.json');
let serverStats = { totalLogins: 0, totalUploads: 0, totalBytes: 0 };
try {
  const raw = fs.readFileSync(statsFile, 'utf8');
  serverStats = JSON.parse(raw);
} catch { /* first run */ }

const saveStats = () =>
  fsp.writeFile(statsFile, JSON.stringify(serverStats)).catch(() => {});

/** wsMap: uuid → Set of watching WebSocket clients */
const wsMap = new Map<string, Set<WebSocket>>();

// ─── WebSocket broadcast helpers ─────────────────────────────────────────────

const broadcastToLocalWatchers = (uuid: string, buffer: Buffer, excludeWs?: WebSocket) => {
  const watchers = wsMap.get(uuid);
  if (!watchers) return;
  watchers.forEach((tws) => {
    if (tws === excludeWs) return;
    try {
      if (tws.readyState === WebSocket.OPEN && (tws as any).bufferedAmount < 1048576) {
        tws.send(buffer, { binary: true });
      } else if (tws.readyState !== WebSocket.OPEN) {
        watchers.delete(tws);
      }
    } catch { watchers.delete(tws); }
  });
};

const broadcastGlobal = (uuid: string, buffer: Buffer, excludeWs?: WebSocket) => {
  broadcastToLocalWatchers(uuid, buffer, excludeWs);
  if (redisWrapper?.isConnected) {
    redisWrapper.client
      .publish('avatar-broadcast', JSON.stringify({ uuid, bufferHex: buffer.toString('hex') }))
      .catch(() => {});
  }
};

// ─── Auth middleware ──────────────────────────────────────────────────────────

const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const userInfo = tokens.get(req.headers['token'] as string);
  if (!userInfo) return res.status(401).end();
  (req as any).userInfo = userInfo;
  next();
};

// ─── Custom WebSocket server (BigAvatar binary protocol) ─────────────────────

const wss = new WebSocketServer({ server: httpServer });

// Per-connection rate limiting: 50 msgs/sec
const WS_RATE_WINDOW_MS = 1000;
const WS_RATE_MAX = 50;

wss.on('connection', (ws: WebSocket) => {
  // Connection limit based on free RAM
  if (wss.clients.size > MAX_WS) {
    ws.close(1013, 'Try again later');
    return;
  }

  let authenticated = false;
  let userInfo: UserInfo | null = null;
  let token: string | null = null;

  // Per-connection rate limit state
  let msgCount = 0;
  let msgWindowStart = Date.now();

  // Auth timeout: close unauthenticated connections after 5 seconds
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      ws.close(1008, 'Auth timeout');
    }
  }, 5000);

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    // Normalise to Buffer
    let buf: Buffer;
    if (Buffer.isBuffer(data)) {
      buf = data;
    } else if (data instanceof ArrayBuffer) {
      buf = Buffer.from(data);
    } else {
      buf = Buffer.concat(data as Buffer[]);
    }

    if (buf.length === 0) return;

    // Per-connection rate limit (50 msgs/sec)
    const now = Date.now();
    if (now - msgWindowStart > WS_RATE_WINDOW_MS) {
      msgCount = 0;
      msgWindowStart = now;
    }
    msgCount++;
    if (msgCount > WS_RATE_MAX) {
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    const msgType = buf[0];

    // ── Type 0: Auth ──────────────────────────────────────────────────────────
    if (msgType === 0x00) {
      const tokenStr = buf.slice(1).toString('utf8').trim();
      const info = tokens.get(tokenStr);
      if (!info) {
        ws.close(1008, 'Invalid token');
        return;
      }
      clearTimeout(authTimeout);
      authenticated = true;
      userInfo = info;
      token = tokenStr;
      info.activeSockets.add(ws);
      info.lastAccess = Date.now();
      // Acknowledge auth
      const ack = Buffer.allocUnsafe(1);
      ack.writeUInt8(0x00, 0);
      ws.send(ack, { binary: true });
      return;
    }

    // All other message types require authentication
    if (!authenticated || !userInfo) {
      ws.close(1008, 'Not authenticated');
      return;
    }

    userInfo.lastAccess = Date.now();

    // ── Type 1: Pose broadcast ────────────────────────────────────────────────
    if (msgType === 0x01) {
      if (buf.length < 6) return; // [0x01][int32 tick][uint8 isGlobal][...data]
      const isGlobal = buf[5] !== 0;
      // Build broadcast buffer: [0x00][16-byte hexUuidBuffer][...pose data]
      const payload = buf.slice(1); // everything after type byte
      const outBuf = Buffer.allocUnsafe(1 + 16 + payload.length);
      outBuf.writeUInt8(0x00, 0);
      userInfo.hexUuidBuffer.copy(outBuf, 1);
      payload.copy(outBuf, 17);

      if (isGlobal) {
        broadcastGlobal(userInfo.uuid, outBuf, ws);
      } else {
        broadcastToLocalWatchers(userInfo.uuid, outBuf, ws);
      }
      return;
    }

    // ── Type 2: Watch ─────────────────────────────────────────────────────────
    if (msgType === 0x02) {
      if (buf.length < 17) return; // [0x02][16 bytes uuid hex]
      const uuidHex = buf.slice(1, 17).toString('hex');
      const uuid = formatUuid(uuidHex);
      if (!wsMap.has(uuid)) wsMap.set(uuid, new Set());
      wsMap.get(uuid)!.add(ws);
      return;
    }

    // ── Type 3: Unwatch ───────────────────────────────────────────────────────
    if (msgType === 0x03) {
      if (buf.length < 17) return; // [0x03][16 bytes uuid hex]
      const uuidHex = buf.slice(1, 17).toString('hex');
      const uuid = formatUuid(uuidHex);
      wsMap.get(uuid)?.delete(ws);
      return;
    }
  });

  ws.on('pong', () => {
    // Handled by ping interval below
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (userInfo) {
      userInfo.activeSockets.delete(ws);
    }
    // Remove from all watch sets
    wsMap.forEach((watchers) => watchers.delete(ws));
  });

  ws.on('error', (err: Error) => {
    logger.debug('WebSocket error', { error: err.message });
    clearTimeout(authTimeout);
    if (userInfo) userInfo.activeSockets.delete(ws);
    wsMap.forEach((watchers) => watchers.delete(ws));
  });
});

// Ping/pong heartbeat — keeps connections alive and detects dead clients
const wsPingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if ((ws as any)._isAlive === false) {
      ws.terminate();
      return;
    }
    (ws as any)._isAlive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL_MS);

// Mark alive on pong — attach once per connection via the server event
wss.on('connection', (ws: WebSocket) => {
  (ws as any)._isAlive = true;
  ws.on('pong', () => { (ws as any)._isAlive = true; });
});

// ─── wsManager-compatible object for health-monitor ───────────────────────────

const wsManagerCompat: WebSocketManager = {
  get connectionCount() { return wss.clients.size; },
  closeAll(code: number) { wss.clients.forEach((ws) => ws.close(code)); },
  destroy() { clearInterval(wsPingInterval); },
};

// ─── Health monitor ───────────────────────────────────────────────────────────

const healthMonitor = createHealthMonitor(
  {
    refreshIntervalMs: appConfig.health.refreshIntervalMs,
    diskWarnFreeBytes: appConfig.health.diskWarnFreeBytes,
    maxOldSpaceBytes: appConfig.maxOldSpaceMb * 1024 * 1024,
    memoryPressureThreshold: appConfig.memoryPressureThreshold,
    uploadDir: appConfig.upload.finalDir,
    degradedAfterMs: appConfig.redis.degradedAfterMs,
  },
  redisWrapper ?? null,
  wsManagerCompat,
  uploadPipeline,
  logger
);

// ─── Metrics & Alerting ───────────────────────────────────────────────────────

const metricsAlerting = createMetricsAlerting(healthMonitor, DISCORD_WEBHOOK_URL, logger);

// ─── Graceful shutdown ────────────────────────────────────────────────────────

const shutdownHandler = createGracefulShutdownHandler(
  httpServer,
  wsManagerCompat,
  logger,
  appConfig.shutdown,
  () => logger.flush()
);

// ─── Middleware stack ─────────────────────────────────────────────────────────

app.use(shutdownHandler.middleware);
app.use(antiSpam.middleware());
app.use('/api/avatar', rateLimiters.upload);
app.use('/api/', rateLimiters.api);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  const snapshot = healthMonitor.getSnapshot();
  res.status(snapshot.status === 'healthy' ? 200 : 503).json(snapshot);
});

app.get('/api/motd', (_req: Request, res: Response) => {
  res.status(200).send(process.env.MOTD_MESSAGE || 'BigAvatar Cloud');
});

app.get('/api/version', (_req: Request, res: Response) => {
  res.json({ release: '0.1.5', prerelease: '0.1.5' });
});

app.get('/api/limits', (_req: Request, res: Response) => {
  res.json({
    rate: { pingSize: 1048576, pingRate: 4096, equip: 0, download: 999999999999, upload: 99999999999 },
    limits: {
      maxAvatarSize: UPLOAD_MAX_FILE_SIZE_BYTES,
      maxAvatars: 100,
      allowedBadges: { special: Array(15).fill(0), pride: Array(30).fill(0) },
    },
  });
});

app.get('/api/server-stats', (req: Request, res: Response) => {
  if (req.query.pass !== (process.env.DASHBOARD_PASS || 'admin123'))
    return res.status(403).json({ error: 'Unauthorized' });
  const snapshot = healthMonitor.getSnapshot();
  res.json({
    totalLogins: serverStats.totalLogins,
    totalUploads: serverStats.totalUploads,
    totalBytesMB: (serverStats.totalBytes / 1024 / 1024).toFixed(2),
    ramUsageMB: (snapshot.memory.heapUsed / 1024 / 1024).toFixed(2),
    uptime: snapshot.uptime,
    zone: process.env.SERVER_ZONE || 'TH',
  });
});

// Auth: issue a server ID for Mojang session verification
app.get('/api/auth/id', (req: Request, res: Response) => {
  const uname = (req.query.username as string)?.toLowerCase();
  if (!uname) return res.status(400).end();
  if (isMaintenanceMode) return res.status(503).send('§e⚠ Server maintenance');
  if (sqlBlacklist.has(uname)) return res.status(403).send('§c✖ Account banned');
  if (ENABLE_WHITELIST && !sqlWhitelist.has(uname))
    return res.status(403).send('§c✖ Not whitelisted');
  const serverID = crypto.randomBytes(16).toString('hex');
  server_ids.set(serverID, { username: req.query.username as string, time: Date.now() });
  // Send both plain text (BigAvatar compat) and JSON-parseable format
  res.setHeader('Content-Type', 'text/plain');
  res.send(serverID);
});

// Auth: verify with Mojang hasJoined and issue a session token
app.get('/api/auth/verify', async (req: Request, res: Response) => {
  try {
    const sid = req.query.id as string;
    const sessionData = server_ids.get(sid);
    if (!sessionData) return res.status(404).json({ error: 'Auth failed' });

    const response = await fastAxios.get(
      'https://sessionserver.mojang.com/session/minecraft/hasJoined',
      { params: { username: sessionData.username, serverId: sid } }
    );
    server_ids.delete(sid);

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

    // Load persisted badges from disk
    const badgeFile = path.join(appConfig.upload.finalDir, `${premiumUuid}.badges.json`);
    fsp.readFile(badgeFile, 'utf8').then(raw => {
      const userInfo = tokens.get(token);
      if (userInfo) userInfo.equippedBadges = JSON.parse(raw);
    }).catch(() => {});

    serverStats.totalLogins++;
    saveStats();
    logger.info('Login', { username: response.data.name, uuid: premiumUuid });

    // Activity log + webhook
    activityLog.record({ event: 'login', uuid: premiumUuid, username: response.data.name, ip: (req as any).clientIp || req.ip });
    webhookEvents.emit('user.login', { uuid: premiumUuid, username: response.data.name });

    res.send(token);
  } catch (err) {
    logger.error('Auth verify error', { error: String(err) });
    res.status(500).json({ error: 'Auth error' });
  }
});

// Equip: broadcast equip event to all watchers
app.post('/api/equip', authMiddleware, (req: Request, res: Response) => {
  const userInfo = (req as any).userInfo as UserInfo;
  userInfo.lastAccess = Date.now();
  // Type 2 equip broadcast: [0x02][16-byte hexUuidBuffer]
  const buffer = Buffer.allocUnsafe(17);
  buffer.writeUInt8(2, 0);
  userInfo.hexUuidBuffer.copy(buffer, 1);
  broadcastGlobal(userInfo.uuid, buffer);
  res.send('success');
});

// Upload avatar — Fix #7: track lastSize; Fix #8: increment totalBytes
app.put('/api/avatar', authMiddleware, async (req: Request, res: Response) => {
  const userInfo = (req as any).userInfo as UserInfo;
  userInfo.lastAccess = Date.now();

  const tempPath = path.join(appConfig.upload.tempDir, `${userInfo.uuid}_${Date.now()}.tmp`);
  const finalPath = path.join(appConfig.upload.finalDir, `${userInfo.uuid}.moon`);

  // Capture Content-Length before pipeline consumes the stream
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);

  const result = await uploadPipeline.handleUpload(req, res, tempPath, finalPath);
  if (result) {
    // Fix #7: track bytes uploaded for this user
    userInfo.lastSize = contentLength || 0;
    hashCache.set(userInfo.uuid, result.hash);
    apiJsonCache.delete(userInfo.uuid);
    serverStats.totalUploads++;
    // Fix #8: increment totalBytes with actual upload size
    serverStats.totalBytes += userInfo.lastSize;
    saveStats();

    // Snapshot previous version before overwriting (if file existed)
    avatarVersioning.snapshot(userInfo.uuid, finalPath, result.hash, userInfo.lastSize).catch(() => {});

    // Activity log + webhook
    activityLog.record({ event: 'upload', uuid: userInfo.uuid, username: userInfo.username, ip: (req as any).clientIp || req.ip, details: { hash: result.hash, sizeBytes: userInfo.lastSize } });
    webhookEvents.emit('avatar.uploaded', { uuid: userInfo.uuid, username: userInfo.username, hash: result.hash, sizeBytes: userInfo.lastSize });

    // Broadcast equip event after successful upload
    const buffer = Buffer.allocUnsafe(17);
    buffer.writeUInt8(2, 0);
    userInfo.hexUuidBuffer.copy(buffer, 1);
    broadcastGlobal(userInfo.uuid, buffer);
  }
});

// Delete avatar
app.delete('/api/avatar', authMiddleware, async (req: Request, res: Response) => {
  const userInfo = (req as any).userInfo as UserInfo;
  try {
    userInfo.lastAccess = Date.now();
    await fsp.unlink(path.join(appConfig.upload.finalDir, `${userInfo.uuid}.moon`));
    hashCache.delete(userInfo.uuid);
    apiJsonCache.delete(userInfo.uuid);
    activityLog.record({ event: 'delete', uuid: userInfo.uuid, username: userInfo.username });
    webhookEvents.emit('avatar.deleted', { uuid: userInfo.uuid, username: userInfo.username });
    const buffer = Buffer.allocUnsafe(17);
    buffer.writeUInt8(2, 0);
    userInfo.hexUuidBuffer.copy(buffer, 1);
    broadcastGlobal(userInfo.uuid, buffer);
    res.send('success');
  } catch {
    res.status(404).end();
  }
});

// Get avatar file — Fix #5: use path.resolve() for absolute path
app.get('/api/:uuid/avatar', async (req: Request, res: Response) => {
  const uuidStr = req.params.uuid;
  if (!isValidUUID(uuidStr)) return res.status(404).end();
  const avatarFile = path.resolve(appConfig.upload.finalDir, `${formatUuid(uuidStr)}.moon`);
  try {
    await fsp.access(avatarFile);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(avatarFile);
  } catch {
    res.status(404).end();
  }
});

// Get avatar JSON metadata
app.get('/api/:uuid', async (req: Request, res: Response) => {
  const uuidStr = req.params.uuid;
  const RESERVED = ['motd', 'version', 'auth', 'limits', 'server-stats', 'equip', 'avatar'];
  if (RESERVED.includes(uuidStr) || !isValidUUID(uuidStr)) return res.status(404).end();

  const uuid = formatUuid(uuidStr);
  const cached = apiJsonCache.get(uuid);
  if (cached) return res.json(cached);

  const data: any = {
    uuid,
    rank: 'normal',
    equipped: [],
    lastUsed: new Date().toISOString(),
    equippedBadges: { special: Array(15).fill(0), pride: Array(30).fill(0) },
    version: '0.1.5',
    banned: false,
  };

  let fileHash = hashCache.get(uuid);
  if (!fileHash) {
    try {
      const fileBuffer = await fsp.readFile(
        path.join(appConfig.upload.finalDir, `${uuid}.moon`)
      );
      fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      hashCache.set(uuid, fileHash);
    } catch { /* no avatar on disk */ }
  }
  if (fileHash) data.equipped.push({ id: 'avatar', owner: uuid, hash: fileHash });

  apiJsonCache.set(uuid, data);
  res.json(data);
});

// Admin: list bans
app.get('/admin/bans', async (_req: Request, res: Response) => {
  try {
    res.json(await antiSpam.listBans());
  } catch {
    res.status(500).json({ error: 'Failed to list bans' });
  }
});

// Admin: lift ban
app.delete('/admin/bans/:clientId', async (req: Request, res: Response) => {
  try {
    await antiSpam.liftBan(req.params.clientId);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to lift ban' });
  }
});

app.get('/', (_req: Request, res: Response) => {
  res.status(200).send(process.env.MOTD_MESSAGE || 'BigAvatar Cloud');
});

// Serve dashboard HTML
app.get('/dashboard', (_req: Request, res: Response) => {
  res.sendFile(path.resolve(__dirname, 'dashboard.html'));
});

// Online users list (dashboard use)
app.get('/api/online-users', (req: Request, res: Response) => {
  if (req.query.pass !== (process.env.DASHBOARD_PASS || 'admin123'))
    return res.status(403).json({ error: 'Unauthorized' });

  const users = Array.from(tokens.values()).map(u => ({
    username: u.username,
    uuid: u.uuid,
    lastSize: u.lastSize,
    activeSockets: u.activeSockets.size,
    lastAccess: new Date(u.lastAccess).toISOString(),
  }));
  res.json({ count: users.length, users });
});

// ─── Figura Backend API (/figura/v1/...) ──────────────────────────────────────

const figuraRouter = createFiguraRouter(
  {
    avatarsDir: appConfig.upload.finalDir,
    tempDir: appConfig.upload.tempDir,
    maxFileSizeBytes: UPLOAD_MAX_FILE_SIZE_BYTES,
    allowedMimeTypes: appConfig.upload.allowedMimeTypes,
    serverVersion: '0.1.5',
    enableWhitelist: ENABLE_WHITELIST,
    tokenMaxAgeMs: TOKEN_MAX_AGE_MS,
  },
  tokens as Map<string, FiguraUserInfo>,
  server_ids,
  hashCache,
  apiJsonCache,
  () => sqlBlacklist,
  () => sqlWhitelist,
  () => isMaintenanceMode,
  broadcastGlobal,
  uploadPipeline,
  logger
);

app.use('/figura/v1', figuraRouter);

// ─── Avatar Versioning Routes ─────────────────────────────────────────────────

// List versions for own avatar
app.get('/api/avatar/versions', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userInfo = (req as any).userInfo as UserInfo;
    const versions = await avatarVersioning.listVersions(userInfo.uuid);
    res.json({ uuid: userInfo.uuid, versions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list versions' });
  }
});

// Restore a specific version
app.post('/api/avatar/versions/:versionId/restore', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userInfo = (req as any).userInfo as UserInfo;
    const { versionId } = req.params;
    const finalPath = path.join(appConfig.upload.finalDir, `${userInfo.uuid}.moon`);

    const version = await avatarVersioning.restoreVersion(userInfo.uuid, versionId, finalPath);

    // Invalidate caches
    hashCache.set(userInfo.uuid, version.hash);
    apiJsonCache.delete(userInfo.uuid);

    // Broadcast equip event so watchers reload
    const buffer = Buffer.allocUnsafe(17);
    buffer.writeUInt8(2, 0);
    userInfo.hexUuidBuffer.copy(buffer, 1);
    broadcastGlobal(userInfo.uuid, buffer);

    logger.info('Avatar version restored', { uuid: userInfo.uuid, versionId });
    res.json({ success: true, version });
  } catch (err: any) {
    const msg = err?.message || 'Failed to restore version';
    res.status(msg.includes('not found') ? 404 : 500).json({ error: msg });
  }
});

// Delete a specific version
app.delete('/api/avatar/versions/:versionId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userInfo = (req as any).userInfo as UserInfo;
    await avatarVersioning.deleteVersion(userInfo.uuid, req.params.versionId);
    res.json({ success: true });
  } catch (err: any) {
    const msg = err?.message || 'Failed to delete version';
    res.status(msg.includes('not found') ? 404 : 500).json({ error: msg });
  }
});

// Admin: list versions for any uuid
app.get('/api/:uuid/versions', async (req: Request, res: Response) => {
  const uuidStr = req.params.uuid;
  if (!isValidUUID(uuidStr)) return res.status(404).end();
  try {
    const uuid = formatUuid(uuidStr);
    const versions = await avatarVersioning.listVersions(uuid);
    res.json({ uuid, versions });
  } catch {
    res.status(500).json({ error: 'Failed to list versions' });
  }
});

// ─── Backup Routes ────────────────────────────────────────────────────────────

const backupAuth = (req: Request, res: Response, next: NextFunction) => {
  if (req.query.pass !== (process.env.DASHBOARD_PASS || 'admin123') &&
      req.headers['x-admin-pass'] !== (process.env.DASHBOARD_PASS || 'admin123'))
    return res.status(403).json({ error: 'Unauthorized' });
  next();
};

// List all backups
app.get('/admin/backups', backupAuth, async (_req: Request, res: Response) => {
  try {
    res.json(await backupSystem.listBackups());
  } catch {
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

// Trigger manual backup
app.post('/admin/backups', backupAuth, async (_req: Request, res: Response) => {
  try {
    const entry = await backupSystem.runBackup();
    sendToDiscord(`💾 **[Backup]** Manual backup created: \`${entry.filename}\` (${entry.fileCount} files)`);
    res.json({ success: true, backup: entry });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Backup failed' });
  }
});

// Restore from a backup
app.post('/admin/backups/:backupId/restore', backupAuth, async (req: Request, res: Response) => {
  try {
    const result = await backupSystem.restoreBackup(req.params.backupId);
    // Invalidate all caches after restore
    hashCache.clear();
    apiJsonCache.clear();
    sendToDiscord(`♻️ **[Restore]** Restored \`${req.params.backupId}\` — ${result.restoredFiles} files`);
    res.json({ success: true, ...result });
  } catch (err: any) {
    const msg = err?.message || 'Restore failed';
    res.status(msg.includes('not found') ? 404 : 500).json({ error: msg });
  }
});

// Delete a backup
app.delete('/admin/backups/:backupId', backupAuth, async (req: Request, res: Response) => {
  try {
    await backupSystem.deleteBackup(req.params.backupId);
    res.json({ success: true });
  } catch (err: any) {
    const msg = err?.message || 'Delete failed';
    res.status(msg.includes('not found') ? 404 : 500).json({ error: msg });
  }
});

// ─── IP Geolocation ───────────────────────────────────────────────────────────

app.get('/api/geozone', async (req: Request, res: Response) => {
  const ip = (req.query.ip as string) || (req as any).clientIp || req.ip || '';
  try {
    const result = await geolocate(ip);
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Geolocation failed' });
  }
});

// ─── Activity Log ─────────────────────────────────────────────────────────────

app.get('/admin/activity', adminAuth, (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string || '100', 10), 500);
  const event = req.query.event as any;
  const uuid = req.query.uuid as string | undefined;
  res.json(activityLog.query({ limit, event, uuid }));
});

// ─── Webhook test ─────────────────────────────────────────────────────────────

app.get('/admin/webhooks/test', adminAuth, (_req: Request, res: Response) => {
  webhookEvents.emit('test', { message: 'Webhook test from BigAvatar Cloud', timestamp: new Date().toISOString() });
  res.json({ success: true, message: 'Test webhook sent' });
});

// ─── Avatar Preview ───────────────────────────────────────────────────────────

app.get('/api/:uuid/preview', async (req: Request, res: Response) => {
  const uuidStr = req.params.uuid;
  if (!isValidUUID(uuidStr)) return res.status(404).end();
  const uuid = formatUuid(uuidStr);
  try {
    const preview = await getAvatarPreview(uuid, appConfig.upload.finalDir, VERSIONS_DIR, hashCache);
    res.json(preview);
  } catch {
    res.status(500).json({ error: 'Preview failed' });
  }
});

app.get('/api/:uuid/card', async (req: Request, res: Response) => {
  const uuidStr = req.params.uuid;
  if (!isValidUUID(uuidStr)) return res.status(404).end();
  const uuid = formatUuid(uuidStr);
  try {
    const preview = await getAvatarPreview(uuid, appConfig.upload.finalDir, VERSIONS_DIR, hashCache);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(formatAvatarCard(preview));
  } catch {
    res.status(500).end();
  }
});

// ─── Express error middleware ─────────────────────────────────────────────────

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error('Request error', { error: err.message, stack: err.stack });
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── API sync interval (every 15s) ───────────────────────────────────────────
// Fetches blacklist/whitelist/maintenance from API_URL and sends heartbeat

async function syncFromApi(): Promise<void> {
  try {
    const response = await fastAxios.get(API_URL, {
      params: { action: 'sync', key: API_KEY },
      timeout: 10000,
    });
    const data = response.data;

    if (Array.isArray(data.blacklist)) {
      sqlBlacklist = new Set<string>(data.blacklist.map((s: string) => s.toLowerCase()));
    }
    if (Array.isArray(data.whitelist)) {
      sqlWhitelist = new Set<string>(data.whitelist.map((s: string) => s.toLowerCase()));
    }
    if (typeof data.maintenance === 'boolean') {
      isMaintenanceMode = data.maintenance;
    }
  } catch {
    // Non-fatal: keep using last known values
  }

  // Send heartbeat with online user count
  try {
    await fastAxios.post(API_URL, {
      action: 'heartbeat',
      key: API_KEY,
      onlineUsers: tokens.size,
      zone: process.env.SERVER_ZONE || 'TH',
    });
  } catch {
    // Non-fatal
  }
}

// ─── Token GC interval (every 5 min) ─────────────────────────────────────────
// Removes expired tokens and cleans up wsMap entries for disconnected sockets

function gcTokens(): void {
  const now = Date.now();
  for (const [tok, info] of tokens) {
    if (now - info.createdAt > TOKEN_MAX_AGE_MS) {
      // Close any active sockets for this token
      info.activeSockets.forEach((ws) => {
        try { ws.close(1001, 'Session expired'); } catch { /* ignore */ }
      });
      tokens.delete(tok);
      logger.debug('Token GC: removed expired token', { uuid: info.uuid });
    }
  }

  // Clean up wsMap: remove closed sockets from all watch sets
  wsMap.forEach((watchers, uuid) => {
    watchers.forEach((ws) => {
      if (ws.readyState !== WebSocket.OPEN) watchers.delete(ws);
    });
    if (watchers.size === 0) wsMap.delete(uuid);
  });
}

// ─── Redis pub/sub: subscribe to avatar-broadcast ────────────────────────────
// Broadcasts messages published by other server instances to local watchers

async function setupRedisPubSub(): Promise<void> {
  if (!redisWrapper?.isConnected) return;

  // Create a dedicated subscriber client (ioredis requires a separate connection for subscribe)
  const { Redis: IORedis } = await import('ioredis');
  const subClient = new IORedis(appConfig.redis.url, {
    connectTimeout: appConfig.redis.connectTimeoutMs,
    commandTimeout: appConfig.redis.commandTimeoutMs,
    maxRetriesPerRequest: null,
    retryStrategy: (attempt: number) =>
      Math.min(100 * Math.pow(2, attempt), appConfig.redis.maxRetryDelayMs),
    lazyConnect: false,
  });

  subClient.on('error', (err: Error) => {
    logger.error('Redis sub client error', { error: err.message });
  });

  await subClient.subscribe('avatar-broadcast');

  subClient.on('message', (_channel: string, message: string) => {
    try {
      const { uuid, bufferHex } = JSON.parse(message) as { uuid: string; bufferHex: string };
      const buffer = Buffer.from(bufferHex, 'hex');
      // Broadcast to local watchers only (do NOT re-publish to avoid loops)
      broadcastToLocalWatchers(uuid, buffer);
    } catch (err) {
      logger.error('Redis pub/sub message parse error', { error: String(err) });
    }
  });

  logger.info('Redis pub/sub subscribed to avatar-broadcast');
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Ensure upload directories exist
  await fsp.mkdir(appConfig.upload.tempDir, { recursive: true });
  await fsp.mkdir(appConfig.upload.finalDir, { recursive: true });
  await fsp.mkdir(VERSIONS_DIR, { recursive: true });
  await fsp.mkdir(BACKUP_DIR, { recursive: true });

  tempCleaner.start();
  backupSystem.start();
  await healthMonitor.start();
  metricsAlerting.start();
  shutdownHandler.registerHandlers();

  // Send Discord alert on graceful shutdown signals
  const notifyStop = () => sendToDiscord('🛑 **[SYSTEM STOP]** BigAvatar Cloud shutting down.');
  process.once('SIGTERM', notifyStop);
  process.once('SIGINT', notifyStop);

  // Tune keep-alive timeouts for production
  httpServer.keepAliveTimeout = 120000;
  httpServer.headersTimeout = 125000;

  httpServer.listen(appConfig.port, '0.0.0.0', () => {
    logger.info('BigAvatar Cloud started', {
      port: appConfig.port,
      zone: process.env.SERVER_ZONE || 'TH',
      redis: redisWrapper ? 'connected' : 'single-node',
      maxWs: MAX_WS,
      uploadMaxBytes: UPLOAD_MAX_FILE_SIZE_BYTES,
    });
    sendToDiscord('🚀 **[SYSTEM START]** BigAvatar Cloud online!');
  });

  // API sync: run immediately then every SYNC_INTERVAL_MS
  syncFromApi().catch(() => {});
  setInterval(() => syncFromApi().catch(() => {}), SYNC_INTERVAL_MS);

  // Token GC: every 5 minutes
  setInterval(gcTokens, 5 * 60 * 1000);

  // Redis pub/sub (non-fatal if Redis is unavailable)
  setupRedisPubSub().catch((err) => {
    logger.warn('Redis pub/sub setup failed', { error: String(err) });
  });
}

start().catch((err) => {
  logger.error('Failed to start server', { error: String(err) });
  process.exit(1);
});
