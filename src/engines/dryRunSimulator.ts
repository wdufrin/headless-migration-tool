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

import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { ValidatedMigrationConfig } from '../config/configSchema.js';
import { logger } from '../utils/logger.js';

export interface PreFlightCheckResult {
  passed: boolean;
  warnings: string[];
  errors: string[];
}

export class DryRunSimulator {
  private client: DiscoveryEngineClient;

  constructor(client: DiscoveryEngineClient) {
    this.client = client;
  }

  /**
   * Validates target project infrastructure, engine existence, and datastore mappings before execution.
   */
  async runPreFlightChecks(config: ValidatedMigrationConfig): Promise<PreFlightCheckResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    logger.info('Executing Pre-Flight Infrastructure Checks...');

    // 1. Check Target Engine
    try {
      logger.info(`Verifying target Engine "${config.target.appId}" in project "${config.target.projectId}"...`);
      const engine = await this.client.getEngine(config.target);
      logger.info(`Target Engine verified: "${engine.displayName || engine.name}"`);
    } catch (err: any) {
      errors.push(`Target Engine "${config.target.appId}" does not exist or is inaccessible in ${config.target.projectId}: ${err.message}`);
    }

    // 2. Check DataStores in Target Project
    try {
      logger.info(`Fetching target DataStores for project "${config.target.projectId}"...`);
      const targetDataStores = await this.client.listDataStores(config.target);
      const existingDsIds = new Set(targetDataStores.map(ds => ds.name.split('/').pop() || ''));

      for (const [sourceDsId, targetDsId] of Object.entries(config.datastoreMapping)) {
        if (!targetDsId) {
          warnings.push(`DataStore mapping for source "${sourceDsId}" is empty. Agents using this DataStore will skip this connection.`);
        } else if (!existingDsIds.has(targetDsId)) {
          warnings.push(`Target DataStore "${targetDsId}" (mapped from "${sourceDsId}") was not found in target project.`);
        }
      }
    } catch (err: any) {
      warnings.push(`Could not list target DataStores: ${err.message}`);
    }

    return {
      passed: errors.length === 0,
      warnings,
      errors
    };
  }
}
