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

import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { EnvironmentConfig, MigrationOptions, MigrationItemResult } from '../types/migration.js';
import { Agent, IamPolicy } from '../types/index.js';
import { mapConcurrent } from '../utils/concurrency.js';
import { logger } from '../utils/logger.js';

export class AgentMigrator {
  private client: DiscoveryEngineClient;

  constructor(client: DiscoveryEngineClient) {
    this.client = client;
  }

  /**
   * Evaluates if an agent matches the specified user filter by inspecting IAM policy bindings or creator metadata.
   */
  isAgentOwnedByUser(agent: Agent, userFilter: string[] = []): boolean {
    if (userFilter.length === 0 || userFilter.includes('*')) {
      return true;
    }

    const members: string[] = [];
    if (agent.iamPolicy?.bindings) {
      for (const b of agent.iamPolicy.bindings) {
        members.push(...b.members);
      }
    }
    if (agent.owner) members.push(agent.owner);

    const lowerFilters = userFilter.map(u => u.toLowerCase().trim());
    return members.some(member => {
      const cleanMember = member.replace(/^user:/i, '').replace(/^serviceAccount:/i, '').toLowerCase().trim();
      return lowerFilters.some(filter => {
        if (filter.startsWith('*@')) {
          const domain = filter.substring(2);
          return cleanMember.endsWith(`@${domain}`);
        }
        return cleanMember === filter;
      });
    });
  }

  /**
   * Deep rewriting of agent definition schemas, datastore URIs, authorizations, and locations.
   */
  buildAgentPayload(
    sourceAgent: Agent,
    sourceEnv: EnvironmentConfig,
    targetEnv: EnvironmentConfig,
    datastoreMapping: Record<string, string> = {},
    collectionMapping: Record<string, string> = {}
  ): any {
    const finalStarterPrompts = (sourceAgent.starterPrompts || [])
      .map(p => (p.text ? p.text.trim() : ''))
      .filter(Boolean)
      .map(text => ({ text }));

    let restoredDisplayName = sourceAgent.displayName;
    if (sourceAgent.dataStoreConnections && sourceAgent.dataStoreConnections.length > 0) {
      restoredDisplayName = `[Replace] ${restoredDisplayName}`;
    }

    const payload: any = {
      displayName: restoredDisplayName,
      description: sourceAgent.description || '',
      icon: sourceAgent.icon || undefined,
      starterPrompts: finalStarterPrompts.length > 0 ? finalStarterPrompts : undefined,
      authorizationConfig: sourceAgent.authorizationConfig,
      authorizations: !sourceAgent.authorizationConfig ? sourceAgent.authorizations : undefined
    };

    // Copy non-blacklisted properties
    const blacklist = [
      'name',
      'createTime',
      'updateTime',
      'agentIdentityInfo',
      'iamPolicy',
      'agentType',
      'disabled',
      'disabledReason',
      'category',
      'agentFiles',
      'activeRevision',
      'targetId'
    ];

    for (const [key, value] of Object.entries(sourceAgent)) {
      if (!blacklist.includes(key) && !(key in payload)) {
        payload[key] = value;
      }
    }

    // 1. Remap DataStore connections
    if (payload.dataStoreConnections && Array.isArray(payload.dataStoreConnections)) {
      const rewrittenConnections = [];
      for (const conn of payload.dataStoreConnections) {
        if (conn.dataStore) {
          const parts = conn.dataStore.split('/');
          const colIndex = parts.indexOf('collections');
          const oldColId = colIndex !== -1 ? parts[colIndex + 1] : 'default_collection';
          const oldDsId = conn.dataStore.split('/').pop();

          if (!oldDsId) {
            rewrittenConnections.push(conn);
            continue;
          }

          const mappedTargetId = datastoreMapping[oldDsId];
          if (mappedTargetId === undefined || mappedTargetId === '') {
            logger.warn(`Datastore "${oldDsId}" is unmapped in target environment. Skipping.`);
            continue;
          }

          const targetLocation = targetEnv.appLocation || 'global';
          const targetCollection = collectionMapping[oldColId] || targetEnv.collectionId || 'default_collection';

          rewrittenConnections.push({
            ...conn,
            dataStore: `projects/${targetEnv.projectId}/locations/${targetLocation}/collections/${targetCollection}/dataStores/${mappedTargetId}`
          });
        } else {
          rewrittenConnections.push(conn);
        }
      }

      // Deduplicate connections
      const seenDataStores = new Set<string>();
      payload.dataStoreConnections = rewrittenConnections.filter(c => {
        if (c.dataStore) {
          if (seenDataStores.has(c.dataStore)) return false;
          seenDataStores.add(c.dataStore);
        }
        return true;
      });
    }

    // 2. Remap Tool Authorizations
    const rewriteAuth = (authName: string) => {
      if (!authName) return authName;
      const authId = authName.split('/').pop();
      return `projects/${targetEnv.projectId}/locations/${targetEnv.appLocation || 'global'}/authorizations/${authId}`;
    };

    if (payload.authorizationConfig?.toolAuthorizations) {
      payload.authorizationConfig.toolAuthorizations = payload.authorizationConfig.toolAuthorizations.map(rewriteAuth);
    }
    if (payload.authorizations) {
      payload.authorizations = payload.authorizations.map(rewriteAuth);
    }

    // 3. Deep string replacements in definition payloads (ADK, LowCode, A2A, Workflow)
    const definitionKeys = Object.keys(payload).filter(key => key.toLowerCase().includes('definition'));
    for (const key of definitionKeys) {
      let definition = payload[key];
      if (definition) {
        definition = JSON.parse(JSON.stringify(definition));
        delete definition.session;
        delete definition.agentFiles;
        delete definition.deployedAgentFiles;
        delete definition.owner;
        delete definition.activeRevision;

        let defStr = JSON.stringify(definition);

        // Project / Location / Engine string replacement
        if (sourceEnv.appId && targetEnv.appId) {
          defStr = defStr.split(sourceEnv.appId).join(targetEnv.appId);
        }
        if (sourceEnv.projectId && targetEnv.projectId) {
          defStr = defStr.split(sourceEnv.projectId).join(targetEnv.projectId);
        }
        if (sourceEnv.appLocation && targetEnv.appLocation) {
          defStr = defStr.split(`/locations/${sourceEnv.appLocation}/`).join(`/locations/${targetEnv.appLocation}/`);
        }

        // Collection remapping
        Object.entries(collectionMapping)
          .sort((a, b) => b[0].length - a[0].length)
          .forEach(([oldCol, newCol]) => {
            defStr = defStr.split(`/collections/${oldCol}/`).join(`/collections/${newCol}/`);
          });

        // DataStore remapping inside definitions
        Object.entries(datastoreMapping)
          .sort((a, b) => b[0].length - a[0].length)
          .forEach(([oldDs, newDs]) => {
            if (newDs) {
              defStr = defStr.split(`/dataStores/${oldDs}`).join(`/dataStores/${newDs}`);
              defStr = defStr.split(oldDs).join(newDs);
            }
          });

        payload[key] = JSON.parse(defStr);
      }
    }

    return payload;
  }

  /**
   * Restores IAM policy bindings to the newly created agent to preserve user access.
   */
  async restoreAgentIamPolicy(
    targetAgentName: string,
    sourcePolicy: IamPolicy,
    targetEnv: EnvironmentConfig,
    identityMapping: Record<string, string> = {}
  ): Promise<void> {
    if (!sourcePolicy?.bindings || sourcePolicy.bindings.length === 0) {
      return;
    }

    const currentPolicy = await this.client.getAgentIamPolicy(targetAgentName, targetEnv);
    const ownerBindings = (currentPolicy.bindings || []).filter(b => b.role === 'roles/discoveryengine.agentOwner');
    
    // Extract shared users from source policy and map to roles/discoveryengine.agentUser
    const sharedUsers: string[] = [];
    (sourcePolicy.bindings || []).forEach(b => {
      if (b.role !== 'roles/discoveryengine.agentOwner') {
        b.members.forEach(m => {
          const mapped = identityMapping[m] || m;
          if (!sharedUsers.includes(mapped)) {
            sharedUsers.push(mapped);
          }
        });
      }
    });

    const finalBindings = [...ownerBindings];
    if (sharedUsers.length > 0) {
      finalBindings.push({
        role: 'roles/discoveryengine.agentUser',
        members: sharedUsers
      });
    }

    const payloadPolicy: IamPolicy = {
      bindings: finalBindings,
      etag: currentPolicy.etag
    };

    await this.client.setAgentIamPolicy(targetAgentName, payloadPolicy, targetEnv);
    logger.info(`IAM permissions and agentUser sharing restored for agent: ${targetAgentName}`);
  }

  /**
   * Helper to detect the agent category.
   */
  getAgentType(agent: Agent): 'LOW_CODE' | 'WORKFLOW' | 'ADK' | 'A2A' | 'OTHER' {
    if (agent.lowCodeAgentDefinition) return 'LOW_CODE';
    if (agent.workflowAgentDefinition) return 'WORKFLOW';
    if (agent.adkAgentDefinition) return 'ADK';
    if (agent.a2aAgentDefinition) return 'A2A';
    return 'OTHER';
  }

  /**
   * Determines if the source agent was in a deployed / published state in the source environment.
   */
  isSourceAgentPublished(agent: Agent): boolean {
    if (agent.state === 'ENABLED') return true;
    if (agent.sharingConfig?.scope === 'ALL_USERS' || agent.sharingConfig?.scope === 'RESTRICTED') return true;
    if (agent.lowCodeAgentDefinition?.deployedNodes && agent.lowCodeAgentDefinition.deployedNodes.length > 0) return true;
    if (agent.activeRevision) return true;
    return false;
  }

  /**
   * Migrates agents from source environment to target environment on behalf of users.
   */
  async migrateAgents(
    sourceEnv: EnvironmentConfig,
    targetEnv: EnvironmentConfig,
    options: MigrationOptions = {},
    datastoreMapping: Record<string, string> = {},
    collectionMapping: Record<string, string> = {},
    identityMapping: Record<string, string> = {}
  ): Promise<MigrationItemResult[]> {
    logger.info(`Discovering agents in source project: ${sourceEnv.projectId} (${sourceEnv.appLocation})...`);
    const sourceAgents = await this.client.listAgents(sourceEnv);
    logger.info(`Found ${sourceAgents.length} total source agents.`);

    // Attach IAM policies for ownership filtering
    for (const agent of sourceAgents) {
      try {
        agent.iamPolicy = await this.client.getAgentIamPolicy(agent.name, sourceEnv);
      } catch (err: any) {
        logger.debug(`Could not load IAM policy for ${agent.displayName}: ${err.message}`);
      }
    }

    const userFilter = options.userFilter || [];
    let filteredAgents = sourceAgents.filter(a => this.isAgentOwnedByUser(a, userFilter));

    if (options.agentTypes && options.agentTypes.length > 0 && !options.agentTypes.includes('ALL')) {
      const allowedTypes = new Set(options.agentTypes);
      filteredAgents = filteredAgents.filter(a => allowedTypes.has(this.getAgentType(a)));
      logger.info(`Filtered agents by type [${options.agentTypes.join(', ')}]: ${filteredAgents.length} matching agents.`);
    } else {
      logger.info(`Selected ${filteredAgents.length} agents matching user filters.`);
    }

    const concurrency = options.concurrency || 10;
    const isDryRun = options.dryRun === true;

    return mapConcurrent(filteredAgents, concurrency, async (agent: Agent) => {
      const startTime = Date.now();
      const originalAgentId = agent.name.split('/').pop() || '';
      const originalOwner = agent.owner || agent.iamPolicy?.bindings?.[0]?.members?.[0] || 'unknown';
      const targetOwner = identityMapping[originalOwner] || originalOwner;

      const result: MigrationItemResult = {
        id: originalAgentId,
        displayName: agent.displayName,
        type: 'AGENT',
        status: 'SUCCESS',
        originalOwner,
        targetOwner
      };

      try {
        if (isDryRun) {
          logger.info(`[DRY RUN] Would migrate Agent "${result.displayName}" (ID: ${originalAgentId}) for owner ${targetOwner}`);
          result.status = 'DRY_RUN';
          result.durationMs = Date.now() - startTime;
          return result;
        }

        const userOwner = (targetOwner && targetOwner !== 'unknown') ? targetOwner : undefined;
        const createPayload = this.buildAgentPayload(agent, sourceEnv, targetEnv, datastoreMapping, collectionMapping);
        const createdAgent = await this.client.createAgent(targetEnv, createPayload, agent.targetId, userOwner);
        const newAgentName = createdAgent.name;
        const newAgentId = newAgentName.split('/').pop() || '';

        result.targetId = newAgentId;
        logger.info(`Created target Agent "${result.displayName}" with new ID "${newAgentId}" (Owner: ${userOwner || 'admin'})`);

        // 1. Replicate sharing configuration ONLY if the source agent had it defined
        if (agent.sharingConfig && options.preserveSharing !== false) {
          try {
            await this.client.patchAgentSharing(newAgentName, agent.sharingConfig, targetEnv, userOwner);
            logger.info(`Sharing configuration mirrored for agent "${result.displayName}" (Scope: ${agent.sharingConfig.scope})`);
          } catch (shareErr: any) {
            logger.warn(`Could not set sharing config on agent "${result.displayName}": ${shareErr.message}`);
          }
        }

        // 2. Replicate IAM policy ONLY if the agent is shared (Google rejects IAM on private agents)
        if (agent.sharingConfig && agent.iamPolicy && agent.iamPolicy.bindings && agent.iamPolicy.bindings.length > 0) {
          try {
            await this.restoreAgentIamPolicy(newAgentName, agent.iamPolicy, targetEnv, identityMapping);
          } catch (iamErr: any) {
            logger.warn(`Could not set IAM policy on agent "${result.displayName}" (${iamErr.message}). Agent creation succeeded.`);
          }
        }

        // 3. Headless publishing is disabled by default to prevent UI revision lockouts and OAuth consent errors.
        // Agents migrate cleanly as native author drafts, ready to be published seamlessly via the UI.
        if (options.publishAgents === true) {
          try {
            await this.client.publishAgent(newAgentName, targetEnv, userOwner);
            logger.info(`Published agent "${result.displayName}".`);
          } catch (pubErr: any) {
            logger.warn(`Notice for agent "${result.displayName}": ${pubErr.message}`);
          }
        } else {
          logger.info(`Preserved agent "${result.displayName}" as native editable draft (Ready for UI 1-click publishing).`);
        }

        const cleanOriginalOwner = (originalOwner || '').replace(/^user:/i, '').replace(/^serviceAccount:/i, '').toLowerCase().trim();
        const cleanTargetOwner = (targetOwner || '').replace(/^user:/i, '').replace(/^serviceAccount:/i, '').toLowerCase().trim();

        const sharedWithList: string[] = [];
        if (agent.sharingConfig?.scope === 'ALL_USERS') {
          sharedWithList.push('Entire Organization (All Users)');
        }
        if (agent.iamPolicy?.bindings) {
          for (const b of agent.iamPolicy.bindings) {
            for (const m of b.members) {
              const cleanM = m.replace(/^user:/i, '').replace(/^group:/i, '[Group] ').trim();
              const lowerMember = cleanM.replace(/^\[Group\]\s*/i, '').toLowerCase();

              // Filter out the author/owner and internal GCP service accounts (redundant)
              if (
                lowerMember === cleanOriginalOwner ||
                lowerMember === cleanTargetOwner ||
                lowerMember.includes('gserviceaccount.com')
              ) {
                continue;
              }

              if (!sharedWithList.includes(cleanM)) {
                sharedWithList.push(cleanM);
              }
            }
          }
        }
        if (sharedWithList.length === 0) {
          sharedWithList.push('Private (Author Only)');
        }

        result.details = {
          agentType: this.getAgentType(agent),
          previousState: agent.state || 'PRIVATE',
          sharedWith: sharedWithList,
          sharingScope: agent.sharingConfig?.scope || 'PRIVATE'
        };

        result.status = 'SUCCESS';
      } catch (err: any) {
        logger.error(`Failed to migrate Agent "${result.displayName}" (${originalAgentId}): ${err.message}`);
        result.status = 'FAILED';
        result.error = err.message;
      }

      result.durationMs = Date.now() - startTime;
      return result;
    });
  }
}
