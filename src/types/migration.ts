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

import { Agent, Notebook, Memory } from './index.js';

export interface EnvironmentConfig {
  projectId: string;
  appLocation: string;
  collectionId?: string;
  appId: string;
  assistantId?: string;
}

export interface MigrationOptions {
  migrateNotebooks?: boolean;
  migrateAgents?: boolean;
  migrateSessions?: boolean;
  migrateMemories?: boolean;
  exportMemories?: boolean;
  exportArtifacts?: boolean;
  agentTypes?: ('LOW_CODE' | 'WORKFLOW' | 'ADK' | 'A2A' | 'OTHER' | 'ALL')[];
  agentStatusFilter?: 'ALL' | 'PUBLISHED_ONLY' | 'DRAFTS_ONLY';
  excludeDraftAgents?: boolean;
  notebookIds?: string[];
  dryRun?: boolean;
  concurrency?: number;
  userFilter?: string[];
  preserveOwnership?: boolean;
  preserveSharing?: boolean;
  publishAgents?: boolean;
  prefixReplacements?: Record<string, string>;
  allowOverwrite?: boolean;
  logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
}

export interface MigrationConfig {
  source: EnvironmentConfig;
  target: EnvironmentConfig;
  options?: MigrationOptions;
  datastoreMapping?: Record<string, string>;
  collectionMapping?: Record<string, string>;
  identityMapping?: Record<string, string>;
  defaultOwnerFallback?: string;
}

export interface MigrationItemResult {
  id: string;
  displayName: string;
  type: 'AGENT' | 'NOTEBOOK' | 'SESSION' | 'MEMORY' | 'ARTIFACT';
  status: 'SUCCESS' | 'SKIPPED' | 'FAILED' | 'DRY_RUN' | 'ARCHIVED';
  originalOwner?: string;
  targetOwner?: string;
  targetId?: string;
  error?: string;
  details?: Record<string, any>;
  durationMs?: number;
}

export interface MigratedSourceItem {
  title: string;
  sourceId?: string;
  type: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'DRY_RUN';
  error?: string;
}

export interface MigrationReport {
  migrationId: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  dryRun: boolean;
  sourceEnvironment: EnvironmentConfig;
  targetEnvironment: EnvironmentConfig;
  summary: {
    totalDiscoveredAgents: number;
    totalDiscoveredNotebooks: number;
    totalDiscoveredSources?: number;
    totalDiscoveredSessions?: number;
    totalDiscoveredMemories?: number;
    totalDiscoveredArtifacts?: number;
    totalMigratedAgents: number;
    totalMigratedNotebooks: number;
    totalMigratedSources?: number;
    totalMigratedSessions?: number;
    totalMigratedMemories?: number;
    totalMigratedArtifacts?: number;
    totalFailedSources?: number;
    totalSkipped: number;
    totalFailed: number;
  };
  results: MigrationItemResult[];
  discoveredUsers: string[];
  logs: string[];
}
