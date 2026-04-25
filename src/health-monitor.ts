import { memoryUsage, uptime } from 'process';
import { loadavg } from 'os';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger, RedisClientWrapper, HealthSnapshot } from './types';
import { WebSocketManager } from './ws-manager';
import { UploadPipelineHandle } from './upload-pipeline';

const execFileAsync = promisify(execFile);

export interface HealthMonitorConfig {
  refreshIntervalMs: number;
  diskWarnFreeBytes: number;
  maxOldSpaceBytes: number;
  memoryPressureThreshold: number;
  uploadDir: string;
  degradedAfterMs: number;
}

export interface HealthMonitor {
  start(): Promise<void>;
  stop(): void;
  getSnapshot(): HealthSnapshot;
}

/**
 * Attempts to get free bytes for the given path.
 * Uses fs.promises.statfs (Node >= 19). Falls back to `df` on older Node,
 * and if that also fails, returns null (caller marks disk as healthy).
 */
async function getDiskFreeBytes(path: string): Promise<number | null> {
  // fs.promises.statfs is available in Node >= 19
  if (typeof (fs.promises as any).statfs === 'function') {
    try {
      const stats = await (fs.promises as any).statfs(path);
      return stats.bavail * stats.bsize;
    } catch {
      // fall through to df fallback
    }
  }

  // Fallback: parse `df -k <path>` output
  try {
    const { stdout } = await execFileAsync('df', ['-k', path]);
    const lines = stdout.trim().split('\n');
    // df output: Filesystem 1K-blocks Used Available Use% Mounted
    const parts = lines[lines.length - 1].split(/\s+/);
    const availableKb = parseInt(parts[3], 10);
    if (!isNaN(availableKb)) {
      return availableKb * 1024;
    }
  } catch {
    // fall through
  }

  return null;
}

export function createHealthMonitor(
  config: HealthMonitorConfig,
  redisWrapper: RedisClientWrapper | null,
  wsManager: WebSocketManager,
  uploadPipeline: UploadPipelineHandle,
  logger: Logger
): HealthMonitor {
  let interval: NodeJS.Timeout | null = null;
  let snapshot: HealthSnapshot | null = null;

  const refresh = async (): Promise<void> => {
    try {
      const mem = memoryUsage();
      const now = Date.now();

      // Check memory pressure
      const heapUsedPercent = mem.heapUsed / config.maxOldSpaceBytes;
      if (heapUsedPercent > config.memoryPressureThreshold) {
        logger.warn('Memory pressure detected', { heapUsedPercent });
      }

      // Check disk
      let diskFreeBytes = 0;
      let diskStatus: 'healthy' | 'degraded' = 'healthy';
      try {
        const freeBytes = await getDiskFreeBytes(config.uploadDir);
        if (freeBytes === null) {
          // statfs not available and df failed — assume healthy
          diskFreeBytes = config.diskWarnFreeBytes; // sentinel: treat as at threshold
        } else {
          diskFreeBytes = freeBytes;
          if (diskFreeBytes < config.diskWarnFreeBytes) {
            diskStatus = 'degraded';
          }
        }
      } catch (err) {
        logger.error('Failed to check disk space', { error: String(err) });
        diskStatus = 'degraded';
      }

      // Check Redis
      let redisStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      let redisLatencyMs = 0;

      if (redisWrapper) {
        if (!redisWrapper.isConnected) {
          if (
            redisWrapper.disconnectedSince !== null &&
            now - redisWrapper.disconnectedSince > config.degradedAfterMs
          ) {
            redisStatus = 'degraded';
          } else {
            redisStatus = 'unhealthy';
          }
        } else {
          // Measure latency
          const startTime = Date.now();
          try {
            await redisWrapper.client.ping();
            redisLatencyMs = Date.now() - startTime;
          } catch (err) {
            logger.error('Redis PING failed', { error: String(err) });
            redisStatus = 'unhealthy';
          }
        }
      }

      // Determine overall status
      let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      if (diskStatus === 'degraded' || redisStatus === 'degraded') {
        overallStatus = 'degraded';
      }
      if (redisStatus === 'unhealthy') {
        overallStatus = 'unhealthy';
      }

      snapshot = {
        status: overallStatus,
        uptime: uptime(),
        timestamp: new Date().toISOString(),
        memory: {
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
        },
        cpu: {
          loadAvg: loadavg() as [number, number, number],
        },
        disk: {
          freeBytes: diskFreeBytes,
          status: diskStatus,
        },
        redis: {
          status: redisStatus,
          latencyMs: redisLatencyMs,
        },
        websocket: {
          activeConnections: wsManager.connectionCount,
        },
        upload: {
          pendingCount: uploadPipeline.pendingCount,
        },
      };
    } catch (err) {
      logger.error('Health monitor refresh failed', { error: String(err) });
    }
  };

  return {
    async start(): Promise<void> {
      if (interval) return;
      await refresh(); // Initial refresh — await so first snapshot is ready
      interval = setInterval(refresh, config.refreshIntervalMs);
      logger.info('Health monitor started', { intervalMs: config.refreshIntervalMs });
    },

    stop(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
        logger.info('Health monitor stopped');
      }
    },

    getSnapshot(): HealthSnapshot {
      return (
        snapshot || {
          status: 'unhealthy',
          uptime: uptime(),
          timestamp: new Date().toISOString(),
          memory: { heapUsed: 0, heapTotal: 0 },
          cpu: { loadAvg: [0, 0, 0] },
          disk: { freeBytes: 0, status: 'degraded' },
          redis: { status: 'unhealthy', latencyMs: 0 },
          websocket: { activeConnections: 0 },
          upload: { pendingCount: 0 },
        }
      );
    },
  };
}
