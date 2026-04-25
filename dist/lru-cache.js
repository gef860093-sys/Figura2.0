"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LRUCache = void 0;
/**
 * LRU Cache implementation with per-entry TTL and O(1) operations
 *
 * Uses a doubly-linked list for LRU ordering and a Map for O(1) key lookup.
 * - Most recently used entries are at the head
 * - Least recently used entries are at the tail
 * - Expired entries are removed lazily on get/set and via background sweep
 */
class LRUCache {
    constructor(maxEntries, defaultTtlMs) {
        this.maxEntries = maxEntries;
        this.defaultTtlMs = defaultTtlMs;
        this.map = new Map();
        this.head = null; // Most recently used
        this.tail = null; // Least recently used
        this.sweepInterval = null;
        // Start background sweep every Math.min(defaultTtlMs, 60_000) ms
        const sweepIntervalMs = Math.min(defaultTtlMs, 60000);
        this.sweepInterval = setInterval(() => this.sweep(), sweepIntervalMs);
    }
    /**
     * Get a value from the cache
     * Returns undefined if key not found or entry has expired
     * Moves accessed entry to head (most recently used)
     * O(1) operation
     */
    get(key) {
        const node = this.map.get(key);
        if (!node) {
            return undefined;
        }
        // Check if expired
        if (Date.now() >= node.expiresAt) {
            this.removeNode(node);
            this.map.delete(key);
            return undefined;
        }
        // Move to head (most recently used)
        this.moveToHead(node);
        return node.value;
    }
    /**
     * Set a value in the cache with optional TTL
     * If cache is full (size >= maxEntries), evicts LRU entry
     * Moves entry to head (most recently used)
     * O(1) operation
     */
    set(key, value, ttlMs = this.defaultTtlMs) {
        const expiresAt = Date.now() + ttlMs;
        // If key already exists, update it
        const existingNode = this.map.get(key);
        if (existingNode) {
            // Check if expired first
            if (Date.now() >= existingNode.expiresAt) {
                this.removeNode(existingNode);
                this.map.delete(key);
            }
            else {
                // Update value and expiry
                existingNode.value = value;
                existingNode.expiresAt = expiresAt;
                this.moveToHead(existingNode);
                return;
            }
        }
        // Evict LRU entry if cache is full
        if (this.map.size >= this.maxEntries && this.tail) {
            const tailKey = this.tail.key;
            this.removeNode(this.tail);
            this.map.delete(tailKey);
        }
        // Create new node and add to head
        const newNode = {
            key,
            value,
            expiresAt,
            prev: null,
            next: null,
        };
        this.addToHead(newNode);
        this.map.set(key, newNode);
    }
    /**
     * Delete a key from the cache
     * Returns true if key was found and deleted, false otherwise
     * O(1) operation
     */
    delete(key) {
        const node = this.map.get(key);
        if (!node) {
            return false;
        }
        this.removeNode(node);
        this.map.delete(key);
        return true;
    }
    /**
     * Clear all entries from the cache
     */
    clear() {
        this.map.clear();
        this.head = null;
        this.tail = null;
    }
    /**
     * Get the current number of entries in the cache
     */
    get size() {
        return this.map.size;
    }
    /**
     * Destroy the cache and stop the background sweep
     */
    destroy() {
        if (this.sweepInterval) {
            clearInterval(this.sweepInterval);
            this.sweepInterval = null;
        }
        this.clear();
    }
    /**
     * Background sweep to remove expired entries
     * Iterates through all entries and removes those that have expired
     */
    sweep() {
        const now = Date.now();
        const keysToDelete = [];
        for (const [key, node] of this.map.entries()) {
            if (now >= node.expiresAt) {
                keysToDelete.push(key);
            }
        }
        for (const key of keysToDelete) {
            const node = this.map.get(key);
            if (node) {
                this.removeNode(node);
                this.map.delete(key);
            }
        }
    }
    /**
     * Move a node to the head (most recently used position)
     */
    moveToHead(node) {
        if (node === this.head) {
            return; // Already at head
        }
        // Remove from current position
        if (node.prev) {
            node.prev.next = node.next;
        }
        if (node.next) {
            node.next.prev = node.prev;
        }
        if (node === this.tail) {
            this.tail = node.prev;
        }
        // Add to head
        node.prev = null;
        node.next = this.head;
        if (this.head) {
            this.head.prev = node;
        }
        this.head = node;
        // If list was empty, set tail
        if (!this.tail) {
            this.tail = node;
        }
    }
    /**
     * Add a node to the head (most recently used position)
     */
    addToHead(node) {
        node.prev = null;
        node.next = this.head;
        if (this.head) {
            this.head.prev = node;
        }
        this.head = node;
        if (!this.tail) {
            this.tail = node;
        }
    }
    /**
     * Remove a node from the linked list
     */
    removeNode(node) {
        if (node.prev) {
            node.prev.next = node.next;
        }
        else {
            this.head = node.next;
        }
        if (node.next) {
            node.next.prev = node.prev;
        }
        else {
            this.tail = node.prev;
        }
    }
}
exports.LRUCache = LRUCache;
//# sourceMappingURL=lru-cache.js.map