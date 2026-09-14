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
import { RegistrySkill, RegistrySkillRevision } from '../types/index.js';
import { GcpAuthService } from './gcpAuth.js';
import { retryWithBackoff } from '../utils/concurrency.js';
import { logger } from '../utils/logger.js';

export const AGENT_REGISTRY_BASE_URL = 'https://agentregistry.googleapis.com';
export const AGENT_REGISTRY_API_VERSION = 'v1alpha';

export class AgentRegistryClient {
  private auth: GcpAuthService;

  constructor(auth: GcpAuthService) {
    this.auth = auth;
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
    return this.listAllPages<RegistrySkill>(
      (pageToken) => {
        const query = new URLSearchParams({ pageSize: '100' });
        if (pageToken) query.set('pageToken', pageToken);
        return `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/projects/${env.projectId}/locations/${env.appLocation || 'global'}/skills?${query.toString()}`;
      },
      (res) => res.skills,
      env.projectId,
      forUserEmail
    );
  }

  async getSkill(skillName: string, env: EnvironmentConfig, forUserEmail?: string): Promise<RegistrySkill> {
    const resourceName = skillName.startsWith('projects/')
      ? skillName
      : `projects/${env.projectId}/locations/${env.appLocation || 'global'}/skills/${skillName}`;
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/${resourceName}`;
    return this.request<RegistrySkill>(url, 'GET', undefined, env.projectId, forUserEmail);
  }

  async createSkill(skillId: string, payload: Partial<RegistrySkill>, env: EnvironmentConfig, forUserEmail?: string): Promise<RegistrySkill> {
    const cleanId = skillId.split('/').pop() || skillId;
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/projects/${env.projectId}/locations/${env.appLocation || 'global'}/skills?skillId=${encodeURIComponent(cleanId)}`;
    return this.request<RegistrySkill>(url, 'POST', payload, env.projectId, forUserEmail);
  }

  async downloadSkillRevisionMedia(revisionName: string, env: EnvironmentConfig, forUserEmail?: string): Promise<string | null> {
    const resourceName = revisionName.startsWith('projects/')
      ? revisionName
      : `projects/${env.projectId}/locations/${env.appLocation || 'global'}/skills/${revisionName}`;
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/${resourceName}?alt=media`;
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
        redirect: 'follow'
      });
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Failed to download skill revision media [${response.status}]: ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return buffer.toString('base64');
    });
  }

  async updateSkill(skillName: string, payload: Partial<RegistrySkill>, updateMask: string[], env: EnvironmentConfig, forUserEmail?: string): Promise<RegistrySkill> {
    const resourceName = skillName.startsWith('projects/')
      ? skillName
      : `projects/${env.projectId}/locations/${env.appLocation || 'global'}/skills/${skillName}`;
    const mask = updateMask.length > 0 ? `?updateMask=${updateMask.join(',')}` : '';
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/${resourceName}${mask}`;
    return this.request<RegistrySkill>(url, 'PATCH', payload, env.projectId, forUserEmail);
  }

  async deleteSkill(skillName: string, env: EnvironmentConfig, forUserEmail?: string): Promise<void> {
    const resourceName = skillName.startsWith('projects/')
      ? skillName
      : `projects/${env.projectId}/locations/${env.appLocation || 'global'}/skills/${skillName}`;
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/${resourceName}`;
    await this.request<void>(url, 'DELETE', undefined, env.projectId, forUserEmail);
  }

  async listSkillRevisions(skillName: string, env: EnvironmentConfig, forUserEmail?: string): Promise<RegistrySkillRevision[]> {
    const resourceName = skillName.startsWith('projects/')
      ? skillName
      : `projects/${env.projectId}/locations/${env.appLocation || 'global'}/skills/${skillName}`;
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
    const resourceName = skillName.startsWith('projects/')
      ? skillName
      : `projects/${env.projectId}/locations/${env.appLocation || 'global'}/skills/${skillName}`;
    const url = `${AGENT_REGISTRY_BASE_URL}/${AGENT_REGISTRY_API_VERSION}/${resourceName}/revisions`;
    return this.request<RegistrySkillRevision>(url, 'POST', payload, env.projectId, forUserEmail);
  }
}
