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
import { ConfigAuditEngine } from '../engines/configAuditEngine.js';
import { GcpAuthService } from '../services/gcpAuth.js';
import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { AgentRegistryClient } from '../services/agentRegistry.js';
import { getDynamicConfig } from './configHelper.js';
import { logger } from '../utils/logger.js';

export const configAuditRouter = express.Router();

/**
 * POST /api/audit/config
 * Executes a configuration parity check and gap analysis between source and target.
 */
configAuditRouter.post('/audit/config', async (req, res) => {
  try {
    let validatedConfig: any;
    try {
      validatedConfig = MigrationConfigSchema.parse(req.body);
    } catch {
      validatedConfig = getDynamicConfig(req);
    }

    const callerToken = req.accessToken;
    const authType = validatedConfig.auth?.authType || 'SERVICE_ACCOUNT_KEY';
    const saKeyPath = validatedConfig.auth?.serviceAccountKeyPath || process.env.SERVICE_ACCOUNT_KEY_PATH ||
      (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);
    const wifPath = validatedConfig.auth?.wifConfigPath || process.env.WORKFORCE_IDENTITY_CONFIG_PATH ||
      (fs.existsSync('./workforce-identity-config.json') ? './workforce-identity-config.json' : undefined);

    const authService = new GcpAuthService({
      staticToken: callerToken,
      authType,
      serviceAccountKeyPath: saKeyPath,
      wifConfigPath: wifPath
    });

    const client = new DiscoveryEngineClient(authService);
    const registryClient = new AgentRegistryClient(authService);
    const auditEngine = new ConfigAuditEngine(authService, client, registryClient);

    logger.info(`Running configuration pre-check audit for ${validatedConfig.source.projectId} -> ${validatedConfig.target.projectId}`);
    const auditResult = await auditEngine.runAudit(validatedConfig);

    return res.status(200).json({
      success: true,
      audit: auditResult
    });
  } catch (err: any) {
    logger.error(`Config Audit Failure: ${err.message}`);
    return res.status(500).json({
      error: 'ConfigAuditExecutionError',
      message: err.message
    });
  }
});

/**
 * POST /api/audit/config/markdown
 * Generates downloadable Markdown from audit result.
 */
configAuditRouter.post('/audit/config/markdown', async (req, res) => {
  try {
    let auditData = req.body;
    const authService = new GcpAuthService({});
    const auditEngine = new ConfigAuditEngine(authService);

    if (!auditData || !Array.isArray(auditData.items)) {
      let validatedConfig: any;
      try {
        validatedConfig = MigrationConfigSchema.parse(req.body);
      } catch {
        validatedConfig = getDynamicConfig(req);
      }
      auditData = await auditEngine.runAudit(validatedConfig);
    }

    const md = auditEngine.generateMarkdownReport(auditData);

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="ge-config-audit-${auditData.sourceProject || 'source'}-to-${auditData.targetProject || 'target'}.md"`);
    return res.status(200).send(md);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/audit/sync-engine-settings
 * Automatically updates target engine features and settings to match source engine.
 */
configAuditRouter.post('/audit/sync-engine-settings', async (req, res) => {
  try {
    let validatedConfig: any;
    try {
      validatedConfig = MigrationConfigSchema.parse(req.body);
    } catch {
      validatedConfig = getDynamicConfig(req);
    }

    const callerToken = req.accessToken;
    const authType = validatedConfig.auth?.authType || 'SERVICE_ACCOUNT_KEY';
    const saKeyPath = validatedConfig.auth?.serviceAccountKeyPath || process.env.SERVICE_ACCOUNT_KEY_PATH ||
      (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);
    const wifPath = validatedConfig.auth?.wifConfigPath || process.env.WORKFORCE_IDENTITY_CONFIG_PATH ||
      (fs.existsSync('./workforce-identity-config.json') ? './workforce-identity-config.json' : undefined);

    const authService = new GcpAuthService({
      staticToken: callerToken,
      authType,
      serviceAccountKeyPath: saKeyPath,
      wifConfigPath: wifPath
    });

    const client = new DiscoveryEngineClient(authService);
    const auditEngine = new ConfigAuditEngine(authService, client);

    logger.info(`Synchronizing engine settings for ${validatedConfig.source.projectId} -> ${validatedConfig.target.projectId}`);
    const syncResult = await auditEngine.syncEngineSettings(validatedConfig);

    return res.status(200).json(syncResult);
  } catch (err: any) {
    logger.error(`Sync Engine Settings Failure: ${err.message}`);
    return res.status(500).json({
      error: 'SyncEngineSettingsError',
      message: err.message
    });
  }
});

