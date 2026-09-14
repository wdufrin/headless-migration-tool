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

import { EnvironmentConfig } from '../types/migration.js';
import { Agent, Notebook, NotebookSource, NotebookNote, DataStore, AppEngine, IamPolicy, Memory } from '../types/index.js';
import { getSafeDiscoveryEngineUrl, validateResourceId } from '../security/validator.js';
import { GcpAuthService } from './gcpAuth.js';
import { retryWithBackoff } from '../utils/concurrency.js';
import { logger } from '../utils/logger.js';

export class DiscoveryEngineClient {
  private auth: GcpAuthService;

  constructor(auth: GcpAuthService) {
    this.auth = auth;
  }

  private async request<T>(
    url: string,
    method: string = 'GET',
    body?: any,
    userProject?: string,
    customHeaders?: Record<string, string>,
    forUserEmail?: string
  ): Promise<T> {
    const token = await this.auth.getAccessToken(forUserEmail);
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...customHeaders
    };

    const homeProject = process.env.SOURCE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
    if (userProject) {
      headers['X-Goog-User-Project'] = userProject;
    } else if (homeProject) {
      headers['X-Goog-User-Project'] = homeProject;
    }

    return retryWithBackoff(async () => {
      logger.debug(`HTTP ${method} ${url}`);
      let response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      });

      if (!response.ok) {
        const errorText = await response.text();
        let parsedError: any;
        try {
          parsedError = JSON.parse(errorText);
        } catch {
          parsedError = null;
        }

        // If target quota project is denied (caller lacks serviceusage.services.use on target), retry with home project
        if (response.status === 403 && headers['X-Goog-User-Project'] !== homeProject && homeProject) {
          const reason = parsedError?.error?.details?.[0]?.reason || '';
          const msg = parsedError?.error?.message || errorText;
          if (reason === 'USER_PROJECT_DENIED' || msg.includes('USER_PROJECT_DENIED') || msg.includes('serviceusage.services.use')) {
            logger.debug(`Target quota project denied; retrying request with home quota project: ${homeProject}`);
            headers['X-Goog-User-Project'] = homeProject;
            response = await fetch(url, {
              method,
              headers,
              body: body ? JSON.stringify(body) : undefined
            });
            if (response.ok) {
              if (response.status === 204) return {} as T;
              return (await response.json()) as T;
            }
          }
        }

        const msg = parsedError?.error?.message || errorText || response.statusText;
        const err: any = new Error(`Discovery Engine API Request Failed [${response.status}]: ${msg}`);
        err.status = response.status;
        err.details = parsedError;
        throw err;
      }

      if (response.status === 204) {
        return {} as T;
      }

      return (await response.json()) as T;
    });
  }

  // --- Agents ---

  async listAgents(env: EnvironmentConfig, forUserEmail?: string): Promise<Agent[]> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const collection = env.collectionId || 'default_collection';
    const assistant = env.assistantId || 'default_assistant';
    let url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/engines/${env.appId}/assistants/${assistant}/agents?pageSize=200`;

    const agents: Agent[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const currentUrl: string = pageToken ? `${url}&pageToken=${encodeURIComponent(pageToken)}` : url;
      const res: { agents?: Agent[]; nextPageToken?: string } = await this.request<{ agents?: Agent[]; nextPageToken?: string }>(currentUrl, 'GET', undefined, env.projectId, undefined, forUserEmail);
      if (res.agents) {
        agents.push(...res.agents);
      }
      pageToken = res.nextPageToken;
    } while (pageToken);

    return agents;
  }

  async getAgent(agentName: string, env: EnvironmentConfig): Promise<Agent> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/${agentName}`;
    return this.request<Agent>(url, 'GET', undefined, env.projectId);
  }

  async createAgent(env: EnvironmentConfig, payload: any, agentId?: string, forUserEmail?: string): Promise<Agent> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const collection = env.collectionId || 'default_collection';
    const assistant = env.assistantId || 'default_assistant';
    let url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/engines/${env.appId}/assistants/${assistant}/agents`;
    if (agentId) {
      validateResourceId(agentId, 'agentId');
      url += `?agentId=${encodeURIComponent(agentId)}`;
    }
    return this.request<Agent>(url, 'POST', payload, env.projectId, undefined, forUserEmail);
  }

  async getAgentIamPolicy(agentName: string, env: EnvironmentConfig): Promise<IamPolicy> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/${agentName}:getIamPolicy`;
    try {
      return await this.request<IamPolicy>(url, 'GET', undefined, env.projectId);
    } catch (err: any) {
      logger.warn(`Could not get IAM policy for agent ${agentName}: ${err.message}`);
      return { bindings: [] };
    }
  }

  async setAgentIamPolicy(agentName: string, policy: IamPolicy, env: EnvironmentConfig): Promise<IamPolicy> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/${agentName}:setIamPolicy`;
    return this.request<IamPolicy>(url, 'POST', { policy }, env.projectId);
  }

  async patchAgentSharing(agentName: string, sharingConfig: any, env: EnvironmentConfig, forUserEmail?: string): Promise<Agent> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/${agentName}?updateMask=sharingConfig`;
    return this.request<Agent>(url, 'PATCH', { sharingConfig }, env.projectId, undefined, forUserEmail);
  }

  async publishAgent(agentName: string, env: EnvironmentConfig, forUserEmail?: string): Promise<any> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/${agentName}?updateMask=state`;
    return this.request<any>(url, 'PATCH', { state: 'ENABLED' }, env.projectId, undefined, forUserEmail);
  }

  async deleteAgent(agentName: string, location: string = 'global', projectId?: string): Promise<any> {
    const baseUrl = getSafeDiscoveryEngineUrl(location);
    const url = `${baseUrl}/v1alpha/${agentName}`;
    const pId = projectId || agentName.split('/')[1];
    return this.request<any>(url, 'DELETE', undefined, pId);
  }

  // --- Notebooks ---

  async listNotebooks(env: EnvironmentConfig, forUserEmail?: string): Promise<Notebook[]> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks:listRecentlyViewed`;
    const res = await this.request<{ notebooks?: Notebook[] }>(url, 'GET', undefined, env.projectId, undefined, forUserEmail);
    const notebooks = res.notebooks || [];
    if (forUserEmail) {
      for (const nb of notebooks) {
        nb.owner = forUserEmail;
        if (!nb.metadata) nb.metadata = {};
        nb.metadata.ownerEmail = forUserEmail;
      }
    }
    return notebooks;
  }

  async batchDeleteNotebooks(projectId: string, location: string, notebookNames: string[], forUserEmail?: string): Promise<any> {
    const baseUrl = getSafeDiscoveryEngineUrl(location);
    const url = `${baseUrl}/v1alpha/projects/${projectId}/locations/${location}/notebooks:batchDelete`;
    for (const name of notebookNames) {
      try {
        await this.request<any>(url, 'POST', { names: [name] }, projectId, undefined, forUserEmail);
      } catch (err: any) {
        logger.warn(`Could not delete notebook ${name}: ${err.message}`);
      }
    }
    return { success: true, count: notebookNames.length };
  }

  async getNotebook(notebookId: string, env: EnvironmentConfig, forUserEmail?: string): Promise<Notebook> {
    validateResourceId(notebookId, 'notebookId');
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}`;
    return this.request<Notebook>(url, 'GET', undefined, env.projectId, undefined, forUserEmail);
  }

  async createNotebook(env: EnvironmentConfig, payload: any, forUserEmail?: string): Promise<Notebook> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks`;
    return this.request<Notebook>(url, 'POST', payload, env.projectId, undefined, forUserEmail);
  }

  async getNotebookSource(notebookId: string, sourceId: string, env: EnvironmentConfig, forUserEmail?: string): Promise<NotebookSource> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}/sources/${sourceId}`;
    return this.request<NotebookSource>(url, 'GET', undefined, env.projectId, undefined, forUserEmail);
  }

  async batchCreateNotebookSources(notebookId: string, userContents: any[], env: EnvironmentConfig, forUserEmail?: string): Promise<any> {
    validateResourceId(notebookId, 'notebookId');
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}/sources:batchCreate`;
    return this.request<any>(url, 'POST', { userContents }, env.projectId, undefined, forUserEmail);
  }

  async listNotes(notebookId: string, env: EnvironmentConfig, forUserEmail?: string): Promise<NotebookNote[]> {
    validateResourceId(notebookId, 'notebookId');
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}/notes`;
    try {
      const res = await this.request<{ notes?: NotebookNote[] }>(url, 'GET', undefined, env.projectId, undefined, forUserEmail);
      return res.notes || [];
    } catch {
      return [];
    }
  }

  async createNote(notebookId: string, payload: any, env: EnvironmentConfig, forUserEmail?: string): Promise<NotebookNote> {
    validateResourceId(notebookId, 'notebookId');
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}/notes`;
    return this.request<NotebookNote>(url, 'POST', payload, env.projectId, undefined, forUserEmail);
  }

  async listArtifacts(notebookId: string, env: EnvironmentConfig, forUserEmail?: string): Promise<any[]> {
    validateResourceId(notebookId, 'notebookId');
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}/artifacts`;
    try {
      const res = await this.request<{ artifacts?: any[] }>(url, 'GET', undefined, env.projectId, undefined, forUserEmail);
      return res.artifacts || [];
    } catch {
      return [];
    }
  }

  async createArtifact(notebookId: string, payload: any, env: EnvironmentConfig, forUserEmail?: string): Promise<any> {
    validateResourceId(notebookId, 'notebookId');
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}/artifacts`;
    return this.request<any>(url, 'POST', payload, env.projectId, undefined, forUserEmail);
  }

  async listEngines(env: { projectId: string; appLocation: string; collectionId?: string }): Promise<AppEngine[]> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const collection = env.collectionId || 'default_collection';
    const url = `${baseUrl}/v1beta/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/engines?pageSize=100`;
    try {
      const res = await this.request<{ engines?: AppEngine[] }>(url, 'GET', undefined, env.projectId);
      return res.engines || [];
    } catch (err: any) {
      try {
        const fallbackUrl = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/engines?pageSize=100`;
        const resFallback = await this.request<{ engines?: AppEngine[] }>(fallbackUrl, 'GET', undefined, env.projectId);
        return resFallback.engines || [];
      } catch (e: any) {
        logger.warn(`Failed to list engines for project ${env.projectId}: ${e.message}`);
        throw e;
      }
    }
  }

  async getEngine(env: EnvironmentConfig): Promise<AppEngine> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const collection = env.collectionId || 'default_collection';
    const url = `${baseUrl}/v1beta/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/engines/${env.appId}`;
    return this.request<AppEngine>(url, 'GET', undefined, env.projectId);
  }

  async patchEngine(env: EnvironmentConfig, payload: any, updateMask: string): Promise<AppEngine> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const collection = env.collectionId || 'default_collection';
    const cleanMask = updateMask.split(',').map(s => encodeURIComponent(s.trim())).join(',');
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/engines/${env.appId}?updateMask=${cleanMask}`;
    return this.request<AppEngine>(url, 'PATCH', payload, env.projectId);
  }

  async listDataStores(env: EnvironmentConfig): Promise<DataStore[]> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const collection = env.collectionId || 'default_collection';
    const url = `${baseUrl}/v1beta/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/dataStores?pageSize=100`;
    const res = await this.request<{ dataStores?: DataStore[] }>(url, 'GET', undefined, env.projectId);
    return res.dataStores || [];
  }

  async getDataStore(dataStoreId: string, env: EnvironmentConfig): Promise<DataStore> {
    validateResourceId(dataStoreId, 'dataStoreId');
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const collection = env.collectionId || 'default_collection';
    const url = `${baseUrl}/v1beta/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/dataStores/${dataStoreId}`;
    return this.request<DataStore>(url, 'GET', undefined, env.projectId);
  }

  /**
   * Dynamically inspects the Identity Provider (IdP) configuration of a Gemini Enterprise Engine/App
   * by inspecting its live engine metadata, mobile deeplink URL, workforce identity pools, and data connector types.
   */
  async detectEngineIdpConfig(env: EnvironmentConfig): Promise<{
    type: 'WORKFORCE_IDENTITY_FEDERATION' | 'GOOGLE_CLOUD_IDENTITY';
    provider?: string;
    tenantId?: string;
    clientId?: string;
    cid?: string;
    isExternalIdp: boolean;
    dataStoreIds?: string[];
  }> {
    try {
      const engine = await this.getEngine(env);
      if (engine?.mobileDeeplinkUrl) {
        try {
          const parsed = new URL(engine.mobileDeeplinkUrl);
          const idp = parsed.searchParams.get('idp');
          const tenantId = parsed.searchParams.get('tenant_id');
          const clientId = parsed.searchParams.get('client_id');
          const cid = parsed.searchParams.get('cid') || engine.widgetConfigConfigId;

          if (idp || tenantId) {
            return {
              type: 'WORKFORCE_IDENTITY_FEDERATION',
              provider: idp ? decodeURIComponent(idp) : undefined,
              tenantId: tenantId || undefined,
              clientId: clientId || undefined,
              cid: cid || undefined,
              isExternalIdp: true,
              dataStoreIds: engine.dataStoreIds
            };
          }
        } catch {
          if (engine.mobileDeeplinkUrl.includes('workforcePools') || engine.mobileDeeplinkUrl.includes('tenant_id')) {
            return {
              type: 'WORKFORCE_IDENTITY_FEDERATION',
              isExternalIdp: true,
              dataStoreIds: engine.dataStoreIds
            };
          }
        }
      }

      const hasExternalConnectors = engine?.dataStoreIds?.some(ds =>
        ds.includes('entraid') || ds.includes('outlook') || ds.includes('onedrive') || ds.includes('sharepoint')
      );

      return {
        type: hasExternalConnectors ? 'WORKFORCE_IDENTITY_FEDERATION' : 'GOOGLE_CLOUD_IDENTITY',
        cid: engine?.widgetConfigConfigId,
        isExternalIdp: !!hasExternalConnectors,
        dataStoreIds: engine?.dataStoreIds
      };
    } catch (err: any) {
      logger.debug(`Could not dynamically detect engine IdP config: ${err.message}`);
      return {
        type: 'GOOGLE_CLOUD_IDENTITY',
        isExternalIdp: false
      };
    }
  }

  // --- Memories ---

  private projectNumberCache: Map<string, string> = new Map();

  async resolveProjectNumber(env: EnvironmentConfig): Promise<string> {
    if (this.projectNumberCache.has(env.projectId)) {
      return this.projectNumberCache.get(env.projectId)!;
    }
    if (/^\d+$/.test(env.projectId)) {
      this.projectNumberCache.set(env.projectId, env.projectId);
      return env.projectId;
    }
    try {
      const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
      const collection = env.collectionId || 'default_collection';
      const eng = await this.request<any>(
        `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/engines/${env.appId}`,
        'GET',
        undefined,
        env.projectId
      );
      if (eng?.name) {
        const match = eng.name.match(/^projects\/(\d+)\//);
        if (match && match[1]) {
          this.projectNumberCache.set(env.projectId, match[1]);
          return match[1];
        }
      }
    } catch (err: any) {
      logger.debug(`Could not resolve numeric project number for ${env.projectId}: ${err.message}`);
    }
    return env.projectId;
  }

  async listMemories(env: EnvironmentConfig, forUserEmail?: string): Promise<Memory[]> {
    const projectNum = await this.resolveProjectNumber(env);
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const collection = env.collectionId || 'default_collection';
    const url = `${baseUrl}/v1alpha/projects/${projectNum}/locations/${env.appLocation}/collections/${collection}/engines/${env.appId}/memories?pageSize=100`;

    const memories: Memory[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const currentUrl: string = pageToken ? `${url}&pageToken=${encodeURIComponent(pageToken)}` : url;
      const res: { memories?: Memory[]; nextPageToken?: string } = await this.request<{ memories?: Memory[]; nextPageToken?: string }>(
        currentUrl,
        'GET',
        undefined,
        env.projectId,
        undefined,
        forUserEmail
      );
      if (res.memories && Array.isArray(res.memories)) {
        for (const m of res.memories) {
          if (forUserEmail) {
            m.owner = forUserEmail;
            m.userEmail = forUserEmail;
            m.userPseudoId = forUserEmail;
          }
          memories.push(m);
        }
      }
      pageToken = res.nextPageToken;
    } while (pageToken);

    return memories;
  }

  async generateMemories(env: EnvironmentConfig, text: string, forUserEmail?: string): Promise<any> {
    const projectNum = await this.resolveProjectNumber(env);
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const collection = env.collectionId || 'default_collection';
    const url = `${baseUrl}/v1alpha/projects/${projectNum}/locations/${env.appLocation}/collections/${collection}/engines/${env.appId}:generateMemories`;
    return this.request<any>(
      url,
      'POST',
      { text },
      env.projectId,
      undefined,
      forUserEmail
    );
  }

  async deleteMemory(memoryName: string, env: EnvironmentConfig, forUserEmail?: string): Promise<any> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = memoryName.startsWith('http') ? memoryName : `${baseUrl}/v1alpha/${memoryName}`;
    return this.request<any>(
      url,
      'DELETE',
      undefined,
      env.projectId,
      undefined,
      forUserEmail
    );
  }
}

