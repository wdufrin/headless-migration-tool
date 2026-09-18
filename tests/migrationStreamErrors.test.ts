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
 * Migration SSE stream handling, executed against the REAL `startMigration`
 * source extracted from public/index.html.
 *
 * Background: the server emits `event: error` with the genuine failure reason
 * (src/routes/migration.ts). The client used to handle that by doing
 *
 *     } else if (eventType === 'error') {
 *       throw new Error(data.message || 'Stream reported an error');
 *     }
 *     } catch (e) {
 *       console.warn('Failed to parse stream event:', e, dataStr);
 *     }
 *
 * The `throw` was caught by its own sibling `catch`, so the real reason was
 * discarded to the browser console and the operator was told the *connection*
 * had dropped. These tests pin the corrected behaviour.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readIndexHtml, extractFunctionSource } from './helpers/htmlFunctionExtractor.js';

const html = readIndexHtml();

interface Harness {
  run: (isDryRun?: boolean) => Promise<void>;
  logs: Array<{ message: string; level: string }>;
  el: (id: string) => any;
}

/** Minimal element stub exposing only what startMigration touches. */
function makeElement(id: string) {
  const classes = new Set<string>();
  return {
    id,
    value: '',
    checked: true,
    textContent: '',
    innerHTML: '',
    style: {} as Record<string, string>,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
      _all: classes
    },
    scrollIntoView: () => {},
    appendChild: () => {},
    insertBefore: () => {},
    remove: () => {},
    parentNode: null as any
  };
}

/**
 * Builds a sandbox around the real function and feeds it a scripted SSE body.
 * `sseChunks` are raw strings written to the stream, exactly as the server would.
 */
function buildHarness(sseChunks: string[], opts: { responseOk?: boolean } = {}): Harness {
  const source = extractFunctionSource(html, 'startMigration');
  const elements = new Map<string, any>();
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const logs: Array<{ message: string; level: string }> = [];

  const documentStub = {
    getElementById: (id: string) => el(id),
    createElement: (tag: string) => makeElement(`created-${tag}`),
    body: makeElement('body')
  };

  const fetchStub = async () => {
    if (opts.responseOk === false) {
      return { ok: false, status: 500, json: async () => ({ message: 'boom' }) };
    }
    const encoder = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (i >= sseChunks.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(sseChunks[i++]) };
          }
        })
      }
    };
  };

  // The extractor strips the leading `async` keyword, so re-attach it.
  const factory = new Function(
    'document', 'fetch', 'addLog', 'updateStage', 'renderReport',
    'setMigrationButtonBusy', 'getSelectedUsersForMigration', 'validateMigrationConfig',
    'computeMappedTarget', 'getActiveDomainRules', 'getFieldValue', 'alert', 'confirm',
    'targetedUsersList', 'explicitIdpOverrides', 'console',
    `
      let migrationInFlight = false;
      let activeReportData = null;
      async ${source}
      return startMigration;
    `
  );

  const startMigration = factory(
    documentStub,
    fetchStub,
    (message: string, level = 'INFO') => logs.push({ message: String(message), level }),
    () => {},
    () => {},
    () => {},
    () => [],
    () => [],                       // validateMigrationConfig: no problems
    (email: string) => email,
    () => [],
    (field: string) => `stub-${field}`,
    () => {},
    () => true,                     // confirm: proceed
    [],
    {},
    { warn: () => {}, log: () => {}, error: () => {} }
  );

  return { run: (isDryRun = true) => startMigration(isDryRun), logs, el };
}

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('Migration stream: server-reported errors', () => {
  let logText: (h: Harness) => string;

  beforeEach(() => {
    logText = (h) => h.logs.map((l) => `[${l.level}] ${l.message}`).join('\n');
  });

  it('surfaces the engine\'s real error message instead of blaming the connection', async () => {
    const h = buildHarness([
      sse('log', { level: 'INFO', message: 'Starting' }),
      sse('error', { message: 'Workspace DWD scope misconfiguration for user@corp.com' })
    ]);

    await h.run();

    expect(h.el('trackerTitle').textContent).toBe('❌ Migration Failed');
    expect(h.el('trackerSubtitle').textContent).toContain('Workspace DWD scope misconfiguration');
    // The misleading message must NOT be shown when the engine told us the cause.
    expect(h.el('trackerTitle').textContent).not.toMatch(/disconnected/i);
    expect(h.el('trackerSubtitle').textContent).not.toMatch(/connection to migration engine closed/i);
  });

  it('writes the error and its issues into the visible log, not just the console', async () => {
    const h = buildHarness([
      sse('error', {
        message: 'Validation failed',
        issues: ['targetProjectId is required', 'sourceAppId is required']
      })
    ]);

    await h.run();

    const text = logText(h);
    expect(text).toContain('Validation failed');
    expect(text).toContain('targetProjectId is required');
    expect(text).toContain('sourceAppId is required');
    expect(text).toMatch(/\[ERROR\]/);
  });

  it('never reports success when an error arrives after a report', async () => {
    // The server can emit `report` and then fail while finishing up.
    const h = buildHarness([
      sse('report', { durationMs: 1200, summary: { totalMigratedAgents: 3, totalMigratedNotebooks: 4 } }),
      sse('error', { message: 'Failed to finalise migration' })
    ]);

    await h.run();

    expect(h.el('trackerTitle').textContent).not.toMatch(/completed successfully/i);
    expect(h.el('trackerTitle').textContent).toBe('❌ Migration Failed');
  });

  it('still reports success on a clean run', async () => {
    // Guards against "make everything a failure", which would be equally wrong.
    const h = buildHarness([
      sse('stage', { stage: 'complete', status: 'done' }),
      sse('report', { durationMs: 900, summary: { totalMigratedAgents: 1, totalMigratedNotebooks: 2 } })
    ]);

    await h.run(true);

    expect(h.el('trackerTitle').textContent).toMatch(/completed/i);
    expect(h.el('progressPercent').textContent).toBe('100%');
  });

  it('still reports a genuine disconnect when no error event was sent', async () => {
    const h = buildHarness([sse('log', { level: 'INFO', message: 'working' })]);

    await h.run();

    expect(h.el('trackerTitle').textContent).toMatch(/disconnected prematurely/i);
    expect(h.el('trackerSubtitle').textContent).toMatch(/connection to migration engine closed/i);
  });

  it('surfaces a malformed event instead of swallowing it silently', async () => {
    const h = buildHarness([
      'event: log\ndata: {this is not valid json\n\n',
      sse('stage', { stage: 'complete', status: 'done' })
    ]);

    await h.run();

    const text = logText(h);
    expect(text).toMatch(/could not parse an event/i);
    expect(text).toMatch(/\[WARN\]/);
  });
});

describe('Migration stream: progress reporting', () => {
  const STAGES = [
    'preflight', 'notebooks', 'skills', 'agents', 'sessions', 'memories', 'artifacts', 'reports'
  ];

  it('derives progress from stage events, not from log wording', async () => {
    // Log text that the OLD implementation pattern-matched to 42% / 62% / 80%.
    const h = buildHarness([
      sse('log', { level: 'INFO', message: 'Discovering source notebooks for everyone' }),
      sse('log', { level: 'INFO', message: 'Created target Agent alpha' }),
      sse('log', { level: 'INFO', message: 'Restored session xyz' }),
      sse('log', { level: 'INFO', message: 'Archived 12 things' })
    ]);

    await h.run();

    // No stage events were sent, so nothing has provably completed.
    expect(h.el('progressPercent').textContent).toBe('0%');
  });

  it('advances in proportion to the phases the engine reports finished', async () => {
    const h = buildHarness([
      sse('stage', { stage: 'preflight', status: 'active' }),
      sse('stage', { stage: 'preflight', status: 'done' }),
      sse('stage', { stage: 'notebooks', status: 'active' }),
      sse('stage', { stage: 'notebooks', status: 'done' })
    ]);

    await h.run();

    // 2 of 8 phases finished.
    expect(h.el('progressPercent').textContent).toBe(`${Math.round((2 / STAGES.length) * 100)}%`);
  });

  it('reaches 100% only on the complete event', async () => {
    const h = buildHarness([
      sse('stage', { stage: 'preflight', status: 'done' }),
      sse('stage', { stage: 'complete', status: 'done' })
    ]);

    await h.run();

    expect(h.el('progressPercent').textContent).toBe('100%');
    expect(h.el('progressBar').style.width).toBe('100%');
  });

  it('ignores unrecognised stages rather than distorting the percentage', async () => {
    const h = buildHarness([
      sse('stage', { stage: 'preflight', status: 'done' }),
      sse('stage', { stage: 'some-future-phase', status: 'done' })
    ]);

    await h.run();

    expect(h.el('progressPercent').textContent).toBe(`${Math.round((1 / STAGES.length) * 100)}%`);
  });

  it('does not double-count a phase reported done twice', async () => {
    const h = buildHarness([
      sse('stage', { stage: 'agents', status: 'done' }),
      sse('stage', { stage: 'agents', status: 'done' })
    ]);

    await h.run();

    expect(h.el('progressPercent').textContent).toBe(`${Math.round((1 / STAGES.length) * 100)}%`);
  });

  it('keeps the client stage list in sync with the engine MigrationStage union', async () => {
    // A phase added to the engine but not here would silently skew every percentage.
    const runnerSrc = await import('fs').then((fs) =>
      fs.readFileSync('src/engines/migrationRunner.ts', 'utf8')
    );
    const union = runnerSrc.slice(
      runnerSrc.indexOf('export type MigrationStage'),
      runnerSrc.indexOf(';', runnerSrc.indexOf('export type MigrationStage'))
    );
    const engineStages = [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

    expect(engineStages.sort()).toEqual([...STAGES].sort());

    const clientList = html.slice(
      html.indexOf('const MIGRATION_STAGE_ORDER'),
      html.indexOf('];', html.indexOf('const MIGRATION_STAGE_ORDER'))
    );
    const clientStages = [...clientList.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(clientStages.sort()).toEqual([...STAGES].sort());
  });
});

