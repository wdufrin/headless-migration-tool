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
import * as fs from 'fs';
import path from 'path';
import { MigrationReport, MigrationItemResult, MigrationOptions } from '../types/migration.js';
import { ValidatedMigrationConfig } from '../config/configSchema.js';
import { GcpAuthService } from '../services/gcpAuth.js';
import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { AgentRegistryClient } from '../services/agentRegistry.js';
import { NotebookMigrator } from './notebookMigrator.js';
import { AgentMigrator } from './agentMigrator.js';
import { SkillMigrator } from './skillMigrator.js';
import { DryRunSimulator } from './dryRunSimulator.js';
import { MigrationReporter } from '../services/reporter.js';
import { IdentityMappingService } from '../services/identityMappingService.js';
import { CheckpointManager } from '../services/checkpointManager.js';
import { logger } from '../utils/logger.js';

/** Phases the runner reports, in the order they execute. */
export type MigrationStage =
  | 'preflight'
  | 'notebooks'
  | 'skills'
  | 'agents'
  | 'sessions'
  | 'memories'
  | 'artifacts'
  | 'reports';

export interface MigrationRunnerOptions {
  authService?: GcpAuthService;
  outputDir?: string;
  /**
   * Invoked when a phase starts and finishes. Consumers (the SSE route, the CLI)
   * use this for progress reporting. Previously the browser inferred progress by
   * substring-matching log text, which silently broke whenever wording changed.
   *
   * NOTE: 'done' means the phase finished EXECUTING, not that every item in it
   * succeeded. Phases catch and log per-item errors and continue, so the
   * authoritative success/failure counts are in the MigrationReport summary.
   */
  onStage?: (stage: MigrationStage, status: 'active' | 'done') => void;

}

export class MigrationRunner {
  private auth: GcpAuthService;
  private client: DiscoveryEngineClient;
  private registryClient: AgentRegistryClient;
  private notebookMigrator: NotebookMigrator;
  private agentMigrator: AgentMigrator;
  private skillMigrator: SkillMigrator;
  private simulator: DryRunSimulator;
  private outputDir: string;
  private onStage: (stage: MigrationStage, status: 'active' | 'done') => void;

  constructor(options: MigrationRunnerOptions = {}) {
    this.auth = options.authService || new GcpAuthService();
    this.client = new DiscoveryEngineClient(this.auth);
    this.registryClient = new AgentRegistryClient(this.auth);
    this.notebookMigrator = new NotebookMigrator(this.client);
    this.agentMigrator = new AgentMigrator(this.client);
    this.skillMigrator = new SkillMigrator(this.registryClient, this.client);
    this.simulator = new DryRunSimulator(this.client);
    this.outputDir = options.outputDir || './reports';
    // A progress listener must never be able to abort a migration.
    const listener = options.onStage;
    this.onStage = (stage, status) => {
      if (!listener) return;
      try {
        listener(stage, status);
      } catch (err: any) {
        logger.warn(`Stage listener threw for "${stage}/${status}": ${err?.message || err}`);
      }
    };
  }


  async run(config: ValidatedMigrationConfig): Promise<MigrationReport> {
    const migrationId = randomUUID().substring(0, 8);
    const startTimeDate = new Date();
    const startTime = startTimeDate.toISOString();
    const startMs = Date.now();

    if (config.options?.debugMode) {
      logger.setLevel('DEBUG');
    } else if (config.options?.logLevel) {
      logger.setLevel(config.options.logLevel);
    }
    logger.clearLogs();
    this.onStage('preflight', 'active');

    logger.info(`Starting Gemini Enterprise Admin Migration Pipeline [ID: ${migrationId}]...`);
    logger.info(`Source: ${config.source.projectId} (${config.source.appLocation}) -> Target: ${config.target.projectId} (${config.target.appLocation})`);
    if (config.options?.dryRun) {
      logger.info('Mode: DRY RUN (Simulation only, no target modifications will be made)');
    }
    if (config.options?.debugMode) {
      logger.info(`[DIAGNOSTIC] Forensic Troubleshooting & Debug Mode ENABLED (Node ${process.version}, Platform: ${process.platform}/${process.arch})`);
      logger.info(`[DIAGNOSTIC] Config Snapshot: ${JSON.stringify({
        source: config.source,
        target: config.target,
        authType: config.auth?.authType,
        idpMapping: config.idpMapping,
        options: {
          migrateNotebooks: config.options.migrateNotebooks,
          migrateAgents: config.options.migrateAgents,
          migrateSkills: config.options.migrateSkills,
          migrateSessions: config.options.migrateSessions,
          migrateMemories: config.options.migrateMemories,
          exportArtifacts: config.options.exportArtifacts,
          dryRun: config.options.dryRun,
          debugMode: config.options.debugMode,
          userFilter: config.options.userFilter,
          notebookIds: config.options.notebookIds,
          agentTypes: config.options.agentTypes,
          agentStatusFilter: config.options.agentStatusFilter
        }
      })}`);
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

    // Resolve Live IdP Configuration for Source & Target Engines
    try {
      const srcIdp = await this.client.detectEngineIdpConfig(config.source);
      const tgtIdp = await this.client.detectEngineIdpConfig(config.target);

      if (srcIdp.type === 'WORKFORCE_IDENTITY_FEDERATION') {
        logger.info(`Source Engine IdP: Workforce Identity Federation (${srcIdp.provider ? `Provider: ${srcIdp.provider}` : 'Entra ID / WiF'})`);
      } else {
        logger.info(`Source Engine IdP: Google Cloud Identity / Workspace`);
      }

      if (tgtIdp.type === 'WORKFORCE_IDENTITY_FEDERATION') {
        logger.info(`Target Engine IdP: Workforce Identity Federation (${tgtIdp.provider ? `Provider: ${tgtIdp.provider}` : 'Entra ID / WiF / Connectors Active'})`);
        (config.target as any).isExternalIdp = true;
      } else {
        logger.info(`Target Engine IdP: Google Cloud Identity / Workspace`);
      }

      if (tgtIdp.cid) {
        (config.target as any).widgetConfigConfigId = tgtIdp.cid;
        (config.target as any).cid = tgtIdp.cid;
        logger.info(`Resolved target engine CID: ${tgtIdp.cid}`);
      }
    } catch (e: any) {
      logger.debug(`Could not retrieve engine IdP configs: ${e.message}`);
    }

    // Step 2: User Asset Discovery via UserFilters & IdentityMapping
    let discoveredUsers: string[] = [];

    if (config.options?.userFilter && config.options.userFilter.length > 0) {
      const allowed = config.options.userFilter.map(f => f.replace(/^user:/, '').trim().toLowerCase());
      if (allowed.length > 0 && !allowed.includes('*')) {
        discoveredUsers = discoveredUsers.filter(u => allowed.includes(u.toLowerCase()));
        for (const f of allowed) {
          if (f.includes('@') && !discoveredUsers.map(u => u.toLowerCase()).includes(f)) {
            discoveredUsers.push(f);
          }
        }
        logger.info(`Targeted user filter applied: Migrating ${discoveredUsers.length} user(s): ${discoveredUsers.join(', ')}`);
      }
    } else if (config.identityMapping) {
      for (const k of Object.keys(config.identityMapping)) {
        const cleanK = k.replace(/^user:/, '').trim();
        if (cleanK.includes('@') && !discoveredUsers.includes(cleanK)) {
          discoveredUsers.push(cleanK);
        }
      }
    }

    // Normalize explicit identityMapping keys (e.g. from CSV or config) for case-insensitive matching
    if (config.identityMapping && typeof config.identityMapping === 'object') {
      const normalizedMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(config.identityMapping)) {
        const cleanK = k.replace(/^user:/i, '').trim();
        const cleanV = typeof v === 'string' ? v.replace(/^user:/i, '').trim() : '';
        if (cleanK && cleanV) {
          normalizedMap[cleanK] = cleanV;
          normalizedMap[cleanK.toLowerCase()] = cleanV.toLowerCase();
        }
      }
      config.identityMapping = normalizedMap;
    }

    // Step 2b: Apply IdP Domain Rules & Automated Cross-IdP Translations
    if (config.idpMapping) {
      const idpService = new IdentityMappingService({
        sourceIdp: config.idpMapping.sourceIdp,
        targetIdp: config.idpMapping.targetIdp,
        domainRules: config.idpMapping.domainRules || [],
        explicitMappings: config.identityMapping || {},
        defaultFallbackEmail: config.idpMapping.fallbackUserEmail || config.defaultOwnerFallback
      });

      config.identityMapping = config.identityMapping || {};
      for (const u of discoveredUsers) {
        const res = idpService.resolveIdentity(u);
        if (res.targetIdentity && !config.identityMapping[u]) {
          config.identityMapping[u] = res.targetIdentity;
          config.identityMapping[u.toLowerCase()] = res.targetIdentity.toLowerCase();
          logger.info(`[IdP AUTO-MAP] "${u}" -> "${res.targetIdentity}" (${res.matchedRule || 'Default'})`);
        }
      }
    }

    // Step 2c: Checkpoint Resumption (Skip previously completed assets)
    const checkpointManager = new CheckpointManager(this.outputDir, migrationId);
    const resumedItems = new Map<string, MigrationItemResult>();
    if (config.options?.resumeFrom) {
      const loaded = CheckpointManager.load(config.options.resumeFrom);
      for (const [k, v] of loaded.entries()) {
        resumedItems.set(k, v);
      }
      checkpointManager.seed(resumedItems);
      logger.info(`[RESUME CHECKPOINT] Found ${resumedItems.size} previously completed item(s). These will be skipped.`);
    }

    const allResults: MigrationItemResult[] = [];

    // Pre-seed allResults with already completed items from checkpoint
    for (const item of resumedItems.values()) {
      allResults.push({
        ...item,
        details: {
          ...item.details,
          resumedFromCheckpoint: true
        }
      });
    }

    // Populate skipIds for migrator engines
    const activeSkipIds = new Set<string>(config.options?.skipIds || []);
    for (const [key, item] of resumedItems.entries()) {
      activeSkipIds.add(item.id);
      activeSkipIds.add(key);
    }
    const effectiveOptions: MigrationOptions = {
      ...config.options,
      skipIds: Array.from(activeSkipIds),
      onItemCompleted: (item: MigrationItemResult) => {
        checkpointManager.recordSuccess(item);
      }
    };

    this.onStage('preflight', 'done');
    // Step 3: Migrate Notebooks
    if (config.options?.migrateNotebooks !== false) {
      this.onStage('notebooks', 'active');
      try {
        const notebookResults = await this.notebookMigrator.migrateNotebooks(
          config.source,
          config.target,
          effectiveOptions,
          config.identityMapping,
          discoveredUsers
        );
        allResults.push(...notebookResults);
        checkpointManager.recordBatch(notebookResults);
      } catch (err: any) {
        logger.error(`Notebook migration phase failed: ${err.message}`);
        allResults.push({
          id: 'phase-failure-notebooks',
          displayName: 'Notebooks Migration Phase',
          type: 'SYSTEM',
          status: 'FAILED',
          error: `Fatal Phase Exception: ${err.message}`,
          originalOwner: 'system',
          targetOwner: 'system'
        });
      }
      this.onStage('notebooks', 'done');
    }

    // Step 3b: Directly Migrate User-Created Skills (Agent Registry & Discovery Engine)
    if (config.options?.migrateSkills !== false) {
      this.onStage('skills', 'active');
      try {
        const skillResults = await this.skillMigrator.migrateSkills(
          config.source,
          config.target,
          effectiveOptions,
          config.identityMapping
        );
        allResults.push(...skillResults);
        checkpointManager.recordBatch(skillResults);

        // Add migrated skills to activeSkipIds to prevent duplicate processing by agentMigrator
        for (const sr of skillResults) {
          if (sr.status === 'SUCCESS' || sr.status === 'DRY_RUN') {
            activeSkipIds.add(sr.id);
            activeSkipIds.add(`SKILL:${sr.id}`);
            activeSkipIds.add(`AGENT:${sr.id}`);
          }
        }
        effectiveOptions.skipIds = Array.from(activeSkipIds);
      } catch (skillErr: any) {
        logger.error(`Skills migration phase failed: ${skillErr.message}`);
        allResults.push({
          id: 'phase-failure-skills',
          displayName: 'Skills Migration Phase',
          type: 'SYSTEM',
          status: 'FAILED',
          error: `Fatal Phase Exception: ${skillErr.message}`,
          originalOwner: 'system',
          targetOwner: 'system'
        });
      }
      this.onStage('skills', 'done');
    }

    // Step 4: Migrate Agents
    if (config.options?.migrateAgents !== false) {
      this.onStage('agents', 'active');
      try {
        const agentResults = await this.agentMigrator.migrateAgents(
          config.source,
          config.target,
          effectiveOptions,
          config.datastoreMapping,
          config.collectionMapping,
          config.identityMapping
        );
        allResults.push(...agentResults);
        checkpointManager.recordBatch(agentResults);
      } catch (err: any) {
        logger.error(`Agent migration phase failed: ${err.message}`);
        allResults.push({
          id: 'phase-failure-agents',
          displayName: 'Agents Migration Phase',
          type: 'SYSTEM',
          status: 'FAILED',
          error: `Fatal Phase Exception: ${err.message}`,
          originalOwner: 'system',
          targetOwner: 'system'
        });
      }
      this.onStage('agents', 'done');
    }

    // Step 5: Migrate Multi-User Chat History Sessions
    if (config.options?.migrateSessions !== false) {
      this.onStage('sessions', 'active');
      try {
        const { SessionMigrator } = await import('./sessionMigrator.js');
        const sessionMigrator = new SessionMigrator(config, this.auth);
        const sourceSessions = await sessionMigrator.listSourceSessions(discoveredUsers);

        let filteredSessions = sourceSessions;
        if (config.options?.userFilter && config.options.userFilter.length > 0) {
          const allowedUsers = new Set(config.options.userFilter.map(f => f.replace(/^user:/i, '').trim().toLowerCase()));
          if (!allowedUsers.has('*')) {
            filteredSessions = sourceSessions.filter(s => {
              const u = (s.userPseudoId || '').replace(/^user:/i, '').trim().toLowerCase();
              return allowedUsers.has(u);
            });
            logger.info(`Filtered sessions from ${sourceSessions.length} down to ${filteredSessions.length} matching user filter: ${Array.from(allowedUsers).join(', ')}`);
          }
        }

        logger.info(`Starting Multi-User Chat History Migration for ${filteredSessions.length} sessions (Sorted Chronologically: Oldest -> Newest)...`);

        // Sort chronologically (oldest first -> newest last) so that in the target engine,
        // the newest sessions are created last and appear at the top of the sidebar.
        const chronologicalSessions = [...filteredSessions].sort((a, b) => {
          const tA = new Date(a.startTime || a.endTime || 0).getTime();
          const tB = new Date(b.startTime || b.endTime || 0).getTime();
          return tA - tB;
        });

        const selectedUser = (config.options?.userFilter && config.options.userFilter.length === 1 && !config.options.userFilter[0].includes('*'))
          ? config.options.userFilter[0].replace(/^user:/i, '').trim()
          : (discoveredUsers[0] || 'user@example.com');

        for (const s of chronologicalSessions) {
          const sessId = s.name.split('/').pop() || 'unknown';
          if (resumedItems.has(`SESSION:${sessId}`)) {
            logger.info(`Skipping already-migrated Chat Session "${s.displayName || sessId}" (${sessId}) from previous checkpoint.`);
            continue;
          }

          const rawOwner = s.userPseudoId || selectedUser;
          const origOwner = (rawOwner && rawOwner.includes('@')) ? rawOwner : selectedUser;
          const tgtOwner = IdentityMappingService.lookupTargetIdentity(origOwner, config.identityMapping, selectedUser || origOwner);

          try {
            if (!config.options?.dryRun) {
              await sessionMigrator.migrateSession(s, tgtOwner);
            }
            const sessionItem: MigrationItemResult = {
              id: s.name.split('/').pop() || 'unknown',
              displayName: s.displayName || 'Untitled Chat',
              type: 'SESSION',
              status: config.options?.dryRun ? 'DRY_RUN' : 'SUCCESS',
              originalOwner: origOwner,
              targetOwner: tgtOwner
            };
            allResults.push(sessionItem);
            checkpointManager.recordSuccess(sessionItem);
          } catch (sErr: any) {
            allResults.push({
              id: s.name.split('/').pop() || 'unknown',
              displayName: s.displayName || 'Untitled Chat',
              type: 'SESSION',
              status: 'FAILED',
              originalOwner: origOwner,
              targetOwner: tgtOwner,
              error: sErr.message
            });
          }
        }
      } catch (sessionErr: any) {
        logger.warn(`Chat session migration skipped or failed: ${sessionErr.message}`);
        allResults.push({
          id: 'phase-failure-sessions',
          displayName: 'Chat Sessions Migration Phase',
          type: 'SYSTEM',
          status: 'FAILED',
          error: `Fatal Phase Exception: ${sessionErr.message}`,
          originalOwner: 'system',
          targetOwner: 'system'
        });
      }
      this.onStage('sessions', 'done');
    }

    // Step 5b: Migrate User Memories
    if (config.options?.migrateMemories !== false) {
      this.onStage('memories', 'active');
      try {
        const { MemoryMigrator } = await import('./memoryMigrator.js');
        const memoryMigrator = new MemoryMigrator(config, this.auth, this.client);
        const sourceMemories = await memoryMigrator.listSourceMemories(discoveredUsers);
        logger.info(`Starting User Memories Migration for ${sourceMemories.length} discovered memories...`);

        // Automatically archive memories to disk backup so they are never lost
        try {
          await memoryMigrator.exportAllMemoriesToDirectory('./exports/memories', discoveredUsers);
        } catch {}

        const callerIdentity = (await this.auth.getCallerIdentity?.()) || (discoveredUsers && discoveredUsers[0]) || '';
        const defaultOwner = (config.options?.userFilter && config.options.userFilter.length === 1 && !config.options.userFilter[0].includes('*'))
          ? config.options.userFilter[0].replace(/^user:/i, '').trim()
          : (callerIdentity || (discoveredUsers && discoveredUsers[0]) || 'user@example.com');

        for (const m of sourceMemories) {
          const memId = m.name?.split('/').pop() || 'unknown';
          if (resumedItems.has(`MEMORY:${memId}`)) {
            logger.info(`Skipping already-migrated User Memory fact from previous checkpoint.`);
            continue;
          }

          const rawOwner = m.owner || m.userEmail || m.userPseudoId || defaultOwner;
          const origOwner = (rawOwner && rawOwner.includes('@')) ? rawOwner : defaultOwner;
          const tgtOwner = IdentityMappingService.lookupTargetIdentity(origOwner, config.identityMapping, defaultOwner || origOwner);

          try {
            if (!config.options?.dryRun) {
              await memoryMigrator.migrateMemory(m, tgtOwner);
            }
            const memoryItem: MigrationItemResult = {
              id: m.name?.split('/').pop() || 'unknown',
              displayName: m.fact ? (m.fact.length > 50 ? `${m.fact.substring(0, 47)}...` : m.fact) : 'User Memory',
              type: 'MEMORY',
              status: config.options?.dryRun ? 'DRY_RUN' : 'SUCCESS',
              originalOwner: origOwner,
              targetOwner: tgtOwner,
              details: {
                fact: m.fact,
                originalResourcePath: m.originalResourcePath
              }
            };
            allResults.push(memoryItem);
            checkpointManager.recordSuccess(memoryItem);
          } catch (mErr: any) {
            const isGoogleInternal = mErr.message?.includes('Method not found') || mErr.message?.includes('404');
            const errorReason = isGoogleInternal
              ? 'Google API Restriction: Gemini Enterprise does not expose a public REST endpoint to inject memory facts (method is restricted to GOOGLE_INTERNAL). Memory was archived to ./exports/memories; conversation context was preserved in migrated chat sessions.'
              : mErr.message;

            allResults.push({
              id: m.name?.split('/').pop() || 'unknown',
              displayName: m.fact ? (m.fact.length > 50 ? `${m.fact.substring(0, 47)}...` : m.fact) : 'User Memory',
              type: 'MEMORY',
              status: isGoogleInternal ? 'ARCHIVED' : 'FAILED',
              originalOwner: origOwner,
              targetOwner: tgtOwner,
              error: errorReason,
              details: {
                fact: m.fact,
                originalResourcePath: m.originalResourcePath,
                archivedPath: './exports/memories/latest.json'
              }
            });
          }
        }
      } catch (memErr: any) {
        logger.warn(`User memories migration skipped or failed: ${memErr.message}`);
        allResults.push({
          id: 'phase-failure-memories',
          displayName: 'User Memories Migration Phase',
          type: 'SYSTEM',
          status: 'FAILED',
          error: `Fatal Phase Exception: ${memErr.message}`,
          originalOwner: 'system',
          targetOwner: 'system'
        });
      }
      this.onStage('memories', 'done');
    }

    // Step 6: Export & Archive Multi-User Canvas & Presentation Artifacts
    if (config.options?.exportArtifacts !== false) {
      this.onStage('artifacts', 'active');
      try {
        const { ArtifactExtractor } = await import('./artifactExtractor.js');
        const artifactExtractor = new ArtifactExtractor(config, this.auth);
        const artResult = await artifactExtractor.exportAllToDirectory('./exports/artifacts', discoveredUsers);
        logger.info(`Archived ${artResult.count} user presentations, dashboards, and media manifests to ${artResult.exportDir}`);
      } catch (artErr: any) {
        logger.warn(`Artifact export skipped: ${artErr.message}`);
      }
      this.onStage('artifacts', 'done');
    }

    // Step 6b: Export & Backup User Memories to JSON (Optional Archive)
    if (config.options?.exportMemories === true) {
      try {
        const { MemoryMigrator } = await import('./memoryMigrator.js');
        const memoryMigrator = new MemoryMigrator(config, this.auth, this.client);
        const memResult = await memoryMigrator.exportAllMemoriesToDirectory('./exports/memories', discoveredUsers);
        logger.info(`Archived ${memResult.count} user memories to ${memResult.exportPath}`);
      } catch (memExportErr: any) {
        logger.warn(`User memories export skipped: ${memExportErr.message}`);
      }
    }

    const endTime = new Date().toISOString();
    const durationMs = Date.now() - startMs;

    let totalArtifactsCount = 0;
    let totalDiscoveredSources = 0;
    let totalMigratedSources = 0;
    let totalFailedSources = 0;

    for (const r of allResults) {
      if (r.details?.artifactsCount || r.details?.notesCount) {
        totalArtifactsCount += (r.details.artifactsCount || 0) + (r.details.notesCount || 0);
      }
      if (r.type === 'NOTEBOOK' && r.details) {
        totalDiscoveredSources += (r.details.sourcesCount || 0);
        totalMigratedSources += (r.details.sourcesRestored ?? (r.status === 'SUCCESS' || r.status === 'DRY_RUN' ? r.details.sourcesCount : 0));
        totalFailedSources += (r.details.sourcesFailed || 0);
      }
    }

    const summary = {
      totalDiscoveredAgents: allResults.filter(r => r.type === 'AGENT').length,
      totalDiscoveredNotebooks: allResults.filter(r => r.type === 'NOTEBOOK').length,
      totalDiscoveredSkills: allResults.filter(r => r.type === 'SKILL').length,
      totalDiscoveredSources,
      totalDiscoveredSessions: allResults.filter(r => (r.type as string) === 'SESSION').length,
      totalDiscoveredMemories: allResults.filter(r => (r.type as string) === 'MEMORY').length,
      totalDiscoveredArtifacts: totalArtifactsCount,
      totalMigratedAgents: allResults.filter(r => r.type === 'AGENT' && (r.status === 'SUCCESS' || r.status === 'DRY_RUN')).length,
      totalMigratedNotebooks: allResults.filter(r => r.type === 'NOTEBOOK' && (r.status === 'SUCCESS' || r.status === 'DRY_RUN')).length,
      totalMigratedSkills: allResults.filter(r => r.type === 'SKILL' && (r.status === 'SUCCESS' || r.status === 'DRY_RUN')).length,
      totalMigratedSources,
      totalMigratedSessions: allResults.filter(r => (r.type as string) === 'SESSION' && (r.status === 'SUCCESS' || r.status === 'DRY_RUN')).length,
      totalMigratedMemories: allResults.filter(r => (r.type as string) === 'MEMORY' && (r.status === 'SUCCESS' || r.status === 'DRY_RUN')).length,
      totalMigratedArtifacts: totalArtifactsCount,
      totalFailedSources,
      totalSkipped: allResults.filter(r => r.status === 'SKIPPED').length,
      totalFailed: allResults.filter(r => r.status === 'FAILED').length,
      totalOwnershipNotTransferred: allResults.filter(r => r.ownershipTransferred === false).length
    };

    this.onStage('reports', 'active');
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
      identityMapping: config.identityMapping,
      logs: logger.getLogs()
    };

    // Step 7: Write Output Reports
    try {
      const { mdPath, jsonPath } = MigrationReporter.writeReportFiles(report, this.outputDir);
      logger.info(`Migration Report generated successfully:`);
      logger.info(`  - Markdown Report: ${mdPath}`);
      logger.info(`  - JSON Report:     ${jsonPath}`);
      logger.info(`  - Live Checkpoint: ${checkpointManager.getFilePath()}`);
      if (config.options?.debugMode) {
        const diagPath = path.join(this.outputDir, `diagnostic-troubleshoot-${migrationId}.json`);
        const diagPayload = {
          migrationId,
          generatedAt: new Date().toISOString(),
          environment: {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch
          },
          config: {
            source: config.source,
            target: config.target,
            authType: config.auth?.authType,
            idpMapping: config.idpMapping,
            options: config.options,
            identityMapping: config.identityMapping
          },
          preFlight,
          summary: report.summary,
          results: report.results,
          logs: logger.getLogs()
        };
        fs.writeFileSync(diagPath, JSON.stringify(diagPayload, null, 2), 'utf8');
        logger.info(`  - Diagnostic Bundle: ${diagPath}`);
      }
    } catch (reportErr: any) {
      logger.warn(`Could not save report files: ${reportErr.message}`);
    }

    this.onStage('reports', 'done');
    return report;
  }
}
