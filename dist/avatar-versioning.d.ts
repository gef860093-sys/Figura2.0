/**
 * Avatar Versioning System
 *
 * Stores up to MAX_VERSIONS previous avatar files per user.
 * Layout on disk:
 *   avatars/<uuid>.moon          ← current (managed by upload pipeline)
 *   avatars_versions/<uuid>/     ← version history directory
 *     <timestamp>_<hash>.moon   ← versioned snapshot
 *     versions.json             ← metadata index
 */
export interface AvatarVersion {
    versionId: string;
    hash: string;
    sizeBytes: number;
    createdAt: string;
    filename: string;
}
export interface VersioningConfig {
    versionsDir: string;
    maxVersions: number;
}
export interface AvatarVersioningSystem {
    /** Called after a successful upload — snapshots the current file as a new version */
    snapshot(uuid: string, currentFilePath: string, hash: string, sizeBytes: number): Promise<void>;
    /** List all stored versions for a user, newest first */
    listVersions(uuid: string): Promise<AvatarVersion[]>;
    /** Restore a specific version — copies it back to currentFilePath */
    restoreVersion(uuid: string, versionId: string, currentFilePath: string): Promise<AvatarVersion>;
    /** Delete a specific version */
    deleteVersion(uuid: string, versionId: string): Promise<void>;
    /** Delete all versions for a user */
    deleteAllVersions(uuid: string): Promise<void>;
}
export declare function createAvatarVersioningSystem(config: VersioningConfig): AvatarVersioningSystem;
//# sourceMappingURL=avatar-versioning.d.ts.map