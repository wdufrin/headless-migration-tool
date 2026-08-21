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

      // Full Jitter Exponential Backoff: baseDelay * 2^(attempt-1) + random jitter
      const exponentialDelay = Math.pow(2, attempt - 1) * baseDelayMs;
      const jitter = Math.random() * baseDelayMs;
      const totalDelay = Math.min(exponentialDelay + jitter, 15000); // Cap at 15s max delay

      await new Promise(res => setTimeout(res, totalDelay));
    }
  }
}
