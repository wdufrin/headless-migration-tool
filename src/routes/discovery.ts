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

export const discoveryRouter = express.Router();

function isValidUserIdentity(id: string): boolean {
  if (!id || id === 'unknown' || id === 'undefined' || id === 'null') return false;
  const trimmed = id.trim();
  if (/^\d+$/.test(trimmed)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return false;
  return trimmed.includes('@') || trimmed.startsWith('principal://') || trimmed.startsWith('user:');
}

// User Discovery Endpoint (Gathers users directly across Discovery Engine sessions, agents, & notebooks)
discoveryRouter.get(['/users', '/users/discover'], async (req, res) => {
  try {
    const projectId = (req.query.projectId as string) || process.env.SOURCE_PROJECT_ID || '';
    const location = (req.query.location as string) || 'global';
    const collectionId = (req.query.collectionId as string) || 'default_collection';
    const appId = (req.query.appId as string) || '';

    const saKeyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || 
      (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);

    const authService = new GcpAuthService({
      staticToken: req.accessToken,
      serviceAccountKeyPath: saKeyPath
    });

    const userMap = new Map<string, {
      email: string;
      sessionsCount: number;
      notebooksCount: number;
      agentsCount: number;
      sources: string[];
    }>();

    const token = await authService.getAccessToken().catch(() => null);
    const baseUrl = getSafeDiscoveryEngineUrl(location);

    if (token) {
      // 1. Discover user creators from Custom Agents & Agent IAM Policies
      if (appId && appId !== 'custom') {
        try {
          const agUrl = `${baseUrl}/v1alpha/projects/${projectId}/locations/${location}/collections/${collectionId}/engines/${appId}/assistants/default_assistant/agents?pageSize=100`;
          const agResp = await fetch(agUrl, {
            headers: { 
              'Authorization': `Bearer ${token}`,
              'X-Goog-User-Project': projectId
            }
          });
          if (agResp.ok) {
            const agData: any = await agResp.json();
            const agents = agData.agents || [];
            
            // Inspect IAM policies on agents in parallel batches
            await Promise.all(agents.slice(0, 30).map(async (a: any) => {
              try {
                const iamRes = await fetch(`${baseUrl}/v1alpha/${a.name}:getIamPolicy`, {
                  headers: { 
                    'Authorization': `Bearer ${token}`,
                    'X-Goog-User-Project': projectId
                  }
                });
                if (iamRes.ok) {
                  const iamData: any = await iamRes.json();
                  for (const binding of iamData.bindings || []) {
                    for (const m of binding.members || []) {
                      if (m.startsWith('user:') && isValidUserIdentity(m)) {
                        const cleanEmail = m.replace(/^user:/i, '').trim();
                        const existing = userMap.get(cleanEmail) || {
                          email: cleanEmail,
                          sessionsCount: 0,
                          notebooksCount: 0,
                          agentsCount: 0,
                          sources: [] as string[]
                        };
                        existing.agentsCount++;
                        const srcLabel = `Agent (${a.displayName || 'Custom'})`;
                        if (!existing.sources.includes(srcLabel) && existing.sources.length < 3) {
                          existing.sources.push(srcLabel);
                        }
                        userMap.set(cleanEmail, existing);
                      }
                    }
                  }
                }
              } catch {}
            }));
          }
        } catch (agErr: any) {
          logger.debug(`Agents user discovery skipped: ${agErr.message}`);
        }
      }

      // 2. Discover users from Discovery Engine Chat Sessions
      if (appId && appId !== 'custom') {
        try {
          const url = `${baseUrl}/v1alpha/projects/${projectId}/locations/${location}/collections/${collectionId}/engines/${appId}/sessions?pageSize=100`;
          const resp = await fetch(url, {
            headers: { 
              'Authorization': `Bearer ${token}`,
              'X-Goog-User-Project': projectId
            }
          });
          if (resp.ok) {
            const sessData: any = await resp.json();
            const sessions = sessData.sessions || [];
            for (const s of sessions) {
              const userEmail = s.userPseudoId || s.user || '';
              if (isValidUserIdentity(userEmail)) {
                const cleanEmail = userEmail.replace(/^user:/i, '').trim();
                const existing = userMap.get(cleanEmail) || {
                  email: cleanEmail,
                  sessionsCount: 0,
                  notebooksCount: 0,
                  agentsCount: 0,
                  sources: [] as string[]
                };
                existing.sessionsCount++;
                if (!existing.sources.includes('Chat Sessions')) {
                  existing.sources.push('Chat Sessions');
                }
                userMap.set(cleanEmail, existing);
              }
            }
          }
        } catch (sessErr: any) {
          logger.debug(`Sessions discovery skipped or failed: ${sessErr.message}`);
        }
      }

      // 3. Discover user owners from Notebooks
      try {
        const nbUrl = `${baseUrl}/v1alpha/projects/${projectId}/locations/${location}/notebooks:listRecentlyViewed`;
        const nbResp = await fetch(nbUrl, {
          headers: { 
            'Authorization': `Bearer ${token}`,
            'X-Goog-User-Project': projectId
          }
        });
        if (nbResp.ok) {
          const nbData: any = await nbResp.json();
          const notebooks = nbData.notebooks || [];
          for (const nb of notebooks) {
            const owner = nb.owner || nb.creator || nb.metadata?.owner || nb.metadata?.ownerEmail || nb.metadata?.creatorEmail || '';
            if (isValidUserIdentity(owner)) {
              const cleanOwner = owner.replace(/^user:/i, '').trim();
              const existing = userMap.get(cleanOwner) || {
                email: cleanOwner,
                sessionsCount: 0,
                notebooksCount: 0,
                agentsCount: 0,
                sources: [] as string[]
              };
              existing.notebooksCount++;
              if (!existing.sources.includes('NotebookLM')) {
                existing.sources.push('NotebookLM');
              }
              userMap.set(cleanOwner, existing);
            }
          }
        }
      } catch (nbErr: any) {
        logger.debug(`Notebooks user discovery skipped: ${nbErr.message}`);
      }
    }

    // Fallback: If no users found, provide default configured admin if defined in environment
    if (userMap.size === 0 && (process.env.ADMIN_EMAIL || process.env.DEFAULT_USER_EMAIL)) {
      const defaultUser = process.env.ADMIN_EMAIL || process.env.DEFAULT_USER_EMAIL || '';
      userMap.set(defaultUser, {
        email: defaultUser,
        sessionsCount: 0,
        notebooksCount: 0,
        agentsCount: 0,
        sources: ['Configured Admin']
      });
    }

    const users = Array.from(userMap.values());
    return res.status(200).json({
      success: true,
      totalUsers: users.length,
      users
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'UserDiscoveryFailed', message: err.message });
  }
});

export function buildGeminiEnterpriseAppUrl(
  cid?: string,
  location: string = 'global',
  idpProvider?: string,
  route: string = ''
): string | undefined {
  if (!cid) return undefined;
  const loc = (location || 'global').toLowerCase();
  const locPrefix = loc !== 'global' ? `${loc}/` : '';
  const subPath = route ? `/r/${route}` : '';

  if (idpProvider) {
    const cleanIdp = idpProvider
      .replace(/^https?:\/\/auth\.cloud\.google\/signin\//, '')
      .replace(/^\/+/, '');
    const rawTargetUrl = `https://vertexaisearch.cloud.google/${locPrefix}home/cid/${cid}${subPath}&hl=en_US`;
    return `https://auth.cloud.google/signin/${cleanIdp}?continueUrl=${encodeURIComponent(rawTargetUrl)}`;
  }

  return `https://vertexaisearch.cloud.google.com/${locPrefix}home/cid/${cid}${subPath}?hl=en_US`;
}

// List Available Gemini Enterprise Engines/Apps for Project & Region
discoveryRouter.get('/engines/list', async (req, res) => {
  try {
    const projectId = req.query.projectId as string;
    const location = (req.query.location as string) || 'global';
    const collectionId = (req.query.collectionId as string) || 'default_collection';

    if (!projectId) {
      return res.status(400).json({ error: 'MissingProject', message: 'projectId is required' });
    }

    const saKeyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || 
      (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);

    const authService = new GcpAuthService({
      staticToken: req.accessToken,
      serviceAccountKeyPath: saKeyPath
    });
    const client = new DiscoveryEngineClient(authService);
    const engines = await client.listEngines({ projectId, appLocation: location, collectionId });

    const formatted = engines.map((eng: any) => {
      const parts = eng.name?.split('/') || [];
      const engineId = parts[parts.length - 1] || eng.displayName || eng.name;
      const cid = eng.widgetConfigConfigId || eng.cid || undefined;

      // Detect IdP provider from mobile deeplink URL or external data connectors
      let detectedIdp: string | undefined = undefined;
      if (eng.mobileDeeplinkUrl) {
        try {
          const parsed = new URL(eng.mobileDeeplinkUrl);
          const p = parsed.searchParams.get('idp');
          if (p) detectedIdp = decodeURIComponent(p);
        } catch {}
      }
      if (!detectedIdp && (eng.dataStoreIds || []).some((d: string) => d.includes('entra') || d.includes('outlook') || d.includes('onedrive') || d.includes('sharepoint'))) {
        detectedIdp = process.env.WIF_PROVIDER_ID || undefined;
      }

      return {
        id: engineId,
        displayName: eng.displayName || engineId,
        solutionType: eng.solutionType,
        name: eng.name,
        cid: cid,
        widgetConfigConfigId: cid,
        idpProvider: detectedIdp,
        location: location,
        webAppUrl: buildGeminiEnterpriseAppUrl(cid, location, detectedIdp, ''),
        agentGalleryUrl: buildGeminiEnterpriseAppUrl(cid, location, detectedIdp, 'agents'),
        mobileDeeplinkUrl: eng.mobileDeeplinkUrl || undefined
      };
    });

    return res.status(200).json({
      engines: formatted
    });
  } catch (err: any) {
    logger.warn(`Failed to list engines for project ${req.query.projectId}: ${err.message}`);
    return res.status(200).json({
      engines: [],
      error: err.message
    });
  }
});

// Resolve Gemini Enterprise Web App URL for a specific Engine/App
discoveryRouter.get('/engines/app-url', async (req, res) => {
  try {
    const projectId = req.query.projectId as string;
    const location = (req.query.location as string) || 'global';
    const collectionId = (req.query.collectionId as string) || 'default_collection';
    const engineId = req.query.engineId as string;
    const reqIdpType = (req.query.idpType as string) || '';
    const reqIdpProvider = (req.query.idpProvider as string) || '';

    if (!projectId || !engineId) {
      return res.status(400).json({ error: 'MissingParameters', message: 'projectId and engineId are required' });
    }

    const saKeyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || 
      (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);

    const authService = new GcpAuthService({
      staticToken: req.accessToken,
      serviceAccountKeyPath: saKeyPath
    });
    const client = new DiscoveryEngineClient(authService);

    const engine = await client.getEngine({
      projectId,
      appLocation: location,
      collectionId,
      appId: engineId
    });

    const cid = engine?.widgetConfigConfigId || (engine as any)?.cid;

    // Detect IdP provider
    let detectedIdp: string | undefined = reqIdpProvider || undefined;
    if (!detectedIdp && engine?.mobileDeeplinkUrl) {
      try {
        const parsed = new URL(engine.mobileDeeplinkUrl);
        const p = parsed.searchParams.get('idp');
        if (p) detectedIdp = decodeURIComponent(p);
      } catch {}
    }

    if (!detectedIdp && (
      reqIdpType === 'entra' ||
      reqIdpType === 'wif' ||
      reqIdpType === 'WORKFORCE_IDENTITY_FEDERATION' ||
      engineId.toLowerCase().includes('entra') ||
      (engine?.dataStoreIds || []).some((d: string) => d.includes('entra') || d.includes('outlook') || d.includes('onedrive') || d.includes('sharepoint'))
    )) {
      detectedIdp = process.env.WIF_PROVIDER_ID || undefined;
    }

    const webAppUrl = buildGeminiEnterpriseAppUrl(cid, location, detectedIdp, '') || `https://console.cloud.google.com/gen-app-builder/engines?project=${encodeURIComponent(projectId)}`;
    const agentGalleryUrl = buildGeminiEnterpriseAppUrl(cid, location, detectedIdp, 'agents');
    const chatUrl = buildGeminiEnterpriseAppUrl(cid, location, detectedIdp, 'chat');
    const notebooksUrl = buildGeminiEnterpriseAppUrl(cid, location, detectedIdp, 'notebook');
    const consoleUrl = `https://console.cloud.google.com/gen-app-builder/engines?project=${encodeURIComponent(projectId)}`;

    return res.status(200).json({
      engineId,
      displayName: engine?.displayName || engineId,
      cid,
      location,
      idpProvider: detectedIdp,
      webAppUrl,
      agentGalleryUrl,
      chatUrl,
      notebooksUrl,
      consoleUrl,
      mobileDeeplinkUrl: engine?.mobileDeeplinkUrl
    });
  } catch (err: any) {
    logger.warn(`Failed to resolve app URL for engine ${req.query.engineId}: ${err.message}`);
    const projectId = req.query.projectId as string;
    return res.status(200).json({
      engineId: req.query.engineId,
      consoleUrl: `https://console.cloud.google.com/gen-app-builder/engines?project=${encodeURIComponent(projectId || '')}`,
      error: err.message
    });
  }
});
