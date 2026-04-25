import { Logger, AppConfig } from './types';
/**
 * Creates a logger instance with structured JSON output, daily rotation, size-based rotation,
 * gzip compression, and max-files pruning.
 */
export declare function createLogger(config: AppConfig, requestId?: string): Logger;
//# sourceMappingURL=log-manager.d.ts.map