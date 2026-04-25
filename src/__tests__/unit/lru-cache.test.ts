import { LRUCache } from '../../lru-cache';
import * as fc from 'fast-check';

describe('LRUCache', () => {
  let cache: LRUCache<string, string>;

  beforeEach(() => {
    cache = new LRUCache(3, 1000); // maxEntries=3, defaultTtlMs=1000
  });

  afterEach(() => {
    cache.destroy();
  });

  describe('Basic Operations', () => {
    it('should set and get a value', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('should return undefined for non-existent key', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should delete a key', () => {
      cache.set('key1', 'value1');
      expect(cache.delete('key1')).toBe(true);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should return false when deleting non-existent key', () => {
      expect(cache.delete('nonexistent')).toBe(false);
    });

    it('should clear all entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeUndefined();
    });

    it('should track cache size correctly', () => {
      expect(cache.size).toBe(0);
      cache.set('key1', 'value1');
      expect(cache.size).toBe(1);
      cache.set('key2', 'value2');
      expect(cache.size).toBe(2);
      cache.delete('key1');
      expect(cache.size).toBe(1);
    });
  });

  describe('LRU Eviction', () => {
    it('should evict LRU entry when cache is full', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');
      expect(cache.size).toBe(3);

      // Adding a 4th entry should evict key1 (LRU)
      cache.set('key4', 'value4');
      expect(cache.size).toBe(3);
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key4')).toBe('value4');
    });

    it('should update LRU order on get', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      // Access key1 to make it recently used
      cache.get('key1');

      // Adding key4 should evict key2 (now LRU)
      cache.set('key4', 'value4');
      expect(cache.get('key1')).toBe('value1');
      expect(cache.get('key2')).toBeUndefined();
      expect(cache.get('key4')).toBe('value4');
    });

    it('should update LRU order on set (update existing key)', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      // Update key1 to make it recently used
      cache.set('key1', 'updated1');

      // Adding key4 should evict key2 (now LRU)
      cache.set('key4', 'value4');
      expect(cache.get('key1')).toBe('updated1');
      expect(cache.get('key2')).toBeUndefined();
      expect(cache.get('key4')).toBe('value4');
    });

    it('should handle multiple evictions correctly', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      cache.set('key4', 'value4'); // Evicts key1
      cache.set('key5', 'value5'); // Evicts key2
      cache.set('key6', 'value6'); // Evicts key3

      expect(cache.size).toBe(3);
      expect(cache.get('key4')).toBe('value4');
      expect(cache.get('key5')).toBe('value5');
      expect(cache.get('key6')).toBe('value6');
    });
  });

  describe('TTL and Expiry', () => {
    it('should expire entries after TTL', () => {
      jest.useFakeTimers();
      try {
        const testCache = new LRUCache(3, 1000);
        testCache.set('key1', 'value1', 1000);
        expect(testCache.get('key1')).toBe('value1');

        jest.advanceTimersByTime(1000);
        expect(testCache.get('key1')).toBeUndefined();

        testCache.destroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('should support custom TTL per entry', () => {
      jest.useFakeTimers();
      try {
        const testCache = new LRUCache(3, 1000);
        testCache.set('key1', 'value1', 500);
        testCache.set('key2', 'value2', 2000);

        jest.advanceTimersByTime(600);
        expect(testCache.get('key1')).toBeUndefined();
        expect(testCache.get('key2')).toBe('value2');

        jest.advanceTimersByTime(1500);
        expect(testCache.get('key2')).toBeUndefined();

        testCache.destroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('should use default TTL when not specified', () => {
      jest.useFakeTimers();
      try {
        const testCache = new LRUCache(3, 1000);
        testCache.set('key1', 'value1'); // Uses default 1000ms
        expect(testCache.get('key1')).toBe('value1');

        jest.advanceTimersByTime(1000);
        expect(testCache.get('key1')).toBeUndefined();

        testCache.destroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('should remove expired entries on lazy expiry during get', () => {
      jest.useFakeTimers();
      try {
        const testCache = new LRUCache(3, 1000);
        testCache.set('key1', 'value1', 500);
        testCache.set('key2', 'value2', 2000);

        expect(testCache.size).toBe(2);
        jest.advanceTimersByTime(600);

        // Getting expired key should remove it
        testCache.get('key1');
        expect(testCache.size).toBe(1);

        testCache.destroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('should remove expired entries on lazy expiry during set', () => {
      jest.useFakeTimers();
      try {
        const testCache = new LRUCache(3, 1000);
        testCache.set('key1', 'value1', 500);

        expect(testCache.size).toBe(1);
        jest.advanceTimersByTime(600);

        // Setting an expired key should remove it and update
        testCache.set('key1', 'updated1', 1000);
        expect(testCache.size).toBe(1);
        expect(testCache.get('key1')).toBe('updated1');

        testCache.destroy();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('Background Sweep', () => {
    it('should remove expired entries via background sweep', () => {
      jest.useFakeTimers();
      try {
        const testCache = new LRUCache(3, 1000);
        testCache.set('key1', 'value1', 500);
        testCache.set('key2', 'value2', 2000);

        expect(testCache.size).toBe(2);

        // Trigger sweep (happens every Math.min(defaultTtlMs, 60_000) = 1000ms)
        jest.advanceTimersByTime(1000);

        // key1 should be removed by sweep
        expect(testCache.size).toBe(1);
        expect(testCache.get('key2')).toBe('value2');

        testCache.destroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('should handle multiple sweeps correctly', () => {
      jest.useFakeTimers();
      try {
        const testCache = new LRUCache(3, 1000);
        testCache.set('key1', 'value1', 500);
        testCache.set('key2', 'value2', 1500);
        testCache.set('key3', 'value3', 2500);

        jest.advanceTimersByTime(1000); // First sweep
        expect(testCache.size).toBe(2); // key1 removed

        jest.advanceTimersByTime(1000); // Second sweep
        expect(testCache.size).toBe(1); // key2 removed

        jest.advanceTimersByTime(1000); // Third sweep
        expect(testCache.size).toBe(0); // key3 removed

        testCache.destroy();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('O(1) Operations', () => {
    it('should perform get in O(1) time', () => {
      const largeCache = new LRUCache(10000, 1000);
      for (let i = 0; i < 10000; i++) {
        largeCache.set(`key${i}`, `value${i}`);
      }

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        largeCache.get(`key${Math.floor(Math.random() * 10000)}`);
      }
      const duration = performance.now() - start;

      // Should be very fast (< 10ms for 1000 operations)
      expect(duration).toBeLessThan(10);
      largeCache.destroy();
    });

    it('should perform set in O(1) time', () => {
      const largeCache = new LRUCache(10000, 1000);

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        largeCache.set(`key${i}`, `value${i}`);
      }
      const duration = performance.now() - start;

      // Should be very fast (< 10ms for 1000 operations)
      expect(duration).toBeLessThan(10);
      largeCache.destroy();
    });

    it('should perform delete in O(1) time', () => {
      const largeCache = new LRUCache(10000, 1000);
      for (let i = 0; i < 1000; i++) {
        largeCache.set(`key${i}`, `value${i}`);
      }

      const start = performance.now();
      for (let i = 0; i < 500; i++) {
        largeCache.delete(`key${i}`);
      }
      const duration = performance.now() - start;

      // Should be very fast (< 10ms for 500 operations)
      expect(duration).toBeLessThan(10);
      largeCache.destroy();
    });
  });

  describe('Destroy', () => {
    it('should stop background sweep on destroy', () => {
      jest.useFakeTimers();
      try {
        const testCache = new LRUCache(3, 1000);
        testCache.set('key1', 'value1', 500);

        testCache.destroy();

        // Advance time past sweep interval
        jest.advanceTimersByTime(2000);

        // Cache should be empty (destroyed)
        expect(testCache.size).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should clear all entries on destroy', () => {
      const testCache = new LRUCache(3, 1000);
      testCache.set('key1', 'value1');
      testCache.set('key2', 'value2');

      testCache.destroy();

      expect(testCache.size).toBe(0);
      expect(testCache.get('key1')).toBeUndefined();
    });
  });

  describe('Property 1: LRU Cache size invariant', () => {
    it('should never exceed maxEntries', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(fc.string(), fc.string()), { minLength: 0, maxLength: 100 }),
          (operations) => {
            const testCache = new LRUCache(10, 1000);
            for (const [key, value] of operations) {
              testCache.set(key, value);
              expect(testCache.size).toBeLessThanOrEqual(10);
            }
            testCache.destroy();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should evict LRU entry when full', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string(), { minLength: 5, maxLength: 20 }),
          (keys) => {
            const testCache = new LRUCache(3, 1000);
            const uniqueKeys = [...new Set(keys)];

            for (const key of uniqueKeys) {
              testCache.set(key, `value_${key}`);
            }

            // Size should never exceed maxEntries
            expect(testCache.size).toBeLessThanOrEqual(3);

            // Most recent entries should be present
            const lastThreeKeys = uniqueKeys.slice(-3);
            for (const key of lastThreeKeys) {
              expect(testCache.get(key)).toBeDefined();
            }

            testCache.destroy();
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 2: TTL expiry removes entries', () => {
    it('should remove entries after TTL expires', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 100, max: 5000 }),
          (ttlMs) => {
            jest.useFakeTimers();
            try {
              const testCache = new LRUCache(10, 1000);
              testCache.set('key1', 'value1', ttlMs);

              // Before expiry
              expect(testCache.get('key1')).toBe('value1');

              // After expiry
              jest.advanceTimersByTime(ttlMs + 1);
              expect(testCache.get('key1')).toBeUndefined();

              testCache.destroy();
            } finally {
              jest.useRealTimers();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should not remove entries before TTL expires', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 100, max: 5000 }),
          fc.integer({ min: 0, max: 100 }),
          (ttlMs, advanceMs) => {
            jest.useFakeTimers();
            try {
              const testCache = new LRUCache(10, 1000);
              testCache.set('key1', 'value1', ttlMs);

              // Advance less than TTL
              jest.advanceTimersByTime(Math.min(advanceMs, ttlMs - 1));
              expect(testCache.get('key1')).toBe('value1');

              testCache.destroy();
            } finally {
              jest.useRealTimers();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty cache operations', () => {
      expect(cache.size).toBe(0);
      expect(cache.get('any')).toBeUndefined();
      expect(cache.delete('any')).toBe(false);
      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('should handle single entry cache', () => {
      const singleCache = new LRUCache(1, 1000);
      singleCache.set('key1', 'value1');
      expect(singleCache.get('key1')).toBe('value1');

      singleCache.set('key2', 'value2');
      expect(singleCache.get('key1')).toBeUndefined();
      expect(singleCache.get('key2')).toBe('value2');

      singleCache.destroy();
    });

    it('should handle updating same key multiple times', () => {
      cache.set('key1', 'value1');
      cache.set('key1', 'value2');
      cache.set('key1', 'value3');

      expect(cache.size).toBe(1);
      expect(cache.get('key1')).toBe('value3');
    });

    it('should handle numeric and object keys', () => {
      const numCache = new LRUCache<number, string>(3, 1000);
      numCache.set(1, 'one');
      numCache.set(2, 'two');
      expect(numCache.get(1)).toBe('one');
      expect(numCache.get(2)).toBe('two');
      numCache.destroy();

      const objCache = new LRUCache<{ id: number }, string>(3, 1000);
      const key1 = { id: 1 };
      const key2 = { id: 2 };
      objCache.set(key1, 'obj1');
      objCache.set(key2, 'obj2');
      expect(objCache.get(key1)).toBe('obj1');
      expect(objCache.get(key2)).toBe('obj2');
      objCache.destroy();
    });
  });
});
