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
import { GcpAuthService, isCredentialAutoloadDisabled } from '../services/gcpAuth.js';
import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { ValidatedMigrationConfig } from '../config/configSchema.js';
import { IdentityMappingService } from '../services/identityMappingService.js';
import { Memory, MemoryBackupSnapshot } from '../types/index.js';
import { logger } from '../utils/logger.js';

export class MemoryMigrator {
  private auth: GcpAuthService;
  private client: DiscoveryEngineClient;
  private config: ValidatedMigrationConfig;

  constructor(config: ValidatedMigrationConfig, authService?: GcpAuthService, client?: DiscoveryEngineClient) {
    this.config = config;
    this.auth = authService || new GcpAuthService();
    // `(this.auth as any).serviceAccountKeyPath` was always undefined -- GcpAuthService
    // has no such property -- so this guard never fired and the CWD key always won.
    // hasDwdConfigured() is the real accessor.
    if (
      !isCredentialAutoloadDisabled() &&
      !this.auth.hasDwdConfigured() &&
      fs.existsSync('./sa-dwd-key.json')
    ) {
      logger.debug('MemoryMigrator: auto-loading DWD key from ./sa-dwd-key.json');
      this.auth.setServiceAccountKey('./sa-dwd-key.json');
    }
    this.client = client || new DiscoveryEngineClient(this.auth);
  }

  /**
   * Resolves list of candidate user email accounts to scan for memories.
   */
  private resolveCandidateUsers(candidateUsers: string[] = []): string[] {
    const usersToScan = new Set<string>();
    const hasExplicitFilter = this.config.options?.userFilter && this.config.options.userFilter.length > 0 && !this.config.options.userFilter.includes('*') && !this.config.options.userFilter.includes('*@*');

    if (hasExplicitFilter) {
      for (const u of this.config.options!.userFilter!) {
        if (u && u.includes('@')) {
          usersToScan.add(u.replace(/^user:/i, '').trim());
        }
      }
    } else {
      for (const u of candidateUsers) {
        if (u && u.includes('@')) usersToScan.add(u.replace(/^user:/i, '').trim());
      }
      if (this.config.identityMapping) {
        for (const k of Object.keys(this.config.identityMapping)) {
          if (k && k.includes('@')) usersToScan.add(k.replace(/^user:/i, '').trim());
        }
      }
    }
    if (usersToScan.size === 0) {
      const defaultAdmin = process.env.ADMIN_EMAIL || process.env.DEFAULT_USER_EMAIL || '';
      if (defaultAdmin) usersToScan.add(defaultAdmin);
    }
    return Array.from(usersToScan);
  }

  /**
   * Lists all memories across candidate users in the source environment.
   */
  public async listSourceMemories(candidateUsers: string[] = []): Promise<Memory[]> {
    const env = this.config.source;
    const users = this.resolveCandidateUsers(candidateUsers);
    const allMemories: Memory[] = [];
    const seenMemoryNames = new Set<string>();
    const callerEmail = (await this.auth.getCallerIdentity?.()) || users[0] || (candidateUsers && candidateUsers[0]) || '';

    // 1. Scan default caller credentials / primary session
    try {
      const defaultMemories = await this.client.listMemories(env);
      for (const m of defaultMemories) {
        if (!seenMemoryNames.has(m.name)) {
          seenMemoryNames.add(m.name);
          if (!m.owner && callerEmail) {
            m.owner = callerEmail;
            m.userEmail = callerEmail;
            m.userPseudoId = callerEmail;
          }
          allMemories.push(m);
        }
      }
    } catch (err: any) {
      logger.debug(`Default source memory listing: ${err.message}`);
    }

    // 2. Scan per-user for impersonated/DWD domains
    for (const email of users) {
      if (callerEmail && email.toLowerCase() === callerEmail.toLowerCase()) {
        continue;
      }
      try {
        const userMemories = await this.client.listMemories(env, email);
        for (const m of userMemories) {
          if (!seenMemoryNames.has(m.name)) {
            seenMemoryNames.add(m.name);
            m.owner = email;
            m.userEmail = email;
            m.userPseudoId = email;
            allMemories.push(m);
          } else {
            // Update owner on previously seen memory if matching user
            const existing = allMemories.find(x => x.name === m.name);
            if (existing && (!existing.owner || existing.owner === 'default_user')) {
              existing.owner = email;
              existing.userEmail = email;
              existing.userPseudoId = email;
            }
          }
        }
      } catch (err: any) {
        logger.warn(`Could not list memories for user ${email} (${err.message}). Skipping user-scoped memory sync to prevent data bleed.`);
      }
    }

    // 3. Apply user filters if specified in migration options
    if (this.config.options?.userFilter && this.config.options.userFilter.length > 0) {
      const filters = this.config.options.userFilter.map(f => f.toLowerCase().trim());
      const hasWildcard = filters.includes('*') || filters.includes('*@*');
      if (!hasWildcard) {
        return allMemories.filter(m => {
          let owner = (m.owner || m.userEmail || m.userPseudoId || '').toLowerCase();
          if (!owner && callerEmail) {
            owner = callerEmail.toLowerCase();
          }
          if (!owner) return true; // Do not drop unassigned caller memories
          return filters.some(f => {
            if (f.startsWith('*@')) {
              const domain = f.replace('*@', '');
              return owner.endsWith('@' + domain);
            }
            return owner === f || owner === `user:${f}`;
          });
        });
      }
    }

    return allMemories;
  }

  /**
   * Lists memories in the target environment for a specific user or default caller.
   */
  public async listTargetMemories(userEmail?: string): Promise<Memory[]> {
    const env = this.config.target;
    return this.client.listMemories(env, userEmail);
  }

  /**
   * Migrates a single memory to the target environment.
   */
  public async migrateMemory(memory: Memory, targetUserOverride?: string): Promise<any> {
    const target = this.config.target;
    let targetUserId = targetUserOverride;

    if (!targetUserId) {
      const srcUser = memory.owner || memory.userEmail || memory.userPseudoId;
      const defaultUser = this.config.options?.userFilter?.[0]?.replace(/^.*\/subject\//i, '').replace(/^user:/i, '').trim();
      let cleanSrcUser = srcUser ? srcUser.replace(/^.*\/subject\//i, '').replace(/^user:/i, '').trim() : '';
      try { cleanSrcUser = decodeURIComponent(cleanSrcUser); } catch {}

      const mappedFromDict = IdentityMappingService.lookupTargetIdentity(cleanSrcUser || srcUser, this.config.identityMapping, '');
      if (mappedFromDict && mappedFromDict !== (cleanSrcUser || srcUser)) {
        targetUserId = mappedFromDict;
      } else if (cleanSrcUser && this.config.identityMapping?.[cleanSrcUser]) {
        targetUserId = this.config.identityMapping[cleanSrcUser];
      } else if (srcUser && this.config.identityMapping?.[srcUser]) {
        targetUserId = this.config.identityMapping[srcUser];
      } else if (cleanSrcUser && cleanSrcUser.includes('@')) {
        targetUserId = cleanSrcUser;
      } else if (defaultUser && defaultUser.includes('@')) {
        targetUserId = defaultUser;
      } else {
        targetUserId = process.env.DEFAULT_USER_EMAIL || process.env.ADMIN_EMAIL || undefined;
      }
    }

    if (!memory.fact || !memory.fact.trim()) {
      throw new Error(`Memory ${memory.name} has no valid fact content.`);
    }

    // Probe target memories to prevent duplicate memory generation on retry
    try {
      const existing = await this.listTargetMemories(targetUserId);
      const factMatch = existing.find(m => m.fact && m.fact.trim() === memory.fact.trim());
      if (factMatch) {
        logger.info(`Memory fact "${memory.fact.substring(0, 40)}..." already exists in target for ${targetUserId || 'default'}. Skipping duplicate.`);
        return factMatch;
      }
    } catch (probeErr: any) {
      logger.debug(`Could not probe target memories: ${probeErr.message}`);
    }

    const res = await this.client.generateMemories(target, memory.fact, targetUserId);
    logger.info(`Migrated memory fact "${memory.fact.substring(0, 40)}..." to target for ${targetUserId || 'default'}`);
    return res;
  }

  /**
   * Restores an array of memories into the target environment.
   */
  public async restoreMemories(
    memories: Memory[],
    targetUserOverride?: string
  ): Promise<{ total: number; successCount: number; failedCount: number; results: any[] }> {
    const results: any[] = [];
    let successCount = 0;
    let failedCount = 0;

    for (const mem of memories) {
      const factSummary = mem.fact ? mem.fact.substring(0, 50) : mem.name;
      try {
        const res = await this.migrateMemory(mem, targetUserOverride);
        successCount++;
        results.push({
          id: mem.name?.split('/').pop() || mem.name,
          fact: mem.fact,
          owner: mem.owner || mem.userEmail,
          status: 'SUCCESS',
          response: res
        });
      } catch (err: any) {
        failedCount++;
        logger.warn(`Failed to restore memory "${factSummary}": ${err.message}`);
        results.push({
          id: mem.name?.split('/').pop() || mem.name,
          fact: mem.fact,
          owner: mem.owner || mem.userEmail,
          status: 'FAILED',
          error: err.message
        });
      }
    }

    return { total: memories.length, successCount, failedCount, results };
  }

  /**
   * Exports all discovered source memories into a backup snapshot JSON file on disk.
   */
  public async exportAllMemoriesToDirectory(
    outputDir: string = './exports/memories',
    candidateUsers: string[] = []
  ): Promise<{ count: number; exportPath: string; memories: Memory[] }> {
    const resolvedDir = path.resolve(process.cwd(), outputDir);
    if (!fs.existsSync(resolvedDir)) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    }

    const memories = await this.listSourceMemories(candidateUsers);
    const usersSet = new Set<string>();
    for (const m of memories) {
      if (m.owner) usersSet.add(m.owner);
      if (m.userEmail) usersSet.add(m.userEmail);
    }
    const users = Array.from(usersSet);

    const snapshot: MemoryBackupSnapshot = {
      timestamp: new Date().toISOString(),
      sourceEnvironment: {
        projectId: this.config.source.projectId,
        appLocation: this.config.source.appLocation,
        collectionId: this.config.source.collectionId,
        appId: this.config.source.appId
      },
      total: memories.length,
      totalMemories: memories.length,
      totalUsers: users.length,
      users,
      memories
    };

    const fileName = `memories-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const exportPath = path.join(resolvedDir, fileName);
    fs.writeFileSync(exportPath, JSON.stringify(snapshot, null, 2), 'utf-8');

    // Also write a latest.json pointer
    const latestPath = path.join(resolvedDir, 'latest.json');
    fs.writeFileSync(latestPath, JSON.stringify(snapshot, null, 2), 'utf-8');

    // Write per-user backup files
    const usersDir = path.join(resolvedDir, 'users');
    if (!fs.existsSync(usersDir)) {
      fs.mkdirSync(usersDir, { recursive: true });
    }
    for (const u of users) {
      const userMems = memories.filter(m => m.owner === u || m.userEmail === u);
      const safeName = u.replace(/[^a-zA-Z0-9_-]/g, '_');
      const userFile = path.join(usersDir, `${safeName}.json`);
      fs.writeFileSync(userFile, JSON.stringify({
        user: u,
        timestamp: snapshot.timestamp,
        count: userMems.length,
        memories: userMems
      }, null, 2), 'utf-8');
    }

    logger.info(`Exported ${memories.length} user memories across ${users.length} users to ${exportPath}`);
    return { count: memories.length, exportPath, memories };
  }

  /**
   * Imports and restores memories from a JSON backup file.
   */
  public async importMemoriesFromFile(
    filePath: string,
    targetUserOverride?: string
  ): Promise<{ total: number; successCount: number; failedCount: number; results: any[] }> {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Memory backup file not found: ${resolvedPath}`);
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const data = JSON.parse(content);
    let memories: Memory[] = [];

    if (Array.isArray(data)) {
      memories = data;
    } else if (Array.isArray(data.memories)) {
      memories = data.memories;
    } else {
      throw new Error('Invalid memory backup format. Expected array of memories or snapshot object with "memories" key.');
    }

    return this.restoreMemories(memories, targetUserOverride);
  }

  /**
   * Deletes a memory from either target or source engine.
   */
  public async deleteMemory(memoryName: string, userEmail?: string, fromTarget: boolean = true): Promise<any> {
    const env = fromTarget ? this.config.target : this.config.source;
    return this.client.deleteMemory(memoryName, env, userEmail);
  }
}
