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
 * Executes a function with exponential backoff retries for rate-limited (HTTP 429/503) requests.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 4,
  baseDelayMs: number = 500
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err: any) {
      attempt++;
      const isRateLimit = err.status === 429 || err.statusCode === 429 || String(err.message).includes('429') || String(err.message).includes('RESOURCE_EXHAUSTED');
      const isTransient = err.status === 503 || err.statusCode === 503 || String(err.message).includes('503') || String(err.message).includes('UNAVAILABLE');

      if (attempt > maxRetries || (!isRateLimit && !isTransient)) {
        throw err;
      }

      const jitter = Math.random() * 200;
      const delay = Math.pow(2, attempt) * baseDelayMs + jitter;
      await new Promise(res => setTimeout(res, delay));
    }
  }
}
