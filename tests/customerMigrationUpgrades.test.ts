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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentRegistryClient, AGENT_REGISTRY_API_VERSION } from '../src/services/agentRegistry.js';
import { DiscoveryEngineClient } from '../src/services/discoveryEngine.js';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import { SkillMigrator } from '../src/engines/skillMigrator.js';
import { AgentMigrator } from '../src/engines/agentMigrator.js';
import { NotebookMigrator, resolveLocalSourceFile } from '../src/engines/notebookMigrator.js';
import { SecurityValidationError } from '../src/security/validator.js';
import { EnvironmentConfig } from '../src/types/migration.js';
import { Agent, Notebook } from '../src/types/index.js';

describe('Customer Project Backend Upgrades (P0 / P1 / P2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================================
  // P0: Cloud Agent Registry v1 GA, LRO Polling, Scotty /download, & Skill IAM
  // ============================================================================
  describe('P0: AgentRegistryClient v1 GA, LRO Polling, Scotty Download, & Skill IAM', () => {
    const usSourceEnv: EnvironmentConfig = {
      projectId: 'cust-src-proj',
      appLocation: 'us',
      appId: 'src-engine'
    };
    const usTargetEnv: EnvironmentConfig = {
      projectId: 'cust-tgt-proj',
      appLocation: 'us',
      appId: 'tgt-engine'
    };

    it('uses GA v1 surface, polls LongRunningOperations to completion, downloads via /download/v1, and migrates Skill IAM bindings', async () => {
      expect(AGENT_REGISTRY_API_VERSION).toBe('v1');

      const auth = new GcpAuthService({ staticToken: 'test-token' });
      const arClient = new AgentRegistryClient(auth, {
        operationPollIntervalMs: 5,
        operationTimeoutMs: 2000
      });

      const observedCalls: Array<{ method: string; url: string; body?: any }> = [];
      let createOpPollCount = 0;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : input.url;
        const method = init?.method || 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        observedCalls.push({ method, url, body });

        // 1. Source listSkills (regional us)
        if (url === 'https://agentregistry.googleapis.com/v1/projects/cust-src-proj/locations/us/skills?pageSize=100') {
          return new Response(
            JSON.stringify({
              skills: [
                {
                  name: 'projects/cust-src-proj/locations/us/skills/finops-analyzer',
                  skillId: 'finops-analyzer',
                  displayName: 'FinOps Analyzer',
                  description: 'Analyzes GCP billing exports',
                  type: 'SIMPLE',
                  targetState: 'TARGET_STATE_ACTIVE'
                }
              ]
            }),
            { status: 200 }
          );
        }

        // 2. Source getSkillIamPolicy (owner identified via IAM binding even without skill.publisher)
        if (
          url ===
          'https://agentregistry.googleapis.com/v1/projects/cust-src-proj/locations/us/skills/finops-analyzer:getIamPolicy?options.requestedPolicyVersion=3'
        ) {
          return new Response(
            JSON.stringify({
              version: 3,
              etag: 'src-etag-1',
              bindings: [
                { role: 'roles/agentregistry.admin', members: ['user:alice@source.com'] },
                {
                  role: 'roles/agentregistry.viewer',
                  members: ['user:bob@source.com', 'deleted:user:gone@source.com'],
                  condition: { title: 'ProdOnly', expression: 'resource.name.startsWith("projects/cust")' }
                }
              ]
            }),
            { status: 200 }
          );
        }

        // 3. Source getSkill
        if (
          method === 'GET' &&
          url === 'https://agentregistry.googleapis.com/v1/projects/cust-src-proj/locations/us/skills/finops-analyzer'
        ) {
          return new Response(
            JSON.stringify({
              name: 'projects/cust-src-proj/locations/us/skills/finops-analyzer',
              displayName: 'FinOps Analyzer',
              description: 'Analyzes GCP billing exports',
              type: 'SIMPLE',
              targetState: 'TARGET_STATE_ACTIVE'
            }),
            { status: 200 }
          );
        }

        // 4. Source listSkillRevisions (no inline archiveContent -> forces Scotty /download/v1 media fetch)
        if (
          url ===
          'https://agentregistry.googleapis.com/v1/projects/cust-src-proj/locations/us/skills/finops-analyzer/revisions?pageSize=50'
        ) {
          return new Response(
            JSON.stringify({
              skillRevisions: [
                {
                  name: 'projects/cust-src-proj/locations/us/skills/finops-analyzer/revisions/rev-1',
                  state: 'ACTIVE'
                }
              ]
            }),
            { status: 200 }
          );
        }

        // 5. Source Scotty media download (/download/v1/...?alt=media)
        if (
          url ===
          'https://agentregistry.googleapis.com/download/v1/projects/cust-src-proj/locations/us/skills/finops-analyzer/revisions/rev-1?alt=media'
        ) {
          return new Response(Buffer.from('PK-REAL-SKILL-ZIP-BYTES'), { status: 200 });
        }

        // 6. Target existence probe -> 404
        if (
          method === 'GET' &&
          url === 'https://agentregistry.googleapis.com/v1/projects/cust-tgt-proj/locations/us/skills/finops-analyzer'
        ) {
          return new Response(JSON.stringify({ error: { code: 404, message: 'Skill not found' } }), { status: 404 });
        }

        // 7. Target createSkill -> returns PENDING LRO (operation ID must NOT be confused with skill ID!)
        if (
          method === 'POST' &&
          url === 'https://agentregistry.googleapis.com/v1/projects/cust-tgt-proj/locations/us/skills?skillId=finops-analyzer'
        ) {
          return new Response(
            JSON.stringify({
              name: 'projects/cust-tgt-proj/locations/us/operations/op-create-99999',
              done: false,
              metadata: { verb: 'create' }
            }),
            { status: 200 }
          );
        }

        // 8. Poll LRO -> pending first, then done with Skill response
        if (url === 'https://agentregistry.googleapis.com/v1/projects/cust-tgt-proj/locations/us/operations/op-create-99999') {
          createOpPollCount++;
          if (createOpPollCount < 2) {
            return new Response(
              JSON.stringify({
                name: 'projects/cust-tgt-proj/locations/us/operations/op-create-99999',
                done: false
              }),
              { status: 200 }
            );
          }
          return new Response(
            JSON.stringify({
              name: 'projects/cust-tgt-proj/locations/us/operations/op-create-99999',
              done: true,
              response: {
                '@type': 'type.googleapis.com/google.cloud.agentregistry.v1.Skill',
                name: 'projects/cust-tgt-proj/locations/us/skills/finops-analyzer',
                displayName: 'FinOps Analyzer'
              }
            }),
            { status: 200 }
          );
        }

        // 9. Target listSkillRevisions & updateSkill (also returns completed LRO)
        if (
          url ===
          'https://agentregistry.googleapis.com/v1/projects/cust-tgt-proj/locations/us/skills/finops-analyzer/revisions?pageSize=50'
        ) {
          return new Response(
            JSON.stringify({
              skillRevisions: [
                {
                  name: 'projects/cust-tgt-proj/locations/us/skills/finops-analyzer/revisions/tgt-rev-1',
                  state: 'ACTIVE'
                }
              ]
            }),
            { status: 200 }
          );
        }
        if (
          method === 'PATCH' &&
          url.startsWith('https://agentregistry.googleapis.com/v1/projects/cust-tgt-proj/locations/us/skills/finops-analyzer?updateMask=')
        ) {
          return new Response(
            JSON.stringify({
              name: 'projects/cust-tgt-proj/locations/us/operations/op-update-111',
              done: true,
              response: {
                name: 'projects/cust-tgt-proj/locations/us/skills/finops-analyzer',
                state: 'STATE_ACTIVE'
              }
            }),
            { status: 200 }
          );
        }

        // 10. Target getSkillIamPolicy & setSkillIamPolicy
        if (
          url ===
          'https://agentregistry.googleapis.com/v1/projects/cust-tgt-proj/locations/us/skills/finops-analyzer:getIamPolicy?options.requestedPolicyVersion=3'
        ) {
          return new Response(
            JSON.stringify({
              version: 3,
              etag: 'tgt-etag-initial',
              bindings: [
                { role: 'roles/agentregistry.admin', members: ['serviceAccount:migrator@cust-tgt-proj.iam.gserviceaccount.com'] }
              ]
            }),
            { status: 200 }
          );
        }
        if (
          method === 'POST' &&
          url === 'https://agentregistry.googleapis.com/v1/projects/cust-tgt-proj/locations/us/skills/finops-analyzer:setIamPolicy'
        ) {
          return new Response(JSON.stringify(body.policy), { status: 200 });
        }

        throw new Error(`Unhandled fetch URL in AgentRegistry test: ${method} ${url}`);
      });

      const migrator = new SkillMigrator(arClient);
      const results = await migrator.migrateSkills(
        usSourceEnv,
        usTargetEnv,
        { userFilter: ['alice@source.com'] },
        {
          'alice@source.com': 'alice@target.com',
          'bob@source.com': 'bob@target.com'
        }
      );

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('SUCCESS');
      // Critical LRO regression check: targetId MUST be 'finops-analyzer', NEVER 'op-create-99999'
      expect(results[0].targetId).toBe('finops-analyzer');
      expect(results[0].originalOwner).toBe('alice@source.com');
      expect(results[0].targetOwner).toBe('alice@target.com');
      expect(createOpPollCount).toBe(2);

      // Verify Scotty download hit /download/v1/... and archive bytes were sent in createSkill
      const createCall = observedCalls.find(
        c => c.method === 'POST' && c.url.includes('/skills?skillId=finops-analyzer')
      );
      expect(createCall?.body?.initialRevision?.archiveUploadSource?.archiveContent).toBe(
        Buffer.from('PK-REAL-SKILL-ZIP-BYTES').toString('base64')
      );

      // Verify setIamPolicy mapped identities, stripped deleted: principals, and preserved IAM conditions
      const setIamCall = observedCalls.find(c => c.url.endsWith(':setIamPolicy'));
      expect(setIamCall).toBeDefined();
      expect(setIamCall?.body?.policy?.etag).toBe('tgt-etag-initial');
      expect(setIamCall?.body?.policy?.bindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'roles/agentregistry.admin',
            members: expect.arrayContaining([
              'serviceAccount:migrator@cust-tgt-proj.iam.gserviceaccount.com',
              'user:alice@target.com'
            ])
          }),
          expect.objectContaining({
            role: 'roles/agentregistry.viewer',
            members: ['user:bob@target.com'],
            condition: { title: 'ProdOnly', expression: 'resource.name.startsWith("projects/cust")' }
          })
        ])
      );
    });

    it('rejects hostile SSRF/traversal inputs, failed LROs, LRO timeouts, and non-404 media errors', async () => {
      const auth = new GcpAuthService({ staticToken: 'test-token' });
      const arClient = new AgentRegistryClient(auth, {
        operationPollIntervalMs: 5,
        operationTimeoutMs: 25
      });

      // 1. Hostile location / skillId / operationName must throw SecurityValidationError before any network call
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(
        arClient.listSkills({ projectId: 'p1', appLocation: 'us/../../evil', appId: 'a1' })
      ).rejects.toThrow(SecurityValidationError);
      await expect(
        arClient.createSkill('../etc/passwd', { displayName: 'Bad' }, usTargetEnv)
      ).rejects.toThrow(SecurityValidationError);
      await expect(
        arClient.getOperation('projects/p1/locations/us/operations/../../secret', 'p1')
      ).rejects.toThrow(SecurityValidationError);
      expect(fetchSpy).not.toHaveBeenCalled();

      // 2. LRO returning operation.error must reject with explicit status/message
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'projects/cust-tgt-proj/locations/us/operations/op-fail-1',
            done: true,
            error: { code: 7, message: 'Caller lacks agentregistry.skills.create' }
          }),
          { status: 200 }
        )
      );
      await expect(
        arClient.createSkill('valid-skill', { displayName: 'Valid' }, usTargetEnv)
      ).rejects.toThrow(/Agent Registry Operation Failed \[7\]: Caller lacks agentregistry\.skills\.create/);

      // 3. LRO never finishing within operationTimeoutMs must throw TimeoutError (ETIMEDOUT)
      fetchSpy.mockImplementation(async () =>
        new Response(
          JSON.stringify({
            name: 'projects/cust-tgt-proj/locations/us/operations/op-stuck-1',
            done: false
          }),
          { status: 200 }
        )
      );
      await expect(
        arClient.createSkill('stuck-skill', { displayName: 'Stuck' }, usTargetEnv)
      ).rejects.toMatchObject({ name: 'TimeoutError', code: 'ETIMEDOUT' });

      // 4. Non-404 Scotty media download failure (403) must throw, whereas 404 returns null
      fetchSpy.mockImplementation(async () => new Response('Forbidden media', { status: 403 }));
      await expect(
        arClient.downloadSkillRevisionMedia(
          'projects/cust-src-proj/locations/us/skills/s1/revisions/1',
          usSourceEnv
        )
      ).rejects.toThrow(/Failed to download skill revision media \[403\]/);

      fetchSpy.mockImplementation(async () => new Response('Not found', { status: 404 }));
      const notFoundMedia = await arClient.downloadSkillRevisionMedia(
        'projects/cust-src-proj/locations/us/skills/s1/revisions/1',
        usSourceEnv
      );
      expect(notFoundMedia).toBeNull();
    });
  });

  // ============================================================================
  // P1: Custom Agent Knowledge Files (AgentFile) & Admin TransferAgentOwner
  // ============================================================================
  describe('P1: Custom Agent AgentFile Migration & Server-Side TransferAgentOwner', () => {
    const sourceEnv: EnvironmentConfig = {
      projectId: 'src-cust',
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: 'src-eng',
      assistantId: 'default_assistant'
    };
    const targetEnv: EnvironmentConfig = {
      projectId: 'tgt-cust',
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: 'tgt-eng',
      assistantId: 'default_assistant'
    };

    it('downloads Low-Code AgentFiles via Scotty, uploads to target, patches lowCodeAgentDefinition BEFORE deployLowCode, and transfers ownership via TransferAgentOwner on SA fallback', async () => {
      const auth = new GcpAuthService({ staticToken: 'admin-token' });
      const client = new DiscoveryEngineClient(auth, { maxRetries: 1, retryBaseDelayMs: 5 });
      const migrator = new AgentMigrator(client);

      const lifecycleOrder: string[] = [];
      let uploadedHeaders: Record<string, string> = {};
      let uploadedBodyBytes: Buffer | null = null;
      let patchedLowCodeDef: any = null;
      let transferRequestPayload: any = null;

      const sourceLowCodeAgent: Agent = {
        name: 'projects/111/locations/global/collections/default_collection/engines/src-eng/assistants/default_assistant/agents/hr-policy-bot',
        displayName: 'HR Policy Bot',
        state: 'ENABLED',
        sharingConfig: { scope: 'ALL_USERS' },
        owner: 'user:alice@source.com',
        iamPolicy: {
          bindings: [
            { role: 'roles/discoveryengine.agentOwner', members: ['user:alice@source.com'] },
            { role: 'roles/discoveryengine.agentUser', members: ['user:bob@source.com'] }
          ]
        },
        lowCodeAgentDefinition: {
          rootAgentId: 'root-1',
          agentFiles: [
            {
              name: 'projects/111/locations/global/collections/default_collection/engines/src-eng/assistants/default_assistant/agents/hr-policy-bot/files/old-file-77',
              fileName: 'Employee_Handbook_2026.pdf',
              mimeType: 'application/pdf'
            }
          ],
          nodes: [
            {
              id: 'root-1',
              llmAgentNode: {
                instruction: 'Answer HR questions grounded in the handbook.',
                knowledgeSources: [
                  {
                    agentFile: {
                      name: 'projects/111/locations/global/collections/default_collection/engines/src-eng/assistants/default_assistant/agents/hr-policy-bot/files/old-file-77',
                      fileName: 'Employee_Handbook_2026.pdf',
                      mimeType: 'application/pdf'
                    }
                  }
                ]
              }
            }
          ],
          deployedRootAgentId: 'root-1'
        }
      };

      const tgtAgentName =
        'projects/222/locations/global/collections/default_collection/engines/tgt-eng/assistants/default_assistant/agents/new-hr-bot';
      const newUploadedFileName = `${tgtAgentName}/files/new-file-888`;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : input.url;
        const method = init?.method || 'GET';

        // Scotty DownloadAgentFile on source
        if (
          method === 'GET' &&
          url ===
            'https://discoveryengine.googleapis.com/download/v1alpha/projects/111/locations/global/collections/default_collection/engines/src-eng/assistants/default_assistant/agents/hr-policy-bot/files/old-file-77:download?alt=media'
        ) {
          lifecycleOrder.push('downloadAgentFile');
          return new Response(Buffer.from('%PDF-1.7-HANDBOOK-BYTES'), { status: 200 });
        }

        // Scotty UploadAgentFile on target
        if (method === 'POST' && url === `https://discoveryengine.googleapis.com/upload/v1alpha/${tgtAgentName}/files:upload`) {
          lifecycleOrder.push('uploadAgentFile');
          uploadedHeaders = (init?.headers || {}) as Record<string, string>;
          uploadedBodyBytes = Buffer.from(init?.body as any);
          return new Response(
            JSON.stringify({
              agentFile: {
                name: newUploadedFileName,
                fileName: 'Employee_Handbook_2026.pdf',
                mimeType: 'application/pdf'
              }
            }),
            { status: 200 }
          );
        }

        throw new Error(`Unexpected raw fetch call: ${method} ${url}`);
      });

      vi.spyOn(client, 'listAgents').mockImplementation(async (env) =>
        env.projectId === sourceEnv.projectId ? [sourceLowCodeAgent] : []
      );
      vi.spyOn(client, 'getAgentIamPolicy').mockImplementation(async (name, env) => {
        if (env.projectId === sourceEnv.projectId) return sourceLowCodeAgent.iamPolicy!;
        return {
          etag: 'tgt-etag',
          bindings: [{ role: 'roles/discoveryengine.agentOwner', members: ['user:alice@target.com'] }]
        };
      });

      // Simulate user impersonation failing on createAgent -> falls back to Admin Service Account
      vi.spyOn(client, 'createAgent').mockImplementation(async (_env, payload, _id, forUser) => {
        if (forUser) {
          const err: any = new Error('DWD Impersonation Failed: unauthorized_client');
          err.status = 403;
          throw err;
        }
        lifecycleOrder.push('createAgent:SA');
        return { name: tgtAgentName, displayName: payload.displayName } as Agent;
      });

      vi.spyOn(client, 'listAgentFiles').mockResolvedValue([]);
      vi.spyOn(client, 'patchAgent').mockImplementation(async (_name, payload, mask) => {
        lifecycleOrder.push(`patchAgent:${mask}`);
        patchedLowCodeDef = payload.lowCodeAgentDefinition;
        return { name: tgtAgentName, displayName: 'HR Policy Bot' } as Agent;
      });
      vi.spyOn(client, 'publishAgent').mockImplementation(async () => {
        lifecycleOrder.push('publishAgent');
        return {};
      });
      vi.spyOn(client, 'requestAgentReview').mockImplementation(async () => {
        lifecycleOrder.push('requestAgentReview');
        return { name: tgtAgentName, displayName: 'HR Policy Bot', state: 'ENABLED' } as Agent;
      });
      vi.spyOn(client, 'patchAgentSharing').mockImplementation(async () => {
        lifecycleOrder.push('patchAgentSharing');
        return { name: tgtAgentName, displayName: 'HR Policy Bot' } as Agent;
      });
      vi.spyOn(client, 'setAgentIamPolicy').mockImplementation(async () => {
        lifecycleOrder.push('setAgentIamPolicy');
        return { bindings: [] };
      });
      const transferSpy = vi.spyOn(client as any, 'request').mockImplementation(async (url: any, method: any, body: any) => {
        if (String(url).endsWith(':transferAgentOwner') && method === 'POST') {
          lifecycleOrder.push('transferAgentOwner');
          transferRequestPayload = body;
          return {};
        }
        throw new Error(`Unexpected client.request URL: ${url}`);
      });

      const results = await migrator.migrateAgents(
        sourceEnv,
        targetEnv,
        { concurrency: 1 },
        {},
        {},
        {
          'alice@source.com': 'principal://iam.googleapis.com/locations/global/workforcePools/corp-pool/subject/alice@target.com',
          'bob@source.com': 'bob@target.com'
        }
      );

      expect(results).toHaveLength(1);
      const res = results[0];
      expect(res.status).toBe('SUCCESS');
      expect(res.ownershipTransferred).toBe(true);
      expect(res.ownershipNote).toContain('TransferAgentOwner');
      expect(res.details?.agentFilesMigrated).toBe(1);
      expect(res.details?.agentFilesFailed).toBe(0);

      // Verify Scotty headers & raw PDF bytes
      expect(uploadedHeaders['X-Goog-Upload-Protocol']).toBe('raw');
      expect(uploadedHeaders['X-Goog-Upload-File-Name']).toBe('Employee_Handbook_2026.pdf');
      expect(uploadedHeaders['Content-Type']).toBe('application/pdf');
      expect(uploadedBodyBytes?.toString('utf8')).toBe('%PDF-1.7-HANDBOOK-BYTES');

      // Verify old file ID was rewritten to new target AgentFile resource name in BOTH agentFiles AND knowledgeSources
      expect(patchedLowCodeDef.agentFiles).toEqual([
        {
          name: newUploadedFileName,
          fileName: 'Employee_Handbook_2026.pdf',
          mimeType: 'application/pdf'
        }
      ]);
      expect(patchedLowCodeDef.nodes[0].llmAgentNode.knowledgeSources[0].agentFile.name).toBe(newUploadedFileName);

      // Verify strict execution order: upload & patchAgent BEFORE publishAgent, and transferAgentOwner AFTER sharing
      expect(lifecycleOrder).toEqual([
        'createAgent:SA',
        'downloadAgentFile',
        'uploadAgentFile',
        'patchAgent:lowCodeAgentDefinition',
        'publishAgent',
        'requestAgentReview',
        'patchAgentSharing',
        'transferAgentOwner',
        'setAgentIamPolicy'
      ]);

      // Verify WIF principal:// was preserved verbatim in TransferAgentOwner request
      expect(transferSpy).toHaveBeenCalledTimes(1);
      expect(transferRequestPayload).toEqual({
        targetPrincipal: {
          principal: 'principal://iam.googleapis.com/locations/global/workforcePools/corp-pool/subject/alice@target.com'
        }
      });
    });

    it('rejects invalid TransferAgentOwner principals and empty/traversal AgentFile operations, and reports honest failure when TransferAgentOwner fails', async () => {
      const auth = new GcpAuthService({ staticToken: 'admin-token' });
      const client = new DiscoveryEngineClient(auth, { maxRetries: 1, retryBaseDelayMs: 5 });

      const validAgent =
        'projects/222/locations/global/collections/default_collection/engines/tgt-eng/assistants/default_assistant/agents/ag-1';

      // 1. Reject serviceAccount:, empty, and malformed principals on transferAgentOwner
      await expect(
        client.transferAgentOwner(validAgent, 'serviceAccount:bot@proj.iam.gserviceaccount.com', targetEnv)
      ).rejects.toThrow(SecurityValidationError);
      await expect(client.transferAgentOwner(validAgent, 'not-a-valid-principal', targetEnv)).rejects.toThrow(
        SecurityValidationError
      );
      await expect(client.transferAgentOwner('projects/222/../../evil/agents/ag-1', 'alice@corp.com', targetEnv)).rejects.toThrow(
        SecurityValidationError
      );

      // 2. Reject empty AgentFile upload or missing /files/ segment on downloadAgentFile
      await expect(
        client.uploadAgentFile(validAgent, 'empty.pdf', Buffer.alloc(0), 'application/pdf', targetEnv)
      ).rejects.toThrow(/Cannot upload empty AgentFile/);
      await expect(
        client.uploadAgentFile(validAgent, '   ', Buffer.from('abc'), 'text/plain', targetEnv)
      ).rejects.toThrow(SecurityValidationError);
      await expect(client.downloadAgentFile(validAgent, targetEnv)).rejects.toThrow(SecurityValidationError);

      // 3. When TransferAgentOwner fails (e.g. target user lacks GE license), ownershipTransferred MUST be false
      const migrator = new AgentMigrator(client);
      const sharedAgent: Agent = {
        name: 'projects/111/locations/global/collections/default_collection/engines/src-eng/assistants/default_assistant/agents/shared-1',
        displayName: 'Shared Agent Unlicensed Target',
        state: 'ENABLED',
        sharingConfig: { scope: 'ALL_USERS' },
        owner: 'user:alice@source.com',
        adkAgentDefinition: { reasoningEngine: 'projects/111/locations/us-central1/reasoningEngines/re-1' }
      };

      vi.spyOn(client, 'listAgents').mockImplementation(async (env) =>
        env.projectId === sourceEnv.projectId ? [sharedAgent] : []
      );
      vi.spyOn(client, 'getAgentIamPolicy').mockResolvedValue({ bindings: [] });
      vi.spyOn(client, 'createAgent').mockImplementation(async (_env, payload, _id, forUser) => {
        if (forUser) {
          const err: any = new Error('PERMISSION_DENIED');
          err.status = 403;
          throw err;
        }
        return { name: validAgent, displayName: payload.displayName } as Agent;
      });
      vi.spyOn(client, 'publishAgent').mockResolvedValue({});
      vi.spyOn(client, 'requestAgentReview').mockResolvedValue({ name: validAgent, displayName: 'Shared', state: 'ENABLED' } as Agent);
      vi.spyOn(client, 'patchAgentSharing').mockResolvedValue({ name: validAgent, displayName: 'Shared' } as Agent);
      vi.spyOn(client, 'transferAgentOwner').mockRejectedValue(
        new Error('FAILED_PRECONDITION: Target user alice@target.com does not hold an active license')
      );

      const [res] = await migrator.migrateAgents(
        sourceEnv,
        targetEnv,
        { concurrency: 1 },
        {},
        {},
        { 'alice@source.com': 'alice@target.com' }
      );

      expect(res.status).toBe('SUCCESS');
      expect(res.ownershipTransferred).toBe(false);
      expect(res.ownershipNote).toContain('Target user alice@target.com does not hold an active license');
    });
  });

  // ============================================================================
  // P2a: Per-User Scheduled / Event AgentSubscription Migration
  // ============================================================================
  describe('P2a: Per-User AgentSubscription Migration', () => {
    const sourceEnv: EnvironmentConfig = {
      projectId: 'src-proj',
      appLocation: 'us',
      collectionId: 'default_collection',
      appId: 'src-app',
      assistantId: 'default_assistant'
    };
    const targetEnv: EnvironmentConfig = {
      projectId: 'tgt-proj',
      appLocation: 'eu',
      collectionId: 'default_collection',
      appId: 'tgt-app',
      assistantId: 'default_assistant'
    };

    it('migrates ACTIVE and INACTIVE per-user AgentSubscriptions, rewrites connector URIs, strips output-only fields, and pauses INACTIVE subscriptions', async () => {
      const auth = new GcpAuthService({ staticToken: 'test-token' });
      const client = new DiscoveryEngineClient(auth, { maxRetries: 1, retryBaseDelayMs: 5 });
      const migrator = new AgentMigrator(client);

      const srcAgentName =
        'projects/src-proj/locations/us/collections/default_collection/engines/src-app/assistants/default_assistant/agents/wf-1';
      const tgtAgentName =
        'projects/tgt-proj/locations/eu/collections/default_collection/engines/tgt-app/assistants/default_assistant/agents/wf-tgt-1';

      const workflowAgent: Agent = {
        name: srcAgentName,
        displayName: 'Daily Digest Workflow',
        state: 'ENABLED',
        sharingConfig: { scope: 'RESTRICTED' },
        owner: 'user:alice@src.com',
        iamPolicy: {
          bindings: [
            { role: 'roles/discoveryengine.agentOwner', members: ['user:alice@src.com'] },
            { role: 'roles/discoveryengine.agentUser', members: ['user:bob@src.com'] }
          ]
        },
        workflowAgentDefinition: {
          deployedAgentFlow: {
            nodes: [{ id: 'trig-1', scheduleTrigger: { cron: '0 9 * * 1-5' } }]
          }
        }
      };

      vi.spyOn(client, 'listAgents').mockImplementation(async (env) =>
        env.projectId === sourceEnv.projectId ? [workflowAgent] : []
      );
      vi.spyOn(client, 'getAgentIamPolicy').mockImplementation(async (_name, env) =>
        env.projectId === sourceEnv.projectId
          ? workflowAgent.iamPolicy!
          : { etag: 'e1', bindings: [{ role: 'roles/discoveryengine.agentOwner', members: ['user:alice@tgt.com'] }] }
      );
      vi.spyOn(client, 'createAgent').mockResolvedValue({ name: tgtAgentName, displayName: 'Daily Digest Workflow' });
      vi.spyOn(client, 'publishAgent').mockResolvedValue({});
      vi.spyOn(client, 'requestAgentReview').mockResolvedValue({ name: tgtAgentName, displayName: 'Daily Digest Workflow', state: 'ENABLED' });
      vi.spyOn(client, 'patchAgentSharing').mockResolvedValue({ name: tgtAgentName, displayName: 'Daily Digest Workflow' });
      vi.spyOn(client, 'setAgentIamPolicy').mockResolvedValue({ bindings: [] });

      const createdRequests: Array<{ url: string; body: any; user?: string }> = [];
      const pausedUrls: Array<{ url: string; user?: string }> = [];

      vi.spyOn(client as any, 'request').mockImplementation(async (...args: any[]) => {
        const url = String(args[0]);
        const method = String(args[1] || 'GET');
        const body = args[2];
        const forUser = args[5];

        if (method === 'GET' && url.includes(`${srcAgentName}/agentSubscriptions`)) {
          if (forUser === 'alice@src.com') {
            return {
              agentSubscriptions: [
                {
                  name: `${srcAgentName}/agentSubscriptions/sub-alice-1`,
                  subscriberCpi: 'cpi-alice',
                  state: 'ACTIVE',
                  createTime: '2026-10-01T00:00:00Z',
                  agentFlowNode: {
                    id: 'trig-1',
                    connectorEventTrigger: {
                      dataConnector: 'projects/src-proj/locations/us/collections/jira_src/dataConnector'
                    }
                  }
                }
              ]
            };
          }
          if (forUser === 'bob@src.com') {
            return {
              agentSubscriptions: [
                {
                  name: `${srcAgentName}/agentSubscriptions/sub-bob-1`,
                  subscriberCpi: 'cpi-bob',
                  state: 'INACTIVE',
                  agentFlowNode: {
                    id: 'trig-2',
                    scheduleTrigger: { cron: '0 14 * * 5' }
                  }
                }
              ]
            };
          }
          return { agentSubscriptions: [] };
        }

        if (method === 'GET' && url.includes(`${tgtAgentName}/agentSubscriptions`)) {
          return { agentSubscriptions: [] };
        }

        if (method === 'POST' && url.endsWith(`${tgtAgentName}/agentSubscriptions`)) {
          createdRequests.push({ url, body, user: forUser });
          return {
            name: `${tgtAgentName}/agentSubscriptions/new-sub-${forUser?.split('@')[0]}`,
            state: 'ACTIVE'
          };
        }

        if (method === 'POST' && url.endsWith(':pause')) {
          pausedUrls.push({ url, user: forUser });
          return { state: 'INACTIVE' };
        }

        throw new Error(`Unexpected subscription test request: ${method} ${url}`);
      });

      const [res] = await migrator.migrateAgents(
        sourceEnv,
        targetEnv,
        { concurrency: 1 },
        {},
        { jira_src: 'jira_tgt' },
        { 'alice@src.com': 'alice@tgt.com', 'bob@src.com': 'bob@tgt.com' }
      );

      expect(res.status).toBe('SUCCESS');
      expect(res.details?.subscriptionsMigrated).toBe(2);
      expect(res.details?.subscriptionsFailed).toBe(0);
      expect(createdRequests).toHaveLength(2);

      // Output-only fields MUST be stripped and connector collection + location rewritten to target (eu / jira_tgt)
      const aliceSub = createdRequests.find(r => r.user === 'alice@tgt.com');
      expect(aliceSub?.body.name).toBeUndefined();
      expect(aliceSub?.body.subscriberCpi).toBeUndefined();
      expect(aliceSub?.body.state).toBeUndefined();
      expect(aliceSub?.body.agentFlowNode.connectorEventTrigger.dataConnector).toBe(
        'projects/tgt-proj/locations/eu/collections/jira_tgt/dataConnector'
      );

      // Bob's INACTIVE subscription must be paused immediately after creation
      expect(pausedUrls).toEqual([
        {
          url: `https://eu-discoveryengine.googleapis.com/v1alpha/${tgtAgentName}/agentSubscriptions/new-sub-bob:pause`,
          user: 'bob@tgt.com'
        }
      ]);

      // Adversarial validation checks on subscription methods
      await expect(client.pauseAgentSubscription(`${tgtAgentName}/notASubscription`, targetEnv)).rejects.toThrow(
        SecurityValidationError
      );
      await expect(client.createAgentSubscription(tgtAgentName, null as any, targetEnv)).rejects.toThrow(
        /Subscription payload must be a non-null object/
      );
    });
  });

  // ============================================================================
  // P2b: Notebook Binary UploadSourceFile & Path-Traversal Protection
  // ============================================================================
  describe('P2b: NotebookLM Scotty UploadSourceFile & Local Directory Confinement', () => {
    it('uploads local binary PDFs via /upload/v1alpha/.../sources:uploadFile when ESF strips tailwind_doc on customer projects', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-migrate-nb-src-'));
      try {
        const pdfBytes = Buffer.from('%PDF-1.7-BOARD-DECK-BINARY-CONTENT');
        fs.writeFileSync(path.join(tmpDir, 'Board_Deck_Q4.pdf'), pdfBytes);

        const auth = new GcpAuthService({ staticToken: 'user-token' });
        vi.spyOn(auth, 'getAccessToken').mockResolvedValue('user-token');
        const client = new DiscoveryEngineClient(auth, { maxRetries: 1, retryBaseDelayMs: 5 });
        const migrator = new NotebookMigrator(client);

        const sourceEnv: EnvironmentConfig = {
          projectId: 'cust-nb-src',
          appLocation: 'us',
          appId: 'src-app'
        };
        const targetEnv: EnvironmentConfig = {
          projectId: 'cust-nb-tgt',
          appLocation: 'us',
          appId: 'tgt-app'
        };

        const srcNotebook: Notebook = {
          name: 'projects/cust-nb-src/locations/us/notebooks/nb-100',
          title: 'Q4 Executive Planning',
          owner: 'exec@customer.com',
          metadata: { userRole: 'PROJECT_ROLE_OWNER', isShared: false },
          sources: [
            {
              name: 'projects/cust-nb-src/locations/us/notebooks/nb-100/sources/src-pdf-1',
              title: 'Board_Deck_Q4.pdf',
              metadata: {} // Stripped by ESF on customer project (no tailwindDoc)
            }
          ]
        };

        vi.spyOn(client, 'listNotebooks').mockImplementation(async (env) =>
          env.projectId === sourceEnv.projectId ? [srcNotebook] : []
        );
        vi.spyOn(client, 'getNotebook').mockResolvedValue(srcNotebook);
        vi.spyOn(client, 'getNotebookSource').mockResolvedValue({
          name: 'projects/cust-nb-src/locations/us/notebooks/nb-100/sources/src-pdf-1',
          title: 'Board_Deck_Q4.pdf',
          metadata: {}
        });
        vi.spyOn(client, 'listNotes').mockResolvedValue([]);
        vi.spyOn(client, 'listArtifacts').mockResolvedValue([]);
        vi.spyOn(client, 'createNotebook').mockResolvedValue({
          name: 'projects/cust-nb-tgt/locations/us/notebooks/nb-tgt-200',
          title: 'Q4 Executive Planning'
        });

        let scottyUploadUrl = '';
        let scottyHeaders: Record<string, string> = {};
        let scottyBody: Buffer | null = null;

        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
          scottyUploadUrl = typeof input === 'string' ? input : input.url;
          scottyHeaders = (init?.headers || {}) as Record<string, string>;
          scottyBody = Buffer.from(init?.body as any);
          return new Response(
            JSON.stringify({ sourceId: { id: 'uploaded-src-999' } }),
            { status: 200 }
          );
        });

        // 1. Dry-run parity check
        const dryRes = await migrator.migrateNotebooks(sourceEnv, targetEnv, {
          dryRun: true,
          userFilter: ['exec@customer.com'],
          localSourceFilesDir: tmpDir
        });
        expect(dryRes).toHaveLength(1);
        expect(dryRes[0].status).toBe('DRY_RUN');
        expect(dryRes[0].details?.sourcesRestored).toBe(1);
        expect(dryRes[0].details?.sourcesFailed).toBe(0);
        expect(scottyUploadUrl).toBe(''); // Dry run must not upload

        // 2. Live migration check
        const liveRes = await migrator.migrateNotebooks(sourceEnv, targetEnv, {
          dryRun: false,
          userFilter: ['exec@customer.com'],
          localSourceFilesDir: tmpDir
        });
        expect(liveRes).toHaveLength(1);
        expect(liveRes[0].status).toBe('SUCCESS');
        expect(liveRes[0].details?.sourcesRestored).toBe(1);
        expect(liveRes[0].details?.sourcesFailed).toBe(0);
        expect(liveRes[0].details?.sources?.[0]?.targetSourceId).toBe('uploaded-src-999');

        expect(scottyUploadUrl).toBe(
          'https://us-discoveryengine.googleapis.com/upload/v1alpha/projects/cust-nb-tgt/locations/us/notebooks/nb-tgt-200/sources:uploadFile'
        );
        expect(scottyHeaders['X-Goog-Upload-Protocol']).toBe('raw');
        expect(scottyHeaders['X-Goog-Upload-File-Name']).toBe('Board_Deck_Q4.pdf');
        expect(scottyHeaders['Content-Type']).toBe('application/pdf');
        expect(scottyBody?.equals(pdfBytes)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('strictly rejects path traversal, directory separators, null bytes, and symlink escapes in resolveLocalSourceFile', () => {
      const safeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-safe-src-'));
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-outside-secret-'));
      try {
        const secretPath = path.join(outsideDir, 'secret.txt');
        fs.writeFileSync(secretPath, 'TOP-SECRET-TOKEN');
        const symlinkPath = path.join(safeDir, 'escaped_link.pdf');
        fs.symlinkSync(secretPath, symlinkPath);

        expect(() => resolveLocalSourceFile(safeDir, '../../etc/passwd')).toThrow(SecurityValidationError);
        expect(() => resolveLocalSourceFile(safeDir, '/etc/passwd')).toThrow(SecurityValidationError);
        expect(() => resolveLocalSourceFile(safeDir, 'nested/file.pdf')).toThrow(SecurityValidationError);
        expect(() => resolveLocalSourceFile(safeDir, 'bad\0file.pdf')).toThrow(SecurityValidationError);
        expect(() => resolveLocalSourceFile(safeDir, 'escaped_link.pdf')).toThrow(SecurityValidationError);
        expect(() => resolveLocalSourceFile(path.join(safeDir, 'nonexistent-subdir'), 'doc.pdf')).toThrow(
          SecurityValidationError
        );
      } finally {
        fs.rmSync(safeDir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });
});
