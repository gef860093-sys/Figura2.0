import { LRUCache } from './lru-cache';
export interface AvatarPreview {
    uuid: string;
    hash: string | null;
    sizeBytes: number;
    sizeMB: string;
    uploadedAt: string | null;
    versions: number;
    hasAvatar: boolean;
}
export declare function getAvatarPreview(uuid: string, avatarsDir: string, versionsDir: string, hashCache: LRUCache<string, string>): Promise<AvatarPreview>;
export declare function formatAvatarCard(p: AvatarPreview): string;
//# sourceMappingURL=avatar-preview.d.ts.map