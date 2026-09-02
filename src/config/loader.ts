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

import * as fs from 'fs';
import * as path from 'path';
import { MigrationConfigSchema, ValidatedMigrationConfig } from './configSchema.js';
import { validateEnvironmentConfig } from '../security/validator.js';

export function loadConfigFile(filePath: string): ValidatedMigrationConfig {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Configuration file not found at: "${resolvedPath}"`);
  }

  const fileRaw = fs.readFileSync(resolvedPath, 'utf8');
  let parsedJson: any;
  try {
    parsedJson = JSON.parse(fileRaw);
  } catch (err: any) {
    throw new Error(`Failed to parse JSON in configuration file: ${err.message}`);
  }

  const validated = MigrationConfigSchema.parse(parsedJson);

  // Perform extra security checks
  validateEnvironmentConfig(validated.source, 'source');
  validateEnvironmentConfig(validated.target, 'target');

  return validated;
}

export function loadConfigFromEnv(): Partial<ValidatedMigrationConfig> {
  const sourceProject = process.env.SOURCE_PROJECT_ID;
  const sourceLocation = process.env.SOURCE_APP_LOCATION || 'global';
  const sourceApp = process.env.SOURCE_APP_ID;

  const targetProject = process.env.TARGET_PROJECT_ID;
  const targetLocation = process.env.TARGET_APP_LOCATION || 'global';
  const targetApp = process.env.TARGET_APP_ID;

  if (!sourceProject || !sourceApp || !targetProject || !targetApp) {
    return {};
  }

  return {
    source: {
      projectId: sourceProject,
      appLocation: sourceLocation,
      collectionId: process.env.SOURCE_COLLECTION_ID || 'default_collection',
      appId: sourceApp,
      assistantId: process.env.SOURCE_ASSISTANT_ID || 'default_assistant'
    },
    target: {
      projectId: targetProject,
      appLocation: targetLocation,
      collectionId: process.env.TARGET_COLLECTION_ID || 'default_collection',
      appId: targetApp,
      assistantId: process.env.TARGET_ASSISTANT_ID || 'default_assistant'
    },
    options: {
      migrateNotebooks: process.env.MIGRATE_NOTEBOOKS !== 'false',
      migrateAgents: process.env.MIGRATE_AGENTS !== 'false',
      migrateSessions: process.env.MIGRATE_SESSIONS !== 'false',
      migrateMemories: process.env.MIGRATE_MEMORIES !== 'false',
      migrateSkills: process.env.MIGRATE_SKILLS !== 'false',
      exportMemories: process.env.EXPORT_MEMORIES === 'true',
      exportArtifacts: process.env.EXPORT_ARTIFACTS !== 'false',
      agentTypes: (process.env.AGENT_TYPES?.split(',') as any) || ['ALL'],
      agentStatusFilter: (process.env.AGENT_STATUS_FILTER as any) || 'ALL',
      excludeDraftAgents: process.env.EXCLUDE_DRAFT_AGENTS === 'true',
      notebookIds: process.env.NOTEBOOK_IDS ? process.env.NOTEBOOK_IDS.split(',').map(s => s.trim()) : [],
      dryRun: process.env.DRY_RUN === 'true',
      concurrency: Number(process.env.CONCURRENCY) || 10,
      userFilter: process.env.USER_FILTER ? process.env.USER_FILTER.split(',').map(s => s.trim()) : [],
      preserveOwnership: process.env.PRESERVE_OWNERSHIP !== 'false',
      preserveSharing: process.env.PRESERVE_SHARING !== 'false',
      publishAgents: process.env.PUBLISH_AGENTS === 'true',
      prefixReplacements: {},
      allowOverwrite: process.env.ALLOW_OVERWRITE === 'true',
      resumeFrom: process.env.RESUME_FROM || undefined,
      skipIds: [],
      logLevel: (process.env.LOG_LEVEL as any) || 'INFO'
    }
  };
}
