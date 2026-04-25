import { WebSocket } from 'ws';
import { Redis } from 'ioredis';

/**
 * Application configuration interface
 * Contains all configurable parameters for the BigAvatar server
 */
export interface AppConfig {
  port: number;
  maxOldSpaceMb: number;
  memoryPressureThreshold: number; // 0–1, default 0.85

  cache: {
    maxEntries: number;
    defaultTtlMs: number;
    staleTtlMs: number;
  };

  ws: {
    pingIntervalMs: number; // default 30_000
    pongTimeoutMs: number; // default 10_000
    maxConnections: number; // default 10_000
    maxMessageBytes: number; // default 1_048_576
    maxMsgRatePerMin: number;
  };

  upload: {
    maxFileSizeBytes: number; // default 10_485_760
    allowedMimeTypes: string[];
    tempDir: string;
    finalDir: string;
    cleanerIntervalMs: number; // default 600_000
    maxTempAgeMs: number; // default 1_800_000
  };

  redis: {
    url: string;
    connectTimeoutMs: number; // default 5_000
    commandTimeoutMs: number; // default 2_000
    maxRetryDelayMs: number; // default 30_000
    degradedAfterMs: number; // default 60_000
  };

  rateLimit: {
    uploadWindowMs: number;
    uploadMax: number;
    apiWindowMs: number;
    apiMax: number;
    windowResetGraceMs: number; // default 5_000
  };

  antiSpam: {
    violationsBeforeBan: number; // default 5
    violationWindowMs: number; // default 600_000
    banDurationMs: number; // default 900_000
    banExtensionMs: number; // default 900_000
    maxBanDurationMs: number; // default 86_400_000
    banExpiryGraceMs: number; // default 60_000
  };

  shutdown: {
    timeoutMs: number; // default 30_000
  };

  health: {
    refreshIntervalMs: number; // default 15_000
    diskWarnFreeBytes: number; // default 524_288_000
  };

  log: {
    level: 'error' | 'warn' | 'info' | 'debug';
    maxFileSizeBytes: number; // default 52_428_800
    maxFiles: number; // default 14
    dir: string;
  };

  requestTimeoutMs: number; // default 30_000
}

/**
 * Logger interface for structured logging
 */
export interface Logger {
  error(msg: string, meta?: object): void;
  warn(msg: string, meta?: object): void;
  info(msg: string, meta?: object): void;
  debug(msg: string, meta?: object): void;
  child(bindings: object): Logger;
  flush(): Promise<void>;
}

/**
 * Cache entry with TTL support
 */
export interface CacheEntry<V> {
  value: V;
  expiresAt: number; // Date.now() + ttlMs
}

/**
 * LRU Cache interface with O(1) operations
 */
export interface LRUCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V, ttlMs?: number): void;
  delete(key: K): boolean;
  clear(): void;
  readonly size: number;
}

/**
 * Redis client wrapper with connection state tracking
 */
export interface RedisClientWrapper {
  readonly client: Redis;
  readonly isConnected: boolean;
  readonly disconnectedSince: number | null;
  on(event: 'connected' | 'disconnected' | 'reconnected', cb: () => void): void;
}

/**
 * Managed WebSocket connection with tracking metadata
 */
export interface ManagedConnection {
  id: string;
  socket: WebSocket;
  isAlive: boolean;
  messageCount: number;
  messageWindowStart: number;
  createdAt: number;
}

/**
 * Ban record for anti-spam system
 */
export interface BanRecord {
  clientId: string;
  expiresAt: number;
  violations: number;
}

/**
 * Memory metrics snapshot
 */
export interface MemoryMetrics {
  heapUsed: number;
  heapTotal: number;
}

/**
 * CPU metrics snapshot
 */
export interface CPUMetrics {
  loadAvg: [number, number, number];
}

/**
 * Disk metrics snapshot
 */
export interface DiskMetrics {
  freeBytes: number;
  status: 'healthy' | 'degraded' | 'unhealthy';
}

/**
 * Redis health metrics
 */
export interface RedisMetrics {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs: number;
}

/**
 * WebSocket subsystem metrics
 */
export interface WebSocketMetrics {
  activeConnections: number;
}

/**
 * Upload subsystem metrics
 */
export interface UploadMetrics {
  pendingCount: number;
}

/**
 * Complete health snapshot
 */
export interface HealthSnapshot {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  timestamp: string;
  memory: MemoryMetrics;
  cpu: CPUMetrics;
  disk: DiskMetrics;
  redis: RedisMetrics;
  websocket: WebSocketMetrics;
  upload: UploadMetrics;
}

/**
 * Anti-Spam system interface
 */
export interface AntiSpamSystem {
  middleware(): (req: any, res: any, next: any) => void;
  recordViolation(clientId: string): Promise<void>;
  listBans(): Promise<BanRecord[]>;
  liftBan(clientId: string): Promise<void>;
}
