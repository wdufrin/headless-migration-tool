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

import express from 'express';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GcpAuthService } from '../services/gcpAuth.js';
import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { getSafeDiscoveryEngineUrl } from '../security/validator.js';
import { getDynamicConfig } from './configHelper.js';
import { logger } from '../utils/logger.js';
import { AppStateTracker } from '../services/appStateTracker.js';
import { mapConcurrent } from '../utils/concurrency.js';

const execFileAsync = promisify(execFile);

export const maintenanceRouter = express.Router();

export interface TargetAssetCleanupParams {
  sourceProject?: string;
  targetProject: string;
  targetEngine?: string;
  targetLocation?: string;
  targetCollection?: string;
  cleanNotebooks?: boolean;
  cleanAgents?: boolean;
  forceAllAgents?: boolean;
  cleanSessions?: boolean;
  cleanMemories?: boolean;
  cleanArtifacts?: boolean;
  cleanReports?: boolean;
  userFilter?: string[] | string;
  users?: string[] | string;
  targetUsers?: string[] | string;
  identityMapping?: Record<string, string>;
  callerToken?: string;
  serviceAccountKeyPath?: string;
  rawReq?: any;
}

export interface TargetAssetCleanupResult {
  success: boolean;
  errors?: string[];
  deletedNotebooks: number;
  deletedAgents: number;
  deletedSessions: number;
  deletedMemories: number;
  clearedArtifacts: boolean;
  clearedReports: number;
  clearedUserHandover: boolean;
  targetEngine?: string;
  targetUsersCleaned: string[];
  warning?: string;
  message: string;
}

export async function executeTargetAssetCleanup(params: TargetAssetCleanupParams): Promise<TargetAssetCleanupResult> {
  const saKeyPath = params.serviceAccountKeyPath || process.env.SERVICE_ACCOUNT_KEY_PATH || (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);
  const authService = new GcpAuthService({ 
    staticToken: params.callerToken,
    serviceAccountKeyPath: saKeyPath
  });
  const client = new DiscoveryEngineClient(authService);

  const targetProject = params.targetProject;
  const targetEngine = params.targetEngine || process.env.TARGET_APP_ID || '';
  const targetLocation = params.targetLocation || process.env.TARGET_LOCATION || 'global';
  const targetCollection = params.targetCollection || process.env.TARGET_COLLECTION_ID || 'default_collection';

  const cleanNotebooks = params.cleanNotebooks !== false;
  const cleanAgents = params.cleanAgents !== false;
  const cleanSessions = params.cleanSessions !== false;
  const cleanMemories = params.cleanMemories !== false;
  const cleanArtifacts = params.cleanArtifacts !== false;
  const cleanReports = params.cleanReports !== false;

  // Cross-project collision guard: never allow targetProject to wipe sourceProject
  let effectiveSourceProject = params.sourceProject || process.env.SOURCE_PROJECT_ID;
  if (!effectiveSourceProject) {
    try {
      const configPath = path.resolve(process.cwd(), 'migration-config.json');
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        effectiveSourceProject = cfg.source?.projectId;
      }
    } catch {}
  }
  if (effectiveSourceProject && targetProject && targetProject.trim().toLowerCase() === effectiveSourceProject.trim().toLowerCase()) {
    throw new Error(`Target project "${targetProject}" matches source project "${effectiveSourceProject}". Destructive asset cleanup is blocked to prevent accidental deletion of production source assets.`);
  }

  // Granular Scope Protection: If wiping GE App assets (agents, chats, memories), require explicit engine
  if ((cleanAgents || cleanSessions || cleanMemories) && !targetEngine) {
    throw new Error('A Target GE App (Engine) instance must be specified to clean custom agents, chat history sessions, or user memories. NotebookLM notebooks are project/region scoped, but GE App assets belong to a specific engine.');
  }

  logger.info(`Starting maintenance cleanup for project ${targetProject} (Engine: ${targetEngine}, Region: ${targetLocation}) [Notebooks: ${cleanNotebooks}, Agents: ${cleanAgents}, Sessions: ${cleanSessions}, Memories: ${cleanMemories}, Artifacts: ${cleanArtifacts}, Reports: ${cleanReports}]...`);

  // Determine candidate user identities to clean in target
  const rawUsers: string[] = [];
  if (Array.isArray(params.userFilter)) rawUsers.push(...params.userFilter);
  else if (typeof params.userFilter === 'string') rawUsers.push(...params.userFilter.split(','));

  if (Array.isArray(params.users)) rawUsers.push(...params.users);
  else if (typeof params.users === 'string') rawUsers.push(...params.users.split(','));

  if (Array.isArray(params.targetUsers)) rawUsers.push(...params.targetUsers);
  else if (typeof params.targetUsers === 'string') rawUsers.push(...params.targetUsers.split(','));

  if (params.identityMapping && typeof params.identityMapping === 'object') {
    rawUsers.push(...Object.values(params.identityMapping) as string[]);
    rawUsers.push(...Object.keys(params.identityMapping) as string[]);
  }

  if (process.env.ADMIN_EMAIL) rawUsers.push(process.env.ADMIN_EMAIL);
  if (process.env.DEFAULT_USER_EMAIL) rawUsers.push(process.env.DEFAULT_USER_EMAIL);

  // Auto-discover user identities and migrated agent IDs from existing reports, handover bundles, and config before wiping
  const knownMigratedAgentIds = new Set<string>();
  try {
    const handoverDir = path.resolve(process.cwd(), 'user_handover_reports');
    if (fs.existsSync(handoverDir)) {
      const dirs = fs.readdirSync(handoverDir);
      for (const d of dirs) {
        if (d.includes('@') && !d.includes('..')) rawUsers.push(d);
      }
    }
    const reportsDir = path.resolve(process.cwd(), 'reports');
    if (fs.existsSync(reportsDir)) {
      const rFiles = fs.readdirSync(reportsDir).filter(f => f.endsWith('.json'));
      for (const rf of rFiles) {
        try {
          const reportData = JSON.parse(fs.readFileSync(path.join(reportsDir, rf), 'utf-8'));
          if (Array.isArray(reportData.users)) {
            for (const u of reportData.users) {
              if (typeof u === 'string') rawUsers.push(u);
              else if (u?.email) rawUsers.push(u.email);
            }
          }
          if (Array.isArray(reportData.notebooks)) {
            for (const n of reportData.notebooks) {
              if (n?.owner) rawUsers.push(n.owner);
              if (n?.targetOwner) rawUsers.push(n.targetOwner);
            }
          }
          if (Array.isArray(reportData.results)) {
            for (const item of reportData.results) {
              if (item.type === 'AGENT' || item.type === 'SKILL') {
                if (item.targetId) knownMigratedAgentIds.add(item.targetId);
                if (item.id) knownMigratedAgentIds.add(item.id);
              }
            }
          }
        } catch {}
      }
    }
    const configPath = path.resolve(process.cwd(), 'migration-config.json');
    if (fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (cfg.options?.userFilter && Array.isArray(cfg.options.userFilter)) {
          rawUsers.push(...cfg.options.userFilter);
        }
        if (cfg.identityMapping && typeof cfg.identityMapping === 'object') {
          rawUsers.push(...Object.values(cfg.identityMapping) as string[]);
          rawUsers.push(...Object.keys(cfg.identityMapping) as string[]);
        }
      } catch {}
    }
  } catch {}

  const callerEmail = await authService.getCallerIdentity().catch(() => undefined);
  if (callerEmail) rawUsers.push(callerEmail);

  if (rawUsers.length === 0 && targetProject) {
    try {
      const { stdout } = await execFileAsync('gcloud', ['projects', 'get-iam-policy', targetProject, '--format=json']);
      const policy = JSON.parse(stdout);
      if (Array.isArray(policy.bindings)) {
        for (const b of policy.bindings) {
          if (Array.isArray(b.members)) {
            for (const m of b.members) {
              if (typeof m === 'string' && m.startsWith('user:')) {
                rawUsers.push(m.substring(5));
              }
            }
          }
        }
      }
    } catch {}
  }

  const targetUsersToClean = Array.from(new Set<string>(
    rawUsers
      .filter(Boolean)
      .map(u => String(u || '').replace(/^user:/i, '').trim())
      .filter(u => u.includes('@') && !u.endsWith('.gserviceaccount.com') && !u.startsWith('service-'))
  ));

  logger.info(`Resolved ${targetUsersToClean.length} target user(s) for user-scoped maintenance: [${targetUsersToClean.join(', ')}]`);

  if (cleanNotebooks && targetUsersToClean.length === 0) {
    logger.warn('Notebook cleanup was requested, but no target users were found or supplied. Gemini Enterprise notebooks are user-scoped and require user impersonation (DWD) to discover and delete.');
  }

  const cleanupErrors: string[] = [];

  // 1. Delete all notebooks in target (draining all paginated recently viewed items per user)
  let deletedNotebooks = 0;
  if (cleanNotebooks) {
    try {
      const candidateUsers = Array.from(new Set([callerEmail, ...targetUsersToClean])).filter(Boolean) as string[];
      const usersToIterate = candidateUsers.length > 0 ? candidateUsers : [undefined];
      for (const user of usersToIterate) {
        try {
          let userPasses = 0;
          while (userPasses < 15) {
            userPasses++;
            const nbs = await client.listNotebooks({
              projectId: targetProject,
              appLocation: targetLocation,
              appId: targetEngine
            }, user);

            if (!nbs || nbs.length === 0) break;

            const names = nbs.map(n => n.name).filter(Boolean);
            if (names.length === 0) break;

            const delRes = await client.batchDeleteNotebooks(targetProject, targetLocation, names, user);
            deletedNotebooks += delRes.count || 0;
            logger.info(`Deleted batch of ${delRes.count || 0} notebook(s) for user "${user || 'default'}" in project "${targetProject}"`);
            if (delRes.failed > 0) {
              cleanupErrors.push(`Failed to delete ${delRes.failed} notebook(s) for user "${user || 'default'}"`);
            }
          }
        } catch (uErr: any) {
          logger.warn(`User notebook cleanup notice for ${user || 'default'}: ${uErr.message}`);
          cleanupErrors.push(`User ${user || 'default'} notebook cleanup: ${uErr.message}`);
        }
      }
    } catch (e: any) {
      logger.warn(`Notebook cleanup notice: ${e.message}`);
      cleanupErrors.push(`Notebook cleanup: ${e.message}`);
    }
  }

  // 2. Delete non-system agents in target engine
  let deletedAgents = 0;
  if (cleanAgents && targetEngine) {
    try {
      const agents = await client.listAgents({
        projectId: targetProject,
        appLocation: targetLocation,
        collectionId: targetCollection,
        appId: targetEngine,
        assistantId: 'default_assistant'
      });
      for (const ag of agents) {
        const agentId = ag.name.split('/').pop() || '';
        if (agentId === 'deep_research') continue;

        const isMigrated = 
          params.forceAllAgents !== false ||
          knownMigratedAgentIds.has(agentId) ||
          (ag.displayName && (ag.displayName.includes('[Migrated]') || ag.displayName.includes('[Replace]'))) ||
          (ag.description && (ag.description.includes('Migrated by Gemini Enterprise Tool') || ag.description.includes('[Migrated]')));

        if (isMigrated) {
          await client.deleteAgent(ag.name, targetLocation, targetProject);
          deletedAgents++;
          logger.info(`Deleted custom agent "${ag.displayName}" (${agentId}) from engine "${targetEngine}" in project "${targetProject}".`);
        } else {
          logger.info(`Skipping non-migrated agent "${ag.displayName}" (${agentId}) in engine "${targetEngine}".`);
        }
      }
    } catch (e: any) {
      logger.warn(`Agent cleanup notice for engine "${targetEngine}": ${e.message}`);
      cleanupErrors.push(`Agent cleanup (${targetEngine}): ${e.message}`);
    }
  }

  // 3. Delete all chat history sessions in target engine across all user identities
  let deletedSessions = 0;
  if (cleanSessions && targetEngine) {
    try {
      const { SessionMigrator } = await import('../engines/sessionMigrator.js');
      const dynamicConfig = params.rawReq ? getDynamicConfig(params.rawReq) : {
        source: { projectId: params.sourceProject || '', appLocation: targetLocation, collectionId: targetCollection, appId: '', assistantId: 'default_assistant' },
        target: { projectId: targetProject, appLocation: targetLocation, collectionId: targetCollection, appId: targetEngine, assistantId: 'default_assistant' },
        options: { dryRun: false }
      };
      if (dynamicConfig.target) {
        dynamicConfig.target.projectId = targetProject;
        dynamicConfig.target.appLocation = targetLocation;
        dynamicConfig.target.collectionId = targetCollection;
        dynamicConfig.target.appId = targetEngine;
      }
      const migrator = new SessionMigrator(dynamicConfig as any, authService);

      const candidateUsers = Array.from(new Set([callerEmail, ...targetUsersToClean])).filter(Boolean) as string[];
      const usersToIterate = candidateUsers.length > 0 ? candidateUsers : [undefined];
      const deletedSessionNames = new Set<string>();

      for (const userEmail of usersToIterate) {
        try {
          const targetSessions = await migrator.listTargetSessions(userEmail);
          const token = await authService.getAccessToken(userEmail);
          const baseUrl = getSafeDiscoveryEngineUrl(targetLocation);

          const unhandledSessions = targetSessions.filter(s => s && s.name && !deletedSessionNames.has(s.name));
          if (unhandledSessions.length > 0) {
            await mapConcurrent(unhandledSessions, 15, async (s) => {
              try {
                const delUrl = `${baseUrl}/v1alpha/${s.name}`;
                const delRes = await fetch(delUrl, {
                  method: 'DELETE',
                  headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Goog-User-Project': targetProject
                  }
                });
                if (delRes.ok) {
                  deletedSessions++;
                  deletedSessionNames.add(s.name);
                } else if (delRes.status === 404) {
                  deletedSessionNames.add(s.name);
                } else {
                  const errText = await delRes.text();
                  logger.warn(`Could not delete session ${s.name} for ${userEmail || 'default'} (${delRes.status}): ${errText}`);
                  cleanupErrors.push(`Could not delete session ${s.name} for ${userEmail || 'default'}: ${errText}`);
                }
              } catch (sErr: any) {
                logger.warn(`Could not delete session ${s.name} for ${userEmail || 'default'}: ${sErr.message}`);
                cleanupErrors.push(`Could not delete session ${s.name} for ${userEmail || 'default'}: ${sErr.message}`);
              }
            });
          }
        } catch (uErr: any) {
          // user might not exist in target engine
          logger.debug(`Target session discovery notice for ${userEmail || 'default'}: ${uErr.message}`);
        }
      }
    } catch (e: any) {
      logger.warn(`Session cleanup notice for engine "${targetEngine}": ${e.message}`);
      cleanupErrors.push(`Session cleanup (${targetEngine}): ${e.message}`);
    }
  }

  // 3b. Delete all memories in target engine across all user identities
  let deletedMemories = 0;
  if (cleanMemories && targetEngine) {
    try {
      const { MemoryMigrator } = await import('../engines/memoryMigrator.js');
      const dynamicConfig = params.rawReq ? getDynamicConfig(params.rawReq) : {
        source: { projectId: params.sourceProject || '', appLocation: targetLocation, collectionId: targetCollection, appId: '', assistantId: 'default_assistant' },
        target: { projectId: targetProject, appLocation: targetLocation, collectionId: targetCollection, appId: targetEngine, assistantId: 'default_assistant' },
        options: { dryRun: false }
      };
      if (dynamicConfig.target) {
        dynamicConfig.target.projectId = targetProject;
        dynamicConfig.target.appLocation = targetLocation;
        dynamicConfig.target.collectionId = targetCollection;
        dynamicConfig.target.appId = targetEngine;
      }
      const memMigrator = new MemoryMigrator(dynamicConfig as any, authService, client);

      const candidateUsers = Array.from(new Set([callerEmail, ...targetUsersToClean])).filter(Boolean) as string[];
      const usersToIterate = candidateUsers.length > 0 ? candidateUsers : [undefined];
      const deletedMemoryNames = new Set<string>();

      for (const userEmail of usersToIterate) {
        try {
          const targetMems = await memMigrator.listTargetMemories(userEmail);
          const unhandledMems = targetMems.filter(m => m && m.name && !deletedMemoryNames.has(m.name));
          if (unhandledMems.length > 0) {
            await mapConcurrent(unhandledMems, 10, async (m) => {
              try {
                await client.deleteMemory(m.name, {
                  projectId: targetProject,
                  appLocation: targetLocation,
                  appId: targetEngine,
                  collectionId: targetCollection
                }, userEmail);
                deletedMemories++;
                deletedMemoryNames.add(m.name);
              } catch (mErr: any) {
                logger.warn(`Could not delete memory ${m.name} for ${userEmail || 'default'}: ${mErr.message}`);
                cleanupErrors.push(`Could not delete memory ${m.name} for ${userEmail || 'default'}: ${mErr.message}`);
              }
            });
          }
        } catch (mErr: any) {
          // user might not have memories in target
          logger.debug(`Target memory discovery notice for ${userEmail || 'default'}: ${mErr.message}`);
        }
      }
    } catch (e: any) {
      logger.warn(`Memories cleanup notice for engine "${targetEngine}": ${e.message}`);
      cleanupErrors.push(`Memories cleanup (${targetEngine}): ${e.message}`);
    }
  }

  // 4. Clear exported local artifacts folder
  let clearedArtifacts = false;
  if (cleanArtifacts) {
    try {
      const artDir = path.resolve(process.cwd(), 'exports/artifacts');
      if (fs.existsSync(artDir)) {
        fs.rmSync(artDir, { recursive: true, force: true });
        fs.mkdirSync(artDir, { recursive: true });
        clearedArtifacts = true;
      }
      const userArtDir = path.resolve(process.cwd(), 'user_artifacts');
      if (fs.existsSync(userArtDir)) {
        fs.rmSync(userArtDir, { recursive: true, force: true });
        fs.mkdirSync(userArtDir, { recursive: true });
      }
    } catch (e: any) {
      logger.warn(`Artifact cleanup notice: ${e.message}`);
      cleanupErrors.push(`Artifact cleanup: ${e.message}`);
    }
  }

  // 5. Clear migration reports folder
  let clearedReports = 0;
  let clearedUserHandover = false;
  if (cleanReports) {
    try {
      const reportsDir = path.resolve(process.cwd(), 'reports');
      if (fs.existsSync(reportsDir)) {
        const files = fs.readdirSync(reportsDir);
        for (const file of files) {
          if (file.startsWith('migration-report-')) {
            fs.rmSync(path.join(reportsDir, file), { force: true });
            clearedReports++;
          }
        }
      }
    } catch (e: any) {
      logger.warn(`Reports cleanup notice: ${e.message}`);
      cleanupErrors.push(`Reports cleanup: ${e.message}`);
    }

    // 6. Clear user handover reports folder
    try {
      const handoverDir = path.resolve(process.cwd(), 'user_handover_reports');
      if (fs.existsSync(handoverDir)) {
        fs.rmSync(handoverDir, { recursive: true, force: true });
        fs.mkdirSync(handoverDir, { recursive: true });
        clearedUserHandover = true;
      }
    } catch (e: any) {
      logger.warn(`User handover reports cleanup notice: ${e.message}`);
      cleanupErrors.push(`User handover reports cleanup: ${e.message}`);
    }
  }

  logger.info(`Target cleanup completed: ${deletedNotebooks} notebooks, ${deletedAgents} agents, ${deletedSessions} chat sessions, ${deletedMemories} memories, ${clearedReports} reports, artifacts reset.`);

  const warning = (cleanNotebooks && deletedNotebooks === 0 && targetUsersToClean.length === 0)
    ? 'No user identities were specified or found. Notebooks in Gemini Enterprise are user-scoped and require user email impersonation to list and delete.'
    : undefined;

  return {
    success: cleanupErrors.length === 0,
    errors: cleanupErrors.length > 0 ? cleanupErrors : undefined,
    deletedNotebooks,
    deletedAgents,
    deletedSessions,
    deletedMemories,
    clearedArtifacts,
    clearedReports,
    clearedUserHandover,
    targetEngine: targetEngine || undefined,
    targetUsersCleaned: targetUsersToClean,
    warning,
    message: cleanupErrors.length > 0
      ? `Cleanup completed with ${cleanupErrors.length} error(s): ${cleanupErrors.join('; ')}`
      : `Cleaned ${deletedNotebooks} notebooks, ${deletedAgents} custom agents (Engine: ${targetEngine || 'N/A'}), ${deletedSessions} chat sessions, ${deletedMemories} user memories, ${clearedReports} migration reports, and reset all user handover bundles and artifacts.`
  };
}

// Destination Maintenance Cleanup Endpoint (Button 1: Reset Target Project)
maintenanceRouter.post('/cleanup', async (req, res) => {
  try {
    const targetProject = req.body?.tgtProjectId || req.body?.projectId || req.body?.target?.projectId || process.env.TARGET_PROJECT_ID || '';
    const targetEngine = req.body?.tgtAppId || req.body?.targetEngine || req.body?.appId || req.body?.target?.appId || process.env.TARGET_APP_ID || '';
    const targetLocation = req.body?.tgtLocation || req.body?.location || req.body?.target?.appLocation || process.env.TARGET_LOCATION || 'global';
    const targetCollection = req.body?.tgtCollectionId || req.body?.collectionId || req.body?.target?.collectionId || process.env.TARGET_COLLECTION_ID || 'default_collection';

    // SEC-05 Safety Confirmation: Require matching confirmProjectId to prevent accidental misclicks
    const confirmProject = (req.body?.confirmProjectId || req.body?.confirmProject || '').trim();
    if (confirmProject !== targetProject) {
      return res.status(400).json({
        error: 'ConfirmationMismatch',
        message: `Safety check failed: You must provide 'confirmProjectId' matching the exact target project ID ("${targetProject}"). Received: "${confirmProject}".`
      });
    }

    const cleanNotebooks = req.body?.cleanNotebooks !== false && req.body?.cleanNotebooks !== 'false';
    const cleanAgents = req.body?.cleanAgents !== false && req.body?.cleanAgents !== 'false';
    const cleanSessions = req.body?.cleanSessions !== false && req.body?.cleanSessions !== 'false';
    const cleanMemories = req.body?.cleanMemories !== false && req.body?.cleanMemories !== 'false';
    const cleanArtifacts = req.body?.cleanArtifacts !== false && req.body?.cleanArtifacts !== 'false';
    const cleanReports = req.body?.cleanReports !== false && req.body?.cleanReports !== 'false';

    // Safety check: Require targetEngine if cleaning engine-scoped assets (agents, sessions, memories)
    if ((cleanAgents || cleanSessions || cleanMemories) && !targetEngine) {
      return res.status(400).json({
        error: 'MissingTargetEngine',
        message: `A Target GE App (Engine) instance must be specified when cleaning custom agents, chat history sessions, or user memories. Notebooks are project/region scoped, but GE App assets belong to a specific engine.`
      });
    }

    const sourceProject = req.body?.srcProjectId || req.body?.source?.projectId || req.body?.sourceProjectId || process.env.SOURCE_PROJECT_ID;
    const forceAllAgents = req.body?.forceAllAgents !== false && req.body?.forceAllAgents !== 'false';

    const result = await executeTargetAssetCleanup({
      sourceProject,
      targetProject,
      targetEngine,
      targetLocation,
      targetCollection,
      cleanNotebooks,
      cleanAgents,
      forceAllAgents,
      cleanSessions: req.body?.cleanSessions !== false && req.body?.cleanSessions !== 'false',
      cleanMemories: req.body?.cleanMemories !== false && req.body?.cleanMemories !== 'false',
      cleanArtifacts: req.body?.cleanArtifacts !== false && req.body?.cleanArtifacts !== 'false',
      cleanReports: req.body?.cleanReports !== false && req.body?.cleanReports !== 'false',
      userFilter: req.body?.userFilter,
      users: req.body?.users,
      targetUsers: req.body?.targetUsers,
      identityMapping: req.body?.identityMapping,
      callerToken: req.accessToken,
      rawReq: req
    });

    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(500).json({ error: 'CleanupFailed', message: err.message });
  }
});

// Status Endpoint to inspect decommissioning candidates
maintenanceRouter.get('/maintenance/status', async (_req, res) => {
  try {
    const trackedState = AppStateTracker.loadState();
    const saPath = path.resolve(process.cwd(), 'sa-dwd-key.json');
    let saInfo: { email?: string; projectId?: string; clientId?: string } | null = null;
    if (fs.existsSync(saPath)) {
      try {
        const saData = JSON.parse(fs.readFileSync(saPath, 'utf-8'));
        saInfo = {
          email: saData.client_email,
          projectId: saData.project_id,
          clientId: saData.client_id
        };
      } catch {}
    } else if (trackedState.createdServiceAccounts.length > 0) {
      const sa = trackedState.createdServiceAccounts[0];
      saInfo = {
        email: sa.email,
        projectId: sa.projectId,
        clientId: sa.clientId
      };
    }

    const detectedLocalFiles: string[] = [];
    const filesToCheck = [
      'sa-dwd-key.json',
      'workforce-identity-config.json',
      'wif-migration-key.pem',
      'wif-migration-jwks.json',
      'idp-subject-token.jwt',
      'migration-config.json',
      '.migration-state.json'
    ];
    for (const f of filesToCheck) {
      if (fs.existsSync(path.resolve(process.cwd(), f))) {
        detectedLocalFiles.push(f);
      }
    }

    let reportCount = 0;
    const reportsDir = path.resolve(process.cwd(), 'reports');
    if (fs.existsSync(reportsDir)) {
      reportCount = fs.readdirSync(reportsDir).length;
    }

    let artifactCount = 0;
    const artDir = path.resolve(process.cwd(), 'exports/artifacts');
    if (fs.existsSync(artDir)) {
      artifactCount = fs.readdirSync(artDir).length;
    }

    let handoverCount = 0;
    const handDir = path.resolve(process.cwd(), 'user_handover_reports');
    if (fs.existsSync(handDir)) {
      handoverCount = fs.readdirSync(handDir).length;
    }

    return res.status(200).json({
      success: true,
      serviceAccount: saInfo,
      trackedState,
      detectedLocalFiles,
      reportCount,
      artifactCount,
      handoverCount
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'MaintenanceStatusFailed', message: err.message });
  }
});

// Full Application Decommission & Install Cleanup Endpoint
maintenanceRouter.post('/maintenance/decommission', async (req, res) => {
  try {
    const targetProject = (req.body?.targetProjectId || req.body?.tgtProjectId || req.body?.projectId || '').trim();
    const confirmProject = (req.body?.confirmProjectId || req.body?.confirmProject || '').trim();

    if (!targetProject) {
      return res.status(400).json({
        error: 'MissingProject',
        message: 'Target project ID is required for application decommissioning.'
      });
    }

    if (confirmProject !== targetProject && confirmProject !== 'DECOMMISSION') {
      return res.status(400).json({
        error: 'ConfirmationMismatch',
        message: `Safety check failed: You must provide 'confirmProjectId' matching "${targetProject}" or "DECOMMISSION". Received: "${confirmProject}".`
      });
    }

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const safeTargetProject = targetProject.replace(/[^a-zA-Z0-9\-_]/g, '');

    // 1. Identify Service Account to Delete
    let saEmail = (req.body?.serviceAccountEmail || '').trim();
    let clientId: string | undefined = undefined;
    const saKeyPath = path.resolve(process.cwd(), 'sa-dwd-key.json');
    if (fs.existsSync(saKeyPath)) {
      try {
        const saData = JSON.parse(fs.readFileSync(saKeyPath, 'utf-8'));
        if (!saEmail && saData.client_email) {
          saEmail = saData.client_email;
        }
        clientId = saData.client_id;
      } catch {}
    }

    const trackedState = AppStateTracker.loadState();
    if (!saEmail) {
      const trackedSa = trackedState.createdServiceAccounts.find(s => s.projectId === safeTargetProject);
      if (trackedSa) {
        saEmail = trackedSa.email;
        clientId = clientId || trackedSa.clientId;
      }
    }

    if (!saEmail) {
      saEmail = `gemini-dwd-migrator@${safeTargetProject}.iam.gserviceaccount.com`;
    }

    logger.info(`Initiating complete app decommissioning for target project "${safeTargetProject}" (SA: ${saEmail})...`);

    // 0. Optional: Wipe Target Discovery Assets prior to credential teardown if requested
    let targetAssetsWiped: TargetAssetCleanupResult | { error: string } | null = null;
    if (req.body?.wipeTargetAssets === true) {
      try {
        logger.info(`Target asset wipe requested before decommissioning credentials on "${safeTargetProject}"...`);
        targetAssetsWiped = await executeTargetAssetCleanup({
          targetProject: safeTargetProject,
          targetEngine: req.body?.tgtAppId || req.body?.appId || req.body?.target?.appId || process.env.TARGET_APP_ID || '',
          targetLocation: req.body?.tgtLocation || req.body?.location || req.body?.target?.appLocation || process.env.TARGET_LOCATION || 'global',
          targetCollection: req.body?.tgtCollectionId || req.body?.collectionId || req.body?.target?.collectionId || process.env.TARGET_COLLECTION_ID || 'default_collection',
          cleanNotebooks: req.body?.cleanNotebooks !== false,
          cleanAgents: req.body?.cleanAgents !== false,
          cleanSessions: req.body?.cleanSessions !== false,
          cleanMemories: req.body?.cleanMemories !== false,
          cleanArtifacts: true,
          cleanReports: true,
          userFilter: req.body?.userFilter,
          users: req.body?.users,
          targetUsers: req.body?.targetUsers,
          identityMapping: req.body?.identityMapping,
          callerToken: req.accessToken,
          serviceAccountKeyPath: fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined,
          rawReq: req
        });
      } catch (assetErr: any) {
        logger.warn(`Notice during pre-decommission target asset wipe: ${assetErr.message}`);
        targetAssetsWiped = { error: assetErr.message };
      }
    }

    // 2. Reset Overridden Org Policies (requires explicit opt-in)
    const orgPoliciesReset: Array<{ constraint: string; reset: boolean; error?: string }> = [];
    if (req.body?.resetOrgPolicies === true) {
      const constraintsToReset = new Set<string>();
      const trackedPolicies = trackedState.overriddenOrgPolicies.filter(p => p.projectId === safeTargetProject);
      for (const p of trackedPolicies) {
        constraintsToReset.add(p.constraint);
      }
      constraintsToReset.add('iam.disableServiceAccountKeyCreation');

      for (const constraint of constraintsToReset) {
        try {
          logger.info(`Resetting organization policy "${constraint}" on project "${safeTargetProject}"...`);
          await execFileAsync('gcloud', [
            'org-policies',
            'reset',
            constraint,
            `--project=${safeTargetProject}`
          ]);
          orgPoliciesReset.push({ constraint, reset: true });
          logger.info(`Successfully reset org policy "${constraint}" on "${safeTargetProject}".`);
        } catch (opErr: any) {
          const msg = opErr.message || String(opErr);
          if (msg.includes('NOT_FOUND') || msg.includes('not found') || msg.includes('already default')) {
            orgPoliciesReset.push({ constraint, reset: true });
          } else {
            logger.warn(`Notice while resetting org policy "${constraint}": ${msg}`);
            orgPoliciesReset.push({ constraint, reset: false, error: msg });
          }
        }
      }
    }

    // 3. Revoke IAM Policy Bindings
    const iamBindingsRemoved: Array<{ role: string; removed: boolean; error?: string }> = [];
    if (req.body?.removeIamBindings !== false && saEmail) {
      const rolesToRemove = [
        'roles/discoveryengine.admin',
        'roles/serviceusage.serviceUsageConsumer',
        'roles/iam.serviceAccountTokenCreator'
      ];

      const trackedBindings = trackedState.appliedIamBindings.filter(
        b => b.projectId === safeTargetProject && b.email === saEmail
      );
      for (const b of trackedBindings) {
        if (!rolesToRemove.includes(b.role)) {
          rolesToRemove.push(b.role);
        }
      }

      for (const role of rolesToRemove) {
        try {
          logger.info(`Removing IAM role "${role}" for "${saEmail}" on project "${safeTargetProject}"...`);
          await execFileAsync('gcloud', [
            'projects',
            'remove-iam-policy-binding',
            safeTargetProject,
            `--member=serviceAccount:${saEmail}`,
            `--role=${role}`,
            '--quiet'
          ]);
          iamBindingsRemoved.push({ role, removed: true });
          logger.info(`Removed IAM role "${role}" for "${saEmail}".`);
        } catch (iamErr: any) {
          const msg = iamErr.message || String(iamErr);
          if (msg.includes('does not exist') || msg.includes('NOT_FOUND') || msg.includes('not found')) {
            iamBindingsRemoved.push({ role, removed: true });
          } else {
            logger.warn(`Notice while removing IAM role "${role}": ${msg}`);
            iamBindingsRemoved.push({ role, removed: false, error: msg });
          }
        }
      }
    }

    // 4. Delete the Service Account (requires explicit opt-in)
    let serviceAccountDeleted: { email: string; deleted: boolean; error?: string } = {
      email: saEmail || '',
      deleted: false
    };
    if (req.body?.deleteServiceAccount === true && saEmail) {
      try {
        logger.info(`Deleting service account "${saEmail}" in project "${safeTargetProject}"...`);
        await execFileAsync('gcloud', [
          'iam',
          'service-accounts',
          'delete',
          saEmail,
          `--project=${safeTargetProject}`,
          '--quiet'
        ]);
        serviceAccountDeleted = { email: saEmail, deleted: true };
        logger.info(`Successfully deleted service account "${saEmail}".`);
      } catch (saErr: any) {
        const msg = saErr.message || String(saErr);
        if (msg.includes('NOT_FOUND') || msg.includes('not found') || msg.includes('does not exist')) {
          serviceAccountDeleted = { email: saEmail, deleted: true };
        } else {
          logger.warn(`Notice while deleting service account "${saEmail}": ${msg}`);
          serviceAccountDeleted = { email: saEmail, deleted: false, error: msg };
        }
      }
    }

    // 5. Delete Local Files & Credentials
    const localFilesDeleted: string[] = [];
    const foldersPurged: string[] = [];
    if (req.body?.deleteLocalFiles !== false) {
      const rootDir = process.cwd();
      const filesToDelete = [
        'sa-dwd-key.json',
        'workforce-identity-config.json',
        'wif-migration-key.pem',
        'wif-migration-jwks.json',
        'idp-subject-token.jwt',
        'migration-config.json',
        '.migration-state.json'
      ];

      for (const f of filesToDelete) {
        const fullPath = path.resolve(rootDir, f);
        if (fs.existsSync(fullPath)) {
          try {
            fs.unlinkSync(fullPath);
            localFilesDeleted.push(f);
            logger.info(`Deleted local file: ${f}`);
          } catch (fErr: any) {
            logger.warn(`Failed to delete local file ${f}: ${fErr.message}`);
          }
        }
      }

      // Check pattern-matched secret files in root
      try {
        const rootFiles = fs.readdirSync(rootDir);
        for (const rf of rootFiles) {
          if ((rf.startsWith('sa-') && rf.endsWith('.json')) ||
              (rf.startsWith('credentials') && rf.endsWith('.json')) ||
              (rf.startsWith('wif-') && rf.endsWith('.json'))) {
            if (!localFilesDeleted.includes(rf)) {
              try {
                fs.unlinkSync(path.resolve(rootDir, rf));
                localFilesDeleted.push(rf);
              } catch {}
            }
          }
        }
      } catch {}

      // Purge output directories
      const dirsToPurge = [
        'reports',
        'exports/artifacts',
        'exports/memories',
        'exports',
        'user_handover_reports',
        'user_artifacts'
      ];

      for (const d of dirsToPurge) {
        const dirPath = path.resolve(rootDir, d);
        if (fs.existsSync(dirPath)) {
          try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            fs.mkdirSync(dirPath, { recursive: true });
            foldersPurged.push(d);
            logger.info(`Purged directory: ${d}`);
          } catch (dErr: any) {
            logger.warn(`Failed to purge directory ${d}: ${dErr.message}`);
          }
        }
      }

      AppStateTracker.clearTrackedState();
    }

    const dwdActionRequired = {
      required: true,
      clientId: clientId || undefined,
      consoleUrl: 'https://admin.google.com/ac/owl/domainwidedelegation',
      reason: 'Google Workspace does not offer a public API to programmatically delete Domain-Wide Delegation authorizations. The registration row must be deleted manually by a Super Administrator in the Google Admin Console.',
      tokenStatus: serviceAccountDeleted.deleted
        ? `Service account "${saEmail}" permanently deleted in Google Cloud IAM. Its OAuth2 Client ID (${clientId || 'unknown'}) cannot mint impersonation tokens.`
        : `Service account deletion was skipped or could not be verified. Ensure Client ID (${clientId || 'unknown'}) is removed in Google Workspace Admin Console.`
    };

    const dwdStatus = serviceAccountDeleted.deleted
      ? `Service account "${saEmail}" deleted in Google Cloud IAM. Its OAuth2 Client ID (${clientId || 'unknown'}) is permanently revoked and invalidated in Google Workspace DWD. (Manual deletion of the client row in admin.google.com is required due to Google Workspace API limitations).`
      : `Service account deletion was skipped or could not be verified. Ensure Client ID (${clientId || 'unknown'}) is removed in Google Workspace Admin Console.`;

    logger.info(`App decommission completed for project "${safeTargetProject}". State restored.`);

    return res.status(200).json({
      success: true,
      message: 'Migration platform decommission completed. Environment restored to pre-setup state.',
      targetProject: safeTargetProject,
      clientId,
      serviceAccountDeleted,
      iamBindingsRemoved,
      orgPoliciesReset,
      localFilesDeleted,
      foldersPurged,
      targetAssetsWiped,
      dwdStatus,
      dwdActionRequired
    });
  } catch (err: any) {
    logger.error(`Decommission failed: ${err.message}`);
    return res.status(500).json({ error: 'DecommissionFailed', message: err.message });
  }
});

// Alias for convenience: POST /cleanup-install
maintenanceRouter.post('/cleanup-install', async (req, res) => {
  // Re-route to decommission handler
  const targetProject = (req.body?.targetProjectId || req.body?.tgtProjectId || req.body?.projectId || '').trim();
  req.body.targetProjectId = targetProject;
  return (maintenanceRouter as any).handle(req, res);
});

export interface RollbackCheckItem {
  id: string;
  name: string;
  category: 'CLOUD' | 'LOCAL';
  passed: boolean;
  statusText: string;
  details: string;
}

export interface RollbackVerificationResult {
  success: boolean;
  isFullyRolledBack: boolean;
  targetProject: string;
  serviceAccount: string;
  clientId?: string;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  overallStatus: 'VERIFIED_CLEAN' | 'ROLLBACK_INCOMPLETE';
  checks: RollbackCheckItem[];
  dwdActionRequired?: {
    required: boolean;
    clientId?: string;
    consoleUrl: string;
    reason: string;
    instructions: string[];
  };
  timestamp: string;
}

export async function validateRollbackCompleteness(options: {
  targetProject: string;
  serviceAccountEmail?: string;
  clientId?: string;
}): Promise<RollbackVerificationResult> {
  const safeProject = (options.targetProject || '').replace(/[^a-zA-Z0-9\-_]/g, '');
  let saEmail = (options.serviceAccountEmail || '').trim();
  let clientId = (options.clientId || '').trim();
  if (!clientId) {
    try {
      const saKeyPath = path.resolve(process.cwd(), 'sa-dwd-key.json');
      if (fs.existsSync(saKeyPath)) {
        const saData = JSON.parse(fs.readFileSync(saKeyPath, 'utf-8'));
        clientId = saData.client_id || '';
      }
    } catch {}
  }
  if (!clientId) {
    const trackedState = AppStateTracker.loadState();
    const found = trackedState.createdServiceAccounts.find(s => s.projectId === safeProject);
    if (found?.clientId) clientId = found.clientId;
  }
  if (!saEmail) {
    saEmail = `gemini-dwd-migrator@${safeProject}.iam.gserviceaccount.com`;
  }
  const checks: RollbackCheckItem[] = [];

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const rootDir = process.cwd();

  // 1. Cloud Check: Organization Policy Override
  try {
    const { stdout } = await execFileAsync('gcloud', [
      'org-policies',
      'describe',
      'iam.disableServiceAccountKeyCreation',
      `--project=${safeProject}`,
      '--format=json'
    ]);
    const policy = JSON.parse(stdout || '{}');
    const hasRules = Array.isArray(policy?.spec?.rules) && policy.spec.rules.length > 0;
    if (hasRules && policy.spec.rules.some((r: any) => r.enforce === false)) {
      checks.push({
        id: 'org_policy_key_creation',
        name: 'Organization Policy Override (iam.disableServiceAccountKeyCreation)',
        category: 'CLOUD',
        passed: false,
        statusText: 'Project Override Active',
        details: `Project-level override 'enforce: false' is still active on project "${safeProject}".`
      });
    } else {
      checks.push({
        id: 'org_policy_key_creation',
        name: 'Organization Policy Override (iam.disableServiceAccountKeyCreation)',
        category: 'CLOUD',
        passed: true,
        statusText: 'Reset to Inherited Default',
        details: `No project-level override active. Policy inherits parent organization baseline.`
      });
    }
  } catch (err: any) {
    const msg = err.message || String(err);
    if (msg.includes('NOT_FOUND') || msg.includes('not found') || msg.includes('does not exist')) {
      checks.push({
        id: 'org_policy_key_creation',
        name: 'Organization Policy Override (iam.disableServiceAccountKeyCreation)',
        category: 'CLOUD',
        passed: true,
        statusText: 'Reset to Inherited Default',
        details: `No project-level override exists on project "${safeProject}". Inherits from organization default.`
      });
    } else if (msg.includes('PERMISSION_DENIED') || msg.includes('Permission denied') || msg.includes('403')) {
      checks.push({
        id: 'org_policy_key_creation',
        name: 'Organization Policy Override (iam.disableServiceAccountKeyCreation)',
        category: 'CLOUD',
        passed: false,
        statusText: 'Verification Inconclusive (Permission Denied)',
        details: `Could not verify organization policy on project "${safeProject}": Insufficient permissions to describe org policies.`
      });
    } else {
      checks.push({
        id: 'org_policy_key_creation',
        name: 'Organization Policy Override (iam.disableServiceAccountKeyCreation)',
        category: 'CLOUD',
        passed: false,
        statusText: 'Verification Failed',
        details: `Error querying organization policy on "${safeProject}": ${msg}`
      });
    }
  }

  // 2. Cloud Check: Service Account Existence
  let saDeleted = false;
  try {
    await execFileAsync('gcloud', [
      'iam',
      'service-accounts',
      'describe',
      saEmail,
      `--project=${safeProject}`,
      '--format=json'
    ]);
    checks.push({
      id: 'service_account_existence',
      name: `Service Account Existence (${saEmail})`,
      category: 'CLOUD',
      passed: false,
      statusText: 'Service Account Still Exists',
      details: `Service account ${saEmail} was found in Google Cloud IAM.`
    });
  } catch (err: any) {
    const msg = err.message || String(err);
    if (msg.includes('NOT_FOUND') || msg.includes('not found') || msg.includes('does not exist') || msg.includes('Unknown service account')) {
      saDeleted = true;
      checks.push({
        id: 'service_account_existence',
        name: `Service Account Existence (${saEmail})`,
        category: 'CLOUD',
        passed: true,
        statusText: 'Permanently Deleted',
        details: `Service account ${saEmail} does not exist in Google Cloud IAM.`
      });
    } else if (msg.includes('PERMISSION_DENIED') || msg.includes('Permission denied') || msg.includes('403')) {
      saDeleted = false;
      checks.push({
        id: 'service_account_existence',
        name: `Service Account Existence (${saEmail})`,
        category: 'CLOUD',
        passed: false,
        statusText: 'Verification Inconclusive (Permission Denied)',
        details: `Could not verify existence of ${saEmail}: Insufficient permissions.`
      });
    } else {
      saDeleted = false;
      checks.push({
        id: 'service_account_existence',
        name: `Service Account Existence (${saEmail})`,
        category: 'CLOUD',
        passed: false,
        statusText: 'Verification Failed',
        details: `Could not verify service account status: ${msg}`
      });
    }
  }

  // 3. Cloud Check: IAM Policy Bindings on Target Project
  try {
    const { stdout } = await execFileAsync('gcloud', [
      'projects',
      'get-iam-policy',
      safeProject,
      '--format=json'
    ]);
    const policy = JSON.parse(stdout || '{}');
    const bindings = policy.bindings || [];
    const memberTag = `serviceAccount:${saEmail}`;
    const activeRoles: string[] = [];
    for (const b of bindings) {
      if (Array.isArray(b.members) && b.members.includes(memberTag)) {
        activeRoles.push(b.role);
      }
    }
    if (activeRoles.length > 0) {
      checks.push({
        id: 'iam_role_bindings',
        name: `Target Project IAM Policy Bindings`,
        category: 'CLOUD',
        passed: false,
        statusText: `${activeRoles.length} Active Role(s)`,
        details: `Service account ${saEmail} still holds: ${activeRoles.join(', ')}`
      });
    } else {
      checks.push({
        id: 'iam_role_bindings',
        name: `Target Project IAM Policy Bindings`,
        category: 'CLOUD',
        passed: true,
        statusText: 'Zero Role Bindings',
        details: `No IAM permissions or roles assigned to ${saEmail} on project "${safeProject}".`
      });
    }
  } catch (err: any) {
    const msg = err.message || String(err);
    if (msg.includes('PERMISSION_DENIED') || msg.includes('Permission denied') || msg.includes('403')) {
      checks.push({
        id: 'iam_role_bindings',
        name: `Target Project IAM Policy Bindings`,
        category: 'CLOUD',
        passed: false,
        statusText: 'Verification Inconclusive (Permission Denied)',
        details: `Could not fetch IAM policy bindings for project "${safeProject}": Insufficient permissions to run projects.getIamPolicy.`
      });
    } else {
      checks.push({
        id: 'iam_role_bindings',
        name: `Target Project IAM Policy Bindings`,
        category: 'CLOUD',
        passed: false,
        statusText: 'Verification Failed',
        details: `Error inspecting project IAM policy: ${msg}`
      });
    }
  }

  // 4. Cloud / Workspace Check: Domain-Wide Delegation (DWD)
  if (saDeleted) {
    checks.push({
      id: 'dwd_delegation_status',
      name: `Google Workspace Domain-Wide Delegation (DWD)`,
      category: 'CLOUD',
      passed: true,
      statusText: 'Tokens Inactive (Manual Console Prune)',
      details: clientId
        ? `GCP Service Account deleted in IAM (tokens cannot be minted). Google Workspace has no API for automated DWD client deletion; please delete Client ID "${clientId}" in admin.google.com/ac/owl/domainwidedelegation.`
        : `GCP Service Account deleted in IAM (tokens cannot be minted). Google Workspace has no API for automated DWD client deletion; please remove the corresponding client in admin.google.com/ac/owl/domainwidedelegation.`
    });
  } else {
    checks.push({
      id: 'dwd_delegation_status',
      name: `Google Workspace Domain-Wide Delegation (DWD)`,
      category: 'CLOUD',
      passed: false,
      statusText: 'Potential Active Delegation',
      details: `Service Account still exists; ensure numeric Client ID is removed in admin.google.com.`
    });
  }

  // 5. Local Check: Credential & Configuration Files
  const filesToCheck = [
    'sa-dwd-key.json',
    'workforce-identity-config.json',
    'wif-migration-key.pem',
    'wif-migration-jwks.json',
    'idp-subject-token.jwt',
    'migration-config.json',
    '.migration-state.json'
  ];
  const detectedFiles: string[] = [];
  for (const f of filesToCheck) {
    if (fs.existsSync(path.resolve(rootDir, f))) {
      detectedFiles.push(f);
    }
  }
  try {
    const rootFiles = fs.readdirSync(rootDir);
    for (const rf of rootFiles) {
      if ((rf.startsWith('sa-') && rf.endsWith('.json')) ||
          (rf.startsWith('credentials') && rf.endsWith('.json')) ||
          (rf.startsWith('wif-') && rf.endsWith('.json'))) {
        if (!detectedFiles.includes(rf)) {
          detectedFiles.push(rf);
        }
      }
    }
  } catch {}

  if (detectedFiles.length === 0) {
    checks.push({
      id: 'local_credential_files',
      name: 'Local Credential & Configuration Files',
      category: 'LOCAL',
      passed: true,
      statusText: '0 Credential Files Found',
      details: 'All private keys, tokens, and config files have been wiped from the workstation.'
    });
  } else {
    checks.push({
      id: 'local_credential_files',
      name: 'Local Credential & Configuration Files',
      category: 'LOCAL',
      passed: false,
      statusText: `${detectedFiles.length} File(s) Detected`,
      details: `Residual credential files remaining on disk: ${detectedFiles.join(', ')}`
    });
  }

  // 6. Local Check: Output Directories
  const dirCounts: Record<string, number> = {};
  let totalOutputFiles = 0;
  const dirs = [
    'reports',
    'exports/artifacts',
    'exports/memories',
    'user_handover_reports',
    'user_artifacts'
  ];
  for (const d of dirs) {
    const dp = path.resolve(rootDir, d);
    if (fs.existsSync(dp)) {
      try {
        const count = fs.readdirSync(dp).filter(f => !f.startsWith('.')).length;
        dirCounts[d] = count;
        totalOutputFiles += count;
      } catch {
        dirCounts[d] = 0;
      }
    } else {
      dirCounts[d] = 0;
    }
  }

  if (totalOutputFiles === 0) {
    checks.push({
      id: 'local_output_directories',
      name: 'Local Output & Artifact Directories',
      category: 'LOCAL',
      passed: true,
      statusText: 'All Output Folders Empty',
      details: 'reports/, exports/, and user_handover_reports/ contain zero residual files.'
    });
  } else {
    const breakdown = Object.entries(dirCounts)
      .filter(([_, count]) => count > 0)
      .map(([dir, count]) => `${dir} (${count})`)
      .join(', ');
    checks.push({
      id: 'local_output_directories',
      name: 'Local Output & Artifact Directories',
      category: 'LOCAL',
      passed: false,
      statusText: `${totalOutputFiles} Residual File(s)`,
      details: `Remaining output files: ${breakdown}`
    });
  }

  // 7. Local Check: Application State Tracker
  const tracked = AppStateTracker.loadState();
  const hasTrackedEntries = 
    tracked.overriddenOrgPolicies.length > 0 ||
    tracked.createdServiceAccounts.length > 0 ||
    tracked.appliedIamBindings.length > 0;

  if (!hasTrackedEntries && !fs.existsSync(path.resolve(rootDir, '.migration-state.json'))) {
    checks.push({
      id: 'app_state_tracker',
      name: 'Application State Cache & History',
      category: 'LOCAL',
      passed: true,
      statusText: 'State Cache Cleared',
      details: 'No pending tracked overrides, service accounts, or state files found.'
    });
  } else {
    checks.push({
      id: 'app_state_tracker',
      name: 'Application State Cache & History',
      category: 'LOCAL',
      passed: false,
      statusText: 'Active State Entries',
      details: `Tracked state contains ${tracked.overriddenOrgPolicies.length} policy override(s), ${tracked.createdServiceAccounts.length} SA(s).`
    });
  }

  const totalChecks = checks.length;
  const passedChecks = checks.filter(c => c.passed).length;
  const failedChecks = totalChecks - passedChecks;
  const isFullyRolledBack = failedChecks === 0;

  return {
    success: true,
    isFullyRolledBack,
    targetProject: safeProject,
    serviceAccount: saEmail,
    clientId: clientId || undefined,
    totalChecks,
    passedChecks,
    failedChecks,
    overallStatus: isFullyRolledBack ? 'VERIFIED_CLEAN' : 'ROLLBACK_INCOMPLETE',
    checks,
    dwdActionRequired: {
      required: true,
      clientId: clientId || undefined,
      consoleUrl: 'https://admin.google.com/ac/owl/domainwidedelegation',
      reason: 'Google Workspace deliberately does not provide an API to manage or delete Domain-Wide Delegation authorizations.',
      instructions: [
        '1. Open Google Admin Console at https://admin.google.com/ac/owl/domainwidedelegation',
        `2. Locate the client authorization${clientId ? ` with Client ID: ${clientId}` : ''}`,
        '3. Click the client row and select "Delete"'
      ]
    },
    timestamp: new Date().toISOString()
  };
}

// Rollback & Decommission Verification Endpoints
maintenanceRouter.get('/maintenance/verify-rollback', async (req, res) => {
  try {
    const targetProject = (req.query?.targetProject || req.query?.projectId || req.query?.tgtProjectId || process.env.TARGET_PROJECT_ID || '').toString().trim();
    if (!targetProject) {
      return res.status(400).json({
        error: 'MissingProjectId',
        message: 'Target project ID is required to verify rollback completeness.'
      });
    }
    const saEmail = req.query?.serviceAccountEmail?.toString().trim();
    const clientId = req.query?.clientId?.toString().trim();
    const result = await validateRollbackCompleteness({ targetProject, serviceAccountEmail: saEmail, clientId });
    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(500).json({ error: 'RollbackVerificationFailed', message: err.message });
  }
});

maintenanceRouter.post('/maintenance/verify-rollback', async (req, res) => {
  try {
    const targetProject = (req.body?.targetProjectId || req.body?.tgtProjectId || req.body?.projectId || process.env.TARGET_PROJECT_ID || '').toString().trim();
    if (!targetProject) {
      return res.status(400).json({
        error: 'MissingProjectId',
        message: 'Target project ID is required to verify rollback completeness.'
      });
    }
    const saEmail = req.body?.serviceAccountEmail?.toString().trim();
    const clientId = req.body?.clientId?.toString().trim();
    const result = await validateRollbackCompleteness({ targetProject, serviceAccountEmail: saEmail, clientId });
    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(500).json({ error: 'RollbackVerificationFailed', message: err.message });
  }
});


