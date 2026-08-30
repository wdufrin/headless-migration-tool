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

export const reportsRouter = express.Router();

// Reports List Endpoint
reportsRouter.get('/reports', async (_req, res) => {
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

        let totalArtifacts = parsed.summary?.totalMigratedArtifacts || parsed.summary?.totalDiscoveredArtifacts || 0;
        let totalSessions = parsed.summary?.totalMigratedSessions || parsed.summary?.totalDiscoveredSessions || 0;
        let totalMemories = parsed.summary?.totalMigratedMemories || parsed.summary?.totalDiscoveredMemories || 0;
        if (!totalArtifacts && parsed.results) {
          for (const item of parsed.results) {
            if (item.details?.artifactsCount || item.details?.notesCount) {
              totalArtifacts += (item.details.artifactsCount || 0) + (item.details.notesCount || 0);
            }
          }
        }
        if (!totalSessions && parsed.results) {
          totalSessions = parsed.results.filter((r: any) => r.type === 'SESSION').length;
        }
        if (!totalMemories && parsed.results) {
          totalMemories = parsed.results.filter((r: any) => r.type === 'MEMORY').length;
        }

        reports.push({
          id: parsed.id || parsed.migrationId,
          timestamp: new Date(parsed.startTime).toLocaleString(),
          mode: (parsed.options?.dryRun || parsed.dryRun) ? 'DRY_RUN' : 'LIVE',
          migratedAgents: parsed.summary?.totalMigratedAgents || 0,
          migratedNotebooks: parsed.summary?.totalMigratedNotebooks || 0,
          migratedArtifacts: totalArtifacts,
          migratedSessions: totalSessions,
          migratedMemories: totalMemories,
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
reportsRouter.get('/reports/:id', async (req, res) => {
  try {
    const reportsDir = path.join(process.cwd(), 'reports');
    const { id } = req.params;
    const files = fs.readdirSync(reportsDir).filter(f => f.includes(id) && f.endsWith('.json'));

    if (files.length === 0) {
      return res.status(404).json({ error: 'ReportNotFound', message: `Report ID ${id} not found.` });
    }

    const reportFile = path.join(reportsDir, files[0]);
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
    return res.status(200).json({ report });
  } catch (err: any) {
    return res.status(500).json({ error: 'FailedToGetReport', message: err.message });
  }
});
