import { readdir, stat, unlink } from 'fs/promises';
import path from 'path';
import { Logger } from './types';

export interface TempFileCleanerConfig {
  tempDir: string;
  cleanerIntervalMs: number;
  maxTempAgeMs: number;
}

export interface TempFileCleaner {
  start(): void;
  stop(): void;
}

export function createTempFileCleaner(
  config: TempFileCleanerConfig,
  logger: Logger
): TempFileCleaner {
  let interval: NodeJS.Timeout | null = null;

  const runCleanup = async (): Promise<void> => {
    try {
      const files = await readdir(config.tempDir);
      const now = Date.now();

      for (const file of files) {
        const filePath = path.join(config.tempDir, file);

        try {
          const stats = await stat(filePath);
          const age = now - stats.mtimeMs;

          if (age > config.maxTempAgeMs) {
            await unlink(filePath);
            logger.debug('Deleted old temp file', { file, ageMs: age });
          }
        } catch (err) {
          const error = err as any;
          if (error.code !== 'ENOENT') {
            logger.error('Failed to process temp file', { file, error: error.message });
          }
        }
      }
    } catch (err) {
      logger.error('Temp file cleaner error', { error: String(err) });
    }
  };

  return {
    start(): void {
      if (interval) return;
      interval = setInterval(runCleanup, config.cleanerIntervalMs);
      logger.info('Temp file cleaner started', { intervalMs: config.cleanerIntervalMs });
    },

    stop(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
        logger.info('Temp file cleaner stopped');
      }
    },
  };
}
