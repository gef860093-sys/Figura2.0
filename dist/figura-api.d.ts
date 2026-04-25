/**
 * Figura Backend API
 *
 * Implements the full Figura mod backend API spec:
 * https://github.com/FiguraMC/FiguraRewriteReborn
 *
 * Endpoints:
 *   GET  /figura/v1/motd                    — MOTD message
 *   GET  /figura/v1/version                 — server version info
 *   GET  /figura/v1/limits                  — upload/rate limits
 *   GET  /figura/v1/auth                    — Mojang auth (step 1: get server ID)
 *   GET  /figura/v1/auth/verify             — Mojang auth (step 2: verify + get token)
 *   GET  /figura/v1/user/:uuid              — user profile + equipped avatar hash
 *   GET  /figura/v1/avatar/:uuid            — download avatar binary
 *   PUT  /figura/v1/avatar                  — upload avatar (auth required)
 *   DELETE /figura/v1/avatar               — delete avatar (auth required)
 *   POST /figura/v1/equip                   — equip/unequip avatar (auth required)
 *   GET  /figura/v1/badges/:uuid            — get badges for a user
 *   POST /figura/v1/badges                  — set badges (auth required)
 */
import { Router } from 'express';
import { LRUCache } from './lru-cache';
import { Logger } from './types';
export interface FiguraUserInfo {
    uuid: string;
    hexUuid: string;
    hexUuidBuffer: Buffer;
    username: string;
    usernameLower: string;
    lastSize: number;
    lastAccess: number;
    createdAt: number;
    equippedBadges: {
        special: number[];
        pride: number[];
    };
    activeSockets: Set<any>;
}
export interface FiguraApiConfig {
    avatarsDir: string;
    tempDir: string;
    maxFileSizeBytes: number;
    allowedMimeTypes: string[];
    serverVersion: string;
    enableWhitelist: boolean;
    tokenMaxAgeMs: number;
}
export interface FiguraBroadcastFn {
    (uuid: string, buffer: Buffer): void;
}
export declare function createFiguraRouter(config: FiguraApiConfig, tokens: Map<string, FiguraUserInfo>, serverIds: LRUCache<string, {
    username: string;
    time: number;
}>, hashCache: LRUCache<string, string>, apiJsonCache: LRUCache<string, object>, blacklist: () => Set<string>, whitelist: () => Set<string>, maintenanceMode: () => boolean, broadcastGlobal: FiguraBroadcastFn, uploadPipeline: any, logger: Logger): Router;
//# sourceMappingURL=figura-api.d.ts.map