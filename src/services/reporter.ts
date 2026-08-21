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

import * as fs from 'fs';
import * as path from 'path';
import { MigrationReport, MigrationItemResult } from '../types/migration.js';

export class MigrationReporter {
  static generateMarkdownSummary(report: MigrationReport): string {
    const lines: string[] = [];

    lines.push(`# Gemini Enterprise Admin Migration Report`);
    lines.push(`**Migration ID:** \`${report.migrationId}\``);
    lines.push(`**Execution Mode:** ${report.dryRun ? '🔍 DRY RUN (Simulated)' : '🚀 LIVE MIGRATION'}`);
    lines.push(`**Start Time:** ${report.startTime}`);
    lines.push(`**End Time:** ${report.endTime}`);
    lines.push(`**Total Duration:** ${(report.durationMs / 1000).toFixed(2)}s\n`);

    lines.push(`---`);
    lines.push(`## 1. Environment Details`);
    lines.push(`| Environment | Project ID | Region | Engine/App ID | Assistant |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- |`);
    lines.push(`| **Source** | \`${report.sourceEnvironment.projectId}\` | \`${report.sourceEnvironment.appLocation}\` | \`${report.sourceEnvironment.appId}\` | \`${report.sourceEnvironment.assistantId || 'default_assistant'}\` |`);
    lines.push(`| **Target** | \`${report.targetEnvironment.projectId}\` | \`${report.targetEnvironment.appLocation}\` | \`${report.targetEnvironment.appId}\` | \`${report.targetEnvironment.assistantId || 'default_assistant'}\` |\n`);

    lines.push(`---`);
    lines.push(`## 2. Migration Summary`);
    lines.push(`| Metric | Count |`);
    lines.push(`| :--- | :--- |`);
    lines.push(`| **Discovered Agents** | ${report.summary.totalDiscoveredAgents} |`);
    lines.push(`| **Discovered Notebooks** | ${report.summary.totalDiscoveredNotebooks} |`);
    lines.push(`| **Successfully Migrated Agents** | ${report.summary.totalMigratedAgents} |`);
    lines.push(`| **Successfully Migrated Notebooks** | ${report.summary.totalMigratedNotebooks} |`);
    lines.push(`| **Skipped Items** | ${report.summary.totalSkipped} |`);
    lines.push(`| **Failed Items** | ${report.summary.totalFailed} |\n`);

    // Group results by original user for reconciliation
    const userGroups = new Map<string, { migrated: number; skipped: number; failed: number; targetOwner: string; reasons: string[] }>();
    for (const r of report.results) {
      const u = r.originalOwner || 'Unknown User';
      if (!userGroups.has(u)) {
        userGroups.set(u, { migrated: 0, skipped: 0, failed: 0, targetOwner: r.targetOwner || 'N/A', reasons: [] });
      }
      const grp = userGroups.get(u)!;
      if (r.status === 'SUCCESS' || r.status === 'DRY_RUN') {
        grp.migrated++;
      } else if (r.status === 'SKIPPED') {
        grp.skipped++;
        if (r.error && !grp.reasons.includes(r.error)) grp.reasons.push(r.error);
      } else if (r.status === 'FAILED') {
        grp.failed++;
        if (r.error && !grp.reasons.includes(r.error)) grp.reasons.push(r.error);
      }
    }

    if (userGroups.size > 0) {
      lines.push(`---`);
      lines.push(`## 3. User Reconciliation & Migration Status`);
      lines.push(`| Source User Identity | Target Google Identity | Status | Migrated Items | Dropped/Skipped | Notes / Reason |`);
      lines.push(`| :--- | :--- | :---: | :---: | :---: | :--- |`);

      for (const [userEmail, stats] of userGroups.entries()) {
        let userStatus = '✅ FULLY MIGRATED';
        let statusBadge = '✅';
        if (stats.migrated === 0 && stats.skipped > 0) {
          userStatus = '⚠️ DROPPED (OFFBOARDED / UNMAPPED)';
          statusBadge = '⚠️';
        } else if (stats.skipped > 0 || stats.failed > 0) {
          userStatus = '🟡 PARTIALLY MIGRATED';
          statusBadge = '🟡';
        }

        const notes = stats.reasons.length > 0 
          ? stats.reasons.join('; ') 
          : stats.migrated > 0 ? 'All assets restored to personal library' : 'No assets found';

        lines.push(
          `| \`${userEmail}\` | \`${stats.targetOwner}\` | ${statusBadge} **${userStatus}** | **${stats.migrated}** | **${stats.skipped}** | ${notes} |`
        );
      }
      lines.push('');
    }

    lines.push(`---`);
    lines.push(`## 4. Detailed Asset Migration Results`);
    lines.push(`| Type | Display Name / Title | Status | Original Owner | Target Owner / ID | Notes / Error |`);
    lines.push(`| :--- | :--- | :---: | :--- | :--- | :--- |`);

    for (const r of report.results) {
      const statusIcon = r.status === 'SUCCESS' ? '✅' : r.status === 'DRY_RUN' ? '🔍' : r.status === 'SKIPPED' ? '⏭️' : '❌';
      lines.push(
        `| **${r.type}** | ${r.displayName} | ${statusIcon} ${r.status} | \`${r.originalOwner || 'N/A'}\` | \`${r.targetOwner || r.targetId || 'N/A'}\` | ${r.error || 'Migrated successfully'} |`
      );
    }

    if (report.discoveredUsers.length > 0) {
      lines.push(`\n---`);
      lines.push(`## 5. Discovered User Principals (${report.discoveredUsers.length})`);
      for (const u of report.discoveredUsers) {
        lines.push(`- \`${u}\``);
      }
    }

    return lines.join('\n');
  }

  static writeReportFiles(report: MigrationReport, outputDir: string = './reports'): { jsonPath: string; mdPath: string } {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(outputDir, `migration-report-${report.migrationId}-${timestampStr}.json`);
    const mdPath = path.join(outputDir, `migration-report-${report.migrationId}-${timestampStr}.md`);

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(mdPath, this.generateMarkdownSummary(report), 'utf8');

    return { jsonPath, mdPath };
  }
}
