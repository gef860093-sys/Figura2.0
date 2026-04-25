import { Request, Response, RequestHandler } from 'express';
import Redis from 'ioredis';
import { Logger, BanRecord, AntiSpamSystem } from './types';

export interface AntiSpamSystemConfig {
  violationsBeforeBan: number;
  violationWindowMs: number;
  banDurationMs: number;
  banExtensionMs: number;
  maxBanDurationMs: number;
  banExpiryGraceMs: number;
}

class InProcessBanStore {
  private bans = new Map<string, BanRecord & { createdAt: number }>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    private config: AntiSpamSystemConfig,
    private logger: Logger
  ) {}

  start(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const expired: string[] = [];

      this.bans.forEach((ban, clientId) => {
        if (now > ban.expiresAt) {
          expired.push(clientId);
        }
      });

      expired.forEach((clientId) => {
        this.bans.delete(clientId);
        this.logger.debug('Ban expired', { clientId });
      });
    }, this.config.banExpiryGraceMs);
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  async recordViolation(clientId: string): Promise<void> {
    const now = Date.now();
    const ban = this.bans.get(clientId);

    if (ban && now < ban.expiresAt) {
      // Extend ban
      ban.expiresAt = Math.min(
        ban.expiresAt + this.config.banExtensionMs,
        ban.createdAt + this.config.maxBanDurationMs
      );
      ban.violations++;
    } else {
      // Create new ban
      this.bans.set(clientId, {
        clientId,
        expiresAt: now + this.config.banDurationMs,
        violations: 1,
        createdAt: now,
      });
    }
  }

  async getBan(clientId: string): Promise<(BanRecord & { createdAt: number }) | null> {
    const ban = this.bans.get(clientId);
    if (!ban) return null;

    const now = Date.now();
    if (now > ban.expiresAt) {
      this.bans.delete(clientId);
      return null;
    }

    return ban;
  }

  async listBans(): Promise<(BanRecord & { createdAt: number })[]> {
    const now = Date.now();
    const result: (BanRecord & { createdAt: number })[] = [];

    this.bans.forEach((ban) => {
      if (now < ban.expiresAt) {
        result.push(ban);
      }
    });

    return result;
  }

  async liftBan(clientId: string): Promise<void> {
    this.bans.delete(clientId);
  }
}

class RedisBanStore {
  // RedisBanStore does not need a start() method because Redis handles
  // key expiry natively via TTL — no in-process cleanup loop is required.
  constructor(
    private redis: Redis,
    private config: AntiSpamSystemConfig,
    private logger: Logger
  ) {}

  async recordViolation(clientId: string): Promise<void> {
    const key = `ban:${clientId}`;
    const now = Date.now();

    try {
      const existing = await this.redis.hgetall(key);

      if (existing && existing.expiresAt) {
        const expiresAt = parseInt(existing.expiresAt, 10);
        if (now < expiresAt) {
          // Extend ban
          const newExpiresAt = Math.min(
            expiresAt + this.config.banExtensionMs,
            parseInt(existing.createdAt, 10) + this.config.maxBanDurationMs
          );
          await this.redis.hset(key, 'expiresAt', newExpiresAt);
          await this.redis.hincrby(key, 'violations', 1);
          await this.redis.expire(key, Math.ceil(this.config.maxBanDurationMs / 1000));
          return;
        }
      }

      // Create new ban
      await this.redis.hset(
        key,
        'clientId',
        clientId,
        'expiresAt',
        now + this.config.banDurationMs,
        'violations',
        1,
        'createdAt',
        now
      );
      await this.redis.expire(key, Math.ceil(this.config.banDurationMs / 1000));
    } catch (err) {
      this.logger.error('Redis ban record failed', { error: String(err) });
      throw err;
    }
  }

  async getBan(clientId: string): Promise<(BanRecord & { createdAt: number }) | null> {
    const key = `ban:${clientId}`;

    try {
      const data = await this.redis.hgetall(key);
      if (!data || !data.expiresAt) return null;

      const expiresAt = parseInt(data.expiresAt, 10);
      if (Date.now() > expiresAt) {
        await this.redis.del(key);
        return null;
      }

      return {
        clientId,
        expiresAt,
        violations: parseInt(data.violations, 10) || 0,
        createdAt: parseInt(data.createdAt, 10) || Date.now(),
      };
    } catch (err) {
      this.logger.error('Redis get ban failed', { error: String(err) });
      throw err;
    }
  }

  async listBans(): Promise<(BanRecord & { createdAt: number })[]> {
    try {
      const keys = await this.redis.keys('ban:*');
      const result: (BanRecord & { createdAt: number })[] = [];

      for (const key of keys) {
        const data = await this.redis.hgetall(key);
        if (data && data.expiresAt) {
          const expiresAt = parseInt(data.expiresAt, 10);
          if (Date.now() < expiresAt) {
            result.push({
              clientId: data.clientId,
              expiresAt,
              violations: parseInt(data.violations, 10) || 0,
              createdAt: parseInt(data.createdAt, 10) || Date.now(),
            });
          }
        }
      }

      return result;
    } catch (err) {
      this.logger.error('Redis list bans failed', { error: String(err) });
      throw err;
    }
  }

  async liftBan(clientId: string): Promise<void> {
    try {
      await this.redis.del(`ban:${clientId}`);
    } catch (err) {
      this.logger.error('Redis lift ban failed', { error: String(err) });
    }
  }
}

export function createAntiSpamSystem(
  redis: Redis | null,
  config: AntiSpamSystemConfig,
  logger: Logger
): AntiSpamSystem {
  const store = redis ? new RedisBanStore(redis, config, logger) : new InProcessBanStore(config, logger);

  // Only InProcessBanStore needs start() — RedisBanStore relies on Redis TTL for cleanup.
  if (!redis && store instanceof InProcessBanStore) {
    store.start();
  }

  const violationCounts = new Map<string, { count: number; resetAt: number }>();

  // Lazily remove stale violation entries to prevent unbounded memory growth.
  const getOrCreateEntry = (clientId: string, now: number): { count: number; resetAt: number } => {
    const existing = violationCounts.get(clientId);
    if (!existing || now >= existing.resetAt) {
      const entry = { count: 0, resetAt: now + config.violationWindowMs };
      violationCounts.set(clientId, entry);
      return entry;
    }
    return existing;
  };

  const middleware = (): RequestHandler => {
    return async (req: Request, res: Response, next) => {
      const clientId = (req as any).userInfo?.uuid || req.ip || 'unknown';

      try {
        const ban = await store.getBan(clientId);

        if (ban) {
          const retryAfter = Math.ceil((ban.expiresAt - Date.now()) / 1000);
          res.set('Retry-After', String(retryAfter));
          res.status(403).json({ error: 'Client banned' });

          // Extend ban on continued requests while banned
          await store.recordViolation(clientId);
          return;
        }
      } catch (err) {
        logger.error('Anti-spam check failed', { error: String(err) });
      }

      next();
    };
  };

  const recordViolation = async (clientId: string): Promise<void> => {
    const now = Date.now();
    const entry = getOrCreateEntry(clientId, now);

    entry.count++;

    // Only call store.recordViolation when the threshold is crossed for the FIRST time
    // (count equals exactly violationsBeforeBan). Subsequent violations while already
    // banned are handled by the ban-extension logic inside store.recordViolation, which
    // is triggered by the middleware when a banned client keeps sending requests.
    if (entry.count === config.violationsBeforeBan) {
      try {
        await store.recordViolation(clientId);
        logger.warn('Client banned', { clientId, violations: entry.count });
      } catch (err) {
        logger.error('Failed to record ban', { error: String(err) });
      }
    }
  };

  return {
    middleware,
    recordViolation,
    listBans: () => store.listBans(),
    liftBan: (clientId: string) => store.liftBan(clientId),
  };
}
