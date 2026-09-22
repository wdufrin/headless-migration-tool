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

import { AgentRegistryClient } from '../services/agentRegistry.js';
import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { EnvironmentConfig, MigrationOptions, MigrationItemResult } from '../types/migration.js';
import { RegistrySkill, RegistrySkillRevision, Agent, IamPolicy } from '../types/index.js';
import { mapConcurrent } from '../utils/concurrency.js';
import { logger } from '../utils/logger.js';
import { IdentityMappingService } from '../services/identityMappingService.js';
import { isAgentOwnedByUser, mapIamMember, normalizePrincipal } from './agentMigrator.js';

export const PUBLIC_1P_SKILL_IDS = new Set([
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

/**
 * Evaluates if an Agent Registry skill matches the specified user filter.
 */
export function isSkillOwnedByUser(skill: RegistrySkill, userFilter: string[] = []): boolean {
  if (userFilter.length === 0 || userFilter.includes('*') || userFilter.includes('*@*')) {
    return true;
  }
  const candidateOwners: string[] = [
    skill.publisher,
    (skill as any).owner,
    (skill as any).creator,
    (skill as any).metadata?.owner,
    (skill as any).metadata?.creator,
    (skill as any).metadata?.publisher
  ].filter(Boolean) as string[];

  if (candidateOwners.length === 0) {
    return false;
  }

  const lowerFilters = userFilter.map(u => u.toLowerCase().trim().replace(/^user:/i, ''));
  return candidateOwners.some(owner => {
    const cleanOwner = normalizePrincipal(owner);
    return lowerFilters.some(filter => {
      if (filter.startsWith('*@')) {
        const domain = filter.substring(2);
        return cleanOwner.endsWith(`@${domain}`);
      }
      return cleanOwner === filter;
    });
  });
}

export class SkillMigrator {
  private client: AgentRegistryClient;
  private discoveryClient?: DiscoveryEngineClient;

  constructor(client: AgentRegistryClient, discoveryClient?: DiscoveryEngineClient) {
    this.client = client;
    this.discoveryClient = discoveryClient;
  }

  /**
   * Discovers and directly migrates user-created enterprise skills across cloud environments.
   * Public Google catalog skills (e.g. cloud.google.com-*) and org marketplace templates are excluded.
   */
  async migrateSkills(
    sourceEnv: EnvironmentConfig,
    targetEnv: EnvironmentConfig,
    options: MigrationOptions = {},
    identityMapping: Record<string, string> = {}
  ): Promise<MigrationItemResult[]> {
    const results: MigrationItemResult[] = [];
    const pushResult = (item: MigrationItemResult) => {
      results.push(item);
      options.onItemCompleted?.(item);
    };
    const concurrency = options.concurrency ? Math.min(options.concurrency, 4) : 2;

    // -------------------------------------------------------------
    // Phase 1: User-Created Skills in Central Agent Registry
    // -------------------------------------------------------------
    logger.info(`Discovering user-created skills in source Agent Registry: ${sourceEnv.projectId} (${sourceEnv.appLocation || 'global'})...`);

    const allSkills = await this.client.listSkills(sourceEnv);

    // Filter out public Google 1P catalog skills (cloud.google.com-*, discoveryengine.googleapis.com-*, google-*)
    const userRegistrySkills = allSkills.filter((skill: RegistrySkill) => {
      const resourceId = skill.name ? skill.name.split('/').pop()! : (skill.skillId || '');
      if (
        resourceId.startsWith('cloud.google.com-') ||
        resourceId.startsWith('discoveryengine.googleapis.com-') ||
        resourceId.startsWith('google-')
      ) {
        return false;
      }
      return true;
    });

    const userFilter = options.userFilter || [];
    const hasUserFilter = userFilter.length > 0 && !userFilter.includes('*') && !userFilter.includes('*@*');
    const filteredRegistrySkills = userRegistrySkills.filter((skill: RegistrySkill) => {
      if (!hasUserFilter) return true;
      return isSkillOwnedByUser(skill, userFilter);
    });

    if (allSkills.length > filteredRegistrySkills.length) {
      logger.info(`Filtered ${allSkills.length} skills in Agent Registry -> ${filteredRegistrySkills.length} matching skills (excluded public catalog & non-matching user skills).`);
    } else {
      logger.info(`Found ${filteredRegistrySkills.length} user-created skills in Agent Registry.`);
    }

    await mapConcurrent(filteredRegistrySkills, concurrency, async (skill: RegistrySkill) => {
      const resourceId = skill.name ? skill.name.split('/').pop()! : (skill.skillId || 'unknown-skill');
      const displayName = skill.displayName || resourceId;

      const rawOwner = skill.publisher || (skill as any).owner || (skill as any).creator;
      const originalOwner = rawOwner ? normalizePrincipal(rawOwner) : undefined;
      const targetOwner = originalOwner ? IdentityMappingService.lookupTargetIdentity(originalOwner, identityMapping, originalOwner) : undefined;

      if (options.skipIds && (options.skipIds.includes(resourceId) || options.skipIds.includes(`SKILL:${resourceId}`))) {
        logger.info(`Skipping already-migrated Skill "${displayName}" (${resourceId}) from previous checkpoint.`);
        return;
      }

      try {
        let fullSkill = skill;
        try {
          fullSkill = await this.client.getSkill(skill.name, sourceEnv);
        } catch {}

        let revisions: RegistrySkillRevision[] = [];
        try {
          revisions = await this.client.listSkillRevisions(skill.name, sourceEnv);
        } catch {}

        if (options.dryRun) {
          logger.info(`[DRY RUN] Would migrate Skill "${displayName}" (ID: ${resourceId}) to target Agent Registry`);
          pushResult({
            id: resourceId,
            displayName,
            type: 'SKILL',
            status: 'DRY_RUN',
            targetId: resourceId,
            originalOwner,
            targetOwner
          });
          return;
        }

        let existsInTarget = false;
        try {
          await this.client.getSkill(resourceId, targetEnv);
          existsInTarget = true;
          logger.info(`Skill "${displayName}" (${resourceId}) already exists in target Agent Registry. Skipping creation.`);
        } catch {
          existsInTarget = false;
        }

        if (!existsInTarget) {
          const activeRev = revisions.find(r => r.state === 'ACTIVE') || revisions[0];
          let b64Archive: string | undefined = activeRev?.archiveUploadSource?.archiveContent || (fullSkill.initialRevision as any)?.archiveUploadSource?.archiveContent;
          if (!b64Archive && activeRev && typeof this.client.downloadSkillRevisionMedia === 'function') {
            try {
              const media = await this.client.downloadSkillRevisionMedia(activeRev.name, sourceEnv);
              if (media) b64Archive = media;
            } catch (err: any) {
              logger.warn(`Could not download media for skill revision ${activeRev.name}: ${err.message}`);
            }
          }

          const payload: Partial<RegistrySkill> = {
            displayName: fullSkill.displayName || displayName,
            description: fullSkill.description,
            type: fullSkill.type || 'SIMPLE',
            targetState: 'TARGET_STATE_DRAFT',
          };

          if (b64Archive) {
            payload.initialRevision = {
              archiveUploadSource: {
                archiveContent: b64Archive
              }
            };
          }

          logger.info(`Creating Skill "${displayName}" (${resourceId}) in target Agent Registry...`);
          const createdSkill = await this.client.createSkill(resourceId, payload, targetEnv);
          const targetSkillId = createdSkill?.name ? createdSkill.name.split('/').pop()! : resourceId;

          if (fullSkill.targetState === 'TARGET_STATE_ACTIVE') {
            try {
              for (let attempt = 0; attempt < 5; attempt++) {
                await new Promise(r => setTimeout(r, 2000));
                const targetRevs = await this.client.listSkillRevisions(targetSkillId, targetEnv);
                const activeTargetRev = targetRevs.find(r => r.state === 'ACTIVE');
                if (activeTargetRev) {
                  await this.client.updateSkill(
                    targetSkillId,
                    {
                      targetState: 'TARGET_STATE_ACTIVE',
                      defaultRevision: activeTargetRev.name
                    },
                    ['targetState', 'defaultRevision'],
                    targetEnv
                  );
                  logger.info(`Activated Skill "${displayName}" (${targetSkillId}) in target Agent Registry.`);
                  break;
                }
              }
            } catch (actErr: any) {
              logger.warn(`Could not automatically activate skill "${displayName}": ${actErr.message}`);
            }
          }
        }

        pushResult({
          id: resourceId,
          displayName,
          type: 'SKILL',
          status: 'SUCCESS',
          targetId: resourceId,
          originalOwner,
          targetOwner
        });
      } catch (err: any) {
        logger.error(`Failed to migrate Skill "${displayName}" (${resourceId}): ${err.message}`);
        pushResult({
          id: resourceId,
          displayName,
          type: 'SKILL',
          status: 'FAILED',
          error: err.message,
          originalOwner,
          targetOwner
        });
      }
    });

    // -------------------------------------------------------------
    // Phase 2: User-Created Skill Agents in Discovery Engine
    // -------------------------------------------------------------
    if (this.discoveryClient && sourceEnv.appId && targetEnv.appId) {
      logger.info(`Discovering user-created skill agents in source Discovery Engine: ${sourceEnv.projectId} (${sourceEnv.appId})...`);
      try {
        const sourceAgents = await this.discoveryClient.listAgents(sourceEnv);
        const skillAgents = sourceAgents.filter(a => {
          if (!a.skillAgentDefinition) return false;
          const agentId = a.name?.split('/').pop() || '';
          if (a.geminiEnterpriseSkillConfig || PUBLIC_1P_SKILL_IDS.has(agentId)) {
            return false;
          }
          return true;
        });

        for (const a of skillAgents) {
          try {
            a.iamPolicy = await this.discoveryClient.getAgentIamPolicy(a.name, sourceEnv);
          } catch (err: any) {
            logger.debug(`Could not load IAM policy for skill agent ${a.displayName}: ${err.message}`);
          }
        }

        const userFilter = options.userFilter || [];
        const filteredSkillAgents = skillAgents.filter(a => {
          const agentId = a.name?.split('/').pop() || '';
          if (options.skipIds && (options.skipIds.includes(agentId) || options.skipIds.includes(`SKILL:${agentId}`) || options.skipIds.includes(`AGENT:${agentId}`))) {
            logger.info(`Skipping already-migrated Skill Agent "${a.displayName}" (${agentId}) from checkpoint.`);
            return false;
          }
          return isAgentOwnedByUser(a, userFilter);
        });

        logger.info(`Selected ${filteredSkillAgents.length} user-created Discovery Engine skill agents matching user filters.`);

        await mapConcurrent(filteredSkillAgents, concurrency, async (agent: Agent) => {
          const agentId = agent.name?.split('/').pop() || '';
          const rawOwner = agent.owner || agent.iamPolicy?.bindings?.[0]?.members?.[0] || 'unknown';
          let cleanOwner = rawOwner
            .replace(/^.*\/subject\//i, '')
            .replace(/^.*_subject_/i, '')
            .replace(/^principal(set)?:\/\/.*?\//i, '')
            .replace(/^user:/i, '')
            .trim();
          const targetOwner = IdentityMappingService.lookupTargetIdentity(cleanOwner, identityMapping, cleanOwner);

          if (options.dryRun) {
            logger.info(`[DRY RUN] Would migrate Discovery Engine Skill Agent "${agent.displayName}" (ID: ${agentId}) for owner ${targetOwner}`);
            pushResult({
              id: agentId,
              displayName: agent.displayName,
              type: 'SKILL',
              status: 'DRY_RUN',
              targetId: agentId,
              originalOwner: cleanOwner,
              targetOwner
            });
            return;
          }

          try {
            let existsInTarget = false;
            try {
              const targetCollection = targetEnv.collectionId || 'default_collection';
              const targetAssistant = targetEnv.assistantId || 'default_assistant';
              const targetPath = `projects/${targetEnv.projectId}/locations/${targetEnv.appLocation || 'global'}/collections/${targetCollection}/engines/${targetEnv.appId}/assistants/${targetAssistant}/agents/${agentId}`;
              await this.discoveryClient!.getAgent(targetPath, targetEnv);
              existsInTarget = true;
              logger.info(`Skill Agent "${agent.displayName}" (${agentId}) already exists in target Discovery Engine. Skipping creation.`);
            } catch {
              existsInTarget = false;
            }

            if (!existsInTarget) {
              const remappedDataStoreConnections = (agent.dataStoreConnections || []).map((conn: any) => {
                if (!conn.dataStore) return conn;
                const oldDsId = conn.dataStore.split('/').pop() || '';
                const targetLocation = targetEnv.appLocation || 'global';
                const targetCollection = targetEnv.collectionId || 'default_collection';
                return {
                  ...conn,
                  dataStore: `projects/${targetEnv.projectId}/locations/${targetLocation}/collections/${targetCollection}/dataStores/${oldDsId}`
                };
              });

              const remappedTools = (agent.tools || []).map((t: any) => {
                if (typeof t === 'string') {
                  const cleanId = t.split('/').pop() || t;
                  return `projects/${targetEnv.projectId}/locations/${targetEnv.appLocation || 'global'}/tools/${cleanId}`;
                }
                if (t && t.tool) {
                  const cleanId = t.tool.split('/').pop() || t.tool;
                  return {
                    ...t,
                    tool: `projects/${targetEnv.projectId}/locations/${targetEnv.appLocation || 'global'}/tools/${cleanId}`
                  };
                }
                return t;
              });

              const payload: any = {
                displayName: agent.displayName,
                description: agent.description || '',
                icon: agent.icon || undefined,
                state: agent.state || 'PRIVATE',
                sharingConfig: agent.sharingConfig || undefined,
                dataStoreConnections: remappedDataStoreConnections.length > 0 ? remappedDataStoreConnections : undefined,
                tools: remappedTools.length > 0 ? remappedTools : undefined,
                authorizationConfig: agent.authorizationConfig || undefined,
                authorizations: !agent.authorizationConfig ? agent.authorizations : undefined,
                starterPrompts: agent.starterPrompts || undefined,
                skillAgentDefinition: {
                  instruction: agent.skillAgentDefinition?.instruction || '',
                  subfiles: agent.skillAgentDefinition?.subfiles || []
                }
              };

              const userOwner = (targetOwner && targetOwner !== 'unknown') ? targetOwner : undefined;
              let createdAgent;
              try {
                createdAgent = await this.discoveryClient!.createAgent(targetEnv, payload, agentId, userOwner);
              } catch (createErr: any) {
                logger.warn(`Direct user creation failed for skill agent "${agent.displayName}" (${createErr.message}). Falling back to service account creation...`);
                createdAgent = await this.discoveryClient!.createAgent(targetEnv, payload, agentId, undefined);
              }

              const newAgentName = createdAgent.name;
              const isShared = agent.sharingConfig?.scope === 'ALL_USERS' || agent.sharingConfig?.scope === 'RESTRICTED';

              if (agent.sharingConfig && options.preserveSharing !== false) {
                try {
                  await this.discoveryClient!.patchAgentSharing(newAgentName, agent.sharingConfig, targetEnv, userOwner);
                } catch {
                  try {
                    await this.discoveryClient!.patchAgentSharing(newAgentName, agent.sharingConfig, targetEnv, undefined);
                  } catch {}
                }
              }

              if (isShared && agent.iamPolicy?.bindings && agent.iamPolicy.bindings.length > 0) {
                try {
                  const currentPolicy = await this.discoveryClient!.getAgentIamPolicy(newAgentName, targetEnv);
                  const ownerBindings = (currentPolicy.bindings || []).filter(b => b.role === 'roles/discoveryengine.agentOwner');
                  const sharedUsers: string[] = [];
                  (agent.iamPolicy.bindings || []).forEach(b => {
                    if (b.role !== 'roles/discoveryengine.agentOwner') {
                      b.members.forEach(m => {
                        const mapped = mapIamMember(m, identityMapping);
                        if (!sharedUsers.includes(mapped)) sharedUsers.push(mapped);
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
                  await this.discoveryClient!.setAgentIamPolicy(newAgentName, payloadPolicy, targetEnv);
                } catch (iamErr: any) {
                  logger.warn(`Could not restore IAM policy on skill agent "${agent.displayName}": ${iamErr.message}`);
                }
              }
              logger.info(`Successfully migrated user Skill Agent "${agent.displayName}" (ID: ${agentId}) into target Discovery Engine.`);
            }

            pushResult({
              id: agentId,
              displayName: agent.displayName,
              type: 'SKILL',
              status: 'SUCCESS',
              targetId: agentId,
              originalOwner: cleanOwner,
              targetOwner
            });
          } catch (err: any) {
            logger.error(`Failed to migrate user Skill Agent "${agent.displayName}" (${agentId}): ${err.message}`);
            pushResult({
              id: agentId,
              displayName: agent.displayName,
              type: 'SKILL',
              status: 'FAILED',
              error: err.message,
              originalOwner: cleanOwner,
              targetOwner
            });
          }
        });
      } catch (deErr: any) {
        logger.warn(`Could not scan Discovery Engine for skill agents: ${deErr.message}`);
      }
    }

    return results;
  }
}
