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

export function isValidUserIdentity(id: string): boolean {
  if (!id || id === 'unknown' || id === 'undefined' || id === 'null') return false;
  const trimmed = id.trim();
  if (/^\d+$/.test(trimmed)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return false;
  return trimmed.includes('@') || trimmed.startsWith('principal://') || trimmed.startsWith('principalSet://') || trimmed.startsWith('user:');
}

/**
 * Extracts and cleans a user identity (email or UPN) from GCP IAM member strings,
 * Workforce Identity Federation principals, or user: prefixed identifiers.
 */
export function extractUserIdentity(member: string): string | null {
  if (!member || typeof member !== 'string') return null;
  let trimmed = member.trim();
  if (
    !trimmed || 
    trimmed === 'allUsers' || 
    trimmed === 'allAuthenticatedUsers' || 
    trimmed.startsWith('deleted:') ||
    trimmed.endsWith('.gserviceaccount.com') ||
    trimmed.startsWith('serviceAccount:')
  ) {
    return null;
  }

  // 1. Workforce Identity Federation principals:
  // e.g. principal://iam.googleapis.com/locations/global/workforcePools/wdufrin-entra/subject/wdufrin@wdufrin.onmicrosoft.com
  // or   principal://iam.googleapis.com/projects/12345/locations/global/workforcePools/pool/subject/user@domain.com
  if (trimmed.startsWith('principal://') || trimmed.startsWith('principalSet://')) {
    const subjectMatch = trimmed.match(/\/subject\/([^/]+)$/i);
    if (subjectMatch && subjectMatch[1]) {
      let decoded = subjectMatch[1];
      try {
        decoded = decodeURIComponent(decoded).trim();
      } catch {}
      if (isValidUserIdentity(decoded) && !decoded.endsWith('.gserviceaccount.com')) {
        return decoded.replace(/^user:/i, '').trim();
      }
    }

    const attrMatch = trimmed.match(/\/attribute\.(?:user_email|email|upn|mail)\/([^/]+)$/i);
    if (attrMatch && attrMatch[1]) {
      let decoded = attrMatch[1];
      try {
        decoded = decodeURIComponent(decoded).trim();
      } catch {}
      if (isValidUserIdentity(decoded) && !decoded.endsWith('.gserviceaccount.com')) {
        return decoded.replace(/^user:/i, '').trim();
      }
    }

    // Check for any email pattern embedded within the principal string
    const emailMatch = trimmed.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (emailMatch && emailMatch[1]) {
      const email = emailMatch[1].trim();
      if (!email.endsWith('.gserviceaccount.com') && isValidUserIdentity(email)) {
        return email;
      }
    }

    return null;
  }

  // 2. Standard user: prefix (Google Cloud Identity / Workspace)
  if (trimmed.toLowerCase().startsWith('user:')) {
    trimmed = trimmed.replace(/^user:/i, '').trim();
  }

  // 3. Clean user email address
  if (trimmed.includes('@') && isValidUserIdentity(trimmed) && !trimmed.endsWith('.gserviceaccount.com')) {
    return trimmed;
  }

  return null;
}

// User Discovery Endpoint (Gathers users directly across Discovery Engine sessions, agents, & notebooks)
discoveryRouter.get(['/users', '/users/discover'], async (req, res) => {
  try {
    const projectId = (req.query.projectId as string) || process.env.SOURCE_PROJECT_ID || '';
    const location = (req.query.location as string) || 'global';
    const collectionId = (req.query.collectionId as string) || 'default_collection';
    const appId = (req.query.appId as string) || '';

    const scope = (req.query.scope as string) || (appId && appId !== 'all' ? 'single' : 'all');

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
      memoriesCount?: number;
      sources: string[];
    }>();

    const token = await authService.getAccessToken().catch(() => null);
    const baseUrl = getSafeDiscoveryEngineUrl(location);

    if (token) {
      // Determine which engine(s) to scan
      const enginesToScan: string[] = [];
      if (appId && appId !== 'custom' && appId !== 'all' && scope !== 'all') {
        enginesToScan.push(appId);
      } else if (projectId) {
        try {
          const client = new DiscoveryEngineClient(authService);
          const listed = await client.listEngines({ projectId, appLocation: location, collectionId });
          for (const eng of listed) {
            const eid = eng.name?.split('/').pop() || eng.id;
            if (eid && !enginesToScan.includes(eid)) {
              enginesToScan.push(eid);
            }
          }
        } catch (eErr: any) {
          logger.debug(`Could not list engines for project-wide user discovery: ${eErr.message}`);
        }
      }

      // 1. Discover user creators from Custom Agents & Agent IAM Policies across target engines
      for (const curAppId of enginesToScan) {
        try {
          const agUrl = `${baseUrl}/v1alpha/projects/${projectId}/locations/${location}/collections/${collectionId}/engines/${curAppId}/assistants/default_assistant/agents?pageSize=100`;
          const agResp = await fetch(agUrl, {
            headers: { 
              'Authorization': `Bearer ${token}`,
              'X-Goog-User-Project': projectId
            }
          });
          if (agResp.ok) {
            const agData: any = await agResp.json();
            const agents = agData.agents || [];
            
            // Check direct agent owner / creator fields
            for (const a of agents) {
              const directOwner = extractUserIdentity(a.owner || a.creator || a.skillAgentDefinition?.owner || '');
              if (directOwner) {
                const existing = userMap.get(directOwner) || {
                  email: directOwner,
                  sessionsCount: 0,
                  notebooksCount: 0,
                  agentsCount: 0,
                  sources: [] as string[]
                };
                const srcLabel = `Agent (${a.displayName || 'Custom'})`;
                if (!existing.sources.includes(srcLabel) && existing.sources.length < 3) {
                  existing.sources.push(srcLabel);
                }
                userMap.set(directOwner, existing);
              }
            }

            // Inspect IAM policies on agents in concurrent batches of 10
            const chunkSize = 10;
            for (let i = 0; i < agents.length; i += chunkSize) {
              const chunk = agents.slice(i, i + chunkSize);
              await Promise.all(chunk.map(async (a: any) => {
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
                        const cleanEmail = extractUserIdentity(m);
                        if (cleanEmail) {
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
          }
        } catch (agErr: any) {
          logger.debug(`Agents user discovery skipped for ${curAppId}: ${agErr.message}`);
        }

        // 2. Discover users from Discovery Engine Chat Sessions
        try {
          const url = `${baseUrl}/v1alpha/projects/${projectId}/locations/${location}/collections/${collectionId}/engines/${curAppId}/sessions?pageSize=100`;
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
              const cleanEmail = extractUserIdentity(userEmail);
              if (cleanEmail) {
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
          logger.debug(`Sessions discovery skipped or failed for ${curAppId}: ${sessErr.message}`);
        }

        // 3. Discover users from Memories
        try {
          const memUrl = `${baseUrl}/v1alpha/projects/${projectId}/locations/${location}/collections/${collectionId}/engines/${curAppId}/memories?pageSize=100`;
          const memResp = await fetch(memUrl, {
            headers: { 
              'Authorization': `Bearer ${token}`,
              'X-Goog-User-Project': projectId
            }
          });
          if (memResp.ok) {
            const memData: any = await memResp.json();
            const memories = memData.memories || [];
            if (memories.length > 0) {
              const callerId = (await authService.getCallerIdentity?.()) || process.env.ADMIN_EMAIL || process.env.DEFAULT_USER_EMAIL || '';
              const cleanEmail = extractUserIdentity(callerId);
              if (cleanEmail) {
                const existing = userMap.get(cleanEmail) || {
                  email: cleanEmail,
                  sessionsCount: 0,
                  notebooksCount: 0,
                  agentsCount: 0,
                  memoriesCount: 0,
                  sources: [] as string[]
                };
                existing.memoriesCount = (existing.memoriesCount || 0) + memories.length;
                if (!existing.sources.includes('Personal Memories')) {
                  existing.sources.push('Personal Memories');
                }
                userMap.set(cleanEmail, existing);
              }
            }
          }
        } catch (memErr: any) {
          logger.debug(`Memories user discovery skipped for ${curAppId}: ${memErr.message}`);
        }
      }

      // 4. Discover user owners from Notebooks
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
            const cleanOwner = extractUserIdentity(owner);
            if (cleanOwner) {
              const existing = userMap.get(cleanOwner) || {
                email: cleanOwner,
                sessionsCount: 0,
                notebooksCount: 0,
                agentsCount: 0,
                memoriesCount: 0,
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
