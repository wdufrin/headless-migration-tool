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
import nodemailer from 'nodemailer';
import { MigrationReport, MigrationItemResult } from '../types/migration.js';
import { GcpAuthService } from '../services/gcpAuth.js';
import { logger } from '../utils/logger.js';

export interface UserHandoverData {
  userEmail: string;
  notebooks: MigrationItemResult[];
  agents: MigrationItemResult[];
  sessions: MigrationItemResult[];
  targetCid: string;
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

export class UserReportGenerator {
  private baseDir: string;

  constructor(baseDir: string = './user_handover_reports') {
    this.baseDir = baseDir;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
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

    const agentsWebUrl = `https://vertexaisearch.cloud.google.com/home/cid/${targetCid}/r/agents?hl=en_US`;
    const notebooksWebUrl = `https://vertexaisearch.cloud.google.com/home/cid/${targetCid}/r/notebook?hl=en_US`;
    const chatWebUrl = `https://vertexaisearch.cloud.google.com/home/cid/${targetCid}/r/chat?hl=en_US`;

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
    const primaryReportUser = sortedUsers.length > 0 ? sortedUsers[0][0] : (process.env.ADMIN_EMAIL || 'admin@wdufrin.altostrat.com');

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
          targetCid,
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
      }
    }

    return userMap;
  }

  /**
   * Generates clean, end-user friendly Markdown checklist
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
          const directAgentUrl = `https://vertexaisearch.cloud.google.com/home/cid/${data.targetCid}/r/agents/${ag.targetId || ag.id}?hl=en_US`;

          if (isPrivate) {
            return `### 🤖 [${ag.displayName}](${directAgentUrl})
- **Status:** Private
- **Next Step:** Open the agent and click **"Publish"** in the top right to activate it.
`;
          }

          return `### 🤖 [${ag.displayName}](${directAgentUrl})
- **Previously Shared With:** \`${sharedWithText}\`
- **Next Step:**
  1. Open the agent and click **"Publish"** in the top right.
  2. Click **"Share"** in the top right and re-add: \`${sharedWithText}\`.
`;
        }).join('\n')
      : '_No custom agents found for your account._';

    const nbList = data.notebooks.length > 0
      ? data.notebooks.map(nb => {
          const directNbUrl = `https://vertexaisearch.cloud.google.com/home/cid/${data.targetCid}/r/notebook/${nb.targetId || nb.id}?hl=en_US`;
          return `- 📓 **[${nb.displayName}](${directNbUrl})**
  - **Status:** Restored with all your sources and notes.
  - **Next Step:** Open notebook and click **"Share"** if you'd like to invite colleagues.`;
        }).join('\n')
      : '_No research notebooks found for your account._';

    return `# 🚀 Welcome to Your New Gemini Enterprise Workspace

Hello **${data.userEmail}**,

Your Gemini Enterprise custom agents, research notebooks, and past conversations have been successfully transferred and are ready for you.

---

## 🤖 1. Your Custom Agents
Your agents have been transferred with their prompts, tools, and configurations intact.

${agList}

👉 **[Go to My Agents](${data.agentsWebUrl})**

> 💡 *Note: If your agent connects to Google Workspace (Gmail, Drive, Calendar), clicking "Publish" will ask you to approve access so the agent can work on your behalf.*

---

## 📓 2. Your Research Notebooks
All of your notebooks, sources, and generated study guides have been restored. Your generated study guides, FAQs, and briefing documents are also attached to this email.

${nbList}

👉 **[Go to My Notebooks](${data.notebooksWebUrl})**

---

## 💬 3. Previous Conversations Automatically Restored
All of your past search and chat conversations (**${data.sessions.length} conversation threads**) have been transferred to your new account:
- **What was restored:** Your complete question history, AI responses, and source citations.
- **Where to find them:** They will automatically appear chronologically in your left-hand **History** sidebar whenever you chat in Gemini.
- **Action required:** None — your conversation history is ready and waiting for you.

---

*Gemini Enterprise Support*
`;
  }

  /**
   * Generates clean, modern, end-user friendly HTML email
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
          const directAgentUrl = `https://vertexaisearch.cloud.google.com/home/cid/${data.targetCid}/r/agents/${ag.targetId || ag.id}?hl=en_US`;

          const badge = isPrivate
            ? `<span style="background-color: #064e3b; color: #a7f3d0; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 6px;">🔒 Private</span>`
            : `<span style="background-color: #451a03; color: #fde68a; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 6px;">👥 Shared with Colleagues</span>`;

          const instruction = isPrivate
            ? `Click into your agent and press <strong>Publish</strong> to activate.`
            : `Click into your agent, press <strong>Publish</strong>, then click <strong>Share</strong> to re-add: <code>${filteredCollaborators.join(', ')}</code>`;

          return `
            <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <a href="${directAgentUrl}" target="_blank" style="color: #60a5fa; font-weight: 600; font-size: 14px; text-decoration: none;">🤖 ${ag.displayName} &rarr;</a>
                ${badge}
              </div>
              <p style="margin: 0; font-size: 12px; color: #cbd5e1; line-height: 1.4;">
                ${instruction}
              </p>
            </div>
          `;
        }).join('')
      : '<p style="color: #94a3b8; font-size: 13px; margin: 0;">No custom agents found for your account.</p>';

    const nbCards = data.notebooks.length > 0
      ? data.notebooks.map(nb => {
          const directNbUrl = `https://vertexaisearch.cloud.google.com/home/cid/${data.targetCid}/r/notebook/${nb.targetId || nb.id}?hl=en_US`;
          const artCount = nb.details?.artifactsCount || nb.details?.artifacts?.length || 0;
          const noteCount = nb.details?.notesCount || nb.details?.notes?.length || 0;

          return `
            <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px;">
              <div style="margin-bottom: 4px;">
                <a href="${directNbUrl}" target="_blank" style="color: #34d399; font-weight: 600; font-size: 14px; text-decoration: none;">📓 ${nb.displayName} &rarr;</a>
              </div>
              <p style="margin: 0; font-size: 12px; color: #cbd5e1; line-height: 1.4;">
                ✅ Restored with sources, notes, and study materials. Click <strong>Share</strong> inside the notebook if you'd like to invite team members.
              </p>
            </div>
          `;
        }).join('')
      : '<p style="color: #94a3b8; font-size: 13px; margin: 0;">No research notebooks found for your account.</p>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Welcome to Gemini Enterprise</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 24px;">
  <div style="max-width: 640px; margin: 0 auto; background-color: #0f172a; border: 1px solid #334155; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);">
    
    <!-- Hero Header -->
    <div style="background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%); padding: 32px 28px; text-align: left; color: #ffffff;">
      <h1 style="margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em;">
        🚀 Welcome to Your New Gemini Enterprise Workspace
      </h1>
      <p style="margin: 8px 0 0 0; font-size: 14px; opacity: 0.95; line-height: 1.4;">
        Hi <strong>${data.userEmail}</strong>, your agents, research notebooks, and conversations have been transferred and are ready for you.
      </p>
    </div>

    <!-- Body Content -->
    <div style="padding: 28px 24px; background-color: #0f172a;">
      
      <!-- Section 1: Agents -->
      <div style="margin-bottom: 28px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <h2 style="margin: 0; font-size: 16px; font-weight: 700; color: #f8fafc;">
            🤖 Your Custom Agents
          </h2>
          <a href="${data.agentsWebUrl}" target="_blank" style="background-color: #2563eb; color: #ffffff; padding: 6px 14px; border-radius: 8px; text-decoration: none; font-size: 12px; font-weight: 600;">
            Open My Agents &rarr;
          </a>
        </div>
        <p style="margin: 0 0 12px 0; font-size: 13px; color: #94a3b8; line-height: 1.4;">
          Your custom agents are transferred into your drafts. Click into each agent to publish and activate it:
        </p>
        ${agCards}
      </div>

      <!-- Section 2: Notebooks -->
      <div style="margin-bottom: 28px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <h2 style="margin: 0; font-size: 16px; font-weight: 700; color: #f8fafc;">
            📓 Your Research Notebooks
          </h2>
          <a href="${data.notebooksWebUrl}" target="_blank" style="background-color: #059669; color: #ffffff; padding: 6px 14px; border-radius: 8px; text-decoration: none; font-size: 12px; font-weight: 600;">
            Open My Notebooks &rarr;
          </a>
        </div>
        <p style="margin: 0 0 12px 0; font-size: 13px; color: #94a3b8; line-height: 1.4;">
          All your notebooks and research sources are ready. Generated study guides and briefing notes are attached to this email.
        </p>
        ${nbCards}
      </div>

      <!-- Section 3: Chats Info Callout -->
      <div style="background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 18px 20px;">
        <h3 style="margin: 0 0 6px 0; font-size: 14px; font-weight: 700; color: #f8fafc;">
          💬 Previous Conversations Automatically Restored (${data.sessions.length} Threads)
        </h3>
        <p style="margin: 0 0 6px 0; font-size: 13px; color: #cbd5e1; line-height: 1.5;">
          All your past questions, detailed AI answers, and source citations have been migrated to your new account.
        </p>
        <p style="margin: 0; font-size: 12px; color: #94a3b8; line-height: 1.4;">
          ✨ <strong>No action required:</strong> Your previous conversations will automatically appear in your left-hand <em>History</em> sidebar when you chat in Gemini.
        </p>
      </div>

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
   * Renders structured slide decks into standalone, interactive HTML presentations
   */
  renderSlideDeckPresentation(title: string, notebookName: string, content: string): string {
    const rawSlides = content.split(/^##\s+Slide\s+\d+:?/im).filter(s => s.trim().length > 0);
    const slides = rawSlides.length > 0 ? rawSlides : [content];

    const slideCards = slides.map((s, idx) => {
      const lines = s.trim().split('\n');
      const slideTitle = lines[0]?.replace(/^[#*-]\s*/, '').trim() || `Slide ${idx + 1}`;
      const slideBody = lines.slice(1).join('\n')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/^- (.*)$/gm, '<li style="margin-bottom: 8px;">$1</li>')
        .replace(/\[(.*?)\]/g, '<div style="background-color: #1e293b; border-left: 4px solid #3b82f6; padding: 10px 14px; margin: 14px 0; border-radius: 0 6px 6px 0; color: #93c5fd; font-size: 13px;">$1</div>')
        .replace(/\n\n/g, '<br/><br/>');

      return `
        <div class="slide" id="slide-${idx}" style="${idx === 0 ? 'display: block;' : 'display: none;'}">
          <div class="slide-header">
            <span class="slide-badge">SLIDE ${idx + 1} OF ${slides.length}</span>
            <span class="notebook-tag">📓 ${notebookName}</span>
          </div>
          <h2 class="slide-title">${slideTitle}</h2>
          <div class="slide-content">
            ${slideBody}
          </div>
        </div>
      `;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Slide Deck</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: #0b0f19;
      color: #f1f5f9;
      margin: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
      box-sizing: border-box;
    }
    .deck-container {
      width: 100%;
      max-width: 900px;
      background-color: #111827;
      border: 1px solid #1f2937;
      border-radius: 16px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-height: 520px;
    }
    .slide {
      padding: 40px;
      flex: 1;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
    }
    .slide-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .slide-badge {
      background: linear-gradient(135deg, #3b82f6, #6366f1);
      color: white;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      padding: 4px 10px;
      border-radius: 6px;
    }
    .notebook-tag {
      color: #94a3b8;
      font-size: 12px;
    }
    .slide-title {
      font-size: 22px;
      font-weight: 700;
      color: #ffffff;
      margin: 0 0 20px 0;
      line-height: 1.3;
      border-bottom: 2px solid #1f2937;
      padding-bottom: 12px;
    }
    .slide-content {
      font-size: 15px;
      line-height: 1.7;
      color: #cbd5e1;
      flex: 1;
    }
    .controls {
      background-color: #0f172a;
      border-top: 1px solid #1f2937;
      padding: 16px 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .btn {
      background-color: #2563eb;
      color: white;
      border: none;
      padding: 8px 18px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      transition: background 0.2s;
    }
    .btn:hover { background-color: #1d4ed8; }
    .btn:disabled { background-color: #334155; cursor: not-allowed; opacity: 0.6; }
    .progress-text { font-size: 13px; color: #94a3b8; font-weight: 500; }
  </style>
</head>
<body>
  <div class="deck-container">
    ${slideCards}
    <div class="controls">
      <button class="btn" id="prevBtn" onclick="prevSlide()">◀ Previous</button>
      <span class="progress-text" id="counter">Slide 1 of ${slides.length}</span>
      <button class="btn" id="nextBtn" onclick="nextSlide()">Next ▶</button>
    </div>
  </div>

  <script>
    let current = 0;
    const total = ${slides.length};
    function updateUI() {
      for (let i = 0; i < total; i++) {
        const el = document.getElementById('slide-' + i);
        if (el) el.style.display = i === current ? 'block' : 'none';
      }
      document.getElementById('counter').innerText = 'Slide ' + (current + 1) + ' of ' + total;
      document.getElementById('prevBtn').disabled = current === 0;
      document.getElementById('nextBtn').disabled = current === total - 1;
    }
    function nextSlide() { if (current < total - 1) { current++; updateUI(); } }
    function prevSlide() { if (current > 0) { current--; updateUI(); } }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ') nextSlide();
      if (e.key === 'ArrowLeft') prevSlide();
    });
    updateUI();
  </script>
</body>
</html>`;
  }

  /**
   * Renders structured reports, study guides, and briefing docs into executive formatted HTML
   */
  renderDocumentHtml(title: string, type: string, notebookName: string, content: string): string {
    const formattedBody = content
      .replace(/^# (.*$)/gm, '<h1 style="color: #ffffff; font-size: 22px; margin-top: 24px; border-bottom: 2px solid #334155; padding-bottom: 8px;">$1</h1>')
      .replace(/^## (.*$)/gm, '<h2 style="color: #60a5fa; font-size: 18px; margin-top: 20px;">$1</h2>')
      .replace(/^### (.*$)/gm, '<h3 style="color: #a5b4fc; font-size: 15px; margin-top: 16px;">$1</h3>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^- (.*)$/gm, '<li style="margin-bottom: 6px;">$1</li>')
      .replace(/\[(.*?)\]/g, '<div style="background-color: #0f172a; border-left: 4px solid #3b82f6; padding: 10px 14px; margin: 12px 0; border-radius: 0 6px 6px 0; color: #93c5fd; font-size: 13px;">$1</div>')
      .replace(/\n\n/g, '<br/><br/>');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - ${type}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: #0b0f19;
      color: #cbd5e1;
      margin: 0;
      padding: 40px 20px;
      line-height: 1.6;
    }
    .doc-container {
      max-width: 800px;
      margin: 0 auto;
      background-color: #111827;
      border: 1px solid #1f2937;
      border-radius: 16px;
      padding: 40px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .doc-header {
      border-bottom: 1px solid #1f2937;
      padding-bottom: 20px;
      margin-bottom: 28px;
    }
    .doc-badge {
      background-color: #0369a1;
      color: #e0f2fe;
      font-size: 11px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 6px;
      display: inline-block;
      margin-bottom: 12px;
    }
    .doc-title {
      font-size: 24px;
      color: #ffffff;
      margin: 0 0 8px 0;
      font-weight: 700;
    }
    .doc-meta {
      font-size: 12px;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="doc-container">
    <div class="doc-header">
      <span class="doc-badge">${type.toUpperCase()}</span>
      <h1 class="doc-title">${title}</h1>
      <div class="doc-meta">📓 Notebook: <strong>${notebookName}</strong> &bull; Gemini Enterprise NotebookLM</div>
    </div>
    <div class="doc-body">
      ${formattedBody}
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Generates folders, reports, and exports NotebookLM artifacts in their intended rich formats
   */
  generateAllUserBundles(report: MigrationReport): Record<string, { folderPath: string; markdownPath: string; htmlPath: string; notebookArtifactsCount: number }> {
    const userGroups = this.groupReportByUser(report);
    const resultSummary: Record<string, any> = {};

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

      // 3. Extract & Save NotebookLM Artifacts & Notes in intended rich formats (Interactive HTML + Markdown)
      let nbArtifactCount = 0;
      for (const nb of userData.notebooks) {
        const cleanNbTitle = (nb.displayName || 'Notebook').replace(/[^a-zA-Z0-9_-]/g, '_');
        
        // Save Notebook Artifacts (Slide Decks, Infographics, Study Guides, FAQs, Briefing Docs)
        if (nb.details?.artifacts && Array.isArray(nb.details.artifacts)) {
          for (const art of nb.details.artifacts) {
            const artTitle = art.title || art.type || 'Artifact';
            const cleanArtTitle = artTitle.replace(/[^a-zA-Z0-9_-]/g, '_');
            const artType = (art.type || '').toLowerCase();
            const textContent = art.content || art.extractedText || '';

            if (artType.includes('slide') || artType.includes('presentation')) {
              // Interactive HTML Presentation Slide Deck
              const deckHtml = this.renderSlideDeckPresentation(artTitle, nb.displayName, textContent);
              const deckPath = path.join(nbArtifactsFolder, `${cleanNbTitle}_${cleanArtTitle}_SlideDeck.html`);
              fs.writeFileSync(deckPath, deckHtml, 'utf8');
              nbArtifactCount++;
            } else {
              // Formatted Executive HTML Document
              const docHtml = this.renderDocumentHtml(artTitle, art.type || 'Study Guide', nb.displayName, textContent);
              const docPath = path.join(nbArtifactsFolder, `${cleanNbTitle}_${cleanArtTitle}.html`);
              fs.writeFileSync(docPath, docHtml, 'utf8');
              nbArtifactCount++;
            }

            // Always provide companion Markdown document
            const mdFileName = `${cleanNbTitle}_${cleanArtTitle}.md`;
            const mdFilePath = path.join(nbArtifactsFolder, mdFileName);
            const content = `# ${nb.displayName} - ${artTitle}\n\n**Artifact Type:** \`${art.type}\`\n\n---\n\n${textContent}\n`;
            fs.writeFileSync(mdFilePath, content, 'utf8');
          }
        }

        // Save Studio Notes as Formatted HTML & Markdown
        if (nb.details?.notes && Array.isArray(nb.details.notes)) {
          for (const note of nb.details.notes) {
            const noteTitle = note.title || 'Studio Note';
            const cleanNoteTitle = noteTitle.replace(/[^a-zA-Z0-9_-]/g, '_');
            const noteContent = note.content || '';

            // Note HTML
            const noteHtml = this.renderDocumentHtml(noteTitle, 'Studio Note', nb.displayName, noteContent);
            const noteHtmlPath = path.join(nbArtifactsFolder, `${cleanNbTitle}_Note_${cleanNoteTitle}.html`);
            fs.writeFileSync(noteHtmlPath, noteHtml, 'utf8');
            nbArtifactCount++;

            // Note Markdown
            const fileName = `${cleanNbTitle}_Note_${cleanNoteTitle}.md`;
            const filePath = path.join(nbArtifactsFolder, fileName);
            const content = `# ${nb.displayName} - Note: ${noteTitle}\n\n---\n\n${noteContent}\n`;
            fs.writeFileSync(filePath, content, 'utf8');
          }
        }
      }

      logger.info(`Generated Handover Bundle for "${userEmail}" at: ${userFolder} (${nbArtifactCount} rich NotebookLM artifacts saved)`);
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
  }> {
    const userGroups = this.groupReportByUser(report);
    const userData = userGroups.get(options.userEmail) || Array.from(userGroups.values())[0];

    if (!userData) {
      throw new Error(`No handover data found for user email: ${options.userEmail}`);
    }

    // Ensure user bundle exists on disk
    this.generateAllUserBundles(report);

    const recipient = options.overrideRecipientEmail || options.userEmail;
    const fromAddress = options.senderEmail || process.env.SENDER_EMAIL || process.env.ADMIN_EMAIL || 'admin@example.com';
    const htmlBody = this.generateHtmlReport(userData);
    const textBody = this.generateMarkdownReport(userData);

    // Prepare attachments: HTML Checklist + NotebookLM Artifacts
    const sanitizedEmail = options.userEmail.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const userFolder = path.join(this.baseDir, sanitizedEmail);
    const attachments: Array<{ filename: string; path: string }> = [];

    const htmlPath = path.join(userFolder, 'MIGRATION_CHECKLIST.html');
    if (fs.existsSync(htmlPath)) {
      attachments.push({ filename: 'MIGRATION_CHECKLIST.html', path: htmlPath });
    }

    const nbArtFolder = path.join(userFolder, 'notebook_artifacts');
    if (fs.existsSync(nbArtFolder)) {
      const files = fs.readdirSync(nbArtFolder);
      for (const f of files.slice(0, 15)) { // Attach top 15 NotebookLM artifact documents
        const fullPath = path.join(nbArtFolder, f);
        if (fs.statSync(fullPath).isFile()) {
          attachments.push({
            filename: f,
            path: fullPath
          });
        }
      }
    }

    const mailOptions = {
      from: `"Gemini Enterprise" <${fromAddress}>`,
      to: recipient,
      subject: `🚀 Welcome to Your New Gemini Enterprise Workspace (${userData.userEmail})`,
      text: textBody,
      html: htmlBody,
      attachments
    };

    // 1. Build standard RFC 2822 MIME message strictly in-memory
    const memTransport = nodemailer.createTransport({
      streamTransport: true,
      newline: 'windows',
      buffer: true
    });

    const compiledInfo = await memTransport.sendMail(mailOptions);
    const rawMimeBuffer = compiledInfo.message as Buffer;

    // 2. Save local .eml file directly in user folder for offline desktop access
    const emlPath = path.join(userFolder, 'MIGRATION_CHECKLIST.eml');
    fs.writeFileSync(emlPath, rawMimeBuffer);

    // 3. Dispatch: Check for custom corporate SMTP first
    if (options.smtpConfig?.host && options.smtpConfig?.auth?.user) {
      const smtpTransport = nodemailer.createTransport({
        host: options.smtpConfig.host,
        port: options.smtpConfig.port || 587,
        secure: options.smtpConfig.secure || false,
        auth: options.smtpConfig.auth
      });

      const smtpInfo = await smtpTransport.sendMail(mailOptions);
      logger.info(`Dispatched migration handover email via corporate SMTP to "${recipient}" (ID: ${smtpInfo.messageId})`);

      return {
        success: true,
        mode: 'CORPORATE_SMTP',
        message: `Email successfully dispatched via corporate SMTP (${options.smtpConfig.host}) to ${recipient}`,
        messageId: smtpInfo.messageId,
        emlPath,
        htmlPath,
        attachmentsCount: attachments.length
      };
    }

    // 4. Primary: Dispatch via Google Workspace / Gmail REST API
    const rawBase64Url = rawMimeBuffer
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const authService = options.authService || new GcpAuthService();
    const token = options.accessToken || await authService.getAccessToken(fromAddress, ['https://www.googleapis.com/auth/gmail.send']);

    const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        raw: rawBase64Url
      })
    });

    const gmailData: any = await gmailRes.json();

    if (!gmailRes.ok) {
      const errDetail = gmailData?.error?.message || gmailRes.statusText;
      logger.error(`Gmail API send failed: ${errDetail}`);
      throw new Error(`Gmail API returned HTTP ${gmailRes.status}: ${errDetail}. (MIME bundle is saved locally at: ${emlPath})`);
    }

    logger.info(`Dispatched migration handover email via Gmail API from "${fromAddress}" to "${recipient}" (Gmail ID: ${gmailData.id}, ${attachments.length} attachments)`);

    return {
      success: true,
      mode: 'GMAIL_API',
      message: `Email successfully sent via Google Gmail API to ${recipient} (${attachments.length} attachments)`,
      messageId: gmailData.id,
      threadId: gmailData.threadId,
      emlPath,
      htmlPath,
      attachmentsCount: attachments.length
    };
  }
}
