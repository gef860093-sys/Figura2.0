import { LRUCache as LRUCacheInterface } from './types';

/**
 * Node in the doubly-linked list for LRU ordering
 */
interface Node<K, V> {
  key: K;
  value: V;
  expiresAt: number;
  prev: Node<K, V> | null;
  next: Node<K, V> | null;
}

/**
 * LRU Cache implementation with per-entry TTL and O(1) operations
 * 
 * Uses a doubly-linked list for LRU ordering and a Map for O(1) key lookup.
 * - Most recently used entries are at the head
 * - Least recently used entries are at the tail
 * - Expired entries are removed lazily on get/set and via background sweep
 */
export class LRUCache<K, V> implements LRUCacheInterface<K, V> {
  private map: Map<K, Node<K, V>> = new Map();
  private head: Node<K, V> | null = null; // Most recently used
  private tail: Node<K, V> | null = null; // Least recently used
  private sweepInterval: NodeJS.Timeout | null = null;

  constructor(
    private maxEntries: number,
    private defaultTtlMs: number
  ) {
    // Start background sweep every Math.min(defaultTtlMs, 60_000) ms
    const sweepIntervalMs = Math.min(defaultTtlMs, 60_000);
    this.sweepInterval = setInterval(() => this.sweep(), sweepIntervalMs);
  }

  /**
   * Get a value from the cache
   * Returns undefined if key not found or entry has expired
   * Moves accessed entry to head (most recently used)
   * O(1) operation
   */
  get(key: K): V | undefined {
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
  set(key: K, value: V, ttlMs: number = this.defaultTtlMs): void {
    const expiresAt = Date.now() + ttlMs;

    // If key already exists, update it
    const existingNode = this.map.get(key);
    if (existingNode) {
      // Check if expired first
      if (Date.now() >= existingNode.expiresAt) {
        this.removeNode(existingNode);
        this.map.delete(key);
      } else {
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
    const newNode: Node<K, V> = {
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
  delete(key: K): boolean {
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
  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  /**
   * Get the current number of entries in the cache
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Destroy the cache and stop the background sweep
   */
  destroy(): void {
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
  private sweep(): void {
    const now = Date.now();
    const keysToDelete: K[] = [];

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
  private moveToHead(node: Node<K, V>): void {
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
  private addToHead(node: Node<K, V>): void {
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
  private removeNode(node: Node<K, V>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }

    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
  }
}
