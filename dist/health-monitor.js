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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHealthMonitor = createHealthMonitor;
const process_1 = require("process");
const os_1 = require("os");
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
/**
 * Attempts to get free bytes for the given path.
 * Uses fs.promises.statfs (Node >= 19). Falls back to `df` on older Node,
 * and if that also fails, returns null (caller marks disk as healthy).
 */
async function getDiskFreeBytes(path) {
    // fs.promises.statfs is available in Node >= 19
    if (typeof fs.promises.statfs === 'function') {
        try {
            const stats = await fs.promises.statfs(path);
            return stats.bavail * stats.bsize;
        }
        catch {
            // fall through to df fallback
        }
    }
    // Fallback: parse `df -k <path>` output
    try {
        const { stdout } = await execFileAsync('df', ['-k', path]);
        const lines = stdout.trim().split('\n');
        // df output: Filesystem 1K-blocks Used Available Use% Mounted
        const parts = lines[lines.length - 1].split(/\s+/);
        const availableKb = parseInt(parts[3], 10);
        if (!isNaN(availableKb)) {
            return availableKb * 1024;
        }
    }
    catch {
        // fall through
    }
    return null;
}
function createHealthMonitor(config, redisWrapper, wsManager, uploadPipeline, logger) {
    let interval = null;
    let snapshot = null;
    const refresh = async () => {
        try {
            const mem = (0, process_1.memoryUsage)();
            const now = Date.now();
            // Check memory pressure
            const heapUsedPercent = mem.heapUsed / config.maxOldSpaceBytes;
            if (heapUsedPercent > config.memoryPressureThreshold) {
                logger.warn('Memory pressure detected', { heapUsedPercent });
            }
            // Check disk
            let diskFreeBytes = 0;
            let diskStatus = 'healthy';
            try {
                const freeBytes = await getDiskFreeBytes(config.uploadDir);
                if (freeBytes === null) {
                    // statfs not available and df failed — assume healthy
                    diskFreeBytes = config.diskWarnFreeBytes; // sentinel: treat as at threshold
                }
                else {
                    diskFreeBytes = freeBytes;
                    if (diskFreeBytes < config.diskWarnFreeBytes) {
                        diskStatus = 'degraded';
                    }
                }
            }
            catch (err) {
                logger.error('Failed to check disk space', { error: String(err) });
                diskStatus = 'degraded';
            }
            // Check Redis
            let redisStatus = 'healthy';
            let redisLatencyMs = 0;
            if (redisWrapper) {
                if (!redisWrapper.isConnected) {
                    if (redisWrapper.disconnectedSince !== null &&
                        now - redisWrapper.disconnectedSince > config.degradedAfterMs) {
                        redisStatus = 'degraded';
                    }
                    else {
                        redisStatus = 'unhealthy';
                    }
                }
                else {
                    // Measure latency
                    const startTime = Date.now();
                    try {
                        await redisWrapper.client.ping();
                        redisLatencyMs = Date.now() - startTime;
                    }
                    catch (err) {
                        logger.error('Redis PING failed', { error: String(err) });
                        redisStatus = 'unhealthy';
                    }
                }
            }
            // Determine overall status
            let overallStatus = 'healthy';
            if (diskStatus === 'degraded' || redisStatus === 'degraded') {
                overallStatus = 'degraded';
            }
            if (redisStatus === 'unhealthy') {
                overallStatus = 'unhealthy';
            }
            snapshot = {
                status: overallStatus,
                uptime: (0, process_1.uptime)(),
                timestamp: new Date().toISOString(),
                memory: {
                    heapUsed: mem.heapUsed,
                    heapTotal: mem.heapTotal,
                },
                cpu: {
                    loadAvg: (0, os_1.loadavg)(),
                },
                disk: {
                    freeBytes: diskFreeBytes,
                    status: diskStatus,
                },
                redis: {
                    status: redisStatus,
                    latencyMs: redisLatencyMs,
                },
                websocket: {
                    activeConnections: wsManager.connectionCount,
                },
                upload: {
                    pendingCount: uploadPipeline.pendingCount,
                },
            };
        }
        catch (err) {
            logger.error('Health monitor refresh failed', { error: String(err) });
        }
    };
    return {
        async start() {
            if (interval)
                return;
            await refresh(); // Initial refresh — await so first snapshot is ready
            interval = setInterval(refresh, config.refreshIntervalMs);
            logger.info('Health monitor started', { intervalMs: config.refreshIntervalMs });
        },
        stop() {
            if (interval) {
                clearInterval(interval);
                interval = null;
                logger.info('Health monitor stopped');
            }
        },
        getSnapshot() {
            return (snapshot || {
                status: 'unhealthy',
                uptime: (0, process_1.uptime)(),
                timestamp: new Date().toISOString(),
                memory: { heapUsed: 0, heapTotal: 0 },
                cpu: { loadAvg: [0, 0, 0] },
                disk: { freeBytes: 0, status: 'degraded' },
                redis: { status: 'unhealthy', latencyMs: 0 },
                websocket: { activeConnections: 0 },
                upload: { pendingCount: 0 },
            });
        },
    };
}
//# sourceMappingURL=health-monitor.js.map