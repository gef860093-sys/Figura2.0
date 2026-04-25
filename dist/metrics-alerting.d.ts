import { HealthMonitor } from './health-monitor';
import { Logger } from './types';
export interface MetricsAlertingConfig {
    /** Fraction of max heap that triggers a RAM alert (default 0.85) */
    ramThreshold: number;
    /** Disk free bytes below which a disk alert fires (default 500 MB) */
    diskWarnFreeBytes: number;
    /** How long Redis must be disconnected before alerting (ms, default 60 000) */
    redisDownThresholdMs: number;
    /** How often to poll the health monitor (ms, default 30 000) */
    pollIntervalMs: number;
}
export interface MetricsAlerting {
    start(): void;
    stop(): void;
}
export declare function createMetricsAlerting(healthMonitor: HealthMonitor, discordWebhookUrl: string | undefined, logger: Logger, config?: Partial<MetricsAlertingConfig>): MetricsAlerting;
//# sourceMappingURL=metrics-alerting.d.ts.map