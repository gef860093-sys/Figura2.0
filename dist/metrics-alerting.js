"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMetricsAlerting = createMetricsAlerting;
const axios_1 = __importDefault(require("axios"));
async function sendEmbed(webhookUrl, embed) {
    await axios_1.default.post(webhookUrl, { embeds: [embed] }, { timeout: 10000 });
}
function makeEmbed(title, description, color) {
    const colors = { red: 0xef4444, yellow: 0xeab308, green: 0x22c55e, blue: 0x3b82f6 };
    return { title, description, color: colors[color], timestamp: new Date().toISOString() };
}
// ─── Factory ──────────────────────────────────────────────────────────────────
function createMetricsAlerting(healthMonitor, discordWebhookUrl, logger, config) {
    const cfg = {
        ramThreshold: parseFloat(process.env.ALERT_RAM_THRESHOLD || '0.85'),
        diskWarnFreeBytes: parseInt(process.env.ALERT_DISK_WARN_FREE_BYTES || '524288000', 10),
        redisDownThresholdMs: parseInt(process.env.ALERT_REDIS_DOWN_THRESHOLD_MS || '60000', 10),
        pollIntervalMs: parseInt(process.env.ALERT_POLL_INTERVAL_MS || '30000', 10),
        ...config,
    };
    const state = {
        ramHigh: false,
        diskLow: false,
        redisDown: false,
        redisDownSince: null,
    };
    let interval = null;
    // ── Send helper (no-op when webhook not configured) ──────────────────────
    async function alert(embed) {
        if (!discordWebhookUrl)
            return;
        try {
            await sendEmbed(discordWebhookUrl, embed);
        }
        catch (err) {
            logger.warn('MetricsAlerting: failed to send Discord alert', { error: String(err) });
        }
    }
    // ── Poll ─────────────────────────────────────────────────────────────────
    async function poll() {
        const snap = healthMonitor.getSnapshot();
        const now = Date.now();
        // ── RAM ────────────────────────────────────────────────────────────────
        const heapUsedFraction = snap.memory.heapUsed / snap.memory.heapTotal;
        const ramHigh = heapUsedFraction > cfg.ramThreshold;
        if (ramHigh && !state.ramHigh) {
            state.ramHigh = true;
            const pct = (heapUsedFraction * 100).toFixed(1);
            logger.warn('MetricsAlerting: RAM high', { heapUsedFraction });
            await alert(makeEmbed('⚠️ High RAM Usage', `Heap usage is **${pct}%** (threshold: ${(cfg.ramThreshold * 100).toFixed(0)}%)`, 'yellow'));
        }
        else if (!ramHigh && state.ramHigh) {
            state.ramHigh = false;
            const pct = (heapUsedFraction * 100).toFixed(1);
            logger.info('MetricsAlerting: RAM recovered', { heapUsedFraction });
            await alert(makeEmbed('✅ RAM Usage Recovered', `Heap usage back to **${pct}%**`, 'green'));
        }
        // ── Disk ───────────────────────────────────────────────────────────────
        const diskLow = snap.disk.freeBytes < cfg.diskWarnFreeBytes;
        if (diskLow && !state.diskLow) {
            state.diskLow = true;
            const freeMB = (snap.disk.freeBytes / 1048576).toFixed(0);
            const threshMB = (cfg.diskWarnFreeBytes / 1048576).toFixed(0);
            logger.warn('MetricsAlerting: disk low', { freeBytes: snap.disk.freeBytes });
            await alert(makeEmbed('⚠️ Low Disk Space', `Only **${freeMB} MB** free (threshold: ${threshMB} MB)`, 'yellow'));
        }
        else if (!diskLow && state.diskLow) {
            state.diskLow = false;
            const freeMB = (snap.disk.freeBytes / 1048576).toFixed(0);
            logger.info('MetricsAlerting: disk recovered', { freeBytes: snap.disk.freeBytes });
            await alert(makeEmbed('✅ Disk Space Recovered', `Disk free space back to **${freeMB} MB**`, 'green'));
        }
        // ── Redis ──────────────────────────────────────────────────────────────
        const redisConnected = snap.redis.status === 'healthy';
        if (!redisConnected) {
            if (state.redisDownSince === null) {
                state.redisDownSince = now;
            }
            const downMs = now - state.redisDownSince;
            if (downMs >= cfg.redisDownThresholdMs && !state.redisDown) {
                state.redisDown = true;
                const downSec = Math.floor(downMs / 1000);
                logger.warn('MetricsAlerting: Redis down', { downMs });
                await alert(makeEmbed('🔴 Redis Disconnected', `Redis has been unreachable for **${downSec}s** (threshold: ${cfg.redisDownThresholdMs / 1000}s)`, 'red'));
            }
        }
        else {
            if (state.redisDown) {
                state.redisDown = false;
                logger.info('MetricsAlerting: Redis reconnected');
                await alert(makeEmbed('✅ Redis Reconnected', 'Redis connection has been restored.', 'green'));
            }
            state.redisDownSince = null;
        }
    }
    // ── Public API ────────────────────────────────────────────────────────────
    return {
        start() {
            if (interval)
                return;
            // Run first poll after one interval (health monitor needs a moment to warm up)
            interval = setInterval(() => {
                poll().catch((err) => logger.error('MetricsAlerting: poll error', { error: String(err) }));
            }, cfg.pollIntervalMs);
            logger.info('MetricsAlerting started', { pollIntervalMs: cfg.pollIntervalMs });
        },
        stop() {
            if (interval) {
                clearInterval(interval);
                interval = null;
                logger.info('MetricsAlerting stopped');
            }
        },
    };
}
//# sourceMappingURL=metrics-alerting.js.map