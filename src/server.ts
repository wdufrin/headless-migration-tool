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
import { createHostAllowlistMiddleware } from './security/hostAllowlist.js';
import { migrationRouter } from './routes/migration.js';
import { discoveryRouter } from './routes/discovery.js';
import { reportsRouter } from './routes/reports.js';
import { userReportsRouter } from './routes/userReports.js';
import { agentsRouter } from './routes/agents.js';
import { sessionsRouter } from './routes/sessions.js';
import { memoriesRouter } from './routes/memories.js';
import { wizardRouter } from './routes/wizard.js';
import { sandboxRouter } from './routes/sandbox.js';
import { maintenanceRouter } from './routes/maintenance.js';
import { configAuditRouter } from './routes/configAudit.js';
import { getDynamicConfig } from './routes/configHelper.js';
import { logger } from './utils/logger.js';

export { getDynamicConfig };

const app = express();
const port = parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '127.0.0.1';
const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
const allowUnauth = process.env.ALLOW_UNAUTHENTICATED === 'true' || process.env.NODE_ENV === 'test' || (isLoopback && process.env.REQUIRE_AUTH !== 'true');
const requireAuth = !allowUnauth;

if (!requireAuth && !isLoopback && process.env.NODE_ENV !== 'test') {
  logger.error(`FATAL SECURITY ERROR: Server is configured without authentication (requireAuth=false) but bound to non-loopback host "${host}". Starting unauthenticated on a network interface is forbidden.`);
  process.exit(1);
}

// Mitigation #3: Lock CORS to authorized origin (Localhost & 127.0.0.1)
const allowedOriginEnv = process.env.CORS_ALLOWED_ORIGIN;
const CLOUD_SHELL_ORIGIN_REGEX = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.cloudshell\.dev$/i;
app.use(cors({
  origin: (origin, callback) => {
    // Direct requests, curl, or same-origin has undefined origin
    if (!origin) return callback(null, true);
    if (allowedOriginEnv === '*') {
      return callback(null, true);
    }
    if (allowedOriginEnv) {
      const allowedList = allowedOriginEnv.split(',').map(o => o.trim()).filter(Boolean);
      if (allowedList.includes(origin)) {
        return callback(null, true);
      }
    }
    // Allow local workstation ports and Google Cloud Shell Web Preview (*.cloudshell.dev)
    if (
      origin.startsWith('http://127.0.0.1:') ||
      origin.startsWith('http://localhost:') ||
      CLOUD_SHELL_ORIGIN_REGEX.test(origin)
    ) {
      return callback(null, true);
    }
    return callback(new Error('CORS policy: Access blocked from unauthorized origin'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

// Serve Admin Web UI
const publicDir = path.join(process.cwd(), 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// Health Check Probe
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Interactive Migration Action Checklist Endpoint
app.get('/checklist', (_req, res) => {
  const htmlPath = path.join(process.cwd(), 'public/checklist.html');
  if (fs.existsSync(htmlPath)) {
    res.setHeader('Content-Type', 'text/html');
    return res.send(fs.readFileSync(htmlPath, 'utf8'));
  }
  return res.status(404).send('<h1>Checklist file not found</h1>');
});

// DNS rebinding protection. This runs BEFORE authentication because when
// `requireAuth` is false (the loopback default) the Host check is the only thing
// standing between a malicious web page and this server's destructive endpoints.
// CORS does not cover this: it gates reading the response, not dispatching the
// request, and simple requests are not preflighted at all.
const hostAllowlistMiddleware = createHostAllowlistMiddleware({
  boundHost: host,
  additionalHostnames: process.env.MIGRATION_ALLOWED_HOSTNAMES?.split(',')
});
app.use('/api', hostAllowlistMiddleware);

// Mitigation #2: Server-side token verification & global /api route protection
const authMiddleware = createTokenAuthMiddleware({
  requireAuth
});

// Apply authMiddleware globally to all /api routes
app.use('/api', authMiddleware);

// Mount Modular Sub-Routers
app.use('/api', migrationRouter);
app.use('/api', discoveryRouter);
app.use('/api', reportsRouter);
app.use('/api', userReportsRouter);
app.use('/api', agentsRouter);
app.use('/api', sessionsRouter);
app.use('/api', memoriesRouter);
app.use('/api', wizardRouter);
app.use('/api', sandboxRouter);
app.use('/api', maintenanceRouter);
app.use('/api', configAuditRouter);

// Fallback 404 handler for all unmatched /api routes to prevent HTML error pages
app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'NotFound',
    message: `API endpoint not found: ${req.method} ${req.originalUrl}`
  });
});

// Global JSON error handler for /api routes
app.use('/api', (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(`API Error: ${err.message || err}`);
  res.status(err.status || 500).json({
    error: err.name || 'InternalServerError',
    message: err.message || 'An unexpected error occurred processing your request.'
  });
});

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(port, host, () => {
    logger.info(`Gemini Enterprise Admin Migration Console running locally on http://${host}:${port}`);
    logger.info(`Bound to ${host} (loopback only). DNS rebinding protection is active on /api.`);

    // Say plainly what the security posture is. The previous message claimed
    // "Localhost Isolation active" regardless of whether anything was enforced,
    // which read as reassurance the server had not earned.
    if (requireAuth) {
      logger.info('Authentication ENFORCED: /api requires a verified Google OAuth Bearer token.');
    } else {
      logger.warn(
        'Authentication DISABLED: any process or user on this machine can call /api, ' +
          'including the destructive teardown endpoints. Set REQUIRE_AUTH=true to enforce ' +
          'OAuth Bearer token verification.'
      );
    }
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${port} is already in use by another running process.`);
      logger.info(`👉 Tip: You can launch on a different port using: PORT=${port + 5} npm start`);
      process.exit(1);
    }
    throw err;
  });
}

export default app;
