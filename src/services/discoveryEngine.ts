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
import { Agent, Notebook, NotebookSource, NotebookNote, DataStore, ConnectorCollection, AppEngine, IamPolicy, Memory } from '../types/index.js';
import { getSafeDiscoveryEngineUrl, validateResourceId } from '../security/validator.js';
import { GcpAuthService } from './gcpAuth.js';
import { retryWithBackoff, mapConcurrent } from '../utils/concurrency.js';
import { logger } from '../utils/logger.js';

export interface DiscoveryEngineClientOptions {
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export class DiscoveryEngineClient {
  private auth: GcpAuthService;
  private requestTimeoutMs: number;
  private maxRetries: number;
  private retryBaseDelayMs: number;

  constructor(auth: GcpAuthService, options: DiscoveryEngineClientOptions = {}) {
    this.auth = auth;
    const envTimeout = Number(process.env.DISCOVERY_ENGINE_TIMEOUT_MS);
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 30000);
    this.maxRetries = options.maxRetries ?? 5;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 750;
  }

  private async request<T>(
    url: string,
    method: string = 'GET',
    body?: any,
    userProject?: string,
    customHeaders?: Record<string, string>,
    forUserEmail?: string
  ): Promise<T> {
    const saHomeProject = this.auth.getServiceAccountProjectId();
    // If calling the Service Account's home GCP project (e.g., Target Google Workspace project), prefer DWD
    const initialMode: 'DWD' | 'WIF' | undefined = (forUserEmail && saHomeProject && userProject === saHomeProject)
      ? 'DWD'
      : undefined;

    const token = await this.auth.getAccessToken(forUserEmail, undefined, initialMode);
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...customHeaders
    };

    const homeProject = saHomeProject || process.env.SOURCE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
    if (userProject) {
      headers['X-Goog-User-Project'] = userProject;
    } else if (homeProject) {
      headers['X-Goog-User-Project'] = homeProject;
    }

    let impersonationFallbackAttempted = false;

    const fetchWithTimeout = async (reqHeaders: Record<string, string>) => {
      try {
        return await fetch(url, {
          method,
          headers: reqHeaders,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });
      } catch (fetchErr: any) {
        if (
          fetchErr?.name === 'TimeoutError' ||
          fetchErr?.name === 'AbortError' ||
          String(fetchErr?.message || '').toLowerCase().includes('timeout')
        ) {
          const timeoutErr: any = new Error(
            `Discovery Engine API Request Timed Out after ${this.requestTimeoutMs}ms: ${method} ${url}`
          );
          timeoutErr.name = 'TimeoutError';
          timeoutErr.code = 'ETIMEDOUT';
          throw timeoutErr;
        }
        throw fetchErr;
      }
    };

    return retryWithBackoff(async () => {
      logger.debug(`HTTP ${method} ${url}`);
      let response = await fetchWithTimeout(headers);

      if (!response.ok) {
        let errorText = await response.text();
        let parsedError: any;
        try {
          parsedError = JSON.parse(errorText);
        } catch {
          parsedError = null;
        }

        const isQuotaDenied = (errObj: any, raw: string) => {
          const r = errObj?.error?.details?.[0]?.reason || '';
          const m = errObj?.error?.message || raw;
          return r === 'USER_PROJECT_DENIED' || m.includes('USER_PROJECT_DENIED') || m.includes('serviceusage.services.use');
        };

        // 1. If target quota project is denied (caller lacks serviceusage.services.use on target), retry with SA home project or without quota header
        if (response.status === 403 && isQuotaDenied(parsedError, errorText)) {
          if (homeProject && headers['X-Goog-User-Project'] !== homeProject) {
            logger.debug(`Target quota project denied; retrying request with SA home quota project: ${homeProject}`);
            headers['X-Goog-User-Project'] = homeProject;
            response = await fetchWithTimeout(headers);
            if (response.ok) {
              if (response.status === 204) return {} as T;
              return (await response.json()) as T;
            }
            errorText = await response.text();
            try { parsedError = JSON.parse(errorText); } catch { parsedError = null; }
          }

          if (response.status === 403 && isQuotaDenied(parsedError, errorText) && headers['X-Goog-User-Project']) {
            logger.debug(`Quota project still denied; retrying request without X-Goog-User-Project header`);
            delete headers['X-Goog-User-Project'];
            response = await fetchWithTimeout(headers);
            if (response.ok) {
              if (response.status === 204) return {} as T;
              return (await response.json()) as T;
            }
            errorText = await response.text();
            try { parsedError = JSON.parse(errorText); } catch { parsedError = null; }
          }
        }

        // 1. If 403 Forbidden with SERVICE_DISABLED, fail immediately without retry.
        if (response.status === 403) {
          const detail = parsedError?.error?.details?.find((d: any) => d['@type']?.includes('ErrorInfo'));
          if (detail?.reason === 'SERVICE_DISABLED') {
            const serviceName = detail?.metadata?.service || 'discoveryengine.googleapis.com';
            const consumerProject = detail?.metadata?.consumer || userProject || '';
            const activationUrl = `https://console.cloud.google.com/apis/library/${serviceName}?project=${consumerProject}`;
            throw new Error(`CRITICAL: Google Cloud Discovery Engine API is disabled on project "${consumerProject}". Please activate it before continuing: ${activationUrl}`);
          }
        }

        // 2. If 403 Permission Denied when impersonating a user (e.g., WiF token sent to Google Workspace target project),
        // retry using the alternate impersonation mechanism (DWD <-> WIF) -- but ONLY if that
        // mechanism is actually configured, and only ONCE per request to prevent flip-flop loops.
        if (response.status === 403 && forUserEmail && !impersonationFallbackAttempted) {
          impersonationFallbackAttempted = true;
          const actualInitialMode: 'DWD' | 'WIF' =
            (typeof this.auth.getLastUsedImpersonationMode === 'function'
              ? this.auth.getLastUsedImpersonationMode(forUserEmail)
              : undefined) ||
            initialMode ||
            'WIF';
          const alternateMode: 'DWD' | 'WIF' = (actualInitialMode === 'DWD') ? 'WIF' : 'DWD';
          const initialLabel = actualInitialMode;
          const firstFailureDetail = (parsedError?.error?.message || errorText || '').slice(0, 500);
          const mechanism = this.auth.getImpersonationMechanismStatus(forUserEmail, alternateMode);

          if (!mechanism.available) {
            // Do NOT retry. Retrying would re-mint the same credential class and fail identically,
            // while the log implied a different mechanism had been tried.
            logger.warn(
              `Permission denied for "${forUserEmail}" using ${initialLabel} impersonation, and no ${alternateMode} fallback is possible because ${mechanism.reason}. ` +
              `Not retrying. Original error: ${firstFailureDetail}`
            );
          } else {
            try {
              const altToken = await this.auth.getAccessToken(forUserEmail, undefined, alternateMode);
              if (altToken) {
                logger.info(
                  `Permission denied for "${forUserEmail}" using ${initialLabel} impersonation; retrying with ${alternateMode} impersonation token. ` +
                  `Original error: ${firstFailureDetail}`
                );
                headers['Authorization'] = `Bearer ${altToken}`;
                response = await fetchWithTimeout(headers);
                if (response.ok) {
                  if (response.status === 204) return {} as T;
                  return (await response.json()) as T;
                }
                errorText = await response.text();
                try { parsedError = JSON.parse(errorText); } catch { parsedError = null; }
                logger.warn(`${alternateMode} impersonation retry for "${forUserEmail}" also failed with HTTP ${response.status}: ${(parsedError?.error?.message || errorText || '').slice(0, 500)}`);
              } else {
                logger.warn(
                  `Permission denied for "${forUserEmail}" using ${initialLabel} impersonation. ${alternateMode} is configured but returned no token, so no retry was made. ` +
                  `Original error: ${firstFailureDetail}`
                );
              }
            } catch (altErr: any) {
              logger.warn(
                `Permission denied for "${forUserEmail}" using ${initialLabel} impersonation, and the ${alternateMode} fallback failed: ${altErr.message}. ` +
                `Original error: ${firstFailureDetail}`
              );
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
    }, this.maxRetries, this.retryBaseDelayMs);
  }

  async listAllPages<T>(
    buildUrl: (pageToken?: string) => string,
    extractItems: (response: any) => T[] | undefined,
    projectId: string,
    forUserEmail?: string
  ): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const currentUrl = buildUrl(pageToken);
      const res = await this.request<any>(currentUrl, 'GET', undefined, projectId, undefined, forUserEmail);
      const batch = extractItems(res);
      if (batch && Array.isArray(batch)) {
        items.push(...batch);
      }
      pageToken = res?.nextPageToken || undefined;
    } while (pageToken);

    return items;
  }

  // --- Agents ---

  async listAgents(env: EnvironmentConfig, forUserEmail?: string): Promise<Agent[]> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const collection = env.collectionId || 'default_collection';
    const assistant = env.assistantId || 'default_assistant';
    return this.listAllPages<Agent>(
      (pageToken) => {
        const query = new URLSearchParams({ pageSize: '200' });
        if (pageToken) query.set('pageToken', pageToken);
        return `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/engines/${env.appId}/assistants/${assistant}/agents?${query.toString()}`;
      },
      (res) => res.agents,
      env.projectId,
      forUserEmail
    );
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

  async listNotebooks(env: EnvironmentConfig, forUserEmail?: string): Promise<Notebook[]> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const notebooks = await this.listAllPages<Notebook>(
      (pageToken) => {
        const query = new URLSearchParams({ pageSize: '100' });
        if (pageToken) query.set('pageToken', pageToken);
        return `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks:listRecentlyViewed?${query.toString()}`;
      },
      (res) => res.notebooks,
      env.projectId,
      forUserEmail
    );
    if (forUserEmail) {
      for (const nb of notebooks) {
        if (!nb.metadata) nb.metadata = {};
        const hasProtoMetadata =
          nb.metadata.createTime !== undefined ||
          nb.metadata.lastViewed !== undefined ||
          nb.metadata.isShared !== undefined;
        const role = String(nb.userRole || nb.role || nb.accessRole || nb.metadata.userRole || nb.metadata.role || '').toUpperCase();
        const isOwnerRole = Boolean(role && (role === 'PROJECT_ROLE_OWNER' || role === 'OWNER' || role.endsWith('_OWNER')));
        const isNonOwnerRole = Boolean(role && !isOwnerRole);
        const isSharedWithCallerAsNonOwner =
          nb.metadata.isShareable === false ||
          isNonOwnerRole ||
          (nb.metadata.isShared === true && !isOwnerRole) ||
          (hasProtoMetadata && nb.metadata.isShareable !== true);
        const existingOwner = nb.owner || nb.creator || nb.metadata.ownerEmail || nb.metadata.creatorEmail || nb.metadata.owner || nb.metadata.creator;

        if (!isSharedWithCallerAsNonOwner && !existingOwner) {
          nb.owner = forUserEmail;
          nb.metadata.ownerEmail = forUserEmail;
        }
      }
    }
    return notebooks;
  }

  async batchDeleteNotebooks(projectId: string, location: string, notebookNames: string[], forUserEmail?: string): Promise<{ success: boolean; count: number; failed: number }> {
    const baseUrl = getSafeDiscoveryEngineUrl(location);
    const url = `${baseUrl}/v1alpha/projects/${projectId}/locations/${location}/notebooks:batchDelete`;
    let deleted = 0;
    let failed = 0;

    await mapConcurrent(notebookNames, 8, async (name) => {
      try {
        await this.request<any>(url, 'POST', { names: [name] }, projectId, undefined, forUserEmail);
        deleted++;
      } catch (err: any) {
        failed++;
        logger.warn(`Could not delete notebook ${name}: ${err.message}`);
      }
    });

    return { success: failed === 0, count: deleted, failed };
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
    return this.listAllPages<NotebookNote>(
      (pageToken) => {
        const query = new URLSearchParams({ pageSize: '100' });
        if (pageToken) query.set('pageToken', pageToken);
        return `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}/notes?${query.toString()}`;
      },
      (res) => res.notes,
      env.projectId,
      forUserEmail
    );
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
    return this.listAllPages<any>(
      (pageToken) => {
        const query = new URLSearchParams({ pageSize: '100' });
        if (pageToken) query.set('pageToken', pageToken);
        return `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/notebooks/${notebookId}/artifacts?${query.toString()}`;
      },
      (res) => res.artifacts,
      env.projectId,
      forUserEmail
    );
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
    try {
      return await this.listAllPages<AppEngine>(
        (pageToken) => {
          const query = new URLSearchParams({ pageSize: '100' });
          if (pageToken) query.set('pageToken', pageToken);
          return `${baseUrl}/v1beta/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/engines?${query.toString()}`;
        },
        (res) => res.engines,
        env.projectId
      );
    } catch (err: any) {
      return this.listAllPages<AppEngine>(
        (pageToken) => {
          const query = new URLSearchParams({ pageSize: '100' });
          if (pageToken) query.set('pageToken', pageToken);
          return `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/engines?${query.toString()}`;
        },
        (res) => res.engines,
        env.projectId
      );
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
    return this.listAllPages<DataStore>(
      (pageToken) => {
        const query = new URLSearchParams({ pageSize: '100' });
        if (pageToken) query.set('pageToken', pageToken);
        return `${baseUrl}/v1beta/projects/${env.projectId}/locations/${env.appLocation}/collections/${collection}/dataStores?${query.toString()}`;
      },
      (res) => res.dataStores,
      env.projectId
    );
  }

  async listCollections(env: EnvironmentConfig): Promise<ConnectorCollection[]> {
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    return this.listAllPages<ConnectorCollection>(
      (pageToken) => {
        const query = new URLSearchParams({ pageSize: '100' });
        if (pageToken) query.set('pageToken', pageToken);
        return `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections?${query.toString()}`;
      },
      (res) => res.collections,
      env.projectId
    );
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
    const memories = await this.listAllPages<Memory>(
      (pageToken) => {
        const query = new URLSearchParams({ pageSize: '100' });
        if (pageToken) query.set('pageToken', pageToken);
        return `${baseUrl}/v1alpha/projects/${projectNum}/locations/${env.appLocation}/collections/${collection}/engines/${env.appId}/memories?${query.toString()}`;
      },
      (res) => res.memories,
      env.projectId,
      forUserEmail
    );

    if (forUserEmail) {
      for (const m of memories) {
        m.owner = forUserEmail;
        m.userEmail = forUserEmail;
        m.userPseudoId = forUserEmail;
      }
    }

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

  private projectIamPolicyCache: Map<string, IamPolicy | null> = new Map();
  private rolePermissionsCache: Map<string, string[] | null> = new Map();

  /**
   * Fetches and caches the project-level IAM policy using base/admin credentials.
   */
  private async getProjectIamPolicyCached(projectId: string): Promise<IamPolicy | null> {
    if (this.projectIamPolicyCache.has(projectId)) {
      return this.projectIamPolicyCache.get(projectId) ?? null;
    }
    try {
      const url = `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}:getIamPolicy`;
      const res = await this.request<IamPolicy>(url, 'POST', {}, projectId);
      if (res && Array.isArray(res.bindings)) {
        this.projectIamPolicyCache.set(projectId, res);
        return res;
      }
    } catch (err: any) {
      logger.debug(`Could not fetch project IAM policy for "${projectId}": ${err.message}`);
    }
    this.projectIamPolicyCache.set(projectId, null);
    return null;
  }

  /**
   * Checks whether a given IAM role (predefined or custom) includes `permission`.
   */
  private async roleGrantsPermission(role: string, permission: string, projectId: string): Promise<boolean> {
    const normalizedRole = (role || '').trim();
    if (!normalizedRole) return false;

    if (
      normalizedRole === 'roles/owner' ||
      normalizedRole === 'roles/editor' ||
      normalizedRole === 'roles/discoveryengine.admin'
    ) {
      return true;
    }

    if (
      normalizedRole === 'roles/viewer' ||
      normalizedRole === 'roles/browser' ||
      normalizedRole === 'roles/discoveryengine.user' ||
      normalizedRole === 'roles/discoveryengine.viewer'
    ) {
      return false;
    }

    // Predefined roles for other GCP services do not grant discoveryengine.* permissions
    if (normalizedRole.startsWith('roles/') && !normalizedRole.startsWith('roles/discoveryengine.')) {
      return false;
    }

    if (!this.rolePermissionsCache.has(normalizedRole)) {
      try {
        const cleanRolePath = normalizedRole.replace(/^\/+/, '');
        const roleUrl = `https://iam.googleapis.com/v1/${cleanRolePath}`;
        const roleDef = await this.request<{ includedPermissions?: string[] }>(roleUrl, 'GET', undefined, projectId);
        if (roleDef && Array.isArray(roleDef.includedPermissions)) {
          this.rolePermissionsCache.set(normalizedRole, roleDef.includedPermissions);
        } else {
          this.rolePermissionsCache.set(normalizedRole, null);
        }
      } catch (err: any) {
        logger.debug(`Could not inspect IAM role definition "${normalizedRole}": ${err.message}`);
        this.rolePermissionsCache.set(normalizedRole, null);
      }
    }

    const cachedPerms = this.rolePermissionsCache.get(normalizedRole);
    if (Array.isArray(cachedPerms)) {
      return cachedPerms.includes(permission);
    }

    // Fallback heuristic when iam.roles.get is unavailable (e.g., caller lacks iam.roles.get on custom role)
    if (permission === 'discoveryengine.notebooks.delete') {
      const roleId = (normalizedRole.split('/').pop() || normalizedRole).toLowerCase();
      if (
        roleId.includes('restricted') ||
        roleId.includes('enduser') ||
        roleId.includes('viewer') ||
        roleId.includes('reader') ||
        roleId.endsWith('user')
      ) {
        return false;
      }
      if (
        roleId.includes('admin') ||
        roleId.includes('owner') ||
        roleId.includes('editor') ||
        roleId.includes('agentspace')
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Evaluates whether `forUserEmail` holds `permissions` on `projectId` by inspecting
   * the project's IAM policy bindings using base/admin credentials (avoiding DWD user token
   * `cloud-platform` OAuth scope restrictions on Cloud Resource Manager).
   */
  private async evaluatePermissionsFromProjectIamPolicy(
    projectId: string,
    permissions: string[],
    forUserEmail: string
  ): Promise<string[] | null> {
    const policy = await this.getProjectIamPolicyCached(projectId);
    if (!policy || !Array.isArray(policy.bindings)) {
      return null;
    }

    const cleanEmail = forUserEmail.replace(/^user:/i, '').trim().toLowerCase();
    const domain = cleanEmail.includes('@') ? cleanEmail.split('@')[1] : '';
    const wifAvailable =
      typeof this.auth.getImpersonationMechanismStatus === 'function'
        ? this.auth.getImpersonationMechanismStatus(cleanEmail, 'WIF').available
        : false;
    const isWifUser =
      wifAvailable &&
      (this.auth.getAuthType?.() === 'WORKFORCE_IDENTITY_FEDERATION' ||
        GcpAuthService.isExternalIdentityDomain(cleanEmail) ||
        this.auth.getLastUsedImpersonationMode?.(cleanEmail) === 'WIF');

    const matchedRoles = new Set<string>();
    for (const binding of policy.bindings) {
      if (!binding?.role || !Array.isArray(binding.members)) continue;
      for (const rawMember of binding.members) {
        const m = String(rawMember || '').trim().toLowerCase();
        const isDirectUser = m === `user:${cleanEmail}`;
        const isDomainMatch = Boolean(domain && m === `domain:${domain}`);
        const isPublicMatch = m === 'allauthenticatedusers' || m === 'allusers';
        const isExplicitPrincipalSubject = m.endsWith(`/subject/${cleanEmail}`);
        const isWorkforcePoolWildcard =
          isWifUser &&
          m.startsWith('principalset://iam.googleapis.com/locations/global/workforcepools/') &&
          m.endsWith('/*');

        if (
          isDirectUser ||
          isDomainMatch ||
          isPublicMatch ||
          isExplicitPrincipalSubject ||
          isWorkforcePoolWildcard
        ) {
          matchedRoles.add(binding.role);
          break;
        }
      }
    }

    const granted: string[] = [];
    for (const perm of permissions) {
      for (const role of matchedRoles) {
        if (await this.roleGrantsPermission(role, perm, projectId)) {
          granted.push(perm);
          break;
        }
      }
    }
    return granted;
  }

  /**
   * Tests whether the caller (or impersonated user token) holds specific GCP project-level
   * IAM permissions on `projectId` via Project IAM Policy inspection and/or Cloud Resource Manager
   * `projects.testIamPermissions`.
   */
  async testProjectIamPermissions(projectId: string, permissions: string[], forUserEmail?: string): Promise<string[]> {
    const cleanEmail = forUserEmail ? forUserEmail.replace(/^user:/i, '').trim().toLowerCase() : undefined;
    const isDwdModeForUser =
      Boolean(cleanEmail) &&
      this.auth.getAuthType?.() !== 'WORKFORCE_IDENTITY_FEDERATION' &&
      !GcpAuthService.isExternalIdentityDomain(cleanEmail!);

    // For DWD-impersonated users, DWD tokens only carry Discovery Engine scopes (not cloud-platform),
    // so calling cloudresourcemanager.googleapis.com:testIamPermissions with the user's DWD token
    // fails with HTTP 403 "Request had insufficient authentication scopes". Evaluate via the project's
    // IAM policy (using base/admin credentials) first.
    if (cleanEmail && isDwdModeForUser) {
      const fromPolicy = await this.evaluatePermissionsFromProjectIamPolicy(projectId, permissions, cleanEmail);
      if (fromPolicy !== null) {
        return fromPolicy;
      }
    }

    const url = `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}:testIamPermissions`;
    try {
      const res = await this.request<{ permissions?: string[] }>(
        url,
        'POST',
        { permissions },
        projectId,
        undefined,
        forUserEmail
      );
      return Array.isArray(res?.permissions) ? res.permissions : [];
    } catch (err: any) {
      if (cleanEmail) {
        const fromPolicy = await this.evaluatePermissionsFromProjectIamPolicy(projectId, permissions, cleanEmail);
        if (fromPolicy !== null) {
          return fromPolicy;
        }
      }
      throw err;
    }
  }
}

