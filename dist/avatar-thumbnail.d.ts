/**
 * Avatar Thumbnail / Preview
 *
 * Generates metadata previews for .moon avatar files (no image processing).
 *
 * Routes (registered in server.ts):
 *   GET /api/:uuid/preview          → JSON metadata preview
 *   GET /figura/v1/avatar/:uuid/preview → same
 *   GET /api/:uuid/card             → plain-text "card"
 */
import { Router } from 'express';
export interface AvatarPreview {
    uuid: string;
    hash: string;
    sizeBytes: number;
    uploadedAt: string;
    versions: number;
}
export declare function createAvatarThumbnailRouter(avatarsDir: string, versionsDir: string, hashCache: {
    get(k: string): string | undefined;
    set(k: string, v: string): void;
}): Router;
//# sourceMappingURL=avatar-thumbnail.d.ts.map