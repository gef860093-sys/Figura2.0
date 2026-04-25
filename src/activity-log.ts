/**
 * Player Activity Log
 * Ring buffer in-memory + append to logs/activity.log
 */
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';

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
  query(opts?: { limit?: number; event?: ActivityEvent; uuid?: string }): ActivityEntry[];
}

export function createActivityLog(opts: { maxEvents?: number; logDir?: string } = {}): ActivityLog {
  const maxEvents = opts.maxEvents || 1000;
  const logFile = opts.logDir ? path.join(opts.logDir, 'activity.log') : null;
  const ring: ActivityEntry[] = [];

  // Ensure log dir exists
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  return {
    record(entry) {
      const full: ActivityEntry = { timestamp: new Date().toISOString(), ...entry };
      ring.push(full);
      if (ring.length > maxEvents) ring.shift();

      // Append to file (non-blocking)
      if (logFile) {
        fsp.appendFile(logFile, JSON.stringify(full) + '\n').catch(() => {});
      }
    },

    query({ limit = 100, event, uuid } = {}) {
      let results = [...ring].reverse(); // newest first
      if (event) results = results.filter(e => e.event === event);
      if (uuid) results = results.filter(e => e.uuid === uuid);
      return results.slice(0, Math.min(limit, 500));
    },
  };
}
