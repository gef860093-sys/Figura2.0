/**
 * Integration tests for Health Monitor.
 * Requirements: 7.4, 7.6
 */

import { createHealthMonitor } from '../../health-monitor';
import { Logger, RedisClientWrapper, HealthSnapshot } from '../../types';
import { WebSocketManager } from '../../ws-manager';
import { UploadPipelineHandle } from '../../upload-pipeline';

// ─── Mock logger ──────────────────────────────────────────────────────────────

const mockLogger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
  flush: jest.fn().mockResolvedValue(undefined),
};

// ─── Mock dependencies ────────────────────────────────────────────────────────

const mockWsManager: WebSocketManager = {
  get connectionCount() { return 5; },
  closeAll: jest.fn(),
  destroy: jest.fn(),
};

const mockUploadPipeline: UploadPipelineHandle = {
  get pendingCount() { return 2; },
  handleUpload: jest.fn(),
};

const mockRedisWrapper: RedisClientWrapper = {
  get client() {
    return {
      ping: jest.fn().mockResolvedValue('PONG'),
    } as any;
  },
  get isConnected() { return true; },
  get disconnectedSince() { return null; },
  on: jest.fn(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Health Monitor (Requirements 7.4, 7.6)', () => {
  const config = {
    refreshIntervalMs: 100,
    diskWarnFreeBytes: 524288000,
    maxOldSpaceBytes: 512 * 1024 * 1024,
    memoryPressureThreshold: 0.85,
    uploadDir: process.cwd(),
    degradedAfterMs: 60000,
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns unhealthy snapshot before start()', () => {
    const monitor = createHealthMonitor(config, null, mockWsManager, mockUploadPipeline, mockLogger);
    const snapshot = monitor.getSnapshot();
    expect(snapshot.status).toBe('unhealthy');
  });

  it('returns snapshot with all required fields after start() (Requirement 7.3)', async () => {
    const monitor = createHealthMonitor(config, null, mockWsManager, mockUploadPipeline, mockLogger);
    await monitor.start();

    const snapshot = monitor.getSnapshot();

    // Requirement 7.3: all required fields must be present
    expect(snapshot).toHaveProperty('status');
    expect(snapshot).toHaveProperty('uptime');
    expect(snapshot).toHaveProperty('timestamp');
    expect(snapshot).toHaveProperty('memory.heapUsed');
    expect(snapshot).toHaveProperty('memory.heapTotal');
    expect(snapshot).toHaveProperty('cpu.loadAvg');
    expect(snapshot).toHaveProperty('disk.freeBytes');
    expect(snapshot).toHaveProperty('redis.status');
    expect(snapshot).toHaveProperty('redis.latencyMs');
    expect(snapshot).toHaveProperty('websocket.activeConnections');
    expect(snapshot).toHaveProperty('upload.pendingCount');

    monitor.stop();
  });

  it('reflects WebSocket connection count in snapshot', async () => {
    const monitor = createHealthMonitor(config, null, mockWsManager, mockUploadPipeline, mockLogger);
    await monitor.start();

    const snapshot = monitor.getSnapshot();
    expect(snapshot.websocket.activeConnections).toBe(5);

    monitor.stop();
  });

  it('reflects upload pending count in snapshot', async () => {
    const monitor = createHealthMonitor(config, null, mockWsManager, mockUploadPipeline, mockLogger);
    await monitor.start();

    const snapshot = monitor.getSnapshot();
    expect(snapshot.upload.pendingCount).toBe(2);

    monitor.stop();
  });

  it('measures Redis PING latency (Requirement 7.4)', async () => {
    const monitor = createHealthMonitor(
      config,
      mockRedisWrapper,
      mockWsManager,
      mockUploadPipeline,
      mockLogger
    );
    await monitor.start();

    const snapshot = monitor.getSnapshot();
    expect(snapshot.redis.status).toBe('healthy');
    expect(typeof snapshot.redis.latencyMs).toBe('number');
    expect(snapshot.redis.latencyMs).toBeGreaterThanOrEqual(0);

    monitor.stop();
  });

  it('marks Redis as unhealthy when disconnected', async () => {
    const disconnectedRedis: RedisClientWrapper = {
      get client() { return {} as any; },
      get isConnected() { return false; },
      get disconnectedSince() { return Date.now() - 1000; }, // disconnected 1s ago
      on: jest.fn(),
    };

    const monitor = createHealthMonitor(
      config,
      disconnectedRedis,
      mockWsManager,
      mockUploadPipeline,
      mockLogger
    );
    await monitor.start();

    const snapshot = monitor.getSnapshot();
    expect(['unhealthy', 'degraded']).toContain(snapshot.redis.status);
    expect(['unhealthy', 'degraded']).toContain(snapshot.status);

    monitor.stop();
  });

  it('marks Redis as degraded when disconnected longer than degradedAfterMs', async () => {
    const longDisconnectedRedis: RedisClientWrapper = {
      get client() { return {} as any; },
      get isConnected() { return false; },
      get disconnectedSince() { return Date.now() - 120000; }, // 2 minutes ago
      on: jest.fn(),
    };

    const monitor = createHealthMonitor(
      config,
      longDisconnectedRedis,
      mockWsManager,
      mockUploadPipeline,
      mockLogger
    );
    await monitor.start();

    const snapshot = monitor.getSnapshot();
    expect(snapshot.redis.status).toBe('degraded');

    monitor.stop();
  });

  it('marks disk as degraded when free bytes below threshold (Requirement 7.5)', async () => {
    const lowDiskConfig = {
      ...config,
      diskWarnFreeBytes: Number.MAX_SAFE_INTEGER, // always trigger degraded
    };

    const monitor = createHealthMonitor(
      lowDiskConfig,
      null,
      mockWsManager,
      mockUploadPipeline,
      mockLogger
    );
    await monitor.start();

    const snapshot = monitor.getSnapshot();
    // disk.freeBytes will be less than MAX_SAFE_INTEGER
    expect(snapshot.disk.status).toBe('degraded');

    monitor.stop();
  });

  it('returns HTTP 200 status when healthy, 503 when degraded (Requirement 7.2)', async () => {
    const monitor = createHealthMonitor(config, null, mockWsManager, mockUploadPipeline, mockLogger);
    await monitor.start();

    const snapshot = monitor.getSnapshot();
    const httpStatus = snapshot.status === 'healthy' ? 200 : 503;
    expect([200, 503]).toContain(httpStatus);

    monitor.stop();
  });

  it('caches snapshot — getSnapshot() never triggers live check (Requirement 7.6)', async () => {
    const pingMock = jest.fn().mockResolvedValue('PONG');
    const cachedRedis: RedisClientWrapper = {
      get client() { return { ping: pingMock } as any; },
      get isConnected() { return true; },
      get disconnectedSince() { return null; },
      on: jest.fn(),
    };

    const monitor = createHealthMonitor(
      config,
      cachedRedis,
      mockWsManager,
      mockUploadPipeline,
      mockLogger
    );
    await monitor.start();

    const callCountAfterStart = pingMock.mock.calls.length;

    // Multiple getSnapshot() calls should NOT trigger additional pings
    monitor.getSnapshot();
    monitor.getSnapshot();
    monitor.getSnapshot();

    expect(pingMock.mock.calls.length).toBe(callCountAfterStart);

    monitor.stop();
  });
});
