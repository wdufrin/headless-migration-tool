import { describe, it, expect } from 'vitest';
import {
  buildConnectorAndDataStoreMappings,
  parseTimestampedResourceId,
  validateConnectorOrDataStoreId
} from '../src/services/connectorMatcher.js';

describe('Connector and DataStore Matching Logic', () => {
  it('should flag the connector as not matching (NEEDS_HITL) and list missing datastores when target connector is missing underlying entity DataStores', () => {
    // Source connector has 3 entity DataStores: issue, pull_request, repository
    // Target candidate has matching base name but is missing 'pull_request' and 'issue'
    const result = buildConnectorAndDataStoreMappings({
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
        }
      ],
      targetCollections: [
        {
          name: 'projects/tgt/locations/global/collections/github_1780931139999',
          displayName: 'GitHub Enterprise',
          dataConnector: {
            dataSource: 'github',
            entities: [
              // Target ONLY has repository; missing issue and pull_request
              { entityName: 'repository', dataStore: 'projects/tgt/locations/global/collections/github_1780931139999/dataStores/github_1780931139999_repository' }
            ]
          }
        }
      ],
      sourceDataStores: [
        { name: 'projects/src/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_issue', displayName: 'Issues' },
        { name: 'projects/src/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_pull_request', displayName: 'Pull Requests' },
        { name: 'projects/src/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_repository', displayName: 'Repositories' }
      ],
      targetDataStores: [
        { name: 'projects/tgt/locations/global/collections/github_1780931139999/dataStores/github_1780931139999_repository', displayName: 'Repositories' },
        // Distractor: a standalone target datastore that happens to be named 'github_issue'
        { name: 'projects/tgt/locations/global/dataStores/standalone_issue', displayName: 'github_issue' }
      ]
    });

    const ghEntry = result.entries.find(e => e.sourceId === 'github_1773757636775');
    expect(ghEntry).toBeDefined();
    // Must flag the connector itself as not matching
    expect(ghEntry?.matchStatus).toBe('NEEDS_HITL');
    expect(ghEntry?.missingEntities).toEqual(['issue', 'pull_request']);
    expect(ghEntry?.missingDataStoreIds).toEqual([
      'github_1773757636775_issue',
      'github_1773757636775_pull_request'
    ]);
    expect(ghEntry?.matchReason).toContain('missing required underlying entity DataStore(s)');
    expect(ghEntry?.matchReason).toContain('"issue"');
    expect(ghEntry?.matchReason).toContain('"pull_request"');
    expect(ghEntry?.matchReason).toContain('Direct matching of underlying DataStores is skipped');

    // Do NOT match underlying DataStores directly to arbitrary standalone DataStores
    expect(result.datastoreMapping['github_1773757636775_issue']).toBeUndefined();
    expect(result.datastoreMapping['github_1773757636775_pull_request']).toBeUndefined();
    expect(result.collectionMapping['github_1773757636775']).toBeUndefined();
  });

  it('should flag the connector as not matching when exact collection ID exists in target but is missing underlying DataStores', () => {
    const result = buildConnectorAndDataStoreMappings({
      sourceCollections: [
        {
          name: 'projects/src/locations/global/collections/jira_1773757000000',
          displayName: 'Jira Software',
          dataConnector: {
            dataSource: 'jira',
            entities: [
              { entityName: 'issue', dataStore: 'projects/src/locations/global/collections/jira_1773757000000/dataStores/jira_1773757000000_issue' },
              { entityName: 'project', dataStore: 'projects/src/locations/global/collections/jira_1773757000000/dataStores/jira_1773757000000_project' }
            ]
          }
        }
      ],
      targetCollections: [
        {
          // Target has exact same collection ID but only 1 entity
          name: 'projects/tgt/locations/global/collections/jira_1773757000000',
          displayName: 'Jira Software',
          dataConnector: {
            dataSource: 'jira',
            entities: [
              { entityName: 'project', dataStore: 'projects/tgt/locations/global/collections/jira_1773757000000/dataStores/jira_1773757000000_project' }
            ]
          }
        }
      ],
      sourceDataStores: [
        { name: 'projects/src/locations/global/collections/jira_1773757000000/dataStores/jira_1773757000000_issue', displayName: 'Issues' },
        { name: 'projects/src/locations/global/collections/jira_1773757000000/dataStores/jira_1773757000000_project', displayName: 'Projects' }
      ],
      targetDataStores: [
        { name: 'projects/tgt/locations/global/collections/jira_1773757000000/dataStores/jira_1773757000000_project', displayName: 'Projects' }
      ]
    });

    const jiraEntry = result.entries.find(e => e.sourceId === 'jira_1773757000000');
    expect(jiraEntry?.matchStatus).toBe('NEEDS_HITL');
    expect(jiraEntry?.matchReason).toContain('has matching ID but is missing required underlying entity DataStore(s)');
    expect(jiraEntry?.missingEntities).toEqual(['issue']);
    expect(jiraEntry?.missingDataStoreIds).toEqual(['jira_1773757000000_issue']);
    expect(result.collectionMapping['jira_1773757000000']).toBeUndefined();
    expect(result.datastoreMapping['jira_1773757000000_issue']).toBeUndefined();
  });

  it('should auto-map to the candidate that has all underlying DataStores when multiple target candidates exist', () => {
    const result = buildConnectorAndDataStoreMappings({
      sourceCollections: [
        {
          name: 'projects/src/locations/global/collections/github_1773757636775',
          displayName: 'GitHub Enterprise',
          dataConnector: {
            dataSource: 'github',
            entities: [
              { entityName: 'issue', dataStore: 'projects/src/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_issue' },
              { entityName: 'pull_request', dataStore: 'projects/src/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_pull_request' }
            ]
          }
        }
      ],
      targetCollections: [
        {
          // Candidate A: incomplete (has only issue)
          name: 'projects/tgt/locations/global/collections/github_1780000000001',
          displayName: 'GitHub Enterprise',
          dataConnector: {
            dataSource: 'github',
            entities: [
              { entityName: 'issue', dataStore: 'projects/tgt/locations/global/collections/github_1780000000001/dataStores/github_1780000000001_issue' }
            ]
          }
        },
        {
          // Candidate B: complete (has both issue and pull_request)
          name: 'projects/tgt/locations/global/collections/github_1780000000002',
          displayName: 'GitHub Enterprise',
          dataConnector: {
            dataSource: 'github',
            entities: [
              { entityName: 'issue', dataStore: 'projects/tgt/locations/global/collections/github_1780000000002/dataStores/github_1780000000002_issue' },
              { entityName: 'pull_request', dataStore: 'projects/tgt/locations/global/collections/github_1780000000002/dataStores/github_1780000000002_pull_request' }
            ]
          }
        }
      ]
    });

    const ghEntry = result.entries.find(e => e.sourceId === 'github_1773757636775');
    expect(ghEntry?.matchStatus).toBe('AUTO_MATCHED');
    expect(ghEntry?.targetId).toBe('github_1780000000002');
    expect(result.collectionMapping['github_1773757636775']).toBe('github_1780000000002');
    expect(result.datastoreMapping['github_1773757636775_issue']).toBe('github_1780000000002_issue');
    expect(result.datastoreMapping['github_1773757636775_pull_request']).toBe('github_1780000000002_pull_request');
  });

  it('should only match datastore to datastore if they are NOT part of a connector', () => {
    const result = buildConnectorAndDataStoreMappings({
      sourceCollections: [
        {
          name: 'projects/src/locations/global/collections/github_1773757636775',
          displayName: 'GitHub Enterprise',
          dataConnector: {
            dataSource: 'github',
            entities: [
              { entityName: 'repository', dataStore: 'projects/src/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_repository' }
            ]
          }
        }
      ],
      targetCollections: [],
      sourceDataStores: [
        // Connector entity datastore
        { name: 'projects/src/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_repository', displayName: 'Repositories' },
        // Standalone datastore
        { name: 'projects/src/locations/global/dataStores/company_policies_1773757111111', displayName: 'Company Policies' }
      ],
      targetDataStores: [
        // Standalone target datastore matching base name
        { name: 'projects/tgt/locations/global/dataStores/company_policies_1780931222222', displayName: 'Company Policies' },
        // Target connector entity datastore (should never match a standalone source)
        { name: 'projects/tgt/locations/global/collections/other_12345/dataStores/other_12345_repository', displayName: 'Repositories' }
      ]
    });

    // Connector github_1773757636775 has no target connector -> NEEDS_HITL
    const ghEntry = result.entries.find(e => e.sourceId === 'github_1773757636775');
    expect(ghEntry?.matchStatus).toBe('NEEDS_HITL');

    // Connector entity DataStore MUST NOT be matched datastore to datastore
    expect(result.datastoreMapping['github_1773757636775_repository']).toBeUndefined();
    expect(result.entries.find(e => e.sourceId === 'github_1773757636775_repository')).toBeUndefined();

    // Standalone DataStore MUST be matched datastore to datastore
    const standaloneEntry = result.entries.find(e => e.sourceId === 'company_policies_1773757111111');
    expect(standaloneEntry).toBeDefined();
    expect(standaloneEntry?.kind).toBe('DATASTORE');
    expect(standaloneEntry?.matchStatus).toBe('AUTO_MATCHED');
    expect(standaloneEntry?.targetId).toBe('company_policies_1780931222222');
    expect(result.datastoreMapping['company_policies_1773757111111']).toBe('company_policies_1780931222222');
  });

  it('should flag operator HITL selection as NEEDS_HITL if selected target connector is missing underlying DataStores', () => {
    const result = buildConnectorAndDataStoreMappings({
      sourceCollections: [
        {
          name: 'projects/src/locations/global/collections/github_1773757636775',
          displayName: 'GitHub Enterprise',
          dataConnector: {
            dataSource: 'github',
            entities: [
              { entityName: 'issue', dataStore: 'projects/src/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_issue' },
              { entityName: 'pull_request', dataStore: 'projects/src/locations/global/collections/github_1773757636775/dataStores/github_1773757636775_pull_request' }
            ]
          }
        }
      ],
      targetCollections: [
        {
          name: 'projects/tgt/locations/global/collections/custom_target_gh',
          displayName: 'Custom GitHub Target',
          dataConnector: {
            dataSource: 'github',
            entities: [
              { entityName: 'issue', dataStore: 'projects/tgt/locations/global/collections/custom_target_gh/dataStores/custom_target_gh_issue' }
            ]
          }
        }
      ],
      existingCollectionMapping: {
        'github_1773757636775': 'custom_target_gh'
      }
    });

    const entry = result.entries.find(e => e.sourceId === 'github_1773757636775');
    expect(entry?.matchStatus).toBe('NEEDS_HITL');
    expect(entry?.matchReason).toContain('selected via HITL is missing required underlying entity DataStore(s): "pull_request"');
    expect(entry?.missingEntities).toEqual(['pull_request']);
    expect(result.collectionMapping['github_1773757636775']).toBeUndefined();
    expect(result.datastoreMapping['github_1773757636775_pull_request']).toBeUndefined();
    // Only the existing entity is mapped
    expect(result.datastoreMapping['github_1773757636775_issue']).toBe('custom_target_gh_issue');
  });
});
