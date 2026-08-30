import { describe, it, expect, vi } from 'vitest';
import { MigrationRunner } from '../src/engines/migrationRunner.js';
import { ValidatedMigrationConfig } from '../src/config/configSchema.js';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import * as fs from 'fs';
import * as path from 'path';

describe('MigrationRunner Orchestrator', () => {
  const dummyAuth = new GcpAuthService({ staticToken: 'test-token' });
  const testOutputDir = path.join(process.cwd(), '.tmp-test-reports');

  const sampleConfig: ValidatedMigrationConfig = {
    source: {
      projectId: 'fedex-test-project',
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: 'test_engine_1',
      assistantId: 'default_assistant'
    },
    target: {
      projectId: 'fedex-prod-project',
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: 'prod_engine_1',
      assistantId: 'default_assistant'
    },
    options: {
      migrateNotebooks: true,
      migrateAgents: true,
      dryRun: true,
      concurrency: 5,
      userFilter: [],
      preserveOwnership: true,
      prefixReplacements: {},
      allowOverwrite: false,
      logLevel: 'INFO'
    },
    datastoreMapping: {
      'test-ds-1': 'prod-ds-1'
    },
    collectionMapping: {},
    identityMapping: {}
  };

  it('should run a simulated dry run and generate report files', async () => {
    const runner = new MigrationRunner({
      authService: dummyAuth,
      outputDir: testOutputDir
    });

    // Mock client methods so network calls don't fail in unit tests
    (runner as any).client.getEngine = vi.fn().mockResolvedValue({ name: 'engines/prod_engine_1' });
    (runner as any).client.listDataStores = vi.fn().mockResolvedValue([{ name: 'dataStores/prod-ds-1' }]);
    (runner as any).client.listNotebooks = vi.fn().mockResolvedValue([
      { name: 'projects/123/locations/global/notebooks/nb-1', title: 'Q3 Plan', metadata: { ownerEmail: 'user@fedex.com' } }
    ]);
    (runner as any).client.listAgents = vi.fn().mockResolvedValue([
      { name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/ag-1', displayName: 'Agent A' }
    ]);
    (runner as any).client.listMemories = vi.fn().mockResolvedValue([]);
    (runner as any).client.getAgentIamPolicy = vi.fn().mockResolvedValue({ bindings: [] });

    const report = await runner.run(sampleConfig);

    expect(report).toBeDefined();
    expect(report.dryRun).toBe(true);
    expect(report.summary.totalDiscoveredNotebooks).toBe(1);
    expect(report.summary.totalDiscoveredAgents).toBe(1);
    expect(report.results.length).toBe(2);
    expect(report.results[0].status).toBe('DRY_RUN');
    expect(report.results[1].status).toBe('DRY_RUN');

    // Clean up test reports dir
    if (fs.existsSync(testOutputDir)) {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });
});
