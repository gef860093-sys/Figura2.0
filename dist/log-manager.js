"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogger = createLogger;
const winston_1 = __importDefault(require("winston"));
const winston_daily_rotate_file_1 = __importDefault(require("winston-daily-rotate-file"));
const zlib_1 = require("zlib");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
/**
 * Creates a logger instance with structured JSON output, daily rotation, size-based rotation,
 * gzip compression, and max-files pruning.
 */
function createLogger(config, requestId) {
    // Ensure log directory exists
    const logDir = config.log.dir;
    // Create Winston logger with DailyRotateFile transport
    // NOTE: do NOT set handleExceptions on the transport AND exceptionHandlers simultaneously —
    // that causes "exitOnError cannot be true with no exception handlers" warning.
    const dailyRotateTransport = new winston_daily_rotate_file_1.default({
        filename: path_1.default.join(logDir, 'app-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: `${config.log.maxFileSizeBytes}b`,
        maxFiles: config.log.maxFiles,
        dirname: logDir,
        auditFile: path_1.default.join(logDir, '.audit.json'),
        // handleExceptions is intentionally NOT set here — handled via exceptionHandlers below
    });
    const winstonLogger = winston_1.default.createLogger({
        level: config.log.level,
        format: winston_1.default.format.combine(winston_1.default.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), winston_1.default.format.json()),
        defaultMeta: requestId ? { requestId } : {},
        transports: [dailyRotateTransport],
        exitOnError: false,
        exceptionHandlers: [
            new winston_1.default.transports.Console({ stderrLevels: ['error'] }),
        ],
    });
    // Add stderr transport as fallback for disk-full errors
    const stderrTransport = new winston_1.default.transports.Stream({
        stream: process.stderr,
        level: 'error',
    });
    // Handle rotation events for compression and pruning
    dailyRotateTransport.on('rotate', (oldFilename, newFilename) => {
        handleRotation(oldFilename, config.log.maxFiles, logDir);
    });
    // Wrap the DailyRotateFile transport to catch disk-full errors
    dailyRotateTransport.on('error', (error) => {
        // On disk-full or other write errors, log to stderr
        if (error.message.includes('ENOSPC') || error.message.includes('disk')) {
            if (stderrTransport.log) {
                stderrTransport.log({
                    level: 'error',
                    message: `Disk write failed: ${error.message}`,
                    timestamp: new Date().toISOString(),
                }, () => { });
            }
        }
    });
    // Return Logger interface implementation
    return {
        error(msg, meta) {
            winstonLogger.error(msg, meta);
        },
        warn(msg, meta) {
            winstonLogger.warn(msg, meta);
        },
        info(msg, meta) {
            winstonLogger.info(msg, meta);
        },
        debug(msg, meta) {
            winstonLogger.debug(msg, meta);
        },
        child(bindings) {
            const childLogger = winstonLogger.child(bindings);
            return {
                error(msg, meta) {
                    childLogger.error(msg, meta);
                },
                warn(msg, meta) {
                    childLogger.warn(msg, meta);
                },
                info(msg, meta) {
                    childLogger.info(msg, meta);
                },
                debug(msg, meta) {
                    childLogger.debug(msg, meta);
                },
                child(bindings) {
                    return this.child(bindings);
                },
                async flush() {
                    return new Promise((resolve) => setTimeout(resolve, 200));
                },
            };
        },
        async flush() {
            // Wait briefly for any buffered writes to drain without closing the stream
            return new Promise((resolve) => setTimeout(resolve, 200));
        },
    };
}
/**
 * Handles log file rotation: compresses rotated files and prunes old files
 */
async function handleRotation(oldFilename, maxFiles, logDir) {
    try {
        // Compress the rotated file
        await compressLogFile(oldFilename);
        // Prune old files if necessary
        await pruneOldFiles(logDir, maxFiles);
    }
    catch (error) {
        // Log compression/pruning errors to stderr
        console.error(`Log rotation error: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Compresses a log file using gzip
 */
async function compressLogFile(filename) {
    const gzipFilename = `${filename}.gz`;
    // Check if file exists
    try {
        await fs_1.promises.access(filename);
    }
    catch {
        // File doesn't exist, skip compression
        return;
    }
    // Create read and write streams
    const readStream = (await Promise.resolve().then(() => __importStar(require('fs')))).createReadStream(filename);
    const writeStream = (await Promise.resolve().then(() => __importStar(require('fs')))).createWriteStream(gzipFilename);
    const gzip = (0, zlib_1.createGzip)();
    // Pipe: read -> gzip -> write
    return new Promise((resolve, reject) => {
        readStream
            .pipe(gzip)
            .pipe(writeStream)
            .on('finish', async () => {
            try {
                // Delete original file after successful compression
                await fs_1.promises.unlink(filename);
                resolve();
            }
            catch (error) {
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
async function pruneOldFiles(logDir, maxFiles) {
    try {
        const files = await fs_1.promises.readdir(logDir);
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
                    await fs_1.promises.unlink(path_1.default.join(logDir, file));
                }
                catch (error) {
                    // Log error but continue with other files
                    console.error(`Failed to delete log file ${file}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    }
    catch (error) {
        // Log pruning errors but don't throw
        console.error(`Failed to prune log files: ${error instanceof Error ? error.message : String(error)}`);
    }
}
//# sourceMappingURL=log-manager.js.map