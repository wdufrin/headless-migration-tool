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
import { GcpAuthService } from '../services/gcpAuth.js';
import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { getSafeDiscoveryEngineUrl } from '../security/validator.js';
import { getDynamicConfig } from './configHelper.js';
import { logger } from '../utils/logger.js';

export const maintenanceRouter = express.Router();

// Destination Maintenance Cleanup Endpoint
maintenanceRouter.post('/cleanup', async (req, res) => {
  try {
    const callerToken = req.accessToken;
    const saKeyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);
    const authService = new GcpAuthService({ 
      staticToken: callerToken,
      serviceAccountKeyPath: saKeyPath
    });
    const client = new DiscoveryEngineClient(authService);

    const targetProject = req.body?.tgtProjectId || req.body?.projectId || req.body?.target?.projectId || process.env.TARGET_PROJECT_ID || '';
    const targetEngine = req.body?.tgtAppId || req.body?.appId || req.body?.target?.appId || process.env.TARGET_APP_ID || '';
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

    logger.info(`Starting maintenance cleanup for project ${targetProject} (Engine: ${targetEngine}, Region: ${targetLocation}) [Notebooks: ${cleanNotebooks}, Agents: ${cleanAgents}, Sessions: ${cleanSessions}, Memories: ${cleanMemories}, Artifacts: ${cleanArtifacts}, Reports: ${cleanReports}]...`);

    // Determine candidate user identities to clean in target
    const targetUsersToClean = Array.from(new Set<string>([
      process.env.ADMIN_EMAIL,
      process.env.DEFAULT_USER_EMAIL,
      ...(req.body?.userFilter || []),
      ...(Object.values(req.body?.identityMapping || {}))
    ].filter(Boolean).map(u => String(u || '').replace(/^user:/i, '').trim()).filter(Boolean)));

    // 1. Delete all notebooks in target (draining all paginated recently viewed items per user)
    let deletedNotebooks = 0;
    if (cleanNotebooks) {
      try {
        for (const user of [undefined, ...targetUsersToClean]) {
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

              await client.batchDeleteNotebooks(targetProject, targetLocation, names, user);
              deletedNotebooks += names.length;
            }
          } catch (uErr: any) {
            logger.debug(`User notebook cleanup notice for ${user || 'default'}: ${uErr.message}`);
          }
        }
      } catch (e: any) {
        logger.warn(`Notebook cleanup notice: ${e.message}`);
      }
    }

    // 2. Delete non-system agents in target engine
    let deletedAgents = 0;
    if (cleanAgents) {
      try {
        const agents = await client.listAgents({
          projectId: targetProject,
          appLocation: targetLocation,
          collectionId: targetCollection,
          appId: targetEngine,
          assistantId: 'default_assistant'
        });
        for (const ag of agents) {
          const agentId = ag.name.split('/').pop();
          if (agentId !== 'deep_research') {
            await client.deleteAgent(ag.name, targetLocation, targetProject);
            deletedAgents++;
          }
        }
      } catch (e: any) {
        logger.warn(`Agent cleanup notice: ${e.message}`);
      }
    }

    // 3. Delete all chat history sessions in target engine across all user identities
    let deletedSessions = 0;
    if (cleanSessions) {
      try {
        const { SessionMigrator } = await import('../engines/sessionMigrator.js');
        const dynamicConfig = getDynamicConfig(req);
        const migrator = new SessionMigrator(dynamicConfig, authService);

        for (const userEmail of targetUsersToClean) {
          try {
            const targetSessions = await migrator.listTargetSessions(userEmail);
            const token = await authService.getAccessToken(userEmail);
            const baseUrl = getSafeDiscoveryEngineUrl(targetLocation);

            for (const s of targetSessions) {
              try {
                const delUrl = `${baseUrl}/v1alpha/${s.name}`;
                const delRes = await fetch(delUrl, {
                  method: 'DELETE',
                  headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Goog-User-Project': targetProject
                  }
                });
                if (delRes.ok || delRes.status === 404) {
                  deletedSessions++;
                }
              } catch (sErr: any) {
                logger.warn(`Could not delete session ${s.name} for ${userEmail}: ${sErr.message}`);
              }
            }
          } catch {
            // user might not exist in target engine
          }
        }
      } catch (e: any) {
        logger.warn(`Session cleanup notice: ${e.message}`);
      }
    }

    // 3b. Delete all memories in target engine across all user identities
    let deletedMemories = 0;
    if (cleanMemories) {
      try {
        const { MemoryMigrator } = await import('../engines/memoryMigrator.js');
        const dynamicConfig = getDynamicConfig(req);
        const memMigrator = new MemoryMigrator(dynamicConfig, authService, client);

        for (const userEmail of [undefined, ...targetUsersToClean]) {
          try {
            const targetMems = await memMigrator.listTargetMemories(userEmail);
            for (const m of targetMems) {
              try {
                await client.deleteMemory(m.name, {
                  projectId: targetProject,
                  appLocation: targetLocation,
                  appId: targetEngine,
                  collectionId: targetCollection
                }, userEmail);
                deletedMemories++;
              } catch (mErr: any) {
                logger.warn(`Could not delete memory ${m.name} for ${userEmail || 'default'}: ${mErr.message}`);
              }
            }
          } catch {
            // user might not have memories in target
          }
        }
      } catch (e: any) {
        logger.warn(`Memories cleanup notice: ${e.message}`);
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
      }
    }

    logger.info(`Target cleanup completed: ${deletedNotebooks} notebooks, ${deletedAgents} agents, ${deletedSessions} chat sessions, ${deletedMemories} memories, ${clearedReports} reports, artifacts reset.`);

    return res.status(200).json({
      success: true,
      deletedNotebooks,
      deletedAgents,
      deletedSessions,
      deletedMemories,
      clearedArtifacts,
      clearedReports,
      clearedUserHandover,
      message: `Cleaned ${deletedNotebooks} notebooks, ${deletedAgents} custom agents, ${deletedSessions} chat sessions, ${deletedMemories} user memories, ${clearedReports} migration reports, and reset all user handover bundles and artifacts.`
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'CleanupFailed', message: err.message });
  }
});
