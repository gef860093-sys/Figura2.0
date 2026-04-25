import Redis from 'ioredis';
import { AppConfig, Logger, RedisClientWrapper } from './types';

type RedisEvent = 'connected' | 'disconnected' | 'reconnected';

/**
 * Creates a Redis client wrapper with exponential backoff reconnect,
 * connection/command timeouts, and lifecycle event emission.
 *
 * Returns null if REDIS_URL is not set (single-node fallback mode).
 */
export function createRedisClient(
  redisConfig: AppConfig['redis'],
  logger: Logger
): RedisClientWrapper | null {
  if (!redisConfig.url) {
    logger.warn('REDIS_URL not set — running in single-node fallback mode (no Redis)');
    return null;
  }

  let disconnectedAt: number | null = null;
  let _isConnected = false;

  const listeners: Record<RedisEvent, Array<() => void>> = {
    connected: [],
    disconnected: [],
    reconnected: [],
  };

  function emit(event: RedisEvent): void {
    for (const cb of listeners[event]) {
      try {
        cb();
      } catch (err) {
        logger.error('Redis event listener threw', { event, error: String(err) });
      }
    }
  }

  const client = new Redis(redisConfig.url, {
    connectTimeout: redisConfig.connectTimeoutMs,
    commandTimeout: redisConfig.commandTimeoutMs,
    // Disable the per-request retry limit so reconnect strategy drives retries
    maxRetriesPerRequest: null,
    retryStrategy: (attempt: number) =>
      Math.min(100 * Math.pow(2, attempt), redisConfig.maxRetryDelayMs),
    enableOfflineQueue: true,
    lazyConnect: false,
  });

  // 'connect' fires when the TCP connection is established and AUTH/SELECT succeed
  client.on('connect', () => {
    const wasDisconnected = disconnectedAt !== null;
    _isConnected = true;

    if (wasDisconnected) {
      const downtimeMs = Date.now() - disconnectedAt!;
      disconnectedAt = null;
      logger.info('Redis reconnected', { downtimeMs });
      emit('reconnected');
    } else {
      disconnectedAt = null;
      logger.info('Redis connected');
      emit('connected');
    }
  });

  // 'close' fires when the connection is fully closed (after disconnect/error)
  client.on('close', () => {
    if (_isConnected) {
      _isConnected = false;
      disconnectedAt = Date.now();
      logger.warn('Redis disconnected');
      emit('disconnected');
    }
  });

  // 'error' fires on connection errors; also mark as disconnected if not already
  client.on('error', (err: Error) => {
    logger.error('Redis error', { error: err.message });
    if (_isConnected) {
      _isConnected = false;
      if (disconnectedAt === null) {
        disconnectedAt = Date.now();
        emit('disconnected');
      }
    }
  });

  const wrapper: RedisClientWrapper = {
    get client(): Redis {
      return client;
    },
    get isConnected(): boolean {
      return _isConnected;
    },
    get disconnectedSince(): number | null {
      return disconnectedAt;
    },
    on(event: RedisEvent, cb: () => void): void {
      listeners[event].push(cb);
    },
  };

  return wrapper;
}
