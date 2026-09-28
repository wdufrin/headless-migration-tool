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
});

