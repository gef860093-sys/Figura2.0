export type ActivityEvent = 'login' | 'logout' | 'upload' | 'delete' | 'equip' | 'restore_version' | 'backup_restore' | 'ban_issued';
export interface ActivityEntry {
    timestamp: string;
    event: ActivityEvent;
    uuid?: string;
    username?: string;
    ip?: string;
    details?: Record<string, any>;
}
export interface ActivityLog {
    record(entry: Omit<ActivityEntry, 'timestamp'>): void;
    query(opts?: {
        limit?: number;
        event?: ActivityEvent;
        uuid?: string;
    }): ActivityEntry[];
}
export declare function createActivityLog(opts?: {
    maxEvents?: number;
    logDir?: string;
}): ActivityLog;
//# sourceMappingURL=activity-log.d.ts.map