import { describe, it, expect } from 'vitest';
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

    expect(payload.displayName).toBe('[Replace] HR Benefits Assistant');
    expect(payload.dataStoreConnections[0].dataStore).toBe(
      'projects/fedex-prod-project/locations/global/collections/default_collection/dataStores/prod-benefits-ds'
    );
    expect(payload.adkAgentDefinition.enginePath).toContain('fedex-prod-project');
    expect(payload.adkAgentDefinition.enginePath).toContain('prod_engine_1');
    expect(payload.adkAgentDefinition.instructions).toContain('prod-benefits-ds');
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
});
