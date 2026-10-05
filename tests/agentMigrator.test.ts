import { describe, it, expect, vi } from 'vitest';
import { AgentMigrator } from '../src/engines/agentMigrator.js';
import { DiscoveryEngineClient } from '../src/services/discoveryEngine.js';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import { Agent } from '../src/types/index.js';

describe('AgentMigrator Engine', () => {
  const dummyAuth = new GcpAuthService({ staticToken: 'test-token' });
  const dummyClient = new DiscoveryEngineClient(dummyAuth);
  const migrator = new AgentMigrator(dummyClient);

  const sourceEnv = {
    projectId: 'fedex-test-project',
    appLocation: 'global',
    collectionId: 'default_collection',
    appId: 'test_engine_1',
    assistantId: 'default_assistant'
  };

  const targetEnv = {
    projectId: 'fedex-prod-project',
    appLocation: 'global',
    collectionId: 'default_collection',
    appId: 'prod_engine_1',
    assistantId: 'default_assistant'
  };

  it('should remap datastores, project IDs, and engine IDs in agent payloads', () => {
    const sourceAgent: Agent = {
      name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/agent-123',
      displayName: 'HR Benefits Assistant',
      description: 'Helps employees navigate benefits.',
      dataStoreConnections: [
        {
          dataStore: 'projects/fedex-test-project/locations/global/collections/default_collection/dataStores/test-benefits-ds'
        }
      ],
      adkAgentDefinition: {
        agentName: 'hr_benefits',
        enginePath: 'projects/fedex-test-project/locations/global/collections/default_collection/engines/test_engine_1',
        instructions: 'Use datastore test-benefits-ds for answers.'
      }
    };

    const datastoreMapping = {
      'test-benefits-ds': 'prod-benefits-ds'
    };

    const payload = migrator.buildAgentPayload(sourceAgent, sourceEnv, targetEnv, datastoreMapping);

    expect(payload.displayName).toBe('HR Benefits Assistant');
    expect(payload.dataStoreConnections[0].dataStore).toBe(
      'projects/fedex-prod-project/locations/global/collections/default_collection/dataStores/prod-benefits-ds'
    );
    expect(payload.adkAgentDefinition.enginePath).toContain('fedex-prod-project');
    expect(payload.adkAgentDefinition.enginePath).toContain('prod_engine_1');
    expect(payload.adkAgentDefinition.instructions).toBe('Use datastore test-benefits-ds for answers.');
  });

  it('should filter agents by user IAM policy bindings', () => {
    const agentWithIam: Agent = {
      name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/agent-456',
      displayName: 'Supply Chain Tracker',
      iamPolicy: {
        bindings: [
          {
            role: 'roles/discoveryengine.agentOwner',
            members: ['user:bob@fedex.com']
          }
        ]
      }
    };

    expect(migrator.isAgentOwnedByUser(agentWithIam, ['bob@fedex.com'])).toBe(true);
    expect(migrator.isAgentOwnedByUser(agentWithIam, ['*@fedex.com'])).toBe(true);
    expect(migrator.isAgentOwnedByUser(agentWithIam, ['alice@fedex.com'])).toBe(false);
  });

  it('should filter agents with multiple owners in agentOwner IAM binding (Fix 2.6)', () => {
    const multiOwnerAgent: Agent = {
      name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/agent-789',
      displayName: 'Multi-Owner Analytics Agent',
      iamPolicy: {
        bindings: [
          {
            role: 'roles/discoveryengine.agentOwner',
            members: ['user:primary@fedex.com', 'user:secondary@fedex.com']
          }
        ]
      }
    };

    expect(migrator.isAgentOwnedByUser(multiOwnerAgent, ['primary@fedex.com'])).toBe(true);
    expect(migrator.isAgentOwnedByUser(multiOwnerAgent, ['secondary@fedex.com'])).toBe(true);
    expect(migrator.isAgentOwnedByUser(multiOwnerAgent, ['other@fedex.com'])).toBe(false);
  });

  it('should filter agents owned by Workforce Identity Federation (WiF) principals', () => {
    const wifAgent: Agent = {
      name: 'projects/123/locations/eu/collections/default_collection/engines/entraid-test/assistants/default_assistant/agents/agent-wif-1',
      displayName: 'Entra Connected Agent',
      iamPolicy: {
        bindings: [
          {
            role: 'roles/discoveryengine.agentOwner',
            members: ['principal://iam.googleapis.com/locations/global/workforcePools/wdufrin-entra/subject/wdufrin@wdufrin.onmicrosoft.com']
          }
        ]
      }
    };

    expect(migrator.isAgentOwnedByUser(wifAgent, ['wdufrin@wdufrin.onmicrosoft.com'])).toBe(true);
    expect(migrator.isAgentOwnedByUser(wifAgent, ['*@wdufrin.onmicrosoft.com'])).toBe(true);
    expect(migrator.isAgentOwnedByUser(wifAgent, ['other@domain.com'])).toBe(false);
  });

  it('should correctly map Workforce Identity Federation IAM members to Cloud Identity user prefixes', async () => {
    const { mapIamMember } = await import('../src/engines/agentMigrator.js');
    const mapping = {
      'wdufrin@wdufrin.onmicrosoft.com': 'admin@wdufrin.altostrat.com'
    };

    const wifPrincipal = 'principal://iam.googleapis.com/locations/global/workforcePools/wdufrin-entra/subject/wdufrin@wdufrin.onmicrosoft.com';
    const mapped = mapIamMember(wifPrincipal, mapping);
    expect(mapped).toBe('user:admin@wdufrin.altostrat.com');

    const standardUser = 'user:bob@oldcorp.com';
    const mappedUser = mapIamMember(standardUser, { 'bob@oldcorp.com': 'bob@newcorp.com' });
    expect(mappedUser).toBe('user:bob@newcorp.com');
  });

  it('should extract user identities across various IdP formats using extractUserIdentity', async () => {
    const { extractUserIdentity } = await import('../src/routes/discovery.js');

    expect(extractUserIdentity('principal://iam.googleapis.com/locations/global/workforcePools/wdufrin-entra/subject/wdufrin@wdufrin.onmicrosoft.com')).toBe('wdufrin@wdufrin.onmicrosoft.com');
    expect(extractUserIdentity('principal://iam.googleapis.com/locations/global/workforcePools/wdufrin-entra/subject/wdufrin%40wdufrin.onmicrosoft.com')).toBe('wdufrin@wdufrin.onmicrosoft.com');
    expect(extractUserIdentity('principalSet://iam.googleapis.com/locations/global/workforcePools/wdufrin-entra/attribute.user_email/alice@domain.com')).toBe('alice@domain.com');
    expect(extractUserIdentity('user:admin@wdufrin.altostrat.com')).toBe('admin@wdufrin.altostrat.com');
    expect(extractUserIdentity('admin@wdufrin.altostrat.com')).toBe('admin@wdufrin.altostrat.com');
    expect(extractUserIdentity('serviceAccount:sa@project.iam.gserviceaccount.com')).toBeNull();
    expect(extractUserIdentity('allUsers')).toBeNull();
  });

  it('should preserve private scope by default for unshared agents (Fix 1.2)', async () => {
    const patchSpy = vi.fn().mockResolvedValue({});
    const unsharedAgent: Agent = {
      name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/unshared-1',
      displayName: 'Confidential Strategy Agent',
      owner: 'alice@fedex.com'
      // sharingConfig omitted / undefined
    };

    dummyClient.listAgents = vi.fn().mockResolvedValue([unsharedAgent]);
    dummyClient.getAgentIamPolicy = vi.fn().mockResolvedValue({ bindings: [] });
    dummyClient.createAgent = vi.fn().mockResolvedValue({
      name: 'projects/fedex-prod-project/locations/global/collections/default_collection/engines/prod_engine_1/assistants/default_assistant/agents/new-agent-1'
    });
    dummyClient.patchAgentSharing = patchSpy;

    const options = {
      dryRun: false,
      preserveOwnership: true,
      preserveSharing: false,
      concurrency: 1
    };

    await migrator.migrateAgents(
      sourceEnv,
      targetEnv,
      options,
      {},
      {},
      { 'alice@fedex.com': 'alice@fedex.com' }
    );

    // Unshared agents MUST NOT be patched with scope: ALL_USERS
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('should not match user filter when user is merely an agentUser and an explicit owner exists', () => {
    const sharedAgent: Agent = {
      name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/weather-agent',
      displayName: 'Get Current Weather',
      iamPolicy: {
        bindings: [
          {
            role: 'roles/discoveryengine.agentOwner',
            members: ['user:bryankelly@company.com']
          },
          {
            role: 'roles/discoveryengine.agentUser',
            members: ['user:admin@wdufrin.altostrat.com']
          }
        ]
      }
    };

    // bryankelly owns the agent
    expect(migrator.isAgentOwnedByUser(sharedAgent, ['bryankelly@company.com'])).toBe(true);
    // admin is only a user, NOT the owner, so filtering to admin must return false
    expect(migrator.isAgentOwnedByUser(sharedAgent, ['admin@wdufrin.altostrat.com'])).toBe(false);
  });

  it('should rewrite relative collections/{id}/dataConnector AND all 3 child entity dataStoreSpecs together so 1 Connector source does not split into 3 sources', () => {
    const noCodeGithubAgent: Agent = {
      name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/nocode-gh-1',
      displayName: 'GitHub PR Helper',
      lowCodeAgentDefinition: {
        nodes: [
          {
            id: 'node-1',
            llmAgentNode: {
              instruction: 'Answer questions about issues, PRs, and repositories.',
              selectedTools: {
                dataConnectors: [
                  {
                    // Note: Discovery Engine stores relative path WITHOUT leading slash!
                    name: 'collections/github_1773757636775/dataConnector',
                    dataSource: 'github'
                  }
                ],
                dataStoreSpecs: {
                  specs: [
                    {
                      dataStore: 'projects/fedex-test-project/locations/global/collections/default_collection/dataStores/github_1773757636775_issue'
                    },
                    {
                      dataStore: 'projects/fedex-test-project/locations/global/collections/default_collection/dataStores/github_1773757636775_pull_request'
                    },
                    {
                      dataStore: 'projects/fedex-test-project/locations/global/collections/default_collection/dataStores/github_1773757636775_repository'
                    }
                  ]
                }
              }
            }
          }
        ]
      }
    };

    // Even if only collectionMapping is provided, buildAgentPayload synchronizes child entity dataStores
    const payload = migrator.buildAgentPayload(
      noCodeGithubAgent,
      sourceEnv,
      targetEnv,
      {},
      { 'github_1773757636775': 'github_1780931139999' },
      {}
    );

    const tools = payload.lowCodeAgentDefinition.nodes[0].llmAgentNode.selectedTools;
    expect(tools.dataConnectors).toHaveLength(1);
    expect(tools.dataConnectors[0].name).toBe('collections/github_1780931139999/dataConnector');

    expect(tools.dataStoreSpecs.specs).toHaveLength(3);
    expect(tools.dataStoreSpecs.specs.map((s: any) => s.dataStore)).toEqual([
      'projects/fedex-prod-project/locations/global/collections/default_collection/dataStores/github_1780931139999_issue',
      'projects/fedex-prod-project/locations/global/collections/default_collection/dataStores/github_1780931139999_pull_request',
      'projects/fedex-prod-project/locations/global/collections/default_collection/dataStores/github_1780931139999_repository'
    ]);
  });

  it('should strip dataConnectors and child entity dataStoreSpecs when mapped to __STRIP__', () => {
    const noCodeAgent: Agent = {
      name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/nocode-strip-1',
      displayName: 'Multi-Source Agent',
      lowCodeAgentDefinition: {
        nodes: [
          {
            id: 'node-1',
            llmAgentNode: {
              selectedTools: {
                dataConnectors: [
                  { name: 'collections/github_1773757636775/dataConnector', dataSource: 'github' },
                  { name: 'collections/jira_1773757999999/dataConnector', dataSource: 'jira' }
                ],
                dataStoreSpecs: {
                  specs: [
                    { dataStore: 'projects/fedex-test-project/locations/global/collections/default_collection/dataStores/github_1773757636775_issue' },
                    { dataStore: 'projects/fedex-test-project/locations/global/collections/default_collection/dataStores/github_1773757636775_pull_request' },
                    { dataStore: 'projects/fedex-test-project/locations/global/collections/default_collection/dataStores/jira_1773757999999_issue' }
                  ]
                }
              }
            }
          }
        ]
      }
    };

    const payload = migrator.buildAgentPayload(
      noCodeAgent,
      sourceEnv,
      targetEnv,
      {},
      {
        'github_1773757636775': '__STRIP__',
        'jira_1773757999999': 'jira_1780000111111'
      },
      {}
    );

    const tools = payload.lowCodeAgentDefinition.nodes[0].llmAgentNode.selectedTools;
    expect(tools.dataConnectors).toHaveLength(1);
    expect(tools.dataConnectors[0].name).toBe('collections/jira_1780000111111/dataConnector');
    expect(tools.dataStoreSpecs.specs).toHaveLength(1);
    expect(tools.dataStoreSpecs.specs[0].dataStore).toBe(
      'projects/fedex-prod-project/locations/global/collections/default_collection/dataStores/jira_1780000111111_issue'
    );
  });

  it('should auto-map _##### connectors and invoke onConnectorHitlPrompt when an agent connector is ambiguous or missing', async () => {
    const {
      parseTimestampedResourceId,
      validateConnectorOrDataStoreId,
      buildConnectorAndDataStoreMappings
    } = await import('../src/services/connectorMatcher.js');

    // 1. Verify regex pattern matching on timestamped IDs
    expect(parseTimestampedResourceId('github_1773757636775')).toEqual({
      rawId: 'github_1773757636775',
      baseName: 'github',
      separator: '_',
      instanceNumericId: '1773757636775',
      entitySuffix: undefined,
      parentCollectionId: undefined,
      normalizedBase: 'github',
      normalizedFullKey: 'github'
    });
    expect(parseTimestampedResourceId('github_1773757636775_pull_request')).toEqual({
      rawId: 'github_1773757636775_pull_request',
      baseName: 'github',
      separator: '_',
      instanceNumericId: '1773757636775',
      entitySuffix: 'pull_request',
      parentCollectionId: 'github_1773757636775',
      normalizedBase: 'github',
      normalizedFullKey: 'github__pull_request'
    });

    // 2. Negative / adversarial input validation tests
    expect(() => validateConnectorOrDataStoreId('', 'sourceId')).toThrow(/must be a non-empty string/);
    expect(() => validateConnectorOrDataStoreId('../etc/passwd', 'sourceId')).toThrow(/path traversal or slash characters are forbidden/);
    expect(() => validateConnectorOrDataStoreId('collections/github_123', 'sourceId')).toThrow(/path traversal or slash characters are forbidden/);
    expect(() => validateConnectorOrDataStoreId('github_123; rm -rf', 'sourceId')).toThrow(/must contain only alphanumeric characters/);

    // 3. Verify buildConnectorAndDataStoreMappings auto-maps unique _##### match and flags ambiguous/missing as NEEDS_HITL
    const mappings = buildConnectorAndDataStoreMappings({
      sourceCollections: [
        {
          name: 'projects/src/locations/global/collections/github_1773757636775',
          displayName: 'GitHub Enterprise',
          dataConnector: {
            dataSource: 'github',
            entities: [
              { entityName: 'issue', dataStore: 'projects/src/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_issue' },
              { entityName: 'pull_request', dataStore: 'projects/src/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_pull_request' },
              { entityName: 'repository', dataStore: 'projects/src/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_repository' }
            ]
          }
        },
        {
          name: 'projects/src/locations/global/collections/slack_1773757111111',
          displayName: 'Corp Slack',
          dataConnector: { dataSource: 'slack', entities: [] }
        }
      ],
      targetCollections: [
        {
          name: 'projects/tgt/locations/global/collections/github_1780931139999',
          displayName: 'GitHub Enterprise',
          dataConnector: {
            dataSource: 'github',
            entities: [
              { entityName: 'issue', dataStore: 'projects/tgt/locations/global/collections/github_1780931139999/dataStores/github_1780931139999_issue' },
              { entityName: 'pull_request', dataStore: 'projects/tgt/locations/global/collections/github_1780931139999/dataStores/github_1780931139999_pull_request' },
              { entityName: 'repository', dataStore: 'projects/tgt/locations/global/collections/github_1780931139999/dataStores/github_1780931139999_repository' }
            ]
          }
        }
      ],
      sourceDataStores: [],
      targetDataStores: []
    });

    const ghEntry = mappings.entries.find(e => e.sourceId === 'github_1773757636775');
    expect(ghEntry?.matchStatus).toBe('AUTO_MATCHED');
    expect(ghEntry?.targetId).toBe('github_1780931139999');
    expect(ghEntry?.entityMappings).toHaveLength(3);
    expect(mappings.datastoreMapping['github_1773757636775_issue']).toBe('github_1780931139999_issue');
    expect(mappings.datastoreMapping['github_1773757636775_pull_request']).toBe('github_1780931139999_pull_request');
    expect(mappings.datastoreMapping['github_1773757636775_repository']).toBe('github_1780931139999_repository');

    const slackEntry = mappings.entries.find(e => e.sourceId === 'slack_1773757111111');
    expect(slackEntry?.matchStatus).toBe('NEEDS_HITL');
    expect(slackEntry?.targetId).toBeUndefined();
  });

  it('should skip undeployed Draft agents ("My Agent" / "My Workflow") while migrating Private (created/deployed) and Published/Shared agents when excludeDraftAgents is true', async () => {
    const draftLowCodeAgent: Agent = {
      name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/draft-lc-1',
      displayName: 'My Agent',
      state: 'PRIVATE',
      owner: 'alice@fedex.com',
      lowCodeAgentDefinition: {
        nodes: [{ id: '1', displayName: 'Start', llmAgentNode: { description: 'Root Agent', instruction: '' } }],
        rootAgentId: '1'
        // No deployedNodes or deployedRootAgentId -> Unsaved/undeployed UI draft
      }
    };

    const draftWorkflowAgent: Agent = {
      name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/draft-wf-1',
      displayName: 'My Workflow',
      state: 'PRIVATE',
      owner: 'alice@fedex.com',
      workflowAgentDefinition: {
        agentFlow: { steps: [] }
        // No deployedAgentFlow or activeRevision -> Undeployed workflow draft
      } as any
    };

    const privateCreatedLowCodeAgent: Agent = {
      name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/private-lc-1',
      displayName: 'Personal Executive Briefing Agent',
      state: 'PRIVATE',
      owner: 'alice@fedex.com',
      lowCodeAgentDefinition: {
        nodes: [{ id: '1', displayName: 'Start', llmAgentNode: { instruction: 'Summarize executive notes.' } }],
        rootAgentId: '1',
        deployedNodes: [{ id: '1', displayName: 'Start', llmAgentNode: { instruction: 'Summarize executive notes.' } }],
        deployedRootAgentId: '1'
      } as any
    };

    const publishedSharedAgent: Agent = {
      name: 'projects/123/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/published-1',
      displayName: 'Org-Wide HR Policy Assistant',
      state: 'ENABLED',
      owner: 'alice@fedex.com',
      sharingConfig: { scope: 'ALL_USERS' },
      lowCodeAgentDefinition: {
        nodes: [{ id: '1', displayName: 'Start', llmAgentNode: { instruction: 'Answer HR questions.' } }],
        rootAgentId: '1',
        deployedNodes: [{ id: '1', displayName: 'Start', llmAgentNode: { instruction: 'Answer HR questions.' } }]
      }
    };

    // Direct classification checks
    expect(migrator.isSourceAgentDraft(draftLowCodeAgent)).toBe(true);
    expect(migrator.isSourceAgentPublished(draftLowCodeAgent)).toBe(false);
    expect(migrator.isSourceAgentDraft(draftWorkflowAgent)).toBe(true);
    expect(migrator.isSourceAgentPublished(draftWorkflowAgent)).toBe(false);
    expect(migrator.isSourceAgentDraft(privateCreatedLowCodeAgent)).toBe(false);
    expect(migrator.isSourceAgentPublished(privateCreatedLowCodeAgent)).toBe(true);
    expect(migrator.isSourceAgentDraft(publishedSharedAgent)).toBe(false);
    expect(migrator.isSourceAgentPublished(publishedSharedAgent)).toBe(true);

    // End-to-end migrateAgents filtering with excludeDraftAgents: true
    dummyClient.listAgents = vi.fn().mockResolvedValue([
      draftLowCodeAgent,
      draftWorkflowAgent,
      privateCreatedLowCodeAgent,
      publishedSharedAgent
    ]);
    dummyClient.getAgentIamPolicy = vi.fn().mockResolvedValue({ bindings: [] });

    const results = await migrator.migrateAgents(
      sourceEnv,
      targetEnv,
      {
        dryRun: true,
        excludeDraftAgents: true,
        userFilter: ['alice@fedex.com']
      }
    );

    expect(results).toHaveLength(2);
    expect(results.map(r => r.displayName)).toEqual([
      'Personal Executive Briefing Agent',
      'Org-Wide HR Policy Assistant'
    ]);
  });

  it('should explicitly reject invalid excludeDraftAgents and agentStatusFilter values in MigrationOptionsSchema (negative test)', async () => {
    const { MigrationOptionsSchema } = await import('../src/config/configSchema.js');
    expect(() => MigrationOptionsSchema.parse({ excludeDraftAgents: 'true' as any })).toThrow(/Expected boolean/);
    expect(() => MigrationOptionsSchema.parse({ agentStatusFilter: 'INVALID_FILTER' as any })).toThrow(/Invalid enum value/);
  });

  it('should prevent duplicate agent creation on Run #2 using Admin SA listAgents when end-user lacks discoveryengine.agents.manage, and skip setAgentIamPolicy on private agents', async () => {
    const sourceAgent1: Agent = {
      name: 'projects/src/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/src-agent-1',
      displayName: 'Inactive Agent Notifier',
      state: 'PRIVATE',
      lowCodeAgentDefinition: {
        nodes: [{ id: '1', displayName: 'Start', llmAgentNode: { instruction: 'Notify inactive agents.' } }],
        deployedNodes: [{ id: '1', displayName: 'Start', llmAgentNode: { instruction: 'Notify inactive agents.' } }]
      }
    };

    const sourceAgent2: Agent = {
      name: 'projects/src/locations/global/collections/default_collection/engines/test_engine_1/assistants/default_assistant/agents/src-agent-2',
      displayName: 'Shared Name But Owned By Colleague In Target',
      state: 'PRIVATE',
      lowCodeAgentDefinition: {
        nodes: [{ id: '1', displayName: 'Start', llmAgentNode: { instruction: 'Run report.' } }],
        deployedNodes: [{ id: '1', displayName: 'Start', llmAgentNode: { instruction: 'Run report.' } }]
      }
    };

    const existingTargetAgentOwnedByUser: Agent = {
      name: 'projects/fedex-prod-project/locations/global/collections/default_collection/engines/prod_engine_1/assistants/default_assistant/agents/tgt-existing-1',
      displayName: 'Inactive Agent Notifier',
      state: 'PRIVATE'
    };

    const existingTargetAgentOwnedByOtherUser: Agent = {
      name: 'projects/fedex-prod-project/locations/global/collections/default_collection/engines/prod_engine_1/assistants/default_assistant/agents/tgt-colleague-99',
      displayName: 'Shared Name But Owned By Colleague In Target',
      state: 'PRIVATE'
    };

    // Simulate real Discovery Engine behavior:
    // Calling listAgents with a userOwner email throws HTTP 403 (Permission 'discoveryengine.agents.manage' denied),
    // while calling listAgents with undefined (Admin Service Account) succeeds.
    dummyClient.listAgents = vi.fn().mockImplementation(async (env: any, forUserEmail?: string) => {
      if (forUserEmail) {
        const err: any = new Error(
          `Discovery Engine API Request Failed [403]: Permission 'discoveryengine.agents.manage' denied on resource 'projects/${env.projectId}/locations/global/collections/default_collection/engines/${env.appId}/assistants/default_assistant'`
        );
        err.status = 403;
        throw err;
      }
      if (env.projectId === sourceEnv.projectId) {
        return [sourceAgent1, sourceAgent2];
      }
      return [existingTargetAgentOwnedByUser, existingTargetAgentOwnedByOtherUser];
    });

    dummyClient.getAgentIamPolicy = vi.fn().mockImplementation(async (agentName: string) => {
      if (agentName.endsWith('/src-agent-1') || agentName.endsWith('/src-agent-2')) {
        return {
          bindings: [
            {
              role: 'roles/discoveryengine.agentOwner',
              members: ['user:greiler.abrahantes@geappliances.com']
            }
          ]
        };
      }
      if (agentName.endsWith('/tgt-existing-1')) {
        return {
          bindings: [
            {
              role: 'roles/discoveryengine.agentOwner',
              members: ['user:240168547@applhome.com']
            }
          ]
        };
      }
      if (agentName.endsWith('/tgt-colleague-99')) {
        return {
          bindings: [
            {
              role: 'roles/discoveryengine.agentOwner',
              members: ['user:other.colleague@applhome.com']
            }
          ]
        };
      }
      return { bindings: [] };
    });

    const createAgentSpy = vi.fn().mockResolvedValue({
      name: 'projects/fedex-prod-project/locations/global/collections/default_collection/engines/prod_engine_1/assistants/default_assistant/agents/tgt-newly-created-2'
    });
    const setIamSpy = vi.fn().mockRejectedValue(
      new Error('Discovery Engine API Request Failed [400]: Cannot set IAM policy on a private agent.')
    );
    dummyClient.createAgent = createAgentSpy;
    dummyClient.setAgentIamPolicy = setIamSpy;
    dummyClient.publishAgent = vi.fn().mockResolvedValue({});

    const results = await migrator.migrateAgents(
      sourceEnv,
      targetEnv,
      {
        dryRun: false,
        publishAgents: false,
        userFilter: ['greiler.abrahantes@geappliances.com']
      },
      {},
      {},
      { 'greiler.abrahantes@geappliances.com': '240168547@applhome.com' }
    );

    expect(results).toHaveLength(2);
    // 1. "Inactive Agent Notifier" already existed for 240168547@applhome.com -> reused tgt-existing-1 without calling createAgent
    const res1 = results.find(r => r.displayName === 'Inactive Agent Notifier');
    expect(res1?.status).toBe('SUCCESS');
    expect(res1?.targetId).toBe('tgt-existing-1');

    // 2. "Shared Name But Owned By Colleague In Target" belonged to other.colleague@applhome.com -> created a new agent for 240168547@applhome.com
    const res2 = results.find(r => r.displayName === 'Shared Name But Owned By Colleague In Target');
    expect(res2?.status).toBe('SUCCESS');
    expect(res2?.targetId).toBe('tgt-newly-created-2');

    // createAgent must only be called ONCE (for sourceAgent2, NOT for sourceAgent1)
    expect(createAgentSpy).toHaveBeenCalledTimes(1);
    // setAgentIamPolicy must NEVER be called on private agents
    expect(setIamSpy).not.toHaveBeenCalled();
  });
});


