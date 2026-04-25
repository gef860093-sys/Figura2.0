import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { createGzip } from 'zlib';
import { promises as fs } from 'fs';
import path from 'path';
import { Logger, AppConfig } from './types';

/**
 * Creates a logger instance with structured JSON output, daily rotation, size-based rotation,
 * gzip compression, and max-files pruning.
 */
export function createLogger(config: AppConfig, requestId?: string): Logger {
  // Ensure log directory exists
  const logDir = config.log.dir;

  // Create Winston logger with DailyRotateFile transport
  // NOTE: do NOT set handleExceptions on the transport AND exceptionHandlers simultaneously —
  // that causes "exitOnError cannot be true with no exception handlers" warning.
  const dailyRotateTransport = new DailyRotateFile({
    filename: path.join(logDir, 'app-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: `${config.log.maxFileSizeBytes}b`,
    maxFiles: config.log.maxFiles,
    dirname: logDir,
    auditFile: path.join(logDir, '.audit.json'),
    // handleExceptions is intentionally NOT set here — handled via exceptionHandlers below
  });

  const winstonLogger = winston.createLogger({
    level: config.log.level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.json()
    ),
    defaultMeta: requestId ? { requestId } : {},
    transports: [dailyRotateTransport],
    exitOnError: false,
    exceptionHandlers: [
      new winston.transports.Console({ stderrLevels: ['error'] }),
    ],
  });

  // Add stderr transport as fallback for disk-full errors
  const stderrTransport = new winston.transports.Stream({
    stream: process.stderr,
    level: 'error',
  });

  // Handle rotation events for compression and pruning
  dailyRotateTransport.on('rotate', (oldFilename: string, newFilename: string) => {
    handleRotation(oldFilename, config.log.maxFiles, logDir);
  });

  // Wrap the DailyRotateFile transport to catch disk-full errors
  dailyRotateTransport.on('error', (error: Error) => {
    // On disk-full or other write errors, log to stderr
    if (error.message.includes('ENOSPC') || error.message.includes('disk')) {
      if (stderrTransport.log) {
        stderrTransport.log(
          {
            level: 'error',
            message: `Disk write failed: ${error.message}`,
            timestamp: new Date().toISOString(),
          },
          () => {}
        );
      }
    }
  });

  // Return Logger interface implementation
  return {
    error(msg: string, meta?: object) {
      winstonLogger.error(msg, meta);
    },
    warn(msg: string, meta?: object) {
      winstonLogger.warn(msg, meta);
    },
    info(msg: string, meta?: object) {
      winstonLogger.info(msg, meta);
    },
    debug(msg: string, meta?: object) {
      winstonLogger.debug(msg, meta);
    },
    child(bindings: object): Logger {
      const childLogger = winstonLogger.child(bindings);
      return {
        error(msg: string, meta?: object) {
          childLogger.error(msg, meta);
        },
        warn(msg: string, meta?: object) {
          childLogger.warn(msg, meta);
        },
        info(msg: string, meta?: object) {
          childLogger.info(msg, meta);
        },
        debug(msg: string, meta?: object) {
          childLogger.debug(msg, meta);
        },
        child(bindings: object): Logger {
          return this.child(bindings);
        },
        async flush(): Promise<void> {
          return new Promise((resolve) => setTimeout(resolve, 200));
        },
      };
    },
    async flush(): Promise<void> {
      // Wait briefly for any buffered writes to drain without closing the stream
      return new Promise((resolve) => setTimeout(resolve, 200));
    },
  };
}

/**
 * Handles log file rotation: compresses rotated files and prunes old files
 */
async function handleRotation(
  oldFilename: string,
  maxFiles: number,
  logDir: string
): Promise<void> {
  try {
    // Compress the rotated file
    await compressLogFile(oldFilename);

    // Prune old files if necessary
    await pruneOldFiles(logDir, maxFiles);
  } catch (error) {
    // Log compression/pruning errors to stderr
    console.error(`Log rotation error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Compresses a log file using gzip
 */
async function compressLogFile(filename: string): Promise<void> {
  const gzipFilename = `${filename}.gz`;

  // Check if file exists
  try {
    await fs.access(filename);
  } catch {
    // File doesn't exist, skip compression
    return;
  }

  // Create read and write streams
  const readStream = (await import('fs')).createReadStream(filename);
  const writeStream = (await import('fs')).createWriteStream(gzipFilename);
  const gzip = createGzip();

  // Pipe: read -> gzip -> write
  return new Promise((resolve, reject) => {
    readStream
      .pipe(gzip)
      .pipe(writeStream)
      .on('finish', async () => {
        try {
          // Delete original file after successful compression
          await fs.unlink(filename);
          resolve();
        } catch (error) {
          reject(error);
        }
      })
      .on('error', reject);

    readStream.on('error', reject);
    gzip.on('error', reject);
  });
}

/**
 * Prunes old log files, keeping only maxFiles rotated files
 */
async function pruneOldFiles(logDir: string, maxFiles: number): Promise<void> {
  try {
    const files = await fs.readdir(logDir);

    // Filter log files (app-YYYY-MM-DD.log or app-YYYY-MM-DD.log.gz)
    const logFiles = files
      .filter((f) => f.startsWith('app-') && (f.endsWith('.log') || f.endsWith('.log.gz')))
      .sort()
      .reverse(); // Sort in reverse chronological order

    // Delete files beyond maxFiles limit
    if (logFiles.length > maxFiles) {
      const filesToDelete = logFiles.slice(maxFiles);
      for (const file of filesToDelete) {
        try {
          await fs.unlink(path.join(logDir, file));
        } catch (error) {
          // Log error but continue with other files
          console.error(`Failed to delete log file ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } catch (error) {
    // Log pruning errors but don't throw
    console.error(`Failed to prune log files: ${error instanceof Error ? error.message : String(error)}`);
  }
}
