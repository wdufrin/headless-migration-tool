import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigAuditEngine } from '../src/engines/configAuditEngine.js';
import { DiscoveryEngineClient } from '../src/services/discoveryEngine.js';
import { AgentRegistryClient } from '../src/services/agentRegistry.js';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import { ValidatedMigrationConfig } from '../src/config/configSchema.js';

describe('ConfigAuditEngine', () => {
  let mockClient: DiscoveryEngineClient;
  let mockRegistryClient: AgentRegistryClient;
  let mockAuth: GcpAuthService;
  let auditEngine: ConfigAuditEngine;

  const mockConfig: ValidatedMigrationConfig = {
    source: {
      projectId: 'source-proj',
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: 'source-engine',
      assistantId: 'default_assistant'
    },
    target: {
      projectId: 'target-proj',
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: 'target-engine',
      assistantId: 'default_assistant'
    },
    options: {
      migrateNotebooks: true,
      migrateAgents: true,
      migrateSessions: true,
      migrateMemories: true,
      migrateSkills: true,
      exportMemories: false,
      exportArtifacts: true,
      agentTypes: ['ALL'],
      agentStatusFilter: 'ALL',
      excludeDraftAgents: false,
      notebookIds: [],
      dryRun: false,
      concurrency: 10,
      userFilter: [],
      preserveOwnership: true,
      preserveSharing: false,
      publishAgents: false,
      prefixReplacements: {},
      allowOverwrite: false,
      skipIds: [],
      promptForAdminNotebookHitl: false,
      approvedAdminNotebookIds: [],
      promptForConnectorHitl: true,
      debugMode: false,
      logLevel: 'INFO'
    },
    datastoreMapping: {
      'ds-docs': 'ds-docs'
    },
    collectionMapping: {},
    identityMapping: {},
    toolMapping: {}
  };

  beforeEach(() => {
    mockAuth = {
      getCallerIdentity: vi.fn().mockResolvedValue('admin@company.com'),
      getAccessToken: vi.fn().mockResolvedValue('mock-token')
    } as unknown as GcpAuthService;

    mockClient = {
      getEngine: vi.fn(),
      listDataStores: vi.fn(),
      detectEngineIdpConfig: vi.fn()
    } as unknown as DiscoveryEngineClient;

    mockRegistryClient = {
      listSkills: vi.fn().mockResolvedValue([])
    } as unknown as AgentRegistryClient;

    auditEngine = new ConfigAuditEngine(mockAuth, mockClient, mockRegistryClient);
  });

  it('should detect parity match when target engine and datastores match', async () => {
    (mockClient.getEngine as any).mockImplementation((env: any) => {
      return Promise.resolve({ name: `projects/${env.projectId}/engines/${env.appId}`, displayName: env.appId });
    });

    (mockClient.listDataStores as any).mockImplementation((env: any) => {
      return Promise.resolve([
        { name: `projects/${env.projectId}/locations/global/dataStores/ds-docs`, displayName: 'Company Docs' }
      ]);
    });

    (mockClient.detectEngineIdpConfig as any).mockResolvedValue({ idpType: 'GOOGLE_CLOUD_IDENTITY' });

    const result = await auditEngine.runAudit(mockConfig);

    expect(result.sourceProject).toBe('source-proj');
    expect(result.targetProject).toBe('target-proj');
    expect(result.readinessScore).toBeGreaterThanOrEqual(90);
    expect(result.missingInTargetCount).toBe(0);

    const engineItem = result.items.find(i => i.id === 'engine-existence');
    expect(engineItem?.status).toBe('MATCH');

    const dsItem = result.items.find(i => i.id === 'datastore-ds-docs');
    expect(dsItem?.status).toBe('MATCH');
  });

  it('should detect gap when target engine does not exist', async () => {
    (mockClient.getEngine as any).mockImplementation((env: any) => {
      if (env.projectId === 'target-proj') {
        return Promise.reject(new Error('Engine not found 404'));
      }
      return Promise.resolve({ name: 'projects/source-proj/engines/source-engine' });
    });

    (mockClient.listDataStores as any).mockResolvedValue([]);
    (mockClient.detectEngineIdpConfig as any).mockResolvedValue({ idpType: 'GOOGLE_CLOUD_IDENTITY' });

    const result = await auditEngine.runAudit(mockConfig);

    expect(result.readinessScore).toBeLessThanOrEqual(50);
    expect(result.missingInTargetCount).toBeGreaterThan(0);

    const engineItem = result.items.find(i => i.id === 'engine-existence');
    expect(engineItem?.status).toBe('MISSING_IN_TARGET');
    expect(engineItem?.remediationCommand).toContain('curl -s -X POST');
    expect(engineItem?.remediationCommand).toContain('discoveryengine.googleapis.com');
  });

  it('should detect missing DataStore in target without generating CLI creation commands', async () => {
    (mockClient.getEngine as any).mockResolvedValue({ name: 'ok' });

    (mockClient.listDataStores as any).mockImplementation((env: any) => {
      if (env.projectId === 'source-proj') {
        return Promise.resolve([
          { name: 'projects/source-proj/locations/global/dataStores/ds-finance', displayName: 'Finance KB' }
        ]);
      }
      return Promise.resolve([]); // target has none
    });

    (mockClient.detectEngineIdpConfig as any).mockResolvedValue({ idpType: 'GOOGLE_CLOUD_IDENTITY' });

    const result = await auditEngine.runAudit({
      ...mockConfig,
      datastoreMapping: {}
    });

    const dsItem = result.items.find(i => i.id === 'datastore-ds-finance');
    expect(dsItem?.status).toBe('MISSING_IN_TARGET');
    expect(dsItem?.remediationCommand).toBeUndefined();

    // Verify no CLI command is provided for datastore creation
    const dsCreationPlan = result.remediationPlan.find(p => p.command && p.command.includes('dataStores?dataStoreId='));
    expect(dsCreationPlan).toBeUndefined();

    // Informational card exists in remediation plan without CLI command
    const infoPlan = result.remediationPlan.find(p => p.title.includes('Missing Attached DataStore(s)'));
    expect(infoPlan).toBeDefined();
    expect(infoPlan?.command).toBeUndefined();
  });

  it('should generate formatted Markdown report', async () => {
    (mockClient.getEngine as any).mockResolvedValue({ name: 'ok' });
    (mockClient.listDataStores as any).mockResolvedValue([]);
    (mockClient.detectEngineIdpConfig as any).mockResolvedValue({ idpType: 'GOOGLE_CLOUD_IDENTITY' });

    const result = await auditEngine.runAudit(mockConfig);
    const md = auditEngine.generateMarkdownReport(result);

    expect(md).toContain('# Gemini Enterprise Pre-Migration Configuration & Gap Audit');
    expect(md).toContain('**Source Project:** `source-proj`');
    expect(md).toContain('## Detailed Parity Breakdown');
  });

  it('should compare all engine features including memory, agent catalog, create agents, and skills', async () => {
    (mockClient.getEngine as any).mockImplementation((env: any) => {
      if (env.projectId === 'source-proj') {
        return Promise.resolve({
          name: 'projects/source-proj/engines/source-engine',
          displayName: 'Source Engine',
          features: {
            'personalization-memory': 'FEATURE_STATE_ON',
            'agent-gallery': 'FEATURE_STATE_ON',
            'no-code-agent-builder': 'FEATURE_STATE_ON',
            'skills': 'FEATURE_STATE_ON',
            'skill-sharing': 'FEATURE_STATE_ON',
            'session-sharing': 'FEATURE_STATE_ON'
          },
          marketplaceAgentVisibility: 'SHOW_AVAILABLE_AGENTS_ONLY',
          observabilityConfig: { observabilityEnabled: true, sensitiveLoggingEnabled: true }
        });
      } else {
        return Promise.resolve({
          name: 'projects/target-proj/engines/target-engine',
          displayName: 'Target Engine',
          features: {
            'personalization-memory': 'FEATURE_STATE_ON',
            'agent-gallery': 'FEATURE_STATE_OFF',
            'no-code-agent-builder': 'FEATURE_STATE_ON',
            'skills': 'FEATURE_STATE_ON',
            'skill-sharing': 'FEATURE_STATE_ON',
            'session-sharing': 'FEATURE_STATE_OFF'
          },
          marketplaceAgentVisibility: 'SHOW_ALL_AGENTS',
          observabilityConfig: { observabilityEnabled: true }
        });
      }
    });

    (mockClient.listDataStores as any).mockResolvedValue([]);
    (mockClient.detectEngineIdpConfig as any).mockResolvedValue({ idpType: 'GOOGLE_CLOUD_IDENTITY' });

    const result = await auditEngine.runAudit(mockConfig);

    const memoryItem = result.items.find(i => i.id === 'engine-feature-personalization-memory');
    expect(memoryItem).toBeDefined();
    expect(memoryItem?.status).toBe('MATCH');
    expect(memoryItem?.name).toBe('User Memory & Personalization');

    const galleryItem = result.items.find(i => i.id === 'engine-feature-agent-gallery');
    expect(galleryItem).toBeDefined();
    expect(galleryItem?.status).toBe('WARNING');
    expect(galleryItem?.name).toBe('Agent Gallery & Catalog');

    const builderItem = result.items.find(i => i.id === 'engine-feature-no-code-agent-builder');
    expect(builderItem).toBeDefined();
    expect(builderItem?.status).toBe('MATCH');
    expect(builderItem?.name).toBe('Create Agents (No-Code Builder)');

    const skillsItem = result.items.find(i => i.id === 'engine-feature-skills');
    expect(skillsItem).toBeDefined();
    expect(skillsItem?.status).toBe('MATCH');
    expect(skillsItem?.name).toBe('Create & Execute Skills');

    const visibilityItem = result.items.find(i => i.id === 'engine-marketplace-visibility');
    expect(visibilityItem).toBeDefined();
    expect(visibilityItem?.status).toBe('DIFF');

    // Verify remediation plan contains an engine feature sync recommendation
    const syncPlan = result.remediationPlan.find(p => p.title.includes('Synchronize Engine Features'));
    expect(syncPlan).toBeDefined();
    expect(syncPlan?.command).toContain('updateMask=features,marketplaceAgentVisibility,observabilityConfig');
  });

  it('should synchronize engine settings via syncEngineSettings', async () => {
    (mockClient.getEngine as any).mockResolvedValue({
      name: 'projects/source-proj/engines/source-engine',
      features: {
        'personalization-memory': 'FEATURE_STATE_ON',
        'agent-gallery': 'FEATURE_STATE_ON'
      },
      marketplaceAgentVisibility: 'SHOW_AVAILABLE_AGENTS_ONLY',
      observabilityConfig: { observabilityEnabled: true }
    });

    (mockClient as any).patchEngine = vi.fn().mockResolvedValue({
      name: 'projects/target-proj/engines/target-engine'
    });

    const res = await auditEngine.syncEngineSettings(mockConfig);

    expect(res.success).toBe(true);
    expect((mockClient as any).patchEngine).toHaveBeenCalledWith(
      mockConfig.target,
      expect.objectContaining({
        features: {
          'personalization-memory': 'FEATURE_STATE_ON',
          'agent-gallery': 'FEATURE_STATE_ON'
        },
        marketplaceAgentVisibility: 'SHOW_AVAILABLE_AGENTS_ONLY',
        observabilityConfig: { observabilityEnabled: true }
      }),
      'features,marketplaceAgentVisibility,observabilityConfig'
    );
  });

  it('should only audit DataStores attached to the source engine and ignore unattached project DataStores', async () => {
    (mockClient.getEngine as any).mockImplementation((env: any) => {
      if (env.projectId === 'source-proj') {
        return Promise.resolve({
          name: 'projects/source-proj/engines/source-engine',
          dataStoreIds: ['ds-attached-1', 'ds-attached-2']
        });
      } else {
        return Promise.resolve({
          name: 'projects/target-proj/engines/target-engine',
          dataStoreIds: ['ds-attached-1']
        });
      }
    });

    (mockClient.listDataStores as any).mockImplementation((env: any) => {
      if (env.projectId === 'source-proj') {
        return Promise.resolve([
          { name: 'projects/source-proj/locations/global/dataStores/ds-attached-1', displayName: 'Attached Store 1' },
          { name: 'projects/source-proj/locations/global/dataStores/ds-attached-2', displayName: 'Attached Store 2' },
          { name: 'projects/source-proj/locations/global/dataStores/ds-orphan-3', displayName: 'Orphaned Store 3' },
          { name: 'projects/source-proj/locations/global/dataStores/ds-orphan-4', displayName: 'Orphaned Store 4' }
        ]);
      } else {
        return Promise.resolve([
          { name: 'projects/target-proj/locations/global/dataStores/ds-attached-1', displayName: 'Attached Store 1' },
          { name: 'projects/target-proj/locations/global/dataStores/ds-attached-2', displayName: 'Attached Store 2' }
        ]);
      }
    });

    (mockClient.detectEngineIdpConfig as any).mockResolvedValue({ idpType: 'GOOGLE_CLOUD_IDENTITY' });

    const result = await auditEngine.runAudit({
      ...mockConfig,
      datastoreMapping: {}
    });

    // ds-attached-1 is in target project AND in target engine dataStoreIds -> MATCH
    const ds1 = result.items.find(i => i.id === 'datastore-ds-attached-1');
    expect(ds1).toBeDefined();
    expect(ds1?.status).toBe('MATCH');

    // ds-attached-2 is in target project BUT NOT in target engine dataStoreIds -> WARNING
    const ds2 = result.items.find(i => i.id === 'datastore-ds-attached-2');
    expect(ds2).toBeDefined();
    expect(ds2?.status).toBe('WARNING');
    expect(ds2?.details).toContain('is NOT attached to target engine');

    // Orphaned stores should NOT be audited at all
    const orphan3 = result.items.find(i => i.id === 'datastore-ds-orphan-3');
    const orphan4 = result.items.find(i => i.id === 'datastore-ds-orphan-4');
    expect(orphan3).toBeUndefined();
    expect(orphan4).toBeUndefined();

    // Remediation plan should contain command to attach ds-attached-2 to target engine
    const attachPlan = result.remediationPlan.find(p => p.title.includes('Attach 1 Provisioned DataStore(s)'));
    expect(attachPlan).toBeDefined();
    expect(attachPlan?.command).toContain('updateMask=dataStoreIds');
    expect(attachPlan?.command).toContain('"dataStoreIds":["ds-attached-1","ds-attached-2"]');
  });

  it('should detect extra DataStores attached to target engine that are not on source engine', async () => {
    (mockClient.getEngine as any).mockImplementation((env: any) => {
      if (env.projectId === 'source-proj') {
        return Promise.resolve({
          name: 'projects/source-proj/engines/source-engine',
          dataStoreIds: ['ds-common']
        });
      } else {
        return Promise.resolve({
          name: 'projects/target-proj/engines/target-engine',
          dataStoreIds: ['ds-common', 'ds-extra-target']
        });
      }
    });

    (mockClient.listDataStores as any).mockImplementation((env: any) => {
      if (env.projectId === 'source-proj') {
        return Promise.resolve([
          { name: 'projects/source-proj/locations/global/dataStores/ds-common', displayName: 'Common Store' }
        ]);
      } else {
        return Promise.resolve([
          { name: 'projects/target-proj/locations/global/dataStores/ds-common', displayName: 'Common Store' },
          { name: 'projects/target-proj/locations/global/dataStores/ds-extra-target', displayName: 'Target Extra Store' }
        ]);
      }
    });

    (mockClient.detectEngineIdpConfig as any).mockResolvedValue({ idpType: 'GOOGLE_CLOUD_IDENTITY' });

    const result = await auditEngine.runAudit({
      ...mockConfig,
      datastoreMapping: {}
    });

    const extraItem = result.items.find(i => i.id === 'datastore-target-extra-ds-extra-target');
    expect(extraItem).toBeDefined();
    expect(extraItem?.status).toBe('DIFF');
    expect(extraItem?.details).toContain('attached to target engine "target-engine", but was not attached to source engine');
  });

  it('should dynamically auto-map _##### Connector Collections and child entity DataStores in Step 2 Audit and flag missing ones for HITL', async () => {
    (mockClient.getEngine as any).mockImplementation((env: any) => {
      if (env.projectId === 'source-proj') {
        return Promise.resolve({
          name: 'projects/source-proj/engines/source-engine',
          dataStoreIds: ['github_1773757636775_issue', 'github_1773757636775_pull_request', 'github_1773757636775_repository']
        });
      }
      return Promise.resolve({
        name: 'projects/target-proj/engines/target-engine',
        dataStoreIds: ['github_1780931139999_issue', 'github_1780931139999_pull_request', 'github_1780931139999_repository']
      });
    });

    (mockClient as any).listCollections = vi.fn().mockImplementation((env: any) => {
      if (env.projectId === 'source-proj') {
        return Promise.resolve([
          {
            name: 'projects/source-proj/locations/global/collections/github_1773757636775',
            displayName: 'GitHub Connector',
            dataConnector: {
              dataSource: 'github',
              entities: [
                { entityName: 'issue', dataStore: 'projects/source-proj/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_issue' },
                { entityName: 'pull_request', dataStore: 'projects/source-proj/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_pull_request' },
                { entityName: 'repository', dataStore: 'projects/source-proj/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_repository' }
              ]
            }
          },
          {
            name: 'projects/source-proj/locations/global/collections/servicenow_1773757000111',
            displayName: 'ServiceNow Connector',
            dataConnector: {
              dataSource: 'servicenow',
              entities: [
                { entityName: 'incident', dataStore: 'projects/source-proj/locations/global/collections/servicenow_1773757000111/dataStores/servicenow_1773757000111_incident' }
              ]
            }
          }
        ]);
      }
      return Promise.resolve([
        {
          name: 'projects/target-proj/locations/global/collections/github_1780931139999',
          displayName: 'GitHub Connector',
          dataConnector: {
            dataSource: 'github',
            entities: [
              { entityName: 'issue', dataStore: 'projects/target-proj/locations/global/collections/github_1780931139999/dataStores/github_1780931139999_issue' },
              { entityName: 'pull_request', dataStore: 'projects/target-proj/locations/global/collections/github_1780931139999/dataStores/github_1780931139999_pull_request' },
              { entityName: 'repository', dataStore: 'projects/target-proj/locations/global/collections/github_1780931139999/dataStores/github_1780931139999_repository' }
            ]
          }
        }
      ]);
    });

    (mockClient.listDataStores as any).mockImplementation((env: any) => {
      if (env.projectId === 'source-proj') {
        return Promise.resolve([
          { name: 'projects/source-proj/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_issue', displayName: 'GitHub Issues' },
          { name: 'projects/source-proj/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_pull_request', displayName: 'GitHub PRs' },
          { name: 'projects/source-proj/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_repository', displayName: 'GitHub Repos' }
        ]);
      }
      return Promise.resolve([
        { name: 'projects/target-proj/locations/global/collections/github_1780931139999/dataStores/github_1780931139999_issue', displayName: 'GitHub Issues' },
        { name: 'projects/target-proj/locations/global/collections/github_1780931139999/dataStores/github_1780931139999_pull_request', displayName: 'GitHub PRs' },
        { name: 'projects/target-proj/locations/global/collections/github_1780931139999/dataStores/github_1780931139999_repository', displayName: 'GitHub Repos' }
      ]);
    });

    (mockClient.detectEngineIdpConfig as any).mockResolvedValue({ idpType: 'GOOGLE_CLOUD_IDENTITY' });

    const result = await auditEngine.runAudit({
      ...mockConfig,
      datastoreMapping: {},
      collectionMapping: {}
    });

    expect(result.connectorMappings).toBeDefined();
    const ghMapping = result.connectorMappings?.entries.find(m => m.sourceId === 'github_1773757636775');
    expect(ghMapping?.matchStatus).toBe('AUTO_MATCHED');
    expect(ghMapping?.targetId).toBe('github_1780931139999');

    const snowMapping = result.connectorMappings?.entries.find(m => m.sourceId === 'servicenow_1773757000111');
    expect(snowMapping?.matchStatus).toBe('NEEDS_HITL');

    // Auto-mapped child entity DataStores should be marked as MATCH in parity items
    const issueItem = result.items.find(i => i.id === 'datastore-github_1773757636775_issue');
    expect(issueItem?.status).toBe('MATCH');
    expect(issueItem?.details).toContain('Auto-mapped');
  });
});

