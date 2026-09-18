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
    lines.push(`| **Discovered Notebook Sources** | ${report.summary.totalDiscoveredSources ?? 0} |`);
    lines.push(`| **Discovered Chat Sessions** | ${report.summary.totalDiscoveredSessions ?? 0} |`);
    lines.push(`| **Discovered User Memories** | ${report.summary.totalDiscoveredMemories ?? 0} |`);
    lines.push(`| **Discovered Enterprise Skills** | ${report.summary.totalDiscoveredSkills ?? 0} |`);
    lines.push(`| **Successfully Migrated Agents** | ${report.summary.totalMigratedAgents} |`);
    lines.push(`| **Successfully Migrated Notebooks** | ${report.summary.totalMigratedNotebooks} |`);
    lines.push(`| **Successfully Migrated Sources** | ${report.summary.totalMigratedSources ?? 0} |`);
    lines.push(`| **Failed Notebook Sources** | ${report.summary.totalFailedSources ?? 0} |`);
    lines.push(`| **Successfully Migrated Chat Sessions** | ${report.summary.totalMigratedSessions ?? 0} |`);
    lines.push(`| **Successfully Migrated User Memories** | ${report.summary.totalMigratedMemories ?? 0} |`);
    lines.push(`| **Successfully Migrated Skills** | ${report.summary.totalMigratedSkills ?? 0} |`);
    lines.push(`| **Exported Studio Artifacts** | ${report.summary.totalMigratedArtifacts ?? report.summary.totalDiscoveredArtifacts ?? 0} |`);
    lines.push(`| **Skipped Items** | ${report.summary.totalSkipped} |`);
    lines.push(`| **Failed Items** | ${report.summary.totalFailed} |`);
    lines.push(`| **Migrated WITHOUT ownership transfer** | ${report.summary.totalOwnershipNotTransferred ?? 0} |\n`);

    // Group results by original user for reconciliation
    const userGroups = new Map<string, {
      agents: number;
      notebooks: number;
      sourcesRestored: number;
      sourcesFailed: number;
      memories: number;
      sessions: number;
      artifacts: number;
      skills: number;
      migrated: number;
      skipped: number;
      failed: number;
      targetOwner: string;
      reasons: string[];
    }>();

    for (const r of report.results) {
      const u = r.originalOwner || 'System / Shared';
      if (!userGroups.has(u)) {
        userGroups.set(u, {
          agents: 0,
          notebooks: 0,
          sourcesRestored: 0,
          sourcesFailed: 0,
          memories: 0,
          sessions: 0,
          artifacts: 0,
          skills: 0,
          migrated: 0,
          skipped: 0,
          failed: 0,
          targetOwner: r.targetOwner || 'N/A',
          reasons: []
        });
      }
      const grp = userGroups.get(u)!;
      if (r.type === 'AGENT') grp.agents++;
      else if (r.type === 'NOTEBOOK') {
        grp.notebooks++;
        grp.sourcesRestored += (r.details?.sourcesRestored ?? r.details?.sourcesCount ?? 0);
        grp.sourcesFailed += (r.details?.sourcesFailed ?? 0);
      }
      else if (r.type === 'MEMORY') grp.memories++;
      else if (r.type === 'SESSION') grp.sessions++;
      else if (r.type === 'ARTIFACT') grp.artifacts++;
      else if (r.type === 'SKILL') grp.skills++;

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

    if (report.identityMapping && Object.keys(report.identityMapping).length > 0) {
      lines.push(`---`);
      lines.push(`## 2b. User Identity Mapping Report (Source ID ➔ Destination ID)`);
      lines.push(`| Source User Identity (Old ID) | Target User Identity (New ID) | Mapping Type | Assets Migrated |`);
      lines.push(`| :--- | :--- | :---: | :---: |`);
      const seenPairs = new Set<string>();
      for (const [srcId, tgtId] of Object.entries(report.identityMapping)) {
        const normKey = `${srcId.toLowerCase()}->${tgtId.toLowerCase()}`;
        if (seenPairs.has(normKey)) continue;
        seenPairs.add(normKey);
        const grp = userGroups.get(srcId) || userGroups.get(srcId.toLowerCase());
        const count = grp ? grp.migrated : 0;
        const mapType = srcId.toLowerCase() !== tgtId.toLowerCase() ? '🔄 Mapped (`Old ➔ New`)' : '1:1 Direct';
        lines.push(`| \`${srcId}\` | \`${tgtId}\` | ${mapType} | **${count}** |`);
      }
      lines.push('');
    }

    if (userGroups.size > 0) {
      lines.push(`---`);
      lines.push(`## 3. User Reconciliation & Migration Status`);
      lines.push(`| Source User Identity | Target Google Identity | Status | Agents | Notebooks | Sources Restored | Sources Failed | Memories | Sessions | Skills | Artifacts | Dropped/Skipped | Notes / Reason |`);
      lines.push(`| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |`);

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

        const failedSourcesBadge = stats.sourcesFailed > 0 ? `⚠️ **${stats.sourcesFailed}**` : '0';

        lines.push(
          `| \`${userEmail}\` | \`${stats.targetOwner}\` | ${statusBadge} **${userStatus}** | ${stats.agents} | ${stats.notebooks} | ${stats.sourcesRestored} | ${failedSourcesBadge} | ${stats.memories} | ${stats.sessions} | ${stats.skills} | ${stats.artifacts} | **${stats.skipped}** | ${notes} |`
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
      const typeIcon = r.type === 'MEMORY' ? '🧠' : r.type === 'AGENT' ? '🤖' : r.type === 'NOTEBOOK' ? '📓' : r.type === 'SESSION' ? '💬' : r.type === 'SKILL' ? '🎯' : '🎨';
      
      let noteText = r.error || 'Migrated successfully';
      if (r.type === 'NOTEBOOK' && r.details) {
        const restored = r.details.sourcesRestored ?? r.details.sourcesCount ?? 0;
        const failed = r.details.sourcesFailed ?? 0;
        noteText = failed > 0 
          ? `⚠️ ${restored} sources restored (${failed} failed)` 
          : `✅ ${restored} sources restored${r.error ? `; ${r.error}` : ''}`;
      }

      lines.push(
        `| ${typeIcon} **${r.type}** | ${r.displayName} | ${statusIcon} ${r.status} | \`${r.originalOwner || 'N/A'}\` | \`${r.targetOwner || r.targetId || 'N/A'}\` | ${noteText} |`
      );
    }

    // Section 5: Detailed Notebook Sources Breakdown & Audit
    const allNotebookSources: Array<{
      notebookName: string;
      sourceTitle: string;
      type: string;
      status: string;
      error?: string;
    }> = [];

    for (const r of report.results) {
      if (r.type === 'NOTEBOOK' && r.details?.sources && Array.isArray(r.details.sources)) {
        for (const s of r.details.sources) {
          allNotebookSources.push({
            notebookName: r.displayName,
            sourceTitle: s.title || 'Untitled Source',
            type: s.type || 'DOCUMENT',
            status: s.status || 'SUCCESS',
            error: s.error
          });
        }
      }
    }

    if (allNotebookSources.length > 0) {
      lines.push(`\n---`);
      lines.push(`## 5. Notebook Sources Breakdown & Integrity Audit (${allNotebookSources.length} sources)`);
      lines.push(`| Notebook | Source Document / Title | Content Type | Status | Audit Details / Error |`);
      lines.push(`| :--- | :--- | :---: | :---: | :--- |`);

      for (const s of allNotebookSources) {
        const statusBadge = s.status === 'SUCCESS' ? '✅ SUCCESS' : s.status === 'DRY_RUN' ? '🔍 DRY_RUN' : '❌ FAILED';
        const detailMsg = s.error ? `**Error:** ${s.error}` : 'Indexed and ready in target notebook';
        lines.push(`| 📓 ${s.notebookName} | ${s.sourceTitle} | \`${s.type}\` | ${statusBadge} | ${detailMsg} |`);
      }
    }

    if (report.discoveredUsers.length > 0) {
      lines.push(`\n---`);
      lines.push(`## 6. Discovered User Principals (${report.discoveredUsers.length})`);
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
