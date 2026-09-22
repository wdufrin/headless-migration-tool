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
import { SessionMigrator } from '../engines/sessionMigrator.js';
import { getDynamicConfig } from './configHelper.js';

export const sessionsRouter = express.Router();

interface ArtifactCacheEntry {
  artifacts: any[];
  timestamp: number;
}
const projectArtifactCache = new Map<string, ArtifactCacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// Chat Sessions Endpoints
sessionsRouter.get('/sessions/list-source', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const migrator = new SessionMigrator(config);
    const sessions = await migrator.listSourceSessions();
    return res.status(200).json({ sessions, sourceProject: config.source.projectId, sourceApp: config.source.appId });
  } catch (err: any) {
    return res.status(500).json({ error: 'ListSourceSessionsFailed', message: err.message });
  }
});

sessionsRouter.get('/sessions/list-target', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const migrator = new SessionMigrator(config);
    const sessions = await migrator.listTargetSessions();
    return res.status(200).json({ sessions, targetProject: config.target.projectId, targetApp: config.target.appId });
  } catch (err: any) {
    return res.status(500).json({ error: 'ListTargetSessionsFailed', message: err.message });
  }
});

sessionsRouter.post('/sessions/migrate', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const migrator = new SessionMigrator(config);

    const { session, all } = req.body;
    if (all) {
      const srcSessions = await migrator.listSourceSessions();
      // Sort chronologically (oldest first -> newest last) so newest appears at the top of target sidebar
      const chronologicalSessions = [...srcSessions].sort((a, b) => {
        const tA = new Date(a.startTime || a.endTime || 0).getTime();
        const tB = new Date(b.startTime || b.endTime || 0).getTime();
        return tA - tB;
      });
      const results: any[] = [];
      for (const s of chronologicalSessions) {
        try {
          const restored = await migrator.migrateSession(s);
          results.push({ name: s.displayName || s.name, success: true, targetName: restored.name });
        } catch (e: any) {
          results.push({ name: s.displayName || s.name, success: false, error: e.message });
        }
      }
      return res.status(200).json({ results, total: results.length });
    } else if (session) {
      const restored = await migrator.migrateSession(session);
      return res.status(200).json({ success: true, session: restored });
    } else {
      return res.status(400).json({ error: 'InvalidRequest', message: 'Must specify session or all=true' });
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'MigrateSessionsFailed', message: err.message });
  }
});

sessionsRouter.get('/sessions/answer', async (req, res) => {
  try {
    const resourceName = req.query.resourceName as string;
    if (!resourceName) {
      return res.status(400).json({ error: 'MissingResourceName', message: 'resourceName query param required' });
    }
    const config = getDynamicConfig(req);
    const migrator = new SessionMigrator(config);
    const userEmail = (req.query.userEmail as string) || (req.query.userPseudoId as string);
    const answer = await migrator.getAnswer(resourceName, userEmail);
    return res.status(200).json({ answer });
  } catch (err: any) {
    return res.status(500).json({ error: 'GetAnswerFailed', message: err.message });
  }
});

// Artifacts Gallery & Exporter Endpoints
sessionsRouter.get('/artifacts/list', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const cacheKey = `${config.source.projectId}:${config.source.appId}`;
    const { ArtifactExtractor } = await import('../engines/artifactExtractor.js');
    const extractor = new ArtifactExtractor(config);
    const artifacts = await extractor.scanAllArtifacts();
    projectArtifactCache.set(cacheKey, { artifacts, timestamp: Date.now() });
    return res.status(200).json({ artifacts, total: artifacts.length, sourceProject: config.source.projectId });
  } catch (err: any) {
    return res.status(500).json({ error: 'ArtifactScanFailed', message: err.message });
  }
});

sessionsRouter.post('/artifacts/export-all', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const { ArtifactExtractor } = await import('../engines/artifactExtractor.js');
    const extractor = new ArtifactExtractor(config);
    const result = await extractor.exportAllToDirectory('./exports/artifacts');
    return res.status(200).json({ success: true, count: result.count, exportDir: result.exportDir });
  } catch (err: any) {
    return res.status(500).json({ error: 'ArtifactExportFailed', message: err.message });
  }
});

sessionsRouter.get('/artifacts/render/:id', async (req, res) => {
  try {
    const artifactId = req.params.id;
    const config = getDynamicConfig(req);
    const cacheKey = `${config.source.projectId}:${config.source.appId}`;
    let entry = projectArtifactCache.get(cacheKey);

    if (!entry || Date.now() - entry.timestamp > CACHE_TTL_MS) {
      const { ArtifactExtractor } = await import('../engines/artifactExtractor.js');
      const extractor = new ArtifactExtractor(config);
      const artifacts = await extractor.scanAllArtifacts();
      entry = { artifacts, timestamp: Date.now() };
      projectArtifactCache.set(cacheKey, entry);
    }

    const art = entry.artifacts.find(a => a.id === artifactId);
    if (!art || !art.htmlContent) {
      return res.status(404).send('<h1>Artifact not found or has no HTML content</h1>');
    }
    res.setHeader('Content-Type', 'text/html');
    return res.send(art.htmlContent);
  } catch (err: any) {
    return res.status(500).send(`<h1>Failed to render artifact: ${err.message}</h1>`);
  }
});
