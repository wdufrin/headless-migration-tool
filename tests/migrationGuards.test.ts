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

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The migration launch guards live in the inline <script> of public/index.html,
 * which is not importable. Rather than copy the function into the test (which
 * would then pass forever regardless of what the page actually does), this
 * extracts the real function source from the shipped HTML and evaluates it.
 *
 * If someone deletes or renames the function, extraction fails and these tests
 * fail with it.
 */

const HTML_PATH = path.resolve(process.cwd(), 'public/index.html');

/** Extracts a top-level `function name(...) { ... }` by brace matching. */
function extractFunctionSource(source: string, functionName: string): string {
  const signature = `function ${functionName}(`;
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(
      `Could not find "${signature}" in public/index.html. If the function was ` +
        'renamed or removed, update this test -- do not delete the assertion.'
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

interface Harness {
  fields: Record<string, string>;
  checkboxes: Record<string, boolean>;
}

function buildValidator(harness: Harness): () => string[] {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const fnSource = extractFunctionSource(html, 'validateMigrationConfig');

  const getFieldValue = (id: string) => harness.fields[id] ?? '';
  const documentStub = {
    getElementById: (id: string) =>
      id in harness.checkboxes ? { checked: harness.checkboxes[id] } : null
  };

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'getFieldValue',
    'document',
    `${fnSource}; return validateMigrationConfig;`
  );
  return factory(getFieldValue, documentStub);
}

const ALL_CATEGORIES = {
  optNotebooks: true,
  optSkills: true,
  optAgents: true,
  optSessions: true,
  optMemories: true,
  optArtifacts: true
};

function validConfig(): Harness {
  return {
    fields: {
      srcProjectId: 'source-proj',
      srcAppId: 'source-app',
      tgtProjectId: 'target-proj',
      tgtAppId: 'target-app'
    },
    checkboxes: { ...ALL_CATEGORIES }
  };
}

describe('validateMigrationConfig (extracted from public/index.html)', () => {
  it('accepts a fully specified configuration', () => {
    expect(buildValidator(validConfig())()).toEqual([]);
  });

  // ---- Adversarial: each of these must be rejected. ----

  it.each([
    ['srcProjectId', 'Source Project ID'],
    ['srcAppId', 'Source App (Engine) ID'],
    ['tgtProjectId', 'Target Project ID'],
    ['tgtAppId', 'Target App (Engine) ID']
  ])('rejects a missing %s', (fieldId, label) => {
    const harness = validConfig();
    harness.fields[fieldId] = '';

    const problems = buildValidator(harness)();
    expect(problems).toContain(`${label} is required.`);
  });

  it('treats a whitespace-only field as missing', () => {
    const harness = validConfig();
    harness.fields.tgtAppId = '    ';

    const problems = buildValidator(harness)();
    expect(problems).toContain('Target App (Engine) ID is required.');
  });

  it('rejects migrating an app onto itself', () => {
    const harness = validConfig();
    harness.fields.tgtProjectId = 'source-proj';
    harness.fields.tgtAppId = 'source-app';

    const problems = buildValidator(harness)();
    expect(problems.some((p) => p.includes('same project AND the same app'))).toBe(true);
  });

  it('ALLOWS same project with a different app (a legitimate in-project migration)', () => {
    const harness = validConfig();
    harness.fields.tgtProjectId = 'source-proj';
    harness.fields.tgtAppId = 'a-different-app';

    // Guards must not over-block; this is a supported scenario.
    expect(buildValidator(harness)()).toEqual([]);
  });

  it('rejects a run with every asset category unchecked', () => {
    const harness = validConfig();
    harness.checkboxes = {
      optNotebooks: false,
      optSkills: false,
      optAgents: false,
      optSessions: false,
      optMemories: false,
      optArtifacts: false
    };

    const problems = buildValidator(harness)();
    expect(problems).toContain('No asset categories are selected, so the run would migrate nothing.');
  });

  it('accepts a run with exactly one category selected', () => {
    const harness = validConfig();
    harness.checkboxes = { ...ALL_CATEGORIES, optNotebooks: false, optSkills: false, optAgents: false, optSessions: false, optMemories: false };

    expect(buildValidator(harness)()).toEqual([]);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const harness: Harness = { fields: {}, checkboxes: {} };
    const problems = buildValidator(harness)();

    expect(problems).toContain('Source Project ID is required.');
    expect(problems).toContain('Target App (Engine) ID is required.');
    expect(problems).toContain('No asset categories are selected, so the run would migrate nothing.');
    expect(problems.length).toBeGreaterThanOrEqual(5);
  });
});

describe('Migration launch guards are wired into the page', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');

  it('startMigration checks the in-flight flag before doing any work', () => {
    const fn = extractFunctionSource(html, 'startMigration');
    const guardIndex = fn.indexOf('if (migrationInFlight)');
    const trackerIndex = fn.indexOf("getElementById('trackerSection')");

    expect(guardIndex).toBeGreaterThan(-1);
    expect(trackerIndex).toBeGreaterThan(-1);
    // The guard must precede any UI mutation, or a duplicate click still resets
    // the tracker and wipes the running job's logs from the screen.
    expect(guardIndex).toBeLessThan(trackerIndex);
  });

  it('startMigration validates before prompting for confirmation', () => {
    const fn = extractFunctionSource(html, 'startMigration');
    expect(fn.indexOf('validateMigrationConfig()')).toBeLessThan(fn.indexOf('confirm('));
  });

  it('releases the in-flight flag in a finally block, not only on success', () => {
    const fn = extractFunctionSource(html, 'startMigration');
    const finallyIndex = fn.indexOf('} finally {');

    expect(finallyIndex).toBeGreaterThan(-1);
    expect(fn.slice(finallyIndex)).toContain('migrationInFlight = false');
    expect(fn.slice(finallyIndex)).toContain('setMigrationButtonBusy(false)');
  });

  it('only prompts for confirmation on the live path', () => {
    const fn = extractFunctionSource(html, 'startMigration');
    const confirmIndex = fn.indexOf('confirm(');
    const liveGuardIndex = fn.indexOf('if (!isDryRun)');

    expect(liveGuardIndex).toBeGreaterThan(-1);
    expect(liveGuardIndex).toBeLessThan(confirmIndex);
  });
});
