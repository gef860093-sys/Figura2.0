/**
 * Backup System
 *
 * Automatically backs up all avatar files on a configurable schedule.
 * Backups are stored as timestamped zip archives.
 *
 * Layout:
 *   backups/
 *     backup_<ISO-timestamp>.zip   ← full snapshot of avatars dir
 *     backup.index.json            ← metadata index
 */
export interface BackupEntry {
    backupId: string;
    filename: string;
    createdAt: string;
    fileCount: number;
    sizeBytes: number;
}
export interface BackupConfig {
    avatarsDir: string;
    backupDir: string;
    intervalMs: number;
    maxBackups: number;
}
export interface BackupSystem {
    start(): void;
    stop(): void;
    /** Run a backup immediately, returns the new BackupEntry */
    runBackup(): Promise<BackupEntry>;
    /** List all stored backups, newest first */
    listBackups(): Promise<BackupEntry[]>;
    /** Restore all avatar files from a backup archive */
    restoreBackup(backupId: string): Promise<{
        restoredFiles: number;
    }>;
    /** Delete a specific backup */
    deleteBackup(backupId: string): Promise<void>;
}
export declare function createBackupSystem(config: BackupConfig, onError?: (err: Error) => void): BackupSystem;
//# sourceMappingURL=backup-system.d.ts.map