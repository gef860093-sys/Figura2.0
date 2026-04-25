import { createHealthMonitor } from '../../health-monitor';
import * as fc from 'fast-check';

describe('Health Monitor', () => {
  let logger: any;
  let mockWsManager: any;
  let mockUploadPipeline: any;

  beforeEach(() => {
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    mockWsManager = {
      connectionCount: 0,
    };

    mockUploadPipeline = {
      pendingCount: 0,
    };
  });

  // Property 22: Health response status reflects subsystem states
  it('should return healthy status when all subsystems healthy', async () => {
    const monitor = createHealthMonitor(
      {
        refreshIntervalMs: 1000,
        diskWarnFreeBytes: 524288000,
        maxOldSpaceBytes: 134217728,
        memoryPressureThreshold: 0.85,
        uploadDir: '/tmp',
        degradedAfterMs: 60000,
      },
      null,
      mockWsManager,
      mockUploadPipeline,
      logger
    );

    await monitor.start();
    const snapshot = monitor.getSnapshot();

    expect(snapshot.status).toBe('healthy');
    monitor.stop();
  });

  // Property 23: Health response contains all required fields
  it('should include all required fields in health response', async () => {
    const monitor = createHealthMonitor(
      {
        refreshIntervalMs: 1000,
        diskWarnFreeBytes: 524288000,
        maxOldSpaceBytes: 134217728,
        memoryPressureThreshold: 0.85,
        uploadDir: '/tmp',
        degradedAfterMs: 60000,
      },
      null,
      mockWsManager,
      mockUploadPipeline,
      logger
    );

    await monitor.start();
    const snapshot = monitor.getSnapshot();

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

  // Property 24: Disk degraded status threshold
  it('should mark disk degraded when free space below threshold', async () => {
    const monitor = createHealthMonitor(
      {
        refreshIntervalMs: 1000,
        diskWarnFreeBytes: 1099511627776, // Very high threshold
        maxOldSpaceBytes: 134217728,
        memoryPressureThreshold: 0.85,
        uploadDir: '/tmp',
        degradedAfterMs: 60000,
      },
      null,
      mockWsManager,
      mockUploadPipeline,
      logger
    );

    await monitor.start();
    const snapshot = monitor.getSnapshot();

    // Disk should be degraded due to high threshold
    expect(snapshot.disk.status).toBe('degraded');
    monitor.stop();
  });
});
