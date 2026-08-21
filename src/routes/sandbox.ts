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
import { GcpAuthService } from '../services/gcpAuth.js';
import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { getSafeDiscoveryEngineUrl } from '../security/validator.js';
import { logger } from '../utils/logger.js';

export const sandboxRouter = express.Router();

// Single User Sandbox: Inspect & Discover Assets for a Specific User
sandboxRouter.post('/single-user/inspect', async (req, res) => {
  try {
    const {
      source,
      target,
      sourceUser,
      targetUser,
      sourceAuthMode = 'DWD',
      sourceBearerToken,
      wifConfigPath = './workforce-identity-config.json',
      saKeyPath = './sa-dwd-key.json',
      notebookIds = []
    } = req.body || {};

    if (!sourceUser || !targetUser) {
      return res.status(400).json({ error: 'MissingParameters', message: 'sourceUser and targetUser are required.' });
    }

    const srcProj = source?.projectId || process.env.SOURCE_PROJECT_ID || '';
    const srcLoc = source?.appLocation || process.env.SOURCE_LOCATION || 'global';
    const srcApp = source?.appId || process.env.SOURCE_APP_ID || '';
    const srcCol = source?.collectionId || process.env.SOURCE_COLLECTION_ID || 'default_collection';

    const tgtProj = target?.projectId || process.env.TARGET_PROJECT_ID || '';
    const tgtLoc = target?.appLocation || process.env.TARGET_LOCATION || 'global';
    const tgtApp = target?.appId || process.env.TARGET_APP_ID || '';
    const tgtCol = target?.collectionId || process.env.TARGET_COLLECTION_ID || 'default_collection';

    // 1. Setup Source Auth
    let sourceAuthService: GcpAuthService;
    const isWifUser = sourceUser.includes('.onmicrosoft.com') || sourceUser.includes('.okta.com') || sourceUser.includes('.pingidentity.com') || sourceAuthMode === 'WIF';
    if (sourceBearerToken && sourceBearerToken.trim()) {
      sourceAuthService = new GcpAuthService({ staticToken: sourceBearerToken.trim() });
    } else if (isWifUser && fs.existsSync(wifConfigPath)) {
      sourceAuthService = new GcpAuthService({ wifConfigPath, authType: 'WORKFORCE_IDENTITY_FEDERATION' });
    } else {
      sourceAuthService = new GcpAuthService({
        serviceAccountKeyPath: fs.existsSync(saKeyPath) ? saKeyPath : undefined,
        staticToken: req.accessToken
      });
    }

    // 2. Setup Target Auth (DWD)
    const targetAuthService = new GcpAuthService({
      serviceAccountKeyPath: fs.existsSync(saKeyPath) ? saKeyPath : undefined,
      staticToken: req.accessToken
    });

    const srcClient = new DiscoveryEngineClient(sourceAuthService);

    // Test Source Token
    let sourceTokenValid = false;
    let sourceTokenError = '';
    try {
      await sourceAuthService.getAccessToken(sourceUser);
      sourceTokenValid = true;
    } catch (e: any) {
      sourceTokenError = e.message;
      try {
        await sourceAuthService.getAccessToken();
        sourceTokenValid = true;
      } catch (e2: any) {
        sourceTokenError = e2.message;
      }
    }

    // Test Target Token (DWD for targetUser)
    let targetTokenValid = false;
    let targetTokenError = '';
    try {
      await targetAuthService.getAccessToken(targetUser);
      targetTokenValid = true;
    } catch (e: any) {
      targetTokenError = e.message;
    }

    // Discover Notebooks
    const discoveredNotebooks: any[] = [];
    const seenNbIds = new Set<string>();

    if (Array.isArray(notebookIds) && notebookIds.length > 0) {
      for (const rawId of notebookIds) {
        const id = (rawId || '').trim().split('/').pop();
        if (id && !seenNbIds.has(id)) {
          try {
            const nb = await srcClient.getNotebook(id, { projectId: srcProj, appLocation: srcLoc, collectionId: srcCol, appId: srcApp });
            seenNbIds.add(id);
            discoveredNotebooks.push({
              id,
              title: nb.title || id,
              owner: sourceUser,
              sourcesCount: (nb as any).sourcesCount || 0,
              createTime: nb.createTime || (nb as any).metadata?.createTime,
              isExplicit: true
            });
          } catch (err: any) {
            logger.warn(`Could not inspect direct notebook ${id}: ${err.message}`);
          }
        }
      }
    }

    try {
      const userNbs = await srcClient.listNotebooks({ projectId: srcProj, appLocation: srcLoc, collectionId: srcCol, appId: srcApp }, sourceUser);
      for (const nb of userNbs) {
        const id = nb.name?.split('/').pop() || nb.notebookId || '';
        if (id && !seenNbIds.has(id)) {
          seenNbIds.add(id);
          discoveredNotebooks.push({
            id,
            title: nb.title || id,
            owner: sourceUser,
            sourcesCount: (nb as any).sourcesCount || 0,
            createTime: nb.createTime || (nb as any).metadata?.createTime
          });
        }
      }
    } catch (nbErr: any) {
      logger.debug(`Single user listNotebooks notice for ${sourceUser}: ${nbErr.message}`);
    }

    // Discover Agents owned by sourceUser
    const discoveredAgents: any[] = [];
    try {
      const allAgents = await srcClient.listAgents({
        projectId: srcProj,
        appLocation: srcLoc,
        collectionId: srcCol,
        appId: srcApp,
        assistantId: 'default_assistant'
      });
      for (const ag of allAgents) {
        const owner = ag.owner || (ag as any).metadata?.ownerEmail || '';
        const normOwner = owner.replace(/^principal:\/\/.*?\/subject\//, '');
        if (!sourceUser || normOwner.toLowerCase() === sourceUser.toLowerCase() || owner.toLowerCase() === sourceUser.toLowerCase()) {
          discoveredAgents.push({
            id: ag.name.split('/').pop(),
            displayName: ag.displayName || ag.name.split('/').pop(),
            agentType: ag.agentType || 'LOW_CODE',
            status: ag.status || 'PUBLISHED',
            owner: normOwner || sourceUser
          });
        }
      }
    } catch (agErr: any) {
      logger.debug(`Single user listAgents notice: ${agErr.message}`);
    }

    // Discover Chat Sessions for sourceUser
    const discoveredSessions: any[] = [];
    try {
      const baseUrl = getSafeDiscoveryEngineUrl(srcLoc);
      const token = await sourceAuthService.getAccessToken();
      const sessUrl = `${baseUrl}/v1alpha/projects/${srcProj}/locations/${srcLoc}/collections/${srcCol}/engines/${srcApp}/sessions?pageSize=100`;
      const sRes = await fetch(sessUrl, {
        headers: { 'Authorization': `Bearer ${token}`, 'X-Goog-User-Project': srcProj }
      });
      if (sRes.ok) {
        const sData: any = await sRes.json();
        for (const s of (sData.sessions || [])) {
          const uId = s.userPseudoId || '';
          if (!sourceUser || uId.toLowerCase() === sourceUser.toLowerCase() || !uId) {
            discoveredSessions.push({
              id: s.name.split('/').pop(),
              displayName: s.displayName || 'Untitled Conversation',
              userPseudoId: uId || sourceUser,
              turnsCount: s.turns?.length || 0
            });
          }
        }
      }
    } catch (sErr: any) {
      logger.debug(`Single user listSessions notice: ${sErr.message}`);
    }

    return res.status(200).json({
      success: true,
      sourceUser,
      targetUser,
      sourceAuth: {
        valid: sourceTokenValid,
        mode: sourceAuthMode,
        error: sourceTokenError || undefined
      },
      targetAuth: {
        valid: targetTokenValid,
        mode: 'DWD',
        error: targetTokenError || undefined
      },
      assets: {
        notebooks: discoveredNotebooks,
        agents: discoveredAgents,
        sessions: discoveredSessions
      }
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'InspectSingleUserFailed', message: err.message });
  }
});
