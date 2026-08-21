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

import express from 'express';
import fs from 'fs';
import path from 'path';
import { ValidatedMigrationConfig } from '../config/configSchema.js';

export function getDynamicConfig(req: express.Request): ValidatedMigrationConfig {
  const query = (req.query || {}) as Record<string, string>;
  const body = (req.body || {}) as Record<string, any>;

  const srcProjectId = body.srcProjectId || body.source?.projectId || query.srcProjectId || process.env.SOURCE_PROJECT_ID || '';
  const srcLocation = body.srcLocation || body.source?.appLocation || query.srcLocation || process.env.SOURCE_LOCATION || 'global';
  const srcCollectionId = body.srcCollectionId || body.source?.collectionId || query.srcCollectionId || process.env.SOURCE_COLLECTION_ID || 'default_collection';
  const srcAppId = body.srcAppId || body.source?.appId || query.srcAppId || process.env.SOURCE_APP_ID || '';

  const tgtProjectId = body.tgtProjectId || body.target?.projectId || query.tgtProjectId || process.env.TARGET_PROJECT_ID || '';
  const tgtLocation = body.tgtLocation || body.target?.appLocation || query.tgtLocation || process.env.TARGET_LOCATION || 'global';
  const tgtCollectionId = body.tgtCollectionId || body.target?.collectionId || query.tgtCollectionId || process.env.TARGET_COLLECTION_ID || 'default_collection';
  const tgtAppId = body.tgtAppId || body.target?.appId || query.tgtAppId || process.env.TARGET_APP_ID || '';

  let baseConfig: any = {};
  const configPath = path.resolve(process.cwd(), 'config.example.json');
  if (fs.existsSync(configPath)) {
    try {
      baseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {}
  }

  return {
    source: {
      projectId: srcProjectId,
      appLocation: srcLocation,
      collectionId: srcCollectionId,
      appId: srcAppId,
      assistantId: 'default_assistant'
    },
    target: {
      projectId: tgtProjectId,
      appLocation: tgtLocation,
      collectionId: tgtCollectionId,
      appId: tgtAppId,
      assistantId: 'default_assistant'
    },
    options: {
      ...baseConfig.options,
      ...(body.options || {})
    },
    datastoreMapping: baseConfig.datastoreMapping || {},
    collectionMapping: baseConfig.collectionMapping || {},
    identityMapping: baseConfig.identityMapping || {}
  } as ValidatedMigrationConfig;
}
