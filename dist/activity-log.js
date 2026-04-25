"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createActivityLog = createActivityLog;
/**
 * Player Activity Log
 * Ring buffer in-memory + append to logs/activity.log
 */
const promises_1 = __importDefault(require("fs/promises"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function createActivityLog(opts = {}) {
    const maxEvents = opts.maxEvents || 1000;
    const logFile = opts.logDir ? path_1.default.join(opts.logDir, 'activity.log') : null;
    const ring = [];
    // Ensure log dir exists
    if (logFile) {
        fs_1.default.mkdirSync(path_1.default.dirname(logFile), { recursive: true });
    }
    return {
        record(entry) {
            const full = { timestamp: new Date().toISOString(), ...entry };
            ring.push(full);
            if (ring.length > maxEvents)
                ring.shift();
            // Append to file (non-blocking)
            if (logFile) {
                promises_1.default.appendFile(logFile, JSON.stringify(full) + '\n').catch(() => { });
            }
        },
        query({ limit = 100, event, uuid } = {}) {
            let results = [...ring].reverse(); // newest first
            if (event)
                results = results.filter(e => e.event === event);
            if (uuid)
                results = results.filter(e => e.uuid === uuid);
            return results.slice(0, Math.min(limit, 500));
        },
    };
}
//# sourceMappingURL=activity-log.js.map