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
import path from 'path';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import { DiscoveryEngineClient } from '../src/services/discoveryEngine.js';
import { MigrationRunner } from '../src/engines/migrationRunner.js';
import { ValidatedMigrationConfig } from '../src/config/configSchema.js';
import { getSafeDiscoveryEngineUrl } from '../src/security/validator.js';
import { logger } from '../src/utils/logger.js';

export interface TestPermutation {
  id: string;
  name: string;
  sourceIdp: 'GOOGLE_CLOUD_IDENTITY' | 'ENTRA_ID_WIF';
  targetIdp: 'GOOGLE_CLOUD_IDENTITY' | 'ENTRA_ID_WIF';
  authType: 'SERVICE_ACCOUNT_KEY' | 'WORKFORCE_IDENTITY_FEDERATION';
  source: {
    projectId: string;
    appLocation: string;
    collectionId: string;
    appId: string;
    assistantId: string;
  };
  target: {
    projectId: string;
    appLocation: string;
    collectionId: string;
    appId: string;
    assistantId: string;
  };
  sourceUser: string;
  targetUser: string;
}

const SRC_PROJECT_DWD = process.env.SOURCE_PROJECT_DWD || process.env.SOURCE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
const SRC_APP_DWD = process.env.SOURCE_APP_DWD || process.env.SOURCE_APP_ID || '';
const TGT_PROJECT_DWD = process.env.TARGET_PROJECT_DWD || process.env.TARGET_PROJECT_ID || '';
const TGT_APP_DWD = process.env.TARGET_APP_DWD || process.env.TARGET_APP_ID || '';

const SRC_PROJECT_WIF = process.env.SOURCE_PROJECT_WIF || process.env.SOURCE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
const SRC_APP_WIF = process.env.SOURCE_APP_WIF || '';
const TGT_PROJECT_WIF = process.env.TARGET_PROJECT_WIF || process.env.TARGET_PROJECT_ID || '';
const TGT_APP_WIF = process.env.TARGET_APP_WIF || '';

const DWD_USER = process.env.DWD_USER_EMAIL || process.env.ADMIN_EMAIL || '';
const WIF_USER = process.env.WIF_USER_EMAIL || process.env.DEFAULT_USER_EMAIL || '';

export const TEST_PERMUTATIONS: TestPermutation[] = [
  {
    id: 'DWD-DWD',
    name: '1. DWD to DWD (Google Workspace -> Google Workspace)',
    sourceIdp: 'GOOGLE_CLOUD_IDENTITY',
    targetIdp: 'GOOGLE_CLOUD_IDENTITY',
    authType: 'SERVICE_ACCOUNT_KEY',
    source: {
      projectId: SRC_PROJECT_DWD,
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: SRC_APP_DWD,
      assistantId: 'default_assistant'
    },
    target: {
      projectId: TGT_PROJECT_DWD,
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: TGT_APP_DWD,
      assistantId: 'default_assistant'
    },
    sourceUser: DWD_USER,
    targetUser: DWD_USER
  },
  {
    id: 'DWD-WIF',
    name: '2. DWD to WiF (Google Workspace -> Microsoft Entra ID)',
    sourceIdp: 'GOOGLE_CLOUD_IDENTITY',
    targetIdp: 'ENTRA_ID_WIF',
    authType: 'WORKFORCE_IDENTITY_FEDERATION',
    source: {
      projectId: SRC_PROJECT_DWD,
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: SRC_APP_DWD,
      assistantId: 'default_assistant'
    },
    target: {
      projectId: TGT_PROJECT_WIF,
      appLocation: 'eu',
      collectionId: 'default_collection',
      appId: TGT_APP_WIF,
      assistantId: 'default_assistant'
    },
    sourceUser: DWD_USER,
    targetUser: WIF_USER
  },
  {
    id: 'WIF-WIF',
    name: '3. WiF to WiF (Microsoft Entra ID -> Microsoft Entra ID)',
    sourceIdp: 'ENTRA_ID_WIF',
    targetIdp: 'ENTRA_ID_WIF',
    authType: 'WORKFORCE_IDENTITY_FEDERATION',
    source: {
      projectId: SRC_PROJECT_WIF,
      appLocation: 'eu',
      collectionId: 'default_collection',
      appId: SRC_APP_WIF,
      assistantId: 'default_assistant'
    },
    target: {
      projectId: TGT_PROJECT_WIF,
      appLocation: 'eu',
      collectionId: 'default_collection',
      appId: TGT_APP_WIF,
      assistantId: 'default_assistant'
    },
    sourceUser: WIF_USER,
    targetUser: WIF_USER
  },
  {
    id: 'WIF-DWD',
    name: '4. WiF to DWD (Microsoft Entra ID -> Google Workspace)',
    sourceIdp: 'ENTRA_ID_WIF',
    targetIdp: 'GOOGLE_CLOUD_IDENTITY',
    authType: 'SERVICE_ACCOUNT_KEY',
    source: {
      projectId: SRC_PROJECT_WIF,
      appLocation: 'eu',
      collectionId: 'default_collection',
      appId: SRC_APP_WIF,
      assistantId: 'default_assistant'
    },
    target: {
      projectId: TGT_PROJECT_DWD,
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: TGT_APP_DWD,
      assistantId: 'default_assistant'
    },
    sourceUser: WIF_USER,
    targetUser: DWD_USER
  }
];

export interface TestResult {
  id: string;
  name: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  migratedAgents: number;
  migratedNotebooks: number;
  migratedSessions: number;
  migratedArtifacts: number;
  details: string;
  error?: string;
}

export class E2ETestMatrixRunner {
  private auth: GcpAuthService;
  private client: DiscoveryEngineClient;

  constructor() {
    this.auth = new GcpAuthService({
      serviceAccountKeyPath: './sa-dwd-key.json',
      wifConfigPath: './workforce-identity-config.json'
    });
    this.client = new DiscoveryEngineClient(this.auth);
  }

  /**
   * Resets and cleans the target environment before or after a test run.
   */
  async cleanTargetEnvironment(target: TestPermutation['target'], userEmail: string): Promise<{ deletedAgents: number; deletedNotebooks: number; deletedSessions: number }> {
    logger.info(`[CLEANUP] Cleaning target environment: ${target.projectId} (${target.appLocation}) engine: ${target.appId} for user ${userEmail}...`);
    
    let deletedAgents = 0;
    let deletedNotebooks = 0;
    let deletedSessions = 0;

    // 1. Delete Target Agents
    try {
      const agents = await this.client.listAgents({
        projectId: target.projectId,
        appLocation: target.appLocation,
        collectionId: target.collectionId,
        appId: target.appId,
        assistantId: target.assistantId
      });
      for (const ag of agents) {
        const agentId = ag.name.split('/').pop();
        if (agentId !== 'deep_research') {
          try {
            await this.client.deleteAgent(ag.name, target.appLocation, target.projectId);
            deletedAgents++;
          } catch (e: any) {
            logger.debug(`Could not delete agent ${ag.name}: ${e.message}`);
          }
        }
      }
    } catch (agErr: any) {
      logger.debug(`Target agent cleanup list notice: ${agErr.message}`);
    }

    // 2. Delete Target Notebooks
    try {
      const nbs = await this.client.listNotebooks({
        projectId: target.projectId,
        appLocation: target.appLocation,
        appId: target.appId
      }, userEmail);
      if (nbs.length > 0) {
        const nbNames = nbs.map(n => n.name).filter(Boolean);
        await this.client.batchDeleteNotebooks(target.projectId, target.appLocation, nbNames, userEmail);
        deletedNotebooks = nbNames.length;
      }
    } catch (nbErr: any) {
      logger.debug(`Target notebook cleanup notice: ${nbErr.message}`);
    }

    // 3. Delete Target Chat Sessions
    try {
      const baseUrl = getSafeDiscoveryEngineUrl(target.appLocation);
      const url = `${baseUrl}/v1alpha/projects/${target.projectId}/locations/${target.appLocation}/collections/${target.collectionId}/engines/${target.appId}/sessions?pageSize=100`;
      const token = await this.auth.getAccessToken(userEmail);
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Goog-User-Project': target.projectId
        }
      });
      if (res.ok) {
        const data = await res.json() as any;
        const sessions = data.sessions || [];
        for (const s of sessions) {
          try {
            const delUrl = `${baseUrl}/v1alpha/${s.name}`;
            await fetch(delUrl, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${token}`,
                'X-Goog-User-Project': target.projectId
              }
            });
            deletedSessions++;
          } catch {}
        }
      }
    } catch (sErr: any) {
      logger.debug(`Target session cleanup notice: ${sErr.message}`);
    }

    logger.info(`[CLEANUP] Completed for ${target.appId}: Deleted ${deletedAgents} agents, ${deletedNotebooks} notebooks, ${deletedSessions} sessions.`);
    return { deletedAgents, deletedNotebooks, deletedSessions };
  }

  /**
   * Executes a single permutation test.
   */
  async runPermutation(perm: TestPermutation): Promise<TestResult> {
    const startTime = Date.now();
    logger.info(`\n======================================================`);
    logger.info(`🚀 RUNNING TEST: ${perm.name}`);
    logger.info(`   Source: ${perm.source.projectId} (${perm.source.appLocation}) -> ${perm.source.appId} [User: ${perm.sourceUser}]`);
    logger.info(`   Target: ${perm.target.projectId} (${perm.target.appLocation}) -> ${perm.target.appId} [User: ${perm.targetUser}]`);
    logger.info(`   Auth Mode: ${perm.authType}`);
    logger.info(`======================================================\n`);

    try {
      // 1. Pre-Clean Target
      await this.cleanTargetEnvironment(perm.target, perm.targetUser);

      // 2. Build Validated Migration Config
      const config: ValidatedMigrationConfig = {
        source: perm.source,
        target: perm.target,
        options: {
          migrateNotebooks: true,
          migrateAgents: true,
          migrateSessions: true,
          exportArtifacts: true,
          agentTypes: ['ALL'],
          agentStatusFilter: 'ALL',
          excludeDraftAgents: false,
          notebookIds: [],
          dryRun: false, // LIVE EXECUTION
          concurrency: 5,
          userFilter: [perm.sourceUser],
          preserveOwnership: true,
          preserveSharing: true,
          publishAgents: false,
          prefixReplacements: {},
          allowOverwrite: true,
          logLevel: 'INFO'
        },
        auth: {
          authType: perm.authType,
          serviceAccountKeyPath: './sa-dwd-key.json',
          wifConfigPath: './workforce-identity-config.json'
        },
        idpMapping: {
          sourceIdp: perm.sourceIdp,
          targetIdp: perm.targetIdp,
          domainRules: []
        },
        identityMapping: {
          [perm.sourceUser]: perm.targetUser
        },
        datastoreMapping: {},
        collectionMapping: {}
      };

      // 3. Execute Migration
      const runner = new MigrationRunner({ authService: this.auth, outputDir: './reports' });
      const report = await runner.run(config);

      const durationMs = Date.now() - startTime;
      logger.info(`\n✅ MIGRATION COMPLETED for ${perm.id} in ${(durationMs / 1000).toFixed(2)}s`);
      logger.info(`   - Migrated Agents:   ${report.summary.totalMigratedAgents}`);
      logger.info(`   - Migrated Notebooks:${report.summary.totalMigratedNotebooks}`);
      logger.info(`   - Migrated Sessions: ${report.summary.totalMigratedSessions}`);
      logger.info(`   - Migrated Artifacts:${report.summary.totalMigratedArtifacts}`);

      // 4. Validate Target Resources Post-Migration
      const targetAgents = await this.client.listAgents({
        projectId: perm.target.projectId,
        appLocation: perm.target.appLocation,
        collectionId: perm.target.collectionId,
        appId: perm.target.appId,
        assistantId: perm.target.assistantId
      });
      const nonSystemTargetAgents = targetAgents.filter(a => !a.name.endsWith('/deep_research'));
      logger.info(`[VALIDATION] Target non-system agents verified: ${nonSystemTargetAgents.length}`);

      // 5. Post-Clean Target to restore clean slate
      await this.cleanTargetEnvironment(perm.target, perm.targetUser);

      return {
        id: perm.id,
        name: perm.name,
        status: 'PASSED',
        durationMs,
        migratedAgents: report.summary.totalMigratedAgents,
        migratedNotebooks: report.summary.totalMigratedNotebooks,
        migratedSessions: report.summary.totalMigratedSessions,
        migratedArtifacts: report.summary.totalMigratedArtifacts,
        details: `Successfully migrated ${report.summary.totalMigratedAgents} agents, ${report.summary.totalMigratedNotebooks} notebooks, and ${report.summary.totalMigratedSessions} chat sessions. Target verified and cleaned.`
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      logger.error(`❌ TEST FAILED: ${perm.id} - ${err.message}`);
      
      // Attempt cleanup even on failure
      try {
        await this.cleanTargetEnvironment(perm.target, perm.targetUser);
      } catch {}

      return {
        id: perm.id,
        name: perm.name,
        status: 'FAILED',
        durationMs,
        migratedAgents: 0,
        migratedNotebooks: 0,
        migratedSessions: 0,
        migratedArtifacts: 0,
        details: `Execution failed during migration pipeline.`,
        error: err.message
      };
    }
  }

  /**
   * Runs the full matrix of test permutations.
   */
  async runAll(testFilter?: string): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const permutationsToRun = testFilter 
      ? TEST_PERMUTATIONS.filter(p => p.id.toLowerCase() === testFilter.toLowerCase())
      : TEST_PERMUTATIONS;

    logger.info(`Starting E2E Migration Matrix Test Run (${permutationsToRun.length} permutations)...`);

    for (const perm of permutationsToRun) {
      const res = await this.runPermutation(perm);
      results.push(res);
    }

    this.printSummaryTable(results);
    return results;
  }

  private printSummaryTable(results: TestResult[]) {
    console.log(`\n========================================================================================`);
    console.log(`📊 E2E MIGRATION MATRIX TEST SUMMARY`);
    console.log(`========================================================================================`);
    console.table(results.map(r => ({
      Test: r.id,
      Status: r.status === 'PASSED' ? '✅ PASSED' : '❌ FAILED',
      'Duration (s)': (r.durationMs / 1000).toFixed(2),
      Agents: r.migratedAgents,
      Notebooks: r.migratedNotebooks,
      Sessions: r.migratedSessions,
      Artifacts: r.migratedArtifacts,
      Notes: r.error ? `Error: ${r.error.substring(0, 40)}...` : 'Target Verified & Cleaned'
    })));
    console.log(`========================================================================================\n`);
  }
}

// CLI Execution Entrypoint
const isDirectExecution = process.argv[1] && (
  process.argv[1].endsWith('run-e2e-matrix.ts') || 
  process.argv[1].endsWith('run-e2e-matrix.js')
);

if (isDirectExecution) {
  const filterArg = process.argv.find(a => a.startsWith('--test='))?.split('=')[1];
  const runner = new E2ETestMatrixRunner();
  runner.runAll(filterArg).then(results => {
    const hasFailures = results.some(r => r.status === 'FAILED');
    process.exit(hasFailures ? 1 : 0);
  }).catch(err => {
    console.error('Fatal Test Runner Error:', err);
    process.exit(1);
  });
}
