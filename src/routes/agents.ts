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
import { GcpAuthService } from '../services/gcpAuth.js';
import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { logger } from '../utils/logger.js';

export const agentsRouter = express.Router();

// List Target Agents Endpoint
agentsRouter.get('/agents/list-target', async (req, res) => {
  try {
    const projectId = (req.query.projectId as string) || process.env.TARGET_PROJECT_ID || '';
    const location = (req.query.location as string) || process.env.TARGET_LOCATION || 'global';
    const collectionId = (req.query.collectionId as string) || 'default_collection';
    const engineId = (req.query.engineId as string) || process.env.TARGET_APP_ID || '';

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
agentsRouter.post('/agents/widget-deploy', async (req, res) => {
  try {
    const { agentId, projectId, location, collectionId, engineId } = req.body;
    if (!agentId) {
      return res.status(400).json({ error: 'MissingAgentId', message: 'agentId is required.' });
    }

    const targetProject = projectId || process.env.TARGET_PROJECT_ID || '';
    const targetLocation = location || process.env.TARGET_LOCATION || 'global';
    const targetCollection = collectionId || 'default_collection';
    const targetEngine = engineId || process.env.TARGET_APP_ID || '';

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
