import Redis from 'ioredis';
import { Logger, AntiSpamSystem } from './types';
export interface AntiSpamSystemConfig {
    violationsBeforeBan: number;
    violationWindowMs: number;
    banDurationMs: number;
    banExtensionMs: number;
    maxBanDurationMs: number;
    banExpiryGraceMs: number;
}
export declare function createAntiSpamSystem(redis: Redis | null, config: AntiSpamSystemConfig, logger: Logger): AntiSpamSystem;
//# sourceMappingURL=anti-spam.d.ts.map