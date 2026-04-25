import { loadConfig } from '../../config';

describe('Config Validator', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('loadConfig', () => {
    it('should load config with all defaults when no env vars are set', () => {
      // Clear all relevant env vars
      Object.keys(process.env).forEach(key => {
        if (key.startsWith('PORT') || key.startsWith('CACHE_') || key.startsWith('WS_') ||
            key.startsWith('UPLOAD_') || key.startsWith('REDIS_') || key.startsWith('RATE_LIMIT_') ||
            key.startsWith('ANTI_SPAM_') || key.startsWith('SHUTDOWN_') || key.startsWith('HEALTH_') ||
            key.startsWith('LOG_') || key.startsWith('REQUEST_') || key.startsWith('MEMORY_')) {
          delete process.env[key];
        }
      });

      const config = loadConfig();

      expect(config.port).toBe(80);
      expect(config.cache.maxEntries).toBe(3000);
      expect(config.cache.defaultTtlMs).toBe(3600000);
      expect(config.cache.staleTtlMs).toBe(300000);
      expect(config.ws.pingIntervalMs).toBe(30000);
      expect(config.ws.pongTimeoutMs).toBe(10000);
      expect(config.ws.maxConnections).toBe(10000);
      expect(config.ws.maxMessageBytes).toBe(1048576);
      expect(config.ws.maxMsgRatePerMin).toBe(50);
      expect(config.upload.maxFileSizeBytes).toBe(10485760);
      expect(config.upload.allowedMimeTypes).toEqual(['application/octet-stream']);
      expect(config.upload.tempDir).toBe('./avatars_temp');
      expect(config.upload.finalDir).toBe('./avatars');
      expect(config.upload.cleanerIntervalMs).toBe(600000);
      expect(config.upload.maxTempAgeMs).toBe(1800000);
      expect(config.redis.url).toBe('redis://localhost:6379');
      expect(config.redis.connectTimeoutMs).toBe(5000);
      expect(config.redis.commandTimeoutMs).toBe(2000);
      expect(config.redis.maxRetryDelayMs).toBe(30000);
      expect(config.redis.degradedAfterMs).toBe(60000);
      expect(config.rateLimit.uploadWindowMs).toBe(60000);
      expect(config.rateLimit.uploadMax).toBe(20);
      expect(config.rateLimit.apiWindowMs).toBe(60000);
      expect(config.rateLimit.apiMax).toBe(300);
      expect(config.rateLimit.windowResetGraceMs).toBe(5000);
      expect(config.antiSpam.violationsBeforeBan).toBe(5);
      expect(config.antiSpam.violationWindowMs).toBe(600000);
      expect(config.antiSpam.banDurationMs).toBe(900000);
      expect(config.antiSpam.banExtensionMs).toBe(900000);
      expect(config.antiSpam.maxBanDurationMs).toBe(86400000);
      expect(config.antiSpam.banExpiryGraceMs).toBe(60000);
      expect(config.shutdown.timeoutMs).toBe(30000);
      expect(config.health.refreshIntervalMs).toBe(15000);
      expect(config.health.diskWarnFreeBytes).toBe(524288000);
      expect(config.log.level).toBe('info');
      expect(config.log.maxFileSizeBytes).toBe(52428800);
      expect(config.log.maxFiles).toBe(14);
      expect(config.log.dir).toBe('./logs');
      expect(config.requestTimeoutMs).toBe(30000);
    });

    it('should override defaults with env vars', () => {
      process.env.PORT = '3000';
      process.env.CACHE_MAX_ENTRIES = '5000';
      process.env.WS_PING_INTERVAL_MS = '60000';
      process.env.LOG_LEVEL = 'debug';

      const config = loadConfig();

      expect(config.port).toBe(3000);
      expect(config.cache.maxEntries).toBe(5000);
      expect(config.ws.pingIntervalMs).toBe(60000);
      expect(config.log.level).toBe('debug');
    });

    it('should parse comma-separated MIME types', () => {
      process.env.UPLOAD_ALLOWED_MIME_TYPES = 'image/png,image/jpeg,image/gif';

      const config = loadConfig();

      expect(config.upload.allowedMimeTypes).toEqual(['image/png', 'image/jpeg', 'image/gif']);
    });

    it('should validate port range', () => {
      process.env.PORT = '99999';

      expect(() => loadConfig()).toThrow();
    });

    it('should validate memory pressure threshold range', () => {
      process.env.MEMORY_PRESSURE_THRESHOLD = '1.5';

      expect(() => loadConfig()).toThrow();
    });

    it('should validate log level', () => {
      process.env.LOG_LEVEL = 'invalid';

      expect(() => loadConfig()).toThrow();
    });

    it('should validate positive integers', () => {
      process.env.CACHE_MAX_ENTRIES = '-100';

      expect(() => loadConfig()).toThrow();
    });

    it('should freeze the config object', () => {
      const config = loadConfig();

      expect(() => {
        (config as any).port = 9000;
      }).toThrow();
    });

    it('should throw on validation error with descriptive message', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      process.env.PORT = 'invalid';

      expect(() => loadConfig()).toThrow('Configuration validation failed');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Configuration validation failed')
      );

      consoleErrorSpy.mockRestore();
    });
  });
});
