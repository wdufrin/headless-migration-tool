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

import fs from 'fs';
import path from 'path';
import { execSync, execFile } from 'child_process';
import { promisify } from 'util';
import nodemailer from 'nodemailer';
import JSZip from 'jszip';
import { MigrationReport, MigrationItemResult } from '../types/migration.js';
import { GcpAuthService } from '../services/gcpAuth.js';
import { NotebookLmArtifactFormatter } from '../services/notebookLmArtifactFormatter.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export interface UserHandoverData {
  userEmail: string;
  notebooks: MigrationItemResult[];
  agents: MigrationItemResult[];
  sessions: MigrationItemResult[];
  memories: MigrationItemResult[];
  targetCid: string;
  targetLocation: string;
  idpProvider?: string;
  mainAppUrl: string;
  agentsWebUrl: string;
  notebooksWebUrl: string;
  chatWebUrl: string;
  generatedAt: string;
}

export interface SendEmailOptions {
  userEmail: string;
  senderEmail?: string;
  overrideRecipientEmail?: string;
  accessToken?: string;
  authService?: GcpAuthService;
  singleEmailMode?: boolean;
  zipAttachments?: boolean;
  optimizeMedia?: boolean;
  smtpConfig?: {
    host?: string;
    port?: number;
    secure?: boolean;
    auth?: {
      user: string;
      pass: string;
    };
  };
}

export interface BulkEmailOptions {
  userEmails?: string[];
  senderEmail?: string;
  overrideRecipientEmail?: string;
  accessToken?: string;
  authService?: GcpAuthService;
  singleEmailMode?: boolean;
  zipAttachments?: boolean;
  optimizeMedia?: boolean;
  smtpConfig?: {
    host?: string;
    port?: number;
    secure?: boolean;
    auth?: {
      user: string;
      pass: string;
    };
  };
  pacingDelayMs?: number;
}

export interface BulkEmailItemResult {
  userEmail: string;
  recipient: string;
  success: boolean;
  mode?: string;
  messageId?: string;
  threadId?: string;
  error?: string;
  attachmentsCount: number;
  partsSent?: number;
  emlPath?: string;
}

export interface BulkEmailResponse {
  success: boolean;
  total: number;
  sent: number;
  failed: number;
  results: BulkEmailItemResult[];
}

export class UserReportGenerator {
  private baseDir: string;

  constructor(baseDir: string = './user_handover_reports') {
    this.baseDir = baseDir;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Helper to build either standard Cloud Identity URLs or Workforce Identity Federation (WiF) SSO URLs.
   */
  buildAppUrl(cid: string, location: string = 'global', idpProvider?: string, route: string = ''): string {
    const loc = (location || 'global').toLowerCase();
    const locPrefix = loc !== 'global' ? `${loc}/` : '';
    const subPath = route ? `/r/${route}` : '';

    if (idpProvider) {
      const cleanIdp = idpProvider
        .replace(/^https?:\/\/auth\.cloud\.google\/signin\//, '')
        .replace(/^\/+/, '');
      const rawTargetUrl = `https://vertexaisearch.cloud.google/${locPrefix}home/cid/${cid}${subPath}&hl=en_US`;
      return `https://auth.cloud.google/signin/${cleanIdp}?continueUrl=${encodeURIComponent(rawTargetUrl)}`;
    }

    return `https://vertexaisearch.cloud.google.com/${locPrefix}home/cid/${cid}${subPath}?hl=en_US`;
  }

  /**
   * Resolves the target Customer/Widget ID (CID) dynamically from report or default target engine.
   */
  resolveTargetCidSync(report: MigrationReport): string {
    const rawCid = (report.targetEnvironment as any)?.widgetConfigConfigId ||
                   (report.targetEnvironment as any)?.cid ||
                   (report as any).config?.target?.widgetConfigConfigId ||
                   (report as any).config?.target?.cid ||
                   (report as any).targetEngine?.widgetConfigConfigId;
    if (rawCid) return rawCid;

    if (process.env.TARGET_APP_CID) return process.env.TARGET_APP_CID;
    
    // Default valid target CID for engine testnotebooks_1784725785748
    return '85240219-d6ee-415c-9242-d270267fa247';
  }

  /**
   * Groups migration report items by individual user email
   */
  groupReportByUser(report: MigrationReport): Map<string, UserHandoverData> {
    const userMap = new Map<string, UserHandoverData>();
    const targetCid = this.resolveTargetCidSync(report);
    const targetLocation = (report.targetEnvironment?.appLocation || (report as any).config?.target?.appLocation || 'global').toLowerCase();
    const targetAppId = report.targetEnvironment?.appId || (report as any).config?.target?.appId || '';

    // Detect if target environment uses Workforce Identity Federation (WiF / Entra ID)
    let idpProvider: string | undefined = (report.targetEnvironment as any)?.idpProvider || (report as any).config?.target?.idpProvider;
    if (!idpProvider && (
      (report.targetEnvironment as any)?.idpType === 'WORKFORCE_IDENTITY_FEDERATION' ||
      (report as any).config?.idpMapping?.targetIdp === 'WORKFORCE_IDENTITY_FEDERATION' ||
      targetAppId.toLowerCase().includes('entra') ||
      targetLocation === 'eu'
    )) {
      idpProvider = process.env.WIF_PROVIDER_ID || undefined;
    }

    const mainAppUrl = this.buildAppUrl(targetCid, targetLocation, idpProvider, '');
    const agentsWebUrl = this.buildAppUrl(targetCid, targetLocation, idpProvider, 'agents');
    const notebooksWebUrl = this.buildAppUrl(targetCid, targetLocation, idpProvider, 'notebook');
    const chatWebUrl = this.buildAppUrl(targetCid, targetLocation, idpProvider, 'chat');

    const now = new Date().toISOString();

    // Determine the primary domain user in the report to prevent phantom accounts
    const domainUserCandidates: string[] = [];
    const results = Array.isArray(report.results) ? report.results : [];
    for (const r of results) {
      const o = (r.targetOwner || r.originalOwner || '').replace(/^user:/, '').trim();
      if (o && o.includes('@') && o !== 'user@example.com' && !o.includes('gserviceaccount.com')) {
        domainUserCandidates.push(o);
      }
    }

    const userFrequency = new Map<string, number>();
    for (const u of domainUserCandidates) {
      userFrequency.set(u, (userFrequency.get(u) || 0) + 1);
    }
    const sortedUsers = Array.from(userFrequency.entries()).sort((a, b) => b[1] - a[1]);
    const primaryReportUser = sortedUsers.length > 0 ? sortedUsers[0][0] : (process.env.ADMIN_EMAIL || process.env.DEFAULT_USER_EMAIL || 'user@example.com');

    const getOrCreateUser = (rawEmail?: string): UserHandoverData => {
      let email = (rawEmail || '').replace(/^user:/, '').trim();
      if (!email || email === 'unknown' || email === 'admin' || !email.includes('@') || email === 'user@example.com') {
        email = primaryReportUser;
      }

      if (!userMap.has(email)) {
        userMap.set(email, {
          userEmail: email,
          notebooks: [],
          agents: [],
          sessions: [],
          memories: [],
          targetCid,
          targetLocation,
          idpProvider,
          mainAppUrl,
          agentsWebUrl,
          notebooksWebUrl,
          chatWebUrl,
          generatedAt: now
        });
      }
      return userMap.get(email)!;
    };

    // Group Results by Item Type
    for (const item of results) {
      const u = getOrCreateUser(item.targetOwner || item.originalOwner);
      if (item.type === 'NOTEBOOK') {
        u.notebooks.push(item);
      } else if (item.type === 'AGENT') {
        u.agents.push(item);
      } else if (item.type === 'SESSION') {
        u.sessions.push(item);
      } else if (item.type === 'MEMORY') {
        u.memories.push(item);
      }
    }

    return userMap;
  }

  /**
   * Generates clean, end-user friendly Markdown checklist with interactive checkboxes
   */
  generateMarkdownReport(data: UserHandoverData): string {
    const agList = data.agents.length > 0
      ? data.agents.map(ag => {
          const rawSharedList = ag.details?.sharedWith as string[] | undefined;
          const cleanUserEmail = data.userEmail.toLowerCase().trim();
          const filteredCollaborators = (rawSharedList || []).filter(s => {
            const cleanS = s.replace(/^\[Group\]\s*/i, '').replace(/^user:/i, '').toLowerCase().trim();
            return cleanS !== cleanUserEmail && !cleanS.includes('gserviceaccount.com') && cleanS !== 'private (author only)';
          });

          const isPrivate = filteredCollaborators.length === 0;
          const sharedWithText = isPrivate ? 'Private (Only You)' : filteredCollaborators.join(', ');
          const directAgentUrl = this.buildAppUrl(data.targetCid, data.targetLocation, data.idpProvider, `agents/${ag.targetId || ag.id}`);

          if (isPrivate) {
            return `### 🤖 [${ag.displayName}](${directAgentUrl})
- [ ] **Step 1:** Open agent and click **"Publish"** in the top right to activate.
`;
          }

          return `### 🤖 [${ag.displayName}](${directAgentUrl})
- **Previously Shared With:** \`${sharedWithText}\`
- [ ] **Step 1:** Open agent and click **"Publish"** in the top right to activate.
- [ ] **Step 2:** Click **"Share"** in the top right and re-add: \`${sharedWithText}\`.
`;
        }).join('\n')
      : '_No custom agents found for your account._';

    const allNotebookSources: string[] = [];

    const nbList = data.notebooks.length > 0
      ? data.notebooks.map(nb => {
          const directNbUrl = this.buildAppUrl(data.targetCid, data.targetLocation, data.idpProvider, `notebook/${nb.targetId || nb.id}`);
          const restoredCount = nb.details?.sourcesRestored ?? nb.details?.sourcesCount ?? 0;
          const failedCount = nb.details?.sourcesFailed ?? 0;
          const sources = Array.isArray(nb.details?.sources) ? nb.details.sources : [];

          if (sources.length > 0) {
            sources.forEach((s: any) => {
              const icon = s.status === 'SUCCESS' || s.status === 'DRY_RUN' ? '  - ✅' : '  - ❌';
              const errStr = s.error ? ` *(Failed: ${s.error})*` : '';
              allNotebookSources.push(`${icon} ${s.title} \`${s.type}\`${errStr}`);
            });
          }

          return `### 📓 [${nb.displayName}](${directNbUrl})
- **Sources Status:** ${restoredCount} restored${failedCount > 0 ? `, ⚠️ **${failedCount} failed**` : ''}
- [ ] **Step 1:** Open notebook to verify restored notes, sources, and study materials.
- [ ] **Step 2:** Download & extract attached \`NotebookLM_Artifacts.zip\` to access your PowerPoint (.pptx) decks and full-resolution graphics.
- [ ] **Step 3:** (Optional) Click **"Share"** inside the notebook if you'd like to invite colleagues.
`;
        }).join('\n')
      : '_No research notebooks found for your account._';

    let totalFailedSources = 0;
    for (const nb of (data.notebooks || [])) {
      const sources: any[] = nb.details?.sources || [];
      totalFailedSources += sources.filter((s: any) => s.status === 'FAILED' || s.status === 'MANUAL_REUPLOAD_REQUIRED').length;
    }

    const failedAgents = (data.agents || []).filter((a: any) => a.status === 'FAILED').length;
    const totalFailures = totalFailedSources + failedAgents;

    const statusGreeting = totalFailures > 0
      ? `⚠️ **Migration Warning:** Your Gemini Enterprise workspace items have been **partially transferred with ${totalFailures} item(s) requiring attention or manual verification**. Complete the action checklists below to review and finalize your migration.`
      : `Your Gemini Enterprise custom agents, research notebooks, and past conversations have been successfully transferred and are ready for you. Complete the action checklists below to finalize your migration.`;

    const sourcesAuditSection = allNotebookSources.length > 0
      ? `
---

## 📄 Notebook Sources Integrity Audit (${allNotebookSources.length} sources)
The following research documents and web sources were processed during migration:
${allNotebookSources.join('\n')}
`
      : '';

    return `# 🚀 Welcome to Your New Gemini Enterprise Workspace

Hello **${data.userEmail}**,

${statusGreeting}

---

## 🔑 1. First-Time Login & Connector Authorization (Action Required)

Before accessing your transferred agents and notebooks, please authorize your connected enterprise tools:

- [ ] **Step 1 — Log in:** Open **[Launch Gemini Enterprise Workspace](${data.mainAppUrl})** using your **${data.userEmail}** credentials.
- [ ] **Step 2 — Open Connectors:** In the prompt input bar (*"Ask Gemini Enterprise"*), click the **Connectors icon (⊶ / sliders icon)** at the bottom-left corner next to \`+\`. Ensure **"Enable all connectors"** is toggled **ON**.
- [ ] **Step 3 — Authorize Workplace Tools:** In the popover menu, click the blue **"Authorize"** button next to your accounts (e.g. **Microsoft Outlook**, **OneDrive**, **Microsoft Entra ID**, **Google Workspace / Drive**, **Jira**, **ServiceNow**, **Enterprise Web Search**).
- [ ] **Step 4 — Complete Item Checklists:** Follow the item checklists below to activate your custom agents and verify research notebooks.

---

## 🤖 2. Your Custom Agents (Action Required)
Your agents have been transferred into your drafts with their instructions and tools intact.

${agList}

👉 **[Go to My Agents](${data.agentsWebUrl})**

> 💡 *Note: If your agent connects to Google Workspace (Gmail, Drive, Calendar), clicking "Publish" will ask you to approve access so the agent can work on your behalf.*

---

## 📓 3. Your Research Notebooks (Action Required)
All of your notebooks, sources, and generated study guides have been restored. Your generated presentations and briefing documents are also attached to this email.

${nbList}

👉 **[Go to My Notebooks](${data.notebooksWebUrl})**

---

## 💬 4. Previous Conversations Restored
All of your past search and chat conversations (**${data.sessions.length} conversation threads**) have been transferred to your new account:
- [ ] **Step 1 — Confirm History:** Open Gemini and verify your past conversations appear in your left-hand **History** sidebar whenever you chat.

${data.memories.length > 0 ? `
---

## 🧠 5. Personalized AI Memories Restored
All of your learned preferences and personalized facts (**${data.memories.length} memories**) have been safely transferred:
- [ ] **Step 1 — Confirm Memories:** Verify your personalized preferences under Gemini Enterprise Settings &rarr; **Personalization & Memories**.
${data.memories.map(m => `- *"${m.details?.fact || m.displayName}"*`).join('\n')}
` : ''}
${sourcesAuditSection}
---

*Gemini Enterprise Support*
`;
  }

  /**
   * Generates clean, modern, end-user friendly HTML email with checkboxes
   */
  generateHtmlReport(data: UserHandoverData): string {
    const agCards = data.agents.length > 0
      ? data.agents.map(ag => {
          const rawSharedList = ag.details?.sharedWith as string[] | undefined;
          const cleanUserEmail = data.userEmail.toLowerCase().trim();
          const filteredCollaborators = (rawSharedList || []).filter(s => {
            const cleanS = s.replace(/^\[Group\]\s*/i, '').replace(/^user:/i, '').toLowerCase().trim();
            return cleanS !== cleanUserEmail && !cleanS.includes('gserviceaccount.com') && cleanS !== 'private (author only)';
          });

          const isPrivate = filteredCollaborators.length === 0;
          const sharedWithText = isPrivate ? 'Private (Only You)' : filteredCollaborators.join(', ');
          const directAgentUrl = this.buildAppUrl(data.targetCid, data.targetLocation, data.idpProvider, `agents/${ag.targetId || ag.id}`);

          const badge = isPrivate
            ? `<span style="background-color: #064e3b; color: #a7f3d0; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 6px;">🔒 Private</span>`
            : `<span style="background-color: #451a03; color: #fde68a; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 6px;">👥 Shared</span>`;

          return `
            <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 14px 16px; margin-bottom: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <a href="${directAgentUrl}" target="_blank" style="color: #60a5fa; font-weight: 700; font-size: 14px; text-decoration: none;">🤖 ${ag.displayName} &rarr;</a>
                ${badge}
              </div>
              
              <div style="margin-top: 4px;">
                <label style="display: flex; align-items: flex-start; cursor: pointer; user-select: none; margin-bottom: ${isPrivate ? '0' : '8px'};">
                  <input type="checkbox" style="margin: 2px 10px 0 0; width: 16px; height: 16px; accent-color: #2563eb; cursor: pointer;">
                  <span style="font-size: 13px; color: #e2e8f0; line-height: 1.4;">
                    <strong>Step 1:</strong> Click into agent and press <strong>Publish</strong> in the top right to activate.
                  </span>
                </label>

                ${!isPrivate ? `
                <label style="display: flex; align-items: flex-start; cursor: pointer; user-select: none;">
                  <input type="checkbox" style="margin: 2px 10px 0 0; width: 16px; height: 16px; accent-color: #2563eb; cursor: pointer;">
                  <span style="font-size: 13px; color: #e2e8f0; line-height: 1.4;">
                    <strong>Step 2:</strong> Click <strong>Share</strong> and re-add: <code style="background-color: #0f172a; padding: 2px 6px; border-radius: 4px; color: #93c5fd; font-size: 12px;">${filteredCollaborators.join(', ')}</code>
                  </span>
                </label>
                ` : ''}
              </div>
            </div>
          `;
        }).join('')
      : '<p style="color: #94a3b8; font-size: 13px; margin: 0;">No custom agents found for your account.</p>';

    const nbCards = data.notebooks.length > 0
      ? data.notebooks.map(nb => {
          const directNbUrl = this.buildAppUrl(data.targetCid, data.targetLocation, data.idpProvider, `notebook/${nb.targetId || nb.id}`);
          const restoredCount = nb.details?.sourcesRestored ?? nb.details?.sourcesCount ?? 0;
          const failedCount = nb.details?.sourcesFailed ?? 0;
          const sources = Array.isArray(nb.details?.sources) ? nb.details.sources : [];

          const successBadge = `<span style="background-color: #064e3b; color: #a7f3d0; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 6px;">📄 ${restoredCount} Sources Ready</span>`;
          const failedBadge = failedCount > 0 
            ? `<span style="background-color: #7f1d1d; color: #fca5a5; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 6px; margin-left: 6px;">⚠️ ${failedCount} Failed</span>` 
            : '';

          let hiddenSourcesHtml = '';
          if (sources.length > 0) {
            hiddenSourcesHtml = `
              <div style="display: none; max-height: 0px; overflow: hidden; font-size: 0px; line-height: 0px; mso-hide: all; opacity: 0;">
                View Restored Source Documents (${sources.length})
                ${sources.map((s: any) => s.title).join(', ')}
              </div>
            `;
          }

          return `
            <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 14px 16px; margin-bottom: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <a href="${directNbUrl}" target="_blank" style="color: #34d399; font-weight: 700; font-size: 14px; text-decoration: none;">📓 ${nb.displayName} &rarr;</a>
                <div>
                  ${successBadge}
                  ${failedBadge}
                </div>
              </div>

              <div style="margin-top: 4px;">
                <label style="display: flex; align-items: flex-start; cursor: pointer; user-select: none; margin-bottom: 8px;">
                  <input type="checkbox" style="margin: 2px 10px 0 0; width: 16px; height: 16px; accent-color: #059669; cursor: pointer;">
                  <span style="font-size: 13px; color: #e2e8f0; line-height: 1.4;">
                    <strong>Step 1:</strong> Open notebook in Gemini to verify restored sources and study materials.
                  </span>
                </label>

                <label style="display: flex; align-items: flex-start; cursor: pointer; user-select: none; margin-bottom: 8px;">
                  <input type="checkbox" style="margin: 2px 10px 0 0; width: 16px; height: 16px; accent-color: #059669; cursor: pointer;">
                  <span style="font-size: 13px; color: #e2e8f0; line-height: 1.4;">
                    <strong>Step 2:</strong> Download & extract attached <strong>NotebookLM_Artifacts.zip</strong> to access PowerPoint (.pptx) decks and infographics.
                  </span>
                </label>

                <label style="display: flex; align-items: flex-start; cursor: pointer; user-select: none;">
                  <input type="checkbox" style="margin: 2px 10px 0 0; width: 16px; height: 16px; accent-color: #059669; cursor: pointer;">
                  <span style="font-size: 13px; color: #e2e8f0; line-height: 1.4;">
                    <strong>Step 3:</strong> (Optional) Click <strong>Share</strong> inside the notebook if you'd like to invite team members.
                  </span>
                </label>
              </div>
              ${hiddenSourcesHtml}
            </div>
          `;
        }).join('')
      : '<p style="color: #94a3b8; font-size: 13px; margin: 0;">No research notebooks found for your account.</p>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Welcome to Gemini Enterprise</title>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach((cb, idx) => {
        const key = 'gemini_migration_cb_' + idx;
        if (localStorage.getItem(key) === 'true') {
          cb.checked = true;
        }
        cb.addEventListener('change', () => {
          localStorage.setItem(key, cb.checked);
        });
      });
    });
  </script>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 24px;">
  <div style="max-width: 640px; margin: 0 auto; background-color: #0f172a; border: 1px solid #334155; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);">
    
    <!-- Hero Header -->
    <div style="background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%); padding: 32px 28px; text-align: left; color: #ffffff;">
      <h1 style="margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em;">
        🚀 Welcome to Your New Gemini Enterprise Workspace
      </h1>
      <p style="margin: 8px 0 0 0; font-size: 14px; opacity: 0.95; line-height: 1.4;">
        Hi <strong>${data.userEmail}</strong>, your agents, research notebooks, and past conversations have been transferred and are ready for you. Complete the checklists below to finalize your migration.
      </p>
    </div>

    <!-- Body Content -->
    <div style="padding: 28px 24px; background-color: #0f172a;">
      <!-- INJECT_PART_NOTICE -->
      
      <!-- Section 1: First-Time Setup & Connector Authentication -->
      <div style="background-color: #1e1b4b; border: 2px solid #6366f1; border-radius: 12px; padding: 20px; margin-bottom: 28px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <h2 style="margin: 0; font-size: 16px; font-weight: 700; color: #ffffff; display: flex; align-items: center; gap: 8px;">
            <span>🔑</span> 1. First-Time Login & Connector Authorization (Action Required)
          </h2>
          <a href="${data.mainAppUrl}" target="_blank" style="background-color: #4f46e5; color: #ffffff; padding: 8px 16px; border-radius: 8px; text-decoration: none; font-size: 12px; font-weight: 700; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.4);">
            Launch Gemini &rarr;
          </a>
        </div>
        
        <p style="margin: 0 0 14px 0; font-size: 13px; color: #c7d2fe; line-height: 1.5;">
          Please complete these required steps to authorize Gemini and your transferred custom agents to access your workplace tools:
        </p>

        <div style="background-color: #0f172a; border-radius: 8px; padding: 16px;">
          <label style="display: flex; align-items: flex-start; cursor: pointer; user-select: none; margin-bottom: 12px;">
            <input type="checkbox" style="margin: 2px 10px 0 0; width: 16px; height: 16px; accent-color: #4f46e5; cursor: pointer;">
            <span style="font-size: 13px; color: #e2e8f0; line-height: 1.4;">
              <strong>Step 1 — Log in:</strong> Open <a href="${data.mainAppUrl}" target="_blank" style="color: #93c5fd; text-decoration: underline; font-weight: 600;">Gemini Enterprise Workspace</a> using your corporate email (<strong>${data.userEmail}</strong>).
            </span>
          </label>

          <label style="display: flex; align-items: flex-start; cursor: pointer; user-select: none; margin-bottom: 12px;">
            <input type="checkbox" style="margin: 2px 10px 0 0; width: 16px; height: 16px; accent-color: #4f46e5; cursor: pointer;">
            <span style="font-size: 13px; color: #e2e8f0; line-height: 1.4;">
              <strong>Step 2 — Open Connectors:</strong> In the prompt input bar (<em>"Ask Gemini Enterprise"</em>), click the <strong>Connectors icon (⊶ / sliders icon)</strong> at the bottom-left corner next to <code>+</code>. Make sure <strong>"Enable all connectors"</strong> is toggled <strong>ON</strong>.
            </span>
          </label>

          <label style="display: flex; align-items: flex-start; cursor: pointer; user-select: none; margin-bottom: 12px;">
            <input type="checkbox" style="margin: 2px 10px 0 0; width: 16px; height: 16px; accent-color: #4f46e5; cursor: pointer;">
            <span style="font-size: 13px; color: #e2e8f0; line-height: 1.4;">
              <strong>Step 3 — Authorize Workplace Tools:</strong> In the popover menu, click the blue <span style="background-color: #1e293b; color: #60a5fa; border: 1px solid #3b82f6; padding: 1px 6px; border-radius: 4px; font-weight: 600; font-size: 11px;">Authorize</span> button on your connected tools (e.g. <strong>Microsoft Outlook</strong>, <strong>OneDrive</strong>, <strong>Google Workspace / Drive</strong>, <strong>Jira</strong>, <strong>Enterprise Web Search</strong>).
            </span>
          </label>

          <label style="display: flex; align-items: flex-start; cursor: pointer; user-select: none;">
            <input type="checkbox" style="margin: 2px 10px 0 0; width: 16px; height: 16px; accent-color: #4f46e5; cursor: pointer;">
            <span style="font-size: 13px; color: #e2e8f0; line-height: 1.4;">
              <strong>Step 4 — Complete Item Checklists:</strong> Work through the checklists below to activate your custom agents and verify research notebooks.
            </span>
          </label>
        </div>
      </div>

      <!-- Section 2: Agents -->
      <div style="margin-bottom: 28px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <h2 style="margin: 0; font-size: 16px; font-weight: 700; color: #f8fafc;">
            🤖 2. Your Custom Agents (Action Required)
          </h2>
          <a href="${data.agentsWebUrl}" target="_blank" style="background-color: #2563eb; color: #ffffff; padding: 6px 14px; border-radius: 8px; text-decoration: none; font-size: 12px; font-weight: 600;">
            Open My Agents &rarr;
          </a>
        </div>
        <p style="margin: 0 0 12px 0; font-size: 13px; color: #94a3b8; line-height: 1.4;">
          Your custom agents are transferred into your drafts. Use the checkable boxes below to activate and re-share them:
        </p>
        ${agCards}
      </div>

      <!-- Section 3: Notebooks -->
      <div style="margin-bottom: 28px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <h2 style="margin: 0; font-size: 16px; font-weight: 700; color: #f8fafc;">
            📓 3. Your Research Notebooks (Action Required)
          </h2>
          <a href="${data.notebooksWebUrl}" target="_blank" style="background-color: #059669; color: #ffffff; padding: 6px 14px; border-radius: 8px; text-decoration: none; font-size: 12px; font-weight: 600;">
            Open My Notebooks &rarr;
          </a>
        </div>
        <p style="margin: 0 0 12px 0; font-size: 13px; color: #94a3b8; line-height: 1.4;">
          All your notebooks and research sources are ready. Generated presentations and briefing documents are attached to this email. Complete these steps:
        </p>
        ${nbCards}
      </div>

      <!-- Section 4: Chats Info Callout -->
      <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 18px 20px; margin-bottom: 28px;">
        <h3 style="margin: 0 0 6px 0; font-size: 14px; font-weight: 700; color: #f8fafc;">
          💬 4. Previous Conversations Restored (${data.sessions.length} Threads)
        </h3>
        <p style="margin: 0 0 10px 0; font-size: 13px; color: #cbd5e1; line-height: 1.5;">
          All your past questions, detailed AI answers, and source citations have been migrated to your new account.
        </p>
        <label style="display: flex; align-items: flex-start; cursor: pointer; user-select: none;">
          <input type="checkbox" style="margin: 2px 10px 0 0; width: 16px; height: 16px; accent-color: #2563eb; cursor: pointer;">
          <span style="font-size: 13px; color: #e2e8f0; line-height: 1.4;">
            <strong>Step 1:</strong> Open Gemini and confirm your past conversation threads appear in your left-hand <strong>History</strong> sidebar.
          </span>
        </label>
      </div>
${data.memories.length > 0 ? `
      <!-- Section 5: Memories Info Callout -->
      <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 18px 20px; margin-bottom: 28px;">
        <h3 style="margin: 0 0 6px 0; font-size: 14px; font-weight: 700; color: #f8fafc;">
          🧠 5. Personalized AI Memories Restored (${data.memories.length} Memories)
        </h3>
        <p style="margin: 0 0 10px 0; font-size: 13px; color: #cbd5e1; line-height: 1.5;">
          Your personalized facts and AI preferences have been migrated to your new workspace.
        </p>
        <label style="display: flex; align-items: flex-start; cursor: pointer; user-select: none;">
          <input type="checkbox" style="margin: 2px 10px 0 0; width: 16px; height: 16px; accent-color: #2563eb; cursor: pointer;">
          <span style="font-size: 13px; color: #e2e8f0; line-height: 1.4;">
            <strong>Step 1:</strong> Confirm your preferences under <em>Settings &rarr; Personalization & Memories</em>.
          </span>
        </label>
      </div>` : ''}

      <!-- INJECT_OVERSIZED_NOTICE -->
    </div>

    <!-- Clean Footer -->
    <div style="background-color: #0b0f19; padding: 16px 24px; border-top: 1px solid #1e293b; text-align: center; font-size: 11px; color: #64748b;">
      Gemini Enterprise • Handover Notification
    </div>

  </div>
</body>
</html>`;
  }



  /**
   * Renders structured reports, study guides, and briefing docs into executive formatted HTML
   */
  renderDocumentHtml(
    title: string,
    type: string,
    notebookName: string,
    content: string,
    options?: import('../services/notebookLmArtifactFormatter.js').DocumentHtmlOptions
  ): string {
    return NotebookLmArtifactFormatter.renderDocumentHtml(title, type, notebookName, content, options);
  }

  /**
   * Renders an interactive 16:9 carousel presentation viewer matching the PowerPoint slide deck
   */
  renderSlideDeckPresentation(title: string, notebookName: string, content: string): string {
    return NotebookLmArtifactFormatter.renderSlideDeckPresentation(title, notebookName, content);
  }

  /**
   * Generates a native Microsoft PowerPoint (.pptx) presentation matching direct NotebookLM exports
   */
  async generatePptxPresentation(
    title: string,
    notebookName: string,
    content: string,
    outputPath: string,
    options?: import('../services/notebookLmArtifactFormatter.js').PptxPresentationOptions
  ): Promise<void> {
    return NotebookLmArtifactFormatter.generatePptxPresentation(title, notebookName, content, outputPath, options);
  }

  /**
   * Generates a native Microsoft Word (.docx) document matching direct NotebookLM / Google Docs exports
   */
  async generateDocxDocument(
    title: string,
    type: string,
    notebookName: string,
    content: string,
    outputPath: string,
    options?: import('../services/notebookLmArtifactFormatter.js').DocxDocumentOptions
  ): Promise<void> {
    return NotebookLmArtifactFormatter.generateDocxDocument(title, type, notebookName, content, outputPath, options);
  }

  /**
   * Checks if ImageMagick (convert) is available in the execution environment
   */
  static isImageMagickAvailable(): boolean {
    try {
      execSync('convert -version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checks if ffmpeg is available in the execution environment
   */
  static isFfmpegAvailable(): boolean {
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Packages candidate files into a compressed .zip archive using JSZip.
   */
  async createZipArchive(
    zipFilePath: string,
    files: Array<{ filename: string; path: string }>
  ): Promise<number> {
    const zip = new JSZip();
    for (const f of files) {
      if (fs.existsSync(f.path)) {
        zip.file(f.filename, fs.readFileSync(f.path));
      }
    }
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 }
    });
    fs.writeFileSync(zipFilePath, buffer);
    return buffer.length;
  }

  /**
   * Optimizes presentation media, videos, and infographics using ImageMagick and ffmpeg if available.
   * Compresses internal PPTX slide backgrounds (JPEG/PNG) and large infographics
   * to high-efficiency presentation quality (quality 82), and compresses large Explainer Videos
   * (.mp4) via ffmpeg 720p H.264 CRF 28 to ensure all media fit securely inside email handover archives.
   */
  async optimizeMediaArtifact(
    file: { filename: string; path: string; size: number },
    outputDir: string
  ): Promise<{ filename: string; path: string; size: number }> {
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      const ext = path.extname(file.filename).toLowerCase();

      // 1. Explainer Video (.mp4) optimization via ffmpeg
      if (ext === '.mp4') {
        if (!UserReportGenerator.isFfmpegAvailable()) {
          return file;
        }
        // Only compress if video is larger than 12 MB
        if (file.size > 12 * 1024 * 1024) {
          const optVideoPath = path.join(outputDir, file.filename);
          try {
            logger.info(`Compressing oversized video "${file.filename}" (${(file.size / 1048576).toFixed(1)} MB) with ffmpeg...`);
            await execFileAsync(
              'ffmpeg',
              ['-y', '-i', file.path, '-vf', 'scale=-2:720', '-c:v', 'libx264', '-crf', '28', '-preset', 'fast', '-c:a', 'aac', '-b:a', '64k', optVideoPath],
              { timeout: 180000 }
            );
            if (fs.existsSync(optVideoPath)) {
              const optStat = fs.statSync(optVideoPath);
              if (optStat.size < file.size) {
                logger.info(`Optimized video "${file.filename}": ${(file.size / 1048576).toFixed(1)} MB -> ${(optStat.size / 1048576).toFixed(1)} MB (-${((1 - optStat.size / file.size) * 100).toFixed(0)}%)`);
                return { filename: file.filename, path: optVideoPath, size: optStat.size };
              }
            }
          } catch (vidErr: any) {
            logger.warn(`Video compression failed for "${file.filename}": ${vidErr.message}`);
          }
        }
        return file;
      }

      if (!UserReportGenerator.isImageMagickAvailable()) {
        return file;
      }

      // 1. PPTX presentation optimization
      if (ext === '.pptx') {
        const origBuf = fs.readFileSync(file.path);
        const pptxZip = await JSZip.loadAsync(origBuf);
        const mediaEntries = Object.keys(pptxZip.files).filter(k => k.startsWith('ppt/media/'));

        if (mediaEntries.length === 0) {
          return file;
        }

        let modified = false;
        const tmpPrefix = path.join(outputDir, `tmp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
        const tmpIn = `${tmpPrefix}_in.tmp`;
        const tmpOut = `${tmpPrefix}_out.tmp`;

        try {
          for (const entry of mediaEntries) {
            const imgBuf = await pptxZip.files[entry].async('nodebuffer');
            // Only optimize if image is > 150 KB
            if (imgBuf.length > 150 * 1024) {
              fs.writeFileSync(tmpIn, imgBuf);
              try {
                await execFileAsync('convert', [tmpIn, '-quality', '82', `jpg:${tmpOut}`], { timeout: 30000 });
                if (fs.existsSync(tmpOut)) {
                  const optImgBuf = fs.readFileSync(tmpOut);
                  if (optImgBuf.length < imgBuf.length) {
                    pptxZip.file(entry, optImgBuf);
                    modified = true;
                  }
                  fs.unlinkSync(tmpOut);
                }
              } catch {}
              if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
            }
          }

          if (modified) {
            const optPptxBuf = await pptxZip.generateAsync({
              type: 'nodebuffer',
              compression: 'DEFLATE',
              compressionOptions: { level: 6 }
            });
            const optPptxPath = path.join(outputDir, file.filename);
            fs.writeFileSync(optPptxPath, optPptxBuf);
            const optStat = fs.statSync(optPptxPath);
            if (optStat.size < file.size) {
              logger.info(`Optimized PPTX "${file.filename}": ${(file.size / 1048576).toFixed(1)} MB -> ${(optStat.size / 1048576).toFixed(1)} MB (-${((1 - optStat.size / file.size) * 100).toFixed(0)}%)`);
              return { filename: file.filename, path: optPptxPath, size: optStat.size };
            }
          }
        } finally {
          try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch {}
          try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
        }
      }

      // 2. High-resolution Infographics (.jpg, .png)
      if (ext === '.jpg' || ext === '.png') {
        if (file.size > 400 * 1024) {
          const optImgPath = path.join(outputDir, file.filename);
          try {
            await execFileAsync('convert', [file.path, '-quality', '82', optImgPath], { timeout: 30000 });
            if (fs.existsSync(optImgPath)) {
              const optStat = fs.statSync(optImgPath);
              if (optStat.size < file.size) {
                logger.info(`Optimized image "${file.filename}": ${(file.size / 1048576).toFixed(1)} MB -> ${(optStat.size / 1048576).toFixed(1)} MB (-${((1 - optStat.size / file.size) * 100).toFixed(0)}%)`);
                return { filename: file.filename, path: optImgPath, size: optStat.size };
              }
            }
          } catch {}
        }
      }

      return file;
    } catch (err: any) {
      logger.warn(`Media optimization skipped for "${file.filename}": ${err.message}`);
      return file;
    }
  }

  /**
   * Generates folders, reports, and exports NotebookLM artifacts in their intended rich formats (PPTX, DOCX, HTML, MD, Images)
   */
  async generateAllUserBundles(
    report: MigrationReport,
    options?: { authService?: GcpAuthService; discoveryClient?: any }
  ): Promise<Record<string, { folderPath: string; markdownPath: string; htmlPath: string; notebookArtifactsCount: number }>> {
    const userGroups = this.groupReportByUser(report);
    const resultSummary: Record<string, any> = {};

    // Initialize DiscoveryEngineClient for live artifact enrichment if possible
    let discoveryClient = options?.discoveryClient;
    if (!discoveryClient && report.sourceEnvironment?.projectId) {
      try {
        const { DiscoveryEngineClient } = await import('../services/discoveryEngine.js');
        const auth = options?.authService || new GcpAuthService();
        discoveryClient = new DiscoveryEngineClient(auth);
      } catch (e: any) {
        logger.debug(`Could not create DiscoveryEngineClient for live artifact enrichment: ${e.message}`);
      }
    }

    for (const [userEmail, userData] of userGroups.entries()) {
      const sanitizedEmail = userEmail.replace(/[^a-zA-Z0-9@._-]/g, '_');
      const userFolder = path.join(this.baseDir, sanitizedEmail);
      const nbArtifactsFolder = path.join(userFolder, 'notebook_artifacts');

      if (!fs.existsSync(nbArtifactsFolder)) {
        fs.mkdirSync(nbArtifactsFolder, { recursive: true });
      }

      // 1. Write MIGRATION_CHECKLIST.md
      const mdContent = this.generateMarkdownReport(userData);
      const mdPath = path.join(userFolder, 'MIGRATION_CHECKLIST.md');
      fs.writeFileSync(mdPath, mdContent, 'utf8');

      // 2. Write MIGRATION_CHECKLIST.html
      const htmlContent = this.generateHtmlReport(userData);
      const htmlPath = path.join(userFolder, 'MIGRATION_CHECKLIST.html');
      fs.writeFileSync(htmlPath, htmlContent, 'utf8');

      // 3. Extract & Save NotebookLM Artifacts & Notes in intended rich formats (PPTX, DOCX, HTML, Markdown, Images)
      let nbArtifactCount = 0;
      for (const nb of userData.notebooks) {
        const nbId = nb.id || (nb as any).notebookId;
        let artifacts = (nb.details?.artifacts && Array.isArray(nb.details.artifacts)) ? nb.details.artifacts : [];

        // Check if artifacts need live enrichment (missing rawArtifact or download URLs)
        const needsEnrichment = artifacts.length === 0 || artifacts.some((a: any) => !a.rawArtifact || (!a.rawArtifact.slides?.pptxDownloadUrl && !a.rawArtifact.infographic && !a.rawArtifact.audioOverview && !a.rawArtifact.explainerVideo && !a.rawArtifact.app));

        if (needsEnrichment && discoveryClient && report.sourceEnvironment?.projectId && nbId) {
          try {
            const liveArtifacts = await discoveryClient.listArtifacts(nbId, report.sourceEnvironment, userData.userEmail);
            if (liveArtifacts && liveArtifacts.length > 0) {
              logger.info(`Enriched ${liveArtifacts.length} live artifacts with signed URLs for notebook "${nb.displayName}" (${nbId})`);
              nb.details = nb.details || { sourcesCount: 0, sourcesRestored: 0, sourcesFailed: 0, sources: [] };
              nb.details.artifacts = liveArtifacts.map((a: any) => ({
                id: a.artifactId || a.name?.split('/').pop(),
                title: a.title || NotebookLmArtifactFormatter.formatArtifactTypeName(a.type),
                type: NotebookLmArtifactFormatter.formatArtifactTypeName(a.type),
                content: NotebookLmArtifactFormatter.extractTextFromArtifact(a),
                rawArtifact: a
              }));
              artifacts = nb.details.artifacts;
            }
          } catch (enrichErr: any) {
            logger.debug(`Live artifact enrichment skipped for ${nbId}: ${enrichErr.message}`);
          }
        }

        if (artifacts && Array.isArray(artifacts)) {
          for (const art of artifacts) {
            const rawArt = art.rawArtifact || art;
            const artTitle = art.title || art.type || rawArt.title || 'Artifact';
            const artType = (art.type || rawArt.type || '').toLowerCase();
            const textContent = (art.content || rawArt.content || art.extractedText || '').trim();

            const cleanBase = NotebookLmArtifactFormatter.cleanArtifactFilename(nb.displayName, artTitle, '');
            const cleanMarkdown = NotebookLmArtifactFormatter.cleanNotebookLmMarkdown(artTitle, textContent);

            // A. SLIDE DECKS & PRESENTATIONS
            if (artType.includes('slide') || artType.includes('presentation') || rawArt.slides) {
              const pptxUrl = rawArt.slides?.pptxDownloadUrl || rawArt.pptxDownloadUrl;
              const pdfUrl = rawArt.slides?.pdfDownloadUrl || rawArt.pdfDownloadUrl;
              const slidesData = rawArt.slides?.slides || rawArt.slides;

              // 1. Native Microsoft PowerPoint (.pptx) - direct official Google export or high-fidelity synthesis
              const pptxPath = path.join(nbArtifactsFolder, `${cleanBase}.pptx`);
              await this.generatePptxPresentation(artTitle, nb.displayName, textContent, pptxPath, {
                pptxDownloadUrl: pptxUrl,
                pdfDownloadUrl: pdfUrl,
                slidesData
              });
              if (fs.existsSync(pptxPath) && fs.statSync(pptxPath).size > 1024) {
                nbArtifactCount++;
              }

              // If native PDF was downloaded or exists, count it
              const pdfPath = path.join(nbArtifactsFolder, `${cleanBase}.pdf`);
              if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1024) {
                nbArtifactCount++;
              }

              // 2. Interactive HTML Presentation Slide Deck
              const deckHtml = this.renderSlideDeckPresentation(artTitle, nb.displayName, textContent);
              const deckPath = path.join(nbArtifactsFolder, `${cleanBase}_SlideDeck.html`);
              fs.writeFileSync(deckPath, deckHtml, 'utf8');

              // 3. Clean Markdown companion
              const mdFilePath = path.join(nbArtifactsFolder, `${cleanBase}.md`);
              fs.writeFileSync(mdFilePath, cleanMarkdown, 'utf8');
            }
            // B. INFOGRAPHICS & VISUAL GRAPHICS
            else if (artType.includes('infographic') || rawArt.infographic) {
              const infoList = rawArt.infographic?.infographics || [];
              const infoImgUrl = infoList[0]?.image?.url || rawArt.imageUrl;
              let imgBuffer: Buffer | undefined;

              const imgPath = path.join(nbArtifactsFolder, `${cleanBase}.jpg`);
              // 1. Download official high-resolution 2048x2048 infographic image
              if (infoImgUrl) {
                const downloaded = await NotebookLmArtifactFormatter.downloadFile(infoImgUrl, imgPath);
                if (downloaded) {
                  try {
                    imgBuffer = fs.readFileSync(imgPath);
                    nbArtifactCount++;
                  } catch {}
                }
              }

              // If download did not happen, check if authentic image already exists on disk
              if (!imgBuffer && fs.existsSync(imgPath)) {
                try {
                  const stat = fs.statSync(imgPath);
                  if (stat.size > 50 * 1024) {
                    imgBuffer = fs.readFileSync(imgPath);
                    nbArtifactCount++;
                  }
                } catch {}
              }

              // 2. Native Microsoft Word (.docx) with embedded high-res graphic
              const docxPath = path.join(nbArtifactsFolder, `${cleanBase}.docx`);
              await this.generateDocxDocument(artTitle, 'Infographic', nb.displayName, textContent, docxPath, {
                imageBuffer: imgBuffer,
                imageUrl: `${cleanBase}.jpg`,
                caption: `Figure: ${artTitle} (NotebookLM Infographic)`
              });
              nbArtifactCount++;

              // 3. Executive HTML Document with embedded infographic banner
              const docHtml = this.renderDocumentHtml(artTitle, 'Infographic', nb.displayName, textContent, {
                imageUrl: `${cleanBase}.jpg`
              });
              const docPath = path.join(nbArtifactsFolder, `${cleanBase}.html`);
              fs.writeFileSync(docPath, docHtml, 'utf8');

              // 4. Clean Markdown companion
              const mdFilePath = path.join(nbArtifactsFolder, `${cleanBase}.md`);
              fs.writeFileSync(mdFilePath, cleanMarkdown, 'utf8');
            }
            // C. AUDIO OVERVIEWS & PODCAST DEEP DIVES
            else if (artType.includes('audio') || rawArt.audioOverview) {
              const audioUrl = rawArt.audioOverview?.downloadUrl || rawArt.audioOverview?.streamingUrl;
              const audioPath = path.join(nbArtifactsFolder, `${cleanBase}.wav`);
              if (audioUrl) {
                const downloaded = await NotebookLmArtifactFormatter.downloadFile(audioUrl, audioPath);
                if (downloaded) {
                  nbArtifactCount++;
                }
              } else if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1024 * 1024) {
                nbArtifactCount++;
              }

              // Interactive Audio Player HTML
              const safeAudioTitle = artTitle.replace(/"/g, '&quot;');
              const playerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${safeAudioTitle} - Audio Overview</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="min-h-screen flex items-center justify-center p-6 bg-slate-950 text-white font-sans">
  <div class="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl flex flex-col items-center text-center">
    <div class="w-20 h-20 rounded-2xl bg-indigo-600/20 text-indigo-400 flex items-center justify-center text-3xl mb-4 border border-indigo-500/30">
      <i class="fa-solid fa-podcast"></i>
    </div>
    <span class="px-3 py-1 bg-indigo-950 text-indigo-400 text-xs font-semibold rounded-full border border-indigo-800 mb-2">NotebookLM Deep Dive Audio</span>
    <h1 class="text-xl font-bold text-white mb-2">${safeAudioTitle}</h1>
    <p class="text-xs text-slate-400 mb-6">Autonomous multi-speaker podcast audio overview from Notebook: <strong>${nb.displayName}</strong></p>
    <audio controls class="w-full mb-6">
      <source src="${cleanBase}.wav" type="audio/wav">
      <source src="${audioUrl || ''}" type="audio/wav">
      Your browser does not support the audio element.
    </audio>
    <div class="w-full bg-slate-950 rounded-xl p-4 border border-slate-800 text-left text-xs text-slate-400">
      <div>Status: <span class="text-emerald-400 font-semibold">✓ Preserved Offline</span></div>
    </div>
  </div>
</body>
</html>`;
              fs.writeFileSync(path.join(nbArtifactsFolder, `${cleanBase}_AudioPlayer.html`), playerHtml, 'utf8');
            }
            // D. EXPLAINER VIDEOS & MEDIA OVERVIEWS
            else if (artType.includes('video') || rawArt.explainerVideo) {
              const videoUrl = rawArt.explainerVideo?.downloadUrl || rawArt.explainerVideo?.playbackUrl;
              const videoPath = path.join(nbArtifactsFolder, `${cleanBase}.mp4`);
              if (videoUrl) {
                const downloaded = await NotebookLmArtifactFormatter.downloadFile(videoUrl, videoPath);
                if (downloaded) {
                  nbArtifactCount++;
                }
              } else if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 1024 * 1024) {
                nbArtifactCount++;
              }

              // Interactive Video Player HTML
              const safeVideoTitle = artTitle.replace(/"/g, '&quot;');
              const playerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${safeVideoTitle} - Video Overview</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="min-h-screen flex items-center justify-center p-6 bg-slate-950 text-white font-sans">
  <div class="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl flex flex-col items-center text-center">
    <div class="w-full aspect-video bg-black rounded-2xl overflow-hidden mb-4 border border-slate-800 flex items-center justify-center">
      <video controls class="w-full h-full object-contain">
        <source src="${cleanBase}.mp4" type="video/mp4">
        <source src="${videoUrl || ''}" type="video/mp4">
        Your browser does not support HTML5 video.
      </video>
    </div>
    <span class="px-3 py-1 bg-indigo-950 text-indigo-400 text-xs font-semibold rounded-full border border-indigo-800 mb-2">NotebookLM Explainer Video</span>
    <h1 class="text-xl font-bold text-white mb-1">${safeVideoTitle}</h1>
    <p class="text-xs text-slate-400 mb-4">Autonomous AI video overview from Notebook: <strong>${nb.displayName}</strong></p>
    <div class="w-full bg-slate-950 rounded-xl p-3 border border-slate-800 text-left text-xs text-slate-400 flex items-center justify-between">
      <div>Status: <span class="text-emerald-400 font-semibold">✓ Preserved Offline</span></div>
      <a href="${cleanBase}.mp4" download class="text-indigo-400 hover:text-indigo-300 font-medium flex items-center gap-1">
        <i class="fa-solid fa-download"></i> Download Video (.mp4)
      </a>
    </div>
  </div>
</body>
</html>`;
              fs.writeFileSync(path.join(nbArtifactsFolder, `${cleanBase}_VideoPlayer.html`), playerHtml, 'utf8');

              const mdFilePath = path.join(nbArtifactsFolder, `${cleanBase}.md`);
              fs.writeFileSync(mdFilePath, `# Video Overview: ${artTitle}\n\n- Notebook: **${nb.displayName}**\n- Media File: \`${cleanBase}.mp4\`\n- Interactive Player: \`${cleanBase}_VideoPlayer.html\`\n`, 'utf8');
            }
            // E. INTERACTIVE LEARNING APPS, QUIZZES & FLASHCARDS
            else if (artType.includes('app') || rawArt.app || rawArt.type === 'ARTIFACT_TYPE_APP') {
              let appData = NotebookLmArtifactFormatter.extractAppData(rawArt);
              const appHtml = rawArt.app?.appHtml;

              // If not found directly in rawArt, check if HTML already exists on disk
              if (!appData) {
                const existingHtmlPath = path.join(nbArtifactsFolder, `${cleanBase}.html`);
                if (fs.existsSync(existingHtmlPath)) {
                  try {
                    const diskHtml = fs.readFileSync(existingHtmlPath, 'utf8');
                    appData = NotebookLmArtifactFormatter.extractAppData({ content: diskHtml });
                  } catch {}
                }
              }

              let generatedApp = false;

              if (appData?.quiz && Array.isArray(appData.quiz) && appData.quiz.length > 0) {
                // 1. Zero-dependency interactive HTML5 Quiz Application (loads instantly, no blank screen)
                const quizHtml = NotebookLmArtifactFormatter.renderInteractiveQuizHtml(artTitle, nb.displayName, appData.quiz, appData.topics);
                const appPath = path.join(nbArtifactsFolder, `${cleanBase}.html`);
                fs.writeFileSync(appPath, quizHtml, 'utf8');
                nbArtifactCount++;

                // 2. Printable Study Guide & Question Bank (.docx)
                const quizMd = NotebookLmArtifactFormatter.formatQuizMarkdown(artTitle, nb.displayName, appData.quiz);
                const docxPath = path.join(nbArtifactsFolder, `${cleanBase}.docx`);
                await this.generateDocxDocument(artTitle, 'Quiz / Study Guide', nb.displayName, quizMd, docxPath);
                nbArtifactCount++;

                // 3. Clean Markdown Question Bank
                const mdFilePath = path.join(nbArtifactsFolder, `${cleanBase}.md`);
                fs.writeFileSync(mdFilePath, quizMd, 'utf8');

                // 4. Raw Angular app with polyfilled API as secondary backup
                if (appHtml) {
                  const polyfilledHtml = NotebookLmArtifactFormatter.injectNotebookAppApiPolyfill(appHtml);
                  fs.writeFileSync(path.join(nbArtifactsFolder, `${cleanBase}_AngularApp.html`), polyfilledHtml, 'utf8');
                }
                generatedApp = true;
              } else if (appData?.flashcards && Array.isArray(appData.flashcards) && appData.flashcards.length > 0) {
                // 1. Zero-dependency interactive HTML5 3D Flashcards Application
                const fcHtml = NotebookLmArtifactFormatter.renderInteractiveFlashcardsHtml(artTitle, nb.displayName, appData.flashcards, appData.topics);
                const appPath = path.join(nbArtifactsFolder, `${cleanBase}.html`);
                fs.writeFileSync(appPath, fcHtml, 'utf8');
                nbArtifactCount++;

                // 2. Printable Flashcards Study Sheet Table (.docx)
                const fcMd = NotebookLmArtifactFormatter.formatFlashcardsMarkdown(artTitle, nb.displayName, appData.flashcards);
                const docxPath = path.join(nbArtifactsFolder, `${cleanBase}.docx`);
                await this.generateDocxDocument(artTitle, 'Flashcards Study Sheet', nb.displayName, fcMd, docxPath);
                nbArtifactCount++;

                // 3. Clean Markdown Table Study Sheet
                const mdFilePath = path.join(nbArtifactsFolder, `${cleanBase}.md`);
                fs.writeFileSync(mdFilePath, fcMd, 'utf8');

                // 4. Raw Angular app with polyfilled API as secondary backup
                if (appHtml) {
                  const polyfilledHtml = NotebookLmArtifactFormatter.injectNotebookAppApiPolyfill(appHtml);
                  fs.writeFileSync(path.join(nbArtifactsFolder, `${cleanBase}_AngularApp.html`), polyfilledHtml, 'utf8');
                }
                generatedApp = true;
              }

              // Fallback if structured app data could not be parsed
              if (!generatedApp && appHtml) {
                const polyfilledHtml = NotebookLmArtifactFormatter.injectNotebookAppApiPolyfill(appHtml);
                const appPath = path.join(nbArtifactsFolder, `${cleanBase}.html`);
                fs.writeFileSync(appPath, polyfilledHtml, 'utf8');
                nbArtifactCount++;

                const mdFilePath = path.join(nbArtifactsFolder, `${cleanBase}.md`);
                fs.writeFileSync(mdFilePath, `# Interactive Learning App: ${artTitle}\n\n- Notebook: **${nb.displayName}**\n- Type: Interactive Quiz / Flashcards App\n- Standalone File: \`${cleanBase}.html\` (Open in any web browser to play offline)\n`, 'utf8');
              }
            }
            // F. GENERAL DOCUMENTS, BRIEFING DOCS, STUDY GUIDES, FAQS
            else {
              if (textContent.length >= 30) {
                // 1. Native Microsoft Word (.docx)
                const docxPath = path.join(nbArtifactsFolder, `${cleanBase}.docx`);
                await this.generateDocxDocument(artTitle, art.type || 'Study Guide', nb.displayName, textContent, docxPath);

                // 2. Formatted Executive HTML Document
                const docHtml = this.renderDocumentHtml(artTitle, art.type || 'Study Guide', nb.displayName, textContent);
                const docPath = path.join(nbArtifactsFolder, `${cleanBase}.html`);
                fs.writeFileSync(docPath, docHtml, 'utf8');
                nbArtifactCount++;

                // 3. Clean Markdown companion
                const mdFilePath = path.join(nbArtifactsFolder, `${cleanBase}.md`);
                fs.writeFileSync(mdFilePath, cleanMarkdown, 'utf8');
              }
            }
          }
        }

        // Save Studio Notes as Native DOCX, Formatted HTML & Markdown (Only if not empty)
        if (nb.details?.notes && Array.isArray(nb.details.notes)) {
          for (const note of nb.details.notes) {
            const noteContent = (note.content || '').trim();
            if (noteContent.length < 30) {
              continue; // Skip empty notes
            }

            const noteTitle = note.title || 'Studio Note';
            const cleanNoteBase = NotebookLmArtifactFormatter.cleanArtifactFilename(nb.displayName, `Note - ${noteTitle}`, '');
            const cleanNoteMarkdown = NotebookLmArtifactFormatter.cleanNotebookLmMarkdown(noteTitle, noteContent);

            // Note DOCX
            const noteDocxPath = path.join(nbArtifactsFolder, `${cleanNoteBase}.docx`);
            await this.generateDocxDocument(noteTitle, 'Studio Note', nb.displayName, noteContent, noteDocxPath);

            // Note HTML
            const noteHtml = this.renderDocumentHtml(noteTitle, 'Studio Note', nb.displayName, noteContent);
            const noteHtmlPath = path.join(nbArtifactsFolder, `${cleanNoteBase}.html`);
            fs.writeFileSync(noteHtmlPath, noteHtml, 'utf8');
            nbArtifactCount++;

            // Note Markdown
            const noteMdPath = path.join(nbArtifactsFolder, `${cleanNoteBase}.md`);
            fs.writeFileSync(noteMdPath, cleanNoteMarkdown, 'utf8');
          }
        }
      }

      logger.info(`Generated Handover Bundle for "${userEmail}" at: ${userFolder} (${nbArtifactCount} rich PPTX/DOCX/HTML NotebookLM artifacts saved)`);
      resultSummary[userEmail] = {
        folderPath: userFolder,
        markdownPath: mdPath,
        htmlPath: htmlPath,
        notebookArtifactsCount: nbArtifactCount
      };
    }

    return resultSummary;
  }

  /**
   * Dispatches email checklist and NotebookLM attachments to recipient using Google Gmail API.
   * Bin-packs attachments into safe sequential messages (<= 14.5 MB unencoded per part)
   * to guarantee zero quality loss without hitting Gmail's 25 MB message limit.
   */
  async sendUserEmail(options: SendEmailOptions, report: MigrationReport): Promise<{
    success: boolean;
    mode: string;
    message: string;
    messageId?: string;
    threadId?: string;
    emlPath?: string;
    htmlPath?: string;
    attachmentsCount: number;
    partsSent?: number;
    parts?: Array<{ part: number; totalParts: number; messageId?: string; attachmentsCount: number; filenames: string[] }>;
  }> {
    const userGroups = this.groupReportByUser(report);
    const userData = userGroups.get(options.userEmail) || Array.from(userGroups.values())[0];

    if (!userData) {
      throw new Error(`No handover data found for user email: ${options.userEmail}`);
    }

    const authService = options.authService || new GcpAuthService();

    // Ensure user bundle exists on disk with live artifact enrichment
    await this.generateAllUserBundles(report, { authService });

    const recipient = options.overrideRecipientEmail || options.userEmail;
    const fromAddress = options.senderEmail || process.env.SENDER_EMAIL || process.env.ADMIN_EMAIL || 'admin@example.com';
    const baseHtmlBody = this.generateHtmlReport(userData);
    const baseTextBody = this.generateMarkdownReport(userData);

    const sanitizedEmail = options.userEmail.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const userFolder = path.join(this.baseDir, sanitizedEmail);
    const localHtmlPath = path.join(userFolder, 'MIGRATION_CHECKLIST.html');

    // Default to zipped attachments unless explicitly disabled
    const isZipEnabled = options.zipAttachments !== false;
    const shouldOptimize = options.optimizeMedia ?? isZipEnabled;

    // 1. Collect all candidate attachments from notebook_artifacts
    const nbArtFolder = path.join(userFolder, 'notebook_artifacts');
    const allFiles: Array<{ filename: string; path: string; size: number }> = [];
    const oversizedFiles: Array<{ filename: string; size: number; path: string }> = [];

    if (fs.existsSync(nbArtFolder)) {
      const files = fs.readdirSync(nbArtFolder);
      for (const f of files) {
        const fullPath = path.join(nbArtFolder, f);
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isFile() || stat.size <= 1024) continue;

          // Deduplicate companion PDFs: if a .pdf has a corresponding authentic .pptx,
          // exclude the companion .pdf to avoid sending redundant duplicate slide decks.
          if (f.toLowerCase().endsWith('.pdf')) {
            const companionPptx = f.slice(0, -4) + '.pptx';
            if (fs.existsSync(path.join(nbArtFolder, companionPptx))) {
              logger.info(`Excluding companion slide PDF "${f}" to avoid duplicate presentation attachments (authentic PowerPoint "${companionPptx}" is attached).`);
              continue;
            }
          }

          // Deduplicate synthetic companion DOCX: if an infographic already has an authentic .jpg or .png,
          // exclude the synthetic .docx wrapper to avoid duplicate visual assets and conserve attachment space.
          if (f.toLowerCase().endsWith('.docx')) {
            const companionJpg = f.slice(0, -5) + '.jpg';
            const companionPng = f.slice(0, -5) + '.png';
            if (fs.existsSync(path.join(nbArtFolder, companionJpg)) || fs.existsSync(path.join(nbArtFolder, companionPng))) {
              logger.info(`Excluding synthetic companion DOCX "${f}" because authentic image infographic is attached.`);
              continue;
            }
          }

          // Deduplicate companion HTML document viewers: if a .html has a companion .docx,
          // exclude the .html to avoid sending redundant HTML code files (< / >) when authentic Microsoft Word document is attached.
          // BUT preserve standalone interactive applications (quizzes, flashcards, learning apps)!
          const isInteractiveApp = f.toLowerCase().includes('quiz') || f.toLowerCase().includes('flashcard') || f.toLowerCase().includes('app');
          if (f.toLowerCase().endsWith('.html') && !isInteractiveApp) {
            const companionDocx = f.slice(0, -5) + '.docx';
            if (fs.existsSync(path.join(nbArtFolder, companionDocx))) {
              logger.info(`Excluding companion HTML viewer "${f}" because authentic Word document "${companionDocx}" is attached.`);
              continue;
            }
          }

          // Strictly attach authentic user documents and media:
          // Never attach utility .html files (_SlideDeck.html, _AudioPlayer.html, _VideoPlayer.html, _AngularApp.html) which render as code (< / >) icons.
          if (
            f.endsWith('.pptx') ||
            f.endsWith('.docx') ||
            f.endsWith('.pdf') ||
            f.endsWith('.jpg') ||
            f.endsWith('.png') ||
            f.endsWith('.mp4') ||
            f.endsWith('.wav') ||
            (f.endsWith('.html') &&
              !f.endsWith('_SlideDeck.html') &&
              !f.endsWith('_AudioPlayer.html') &&
              !f.endsWith('_VideoPlayer.html') &&
              !f.endsWith('_AngularApp.html') &&
              !f.endsWith('MIGRATION_CHECKLIST.html'))
          ) {
            // Gmail API hard limit is 25 MB per MIME message.
            // When zip attachments are enabled, files up to 35 MB can be included as candidates because
            // document and media compression often achieves 60-80% size reduction.
            // Final archive sizes are evaluated post-compression.
            // When zip is disabled, files > 14.5 MB raw base64 encode to > 19.3 MB, exceeding safe limits.
            const sizeLimit = isZipEnabled ? 35 * 1024 * 1024 : 14.5 * 1024 * 1024;
            if (stat.size > sizeLimit) {
              oversizedFiles.push({ filename: f, size: stat.size, path: fullPath });
            } else {
              allFiles.push({ filename: f, path: fullPath, size: stat.size });
            }
          }
        } catch {}
      }
    }

    // 2. Sort files by priority:
    // 1: Presentations (.pptx)
    // 2: Infographics (.jpg, .png)
    // 3: Interactive Learning Apps / Quizzes (.html)
    // 4: Word documents (.docx)
    // 5: Explainer Videos (.mp4)
    // 6: Audio Podcasts (.wav)
    // 7: Standalone PDFs (.pdf without matching .pptx)
    const getPriority = (filename: string): number => {
      if (filename.endsWith('.pptx')) return 1;
      if (filename.endsWith('.jpg') || filename.endsWith('.png')) return 2;
      if (filename.endsWith('.html')) return 3;
      if (filename.endsWith('.docx')) return 4;
      if (filename.endsWith('.mp4')) return 5;
      if (filename.endsWith('.wav')) return 6;
      if (filename.endsWith('.pdf')) return 7;
      return 8;
    };

    allFiles.sort((a, b) => getPriority(a.filename) - getPriority(b.filename));

    let candidateFiles = [...allFiles];

    const hasOptimizer = UserReportGenerator.isImageMagickAvailable() || UserReportGenerator.isFfmpegAvailable();
    if (shouldOptimize && hasOptimizer) {
      const optDir = path.join(userFolder, 'optimized_artifacts');
      const optimizedFiles: Array<{ filename: string; path: string; size: number }> = [];
      for (const f of candidateFiles) {
        const opt = await this.optimizeMediaArtifact(f, optDir);
        optimizedFiles.push(opt);
      }
      candidateFiles = optimizedFiles;

      // Check if any previously oversized files can now be safely included after media optimization
      for (let i = oversizedFiles.length - 1; i >= 0; i--) {
        const oFile = oversizedFiles[i];
        if (
          oFile.filename.endsWith('.pptx') ||
          oFile.filename.endsWith('.jpg') ||
          oFile.filename.endsWith('.png') ||
          oFile.filename.endsWith('.mp4')
        ) {
          const opt = await this.optimizeMediaArtifact({ filename: oFile.filename, path: oFile.path, size: oFile.size }, optDir);
          if (opt.size <= 14.5 * 1024 * 1024) {
            logger.info(`Promoted previously oversized artifact "${oFile.filename}" into active attachments after media optimization (${(oFile.size / 1048576).toFixed(1)} MB -> ${(opt.size / 1048576).toFixed(1)} MB).`);
            candidateFiles.push(opt);
            oversizedFiles.splice(i, 1);
          }
        }
      }
    }

    // 3. Bin-pack attachments into sequential parts (max 14.5 MB unencoded per part)
    const MAX_PART_SIZE = 14.5 * 1024 * 1024;
    const buckets: Array<Array<{ filename: string; path: string; size: number }>> = [];
    const zipContentsMap = new Map<string, Array<{ filename: string; path: string; size: number }>>();

    if (isZipEnabled) {
      if (candidateFiles.length === 0) {
        buckets.push([]);
      } else {
        // Attempt single-zip packaging first
        const singleZipName = 'NotebookLM_Artifacts.zip';
        const singleZipPath = path.join(userFolder, singleZipName);
        const singleZipSize = await this.createZipArchive(singleZipPath, candidateFiles);

        if (singleZipSize <= MAX_PART_SIZE) {
          logger.info(`Packaged all ${candidateFiles.length} artifacts into single archive: ${singleZipName} (${(singleZipSize / 1048576).toFixed(2)} MB)`);
          buckets.push([{ filename: singleZipName, path: singleZipPath, size: singleZipSize }]);
          zipContentsMap.set(singleZipName, candidateFiles);
        } else {
          logger.info(`Single zip archive (${(singleZipSize / 1048576).toFixed(2)} MB) exceeds single email limit (${(MAX_PART_SIZE / 1048576).toFixed(1)} MB). Partitioning artifacts into multi-part zip archives...`);

          const rawBuckets: Array<Array<{ filename: string; path: string; size: number }>> = [];
          for (const file of candidateFiles) {
            let placed = false;
            for (const b of rawBuckets) {
              const currentSize = b.reduce((sum, item) => sum + item.size, 0);
              if (currentSize + file.size <= MAX_PART_SIZE) {
                b.push(file);
                placed = true;
                break;
              }
            }
            if (!placed) {
              rawBuckets.push([file]);
            }
          }

          for (let bIdx = 0; bIdx < rawBuckets.length; bIdx++) {
            const partFiles = rawBuckets[bIdx];
            const partZipName = `NotebookLM_Artifacts_Part${bIdx + 1}.zip`;
            const partZipPath = path.join(userFolder, partZipName);
            const partZipSize = await this.createZipArchive(partZipPath, partFiles);
            if (partZipSize <= MAX_PART_SIZE) {
              buckets.push([{ filename: partZipName, path: partZipPath, size: partZipSize }]);
              zipContentsMap.set(partZipName, partFiles);
            } else {
              logger.warn(`Partitioned zip archive ${partZipName} (${(partZipSize / 1048576).toFixed(2)} MB) exceeds single email limit (${(MAX_PART_SIZE / 1048576).toFixed(1)} MB). Designating contents for local handover retrieval.`);
              for (const pf of partFiles) {
                oversizedFiles.push({ filename: pf.filename, size: pf.size, path: pf.path });
              }
            }
          }
        }
      }
    } else {
      if (options.singleEmailMode) {
        const singleBucket: Array<{ filename: string; path: string; size: number }> = [];
        let currentBucketSize = 0;
        for (const file of candidateFiles) {
          if (currentBucketSize + file.size <= MAX_PART_SIZE) {
            singleBucket.push(file);
            currentBucketSize += file.size;
          } else {
            oversizedFiles.push({ filename: file.filename, size: file.size, path: file.path });
          }
        }
        buckets.push(singleBucket);
      } else {
        if (candidateFiles.length === 0) {
          buckets.push([]);
        } else {
          for (const file of candidateFiles) {
            let placed = false;
            for (const bucket of buckets) {
              const currentBucketSize = bucket.reduce((sum, item) => sum + item.size, 0);
              if (currentBucketSize + file.size <= MAX_PART_SIZE) {
                bucket.push(file);
                placed = true;
                break;
              }
            }
            if (!placed) {
              buckets.push([file]);
            }
          }
        }
      }
    }

    const totalParts = buckets.length;
    logger.info(`Bin-packed ${isZipEnabled ? (candidateFiles.length || 0) : allFiles.length} attachments (${(candidateFiles.reduce((s, f) => s + f.size, 0) / 1048576).toFixed(1)} MB) into ${totalParts} email part(s) for ${recipient}`);

    // Generate root RFC 2822 Message-ID for conversation threading across all parts
    const domain = fromAddress.includes('@') ? fromAddress.split('@')[1] : 'workspace.migration';
    const rootMessageId = `<migration-${Date.now()}-${Math.random().toString(36).substring(2, 9)}@${domain}>`;
    const baseSubject = `🚀 Welcome to Your New Gemini Enterprise Workspace (${userData.userEmail})`;

    let firstMessageId: string | undefined;
    let sharedThreadId: string | undefined;
    const partsSummary: Array<{ part: number; totalParts: number; messageId?: string; attachmentsCount: number; filenames: string[] }> = [];

    // Authenticate: Mint DWD Token for Gmail API if not corporate SMTP
    let token = options.accessToken;
    const isSmtp = !!(options.smtpConfig?.host && options.smtpConfig?.auth?.user);

    if (!isSmtp && !token) {
      try {
        token = await authService.mintDwdToken(fromAddress, ['https://www.googleapis.com/auth/gmail.send']);
      } catch {
        token = await authService.getAccessToken(fromAddress, ['https://www.googleapis.com/auth/gmail.send']);
      }
    }

    let primaryEmlPath = path.join(userFolder, 'MIGRATION_CHECKLIST.eml');

    // 4. Dispatch each part sequentially
    for (let partIndex = 0; partIndex < totalParts; partIndex++) {
      const currentBucket = buckets[partIndex];
      const partNum = partIndex + 1;
      const bucketFilenames = currentBucket.map(f => f.filename);

      // Keep subject identical or standard Re: for follow-ups so Gmail threads them into a single conversation
      let subject = baseSubject;
      if (partIndex > 0) {
        subject = `Re: ${baseSubject}`;
      }

      let finalHtmlBody: string;
      let finalTextBody: string;

      if (partIndex === 0) {
        // Part 1: Full Migration Handover Guide & Checklist
        let partHtmlNotice = '';
        let partTextNotice = '';

        if (isZipEnabled && currentBucket.length > 0) {
          const zipName = currentBucket[0].filename;
          const zipFiles = zipContentsMap.get(zipName) || candidateFiles;
          const zipSizeMb = (currentBucket[0].size / 1048576).toFixed(1);
          const multiPartSuffix = totalParts > 1 ? ` • Part 1 of ${totalParts}` : '';

          partHtmlNotice = `
<div style="background: #1e1b4b; border: 1px solid #4338ca; border-radius: 12px; padding: 16px 20px; margin-bottom: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="font-size: 13px; font-weight: 700; color: #a5b4fc; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">
    📦 NotebookLM Artifacts Archive Attached (${zipSizeMb} MB)${multiPartSuffix}
  </div>
  <div style="font-size: 13px; color: #e0e7ff; line-height: 1.5;">
    To preserve 100% authentic visual fidelity, custom slide templates, and high-resolution infographics in a single convenient download, your NotebookLM exports are packaged into <strong>${zipName}</strong>.<br/>
    <div style="margin-top: 8px; font-size: 12px; color: #c7d2fe; font-weight: 600;">Contents of this archive (${zipFiles.length} authentic files):</div>
    <ul style="margin: 4px 0 0 16px; padding: 0; color: #e0e7ff; font-size: 12px; line-height: 1.5;">
      ${zipFiles.map(f => `<li>• <strong>${f.filename}</strong> (${(f.size / 1048576).toFixed(1)} MB)</li>`).join('')}
    </ul>
  </div>
</div>`;
          partTextNotice = `[NOTEBOOKLM ARTIFACTS ARCHIVE ATTACHED: ${zipName} (${zipSizeMb} MB)${multiPartSuffix}]\n` +
            `Contents (${zipFiles.length} authentic files):\n` +
            zipFiles.map(f => `• ${f.filename} (${(f.size / 1048576).toFixed(1)} MB)`).join('\n') + '\n\n';
        } else if (totalParts > 1) {
          partHtmlNotice = `
<div style="background: #1e1b4b; border: 1px solid #4338ca; border-radius: 12px; padding: 14px 18px; margin-bottom: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="font-size: 13px; font-weight: 700; color: #a5b4fc; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">
    📦 Migration Handover Delivery • Part 1 of ${totalParts}
  </div>
  <div style="font-size: 13px; color: #e0e7ff; line-height: 1.4;">
    To preserve 100% authentic visual fidelity, custom fonts, and high-resolution media without file size limits, your NotebookLM presentations and infographics are delivered across <strong>${totalParts} connected messages</strong> in this thread.<br/>
    <strong>Attachments in this message (${currentBucket.length}):</strong> ${bucketFilenames.join(', ')}
  </div>
</div>`;
          partTextNotice = `[MIGRATION HANDOVER • PART 1 OF ${totalParts}]\nAttachments in this message (${currentBucket.length}): ${bucketFilenames.join(', ')}\n\n`;
        }

        // High-capacity media & presentations preserved notice
        let oversizedHtmlNotice = '';
        let oversizedTextNotice = '';
        if (oversizedFiles.length > 0) {
          const fileListHtml = oversizedFiles.map(o => `• <strong>${o.filename}</strong> (${(o.size / 1048576).toFixed(1)} MB)`).join('<br/>');
          const fileListText = oversizedFiles.map(o => `• ${o.filename} (${(o.size / 1048576).toFixed(1)} MB)`).join('\n');
          oversizedHtmlNotice = `
<div style="background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 16px 20px; margin-top: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="font-size: 13px; font-weight: 700; color: #38bdf8; margin-bottom: 6px;">
    📁 High-Capacity Media & Presentations Preserved in Workspace
  </div>
  <div style="font-size: 12px; color: #94a3b8; line-height: 1.5;">
    The following items exceed standard email attachment limits (25 MB) and are safely preserved in your workstation's local handover archive:<br/>
    ${fileListHtml}<br/>
    <div style="margin-top: 8px; color: #64748b; font-size: 11px;">Workstation Archive: <code>user_handover_reports/${sanitizedEmail}/notebook_artifacts/</code></div>
  </div>
</div>`;
          oversizedTextNotice = `\n[HIGH-CAPACITY MEDIA PRESERVED IN WORKSPACE]\n${fileListText}\nWorkstation Archive: user_handover_reports/${sanitizedEmail}/notebook_artifacts/\n`;
        }

        if (partHtmlNotice && baseHtmlBody.includes('<!-- INJECT_PART_NOTICE -->')) {
          finalHtmlBody = baseHtmlBody.replace('<!-- INJECT_PART_NOTICE -->', partHtmlNotice);
        } else {
          finalHtmlBody = partHtmlNotice + baseHtmlBody;
        }

        if (oversizedHtmlNotice && finalHtmlBody.includes('<!-- INJECT_OVERSIZED_NOTICE -->')) {
          finalHtmlBody = finalHtmlBody.replace('<!-- INJECT_OVERSIZED_NOTICE -->', oversizedHtmlNotice);
        } else {
          finalHtmlBody = finalHtmlBody + oversizedHtmlNotice;
        }

        finalTextBody = partTextNotice + baseTextBody + oversizedTextNotice;
      } else {
        // Part 2+: Concise threaded continuation with remaining authentic attachments
        if (isZipEnabled && currentBucket.length > 0) {
          const zipName = currentBucket[0].filename;
          const zipFiles = zipContentsMap.get(zipName) || [];
          const zipSizeMb = (currentBucket[0].size / 1048576).toFixed(1);

          finalHtmlBody = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 680px; margin: 0 auto; color: #1e293b; line-height: 1.5; padding: 20px 0;">
  <div style="background: #1e1b4b; border: 1px solid #4338ca; border-radius: 12px; padding: 18px 22px; margin-bottom: 20px;">
    <div style="font-size: 13px; font-weight: 700; color: #a5b4fc; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">
      📦 Migration Handover Delivery • Part ${partNum} of ${totalParts}
    </div>
    <div style="font-size: 14px; color: #e0e7ff; line-height: 1.5;">
      This follow-up message in your handover thread delivers <strong>${zipName}</strong> (${zipSizeMb} MB) containing additional high-resolution presentation and infographic artifacts for <strong>${userData.userEmail}</strong>.
    </div>
  </div>

  <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px 24px; margin-bottom: 20px;">
    <h3 style="margin-top: 0; font-size: 15px; color: #0f172a; font-weight: 600; margin-bottom: 12px;">
      📎 Archive Contents (${zipFiles.length} files)
    </h3>
    <ul style="margin: 0; padding-left: 20px; color: #334155; font-size: 13px; line-height: 1.6;">
      ${zipFiles.map(f => `<li><strong>${f.filename}</strong> (${(f.size / 1048576).toFixed(1)} MB)</li>`).join('')}
    </ul>
    <p style="margin-top: 16px; margin-bottom: 0; font-size: 13px; color: #64748b;">
      ℹ️ Please refer to <strong>Part 1</strong> of this email thread for your complete Gemini Enterprise onboarding checklist, Discovery Engine URLs, and workspace settings.
    </p>
  </div>
</div>`;

          finalTextBody = `[MIGRATION HANDOVER DELIVERY • PART ${partNum} OF ${totalParts}]\n\n` +
            `This follow-up message in your handover thread delivers ${zipName} (${zipSizeMb} MB) containing additional presentation artifacts for ${userData.userEmail}.\n\n` +
            `Archive Contents (${zipFiles.length} files):\n` +
            zipFiles.map(f => `• ${f.filename} (${(f.size / 1048576).toFixed(1)} MB)`).join('\n') + '\n\n' +
            `Please refer to Part 1 of this email thread for your complete Gemini Enterprise onboarding checklist, Discovery Engine URLs, and workspace settings.\n`;
        } else {
          finalHtmlBody = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 680px; margin: 0 auto; color: #1e293b; line-height: 1.5; padding: 20px 0;">
  <div style="background: #1e1b4b; border: 1px solid #4338ca; border-radius: 12px; padding: 18px 22px; margin-bottom: 20px;">
    <div style="font-size: 13px; font-weight: 700; color: #a5b4fc; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">
      📦 Migration Handover Delivery • Part ${partNum} of ${totalParts}
    </div>
    <div style="font-size: 14px; color: #e0e7ff; line-height: 1.5;">
      This follow-up message in your handover thread delivers the remaining high-resolution presentation and media artifacts for <strong>${userData.userEmail}</strong>.
    </div>
  </div>

  <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px 24px; margin-bottom: 20px;">
    <h3 style="margin-top: 0; font-size: 15px; color: #0f172a; font-weight: 600; margin-bottom: 12px;">
      📎 Attached Artifacts in this Message (${currentBucket.length})
    </h3>
    <ul style="margin: 0; padding-left: 20px; color: #334155; font-size: 13px; line-height: 1.6;">
      ${bucketFilenames.map(f => `<li><strong>${f}</strong></li>`).join('')}
    </ul>
    <p style="margin-top: 16px; margin-bottom: 0; font-size: 13px; color: #64748b;">
      ℹ️ Please refer to <strong>Part 1</strong> of this email thread for your complete Gemini Enterprise onboarding checklist, Discovery Engine URLs, and workspace settings.
    </p>
  </div>
</div>`;

          finalTextBody = `[MIGRATION HANDOVER DELIVERY • PART ${partNum} OF ${totalParts}]\n\n` +
            `This follow-up message in your handover thread delivers the remaining high-resolution presentation artifacts for ${userData.userEmail}.\n\n` +
            `Attached Artifacts in this Message (${currentBucket.length}):\n` +
            bucketFilenames.map(f => `• ${f}`).join('\n') + '\n\n' +
            `Please refer to Part 1 of this email thread for your complete Gemini Enterprise onboarding checklist, Discovery Engine URLs, and workspace settings.\n`;
        }
      }

      const mailAttachments = currentBucket.map(f => ({
        filename: f.filename,
        path: f.path
      }));

      const mailOptions: any = {
        from: `"Gemini Enterprise" <${fromAddress}>`,
        to: recipient,
        subject,
        text: finalTextBody,
        html: finalHtmlBody,
        attachments: mailAttachments
      };

      if (partIndex === 0) {
        mailOptions.messageId = rootMessageId;
      } else {
        const partMessageId = `<migration-${Date.now()}-part${partNum}-${Math.random().toString(36).substring(2, 9)}@${domain}>`;
        mailOptions.messageId = partMessageId;
        mailOptions.inReplyTo = rootMessageId;
        mailOptions.references = rootMessageId;
      }

      // 1. Build standard RFC 2822 MIME message strictly in-memory
      const memTransport = nodemailer.createTransport({
        streamTransport: true,
        newline: 'windows',
        buffer: true
      });

      const compiledInfo = await memTransport.sendMail(mailOptions);
      const rawMimeBuffer = compiledInfo.message as Buffer;

      // 2. Save local .eml file directly in user folder for offline desktop access
      const partEmlName = totalParts > 1 ? `MIGRATION_CHECKLIST_Part${partNum}.eml` : 'MIGRATION_CHECKLIST.eml';
      const partEmlPath = path.join(userFolder, partEmlName);
      fs.writeFileSync(partEmlPath, rawMimeBuffer);
      if (partIndex === 0) {
        primaryEmlPath = partEmlPath;
        fs.writeFileSync(path.join(userFolder, 'MIGRATION_CHECKLIST.eml'), rawMimeBuffer);
      }

      // 3. Dispatch: Check for custom corporate SMTP first
      if (isSmtp) {
        const smtpTransport = nodemailer.createTransport({
          host: options.smtpConfig!.host,
          port: options.smtpConfig!.port || 587,
          secure: options.smtpConfig!.secure || false,
          auth: options.smtpConfig!.auth
        });

        const smtpInfo = await smtpTransport.sendMail(mailOptions);
        if (partIndex === 0) firstMessageId = smtpInfo.messageId;
        partsSummary.push({
          part: partNum,
          totalParts,
          messageId: smtpInfo.messageId,
          attachmentsCount: mailAttachments.length,
          filenames: bucketFilenames
        });
        logger.info(`Dispatched migration handover email Part ${partNum}/${totalParts} via corporate SMTP to "${recipient}" (ID: ${smtpInfo.messageId})`);
      } else {
        // 4. Primary: Dispatch via Google Workspace / Gmail REST API
        const rawBase64Url = rawMimeBuffer
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');

        const postBody: any = { raw: rawBase64Url };
        if (sharedThreadId) {
          postBody.threadId = sharedThreadId;
        }

        const maxAttempts = 5;
        let attempt = 0;
        let gmailRes: any = null;
        let gmailData: any = null;

        while (attempt < maxAttempts) {
          attempt++;
          gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(postBody)
          });

          gmailData = await gmailRes.json();

          if (gmailRes.status === 429 || (gmailRes.status >= 500 && gmailRes.status <= 504)) {
            const retryAfterHeader = gmailRes.headers?.get ? gmailRes.headers.get('retry-after') : null;
            let delayMs = Math.min(1000 * Math.pow(2, attempt), 30000);
            if (retryAfterHeader) {
              const seconds = parseInt(retryAfterHeader, 10);
              if (!isNaN(seconds)) delayMs = Math.min(seconds * 1000, 120000);
            }
            logger.warn(`Gmail API returned HTTP ${gmailRes.status} (attempt ${attempt}/${maxAttempts}). Retrying in ${delayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            continue;
          }

          break;
        }

        if (!gmailRes || !gmailRes.ok) {
          const errDetail = gmailData?.error?.message || gmailRes?.statusText || 'Unknown error';
          logger.error(`Gmail API send failed for Part ${partNum}/${totalParts}: ${errDetail}`);

          if (errDetail.toLowerCase().includes('insufficient authentication scopes') || (gmailRes && gmailRes.status === 403)) {
            throw new Error(
              `Gmail API returned HTTP 403: Request had insufficient authentication scopes. ` +
              `The active OAuth token lacks 'https://www.googleapis.com/auth/gmail.send'.\n\n` +
              `Remediation Options:\n` +
              `  1. Domain-Wide Delegation (Enterprise): Configure sa-dwd-key.json with 'https://www.googleapis.com/auth/gmail.send' in Google Workspace Admin Console\n` +
              `  2. Local ADC Login (Workstation): Run 'gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/gmail.send'\n` +
              `  3. Corporate SMTP: Configure an SMTP relay\n` +
              `  4. Offline Delivery: The complete MIME message with all attachments is already saved locally at: ${partEmlPath}`
            );
          }

          throw new Error(`Gmail API returned HTTP ${gmailRes ? gmailRes.status : 'Error'}: ${errDetail}. (MIME bundle is saved locally at: ${partEmlPath})`);
        }

        if (partIndex === 0) {
          firstMessageId = gmailData.id;
          sharedThreadId = gmailData.threadId;
        }

        partsSummary.push({
          part: partNum,
          totalParts,
          messageId: gmailData.id,
          attachmentsCount: mailAttachments.length,
          filenames: bucketFilenames
        });

        logger.info(`Dispatched migration handover email Part ${partNum}/${totalParts} via Gmail API from "${fromAddress}" to "${recipient}" (Gmail ID: ${gmailData.id}, Thread: ${gmailData.threadId}, ${mailAttachments.length} attachments)`);
      }

      // Pacing between successive parts of the multi-part email
      if (partIndex < totalParts - 1) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }

    return {
      success: true,
      mode: isSmtp ? 'CORPORATE_SMTP' : 'GMAIL_API',
      message: `Email successfully sent via ${isSmtp ? 'corporate SMTP' : 'Google Gmail API'} to ${recipient} (${isZipEnabled ? candidateFiles.length : allFiles.length} attachments across ${totalParts} part(s))`,
      messageId: firstMessageId,
      threadId: sharedThreadId,
      emlPath: primaryEmlPath,
      htmlPath: localHtmlPath,
      attachmentsCount: isZipEnabled ? candidateFiles.length : allFiles.length,
      partsSent: totalParts,
      parts: partsSummary
    };
  }

  /**
   * Dispatches bulk handover emails across multiple or all discovered users,
   * with pacing delays to prevent API rate limiting and support for safe staging override.
   */
  async sendBulkUserEmails(options: BulkEmailOptions, report: MigrationReport): Promise<BulkEmailResponse> {
    const userGroups = this.groupReportByUser(report);
    const targetUsers = (options.userEmails && options.userEmails.length > 0)
      ? options.userEmails.filter(e => userGroups.has(e))
      : Array.from(userGroups.keys());

    if (targetUsers.length === 0) {
      throw new Error('No valid target users found in migration report to dispatch bulk emails.');
    }

    const authService = options.authService || new GcpAuthService();

    // Ensure all bundles are generated upfront with enrichment
    await this.generateAllUserBundles(report, { authService });

    const pacingDelayMs = options.pacingDelayMs ?? 250;
    const results: BulkEmailItemResult[] = [];
    let sentCount = 0;
    let failedCount = 0;

    logger.info(`Starting Bulk Email Dispatch to ${targetUsers.length} user(s) (Pacing: ${pacingDelayMs}ms, Safe Override: ${options.overrideRecipientEmail || 'None'})...`);

    for (let i = 0; i < targetUsers.length; i++) {
      const userEmail = targetUsers[i];
      const recipient = options.overrideRecipientEmail || userEmail;

      try {
        const sendRes = await this.sendUserEmail({
          userEmail,
          senderEmail: options.senderEmail,
          overrideRecipientEmail: options.overrideRecipientEmail,
          accessToken: options.accessToken,
          singleEmailMode: options.singleEmailMode,
          zipAttachments: options.zipAttachments,
          optimizeMedia: options.optimizeMedia,
          authService: options.authService,
          smtpConfig: options.smtpConfig
        }, report);

        results.push({
          userEmail,
          recipient,
          success: true,
          mode: sendRes.mode,
          messageId: sendRes.messageId,
          threadId: sendRes.threadId,
          attachmentsCount: sendRes.attachmentsCount,
          partsSent: sendRes.partsSent,
          emlPath: sendRes.emlPath
        });
        sentCount++;
      } catch (err: any) {
        logger.error(`Failed to send handover email for user "${userEmail}": ${err.message}`);
        results.push({
          userEmail,
          recipient,
          success: false,
          error: err.message,
          attachmentsCount: 0
        });
        failedCount++;
      }

      // Pacing delay between successive sends to avoid API rate limit throttling
      if (i < targetUsers.length - 1 && pacingDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, pacingDelayMs));
      }
    }

    logger.info(`Bulk Email Dispatch completed: ${sentCount} sent, ${failedCount} failed of ${targetUsers.length} total.`);

    return {
      success: failedCount === 0,
      total: targetUsers.length,
      sent: sentCount,
      failed: failedCount,
      results
    };
  }
}
