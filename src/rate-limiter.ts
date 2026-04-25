import rateLimit, { RateLimitRequestHandler, Store, Options, ClientRateLimitInfo } from 'express-rate-limit';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { Logger } from './types';

// ─── In-process fallback store ───────────────────────────────────────────────

interface CounterEntry {
  count: number;
  resetAt: number; // epoch ms when this window resets
}

class InProcessStore implements Store {
  localKeys = true;
  private counters = new Map<string, CounterEntry>();

  constructor(
    private windowMs: number,
    private gracePeriodMs: number,
    private logger: Logger
  ) {}

  increment(key: string): ClientRateLimitInfo {
    const now = Date.now();
    let entry = this.counters.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.counters.set(key, entry);

      // Schedule cleanup after window + grace period
      setTimeout(() => {
        this.counters.delete(key);
      }, this.windowMs + this.gracePeriodMs);
    }

    entry.count++;
    return { totalHits: entry.count, resetTime: new Date(entry.resetAt) };
  }

  decrement(key: string): void {
    const entry = this.counters.get(key);
    if (entry && entry.count > 0) {
      entry.count--;
    }
  }

  resetKey(key: string): void {
    this.counters.delete(key);
  }

  resetAll(): void {
    this.counters.clear();
  }

  /** Exposed for testing */
  get _counters(): Map<string, CounterEntry> {
    return this.counters;
  }
}

// ─── Redis-backed store ───────────────────────────────────────────────────────

class RedisRateLimitStore implements Store {
  localKeys = false;

  constructor(
    private redis: Redis,
    private windowMs: number,
    private gracePeriodMs: number,
    private logger: Logger,
    private fallback: InProcessStore
  ) {}

  async increment(key: string): Promise<ClientRateLimitInfo> {
    try {
      const ttlSeconds = Math.ceil(this.windowMs / 1000);
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, ttlSeconds);
      }
      const ttlRemaining = await this.redis.pttl(key);
      const resetTime =
        ttlRemaining > 0
          ? new Date(Date.now() + ttlRemaining)
          : new Date(Date.now() + this.windowMs);
      return { totalHits: count, resetTime };
    } catch (err) {
      this.logger.warn('Redis rate limit unavailable, falling back to in-process store', {
        key,
        error: String(err),
      });
      return this.fallback.increment(key);
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await this.redis.decr(key);
    } catch (err) {
      this.logger.warn('Redis rate limit decrement failed, using in-process fallback', {
        key,
        error: String(err),
      });
      this.fallback.decrement(key);
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.warn('Redis rate limit reset failed, using in-process fallback', {
        key,
        error: String(err),
      });
      this.fallback.resetKey(key);
    }
  }
}

// ─── Key extraction ───────────────────────────────────────────────────────────

function extractKey(req: Request): string {
  const userInfo = (req as any).userInfo;
  if (userInfo?.uuid) {
    return `user:${userInfo.uuid}`;
  }
  const ip = (req as any).clientIp || req.ip || 'unknown';
  return `ip:${ip}`;
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface RateLimiterConfig {
  uploadWindowMs: number;
  uploadMax: number;
  apiWindowMs: number;
  apiMax: number;
  windowResetGraceMs: number;
}

export interface RateLimiters {
  upload: RateLimitRequestHandler;
  api: RateLimitRequestHandler;
}

export function createRateLimiters(
  redis: Redis | null,
  config: RateLimiterConfig,
  logger: Logger
): RateLimiters {
  const createLimiter = (windowMs: number, max: number): RateLimitRequestHandler => {
    const inProcess = new InProcessStore(windowMs, config.windowResetGraceMs, logger);
    const store: Store = redis
      ? new RedisRateLimitStore(redis, windowMs, config.windowResetGraceMs, logger, inProcess)
      : inProcess;

    return rateLimit({
      windowMs,
      max,
      // Disable built-in headers — we set them manually in the handler
      standardHeaders: false,
      legacyHeaders: false,

      keyGenerator: (req: Request) => extractKey(req),

      handler: (req: Request, res: Response, _next: any, options: Options) => {
        const resetTime: Date =
          (req as any).rateLimit?.resetTime ?? new Date(Date.now() + windowMs);
        const retryAfterSecs = Math.max(
          Math.ceil((resetTime.getTime() - Date.now()) / 1000),
          0
        );

        res.set('Retry-After', String(retryAfterSecs));
        res.set('X-RateLimit-Limit', String(max));
        res.set('X-RateLimit-Remaining', '0');
        res.set('X-RateLimit-Reset', String(Math.floor(resetTime.getTime() / 1000)));
        res.status(429).json({ error: 'Too many requests' });
      },

      store,
    });
  };

  return {
    upload: createLimiter(config.uploadWindowMs, config.uploadMax),
    api: createLimiter(config.apiWindowMs, config.apiMax),
  };
}
