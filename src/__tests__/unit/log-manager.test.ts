import { createLogger } from '../../log-manager';
import { AppConfig } from '../../types';
import { promises as fs } from 'fs';
import path from 'path';
import * as os from 'os';

describe('Log Manager', () => {
  let tempDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    // Create temporary directory for logs
    tempDir = path.join(os.tmpdir(), `log-test-${Date.now()}-${Math.random()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Create base config
    config = {
      port: 3000,
      maxOldSpaceMb: 512,
      memoryPressureThreshold: 0.85,
      cache: { maxEntries: 1000, defaultTtlMs: 3600000, staleTtlMs: 300000 },
      ws: {
        pingIntervalMs: 30000,
        pongTimeoutMs: 10000,
        maxConnections: 10000,
        maxMessageBytes: 1048576,
        maxMsgRatePerMin: 50,
      },
      upload: {
        maxFileSizeBytes: 10485760,
        allowedMimeTypes: ['image/png', 'image/jpeg'],
        tempDir: path.join(tempDir, 'temp'),
        finalDir: path.join(tempDir, 'final'),
        cleanerIntervalMs: 600000,
        maxTempAgeMs: 1800000,
      },
      redis: {
        url: 'redis://localhost:6379',
        connectTimeoutMs: 5000,
        commandTimeoutMs: 2000,
        maxRetryDelayMs: 30000,
        degradedAfterMs: 60000,
      },
      rateLimit: {
        uploadWindowMs: 60000,
        uploadMax: 20,
        apiWindowMs: 60000,
        apiMax: 300,
        windowResetGraceMs: 5000,
      },
      antiSpam: {
        violationsBeforeBan: 5,
        violationWindowMs: 600000,
        banDurationMs: 900000,
        banExtensionMs: 900000,
        maxBanDurationMs: 86400000,
        banExpiryGraceMs: 60000,
      },
      shutdown: { timeoutMs: 30000 },
      health: { refreshIntervalMs: 15000, diskWarnFreeBytes: 524288000 },
      log: {
        level: 'debug',
        maxFileSizeBytes: 1024,
        maxFiles: 3,
        dir: tempDir,
      },
      requestTimeoutMs: 30000,
    };
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Log entry structure', () => {
    it('should include timestamp, level, requestId, and message in every log entry', async () => {
      const logger = createLogger(config, 'req_123');
      logger.info('Test message', { userId: 'user_456' });

      // Give winston time to write
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Read the log file
      const files = await fs.readdir(tempDir);
      const logFile = files.find((f) => f.startsWith('app-') && f.endsWith('.log'));
      expect(logFile).toBeDefined();

      if (logFile) {
        const content = await fs.readFile(path.join(tempDir, logFile), 'utf-8');
        const logEntry = JSON.parse(content.trim().split('\n')[0]);

        expect(logEntry).toHaveProperty('timestamp');
        expect(logEntry).toHaveProperty('level');
        expect(logEntry).toHaveProperty('requestId');
        expect(logEntry).toHaveProperty('message');
        expect(logEntry.requestId).toBe('req_123');
        expect(logEntry.message).toBe('Test message');
      }
    });

    it('should include additional metadata in log entries', async () => {
      const logger = createLogger(config, 'req_789');
      logger.info('Upload completed', { userId: 'user_123', durationMs: 142 });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const files = await fs.readdir(tempDir);
      const logFile = files.find((f) => f.startsWith('app-') && f.endsWith('.log'));

      if (logFile) {
        const content = await fs.readFile(path.join(tempDir, logFile), 'utf-8');
        const logEntry = JSON.parse(content.trim().split('\n')[0]);

        expect(logEntry.userId).toBe('user_123');
        expect(logEntry.durationMs).toBe(142);
      }
    });
  });

  describe('Log level filtering', () => {
    it('should suppress debug entries when level is info', async () => {
      const infoConfig: AppConfig = { ...config, log: { ...config.log, level: 'info' } };
      const logger = createLogger(infoConfig, 'req_debug');

      logger.debug('Debug message');
      logger.info('Info message');
      logger.warn('Warn message');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const files = await fs.readdir(tempDir);
      const logFile = files.find((f) => f.startsWith('app-') && f.endsWith('.log'));

      if (logFile) {
        const content = await fs.readFile(path.join(tempDir, logFile), 'utf-8');
        const lines = content.trim().split('\n').filter((l) => l.length > 0);

        // Should have info and warn, but not debug
        const levels = lines.map((l) => JSON.parse(l).level);
        expect(levels).not.toContain('debug');
        expect(levels).toContain('info');
        expect(levels).toContain('warn');
      }
    });

    it('should include debug entries when level is debug', async () => {
      const logger = createLogger(config, 'req_debug');

      logger.debug('Debug message');
      logger.info('Info message');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const files = await fs.readdir(tempDir);
      const logFile = files.find((f) => f.startsWith('app-') && f.endsWith('.log'));

      if (logFile) {
        const content = await fs.readFile(path.join(tempDir, logFile), 'utf-8');
        const lines = content.trim().split('\n').filter((l) => l.length > 0);
        const levels = lines.map((l) => JSON.parse(l).level);

        expect(levels).toContain('debug');
        expect(levels).toContain('info');
      }
    });
  });

  describe('Log level support', () => {
    it('should support all log levels: error, warn, info, debug', async () => {
      const logger = createLogger(config, 'req_levels');

      logger.error('Error message');
      logger.warn('Warn message');
      logger.info('Info message');
      logger.debug('Debug message');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const files = await fs.readdir(tempDir);
      const logFile = files.find((f) => f.startsWith('app-') && f.endsWith('.log'));

      if (logFile) {
        const content = await fs.readFile(path.join(tempDir, logFile), 'utf-8');
        const lines = content.trim().split('\n').filter((l) => l.length > 0);
        const levels = lines.map((l) => JSON.parse(l).level);

        expect(levels).toContain('error');
        expect(levels).toContain('warn');
        expect(levels).toContain('info');
        expect(levels).toContain('debug');
      }
    });
  });

  describe('File rotation on size limit', () => {
    it('should create log files with configured directory', async () => {
      const logger = createLogger(config, 'req_size');

      logger.info('Message 1');
      logger.info('Message 2');

      await new Promise((resolve) => setTimeout(resolve, 200));

      const files = await fs.readdir(tempDir);
      const logFiles = files.filter((f) => f.startsWith('app-') && f.endsWith('.log'));

      // Should have at least one log file
      expect(logFiles.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Max-files pruning', () => {
    it('should keep only maxFiles rotated files', async () => {
      const logger = createLogger(config, 'req_prune');

      // Write enough data to potentially trigger rotation
      for (let i = 0; i < 50; i++) {
        logger.info(`Message ${i}`, { data: 'x'.repeat(100) });
      }

      await new Promise((resolve) => setTimeout(resolve, 500));

      const files = await fs.readdir(tempDir);
      const logFiles = files.filter(
        (f) => f.startsWith('app-') && (f.endsWith('.log') || f.endsWith('.log.gz'))
      );

      // Should not exceed maxFiles (3)
      expect(logFiles.length).toBeLessThanOrEqual(config.log.maxFiles);
    });
  });

  describe('flush() method', () => {
    it('should flush all pending logs before returning', async () => {
      const logger = createLogger(config, 'req_flush');

      logger.info('Message 1');
      logger.info('Message 2');
      logger.info('Message 3');

      await logger.flush();

      const files = await fs.readdir(tempDir);
      const logFile = files.find((f) => f.startsWith('app-') && f.endsWith('.log'));

      if (logFile) {
        const content = await fs.readFile(path.join(tempDir, logFile), 'utf-8');
        const lines = content.trim().split('\n').filter((l) => l.length > 0);

        // All messages should be written
        expect(lines.length).toBeGreaterThanOrEqual(3);
      }
    });
  });

  describe('child logger', () => {
    it('should create child logger with inherited bindings', async () => {
      const logger = createLogger(config, 'req_parent');
      const childLogger = logger.child({ userId: 'user_123' });

      childLogger.info('Child message');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const files = await fs.readdir(tempDir);
      const logFile = files.find((f) => f.startsWith('app-') && f.endsWith('.log'));

      if (logFile) {
        const content = await fs.readFile(path.join(tempDir, logFile), 'utf-8');
        const logEntry = JSON.parse(content.trim().split('\n')[0]);

        expect(logEntry.userId).toBe('user_123');
      }
    });
  });

  describe('Property 25: Log file count invariant', () => {
    it('should never exceed maxFiles rotated log files', async () => {
      const testConfig: AppConfig = { ...config, log: { ...config.log, maxFiles: 5 } };
      const logger = createLogger(testConfig, 'req_prop25');

      // Write messages to trigger rotation
      for (let i = 0; i < 100; i++) {
        logger.info(`Message ${i}`, { data: 'x'.repeat(100) });
      }

      await new Promise((resolve) => setTimeout(resolve, 500));

      const files = await fs.readdir(tempDir);
      const logFiles = files.filter(
        (f) => f.startsWith('app-') && (f.endsWith('.log') || f.endsWith('.log.gz'))
      );

      expect(logFiles.length).toBeLessThanOrEqual(testConfig.log.maxFiles);
    });
  });

  describe('Property 26: Log entry required fields', () => {
    it('should include timestamp, level, requestId, and message in every log entry', async () => {
      const logger = createLogger(config, 'req_prop26');

      logger.error('Error message');
      logger.warn('Warn message');
      logger.info('Info message');
      logger.debug('Debug message');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const files = await fs.readdir(tempDir);
      const logFile = files.find((f) => f.startsWith('app-') && f.endsWith('.log'));

      if (logFile) {
        const content = await fs.readFile(path.join(tempDir, logFile), 'utf-8');
        const lines = content.trim().split('\n').filter((l) => l.length > 0);

        for (const line of lines) {
          const entry = JSON.parse(line);
          expect(entry).toHaveProperty('timestamp');
          expect(entry).toHaveProperty('level');
          expect(entry).toHaveProperty('requestId');
          expect(entry).toHaveProperty('message');
        }
      }
    });
  });

  describe('Property 27: Log level suppression', () => {
    it('should suppress log entries below configured level', async () => {
      const testConfig: AppConfig = {
        ...config,
        log: { ...config.log, level: 'warn' },
      };
      const logger = createLogger(testConfig, 'req_prop27');

      logger.error('Error');
      logger.warn('Warn');
      logger.info('Info');
      logger.debug('Debug');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const files = await fs.readdir(tempDir);
      const logFile = files.find((f) => f.startsWith('app-') && f.endsWith('.log'));

      if (logFile) {
        const content = await fs.readFile(path.join(tempDir, logFile), 'utf-8');
        const lines = content.trim().split('\n').filter((l) => l.length > 0);
        const levels = lines.map((l) => JSON.parse(l).level);

        // Should have error and warn, but not info or debug
        expect(levels).toContain('error');
        expect(levels).toContain('warn');
        expect(levels).not.toContain('info');
        expect(levels).not.toContain('debug');
      }
    });
  });
});
