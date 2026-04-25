"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appConfig = void 0;
exports.loadConfig = loadConfig;
/**
 * Validates and parses an integer from environment variable
 */
function parseIntEnv(value, defaultValue, min, max) {
    if (value === undefined) {
        return defaultValue;
    }
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
        throw new Error(`Invalid integer value: "${value}"`);
    }
    if (min !== undefined && parsed < min) {
        throw new Error(`Value ${parsed} is below minimum ${min}`);
    }
    if (max !== undefined && parsed > max) {
        throw new Error(`Value ${parsed} exceeds maximum ${max}`);
    }
    return parsed;
}
/**
 * Validates and parses a float from environment variable
 */
function parseFloatEnv(value, defaultValue, min, max) {
    if (value === undefined) {
        return defaultValue;
    }
    const parsed = parseFloat(value);
    if (isNaN(parsed)) {
        throw new Error(`Invalid float value: "${value}"`);
    }
    if (min !== undefined && parsed < min) {
        throw new Error(`Value ${parsed} is below minimum ${min}`);
    }
    if (max !== undefined && parsed > max) {
        throw new Error(`Value ${parsed} exceeds maximum ${max}`);
    }
    return parsed;
}
/**
 * Validates and parses a string from environment variable
 */
function parseStringEnv(value, defaultValue, required = false) {
    if (value === undefined) {
        if (required) {
            throw new Error('Required environment variable is missing');
        }
        return defaultValue;
    }
    if (value.trim() === '') {
        if (required) {
            throw new Error('Required environment variable is empty');
        }
        return defaultValue;
    }
    return value;
}
/**
 * Validates and parses a comma-separated list from environment variable
 */
function parseListEnv(value, defaultValue) {
    if (value === undefined) {
        return defaultValue;
    }
    if (value.trim() === '') {
        return defaultValue;
    }
    return value.split(',').map(item => item.trim()).filter(item => item.length > 0);
}
/**
 * Validates log level
 */
function parseLogLevel(value) {
    const level = value || 'info';
    if (!['error', 'warn', 'info', 'debug'].includes(level)) {
        throw new Error(`Invalid log level: "${level}". Must be one of: error, warn, info, debug`);
    }
    return level;
}
/**
 * Loads and validates all environment variables
 * Exits with code 1 if validation fails
 */
function loadConfig() {
    const errors = [];
    try {
        // Get max old space size from Node.js (in MB)
        const maxOldSpaceMb = Math.floor(require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024);
        const config = {
            // Server
            port: parseIntEnv(process.env.PORT, 80, 1, 65535),
            maxOldSpaceMb,
            memoryPressureThreshold: parseFloatEnv(process.env.MEMORY_PRESSURE_THRESHOLD, 0.85, 0, 1),
            // Cache
            cache: {
                maxEntries: parseIntEnv(process.env.CACHE_MAX_ENTRIES, 3000, 1),
                defaultTtlMs: parseIntEnv(process.env.CACHE_DEFAULT_TTL_MS, 3600000, 1),
                staleTtlMs: parseIntEnv(process.env.CACHE_STALE_TTL_MS, 300000, 1),
            },
            // WebSocket
            ws: {
                pingIntervalMs: parseIntEnv(process.env.WS_PING_INTERVAL_MS, 30000, 1),
                pongTimeoutMs: parseIntEnv(process.env.WS_PONG_TIMEOUT_MS, 10000, 1),
                maxConnections: parseIntEnv(process.env.WS_MAX_CONNECTIONS, 10000, 1),
                maxMessageBytes: parseIntEnv(process.env.WS_MAX_MESSAGE_BYTES, 1048576, 1),
                maxMsgRatePerMin: parseIntEnv(process.env.WS_MAX_MSG_RATE_PER_MIN, 50, 1),
            },
            // Upload
            upload: {
                maxFileSizeBytes: parseIntEnv(process.env.UPLOAD_MAX_FILE_SIZE_BYTES, 10485760, 1),
                allowedMimeTypes: parseListEnv(process.env.UPLOAD_ALLOWED_MIME_TYPES, ['application/octet-stream']),
                tempDir: parseStringEnv(process.env.UPLOAD_TEMP_DIR, './avatars_temp'),
                finalDir: parseStringEnv(process.env.UPLOAD_FINAL_DIR, './avatars'),
                cleanerIntervalMs: parseIntEnv(process.env.UPLOAD_CLEANER_INTERVAL_MS, 600000, 1),
                maxTempAgeMs: parseIntEnv(process.env.UPLOAD_MAX_TEMP_AGE_MS, 1800000, 1),
            },
            // Redis
            redis: {
                url: parseStringEnv(process.env.REDIS_URL, 'redis://localhost:6379', false),
                connectTimeoutMs: parseIntEnv(process.env.REDIS_CONNECT_TIMEOUT_MS, 5000, 1),
                commandTimeoutMs: parseIntEnv(process.env.REDIS_COMMAND_TIMEOUT_MS, 2000, 1),
                maxRetryDelayMs: parseIntEnv(process.env.REDIS_MAX_RETRY_DELAY_MS, 30000, 1),
                degradedAfterMs: parseIntEnv(process.env.REDIS_DEGRADED_AFTER_MS, 60000, 1),
            },
            // Rate Limiting
            rateLimit: {
                uploadWindowMs: parseIntEnv(process.env.RATE_LIMIT_UPLOAD_WINDOW_MS, 60000, 1),
                uploadMax: parseIntEnv(process.env.RATE_LIMIT_UPLOAD_MAX, 20, 1),
                apiWindowMs: parseIntEnv(process.env.RATE_LIMIT_API_WINDOW_MS, 60000, 1),
                apiMax: parseIntEnv(process.env.RATE_LIMIT_API_MAX, 300, 1),
                windowResetGraceMs: parseIntEnv(process.env.RATE_LIMIT_WINDOW_RESET_GRACE_MS, 5000, 0),
            },
            // Anti-Spam
            antiSpam: {
                violationsBeforeBan: parseIntEnv(process.env.ANTI_SPAM_VIOLATIONS_BEFORE_BAN, 5, 1),
                violationWindowMs: parseIntEnv(process.env.ANTI_SPAM_VIOLATION_WINDOW_MS, 600000, 1),
                banDurationMs: parseIntEnv(process.env.ANTI_SPAM_BAN_DURATION_MS, 900000, 1),
                banExtensionMs: parseIntEnv(process.env.ANTI_SPAM_BAN_EXTENSION_MS, 900000, 1),
                maxBanDurationMs: parseIntEnv(process.env.ANTI_SPAM_MAX_BAN_DURATION_MS, 86400000, 1),
                banExpiryGraceMs: parseIntEnv(process.env.ANTI_SPAM_BAN_EXPIRY_GRACE_MS, 60000, 0),
            },
            // Shutdown
            shutdown: {
                timeoutMs: parseIntEnv(process.env.SHUTDOWN_TIMEOUT_MS, 30000, 1),
            },
            // Health
            health: {
                refreshIntervalMs: parseIntEnv(process.env.HEALTH_REFRESH_INTERVAL_MS, 15000, 1),
                diskWarnFreeBytes: parseIntEnv(process.env.HEALTH_DISK_WARN_FREE_BYTES, 524288000, 0),
            },
            // Logging
            log: {
                level: parseLogLevel(process.env.LOG_LEVEL),
                maxFileSizeBytes: parseIntEnv(process.env.LOG_MAX_FILE_SIZE_BYTES, 52428800, 1),
                maxFiles: parseIntEnv(process.env.LOG_MAX_FILES, 14, 1),
                dir: parseStringEnv(process.env.LOG_DIR, './logs'),
            },
            // Request timeout
            requestTimeoutMs: parseIntEnv(process.env.REQUEST_TIMEOUT_MS, 30000, 1),
        };
        return Object.freeze(config);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
    }
    if (errors.length > 0) {
        const msg = `Configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`;
        console.error(msg);
        throw new Error(msg);
    }
    // This should never be reached, but TypeScript needs it
    throw new Error('Unreachable');
}
// Export the loaded config — exits with code 1 on validation failure
let appConfig;
try {
    exports.appConfig = appConfig = loadConfig();
}
catch (err) {
    process.exit(1);
    // unreachable — satisfies TS
    exports.appConfig = appConfig = null;
}
//# sourceMappingURL=config.js.map