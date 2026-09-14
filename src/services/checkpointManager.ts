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
import { MigrationItemResult } from '../types/migration.js';
import { logger } from '../utils/logger.js';

export interface CheckpointData {
  migrationId: string;
  updatedAt: string;
  completedItems: MigrationItemResult[];
}

export class CheckpointManager {
  private checkpointFilePath: string;
  private migrationId: string;
  private completedMap: Map<string, MigrationItemResult> = new Map();

  constructor(outputDir: string, migrationId: string, customPath?: string) {
    this.migrationId = migrationId;
    if (customPath) {
      this.checkpointFilePath = path.resolve(process.cwd(), customPath);
    } else {
      const dir = path.resolve(process.cwd(), outputDir);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.checkpointFilePath = path.join(dir, `.checkpoint-${migrationId}.json`);
    }
  }

  public getFilePath(): string {
    return this.checkpointFilePath;
  }

  /**
   * Loads completed items from a previous checkpoint file or a migration report JSON.
   */
  public static load(filePath: string): Map<string, MigrationItemResult> {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    const resultMap = new Map<string, MigrationItemResult>();

    if (!fs.existsSync(resolvedPath)) {
      logger.warn(`[CHECKPOINT] File not found at: ${resolvedPath}`);
      return resultMap;
    }

    try {
      const content = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = JSON.parse(content);

      // Support either CheckpointData format or full MigrationReport format
      const items: MigrationItemResult[] = Array.isArray(parsed.completedItems)
        ? parsed.completedItems
        : Array.isArray(parsed.results)
          ? parsed.results
          : [];

      for (const item of items) {
        if (item.status === 'SUCCESS' || item.status === 'DRY_RUN') {
          resultMap.set(`${item.type}:${item.id}`, item);
        }
      }

      logger.info(`[CHECKPOINT] Loaded ${resultMap.size} previously completed item(s) from: ${resolvedPath}`);
    } catch (err: any) {
      logger.error(`[CHECKPOINT] Failed to parse checkpoint file: ${err.message}`);
    }

    return resultMap;
  }

  /**
   * Seeds the checkpoint manager with pre-existing completed items (e.g. from resumeFrom).
   */
  public seed(items: Map<string, MigrationItemResult>): void {
    for (const [key, val] of items.entries()) {
      this.completedMap.set(key, val);
    }
  }

  /**
   * Checks if an asset was already successfully migrated.
   */
  public has(type: string, id: string): boolean {
    return this.completedMap.has(`${type}:${id}`);
  }

  /**
   * Incrementally records a successful migration result and schedules disk persistence.
   */
  public recordSuccess(item: MigrationItemResult): void {
    if (item.status === 'SUCCESS' || item.status === 'DRY_RUN') {
      const key = `${item.type}:${item.id}`;
      this.completedMap.set(key, item);
      this.flushToDisk();
    }
  }

  /**
   * Records a batch of migration results.
   */
  public recordBatch(items: MigrationItemResult[]): void {
    let added = 0;
    for (const item of items) {
      if (item.status === 'SUCCESS' || item.status === 'DRY_RUN') {
        this.completedMap.set(`${item.type}:${item.id}`, item);
        added++;
      }
    }
    if (added > 0) {
      this.flushToDisk();
    }
  }

  public getCompletedItems(): MigrationItemResult[] {
    return Array.from(this.completedMap.values());
  }

  /**
   * Flushes current state immediately to disk.
   */
  public flushToDisk(): void {
    try {
      const data: CheckpointData = {
        migrationId: this.migrationId,
        updatedAt: new Date().toISOString(),
        completedItems: Array.from(this.completedMap.values())
      };
      const tmpPath = `${this.checkpointFilePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.checkpointFilePath);
    } catch (err: any) {
      logger.debug(`[CHECKPOINT] Failed to persist checkpoint: ${err.message}`);
    }
  }
}
