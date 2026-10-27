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

import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import '../src/security/authMiddleware.js';
import { DiscoveryEngineClient, EnvironmentConfig } from '../src/services/discoveryEngine.js';
import { discoveryRouter } from '../src/routes/discovery.js';

function createTestServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.accessToken = 'mock-operator-access-token';
    next();
  });
  app.use('/api', discoveryRouter);
  return http.createServer(app);
}

describe('Project Capability Probe & Google-Internal API Circuit Breakers', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const env: EnvironmentConfig = {
    projectId: 'customer-prod-proj',
    appLocation: 'global',
    collectionId: 'default_collection',
    appId: 'enterprise-engine-1'
  };

  it('detects public vs allowlist-gated (GOOGLE_INTERNAL / NLME_API_USER) capabilities on a standard customer project', async () => {
    const mockAuth = {
      getAccessToken: vi.fn().mockResolvedValue('mock-admin-token'),
      getUserAccessToken: vi.fn().mockResolvedValue('mock-user-token'),
      getServiceAccountProjectId: vi.fn().mockReturnValue(undefined)
    };

    const client = new DiscoveryEngineClient(mockAuth as any);
    vi.spyOn(client, 'resolveProjectNumber').mockResolvedValue('1234567890');

    vi.spyOn(client as any, 'request').mockImplementation(async (...args: any[]) => {
      const url = String(args[0] || '');
      if (url.includes('/assistants/default_assistant/agents?pageSize=1')) {
        return { agents: [] };
      }
      if (url.includes('/sessions?pageSize=1')) {
        return { sessions: [] };
      }
      if (url.includes('agentregistry.googleapis.com/v1alpha/projects/customer-prod-proj/locations/global/skills')) {
        return { skills: [] };
      }
      if (url.includes('/memories?pageSize=1')) {
        const err: any = new Error('DiscoveryEngine API Error [404]: {"error":{"code":404,"message":"Method not found.","status":"NOT_FOUND"}}');
        err.status = 404;
        throw err;
      }
      if (url.includes(':getEngineUserData')) {
        const err: any = new Error('DiscoveryEngine API Error [404]: {"error":{"code":404,"message":"Method not found.","status":"NOT_FOUND"}}');
        err.status = 404;
        throw err;
      }
      if (url.includes('/notebooks:listRecentlyViewed')) {
        return {
          notebooks: [
            {
              notebookId: 'nb-cust-1',
              name: 'projects/1234567890/locations/global/notebooks/nb-cust-1',
              title: 'Customer Strategy Notebook'
            }
          ]
        };
      }
      if (url.includes('/notebooks/nb-cust-1/notes:batchGet')) {
        const err: any = new Error('DiscoveryEngine API Error [404]: {"error":{"code":404,"message":"Method not found.","status":"NOT_FOUND"}}');
        err.status = 404;
        throw err;
      }
      if (url.includes('/notebooks/nb-cust-1/artifacts?pageSize=1')) {
        const err: any = new Error('DiscoveryEngine API Error [404]: {"error":{"code":404,"message":"Method not found.","status":"NOT_FOUND"}}');
        err.status = 404;
        throw err;
      }
      if (url.endsWith('/notebooks/nb-cust-1')) {
        return {
          notebookId: 'nb-cust-1',
          title: 'Customer Strategy Notebook',
          // ESF strips userInfoAndRole on non-allowlisted projects
          sources: [
            {
              sourceId: { id: 'src-pdf-1' },
              title: 'Uploaded Brief.pdf',
              metadata: {}
            }
          ]
        };
      }
      if (url.endsWith('/notebooks/nb-cust-1/sources/src-pdf-1')) {
        return {
          sourceId: { id: 'src-pdf-1' },
          title: 'Uploaded Brief.pdf',
          metadata: {}
          // ESF strips tailwindDoc on non-allowlisted projects
        };
      }
      throw new Error(`Unexpected URL in mock: ${url}`);
    });

    const report = await client.probeProjectCapabilities(env, {
      sampleUserEmail: 'alice@customer.com'
    });

    expect(report.projectId).toBe('customer-prod-proj');
    expect(report.agents.status).toBe('SUPPORTED');
    expect(report.sessions.status).toBe('SUPPORTED');
    expect(report.skills.status).toBe('SUPPORTED');
    expect(report.notebooks.containersAndLinks.status).toBe('SUPPORTED');

    // Internal-only / allowlist-gated endpoints must be marked RESTRICTED
    expect(report.memories.status).toBe('RESTRICTED');
    expect(report.memories.visibilityFlag).toBe('GOOGLE_INTERNAL');
    expect(report.engineUserData.status).toBe('RESTRICTED');
    expect(report.engineUserData.visibilityFlag).toContain('GOOGLE_INTERNAL');
    expect(report.notebooks.notes.status).toBe('RESTRICTED');
    expect(report.notebooks.notes.visibilityFlag).toContain('NLME_API_USER');
    expect(report.notebooks.artifacts.status).toBe('RESTRICTED');
    expect(report.notebooks.artifacts.visibilityFlag).toContain('NLME_ARTIFACT_API_USER');
    expect(report.notebooks.uploadedFileContent.status).toBe('RESTRICTED');
    expect(report.notebooks.sharingRoster.status).toBe('RESTRICTED');
  });

  it('detects unlocked capabilities on an allowlisted project where GOOGLE_INTERNAL methods and fields are returned', async () => {
    const mockAuth = {
      getAccessToken: vi.fn().mockResolvedValue('mock-admin-token'),
      getUserAccessToken: vi.fn().mockResolvedValue('mock-user-token'),
      getServiceAccountProjectId: vi.fn().mockReturnValue(undefined)
    };

    const client = new DiscoveryEngineClient(mockAuth as any);
    vi.spyOn(client, 'resolveProjectNumber').mockResolvedValue('999888777');

    vi.spyOn(client as any, 'request').mockImplementation(async (...args: any[]) => {
      const url = String(args[0] || '');
      if (url.includes('/assistants/default_assistant/agents?pageSize=1')) return { agents: [] };
      if (url.includes('/sessions?pageSize=1')) return { sessions: [] };
      if (url.includes('agentregistry.googleapis.com')) return { skills: [] };
      if (url.includes('/memories?pageSize=1')) return { memories: [{ name: 'mem-1', text: 'Fact' }] };
      if (url.includes(':getEngineUserData')) return { userAgentEngineConsentData: {} };
      if (url.includes('/notebooks:listRecentlyViewed')) {
        return {
          notebooks: [{ notebookId: 'nb-allow-1', title: 'Allowlisted Notebook' }]
        };
      }
      if (url.includes('/notebooks/nb-allow-1/notes:batchGet')) return { notes: [] };
      if (url.includes('/notebooks/nb-allow-1/artifacts?pageSize=1')) return { artifacts: [] };
      if (url.endsWith('/notebooks/nb-allow-1')) {
        return {
          notebookId: 'nb-allow-1',
          title: 'Allowlisted Notebook',
          userInfoAndRole: [{ userInfo: { email: 'alice@internal.google' }, role: 'PROJECT_ROLE_OWNER' }],
          sources: [{ sourceId: { id: 'src-1' }, title: 'Notes.txt', metadata: {} }]
        };
      }
      if (url.endsWith('/notebooks/nb-allow-1/sources/src-1')) {
        return {
          sourceId: { id: 'src-1' },
          title: 'Notes.txt',
          tailwindDoc: { plainText: 'Full verbatim body from tailwind_doc' }
        };
      }
      return {};
    });

    const allowlistedEnv: EnvironmentConfig = {
      ...env,
      projectId: 'allowlisted-internal-proj'
    };

    const report = await client.probeProjectCapabilities(allowlistedEnv, {
      sampleUserEmail: 'alice@internal.google'
    });

    expect(report.memories.status).toBe('SUPPORTED');
    expect(report.engineUserData.status).toBe('SUPPORTED');
    expect(report.notebooks.notes.status).toBe('SUPPORTED');
    expect(report.notebooks.artifacts.status).toBe('SUPPORTED');
    expect(report.notebooks.uploadedFileContent.status).toBe('SUPPORTED');
    expect(report.notebooks.sharingRoster.status).toBe('SUPPORTED');
  });

  it('trips circuit-breakers on 404 Method not found for memories and engineUserData to avoid per-user 404 spam', async () => {
    const mockAuth = {
      getAccessToken: vi.fn().mockResolvedValue('mock-admin-token'),
      getUserAccessToken: vi.fn().mockResolvedValue('mock-user-token'),
      getServiceAccountProjectId: vi.fn().mockReturnValue(undefined)
    };

    const client = new DiscoveryEngineClient(mockAuth as any);
    vi.spyOn(client, 'resolveProjectNumber').mockResolvedValue('1234567890');

    const requestSpy = vi.spyOn(client as any, 'request').mockImplementation(async () => {
      const err: any = new Error('DiscoveryEngine API Error [404]: {"error":{"code":404,"message":"Method not found.","status":"NOT_FOUND"}}');
      err.status = 404;
      throw err;
    });

    // First call hits ESF and trips the circuit-breaker for 'memories'
    const firstMemories = await client.listMemories(env, 'user1@customer.com');
    expect(firstMemories).toEqual([]);
    expect(requestSpy).toHaveBeenCalledTimes(1);

    // Subsequent calls for other users short-circuit without calling this.request
    const secondMemories = await client.listMemories(env, 'user2@customer.com');
    const genRes = await client.generateMemories(env, 'Some fact', 'user2@customer.com');
    const delRes = await client.deleteMemory('projects/123/locations/global/collections/default_collection/engines/e1/memories/m1', env, 'user2@customer.com');
    expect(secondMemories).toEqual([]);
    expect(genRes).toEqual({});
    expect(delRes).toEqual({});
    expect(requestSpy).toHaveBeenCalledTimes(1);

    // First call to ensureAgentExecutionConsent hits ESF and trips the circuit-breaker for 'engineUserData'
    await expect(
      client.ensureAgentExecutionConsent(
        'projects/1234567890/locations/global/collections/default_collection/engines/enterprise-engine-1/assistants/default_assistant/agents/ag-1',
        env,
        'user1@customer.com'
      )
    ).rejects.toThrow(/UserService \(:getEngineUserData \/ :updateEngineUserData\) is restricted/);
    expect(requestSpy).toHaveBeenCalledTimes(2);

    // Second call for another agent/user short-circuits immediately without invoking this.request
    await expect(
      client.ensureAgentExecutionConsent(
        'projects/1234567890/locations/global/collections/default_collection/engines/enterprise-engine-1/assistants/default_assistant/agents/ag-2',
        env,
        'user2@customer.com'
      )
    ).rejects.toThrow(/UserService \(:getEngineUserData \/ :updateEngineUserData\) is restricted/);
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects GET /api/capabilities/probe with 400 when projectId is missing and returns capability report when valid', async () => {
    const prevSourceProj = process.env.SOURCE_PROJECT_ID;
    delete process.env.SOURCE_PROJECT_ID;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('http://127.0.0.1:')) {
        return realFetch(input, init);
      }
      if (url.includes('/memories') || url.includes(':getEngineUserData') || url.includes('/notes:batchGet') || url.includes('/artifacts')) {
        return new Response(
          JSON.stringify({ error: { code: 404, message: 'Method not found.', status: 'NOT_FOUND' } }),
          { status: 404 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const server = createTestServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    try {
      // 1. Negative test: missing projectId must return HTTP 400 MissingProjectId
      const badRes = await realFetch(`http://127.0.0.1:${port}/api/capabilities/probe`);
      expect(badRes.status).toBe(400);
      const badJson: any = await badRes.json();
      expect(badJson.error).toBe('MissingProjectId');

      // 2. Positive test: valid projectId returns HTTP 200 with structured capabilities
      const okRes = await realFetch(
        `http://127.0.0.1:${port}/api/capabilities/probe?projectId=cust-proj-99&location=global&appId=eng-99`
      );
      expect(okRes.status).toBe(200);
      const okJson: any = await okRes.json();
      expect(okJson.success).toBe(true);
      expect(okJson.capabilities.projectId).toBe('cust-proj-99');
      expect(okJson.capabilities.agents.status).toBe('SUPPORTED');
      expect(okJson.capabilities.memories.status).toBe('RESTRICTED');
      expect(okJson.capabilities.notebooks.notes.status).toBe('RESTRICTED');
      expect(okJson.capabilities.notebooks.artifacts.status).toBe('RESTRICTED');
    } finally {
      if (prevSourceProj !== undefined) {
        process.env.SOURCE_PROJECT_ID = prevSourceProj;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
