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
import { discoveryRouter } from '../src/routes/discovery.js';
import { wizardRouter } from '../src/routes/wizard.js';

function createTestServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.accessToken = 'mock-operator-access-token';
    next();
  });
  app.use('/api', discoveryRouter);
  app.use('/api', wizardRouter);
  return http.createServer(app);
}

describe('User Discovery & Auto-Map Multi-Page Agent Pagination', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('paginates across all agent pages in GET /api/users/discover and aggregates owners + IAM bindings', async () => {
    const requestedAgentPageUrls: string[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('http://127.0.0.1:')) {
        return realFetch(input, init);
      }

      if (url.includes('cloudresourcemanager.googleapis.com')) {
        return new Response(JSON.stringify({ bindings: [] }), { status: 200 });
      }

      if (url.includes('/assistants/default_assistant/agents?')) {
        requestedAgentPageUrls.push(url);
        const parsed = new URL(url);
        const pageToken = parsed.searchParams.get('pageToken');

        if (!pageToken) {
          return new Response(
            JSON.stringify({
              agents: [
                {
                  name: 'projects/test-proj/locations/global/collections/default_collection/engines/eng-1/assistants/default_assistant/agents/ag-1',
                  displayName: 'Page 1 Agent',
                  owner: 'page1.owner@company.com'
                }
              ],
              nextPageToken: 'token-page-2'
            }),
            { status: 200 }
          );
        }

        if (pageToken === 'token-page-2') {
          return new Response(
            JSON.stringify({
              agents: [
                {
                  name: 'projects/test-proj/locations/global/collections/default_collection/engines/eng-1/assistants/default_assistant/agents/ag-2',
                  displayName: 'Page 2 Agent'
                }
              ],
              nextPageToken: 'token-page-3'
            }),
            { status: 200 }
          );
        }

        if (pageToken === 'token-page-3') {
          return new Response(
            JSON.stringify({
              agents: [
                {
                  name: 'projects/test-proj/locations/global/collections/default_collection/engines/eng-1/assistants/default_assistant/agents/ag-3',
                  displayName: 'Page 3 Agent',
                  creator: 'user:page3.creator@company.com'
                }
              ]
            }),
            { status: 200 }
          );
        }
      }

      if (url.endsWith('/agents/ag-1:getIamPolicy')) {
        return new Response(
          JSON.stringify({
            bindings: [{ role: 'roles/discoveryengine.agentOwner', members: ['user:page1.owner@company.com'] }]
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/agents/ag-2:getIamPolicy')) {
        return new Response(
          JSON.stringify({
            bindings: [
              {
                role: 'roles/discoveryengine.agentEditor',
                members: [
                  'principal://iam.googleapis.com/locations/global/workforcePools/corp-pool/subject/page2.iam@company.com',
                  'serviceAccount:bot@test-proj.iam.gserviceaccount.com',
                  'deleted:user:gone@company.com',
                  'allUsers'
                ]
              }
            ]
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/agents/ag-3:getIamPolicy')) {
        return new Response(
          JSON.stringify({
            bindings: [{ role: 'roles/discoveryengine.agentOwner', members: ['user:page3.creator@company.com'] }]
          }),
          { status: 200 }
        );
      }

      return new Response(JSON.stringify({}), { status: 200 });
    });

    const server = createTestServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    try {
      const resp = await realFetch(
        `http://127.0.0.1:${port}/api/users/discover?projectId=test-proj&location=global&appId=eng-1&scope=single`
      );
      expect(resp.status).toBe(200);
      const data: any = await resp.json();

      expect(requestedAgentPageUrls).toHaveLength(3);
      expect(data.success).toBe(true);

      const emails = data.users.map((u: any) => u.email);
      expect(emails).toEqual([
        'page1.owner@company.com',
        'page3.creator@company.com',
        'page2.iam@company.com'
      ]);

      // Non-user principals must be rejected
      expect(emails).not.toContain('bot@test-proj.iam.gserviceaccount.com');
      expect(emails).not.toContain('gone@company.com');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('paginates across all agent pages in POST /api/idp/auto-map when sourceUsers is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('http://127.0.0.1:')) {
        return realFetch(input, init);
      }

      if (url.includes('/assistants/default_assistant/agents?')) {
        const parsed = new URL(url);
        const pageToken = parsed.searchParams.get('pageToken');
        if (!pageToken) {
          return new Response(
            JSON.stringify({
              agents: [
                {
                  name: 'projects/test-proj/locations/global/collections/default_collection/engines/eng-1/assistants/default_assistant/agents/ag-p1',
                  owner: 'alice@source.com'
                }
              ],
              nextPageToken: 'next-p2'
            }),
            { status: 200 }
          );
        }
        if (pageToken === 'next-p2') {
          return new Response(
            JSON.stringify({
              agents: [
                {
                  name: 'projects/test-proj/locations/global/collections/default_collection/engines/eng-1/assistants/default_assistant/agents/ag-p2'
                }
              ]
            }),
            { status: 200 }
          );
        }
      }

      if (url.endsWith('/agents/ag-p2:getIamPolicy')) {
        return new Response(
          JSON.stringify({
            bindings: [{ role: 'roles/owner', members: ['user:bob@source.com'] }]
          }),
          { status: 200 }
        );
      }

      return new Response(JSON.stringify({}), { status: 200 });
    });

    const server = createTestServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    try {
      const resp = await realFetch(`http://127.0.0.1:${port}/api/idp/auto-map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceUsers: [],
          sourceProjectId: 'test-proj',
          sourceLocation: 'global',
          sourceAppId: 'eng-1',
          domainRules: [{ fromDomain: '@source.com', toDomain: '@target.com' }]
        })
      });
      expect(resp.status).toBe(200);
      const body: any = await resp.json();

      expect(body.totalUsers).toBe(2);
      expect(body.mappings).toEqual([
        expect.objectContaining({ sourceIdentity: 'alice@source.com', targetIdentity: 'alice@target.com' }),
        expect.objectContaining({ sourceIdentity: 'bob@source.com', targetIdentity: 'bob@target.com' })
      ]);

      // Negative test: malformed domainRule missing required fromDomain/toDomain strings returns 500 AutoMapFailed
      const badResp = await realFetch(`http://127.0.0.1:${port}/api/idp/auto-map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceUsers: ['alice@source.com'],
          domainRules: [{ invalidKey: 123 }]
        })
      });
      expect(badResp.status).toBe(500);
      const badBody: any = await badResp.json();
      expect(badBody.error).toBe('AutoMapFailed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('breaks cleanly if upstream API returns a cyclic nextPageToken and surfaces 403 permission warnings', async () => {
    let agentCallCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('http://127.0.0.1:')) {
        return realFetch(input, init);
      }

      if (url.includes('/engines/eng-loop/assistants/default_assistant/agents?')) {
        agentCallCount++;
        return new Response(
          JSON.stringify({
            agents: [{ name: 'projects/p/locations/global/collections/default_collection/engines/eng-loop/assistants/default_assistant/agents/a1', owner: 'loop.user@company.com' }],
            nextPageToken: 'stuck-token'
          }),
          { status: 200 }
        );
      }

      if (url.includes('/engines/eng-denied/assistants/default_assistant/agents?')) {
        return new Response(JSON.stringify({ error: { message: 'Permission denied' } }), { status: 403 });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    });

    const server = createTestServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    try {
      // 1. Cyclic token must terminate after seeing 'stuck-token' once (initial page + 1st token page = 2 calls)
      const loopResp = await realFetch(
        `http://127.0.0.1:${port}/api/users/discover?projectId=test-proj&location=global&appId=eng-loop&scope=single`
      );
      expect(loopResp.status).toBe(200);
      const loopData: any = await loopResp.json();
      expect(agentCallCount).toBe(2);
      expect(loopData.users.map((u: any) => u.email)).toEqual(['loop.user@company.com']);

      // 2. HTTP 403 on agent enumeration must surface explicit roles/discoveryengine.admin warning
      const deniedResp = await realFetch(
        `http://127.0.0.1:${port}/api/users/discover?projectId=test-proj&location=global&appId=eng-denied&scope=single`
      );
      expect(deniedResp.status).toBe(200);
      const deniedData: any = await deniedResp.json();
      expect(deniedData.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Service account lacks 'roles/discoveryengine.admin'")
        ])
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
