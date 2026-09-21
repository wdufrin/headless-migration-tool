/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Raised when one or more tasks passed to {@link mapConcurrent} fail.
 *
 * Carries the partial results and the per-index failures so a caller can report
 * exactly which items succeeded and which did not, instead of losing that
 * information along with the rejection.
 */
export class ConcurrentTaskError extends Error {
  public readonly errors: Array<{ index: number; error: unknown }>;
  /** Results for the items that succeeded. Failed indices are `undefined`. */
  public readonly partialResults: unknown[];

  constructor(errors: Array<{ index: number; error: unknown }>, total: number, partialResults: unknown[]) {
    const first = errors[0]?.error as any;
    const firstMessage = first?.message || String(first);
    super(
      `${errors.length} of ${total} concurrent task(s) failed ` +
        `(indices: ${errors.map((e) => e.index).join(', ')}). First failure: ${firstMessage}`
    );
    this.name = 'ConcurrentTaskError';
    this.errors = errors;
    this.partialResults = partialResults;
  }
}

/**
 * Execute an async function over an array with a bounded concurrency limit.
 *
 * Every item is attempted. Previously this awaited `Promise.race()` inside the
 * scheduling loop, so the first rejection propagated out of the loop and any item
 * that had not yet been scheduled was silently never started -- a failure on one
 * notebook could skip an arbitrary number of untouched notebooks while the caller
 * saw only the single underlying error. Completed results were discarded as well,
 * because the pending `Promise.all` was never reached.
 *
 * Now failures are collected and raised together as a {@link ConcurrentTaskError}
 * once all work has settled, with the successful results attached.
 */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Array.isArray(items)) {
    throw new TypeError(`mapConcurrent expected an array of items, received ${typeof items}`);
  }
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  const results = new Array<R>(items.length);
  const failures: Array<{ index: number; error: unknown }> = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failures.push({ index, error });
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));

  if (failures.length > 0) {
    failures.sort((a, b) => a.index - b.index);
    throw new ConcurrentTaskError(failures, items.length, results);
  }

  return results;
}

/**
 * Executes a function with exponential backoff retries for rate-limited (HTTP 429/503/500/502/504) requests.
 * Transparently respects Retry-After HTTP headers when provided by Google Cloud.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 5,
  baseDelayMs: number = 750
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err: any) {
      const status = err?.status || err?.statusCode || 0;
      const msg = String(err?.message || '').toLowerCase();
      // Permission and authentication errors (401, 403) are permanent authorization failures
      // and must fail fast instead of retrying across backoff delays.
      if (status === 401 || status === 403) {
        throw err;
      }

      const isRateLimit = status === 429 || 
        msg.includes('429') || 
        msg.includes('resource_exhausted') || 
        msg.includes('rate limit');
        
      const isTransient = status === 503 || 
        status === 500 || 
        status === 502 || 
        status === 504 || 
        msg.includes('503') || 
        msg.includes('unavailable') || 
        msg.includes('econnreset') || 
        msg.includes('etimedout');

      if (attempt > maxRetries || (!isRateLimit && !isTransient)) {
        throw err;
      }

      // Check for Retry-After header
      let explicitWaitMs: number | null = null;
      const retryAfterHeader = err?.headers?.['retry-after'] || 
        err?.response?.headers?.get?.('retry-after') || 
        err?.retryAfter;

      if (retryAfterHeader) {
        const seconds = Number(retryAfterHeader);
        if (!isNaN(seconds) && seconds > 0) {
          explicitWaitMs = seconds * 1000;
        } else {
          const parsedDate = Date.parse(retryAfterHeader);
          if (!isNaN(parsedDate) && parsedDate > Date.now()) {
            explicitWaitMs = parsedDate - Date.now();
          }
        }
      }

      let totalDelay: number;
      if (explicitWaitMs !== null) {
        totalDelay = Math.min(explicitWaitMs, 120000); // Cap at 120s max delay
      } else {
        // Full Jitter Exponential Backoff: baseDelay * 2^(attempt-1) + random jitter
        const exponentialDelay = Math.pow(2, attempt - 1) * baseDelayMs;
        const jitter = Math.random() * baseDelayMs;
        totalDelay = Math.min(exponentialDelay + jitter, 120000); // Cap at 120s max delay
      }

      await new Promise(res => setTimeout(res, totalDelay));
    }
  }
}

/**
 * Token-Bucket Rate Limiter to throttle concurrent outgoing Google API calls.
 */
export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRatePerSecond: number;
  private lastRefill: number;

  constructor(requestsPerSecond: number = 10, burstLimit?: number) {
    this.refillRatePerSecond = Math.max(1, requestsPerSecond);
    this.maxTokens = burstLimit || this.refillRatePerSecond;
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }

  public async acquire(cost: number = 1): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      const missingTokens = cost - this.tokens;
      const waitMs = Math.ceil((missingTokens / this.refillRatePerSecond) * 1000);
      await new Promise(resolve => setTimeout(resolve, Math.max(waitMs, 25)));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + elapsedSeconds * this.refillRatePerSecond);
      this.lastRefill = now;
    }
  }
}
