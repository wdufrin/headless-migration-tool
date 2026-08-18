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

import { randomUUID } from 'crypto';
import { ValidatedMigrationConfig } from '../config/configSchema.js';
import { MigrationReport, MigrationItemResult } from '../types/migration.js';
import { GcpAuthService } from '../services/gcpAuth.js';
import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { BigQueryDiscoveryService } from '../services/bigQueryDiscovery.js';
import { NotebookMigrator } from './notebookMigrator.js';
import { AgentMigrator } from './agentMigrator.js';
import { DryRunSimulator } from './dryRunSimulator.js';
import { MigrationReporter } from '../services/reporter.js';
import { logger } from '../utils/logger.js';

export interface MigrationRunnerOptions {
  authService?: GcpAuthService;
  outputDir?: string;
}

export class MigrationRunner {
  private auth: GcpAuthService;
  private client: DiscoveryEngineClient;
  private bqDiscovery: BigQueryDiscoveryService;
  private notebookMigrator: NotebookMigrator;
  private agentMigrator: AgentMigrator;
  private simulator: DryRunSimulator;
  private outputDir: string;

  constructor(options: MigrationRunnerOptions = {}) {
    this.auth = options.authService || new GcpAuthService();
    this.client = new DiscoveryEngineClient(this.auth);
    this.bqDiscovery = new BigQueryDiscoveryService(this.auth);
    this.notebookMigrator = new NotebookMigrator(this.client);
    this.agentMigrator = new AgentMigrator(this.client);
    this.simulator = new DryRunSimulator(this.client);
    this.outputDir = options.outputDir || './reports';
  }

  async run(config: ValidatedMigrationConfig): Promise<MigrationReport> {
    const migrationId = randomUUID().substring(0, 8);
    const startTimeDate = new Date();
    const startTime = startTimeDate.toISOString();
    const startMs = Date.now();

    if (config.options?.logLevel) {
      logger.setLevel(config.options.logLevel);
    }
    logger.clearLogs();

    logger.info(`Starting Gemini Enterprise Admin Migration Pipeline [ID: ${migrationId}]...`);
    logger.info(`Source: ${config.source.projectId} (${config.source.appLocation}) -> Target: ${config.target.projectId} (${config.target.appLocation})`);
    if (config.options?.dryRun) {
      logger.info('Mode: DRY RUN (Simulation only, no target modifications will be made)');
    }

    // Step 1: Pre-Flight Health Check
    const preFlight = await this.simulator.runPreFlightChecks(config);
    for (const w of preFlight.warnings) {
      logger.warn(`[PRE-FLIGHT WARNING] ${w}`);
    }
    if (!preFlight.passed) {
      for (const e of preFlight.errors) {
        logger.error(`[PRE-FLIGHT ERROR] ${e}`);
      }
      if (!config.options?.dryRun) {
        throw new Error(`Pre-flight checks failed with ${preFlight.errors.length} error(s). Aborting migration.`);
      }
    }

    // Resolve Target Engine CID for accurate web gallery links
    try {
      const targetEngine = await this.client.getEngine(config.target);
      if (targetEngine?.widgetConfigConfigId) {
        (config.target as any).widgetConfigConfigId = targetEngine.widgetConfigConfigId;
        (config.target as any).cid = targetEngine.widgetConfigConfigId;
        logger.info(`Resolved target engine CID: ${targetEngine.widgetConfigConfigId}`);
      }
    } catch (e: any) {
      logger.debug(`Could not retrieve target engine CID: ${e.message}`);
    }

    // Step 2: User Asset Discovery via BigQuery (Best Effort)
    const discoveredUsers: string[] = [];
    try {
      const bqUsers = await this.bqDiscovery.discoverUsersFromBigQuery(config.source.projectId);
      for (const u of bqUsers) {
        if (u.userEmail && u.userEmail !== 'unknown') {
          discoveredUsers.push(u.userEmail);
        }
      }
      if (discoveredUsers.length > 0) {
        logger.info(`Discovered ${discoveredUsers.length} active users from BigQuery audit telemetry.`);
      }
    } catch (bqErr: any) {
      logger.debug(`BigQuery discovery skipped: ${bqErr.message}`);
    }

    const allResults: MigrationItemResult[] = [];

    // Step 3: Migrate Notebooks
    if (config.options?.migrateNotebooks !== false) {
      try {
        const notebookResults = await this.notebookMigrator.migrateNotebooks(
          config.source,
          config.target,
          config.options,
          config.identityMapping
        );
        allResults.push(...notebookResults);
      } catch (err: any) {
        logger.error(`Notebook migration phase failed: ${err.message}`);
      }
    }

    // Step 4: Migrate Agents
    if (config.options?.migrateAgents !== false) {
      try {
        const agentResults = await this.agentMigrator.migrateAgents(
          config.source,
          config.target,
          config.options,
          config.datastoreMapping,
          config.collectionMapping,
          config.identityMapping
        );
        allResults.push(...agentResults);
      } catch (err: any) {
        logger.error(`Agent migration phase failed: ${err.message}`);
      }
    }

    // Step 5: Migrate Multi-User Chat History Sessions
    if (config.options?.migrateSessions !== false) {
      try {
        const { SessionMigrator } = await import('./sessionMigrator.js');
        const sessionMigrator = new SessionMigrator(config, this.auth);
        const sourceSessions = await sessionMigrator.listSourceSessions();
        logger.info(`Starting Multi-User Chat History Migration for ${sourceSessions.length} sessions (Sorted Chronologically: Oldest -> Newest)...`);

        // Sort chronologically (oldest first -> newest last) so that in the target engine,
        // the newest sessions are created last and appear at the top of the sidebar.
        const chronologicalSessions = [...sourceSessions].sort((a, b) => {
          const tA = new Date(a.startTime || a.endTime || 0).getTime();
          const tB = new Date(b.startTime || b.endTime || 0).getTime();
          return tA - tB;
        });

        for (const s of chronologicalSessions) {
          try {
            if (!config.options?.dryRun) {
              await sessionMigrator.migrateSession(s);
            }
            allResults.push({
              id: s.name.split('/').pop() || 'unknown',
              displayName: s.displayName || 'Untitled Chat',
              type: 'SESSION',
              status: config.options?.dryRun ? 'DRY_RUN' : 'SUCCESS',
              originalOwner: s.userPseudoId
            });
          } catch (sErr: any) {
            allResults.push({
              id: s.name.split('/').pop() || 'unknown',
              displayName: s.displayName || 'Untitled Chat',
              type: 'SESSION',
              status: 'FAILED',
              originalOwner: s.userPseudoId,
              error: sErr.message
            });
          }
        }
      } catch (sessionErr: any) {
        logger.warn(`Chat session migration skipped or failed: ${sessionErr.message}`);
      }
    }

    // Step 6: Export & Archive Multi-User Canvas & Presentation Artifacts
    if (config.options?.exportArtifacts !== false) {
      try {
        const { ArtifactExtractor } = await import('./artifactExtractor.js');
        const artifactExtractor = new ArtifactExtractor(config);
        const artResult = await artifactExtractor.exportAllToDirectory('./exports/artifacts');
        logger.info(`Archived ${artResult.count} user presentations, dashboards, and media manifests to ${artResult.exportDir}`);
      } catch (artErr: any) {
        logger.warn(`Artifact export skipped: ${artErr.message}`);
      }
    }

    const endTime = new Date().toISOString();
    const durationMs = Date.now() - startMs;

    const summary = {
      totalDiscoveredAgents: allResults.filter(r => r.type === 'AGENT').length,
      totalDiscoveredNotebooks: allResults.filter(r => r.type === 'NOTEBOOK').length,
      totalDiscoveredSessions: allResults.filter(r => (r.type as string) === 'SESSION').length,
      totalMigratedAgents: allResults.filter(r => r.type === 'AGENT' && (r.status === 'SUCCESS' || r.status === 'DRY_RUN')).length,
      totalMigratedNotebooks: allResults.filter(r => r.type === 'NOTEBOOK' && (r.status === 'SUCCESS' || r.status === 'DRY_RUN')).length,
      totalMigratedSessions: allResults.filter(r => (r.type as string) === 'SESSION' && (r.status === 'SUCCESS' || r.status === 'DRY_RUN')).length,
      totalSkipped: allResults.filter(r => r.status === 'SKIPPED').length,
      totalFailed: allResults.filter(r => r.status === 'FAILED').length
    };

    const report: MigrationReport = {
      migrationId,
      startTime,
      endTime,
      durationMs,
      dryRun: !!config.options?.dryRun,
      sourceEnvironment: config.source,
      targetEnvironment: config.target,
      summary,
      results: allResults,
      discoveredUsers,
      logs: logger.getLogs()
    };

    // Step 7: Write Output Reports
    try {
      const { mdPath, jsonPath } = MigrationReporter.writeReportFiles(report, this.outputDir);
      logger.info(`Migration Report generated successfully:`);
      logger.info(`  - Markdown Report: ${mdPath}`);
      logger.info(`  - JSON Report:     ${jsonPath}`);
    } catch (reportErr: any) {
      logger.warn(`Could not save report files: ${reportErr.message}`);
    }

    return report;
  }
}
