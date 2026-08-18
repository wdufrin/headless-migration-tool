import fs from 'fs';
import { GcpAuthService } from '../services/gcpAuth.js';
import { ValidatedMigrationConfig } from '../config/configSchema.js';
import { logger } from '../utils/logger.js';

export interface ChatSessionTurn {
  query?: {
    queryId?: string;
    text?: string;
    parts?: Array<{ text?: string }>;
  };
  answer?: string;
  assistAnswer?: string;
  queryConfig?: {
    [key: string]: any;
  };
  assistToken?: string;
  name?: string;
  turnId?: string;
  createdAt?: string;
}

export interface ChatSession {
  name: string;
  displayName?: string;
  userPseudoId?: string;
  state?: string;
  turns?: ChatSessionTurn[];
  startTime?: string;
  endTime?: string;
  expireTime?: string;
}

export class SessionMigrator {
  private auth: GcpAuthService;
  private config: ValidatedMigrationConfig;

  constructor(config: ValidatedMigrationConfig, authService?: GcpAuthService) {
    this.config = config;
    this.auth = authService || new GcpAuthService();
    if (fs.existsSync('./sa-dwd-key.json')) {
      this.auth.setServiceAccountKey('./sa-dwd-key.json');
    }
  }

  private async getAuthToken(userEmail?: string): Promise<string> {
    const email = userEmail || process.env.ADMIN_EMAIL || process.env.DEFAULT_USER_EMAIL || '';
    return this.auth.getAccessToken(email);
  }

  public async getAnswer(resourceName: string): Promise<any> {
    const token = await this.getAuthToken();
    const projectId = resourceName.split('/')[1] || this.config.source.projectId;
    const url = `https://discoveryengine.googleapis.com/v1alpha/${resourceName}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Goog-User-Project': projectId
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to fetch answer (${response.status}): ${errText}`);
    }

    return await response.json();
  }

  private extractTextFromAnswer(ansData: any): string {
    if (!ansData) return '';

    // 1. Check if diagnosticInfo.plannerSteps has full streamed chunks (Multi-Agent EAP responses)
    const plannerSteps = ansData.diagnosticInfo?.plannerSteps || [];
    if (Array.isArray(plannerSteps) && plannerSteps.length > 0) {
      const chunks: string[] = [];
      for (const s of plannerSteps) {
        const parts = s.planStep?.parts || [];
        for (const p of parts) {
          const text = p.text || '';
          // Filter out internal thought headers like **Presenting BigQuery Access**\n\n
          if (/^\*\*[A-Z][a-zA-Z0-9\s-]+\*\*\n\n/.test(text.trim())) {
            continue;
          }
          if (text) {
            chunks.push(text);
          }
        }
      }
      const combined = chunks.join('').replace(/\[\[section:[^\]]+\]\]/g, '').trim();
      if (combined.length > 20) {
        return combined;
      }
    }

    // 2. Check replies array
    if (ansData.replies && Array.isArray(ansData.replies)) {
      const replyTexts: string[] = [];
      for (const r of ansData.replies) {
        const content = r.groundedContent?.content;
        if (content) {
          if (!content.thought && content.text) {
            replyTexts.push(content.text.replace(/\[\[section:[^\]]+\]\]/g, '').trim());
          }
          if (content.inlineData?.data) {
            try {
              let b64 = content.inlineData.data;
              const pad = b64.length % 4;
              if (pad) b64 += '='.repeat(4 - pad);
              const decoded = Buffer.from(b64, 'base64').toString('utf-8');
              const match = decoded.match(/<h1[^>]*>(.*?)<\/h1>/i) || decoded.match(/literalString":\s*"([^"]+)"/);
              if (match) {
                replyTexts.push(`[Interactive Canvas Panel: ${match[1].replace(/<[^>]+>/g, '').trim()}]`);
              }
            } catch {}
          }
          if (content.file) {
            replyTexts.push(`[Generated File: ${content.file.mimeType || 'attachment'}]`);
          }
        }
      }
      if (replyTexts.length > 0) {
        return replyTexts.filter(Boolean).join('\n\n');
      }
    }

    if (ansData.answerText) return ansData.answerText;
    if (ansData.answer_text) return ansData.answer_text;
    if (ansData.steps && Array.isArray(ansData.steps)) {
      const texts = ansData.steps.map((s: any) => s.description || s.thought || '').filter(Boolean);
      if (texts.length > 0) return texts.join('\n\n');
    }
    if (ansData.planStep?.parts && Array.isArray(ansData.planStep.parts)) {
      const texts = ansData.planStep.parts.map((p: any) => p.text || '').filter(Boolean);
      if (texts.length > 0) return texts.join('');
    }
    for (const k of ['text', 'content', 'message', 'reply']) {
      if (ansData[k] && typeof ansData[k] === 'string') return ansData[k];
    }
    if (ansData.reply?.replyText) return ansData.reply.replyText;
    return '';
  }

  public async listSourceSessions(): Promise<ChatSession[]> {
    const env = this.config.source;
    const token = await this.getAuthToken();
    const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections/${env.collectionId || 'default_collection'}/engines/${env.appId}/sessions?pageSize=100`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Goog-User-Project': env.projectId
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to list source sessions (${response.status}): ${errText}`);
    }

    const data = await response.json() as any;
    return (data.sessions || []) as ChatSession[];
  }

  public async listTargetSessions(): Promise<ChatSession[]> {
    const env = this.config.target;
    const token = await this.getAuthToken();
    const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections/${env.collectionId || 'default_collection'}/engines/${env.appId}/sessions?pageSize=100`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Goog-User-Project': env.projectId
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to list target sessions (${response.status}): ${errText}`);
    }

    const data = await response.json() as any;
    return (data.sessions || []) as ChatSession[];
  }

  public async migrateSession(session: ChatSession, targetUserOverride?: string): Promise<ChatSession> {
    const target = this.config.target;
    
    // Resolve target user email (maps numeric pseudo ID to target user account)
    let targetUserId = targetUserOverride;
    if (!targetUserId) {
      const srcUser = session.userPseudoId;
      if (srcUser && this.config.identityMapping?.[srcUser]) {
        targetUserId = this.config.identityMapping[srcUser];
      } else if (srcUser && srcUser.includes('@')) {
        targetUserId = srcUser;
      } else {
        targetUserId = process.env.DEFAULT_USER_EMAIL || process.env.ADMIN_EMAIL || 'admin@example.com';
      }
    }

    const token = await this.getAuthToken(targetUserId.includes('@') ? targetUserId : undefined);

    // Hydrate & sanitize turns with deduplication
    const rawTurns = session.turns || [];
    const pairedTurns: Array<{ queryText: string; answerText?: string }> = [];

    for (const turn of rawTurns) {
      let qText = turn.query?.text;
      if (!qText && turn.query?.parts) {
        qText = turn.query.parts.map(p => p.text || '').join(' ').trim();
      }

      let ansText = '';
      const ansRef = turn.assistAnswer || turn.answer;
      if (ansRef && typeof ansRef === 'string' && ansRef.startsWith('projects/')) {
        try {
          const ansData = await this.getAnswer(ansRef);
          ansText = this.extractTextFromAnswer(ansData);
        } catch (e: any) {
          logger.warn(`Could not hydrate answer ${ansRef}: ${e.message}`);
        }
      } else if (turn.answer && typeof turn.answer === 'string') {
        ansText = turn.answer;
      }

      // Option 1: Structured Historical Record Fallback for unhydrated or ephemeral responses
      if (!ansText && qText) {
        const timeStr = turn.createdAt || session.startTime || new Date().toISOString();
        const srcProj = this.config.source?.projectId || 'source-workspace';
        ansText = `> 📋 **Archived Dialogue Record**\n> * **Source Project**: \`${srcProj}\`\n> * **Recorded Query**: \`${qText}\`\n> * **Timestamp**: \`${timeStr}\`\n> * **Status**: Executed in source workspace. Restored for historical auditing and reference.`;
      }

      if (qText) {
        const last = pairedTurns[pairedTurns.length - 1];
        if (last && last.queryText === qText) {
          if (ansText && !last.answerText) {
            last.answerText = ansText;
          }
        } else {
          pairedTurns.push({ queryText: qText, answerText: ansText || undefined });
        }
      }
    }

    const hydratedTurns: any[] = [];
    const srcProj = this.config.source?.projectId || 'source-workspace';

    for (let i = 0; i < pairedTurns.length; i++) {
      const p = pairedTurns[i];
      const isLast = i === pairedTurns.length - 1;

      let turnContent = `${p.queryText}`;
      if (p.answerText) {
        turnContent += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🤖 **Gemini Response:**\n\n${p.answerText}`;
      }

      if (isLast) {
        turnContent += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🔒 **Conversation Closed** — *Archived from \`${srcProj}\` for historical auditing and reference.*`;
      }

      hydratedTurns.push({
        query: { text: turnContent },
        answer: p.answerText || undefined
      });
    }

    const payload: any = {
      displayName: session.displayName || 'Restored Chat Session',
      userPseudoId: targetUserId,
      state: session.state || 'IN_PROGRESS',
      turns: hydratedTurns
    };

    const targetUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${target.projectId}/locations/${target.appLocation}/collections/${target.collectionId || 'default_collection'}/engines/${target.appId}/sessions`;

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Goog-User-Project': target.projectId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to create session in target (${response.status}): ${errText}`);
    }

    const created = await response.json() as any;
    logger.info(`Restored session "${session.displayName}" for ${targetUserId} with ${hydratedTurns.length} turns -> Target ID: ${created.name.split('/').pop()}`);
    return created as ChatSession;
  }
}
