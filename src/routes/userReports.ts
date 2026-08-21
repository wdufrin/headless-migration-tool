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
import path from 'path';
import { GcpAuthService } from '../services/gcpAuth.js';

export const userReportsRouter = express.Router();

export function getLatestMigrationReport(): any {
  try {
    const reportsDir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) return null;
    const files = fs.readdirSync(reportsDir);
    const jsonFiles = files
      .filter(f => f.startsWith('migration-report-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (jsonFiles.length === 0) return null;
    const raw = fs.readFileSync(path.join(reportsDir, jsonFiles[0]), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// User Handover Reports & Email Dispatcher Endpoints
userReportsRouter.get('/user-reports', async (_req, res) => {
  try {
    const { UserReportGenerator } = await import('../engines/userReportGenerator.js');
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
      targetProject: latestReport.targetEnvironment?.projectId || process.env.TARGET_PROJECT_ID || ''
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'GetUserReportsFailed', message: err.message });
  }
});

userReportsRouter.post('/user-reports/generate', async (_req, res) => {
  try {
    const { UserReportGenerator } = await import('../engines/userReportGenerator.js');
    const generator = new UserReportGenerator();
    const latestReport = getLatestMigrationReport();
    if (!latestReport) {
      return res.status(400).json({ error: 'NoMigrationReport', message: 'No migration reports found to generate user bundles from.' });
    }

    const bundles = await generator.generateAllUserBundles(latestReport);
    return res.status(200).json({
      success: true,
      message: `Generated ${Object.keys(bundles).length} user handover bundles.`,
      bundles
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'GenerateUserReportsFailed', message: err.message });
  }
});

userReportsRouter.post('/user-reports/send-email', async (req, res) => {
  try {
    const callerToken = req.accessToken;
    const { userEmail, overrideRecipientEmail, senderEmail, smtpConfig } = req.body;
    if (!userEmail) {
      return res.status(400).json({ error: 'MissingUserEmail', message: 'userEmail is required' });
    }

    const { UserReportGenerator } = await import('../engines/userReportGenerator.js');
    const generator = new UserReportGenerator();
    const latestReport = getLatestMigrationReport();
    if (!latestReport) {
      return res.status(400).json({ error: 'NoMigrationReport', message: 'No migration reports found.' });
    }

    // Ensure bundles exist
    await generator.generateAllUserBundles(latestReport);

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

userReportsRouter.get('/user-reports/render/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const sanitized = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const htmlPath = path.join('./user_handover_reports', sanitized, 'MIGRATION_CHECKLIST.html');
    
    if (!fs.existsSync(htmlPath)) {
      const { UserReportGenerator } = await import('../engines/userReportGenerator.js');
      const generator = new UserReportGenerator();
      const latestReport = getLatestMigrationReport();
      if (latestReport) await generator.generateAllUserBundles(latestReport);
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
