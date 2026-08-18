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
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { createTokenAuthMiddleware } from './security/authMiddleware.js';
import { MigrationConfigSchema, ValidatedMigrationConfig } from './config/configSchema.js';
import { MigrationRunner } from './engines/migrationRunner.js';
import { GcpAuthService } from './services/gcpAuth.js';
import { BigQueryDiscoveryService } from './services/bigQueryDiscovery.js';
import { DryRunSimulator } from './engines/dryRunSimulator.js';
import { DiscoveryEngineClient } from './services/discoveryEngine.js';
import { SessionMigrator } from './engines/sessionMigrator.js';
import { logger } from './utils/logger.js';

const app = express();
const port = parseInt(process.env.PORT || '8080', 10);

// Mitigation #3: Lock CORS to authorized origin
const allowedOrigin = process.env.CORS_ALLOWED_ORIGIN || '*';
app.use(cors({
  origin: allowedOrigin === '*' ? true : allowedOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

// Serve Admin Web UI
const publicDir = path.join(process.cwd(), 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// Health Check Probe for Kubernetes
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mitigation #2: Server-side token verification and corporate domain check
const authMiddleware = createTokenAuthMiddleware({
  requireAuth: process.env.NODE_ENV === 'production'
});

export function getDynamicConfig(req: express.Request): ValidatedMigrationConfig {
  const query = (req.query || {}) as Record<string, string>;
  const body = (req.body || {}) as Record<string, any>;

  const srcProjectId = body.srcProjectId || body.source?.projectId || query.srcProjectId || process.env.SOURCE_PROJECT_ID || 'ancient-sandbox-322523';
  const srcLocation = body.srcLocation || body.source?.appLocation || query.srcLocation || process.env.SOURCE_LOCATION || 'global';
  const srcCollectionId = body.srcCollectionId || body.source?.collectionId || query.srcCollectionId || process.env.SOURCE_COLLECTION_ID || 'default_collection';
  const srcAppId = body.srcAppId || body.source?.appId || query.srcAppId || process.env.SOURCE_APP_ID || 'cosmere-1756136513915_1756136523768';

  const tgtProjectId = body.tgtProjectId || body.target?.projectId || query.tgtProjectId || process.env.TARGET_PROJECT_ID || 'testgebackupandrestorev2';
  const tgtLocation = body.tgtLocation || body.target?.appLocation || query.tgtLocation || process.env.TARGET_LOCATION || 'global';
  const tgtCollectionId = body.tgtCollectionId || body.target?.collectionId || query.tgtCollectionId || process.env.TARGET_COLLECTION_ID || 'default_collection';
  const tgtAppId = body.tgtAppId || body.target?.appId || query.tgtAppId || process.env.TARGET_APP_ID || 'testnotebooks_1784725785748';

  let baseConfig: any = {};
  const configPath = path.resolve(process.cwd(), 'config.local-test.json');
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

// Admin Migration Trigger Endpoint (JSON)
app.post('/api/migrate', authMiddleware, async (req, res) => {
  try {
    const validatedConfig = MigrationConfigSchema.parse(req.body);

    const callerToken = req.accessToken;
    const saKeyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || 
      (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);

    const authService = new GcpAuthService({
      staticToken: callerToken,
      serviceAccountKeyPath: saKeyPath
    });
    const runner = new MigrationRunner({ authService });

    logger.info(`Admin Migration API invoked by user: ${req.user?.email || 'authenticated-caller'}`);
    const report = await runner.run(validatedConfig);

    return res.status(200).json({
      success: report.summary.totalFailed === 0,
      report
    });
  } catch (err: any) {
    logger.error(`API Migration Failure: ${err.message}`);
    return res.status(err.name === 'ZodError' ? 400 : 500).json({
      error: err.name || 'MigrationExecutionError',
      message: err.message,
      details: err.issues || undefined
    });
  }
});

// Admin Migration Real-Time Stream Endpoint (SSE)
app.post('/api/migrate/stream', authMiddleware, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof (res as any).flushHeaders === 'function') {
    (res as any).flushHeaders();
  }

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const unsubscribe = logger.subscribe((level, line, message) => {
    sendEvent('log', { level, line, message, timestamp: new Date().toISOString() });
  });

  try {
    const validatedConfig = MigrationConfigSchema.parse(req.body);
    const callerToken = req.accessToken;
    const saKeyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || 
      (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);

    const authService = new GcpAuthService({
      staticToken: callerToken,
      serviceAccountKeyPath: saKeyPath
    });
    const runner = new MigrationRunner({ authService });

    sendEvent('stage', { stage: 'preflight', status: 'active' });
    sendEvent('log', { level: 'INFO', message: `Admin Migration Stream initiated by ${req.user?.email || 'admin'}` });

    const report = await runner.run(validatedConfig);
    sendEvent('stage', { stage: 'complete', status: 'done' });
    sendEvent('report', report);
    sendEvent('done', { success: report.summary.totalFailed === 0, durationMs: report.durationMs });
    res.end();
  } catch (err: any) {
    sendEvent('error', { message: err.message, issues: err.issues || undefined });
    res.end();
  } finally {
    unsubscribe();
  }
});

// Reports List Endpoint
app.get('/api/reports', authMiddleware, async (_req, res) => {
  try {
    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) {
      return res.status(200).json({ reports: [] });
    }

    const files = fs.readdirSync(reportsDir).filter(f => f.endsWith('.json'));
    const reports: any[] = [];

    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(reportsDir, f), 'utf-8');
        const parsed = JSON.parse(raw);
        reports.push({
          id: parsed.id,
          timestamp: new Date(parsed.startTime).toLocaleString(),
          mode: parsed.options?.dryRun ? 'DRY_RUN' : 'LIVE',
          migratedAgents: parsed.summary?.totalMigratedAgents || 0,
          migratedNotebooks: parsed.summary?.totalMigratedNotebooks || 0,
          totalFailed: parsed.summary?.totalFailed || 0,
          durationMs: parsed.durationMs || 0,
          fileName: f
        });
      } catch (err) {
        // Skip invalid JSON
      }
    }

    reports.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return res.status(200).json({ reports });
  } catch (err: any) {
    return res.status(500).json({ error: 'FailedToListReports', message: err.message });
  }
});

// Single Report Detail Endpoint
app.get('/api/reports/:id', authMiddleware, async (req, res) => {
  try {
    const reportsDir = path.join(process.cwd(), 'reports');
    const { id } = req.params;
    const files = fs.readdirSync(reportsDir).filter(f => f.includes(id) && f.endsWith('.json'));

    if (files.length === 0) {
      return res.status(404).json({ error: 'ReportNotFound', message: `Report ID ${id} not found.` });
    }

    const raw = fs.readFileSync(path.join(reportsDir, files[0]), 'utf-8');
    const report = JSON.parse(raw);
    return res.status(200).json({ report });
  } catch (err: any) {
    return res.status(500).json({ error: 'FailedToGetReport', message: err.message });
  }
});

// Destination Maintenance Cleanup Endpoint
app.post('/api/cleanup', authMiddleware, async (req, res) => {
  try {
    const callerToken = req.accessToken;
    const authService = new GcpAuthService({ staticToken: callerToken });
    const client = new DiscoveryEngineClient(authService);

    const targetProject = req.body?.tgtProjectId || req.body?.projectId || req.body?.target?.projectId || process.env.TARGET_PROJECT_ID || 'testgebackupandrestorev2';
    const targetEngine = req.body?.tgtAppId || req.body?.appId || req.body?.target?.appId || process.env.TARGET_APP_ID || 'testnotebooks_1784725785748';
    const targetLocation = req.body?.tgtLocation || req.body?.location || req.body?.target?.appLocation || process.env.TARGET_LOCATION || 'global';
    const targetCollection = req.body?.tgtCollectionId || req.body?.collectionId || req.body?.target?.collectionId || process.env.TARGET_COLLECTION_ID || 'default_collection';

    logger.info(`Starting maintenance cleanup for project ${targetProject}...`);

    // 1. Delete all notebooks in target
    let deletedNotebooks = 0;
    try {
      const nbs = await client.listNotebooks({
        projectId: targetProject,
        appLocation: targetLocation,
        appId: targetEngine
      });
      for (const nb of nbs) {
        if (nb.name) {
          await client.batchDeleteNotebooks(targetProject, targetLocation, [nb.name]);
          deletedNotebooks++;
        }
      }
    } catch (e: any) {
      logger.warn(`Notebook cleanup notice: ${e.message}`);
    }

    // 2. Delete non-system agents in target engine
    let deletedAgents = 0;
    try {
      const agents = await client.listAgents({
        projectId: targetProject,
        appLocation: targetLocation,
        collectionId: targetCollection,
        appId: targetEngine,
        assistantId: 'default_assistant'
      });
      for (const ag of agents) {
        const agentId = ag.name.split('/').pop();
        if (agentId !== 'deep_research') {
          await client.deleteAgent(ag.name, targetLocation, targetProject);
          deletedAgents++;
        }
      }
    } catch (e: any) {
      logger.warn(`Agent cleanup notice: ${e.message}`);
    }

    // 3. Delete all chat history sessions in target engine
    let deletedSessions = 0;
    try {
      const { SessionMigrator } = await import('./engines/sessionMigrator.js');
      const dynamicConfig = getDynamicConfig(req);
      const migrator = new SessionMigrator(dynamicConfig, authService);
      const targetSessions = await migrator.listTargetSessions();

      for (const s of targetSessions) {
        try {
          const delUrl = `https://discoveryengine.googleapis.com/v1alpha/${s.name}`;
          const token = await authService.getAccessToken();
          await fetch(delUrl, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-Goog-User-Project': targetProject
            }
          });
          deletedSessions++;
        } catch (sErr: any) {
          logger.warn(`Could not delete session ${s.name}: ${sErr.message}`);
        }
      }
    } catch (e: any) {
      logger.warn(`Session cleanup notice: ${e.message}`);
    }

    // 4. Clear exported local artifacts folder
    let clearedArtifacts = false;
    try {
      const artDir = path.resolve(process.cwd(), 'exports/artifacts');
      if (fs.existsSync(artDir)) {
        fs.rmSync(artDir, { recursive: true, force: true });
        fs.mkdirSync(artDir, { recursive: true });
        clearedArtifacts = true;
      }
      const userArtDir = path.resolve(process.cwd(), 'user_artifacts');
      if (fs.existsSync(userArtDir)) {
        fs.rmSync(userArtDir, { recursive: true, force: true });
        fs.mkdirSync(userArtDir, { recursive: true });
      }
    } catch (e: any) {
      logger.warn(`Artifact cleanup notice: ${e.message}`);
    }

    // 5. Clear migration reports folder
    let clearedReports = 0;
    try {
      const reportsDir = path.resolve(process.cwd(), 'reports');
      if (fs.existsSync(reportsDir)) {
        const files = fs.readdirSync(reportsDir);
        for (const file of files) {
          if (file.startsWith('migration-report-')) {
            fs.rmSync(path.join(reportsDir, file), { force: true });
            clearedReports++;
          }
        }
      }
    } catch (e: any) {
      logger.warn(`Reports cleanup notice: ${e.message}`);
    }

    // 6. Clear user handover reports folder
    let clearedUserHandover = false;
    try {
      const handoverDir = path.resolve(process.cwd(), 'user_handover_reports');
      if (fs.existsSync(handoverDir)) {
        fs.rmSync(handoverDir, { recursive: true, force: true });
        fs.mkdirSync(handoverDir, { recursive: true });
        clearedUserHandover = true;
      }
    } catch (e: any) {
      logger.warn(`User handover reports cleanup notice: ${e.message}`);
    }

    logger.info(`Target cleanup completed: ${deletedNotebooks} notebooks, ${deletedAgents} agents, ${deletedSessions} chat sessions, ${clearedReports} reports, user handover bundles, and artifacts reset.`);

    return res.status(200).json({
      success: true,
      deletedNotebooks,
      deletedAgents,
      deletedSessions,
      clearedArtifacts,
      clearedReports,
      clearedUserHandover,
      message: `Cleaned ${deletedNotebooks} notebooks, ${deletedAgents} custom agents, ${deletedSessions} chat sessions, ${clearedReports} migration reports, and reset all user handover bundles and artifacts.`
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'CleanupFailed', message: err.message });
  }
});

// Pre-Flight Validation Endpoint
app.post('/api/preflight', authMiddleware, async (req, res) => {
  try {
    const validatedConfig = MigrationConfigSchema.parse(req.body);
    const callerToken = req.accessToken;
    const authService = new GcpAuthService({ staticToken: callerToken });
    const client = new DiscoveryEngineClient(authService);
    const simulator = new DryRunSimulator(client);

    const checkResult = await simulator.runPreFlightChecks(validatedConfig);
    return res.status(200).json(checkResult);
  } catch (err: any) {
    return res.status(400).json({
      error: 'PreFlightValidationError',
      message: err.message
    });
  }
});

// User Discovery Endpoint
app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const projectId = (req.query.projectId as string) || process.env.SOURCE_PROJECT_ID;
    if (!projectId) {
      return res.status(400).json({ error: 'MissingRequiredParameter', message: 'projectId query parameter is required.' });
    }

    const callerToken = req.accessToken;
    const authService = new GcpAuthService({ staticToken: callerToken });
    const bqDiscovery = new BigQueryDiscoveryService(authService);

    const users = await bqDiscovery.discoverUsersFromBigQuery(projectId);
  } catch (err: any) {
    return res.status(500).json({ error: 'UserDiscoveryFailed', message: err.message });
  }
});

// List Target Agents Endpoint
app.get('/api/agents/list-target', authMiddleware, async (req, res) => {
  try {
    const projectId = (req.query.projectId as string) || 'testgebackupandrestorev2';
    const location = (req.query.location as string) || 'global';
    const collectionId = (req.query.collectionId as string) || 'default_collection';
    const engineId = (req.query.engineId as string) || 'testnotebooks_1784725785748';

    const saKeyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || 
      (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);

    const authService = new GcpAuthService({
      staticToken: req.accessToken,
      serviceAccountKeyPath: saKeyPath
    });
    const client = new DiscoveryEngineClient(authService);

    const agents = await client.listAgents({
      projectId,
      appLocation: location,
      collectionId,
      appId: engineId,
      assistantId: 'default_assistant'
    });
    const simplified = agents.map(a => ({
      id: a.name.split('/').pop(),
      name: a.name,
      displayName: a.displayName,
      state: a.state,
      activeRevision: a.activeRevision
    }));

    return res.status(200).json({ agents: simplified });
  } catch (err: any) {
    return res.status(500).json({ error: 'ListAgentsFailed', message: err.message });
  }
});

// Agent Deployment / Publishing Endpoint
app.post('/api/agents/widget-deploy', authMiddleware, async (req, res) => {
  try {
    const { agentId, projectId, location, collectionId, engineId } = req.body;
    if (!agentId) {
      return res.status(400).json({ error: 'MissingAgentId', message: 'agentId is required.' });
    }

    const targetProject = projectId || 'testgebackupandrestorev2';
    const targetLocation = location || 'global';
    const targetCollection = collectionId || 'default_collection';
    const targetEngine = engineId || 'testnotebooks_1784725785748';

    const saKeyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || 
      (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);

    const authService = new GcpAuthService({
      staticToken: req.accessToken,
      serviceAccountKeyPath: saKeyPath
    });
    const client = new DiscoveryEngineClient(authService);

    const fullAgentName = agentId.includes('/')
      ? agentId
      : `projects/${targetProject}/locations/${targetLocation}/collections/${targetCollection}/engines/${targetEngine}/assistants/default_assistant/agents/${agentId}`;

    const publishRes = await client.publishAgent(fullAgentName, {
      projectId: targetProject,
      appLocation: targetLocation,
      collectionId: targetCollection,
      appId: targetEngine
    });

    logger.info(`Successfully deployed/published agent: ${fullAgentName}`);
    return res.status(200).json({
      success: true,
      agentId,
      agentName: fullAgentName,
      result: publishRes
    });
  } catch (err: any) {
    logger.warn(`Agent deployment notice for ${req.body?.agentId}: ${err.message}`);
    return res.status(err.message?.includes('403') ? 403 : 500).json({
      error: 'AgentPublishFailed',
      message: err.message
    });
  }
});

// Chat Sessions Endpoints
app.get('/api/sessions/list-source', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const migrator = new SessionMigrator(config);
    const sessions = await migrator.listSourceSessions();
    return res.status(200).json({ sessions, sourceProject: config.source.projectId, sourceApp: config.source.appId });
  } catch (err: any) {
    return res.status(500).json({ error: 'ListSourceSessionsFailed', message: err.message });
  }
});

app.get('/api/sessions/list-target', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const migrator = new SessionMigrator(config);
    const sessions = await migrator.listTargetSessions();
    return res.status(200).json({ sessions, targetProject: config.target.projectId, targetApp: config.target.appId });
  } catch (err: any) {
    return res.status(500).json({ error: 'ListTargetSessionsFailed', message: err.message });
  }
});

app.post('/api/sessions/migrate', async (req, res) => {
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

app.get('/api/sessions/answer', async (req, res) => {
  try {
    const resourceName = req.query.resourceName as string;
    if (!resourceName) {
      return res.status(400).json({ error: 'MissingResourceName', message: 'resourceName query param required' });
    }
    const config = getDynamicConfig(req);
    const migrator = new SessionMigrator(config);
    const answer = await migrator.getAnswer(resourceName);
    return res.status(200).json({ answer });
  } catch (err: any) {
    return res.status(500).json({ error: 'GetAnswerFailed', message: err.message });
  }
});

// Artifacts Gallery & Exporter Endpoints
let cachedArtifacts: any[] | null = null;

app.get('/api/artifacts/list', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const { ArtifactExtractor } = await import('./engines/artifactExtractor.js');
    const extractor = new ArtifactExtractor(config);
    cachedArtifacts = await extractor.scanAllArtifacts();
    return res.status(200).json({ artifacts: cachedArtifacts, total: cachedArtifacts.length, sourceProject: config.source.projectId });
  } catch (err: any) {
    return res.status(500).json({ error: 'ArtifactScanFailed', message: err.message });
  }
});

app.post('/api/artifacts/export-all', async (req, res) => {
  try {
    const config = getDynamicConfig(req);
    const { ArtifactExtractor } = await import('./engines/artifactExtractor.js');
    const extractor = new ArtifactExtractor(config);
    const result = await extractor.exportAllToDirectory('./exports/artifacts');
    return res.status(200).json({ success: true, count: result.count, exportDir: result.exportDir });
  } catch (err: any) {
    return res.status(500).json({ error: 'ArtifactExportFailed', message: err.message });
  }
});

app.get('/api/artifacts/render/:id', async (req, res) => {
  try {
    const artifactId = req.params.id;
    if (!cachedArtifacts) {
      const config = getDynamicConfig(req);
      const { ArtifactExtractor } = await import('./engines/artifactExtractor.js');
      const extractor = new ArtifactExtractor(config);
      cachedArtifacts = await extractor.scanAllArtifacts();
    }
    const art = cachedArtifacts.find(a => a.id === artifactId);
    if (!art || !art.htmlContent) {
      return res.status(404).send('<h1>Artifact not found or has no HTML content</h1>');
    }
    res.setHeader('Content-Type', 'text/html');
    return res.send(art.htmlContent);
  } catch (err: any) {
    return res.status(500).send(`<h1>Failed to render artifact: ${err.message}</h1>`);
  }
});

// Helper: load latest migration report
function getLatestMigrationReport(): any | null {
  const reportsDir = './reports';
  if (!fs.existsSync(reportsDir)) return null;
  const jsonFiles = fs.readdirSync(reportsDir).filter(f => f.startsWith('migration-report-') && f.endsWith('.json'));
  if (jsonFiles.length === 0) return null;
  jsonFiles.sort((a, b) => fs.statSync(path.join(reportsDir, b)).mtimeMs - fs.statSync(path.join(reportsDir, a)).mtimeMs);
  try {
    const raw = fs.readFileSync(path.join(reportsDir, jsonFiles[0]), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// User Handover Reports & Email Dispatcher Endpoints
app.get('/api/user-reports', async (req, res) => {
  try {
    const { UserReportGenerator } = await import('./engines/userReportGenerator.js');
    const generator = new UserReportGenerator();
    const latestReport = getLatestMigrationReport();
    if (!latestReport) {
      return res.status(200).json({ users: [], message: 'No migration runs found yet. Run a migration first.' });
    }

    const userGroups = generator.groupReportByUser(latestReport);
    const usersList: any[] = [];

    for (const [email, data] of userGroups.entries()) {
      const sanitized = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
      const folderPath = path.join('./user_handover_reports', sanitized);
      const hasBundle = fs.existsSync(folderPath);

      let totalNbArtifacts = 0;
      for (const nb of data.notebooks) {
        totalNbArtifacts += (nb.details?.artifactsCount || nb.details?.artifacts?.length || 0) + (nb.details?.notesCount || nb.details?.notes?.length || 0);
      }

      usersList.push({
        userEmail: email,
        notebooksCount: data.notebooks.length,
        agentsCount: data.agents.length,
        sessionsCount: data.sessions.length,
        notebookArtifactsCount: totalNbArtifacts,
        hasGeneratedBundle: hasBundle,
        folderPath,
        notebooks: data.notebooks.map(n => ({ displayName: n.displayName, id: n.targetId || n.id })),
        agents: data.agents.map(a => ({ 
          displayName: a.displayName, 
          id: a.targetId || a.id,
          sharedWith: a.details?.sharedWith || ['Private (Author Only)']
        }))
      });
    }

    return res.status(200).json({
      success: true,
      users: usersList,
      totalUsers: usersList.length,
      targetProject: latestReport.targetEnvironment?.projectId || 'testgebackupandrestorev2'
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'GetUserReportsFailed', message: err.message });
  }
});

app.post('/api/user-reports/generate', async (req, res) => {
  try {
    const { UserReportGenerator } = await import('./engines/userReportGenerator.js');
    const generator = new UserReportGenerator();
    const latestReport = getLatestMigrationReport();
    if (!latestReport) {
      return res.status(400).json({ error: 'NoMigrationReport', message: 'No migration reports found to generate user bundles from.' });
    }

    const bundles = generator.generateAllUserBundles(latestReport);
    return res.status(200).json({
      success: true,
      message: `Generated ${Object.keys(bundles).length} user handover bundles.`,
      bundles
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'GenerateUserReportsFailed', message: err.message });
  }
});

app.post('/api/user-reports/send-email', authMiddleware, async (req, res) => {
  try {
    const callerToken = req.accessToken;
    const { userEmail, overrideRecipientEmail, senderEmail, smtpConfig } = req.body;
    if (!userEmail) {
      return res.status(400).json({ error: 'MissingUserEmail', message: 'userEmail is required' });
    }

    const { UserReportGenerator } = await import('./engines/userReportGenerator.js');
    const generator = new UserReportGenerator();
    const latestReport = getLatestMigrationReport();
    if (!latestReport) {
      return res.status(400).json({ error: 'NoMigrationReport', message: 'No migration reports found.' });
    }

    // Ensure bundles exist
    generator.generateAllUserBundles(latestReport);

    const authService = new GcpAuthService({ staticToken: callerToken });
    const result = await generator.sendUserEmail({
      userEmail,
      senderEmail: senderEmail || process.env.SENDER_EMAIL || process.env.ADMIN_EMAIL || userEmail,
      overrideRecipientEmail: overrideRecipientEmail || userEmail,
      accessToken: callerToken,
      authService,
      smtpConfig
    }, latestReport);

    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(500).json({ error: 'SendEmailFailed', message: err.message });
  }
});

app.get('/api/user-reports/render/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const sanitized = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const htmlPath = path.join('./user_handover_reports', sanitized, 'MIGRATION_CHECKLIST.html');
    
    if (!fs.existsSync(htmlPath)) {
      const { UserReportGenerator } = await import('./engines/userReportGenerator.js');
      const generator = new UserReportGenerator();
      const latestReport = getLatestMigrationReport();
      if (latestReport) generator.generateAllUserBundles(latestReport);
    }

    if (fs.existsSync(htmlPath)) {
      res.setHeader('Content-Type', 'text/html');
      return res.send(fs.readFileSync(htmlPath, 'utf8'));
    }
    return res.status(404).send(`<h1>Report not found for ${email}</h1>`);
  } catch (err: any) {
    return res.status(500).send(`<h1>Error: ${err.message}</h1>`);
  }
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    logger.info(`Gemini Enterprise Admin Migration Console listening on http://localhost:${port}`);
  });
}

export default app;
