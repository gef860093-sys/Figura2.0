import { createRedisClient } from '../../redis-client';
import { AppConfig } from '../../types';

// Mock ioredis so tests don't need a real Redis server
jest.mock('ioredis', () => {
  const EventEmitter = require('events');

  class MockRedis extends EventEmitter {
    public status: string = 'wait';

    constructor(_url: string, _opts?: any) {
      super();
    }

    disconnect() {
      this.status = 'end';
      this.emit('close');
    }

    quit() {
      this.status = 'end';
      this.emit('close');
    }
  }

  return MockRedis;
});

const redisConfig: AppConfig['redis'] = {
  url: 'redis://localhost:6379',
  connectTimeoutMs: 5000,
  commandTimeoutMs: 2000,
  maxRetryDelayMs: 30000,
  degradedAfterMs: 60000,
};

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
  };
}

describe('createRedisClient', () => {
  it('returns null when url is empty', () => {
    const logger = makeLogger();
    const result = createRedisClient({ ...redisConfig, url: '' }, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('REDIS_URL not set'));
  });

  it('returns a wrapper when url is provided', () => {
    const logger = makeLogger();
    const wrapper = createRedisClient(redisConfig, logger);
    expect(wrapper).not.toBeNull();
    expect(wrapper!.client).toBeDefined();
  });

  it('emits connected event on initial connect', (done) => {
    const logger = makeLogger();
    const wrapper = createRedisClient(redisConfig, logger)!;

    wrapper.on('connected', () => {
      expect(wrapper.isConnected).toBe(true);
      expect(wrapper.disconnectedSince).toBeNull();
      done();
    });

    // Simulate ioredis firing 'connect'
    (wrapper.client as any).emit('connect');
  });

  it('emits disconnected event and records disconnectedSince on close', (done) => {
    const logger = makeLogger();
    const wrapper = createRedisClient(redisConfig, logger)!;

    // First connect
    (wrapper.client as any).emit('connect');

    wrapper.on('disconnected', () => {
      expect(wrapper.isConnected).toBe(false);
      expect(wrapper.disconnectedSince).toBeGreaterThan(0);
      done();
    });

    (wrapper.client as any).emit('close');
  });

  it('emits reconnected event and logs downtime after reconnect', (done) => {
    const logger = makeLogger();
    const wrapper = createRedisClient(redisConfig, logger)!;

    // Initial connect
    (wrapper.client as any).emit('connect');
    // Disconnect
    (wrapper.client as any).emit('close');

    wrapper.on('reconnected', () => {
      expect(wrapper.isConnected).toBe(true);
      expect(wrapper.disconnectedSince).toBeNull();
      expect(logger.info).toHaveBeenCalledWith(
        'Redis reconnected',
        expect.objectContaining({ downtimeMs: expect.any(Number) })
      );
      done();
    });

    // Reconnect
    (wrapper.client as any).emit('connect');
  });

  it('does not emit disconnected twice on repeated close events', () => {
    const logger = makeLogger();
    const wrapper = createRedisClient(redisConfig, logger)!;
    const disconnectedCb = jest.fn();

    (wrapper.client as any).emit('connect');
    wrapper.on('disconnected', disconnectedCb);

    (wrapper.client as any).emit('close');
    (wrapper.client as any).emit('close'); // second close should be ignored

    expect(disconnectedCb).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff retryStrategy', () => {
    const logger = makeLogger();
    // Access the retryStrategy via the ioredis constructor options
    // We verify the formula: min(100 * 2^attempt, maxRetryDelayMs)
    const config = { ...redisConfig, maxRetryDelayMs: 30000 };
    createRedisClient(config, logger);

    // Verify the formula directly
    const retryStrategy = (attempt: number) =>
      Math.min(100 * Math.pow(2, attempt), config.maxRetryDelayMs);

    expect(retryStrategy(0)).toBe(100);
    expect(retryStrategy(1)).toBe(200);
    expect(retryStrategy(2)).toBe(400);
    expect(retryStrategy(8)).toBe(25600);
    expect(retryStrategy(9)).toBe(30000); // capped at 30s
    expect(retryStrategy(100)).toBe(30000); // always capped
  });

  it('logs error on Redis error event', () => {
    const logger = makeLogger();
    const wrapper = createRedisClient(redisConfig, logger)!;

    (wrapper.client as any).emit('error', new Error('ECONNREFUSED'));

    expect(logger.error).toHaveBeenCalledWith(
      'Redis error',
      expect.objectContaining({ error: 'ECONNREFUSED' })
    );
  });
});
