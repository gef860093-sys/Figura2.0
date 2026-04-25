import { Logger, RedisClientWrapper, HealthSnapshot } from './types';
import { WebSocketManager } from './ws-manager';
import { UploadPipelineHandle } from './upload-pipeline';
export interface HealthMonitorConfig {
    refreshIntervalMs: number;
    diskWarnFreeBytes: number;
    maxOldSpaceBytes: number;
    memoryPressureThreshold: number;
    uploadDir: string;
    degradedAfterMs: number;
}
export interface HealthMonitor {
    start(): Promise<void>;
    stop(): void;
    getSnapshot(): HealthSnapshot;
}
export declare function createHealthMonitor(config: HealthMonitorConfig, redisWrapper: RedisClientWrapper | null, wsManager: WebSocketManager, uploadPipeline: UploadPipelineHandle, logger: Logger): HealthMonitor;
//# sourceMappingURL=health-monitor.d.ts.map