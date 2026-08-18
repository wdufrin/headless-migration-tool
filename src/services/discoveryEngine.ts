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
import { Agent, Notebook, NotebookSource, NotebookNote, DataStore, AppEngine, IamPolicy } from '../types/index.js';
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

    if (userProject) {
      headers['X-Goog-User-Project'] = userProject;
    }

    return retryWithBackoff(async () => {
      logger.debug(`HTTP ${method} ${url}`);
      const response = await fetch(url, {
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
    const url = `${baseUrl}/v1alpha/${agentName}:publish`;
    return this.request<any>(url, 'POST', {}, env.projectId, undefined, forUserEmail);
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

  async batchDeleteNotebooks(projectId: string, location: string, notebookNames: string[]): Promise<any> {
    const baseUrl = getSafeDiscoveryEngineUrl(location);
    const url = `${baseUrl}/v1alpha/projects/${projectId}/locations/${location}/notebooks:batchDelete`;
    return this.request<any>(url, 'POST', { names: notebookNames }, projectId);
  }

  async getNotebook(notebookId: string, env: EnvironmentConfig): Promise<Notebook> {
    validateResourceId(notebookId, 'notebookId');
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}`;
    return this.request<Notebook>(url, 'GET', undefined, env.projectId);
  }

  async createNotebook(env: EnvironmentConfig, payload: any, forUserEmail?: string): Promise<Notebook> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks`;
    return this.request<Notebook>(url, 'POST', payload, env.projectId, undefined, forUserEmail);
  }

  async getNotebookSource(notebookId: string, sourceId: string, env: EnvironmentConfig): Promise<NotebookSource> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}/sources/${sourceId}`;
    return this.request<NotebookSource>(url, 'GET', undefined, env.projectId);
  }

  async batchCreateNotebookSources(notebookId: string, userContents: any[], env: EnvironmentConfig, forUserEmail?: string): Promise<any> {
    validateResourceId(notebookId, 'notebookId');
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}/sources:batchCreate`;
    return this.request<any>(url, 'POST', { userContents }, env.projectId, undefined, forUserEmail);
  }

  async listNotes(notebookId: string, env: EnvironmentConfig): Promise<NotebookNote[]> {
    validateResourceId(notebookId, 'notebookId');
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}/notes:batchGet`;
    try {
      const res = await this.request<{ notes?: NotebookNote[] }>(url, 'GET', undefined, env.projectId);
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

  async listArtifacts(notebookId: string, env: EnvironmentConfig): Promise<any[]> {
    validateResourceId(notebookId, 'notebookId');
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}/artifacts`;
    try {
      const res = await this.request<{ artifacts?: any[] }>(url, 'GET', undefined, env.projectId);
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

  // --- Engines & DataStores ---

  async getEngine(env: EnvironmentConfig): Promise<AppEngine> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const collection = env.collectionId || 'default_collection';
    const url = `${baseUrl}/v1beta/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/engines/${env.appId}`;
    return this.request<AppEngine>(url, 'GET', undefined, env.projectId);
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
}
