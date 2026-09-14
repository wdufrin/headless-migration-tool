import { describe, it, expect, vi } from 'vitest';
import { mapConcurrent, retryWithBackoff, RateLimiter } from '../src/utils/concurrency.js';

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
