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
import { IamPolicy, LongRunningOperation, RegistrySkill, RegistrySkillRevision } from '../types/index.js';
import { SecurityValidationError } from '../security/validator.js';
import { GcpAuthService } from './gcpAuth.js';
import { retryWithBackoff } from '../utils/concurrency.js';
import { logger } from '../utils/logger.js';

export const AGENT_REGISTRY_BASE_URL = 'https://agentregistry.googleapis.com';
export const AGENT_REGISTRY_API_VERSION = 'v1';

const SAFE_LOCATION_REGEX = /^[a-z0-9-]+$/i;
const SAFE_SKILL_ID_REGEX = /^[a-z0-9._-]+$/i;
const SAFE_SKILL_RESOURCE_REGEX = /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/skills\/[a-z0-9._-]+(?:\/revisions\/[a-z0-9._-]+)?$/i;
const SAFE_OPERATION_NAME_REGEX = /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/operations\/[a-z0-9._-]+$/i;

export function getSafeAgentRegistryLocation(location?: string): string {
  const loc = (location || 'global').trim().toLowerCase();
  if (!loc || !SAFE_LOCATION_REGEX.test(loc)) {
    throw new SecurityValidationError(
      `Invalid Agent Registry location: "${location}". Location must only contain alphanumeric characters and hyphens.`
    );
  }
  return loc;
}

export interface AgentRegistryClientOptions {
  requestTimeoutMs?: number;
  operationPollIntervalMs?: number;
  operationTimeoutMs?: number;
}

export class AgentRegistryClient {
  private auth: GcpAuthService;
  private requestTimeoutMs: number;
  private operationPollIntervalMs: number;
  private operationTimeoutMs: number;

  constructor(auth: GcpAuthService, options: AgentRegistryClientOptions = {}) {
    this.auth = auth;
    const envTimeout = Number(process.env.AGENT_REGISTRY_TIMEOUT_MS);
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 90000);
    this.operationPollIntervalMs = options.operationPollIntervalMs ?? 1000;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 90000;
  }

  private resolveSkillResourceName(skillNameOrId: string, env: EnvironmentConfig): string {
    const trimmed = (skillNameOrId || '').trim().replace(/^\/+/, '');
    if (trimmed.startsWith('projects/')) {
      if (!SAFE_SKILL_RESOURCE_REGEX.test(trimmed)) {
        throw new SecurityValidationError(`Invalid Agent Registry skill resource name: "${skillNameOrId}"`);
      }
      return trimmed;
    }
    if (!trimmed || !SAFE_SKILL_ID_REGEX.test(trimmed)) {
      throw new SecurityValidationError(`Invalid Agent Registry skill ID: "${skillNameOrId}"`);
    }
    const location = getSafeAgentRegistryLocation(env.appLocation);
    return `projects/${env.projectId}/locations/${location}/skills/${trimmed}`;
  }

  private isLongRunningOperation(obj: any): obj is LongRunningOperation {
    if (!obj || typeof obj !== 'object') return false;
    if (typeof obj.name === 'string' && obj.name.includes('/operations/')) {
      return true;
    }
    return 'done' in obj && ('response' in obj || 'error' in obj || 'metadata' in obj);
  }

  async getOperation<T = any>(
    operationName: string,
    projectId: string,
    forUserEmail?: string
  ): Promise<LongRunningOperation<T>> {
    const cleanName = (operationName || '').trim().replace(/^\/+/, '');
    if (!SAFE_OPERATION_NAME_REGEX.test(cleanName)) {
      throw new SecurityValidationError(`Invalid Agent Registry operation resource name: "${operationName}"`);
    }
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/${cleanName}`;
    return this.request<LongRunningOperation<T>>(url, 'GET', undefined, projectId, forUserEmail);
  }

  async waitForOperation<T>(
    operationOrResult: any,
    projectId: string,
    forUserEmail?: string
  ): Promise<T> {
    if (!this.isLongRunningOperation(operationOrResult)) {
      return operationOrResult as T;
    }

    let current: LongRunningOperation<T> = operationOrResult;
    const deadline = Date.now() + this.operationTimeoutMs;

    while (!current.done) {
      if (Date.now() >= deadline) {
        const timeoutErr: any = new Error(
          `Agent Registry Operation Timed Out after ${this.operationTimeoutMs}ms: ${current.name}`
        );
        timeoutErr.name = 'TimeoutError';
        timeoutErr.code = 'ETIMEDOUT';
        throw timeoutErr;
      }
      await new Promise((resolve) => setTimeout(resolve, this.operationPollIntervalMs));
      current = await this.getOperation<T>(current.name, projectId, forUserEmail);
    }

    if (current.error) {
      const opErr: any = new Error(
        `Agent Registry Operation Failed [${current.error.code ?? 'ERR'}]: ${current.error.message || 'Unknown operation error'}`
      );
      opErr.code = current.error.code;
      opErr.details = current.error;
      throw opErr;
    }

    return (current.response ?? current) as T;
  }

  private async request<T>(
    url: string,
    method: string = 'GET',
    body?: any,
    userProject?: string,
    forUserEmail?: string
  ): Promise<T> {
    const token = await this.auth.getAccessToken(forUserEmail);
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    if (userProject) {
      headers['X-Goog-User-Project'] = userProject;
    }

    return retryWithBackoff(async () => {
      logger.debug(`HTTP ${method} ${url}`);
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
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
            `Agent Registry API Request Timed Out after ${this.requestTimeoutMs}ms: ${method} ${url}`
          );
          timeoutErr.name = 'TimeoutError';
          timeoutErr.code = 'ETIMEDOUT';
          throw timeoutErr;
        }
        throw fetchErr;
      }

      if (!response.ok) {
        const errorText = await response.text();
        let parsedError: any;
        try {
          parsedError = JSON.parse(errorText);
        } catch {
          parsedError = null;
        }

        const msg = parsedError?.error?.message || errorText || response.statusText;
        const err: any = new Error(`Agent Registry API Request Failed [${response.status}]: ${msg}`);
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
      const res = await this.request<any>(currentUrl, 'GET', undefined, projectId, forUserEmail);
      const batch = extractItems(res);
      if (batch && Array.isArray(batch)) {
        items.push(...batch);
      }
      pageToken = res?.nextPageToken || undefined;
    } while (pageToken);

    return items;
  }

  async listSkills(env: EnvironmentConfig, forUserEmail?: string): Promise<RegistrySkill[]> {
    const location = getSafeAgentRegistryLocation(env.appLocation);
    return this.listAllPages<RegistrySkill>(
      (pageToken) => {
        const query = new URLSearchParams({ pageSize: '100' });
        if (pageToken) query.set('pageToken', pageToken);
        return `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/projects/${env.projectId}/locations/${location}/skills?${query.toString()}`;
      },
      (res) => res.skills,
      env.projectId,
      forUserEmail
    );
  }

  async getSkill(skillName: string, env: EnvironmentConfig, forUserEmail?: string): Promise<RegistrySkill> {
    const resourceName = this.resolveSkillResourceName(skillName, env);
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/${resourceName}`;
    return this.request<RegistrySkill>(url, 'GET', undefined, env.projectId, forUserEmail);
  }

  async createSkill(skillId: string, payload: Partial<RegistrySkill>, env: EnvironmentConfig, forUserEmail?: string): Promise<RegistrySkill> {
    const rawTrimmed = (skillId || '').trim().replace(/^\/+/, '');
    let cleanId: string;
    if (rawTrimmed.startsWith('projects/')) {
      if (!SAFE_SKILL_RESOURCE_REGEX.test(rawTrimmed)) {
        throw new SecurityValidationError(`Invalid Agent Registry skill resource name: "${skillId}"`);
      }
      cleanId = rawTrimmed.split('/').pop() || '';
    } else {
      cleanId = rawTrimmed;
    }
    if (!cleanId || !SAFE_SKILL_ID_REGEX.test(cleanId)) {
      throw new SecurityValidationError(`Invalid Agent Registry skillId: "${skillId}"`);
    }
    const location = getSafeAgentRegistryLocation(env.appLocation);
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/projects/${env.projectId}/locations/${location}/skills?skillId=${encodeURIComponent(cleanId)}`;
    const opOrSkill = await this.request<any>(url, 'POST', payload, env.projectId, forUserEmail);
    return this.waitForOperation<RegistrySkill>(opOrSkill, env.projectId, forUserEmail);
  }

  async downloadSkillRevisionMedia(revisionName: string, env: EnvironmentConfig, forUserEmail?: string): Promise<string | null> {
    const resourceName = this.resolveSkillResourceName(revisionName, env);
    const url = `${AGENT_REGISTRY_BASE_URL}/download/${AGENT_REGISTRY_API_VERSION}/${resourceName}?alt=media`;
    const token = await this.auth.getAccessToken(forUserEmail);
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`
    };
    if (env.projectId) {
      headers['X-Goog-User-Project'] = env.projectId;
    }

    return retryWithBackoff(async () => {
      logger.debug(`HTTP GET (media) ${url}`);
      const response = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
      if (!response.ok) {
        if (response.status === 404) return null;
        const errBody = await response.text();
        const err: any = new Error(
          `Failed to download skill revision media [${response.status}]: ${errBody || response.statusText}`
        );
        err.status = response.status;
        throw err;
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return buffer.toString('base64');
    });
  }

  async updateSkill(skillName: string, payload: Partial<RegistrySkill>, updateMask: string[], env: EnvironmentConfig, forUserEmail?: string): Promise<RegistrySkill> {
    const resourceName = this.resolveSkillResourceName(skillName, env);
    const mask = updateMask.length > 0 ? `?updateMask=${updateMask.map(encodeURIComponent).join(',')}` : '';
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/${resourceName}${mask}`;
    const opOrSkill = await this.request<any>(url, 'PATCH', payload, env.projectId, forUserEmail);
    return this.waitForOperation<RegistrySkill>(opOrSkill, env.projectId, forUserEmail);
  }

  async deleteSkill(skillName: string, env: EnvironmentConfig, forUserEmail?: string): Promise<void> {
    const resourceName = this.resolveSkillResourceName(skillName, env);
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/${resourceName}`;
    const op = await this.request<any>(url, 'DELETE', undefined, env.projectId, forUserEmail);
    await this.waitForOperation<void>(op, env.projectId, forUserEmail);
  }

  async listSkillRevisions(skillName: string, env: EnvironmentConfig, forUserEmail?: string): Promise<RegistrySkillRevision[]> {
    const resourceName = this.resolveSkillResourceName(skillName, env);
    return this.listAllPages<RegistrySkillRevision>(
      (pageToken) => {
        const query = new URLSearchParams({ pageSize: '50' });
        if (pageToken) query.set('pageToken', pageToken);
        return `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/${resourceName}/revisions?${query.toString()}`;
      },
      (res) => res.skillRevisions,
      env.projectId,
      forUserEmail
    );
  }

  async createSkillRevision(skillName: string, payload: any, env: EnvironmentConfig, forUserEmail?: string): Promise<RegistrySkillRevision> {
    const resourceName = this.resolveSkillResourceName(skillName, env);
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/${resourceName}/revisions`;
    const opOrRevision = await this.request<any>(url, 'POST', payload, env.projectId, forUserEmail);
    return this.waitForOperation<RegistrySkillRevision>(opOrRevision, env.projectId, forUserEmail);
  }

  async getSkillIamPolicy(skillName: string, env: EnvironmentConfig, forUserEmail?: string): Promise<IamPolicy> {
    const resourceName = this.resolveSkillResourceName(skillName, env);
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/${resourceName}:getIamPolicy?options.requestedPolicyVersion=3`;
    return this.request<IamPolicy>(url, 'GET', undefined, env.projectId, forUserEmail);
  }

  async setSkillIamPolicy(skillName: string, policy: IamPolicy, env: EnvironmentConfig, forUserEmail?: string): Promise<IamPolicy> {
    const resourceName = this.resolveSkillResourceName(skillName, env);
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/${resourceName}:setIamPolicy`;
    return this.request<IamPolicy>(url, 'POST', { policy }, env.projectId, forUserEmail);
  }
}

