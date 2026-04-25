import { Server as HttpServer } from 'http';
import { Logger } from './types';
import { WebSocketManager } from './ws-manager';

export interface GracefulShutdownConfig {
  timeoutMs: number;
}

export interface GracefulShutdownHandler {
  /** Express middleware to track in-flight requests */
  middleware: (req: any, res: any, next: any) => void;
  registerHandlers(): void;
}

export function createGracefulShutdownHandler(
  httpServer: HttpServer,
  wsManager: WebSocketManager,
  logger: Logger,
  config: GracefulShutdownConfig,
  flushLogger?: () => Promise<void>
): GracefulShutdownHandler {
  let inFlightRequests = 0;
  let isShuttingDown = false;

  const middleware = (req: any, res: any, next: any): void => {
    inFlightRequests++;
    const decrement = () => {
      inFlightRequests = Math.max(0, inFlightRequests - 1);
    };
    res.on('finish', decrement);
    res.on('close', decrement);
    next();
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info('Shutdown signal received', { signal });

    // 1. Stop accepting new HTTP connections
    httpServer.close();

    // 2. Close all WebSocket connections with code 1001 (Going Away)
    wsManager.closeAll(1001);

    // 3. Wait for in-flight requests to drain (up to timeoutMs)
    const startTime = Date.now();
    while (inFlightRequests > 0) {
      if (Date.now() - startTime >= config.timeoutMs) {
        logger.error('Graceful shutdown timeout — forcibly terminating', { inFlightRequests });
        // 4. Flush logs before exit
        if (flushLogger) {
          try { await flushLogger(); } catch { /* ignore */ }
        }
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // 4. Flush logs
    if (flushLogger) {
      try { await flushLogger(); } catch { /* ignore */ }
    }

    logger.info('Graceful shutdown complete');
    process.exit(0);
  };

  return {
    middleware,
    registerHandlers(): void {
      // Register once — guard against duplicate signal handlers
      process.once('SIGTERM', () => shutdown('SIGTERM'));
      process.once('SIGINT', () => shutdown('SIGINT'));
    },
  };
}

/** Standalone request tracker (for tests and external use) */
export function createRequestTracker() {
  let inFlightRequests = 0;
  return {
    middleware: (req: any, res: any, next: any) => {
      inFlightRequests++;
      const dec = () => { inFlightRequests = Math.max(0, inFlightRequests - 1); };
      res.on('finish', dec);
      res.on('close', dec);
      next();
    },
    getCount: () => inFlightRequests,
  };
}
