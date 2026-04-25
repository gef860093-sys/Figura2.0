import { Server as HttpServer } from 'http';
import { Logger } from './types';
import { WebSocketManager } from './ws-manager';
export interface GracefulShutdownConfig {
    timeoutMs: number;
}
export interface GracefulShutdownHandler {
    /** Express middleware to track in-flight requests */
    middleware: (req: any, res: any, next: any) => void;
    registerHandlers(): void;
}
export declare function createGracefulShutdownHandler(httpServer: HttpServer, wsManager: WebSocketManager, logger: Logger, config: GracefulShutdownConfig, flushLogger?: () => Promise<void>): GracefulShutdownHandler;
/** Standalone request tracker (for tests and external use) */
export declare function createRequestTracker(): {
    middleware: (req: any, res: any, next: any) => void;
    getCount: () => number;
};
//# sourceMappingURL=graceful-shutdown.d.ts.map