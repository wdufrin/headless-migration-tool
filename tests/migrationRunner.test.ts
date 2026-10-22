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
      migrateSessions: true,
      migrateMemories: true,
      migrateSkills: true,
      exportMemories: true,
      exportArtifacts: true,
      agentTypes: ['ALL'],
      agentStatusFilter: 'ALL',
      excludeDraftAgents: false,
      notebookIds: [],
      dryRun: true,
      concurrency: 5,
      userFilter: [],
      preserveOwnership: true,
      preserveSharing: false,
      publishAgents: false,
      prefixReplacements: {},
      allowOverwrite: false,
      skipIds: [],
      promptForAdminNotebookHitl: false,
      approvedAdminNotebookIds: [],
      promptForConnectorHitl: false,
      debugMode: false,
      logLevel: 'INFO'
    },
    datastoreMapping: {
      'test-ds-1': 'prod-ds-1'
    },
    collectionMapping: {},
    identityMapping: {},
    toolMapping: {}
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
    (runner as any).registryClient.listSkills = vi.fn().mockResolvedValue([]);

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

  it('should resume from previous checkpoint and skip already completed items', async () => {
    const runner = new MigrationRunner({
      authService: dummyAuth,
      outputDir: testOutputDir
    });

    const checkpointReportPath = path.join(testOutputDir, 'prev-report.json');
    if (!fs.existsSync(testOutputDir)) {
      fs.mkdirSync(testOutputDir, { recursive: true });
    }

    // Save previous report with nb-1 already SUCCESS
    fs.writeFileSync(checkpointReportPath, JSON.stringify({
      migrationId: 'prev-run-123',
      startTime: '2026-09-02T10:00:00Z',
      endTime: '2026-09-02T10:02:00Z',
      durationMs: 120000,
      dryRun: false,
      sourceEnvironment: sampleConfig.source,
      targetEnvironment: sampleConfig.target,
      summary: { totalMigratedNotebooks: 1, totalMigratedAgents: 0, totalFailed: 0, totalSkipped: 0 },
      results: [
        {
          id: 'nb-1',
          displayName: 'Q3 Plan',
          type: 'NOTEBOOK',
          status: 'SUCCESS',
          originalOwner: 'user@fedex.com',
          targetOwner: 'user@fedex.com'
        }
      ],
      discoveredUsers: ['user@fedex.com'],
      logs: []
    }, null, 2), 'utf8');

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
    (runner as any).registryClient.listSkills = vi.fn().mockResolvedValue([]);

    const resumeConfig: ValidatedMigrationConfig = {
      ...sampleConfig,
      options: {
        ...sampleConfig.options,
        resumeFrom: checkpointReportPath
      }
    };

    const report = await runner.run(resumeConfig);

    expect(report).toBeDefined();
    // nb-1 should be retained from checkpoint
    const resumedNb = report.results.find(r => r.id === 'nb-1');
    expect(resumedNb).toBeDefined();
    expect(resumedNb?.status).toBe('SUCCESS');
    expect(resumedNb?.details?.resumedFromCheckpoint).toBe(true);

    // Clean up
    if (fs.existsSync(testOutputDir)) {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  it('should record structured SYSTEM failure when a phase throws an unhandled error', async () => {
    const runner = new MigrationRunner({
      authService: dummyAuth,
      outputDir: testOutputDir
    });

    (runner as any).client.getEngine = vi.fn().mockResolvedValue({ name: 'engines/prod_engine_1' });
    (runner as any).client.listDataStores = vi.fn().mockResolvedValue([]);
    // Force notebook migrator to throw an unexpected exception
    (runner as any).notebookMigrator.migrateNotebooks = vi.fn().mockRejectedValue(new Error('FATAL_NOTEBOOK_API_ERROR'));
    (runner as any).client.listAgents = vi.fn().mockResolvedValue([]);
    (runner as any).client.listMemories = vi.fn().mockResolvedValue([]);
    (runner as any).registryClient.listSkills = vi.fn().mockResolvedValue([]);

    const report = await runner.run(sampleConfig);

    expect(report).toBeDefined();
    const systemFailure = report.results.find(r => r.id === 'phase-failure-notebooks');
    expect(systemFailure).toBeDefined();
    expect(systemFailure?.type).toBe('SYSTEM');
    expect(systemFailure?.status).toBe('FAILED');
    expect(systemFailure?.error).toContain('FATAL_NOTEBOOK_API_ERROR');
    expect(report.summary.totalFailed).toBeGreaterThanOrEqual(1);

    if (fs.existsSync(testOutputDir)) {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  it('should skip sessions with unmapped opaque userPseudoId in multi-user runs instead of assigning them to discoveredUsers[0]', async () => {
    const runner = new MigrationRunner({
      authService: dummyAuth,
      outputDir: testOutputDir
    });

    (runner as any).client.getEngine = vi.fn().mockResolvedValue({ name: 'engines/prod_engine_1' });
    (runner as any).client.listDataStores = vi.fn().mockResolvedValue([]);
    (runner as any).notebookMigrator.migrateNotebooks = vi.fn().mockResolvedValue([]);
    (runner as any).skillMigrator.migrateSkills = vi.fn().mockResolvedValue([]);
    (runner as any).agentMigrator.migrateAgents = vi.fn().mockResolvedValue([]);
    (runner as any).client.listMemories = vi.fn().mockResolvedValue([]);

    // Mock globalfetch / SessionMigrator so listSourceSessions returns 1 mapped email session and 1 unmapped opaque ID session
    const { SessionMigrator } = await import('../src/engines/sessionMigrator.js');
    const listSpy = vi.spyOn(SessionMigrator.prototype, 'listSourceSessions').mockResolvedValue([
      {
        name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/sessions/sess-alice',
        displayName: 'Alice Valid Session',
        userPseudoId: 'alice@fedex.com',
        turns: []
      },
      {
        name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/sessions/sess-opaque',
        displayName: 'Opaque Unmapped Session',
        userPseudoId: '10928374655',
        turns: []
      }
    ]);
    const migrateSpy = vi.spyOn(SessionMigrator.prototype, 'migrateSession').mockResolvedValue({
      name: 'projects/456/locations/global/collections/default_collection/engines/prod_engine_1/sessions/sess-alice-tgt'
    });

    try {
      const multiUserConfig: ValidatedMigrationConfig = {
        ...sampleConfig,
        identityMapping: {
          'alice@fedex.com': 'alice@target.com',
          'bob@fedex.com': 'bob@target.com'
        },
        options: {
          ...sampleConfig.options,
          dryRun: false,
          migrateNotebooks: false,
          migrateAgents: false,
          migrateSkills: false,
          migrateSessions: true,
          migrateMemories: false,
          userFilter: ['*@fedex.com']
        }
      };

      const report = await runner.run(multiUserConfig);
      const aliceSession = report.results.find(r => r.id === 'sess-alice');
      const opaqueSession = report.results.find(r => r.id === 'sess-opaque');

      expect(aliceSession?.status).toBe('SUCCESS');
      expect(aliceSession?.targetOwner).toBe('alice@target.com');
      expect(opaqueSession?.status).toBe('SKIPPED');
      expect(opaqueSession?.error).toContain('Unmapped opaque user ID');
      expect(migrateSpy).toHaveBeenCalledTimes(1);
    } finally {
      listSpy.mockRestore();
      migrateSpy.mockRestore();
      if (fs.existsSync(testOutputDir)) {
        fs.rmSync(testOutputDir, { recursive: true, force: true });
      }
    }
  });
});
