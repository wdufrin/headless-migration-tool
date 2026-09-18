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
import { MigrationConfigSchema } from '../config/configSchema.js';
import { MigrationRunner } from '../engines/migrationRunner.js';
import { GcpAuthService } from '../services/gcpAuth.js';
import { DryRunSimulator } from '../engines/dryRunSimulator.js';
import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { logger } from '../utils/logger.js';

export const migrationRouter = express.Router();

// Admin Migration Trigger Endpoint (JSON)
migrationRouter.post('/migrate', async (req, res) => {
  try {
    const validatedConfig = MigrationConfigSchema.parse(req.body);
    const callerToken = req.accessToken;
    const authType = validatedConfig.auth?.authType || 'SERVICE_ACCOUNT_KEY';
    const saKeyPath = validatedConfig.auth?.serviceAccountKeyPath || process.env.SERVICE_ACCOUNT_KEY_PATH || 
      (fs.existsSync('./sa-dwd-key.json') && fs.statSync('./sa-dwd-key.json').size > 0 ? './sa-dwd-key.json' : undefined);
    const wifPath = validatedConfig.auth?.wifConfigPath || process.env.WORKFORCE_IDENTITY_CONFIG_PATH ||
      (fs.existsSync('./workforce-identity-config.json') ? './workforce-identity-config.json' : undefined);

    const authService = new GcpAuthService({
      staticToken: callerToken,
      authType,
      serviceAccountKeyPath: saKeyPath,
      wifConfigPath: wifPath
    });
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
    const authType = validatedConfig.auth?.authType || 'SERVICE_ACCOUNT_KEY';
    const saKeyPath = validatedConfig.auth?.serviceAccountKeyPath || process.env.SERVICE_ACCOUNT_KEY_PATH || 
      (fs.existsSync('./sa-dwd-key.json') && fs.statSync('./sa-dwd-key.json').size > 0 ? './sa-dwd-key.json' : undefined);
    const wifPath = validatedConfig.auth?.wifConfigPath || process.env.WORKFORCE_IDENTITY_CONFIG_PATH ||
      (fs.existsSync('./workforce-identity-config.json') ? './workforce-identity-config.json' : undefined);

    const authService = new GcpAuthService({
      staticToken: callerToken,
      authType,
      serviceAccountKeyPath: saKeyPath,
      wifConfigPath: wifPath
    });
    // Forward real phase transitions from the engine. The browser previously had to
    // guess progress by substring-matching log text.
    const runner = new MigrationRunner({
      authService,
      onStage: (stage, status) => sendEvent('stage', { stage, status })
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
    unsubscribe();
  }
});

// Pre-Flight Validation Endpoint
migrationRouter.post('/preflight', async (req, res) => {
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
