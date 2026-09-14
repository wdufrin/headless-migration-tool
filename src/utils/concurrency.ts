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
 * Execute an array of async functions with a maximum bounded concurrency limit.
 */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: Promise<R>[] = [];
  const executing = new Set<Promise<any>>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const p = Promise.resolve().then(() => fn(item, i));
    results.push(p);
    executing.add(p);

    const clean = () => executing.delete(p);
    p.then(clean, clean);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
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
      attempt++;
      const msg = String(err?.message || '').toLowerCase();
      const status = err?.status || err?.statusCode || 0;
      
      const isRateLimit = status === 429 || 
        msg.includes('429') || 
        msg.includes('resource_exhausted') || 
        msg.includes('quota') || 
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
