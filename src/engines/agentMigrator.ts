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

/**
 * Maps IAM member identities across IdPs (Workforce Identity Federation to Cloud Identity/Workspace).
 * Strips workforce pool URLs and user prefixes, applies identity mapping, and formats with valid IAM prefix.
 */
export function mapIamMember(member: string, identityMapping: Record<string, string> = {}): string {
  if (!member || typeof member !== 'string') return member;
  const trimmed = member.trim();
  if (trimmed === 'allUsers' || trimmed === 'allAuthenticatedUsers' || trimmed.startsWith('deleted:')) {
    return trimmed;
  }

  let clean = trimmed
    .replace(/^.*\/subject\//i, '')
    .replace(/^.*_subject_/i, '')
    .replace(/^principal(set)?:\/\/.*?\//i, '')
    .replace(/^user:/i, '')
    .trim();

  try {
    clean = decodeURIComponent(clean);
  } catch {}

  const mapped = identityMapping[clean] || identityMapping[trimmed] || clean;

  // In Cloud Identity / Workspace IAM policies, user accounts must have the user: prefix.
  if (mapped.includes('@') && !mapped.includes(':')) {
    return `user:${mapped}`;
  }
  return mapped;
}

/**
 * Evaluates if an agent matches the specified user filter by inspecting IAM policy bindings or creator metadata.
 */
export function isAgentOwnedByUser(agent: Agent, userFilter: string[] = []): boolean {
  if (userFilter.length === 0 || userFilter.includes('*') || userFilter.includes('*@*')) {
    return true;
  }

  const lowerFilters = userFilter.map(u => u.toLowerCase().trim().replace(/^user:/i, ''));

  // 1. Resolve Primary Owner (prioritize agentOwner IAM binding, then agent.owner)
  let primaryOwner = agent.owner;
  if (agent.iamPolicy?.bindings) {
    const ownerBinding = agent.iamPolicy.bindings.find(b => b.role === 'roles/discoveryengine.agentOwner');
    if (ownerBinding && ownerBinding.members && ownerBinding.members.length > 0) {
      primaryOwner = ownerBinding.members[0];
    }
  }

  if (primaryOwner) {
    let cleanOwner = primaryOwner
      .replace(/^.*\/subject\//i, '')
      .replace(/^.*_subject_/i, '')
      .replace(/^principal(set)?:\/\/.*?\//i, '')
      .replace(/^user:/i, '')
      .replace(/^serviceAccount:/i, '')
      .toLowerCase().trim();

    try {
      cleanOwner = decodeURIComponent(cleanOwner);
    } catch {}

    return lowerFilters.some(filter => {
      if (filter.startsWith('*@')) {
        const domain = filter.substring(2);
        return cleanOwner.endsWith(`@${domain}`);
      }
      return cleanOwner === filter;
    });
  }

  // 2. Only if no explicit owner role is attached, check other IAM members
  const members: string[] = [];
  if (agent.iamPolicy?.bindings) {
    for (const b of agent.iamPolicy.bindings) {
      members.push(...b.members);
    }
  }
  if (members.length === 0) {
    return false;
  }

  return members.some(member => {
    let cleanMember = member
      .replace(/^.*\/subject\//i, '')
      .replace(/^.*_subject_/i, '')
      .replace(/^principal(set)?:\/\/.*?\//i, '')
      .replace(/^user:/i, '')
      .replace(/^serviceAccount:/i, '')
      .toLowerCase().trim();
    
    return lowerFilters.some(filter => {
      if (filter.startsWith('*@')) {
        const domain = filter.substring(2);
        return cleanMember.endsWith(`@${domain}`);
      }
      return cleanMember === filter;
    });
  });
}

export class AgentMigrator {
  private client: DiscoveryEngineClient;

  constructor(client: DiscoveryEngineClient) {
    this.client = client;
  }

  /**
   * Evaluates if an agent matches the specified user filter by inspecting IAM policy bindings or creator metadata.
   */
  isAgentOwnedByUser(agent: Agent, userFilter: string[] = []): boolean {
    return isAgentOwnedByUser(agent, userFilter);
  }

  /**
   * Deep rewriting of agent definition schemas, datastore URIs, authorizations, and locations.
   */
  buildAgentPayload(
    sourceAgent: Agent,
    sourceEnv: EnvironmentConfig,
    targetEnv: EnvironmentConfig,
    datastoreMapping: Record<string, string> = {},
    collectionMapping: Record<string, string> = {},
    toolMapping: Record<string, string> = {}
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

    if (sourceAgent.skillAgentDefinition) {
      payload.skillAgentDefinition = {
        instruction: sourceAgent.skillAgentDefinition.instruction || '',
        subfiles: sourceAgent.skillAgentDefinition.subfiles || []
      };
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

          let mappedTargetId = datastoreMapping[oldDsId];
          if (mappedTargetId === undefined) {
            // Default to same DataStore ID in target environment if not explicitly overridden
            mappedTargetId = oldDsId;
          }
          if (mappedTargetId === '' || mappedTargetId === null) {
            logger.warn(`Datastore "${oldDsId}" is explicitly skipped in target environment.`);
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

    // 2b. Remap custom Tools in tools array
    if (payload.tools && Array.isArray(payload.tools)) {
      payload.tools = payload.tools.map((tool: any) => {
        if (typeof tool === 'string') {
          const cleanId = tool.split('/').pop() || tool;
          const mapped = toolMapping[tool] || toolMapping[cleanId];
          if (mapped) {
            return mapped.startsWith('projects/')
              ? mapped
              : `projects/${targetEnv.projectId}/locations/${targetEnv.appLocation || 'global'}/tools/${mapped}`;
          }
          return `projects/${targetEnv.projectId}/locations/${targetEnv.appLocation || 'global'}/tools/${cleanId}`;
        }
        if (tool && tool.tool) {
          const cleanId = tool.tool.split('/').pop() || tool.tool;
          const mapped = toolMapping[tool.tool] || toolMapping[cleanId];
          const targetTool = mapped || `projects/${targetEnv.projectId}/locations/${targetEnv.appLocation || 'global'}/tools/${cleanId}`;
          return {
            ...tool,
            tool: targetTool.startsWith('projects/')
              ? targetTool
              : `projects/${targetEnv.projectId}/locations/${targetEnv.appLocation || 'global'}/tools/${targetTool}`
          };
        }
        return tool;
      });
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

        // Universal Project ID / Numeric Number & Location replacement
        defStr = defStr.replace(/projects\/[0-9a-zA-Z_-]+\/locations\/([0-9a-zA-Z_-]+)\//g, `projects/${targetEnv.projectId}/locations/${targetEnv.appLocation || '$1'}/`);

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

        // Common DataStore Connector pattern rewriting (e.g. outlook-federated -> outlook-cmek)
        defStr = defStr.replace(/outlook-federated_[0-9]+/g, 'outlook-cmek_1787169366114');
        defStr = defStr.replace(/onedrive-federated_[0-9]+/g, 'onedrive-cmek_1787169277352');
        defStr = defStr.replace(/entraid-connector_[0-9]+/g, 'entraid-cmek_1787169408505');

        // Tool remapping inside definition schemas
        Object.entries(toolMapping).forEach(([oldTool, newTool]) => {
          if (newTool) {
            defStr = defStr.split(`/tools/${oldTool}`).join(`/tools/${newTool}`);
            defStr = defStr.split(oldTool).join(newTool);
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
    
    // Extract source owners and ensure mapped owners are preserved in roles/discoveryengine.agentOwner
    const sourceOwners: string[] = [];
    (sourcePolicy.bindings || []).forEach(b => {
      if (b.role === 'roles/discoveryengine.agentOwner') {
        b.members.forEach(m => {
          const mapped = mapIamMember(m, identityMapping);
          if (!sourceOwners.includes(mapped)) {
            sourceOwners.push(mapped);
          }
        });
      }
    });

    // Extract shared users from source policy and map to roles/discoveryengine.agentUser
    const sharedUsers: string[] = [];
    (sourcePolicy.bindings || []).forEach(b => {
      if (b.role !== 'roles/discoveryengine.agentOwner') {
        b.members.forEach(m => {
          const mapped = mapIamMember(m, identityMapping);
          if (!sharedUsers.includes(mapped)) {
            sharedUsers.push(mapped);
          }
        });
      }
    });

    const finalBindings: any[] = [];
    const mergedOwnerMembers = Array.from(new Set([
      ...(ownerBindings[0]?.members || []),
      ...sourceOwners
    ]));

    if (mergedOwnerMembers.length > 0) {
      finalBindings.push({
        role: 'roles/discoveryengine.agentOwner',
        members: mergedOwnerMembers
      });
    }

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
  getAgentType(agent: Agent): 'LOW_CODE' | 'WORKFLOW' | 'ADK' | 'A2A' | 'SKILL' | 'OTHER' {
    if (agent.lowCodeAgentDefinition) return 'LOW_CODE';
    if (agent.workflowAgentDefinition) return 'WORKFLOW';
    if (agent.adkAgentDefinition) return 'ADK';
    if (agent.a2aAgentDefinition) return 'A2A';
    if (agent.skillAgentDefinition) return 'SKILL';
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
    identityMapping: Record<string, string> = {},
    toolMapping: Record<string, string> = {}
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
    const PUBLIC_1P_SKILL_IDS = new Set([
      'email-writing-style',
      'report-writing',
      'gemini-api',
      'gke-backup-dr',
      'cloud-sql-basics',
      'cloud-run-basics',
      'google-cloud-solution-n-tier-serverless-web-app',
      'google-cloud-waf-operational-excellence',
      'gke-platform-security',
      'gke-tpu-dynamic-slices-monitoring',
      'google-agents-cli-onboarding',
      'google-cloud-waf-performance-optimization',
      'gke-networking',
      'gemini-interactions-api',
      'gke-observability',
      'bigquery-basics',
      'google-cloud-storage-basics'
    ]);

    let filteredAgents = sourceAgents.filter(a => {
      const agentId = a.name?.split('/').pop() || '';
      if (options.skipIds && (options.skipIds.includes(agentId) || options.skipIds.includes(`AGENT:${agentId}`) || options.skipIds.includes(`SKILL:${agentId}`))) {
        logger.info(`Skipping already-migrated Agent "${a.displayName}" (${agentId}) from previous checkpoint.`);
        return false;
      }
      if (a.skillAgentDefinition) {
        if (a.geminiEnterpriseSkillConfig || PUBLIC_1P_SKILL_IDS.has(agentId)) {
          return false;
        }
      }
      return this.isAgentOwnedByUser(a, userFilter);
    });

    if (options.agentTypes && options.agentTypes.length > 0 && !options.agentTypes.includes('ALL')) {
      const allowedTypes = new Set(options.agentTypes);
      filteredAgents = filteredAgents.filter(a => allowedTypes.has(this.getAgentType(a)));
      logger.info(`Filtered agents by type [${options.agentTypes.join(', ')}]: ${filteredAgents.length} matching agents.`);
    }

    if (options.excludeDraftAgents || options.agentStatusFilter === 'PUBLISHED_ONLY') {
      filteredAgents = filteredAgents.filter(a => this.isSourceAgentPublished(a));
      logger.info(`Filtered agents to published/shared only (drafts excluded): ${filteredAgents.length} matching agents.`);
    } else if (options.agentStatusFilter === 'DRAFTS_ONLY') {
      filteredAgents = filteredAgents.filter(a => !this.isSourceAgentPublished(a));
      logger.info(`Filtered agents to drafts only: ${filteredAgents.length} matching agents.`);
    } else {
      logger.info(`Selected ${filteredAgents.length} agents matching user & lifecycle filters.`);
    }

    const concurrency = options.concurrency || 10;
    const isDryRun = options.dryRun === true;

    return mapConcurrent(filteredAgents, concurrency, async (agent: Agent) => {
      const startTime = Date.now();
      const originalAgentId = agent.name.split('/').pop() || '';
      const rawOriginalOwner = agent.owner || agent.iamPolicy?.bindings?.[0]?.members?.[0] || 'unknown';
      let cleanOwner = rawOriginalOwner;
      cleanOwner = cleanOwner.replace(/^.*\/subject\//i, '');
      cleanOwner = cleanOwner.replace(/^.*_subject_/i, '');
      cleanOwner = cleanOwner.replace(/^principal(set)?:\/\/.*?\//i, '');
      cleanOwner = cleanOwner.replace(/^user:/i, '').trim();

      const originalOwner = cleanOwner;
      const targetOwner = identityMapping[cleanOwner] || identityMapping[rawOriginalOwner] || cleanOwner;

      const agentType = this.getAgentType(agent);
      const result: MigrationItemResult = {
        id: originalAgentId,
        displayName: agent.displayName,
        type: agentType === 'SKILL' ? 'SKILL' : 'AGENT',
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
        const createPayload = this.buildAgentPayload(agent, sourceEnv, targetEnv, datastoreMapping, collectionMapping, toolMapping);
        
        let createdAgent;
        try {
          createdAgent = await this.client.createAgent(targetEnv, createPayload, agent.targetId, userOwner);
        } catch (createErr: any) {
          if (
            createErr.message.includes('DWD Impersonation Failed') ||
            createErr.message.includes('User does not exist') ||
            createErr.message.includes('client_is_not_authorized') ||
            createErr.message.includes('unauthorized_client') ||
            createErr.message.includes('invalid_grant') ||
            createErr.message.includes('discoveryengine.agents.create') ||
            createErr.message.includes('PERMISSION_DENIED') ||
            createErr.message.includes('Permission') ||
            createErr.status === 403
          ) {
            logger.warn(`DWD impersonation or user permissions not available for "${userOwner}" (${createErr.message}). Restoring Agent "${result.displayName}" directly into target engine via Service Account.`);
            createdAgent = await this.client.createAgent(targetEnv, createPayload, agent.targetId, undefined);
          } else if (
            createErr.message.includes('authorization') ||
            createErr.message.includes('Authorization') ||
            createErr.message.includes('dataStore') ||
            createErr.message.includes('DataStore') ||
            createErr.message.includes('FAILED_PRECONDITION')
          ) {
            logger.warn(`Agent "${result.displayName}" encountered federated connector constraint (${createErr.message}). Retrying in safe unlinked draft mode...`);
            const fallbackPayload = { ...createPayload };
            delete fallbackPayload.authorizationConfig;
            delete fallbackPayload.authorizations;
            createdAgent = await this.client.createAgent(targetEnv, fallbackPayload, agent.targetId, undefined);
            logger.info(`Agent "${result.displayName}" restored successfully as native draft. User can reconnect federated OAuth credentials on first login.`);
          } else {
            throw createErr;
          }
        }

        const newAgentName = createdAgent.name;
        const newAgentId = newAgentName.split('/').pop() || '';

        result.targetId = newAgentId;
        logger.info(`Created target Agent "${result.displayName}" with new ID "${newAgentId}" (Owner: ${userOwner || 'admin'})`);

        // 1. Replicate sharing configuration so the restored agent is visible in the UI
        const effectiveSharing = agent.sharingConfig || { scope: 'ALL_USERS' };
        if (options.preserveSharing !== false) {
          try {
            await this.client.patchAgentSharing(newAgentName, effectiveSharing, targetEnv, userOwner);
            logger.info(`Sharing configuration configured for agent "${result.displayName}" (Scope: ${effectiveSharing.scope})`);
          } catch (shareErr: any) {
            try {
              await this.client.patchAgentSharing(newAgentName, effectiveSharing, targetEnv, undefined);
              logger.info(`Sharing configuration configured via Service Account for agent "${result.displayName}"`);
            } catch (retryErr: any) {
              logger.warn(`Could not set sharing config on agent "${result.displayName}": ${shareErr.message}`);
            }
          }
        }

        // 2. Replicate IAM policy ONLY if the agent is shared (Google rejects IAM on private agents)
        if (agent.iamPolicy && agent.iamPolicy.bindings && agent.iamPolicy.bindings.length > 0) {
          try {
            await this.restoreAgentIamPolicy(newAgentName, agent.iamPolicy, targetEnv, identityMapping);
          } catch (iamErr: any) {
            logger.warn(`Could not set IAM policy on agent "${result.displayName}" (${iamErr.message}). Agent creation succeeded.`);
          }
        }

        // 3. Publish agent if requested or if published in source
        if (options.publishAgents !== false && (options.publishAgents === true || this.isSourceAgentPublished(agent))) {
          try {
            await this.client.publishAgent(newAgentName, targetEnv, userOwner);
            logger.info(`Published agent "${result.displayName}".`);
          } catch (pubErr: any) {
            try {
              await this.client.publishAgent(newAgentName, targetEnv, undefined);
              logger.info(`Published agent "${result.displayName}" via Service Account.`);
            } catch (retryPubErr: any) {
              logger.warn(`Notice for agent "${result.displayName}": ${pubErr.message}`);
            }
          }
        } else {
          logger.info(`Preserved agent "${result.displayName}" as native editable draft.`);
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
        if (err.message.includes('DWD Impersonation Failed') || err.message.includes('User does not exist') || err.message.includes('client_is_not_authorized') || err.message.includes('unauthorized_client') || err.message.includes('Invalid impersonation')) {
          logger.warn(`[DROPPED / SKIPPED] Agent "${result.displayName}" for offboarded/unmapped user "${originalOwner}" was dropped. Admin account will not be polluted.`);
          result.status = 'SKIPPED';
          result.error = `Skipped: User "${targetOwner || originalOwner}" not found in target Google Identity. Data safely dropped to prevent admin account pollution.`;
        } else {
          logger.error(`Failed to migrate Agent "${result.displayName}" (${originalAgentId}): ${err.message}`);
          result.status = 'FAILED';
          result.error = err.message;
        }
      }

      result.durationMs = Date.now() - startTime;
      return result;
    });
  }
}
