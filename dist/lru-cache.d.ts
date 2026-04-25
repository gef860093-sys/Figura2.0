import { LRUCache as LRUCacheInterface } from './types';
/**
 * LRU Cache implementation with per-entry TTL and O(1) operations
 *
 * Uses a doubly-linked list for LRU ordering and a Map for O(1) key lookup.
 * - Most recently used entries are at the head
 * - Least recently used entries are at the tail
 * - Expired entries are removed lazily on get/set and via background sweep
 */
export declare class LRUCache<K, V> implements LRUCacheInterface<K, V> {
    private maxEntries;
    private defaultTtlMs;
    private map;
    private head;
    private tail;
    private sweepInterval;
    constructor(maxEntries: number, defaultTtlMs: number);
    /**
     * Get a value from the cache
     * Returns undefined if key not found or entry has expired
     * Moves accessed entry to head (most recently used)
     * O(1) operation
     */
    get(key: K): V | undefined;
    /**
     * Set a value in the cache with optional TTL
     * If cache is full (size >= maxEntries), evicts LRU entry
     * Moves entry to head (most recently used)
     * O(1) operation
     */
    set(key: K, value: V, ttlMs?: number): void;
    /**
     * Delete a key from the cache
     * Returns true if key was found and deleted, false otherwise
     * O(1) operation
     */
    delete(key: K): boolean;
    /**
     * Clear all entries from the cache
     */
    clear(): void;
    /**
     * Get the current number of entries in the cache
     */
    get size(): number;
    /**
     * Destroy the cache and stop the background sweep
     */
    destroy(): void;
    /**
     * Background sweep to remove expired entries
     * Iterates through all entries and removes those that have expired
     */
    private sweep;
    /**
     * Move a node to the head (most recently used position)
     */
    private moveToHead;
    /**
     * Add a node to the head (most recently used position)
     */
    private addToHead;
    /**
     * Remove a node from the linked list
     */
    private removeNode;
}
//# sourceMappingURL=lru-cache.d.ts.map