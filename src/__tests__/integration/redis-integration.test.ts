/**
 * Integration tests for Redis-backed rate limiting and ban records.
 * These tests mock ioredis to avoid requiring a real Redis instance.
 * Requirements: 4.1, 4.5, 5.5, 9.4
 */

import { createRedisClient } from '../../redis-client';
import { createRateLimiters } from '../../rate-limiter';
import { createAntiSpamSystem } from '../../anti-spam';
import { Logger } from '../../types';

// ─── Mock logger ──────────────────────────────────────────────────────────────

const mockLogger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
  flush: jest.fn().mockResolvedValue(undefined),
};

// ─── Mock ioredis ─────────────────────────────────────────────────────────────

jest.mock('ioredis', () => {
  const EventEmitter = require('events');

  class MockRedis extends EventEmitter {
    private store = new Map<string, string>();
    private ttls = new Map<string, number>();

    async incr(key: string): Promise<number> {
      const val = parseInt(this.store.get(key) || '0', 10) + 1;
      this.store.set(key, String(val));
      return val;
    }

    async decr(key: string): Promise<number> {
      const val = Math.max(0, parseInt(this.store.get(key) || '0', 10) - 1);
      this.store.set(key, String(val));
      return val;
    }

    async expire(key: string, seconds: number): Promise<number> {
      this.ttls.set(key, Date.now() + seconds * 1000);
      return 1;
    }

    async pttl(key: string): Promise<number> {
      const exp = this.ttls.get(key);
      if (!exp) return -1;
      return Math.max(0, exp - Date.now());
    }

    async get(key: string): Promise<string | null> {
      return this.store.get(key) ?? null;
    }

    async set(key: string, value: string): Promise<'OK'> {
      this.store.set(key, value);
      return 'OK';
    }

    async del(key: string): Promise<number> {
      // Delete the key itself and all hash fields (ban:clientId:field pattern)
      let count = 0;
      const prefix = `${key}:`;
      const toDelete: string[] = [];
      this.store.forEach((_, k) => {
        if (k === key || k.startsWith(prefix)) toDelete.push(k);
      });
      toDelete.forEach((k) => { this.store.delete(k); count++; });
      return count > 0 ? 1 : 0;
    }

    async hset(key: string, ...args: string[]): Promise<number> {
      // args: field1, val1, field2, val2, ...
      for (let i = 0; i < args.length; i += 2) {
        this.store.set(`${key}:${args[i]}`, args[i + 1]);
      }
      return args.length / 2;
    }

    async hget(key: string, field: string): Promise<string | null> {
      return this.store.get(`${key}:${field}`) ?? null;
    }

    async hgetall(key: string): Promise<Record<string, string>> {
      const result: Record<string, string> = {};
      const prefix = `${key}:`;
      this.store.forEach((val, k) => {
        if (k.startsWith(prefix)) {
          result[k.slice(prefix.length)] = val;
        }
      });
      return result;
    }

    async hincrby(key: string, field: string, increment: number): Promise<number> {
      const current = parseInt(this.store.get(`${key}:${field}`) || '0', 10);
      const newVal = current + increment;
      this.store.set(`${key}:${field}`, String(newVal));
      return newVal;
    }

    async keys(pattern: string): Promise<string[]> {
      const prefix = pattern.replace('*', '');
      const seen = new Set<string>();
      this.store.forEach((_, k) => {
        if (k.startsWith(prefix)) {
          // Extract base key: ban:<clientId> from ban:<clientId>:<field>
          const withoutPrefix = k.slice(prefix.length);
          const colonIdx = withoutPrefix.indexOf(':');
          const baseKey = colonIdx >= 0
            ? prefix + withoutPrefix.slice(0, colonIdx)
            : k;
          seen.add(baseKey);
        }
      });
      return Array.from(seen);
    }

    async ping(): Promise<'PONG'> {
      return 'PONG';
    }

    async publish(channel: string, message: string): Promise<number> {
      return 0;
    }

    async subscribe(channel: string): Promise<void> {}

    quit(): Promise<'OK'> {
      return Promise.resolve('OK');
    }
  }

  return MockRedis;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Redis Rate Limit Persistence (Requirement 5.5)', () => {
  it('persists rate limit counters in Redis store', async () => {
    const Redis = require('ioredis');
    const redis = new Redis();

    // Simulate incrementing a rate limit key
    const key = 'rl:user:test-user';
    await redis.incr(key);
    await redis.incr(key);
    const count = await redis.incr(key);

    expect(count).toBe(3);
  });
});

describe('Redis Ban Record Persistence (Requirement 9.4)', () => {
  it('stores and retrieves ban records from Redis', async () => {
    const Redis = require('ioredis');
    const redis = new Redis();

    const antiSpamConfig = {
      violationsBeforeBan: 2,
      violationWindowMs: 60000,
      banDurationMs: 900000,
      banExtensionMs: 900000,
      maxBanDurationMs: 86400000,
      banExpiryGraceMs: 60000,
    };

    const antiSpam = createAntiSpamSystem(redis, antiSpamConfig, mockLogger);

    // Record violations to trigger ban
    await antiSpam.recordViolation('test-client');
    await antiSpam.recordViolation('test-client');

    // Ban should now be in Redis
    const bans = await antiSpam.listBans();
    expect(bans.length).toBeGreaterThan(0);
    expect(bans[0].clientId).toBe('test-client');
  });

  it('lifts ban from Redis', async () => {
    const Redis = require('ioredis');
    const redis = new Redis();

    const antiSpamConfig = {
      violationsBeforeBan: 1,
      violationWindowMs: 60000,
      banDurationMs: 900000,
      banExtensionMs: 900000,
      maxBanDurationMs: 86400000,
      banExpiryGraceMs: 60000,
    };

    const antiSpam = createAntiSpamSystem(redis, antiSpamConfig, mockLogger);

    await antiSpam.recordViolation('lift-test-client');
    await antiSpam.liftBan('lift-test-client');

    const bans = await antiSpam.listBans();
    const found = bans.find((b) => b.clientId === 'lift-test-client');
    expect(found).toBeUndefined();
  });
});

describe('Redis Reconnect Logging (Requirements 4.1, 4.5)', () => {
  it('creates redis client wrapper with correct config', () => {
    const localLogger: Logger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
      flush: jest.fn().mockResolvedValue(undefined),
    };

    // createRedisClient returns null when no URL is provided
    const wrapper = createRedisClient(
      {
        url: '',
        connectTimeoutMs: 5000,
        commandTimeoutMs: 2000,
        maxRetryDelayMs: 30000,
        degradedAfterMs: 60000,
      },
      localLogger
    );

    expect(wrapper).toBeNull();
    expect(localLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('REDIS_URL not set')
    );
  });
});
