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
import { MemoryMigrator } from '../engines/memoryMigrator.js';
import { getDynamicConfig } from './configHelper.js';
import { GcpAuthService } from '../services/gcpAuth.js';
import { logger } from '../utils/logger.js';

export const memoriesRouter = express.Router();

// List source memories
memoriesRouter.get('/memories/list-source', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const authService = new GcpAuthService({ staticToken: req.accessToken });
    const migrator = new MemoryMigrator(config, authService);

    const userEmail = (req.query.userEmail as string) || (req.query.user as string);
    const candidateUsers = userEmail ? [userEmail] : [];

    const memories = await migrator.listSourceMemories(candidateUsers);
    return res.status(200).json({
      memories,
      total: memories.length,
      sourceProject: config.source.projectId,
      sourceApp: config.source.appId
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'ListSourceMemoriesFailed', message: err.message });
  }
});

// List target memories
memoriesRouter.get('/memories/list-target', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const authService = new GcpAuthService({ staticToken: req.accessToken });
    const migrator = new MemoryMigrator(config, authService);

    const userEmail = (req.query.userEmail as string) || (req.query.user as string);
    const memories = await migrator.listTargetMemories(userEmail);
    return res.status(200).json({
      memories,
      total: memories.length,
      targetProject: config.target.projectId,
      targetApp: config.target.appId
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'ListTargetMemoriesFailed', message: err.message });
  }
});

// Backup / Export all memories to file
memoriesRouter.post('/memories/backup', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const authService = new GcpAuthService({ staticToken: req.accessToken });
    const migrator = new MemoryMigrator(config, authService);

    const outputDir = req.body?.outputDir || './exports/memories';
    const candidateUsers = req.body?.candidateUsers || (req.body?.userEmail ? [req.body.userEmail] : []);

    const result = await migrator.exportAllMemoriesToDirectory(outputDir, candidateUsers);
    return res.status(200).json({
      success: true,
      count: result.count,
      exportPath: result.exportPath,
      memories: result.memories
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'MemoryBackupFailed', message: err.message });
  }
});

// Restore memories from memory list or backup file
memoriesRouter.post('/memories/restore', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const authService = new GcpAuthService({ staticToken: req.accessToken });
    const migrator = new MemoryMigrator(config, authService);

    const { filePath, memories, targetUser } = req.body;

    if (filePath) {
      const result = await migrator.importMemoriesFromFile(filePath, targetUser);
      return res.status(200).json({ success: true, ...result });
    } else if (Array.isArray(memories)) {
      const result = await migrator.restoreMemories(memories, targetUser);
      return res.status(200).json({ success: true, ...result });
    } else {
      return res.status(400).json({
        error: 'InvalidRequest',
        message: 'Must specify either "memories" array or "filePath" to backup file.'
      });
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'MemoryRestoreFailed', message: err.message });
  }
});

// Migrate specific or all memories directly from source to target
memoriesRouter.post('/memories/migrate', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const authService = new GcpAuthService({ staticToken: req.accessToken });
    const migrator = new MemoryMigrator(config, authService);

    const { memory, all, userEmail, targetUser } = req.body;

    if (all) {
      const candidateUsers = userEmail ? [userEmail] : [];
      const srcMemories = await migrator.listSourceMemories(candidateUsers);
      const result = await migrator.restoreMemories(srcMemories, targetUser);
      return res.status(200).json({ success: true, ...result });
    } else if (memory) {
      const resData = await migrator.migrateMemory(memory, targetUser);
      return res.status(200).json({ success: true, memory: resData });
    } else {
      return res.status(400).json({ error: 'InvalidRequest', message: 'Must specify memory or all=true' });
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'MigrateMemoriesFailed', message: err.message });
  }
});

// Delete a memory
memoriesRouter.post('/memories/delete', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const authService = new GcpAuthService({ staticToken: req.accessToken });
    const migrator = new MemoryMigrator(config, authService);

    const { memoryName, fromTarget, userEmail } = req.body;
    if (!memoryName) {
      return res.status(400).json({ error: 'MissingMemoryName', message: 'memoryName is required' });
    }

    await migrator.deleteMemory(memoryName, userEmail, fromTarget !== false);
    return res.status(200).json({ success: true, memoryName });
  } catch (err: any) {
    return res.status(500).json({ error: 'DeleteMemoryFailed', message: err.message });
  }
});

// Generate / create a new memory fact directly
memoriesRouter.post('/memories/generate', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const authService = new GcpAuthService({ staticToken: req.accessToken });
    const migrator = new MemoryMigrator(config, authService);

    const { text, targetUser, targetEnv } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'MissingText', message: 'text is required to generate a memory fact' });
    }

    const target = targetEnv === 'source' ? config.source : config.target;
    const client = (migrator as any).client;
    const result = await client.generateMemories(target, text, targetUser);
    return res.status(200).json({ success: true, result });
  } catch (err: any) {
    return res.status(500).json({ error: 'GenerateMemoryFailed', message: err.message });
  }
});
