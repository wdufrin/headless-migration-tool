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
});
