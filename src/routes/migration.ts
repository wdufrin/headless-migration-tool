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
import express from 'express';
import fs from 'fs';
import { MigrationConfigSchema } from '../config/configSchema.js';
import { MigrationRunner } from '../engines/migrationRunner.js';
import { GcpAuthService } from '../services/gcpAuth.js';
import { DryRunSimulator } from '../engines/dryRunSimulator.js';
import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { AdminHitlNotebookCandidate, ConnectorMappingEntry } from '../types/migration.js';
import { validateConnectorOrDataStoreId } from '../services/connectorMatcher.js';
import { logger } from '../utils/logger.js';

export const migrationRouter = express.Router();

const pendingAdminHitlPrompts = new Map<
  string,
  { resolve: (approvedIds: string[]) => void; candidates: AdminHitlNotebookCandidate[] }
>();

const pendingConnectorHitlPrompts = new Map<
  string,
  {
    resolve: (mappings: { collectionMapping?: Record<string, string>; datastoreMapping?: Record<string, string> }) => void;
    entries: ConnectorMappingEntry[];
  }
>();

function resolveAuthServiceOptions(validatedConfig: any, callerToken?: string) {
  const authType = validatedConfig.auth?.authType || 'SERVICE_ACCOUNT_KEY';
  const usesWif =
    authType === 'WORKFORCE_IDENTITY_FEDERATION' ||
    (validatedConfig.idpMapping?.sourceIdp && validatedConfig.idpMapping.sourceIdp !== 'GOOGLE_CLOUD_IDENTITY') ||
    (validatedConfig.idpMapping?.targetIdp && validatedConfig.idpMapping.targetIdp !== 'GOOGLE_CLOUD_IDENTITY');
  const saKeyPath = validatedConfig.auth?.serviceAccountKeyPath || process.env.SERVICE_ACCOUNT_KEY_PATH ||
    (fs.existsSync('./sa-dwd-key.json') && fs.statSync('./sa-dwd-key.json').size > 0 ? './sa-dwd-key.json' : undefined);
  const wifPath = usesWif
    ? (validatedConfig.auth?.wifConfigPath || process.env.WORKFORCE_IDENTITY_CONFIG_PATH ||
       (fs.existsSync('./workforce-identity-config.json') ? './workforce-identity-config.json' : undefined))
    : undefined;

  return {
    staticToken: callerToken,
    authType,
    serviceAccountKeyPath: saKeyPath,
    wifConfigPath: wifPath
  };
}

// Admin Migration Trigger Endpoint (JSON)
migrationRouter.post('/migrate', async (req, res) => {
  try {
    const validatedConfig = MigrationConfigSchema.parse(req.body);
    const authService = new GcpAuthService(resolveAuthServiceOptions(validatedConfig, req.accessToken));
    const runner = new MigrationRunner({ authService });

    logger.info(`Admin Migration API invoked by user: ${req.user?.email || 'authenticated-caller'}`);
    const report = await runner.run(validatedConfig);

    return res.status(200).json({
      success: report.summary.totalFailed === 0 && (report.summary.totalSkipped ?? 0) === 0 && (report.summary.totalFailedSources ?? 0) === 0,
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
migrationRouter.post('/migrate/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof (res as any).flushHeaders === 'function') {
    (res as any).flushHeaders();
  }

  let streamClosed = false;
  const sendEvent = (event: string, data: any) => {
    if (streamClosed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Emit periodic SSE comment frames so reverse proxies, load balancers, and browsers
  // do not sever the connection during long multi-source notebook fetches or HITL waits.
  const keepAliveTimer = setInterval(() => {
    if (!streamClosed && !res.writableEnded) {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }
  }, 15000);
  if (typeof (keepAliveTimer as any).unref === 'function') {
    (keepAliveTimer as any).unref();
  }

  const unsubscribe = logger.subscribe((level, line, message) => {
    sendEvent('log', { level, line, message, timestamp: new Date().toISOString() });
  });

  let activePromptId: string | null = null;
  let activeConnectorPromptId: string | null = null;
  res.on('close', () => {
    streamClosed = true;
    clearInterval(keepAliveTimer);
    if (activePromptId && pendingAdminHitlPrompts.has(activePromptId)) {
      const pending = pendingAdminHitlPrompts.get(activePromptId);
      pendingAdminHitlPrompts.delete(activePromptId);
      pending?.resolve([]);
    }
    if (activeConnectorPromptId && pendingConnectorHitlPrompts.has(activeConnectorPromptId)) {
      const pending = pendingConnectorHitlPrompts.get(activeConnectorPromptId);
      pendingConnectorHitlPrompts.delete(activeConnectorPromptId);
      pending?.resolve({});
    }
  });

  try {
    const validatedConfig = MigrationConfigSchema.parse(req.body);
    const authService = new GcpAuthService(resolveAuthServiceOptions(validatedConfig, req.accessToken));
    // Forward real phase transitions from the engine. The browser previously had to
    // guess progress by substring-matching log text.
    const runner = new MigrationRunner({
      authService,
      onStage: (stage, status) => sendEvent('stage', { stage, status }),
      onAdminNotebookHitlPrompt: (candidates: AdminHitlNotebookCandidate[]) => {
        return new Promise<string[]>((resolve) => {
          const promptId = randomUUID();
          activePromptId = promptId;
          pendingAdminHitlPrompts.set(promptId, { resolve, candidates });
          sendEvent('admin_notebook_hitl', { promptId, candidates });
        });
      },
      onConnectorHitlPrompt: (entries: ConnectorMappingEntry[]) => {
        return new Promise<{ collectionMapping?: Record<string, string>; datastoreMapping?: Record<string, string> }>((resolve) => {
          const promptId = randomUUID();
          activeConnectorPromptId = promptId;
          pendingConnectorHitlPrompts.set(promptId, { resolve, entries });
          sendEvent('connector_mapping_hitl', { promptId, entries });
        });
      }
    });

    sendEvent('stage', { stage: 'preflight', status: 'active' });
    sendEvent('log', { level: 'INFO', message: `Admin Migration Stream initiated by ${req.user?.email || 'admin'}` });


    const report = await runner.run(validatedConfig);
    sendEvent('stage', { stage: 'complete', status: 'done' });
    sendEvent('report', report);
    sendEvent('done', {
      success: report.summary.totalFailed === 0 && (report.summary.totalSkipped ?? 0) === 0 && (report.summary.totalFailedSources ?? 0) === 0,
      totalFailed: report.summary.totalFailed,
      totalSkipped: report.summary.totalSkipped ?? 0,
      totalFailedSources: report.summary.totalFailedSources ?? 0,
      durationMs: report.durationMs
    });
    res.end();
  } catch (err: any) {
    sendEvent('error', { message: err.message, issues: err.issues || undefined });
    res.end();
  } finally {
    streamClosed = true;
    clearInterval(keepAliveTimer);
    if (activePromptId && pendingAdminHitlPrompts.has(activePromptId)) {
      pendingAdminHitlPrompts.delete(activePromptId);
    }
    if (activeConnectorPromptId && pendingConnectorHitlPrompts.has(activeConnectorPromptId)) {
      pendingConnectorHitlPrompts.delete(activeConnectorPromptId);
    }
    unsubscribe();
  }
});

// Human-in-the-Loop (HITL) Response Endpoint for Shared Admin Notebooks
migrationRouter.post('/migrate/hitl-response', (req, res) => {
  const { promptId, approvedNotebookIds } = req.body || {};
  if (!promptId || typeof promptId !== 'string') {
    return res.status(400).json({ error: 'InvalidPromptId', message: 'A valid promptId string is required.' });
  }
  const pending = pendingAdminHitlPrompts.get(promptId);
  if (!pending) {
    return res.status(404).json({ error: 'PromptNotFound', message: `No active HITL prompt found for ID "${promptId}".` });
  }
  const normalizedIds = Array.isArray(approvedNotebookIds)
    ? approvedNotebookIds.map((id: any) => String(id).trim()).filter(Boolean)
    : [];
  pendingAdminHitlPrompts.delete(promptId);
  pending.resolve(normalizedIds);
  logger.info(`[ADMIN HITL VALIDATION] Operator submitted HITL decision for prompt ${promptId}: ${normalizedIds.length} of ${pending.candidates.length} shared Admin notebook(s) approved.`);
  return res.status(200).json({
    ok: true,
    approvedCount: normalizedIds.length,
    totalCandidates: pending.candidates.length
  });
});

// Human-in-the-Loop (HITL) Response Endpoint for Unmapped Connector / DataStore Mappings
migrationRouter.post('/migrate/connector-hitl-response', (req, res) => {
  const { promptId, collectionMapping, datastoreMapping } = req.body || {};
  if (!promptId || typeof promptId !== 'string') {
    return res.status(400).json({ error: 'InvalidPromptId', message: 'A valid promptId string is required.' });
  }
  const pending = pendingConnectorHitlPrompts.get(promptId);
  if (!pending) {
    return res.status(404).json({ error: 'PromptNotFound', message: `No active Connector HITL prompt found for ID "${promptId}".` });
  }

  try {
    const cleanCollectionMapping: Record<string, string> = {};
    const cleanDatastoreMapping: Record<string, string> = {};

    if (collectionMapping && typeof collectionMapping === 'object') {
      for (const [srcId, tgtId] of Object.entries(collectionMapping)) {
        if (typeof tgtId === 'string' && tgtId.trim()) {
          cleanCollectionMapping[validateConnectorOrDataStoreId(srcId, 'sourceCollectionId')] =
            validateConnectorOrDataStoreId(tgtId, 'targetCollectionId');
        }
      }
    }
    if (datastoreMapping && typeof datastoreMapping === 'object') {
      for (const [srcId, tgtId] of Object.entries(datastoreMapping)) {
        if (typeof tgtId === 'string' && tgtId.trim()) {
          cleanDatastoreMapping[validateConnectorOrDataStoreId(srcId, 'sourceDataStoreId')] =
            validateConnectorOrDataStoreId(tgtId, 'targetDataStoreId');
        }
      }
    }

    pendingConnectorHitlPrompts.delete(promptId);
    pending.resolve({
      collectionMapping: cleanCollectionMapping,
      datastoreMapping: cleanDatastoreMapping
    });
    logger.info(
      `[CONNECTOR HITL VALIDATION] Operator submitted Connector HITL mappings for prompt ${promptId}: ${Object.keys(cleanCollectionMapping).length} connector(s), ${Object.keys(cleanDatastoreMapping).length} datastore(s).`
    );
    return res.status(200).json({
      ok: true,
      mappedConnectors: Object.keys(cleanCollectionMapping).length,
      mappedDataStores: Object.keys(cleanDatastoreMapping).length
    });
  } catch (err: any) {
    return res.status(400).json({ error: 'InvalidMappingInput', message: err.message });
  }
});

// Pre-Flight Validation Endpoint
migrationRouter.post('/preflight', async (req, res) => {
  try {
    const validatedConfig = MigrationConfigSchema.parse(req.body);
    const authService = new GcpAuthService(resolveAuthServiceOptions(validatedConfig, req.accessToken));
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
