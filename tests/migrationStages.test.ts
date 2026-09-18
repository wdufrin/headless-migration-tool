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
 * The browser drives its progress bar from MigrationRunner's onStage callback.
 * If the runner stops emitting a phase, the bar silently under-reports forever,
 * so these tests assert the callback actually fires against a real run.
 */

import { describe, it, expect, vi } from 'vitest';
import { MigrationRunner, type MigrationStage } from '../src/engines/migrationRunner.js';

/** A dry run needs no network, but the auth service is still constructed. */
function makeConfig(overrides: Record<string, any> = {}) {
  return {
    source: {
      projectId: 'src-proj',
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: 'src-app',
      assistantId: 'default_assistant'
    },
    target: {
      projectId: 'tgt-proj',
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: 'tgt-app',
      assistantId: 'default_assistant'
    },
    identityMapping: {},
    options: {
      dryRun: true,
      concurrency: 1,
      userFilter: ['user@example.com'],
      ...overrides
    }
  } as any;
}

function runnerWithRecorder(config: any) {
  const events: Array<{ stage: MigrationStage; status: string }> = [];
  const authService = {
    getAccessToken: async () => 'stub-token',
    getCallerIdentity: async () => 'admin@example.com'
  } as any;

  const runner = new MigrationRunner({
    authService,
    outputDir: '/tmp/stage-test-reports',
    onStage: (stage, status) => events.push({ stage, status })
  });

  // Every outbound HTTP call fails; phases catch, log, and continue. Stage
  // reporting must be unaffected by per-item failures.
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
    text: async () => 'denied',
    json: async () => ({})
  } as any);

  return { runner, events, fetchSpy, config };
}

describe('MigrationRunner stage reporting', () => {
  it('emits active and done for every phase the UI tracks', async () => {
    const { runner, events, fetchSpy, config } = runnerWithRecorder(makeConfig());

    try {
      await runner.run(config);
    } finally {
      fetchSpy.mockRestore();
    }

    const expected: MigrationStage[] = [
      'preflight', 'notebooks', 'skills', 'agents', 'sessions', 'memories', 'artifacts', 'reports'
    ];

    for (const stage of expected) {
      expect(
        events.some((e) => e.stage === stage && e.status === 'active'),
        `expected an "active" event for stage "${stage}"`
      ).toBe(true);
      expect(
        events.some((e) => e.stage === stage && e.status === 'done'),
        `expected a "done" event for stage "${stage}"`
      ).toBe(true);
    }
  });

  it('reports phases in execution order', async () => {
    const { runner, events, fetchSpy, config } = runnerWithRecorder(makeConfig());

    try {
      await runner.run(config);
    } finally {
      fetchSpy.mockRestore();
    }

    const doneOrder = events.filter((e) => e.status === 'done').map((e) => e.stage);
    expect(doneOrder).toEqual([
      'preflight', 'notebooks', 'skills', 'agents', 'sessions', 'memories', 'artifacts', 'reports'
    ]);
  });

  it('does not emit a phase the operator disabled', async () => {
    const { runner, events, fetchSpy, config } = runnerWithRecorder(
      makeConfig({ migrateAgents: false, migrateNotebooks: false })
    );

    try {
      await runner.run(config);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(events.some((e) => e.stage === 'agents')).toBe(false);
    expect(events.some((e) => e.stage === 'notebooks')).toBe(false);
    // Enabled phases still report.
    expect(events.some((e) => e.stage === 'skills' && e.status === 'done')).toBe(true);
  });

  it('a throwing stage listener cannot abort the migration', async () => {
    const authService = {
      getAccessToken: async () => 'stub-token',
      getCallerIdentity: async () => 'admin@example.com'
    } as any;

    const runner = new MigrationRunner({
      authService,
      outputDir: '/tmp/stage-test-reports',
      onStage: () => {
        throw new Error('listener exploded');
      }
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 403, statusText: 'Forbidden',
      text: async () => 'denied', json: async () => ({})
    } as any);

    try {
      const report = await runner.run(makeConfig());
      expect(report).toBeDefined();
      expect(report.summary).toBeDefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('runs without a listener configured', async () => {
    const authService = {
      getAccessToken: async () => 'stub-token',
      getCallerIdentity: async () => 'admin@example.com'
    } as any;
    const runner = new MigrationRunner({ authService, outputDir: '/tmp/stage-test-reports' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 403, statusText: 'Forbidden',
      text: async () => 'denied', json: async () => ({})
    } as any);

    try {
      await expect(runner.run(makeConfig())).resolves.toBeDefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
