import { describe, it, expect, vi } from 'vitest';
import { mapConcurrent, retryWithBackoff, RateLimiter, ConcurrentTaskError } from '../src/utils/concurrency.js';

describe('Concurrency Utilities', () => {
  it('mapConcurrent should process items with bounded concurrency', async () => {
    let currentConcurrent = 0;
    let maxObservedConcurrent = 0;

    const items = [1, 2, 3, 4, 5, 6];
    const results = await mapConcurrent(items, 2, async (item) => {
      currentConcurrent++;
      if (currentConcurrent > maxObservedConcurrent) {
        maxObservedConcurrent = currentConcurrent;
      }
      await new Promise(r => setTimeout(r, 20));
      currentConcurrent--;
      return item * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50, 60]);
    expect(maxObservedConcurrent).toBeLessThanOrEqual(2);
  });

  describe('mapConcurrent failure semantics', () => {
    /**
     * The previous implementation awaited `Promise.race()` inside the scheduling loop,
     * so the first rejection escaped the loop and every not-yet-scheduled item was
     * silently never attempted. Measured before the fix: with 8 items, concurrency 3
     * and item 1 failing, only 3 tasks ever started -- 5 were dropped without a trace.
     */
    it('attempts every item even when one fails early', async () => {
      const started: number[] = [];

      await expect(
        mapConcurrent([0, 1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
          started.push(item);
          if (item === 1) {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error(`task ${item} failed`);
          }
          await new Promise((r) => setTimeout(r, 20));
          return item;
        })
      ).rejects.toThrow(ConcurrentTaskError);

      expect(started.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('preserves the results of items that succeeded', async () => {
      let thrown: any;
      try {
        await mapConcurrent([0, 1, 2, 3], 2, async (item) => {
          if (item === 2) throw new Error('boom');
          return item * 100;
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ConcurrentTaskError);
      expect(thrown.partialResults[0]).toBe(0);
      expect(thrown.partialResults[1]).toBe(100);
      expect(thrown.partialResults[2]).toBeUndefined();
      expect(thrown.partialResults[3]).toBe(300);
    });

    it('aggregates every failure in index order, not just the first', async () => {
      let thrown: any;
      try {
        await mapConcurrent([0, 1, 2, 3, 4], 2, async (item) => {
          if (item % 2 === 1) throw new Error(`odd ${item}`);
          return item;
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown.errors.map((e: any) => e.index)).toEqual([1, 3]);
      expect(thrown.errors.map((e: any) => e.error.message)).toEqual(['odd 1', 'odd 3']);
      expect(thrown.message).toContain('2 of 5');
    });

    it('never exceeds the concurrency limit, including while failures occur', async () => {
      let active = 0;
      let peak = 0;

      await expect(
        mapConcurrent([...Array(20).keys()], 4, async (item) => {
          active++;
          peak = Math.max(peak, active);
          try {
            await new Promise((r) => setTimeout(r, 5));
            if (item % 3 === 0) throw new Error(`fail ${item}`);
            return item;
          } finally {
            active--;
          }
        })
      ).rejects.toThrow();

      expect(peak).toBeLessThanOrEqual(4);
    });

    it('returns an empty array for no items without invoking the callback', async () => {
      const fn = vi.fn();
      await expect(mapConcurrent([], 4, fn as any)).resolves.toEqual([]);
      expect(fn).not.toHaveBeenCalled();
    });

    it.each([0, -1, NaN])('clamps an invalid concurrency of %s to at least 1', async (bad) => {
      const results = await mapConcurrent([1, 2, 3], bad as number, async (i) => i * 2);
      expect(results).toEqual([2, 4, 6]);
    });

    it('rejects a non-array input instead of silently returning nothing', async () => {
      await expect(mapConcurrent(undefined as any, 2, async (i) => i)).rejects.toThrow(TypeError);
    });

    it('preserves result ordering regardless of completion order', async () => {
      // Later items finish first; results must still line up with input indices.
      const results = await mapConcurrent([0, 1, 2, 3, 4], 5, async (item) => {
        await new Promise((r) => setTimeout(r, (5 - item) * 8));
        return `item-${item}`;
      });
      expect(results).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4']);
    });
  });

  it('retryWithBackoff should retry on 429 and succeed', async () => {
    let attempts = 0;
    const result = await retryWithBackoff(async () => {
      attempts++;
      if (attempts < 3) {
        const err: any = new Error('Resource Exhausted (429)');
        err.status = 429;
        throw err;
      }
      return 'success';
    }, 5, 10);

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('retryWithBackoff should respect Retry-After header', async () => {
    let attempts = 0;
    const start = Date.now();
    const result = await retryWithBackoff(async () => {
      attempts++;
      if (attempts === 1) {
        const err: any = new Error('Rate Limited');
        err.status = 429;
        err.headers = { 'retry-after': '0.1' }; // 100ms
        throw err;
      }
      return 'ok';
    }, 3, 5);

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });

  it('RateLimiter should throttle token acquisition', async () => {
    const limiter = new RateLimiter(5, 5); // 5 tokens per second
    const start = Date.now();
    
    // Acquire 6 tokens (first 5 immediate, 6th waits ~200ms)
    for (let i = 0; i < 6; i++) {
      await limiter.acquire(1);
    }
    
    const duration = Date.now() - start;
    expect(duration).toBeGreaterThanOrEqual(150);
  });
});
