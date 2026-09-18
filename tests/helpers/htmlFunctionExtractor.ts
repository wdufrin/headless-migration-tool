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

import fs from 'fs';
import path from 'path';

/**
 * Shared helper for testing functions that live in the inline <script> of
 * public/index.html.
 *
 * That script is not importable, and copying functions into test files means the
 * tests keep passing after the real page changes. Extracting the live source
 * instead means a rename or deletion breaks the test, which is the point.
 */

export const INDEX_HTML_PATH = path.resolve(process.cwd(), 'public/index.html');

export function readIndexHtml(): string {
  return fs.readFileSync(INDEX_HTML_PATH, 'utf8');
}

/** Extracts a top-level `function name(...) { ... }` by brace matching. */
export function extractFunctionSource(source: string, functionName: string): string {
  const signature = `function ${functionName}(`;
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(
      `Could not find "${signature}" in public/index.html. If the function was ` +
        'renamed or removed, update the test -- do not delete the assertion.'
    );
  }

  const bodyStart = source.indexOf('{', start);
  if (bodyStart === -1) throw new Error(`No opening brace for ${functionName}`);

  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces while extracting ${functionName}`);
}
