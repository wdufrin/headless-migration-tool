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
import { AgentMigrator } from '../src/engines/agentMigrator.js';
import { DiscoveryEngineClient } from '../src/services/discoveryEngine.js';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import { Agent } from '../src/types/index.js';

/**
 * When user impersonation fails, agentMigrator falls back to creating the agent as the
 * admin service account. The agent then exists in the target but is NOT owned by the
 * intended user.
 *
 * Previously the result still said status SUCCESS with targetOwner set to the user, so
 * the report asserted an ownership transfer that never happened and the operator had no
 * way to find the affected assets short of reading the logs.
 */

const sourceEnv = {
  projectId: 'src-project',
  appLocation: 'global',
  collectionId: 'default_collection',
  appId: 'src_engine',
  assistantId: 'default_assistant'
};

const targetEnv = {
  projectId: 'tgt-project',
  appLocation: 'global',
  collectionId: 'default_collection',
  appId: 'tgt_engine',
  assistantId: 'default_assistant'
};

function agentOwnedBy(owner: string, id = 'agent-1'): Agent {
  return {
    name: `projects/1/locations/global/collections/default_collection/engines/src_engine/assistants/default_assistant/agents/${id}`,
    displayName: `Agent ${id}`,
    owner: `user:${owner}`,
    iamPolicy: {
      bindings: [{ role: 'roles/discoveryengine.agentOwner', members: [`user:${owner}`] }]
    }
  } as Agent;
}

/**
 * Builds a migrator whose client fails impersonated creates with `impersonationError`
 * but succeeds when called without a user (i.e. as the admin service account).
 */
function buildMigrator(impersonationError: string | null) {
  const auth = new GcpAuthService({ staticToken: 'test-token' });
  const client = new DiscoveryEngineClient(auth);

  const createCalls: Array<string | undefined> = [];

  // Must be environment-aware. If the TARGET also lists the agent, the migrator's
  // duplicate probe treats it as already migrated and never calls createAgent at all.
  vi.spyOn(client, 'listAgents').mockImplementation(async (env: any) =>
    (env?.projectId === sourceEnv.projectId ? [agentOwnedBy('alice@corp.com')] : []) as any
  );

  vi.spyOn(client, 'createAgent').mockImplementation(async (_env: any, payload: any, _id: any, forUser?: any) => {
    createCalls.push(forUser);
    if (forUser && impersonationError) {
      const err: any = new Error(impersonationError);
      err.status = 403;
      throw err;
    }
    return {
      name: `${targetEnv.projectId}/agents/created-1`,
      displayName: payload.displayName
    } as any;
  });

  return { migrator: new AgentMigrator(client), client, createCalls };
}

describe('Agent ownership reporting', () => {
  afterEach(() => vi.restoreAllMocks());

  it('marks ownershipTransferred=false when the admin service account created the agent', async () => {
    const { migrator, createCalls } = buildMigrator(
      'PERMISSION_DENIED: caller lacks discoveryengine.agents.create'
    );

    const results = await migrator.migrateAgents(
      sourceEnv,
      targetEnv,
      { concurrency: 1 },
      {},
      {},
      {}
    );

    expect(results).toHaveLength(1);
    const [r] = results;

    // The agent WAS created, so the run is not a failure...
    expect(r.status).toBe('SUCCESS');
    // ...but the report must not claim the user owns it.
    expect(r.ownershipTransferred).toBe(false);
    expect(r.ownershipNote).toMatch(/admin service account/i);
    expect(r.ownershipNote).toContain('alice@corp.com');

    // Confirms the fallback actually happened: impersonated attempt, then unimpersonated.
    expect(createCalls[0]).toBe('alice@corp.com');
    expect(createCalls[createCalls.length - 1]).toBeUndefined();
  });

  it('marks ownershipTransferred=true on a normal impersonated migration', async () => {
    const { migrator, createCalls } = buildMigrator(null);

    const results = await migrator.migrateAgents(sourceEnv, targetEnv, { concurrency: 1 }, {}, {}, {});

    expect(results[0].status).toBe('SUCCESS');
    expect(results[0].ownershipTransferred).toBe(true);
    expect(results[0].ownershipNote).toBeUndefined();
    expect(createCalls).toEqual(['alice@corp.com']);
  });

  it('does not silently report an unqualified success for the fallback path', async () => {
    const { migrator } = buildMigrator('PERMISSION_DENIED');
    const results = await migrator.migrateAgents(sourceEnv, targetEnv, { concurrency: 1 }, {}, {}, {});

    // The precise regression: SUCCESS + targetOwner=user with nothing indicating the
    // ownership transfer failed.
    const looksLikeCleanSuccess =
      results[0].status === 'SUCCESS' && results[0].ownershipTransferred !== false;
    expect(looksLikeCleanSuccess).toBe(false);
  });
});
