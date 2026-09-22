import fs from 'fs';
import { GcpAuthService, isCredentialAutoloadDisabled } from '../services/gcpAuth.js';
import { ValidatedMigrationConfig } from '../config/configSchema.js';
import { getSafeDiscoveryEngineUrl } from '../security/validator.js';
import { IdentityMappingService } from '../services/identityMappingService.js';
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
    // Only fill in a DWD key when the caller has not configured one. This used to
    // run unconditionally, silently overwriting an explicitly-supplied credential
    // with whatever happened to be sitting in the process working directory.
    if (
      !isCredentialAutoloadDisabled() &&
      !this.auth.hasDwdConfigured() &&
      fs.existsSync('./sa-dwd-key.json')
    ) {
      logger.debug('SessionMigrator: auto-loading DWD key from ./sa-dwd-key.json');
      this.auth.setServiceAccountKey('./sa-dwd-key.json');
    }
  }

  private sessionCache = new Map<string, Promise<ChatSession>>();

  private async getAuthToken(userEmail?: string): Promise<string> {
    const email = userEmail || process.env.ADMIN_EMAIL || process.env.DEFAULT_USER_EMAIL || '';
    return this.auth.getAccessToken(email);
  }

  public async getSession(sessionName: string, userEmail?: string): Promise<ChatSession> {
    const cached = this.sessionCache.get(sessionName);
    if (cached) return cached;

    const fetchPromise = (async () => {
      const token = await this.getAuthToken(userEmail);
      const projectId = sessionName.split('/')[1] || this.config.source.projectId;
      const parts = sessionName.split('/');
      const locIndex = parts.indexOf('locations');
      const location = locIndex !== -1 ? parts[locIndex + 1] : this.config.source.appLocation || 'global';
      const baseUrl = getSafeDiscoveryEngineUrl(location);
      const url = `${baseUrl}/v1alpha/${sessionName}?includeAnswerDetails=true`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Goog-User-Project': projectId
        }
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch session (${response.status}): ${errText}`);
      }

      return await response.json() as ChatSession;
    })();

    this.sessionCache.set(sessionName, fetchPromise);
    try {
      return await fetchPromise;
    } catch (err) {
      this.sessionCache.delete(sessionName);
      throw err;
    }
  }

  public async getAnswer(resourceName: string, userEmail?: string): Promise<any> {
    // 1. If this is a session sub-resource (assistAnswers or answers), resolve via session hydration
    if (resourceName.includes('/sessions/')) {
      const sessionName = resourceName.replace(/\/(assistAnswers|answers)\/[^/]+$/, '');
      try {
        const sess = await this.getSession(sessionName, userEmail);
        const turns = sess.turns || [];
        for (const t of turns) {
          const det = (t as any).detailedAssistAnswer || (t as any).detailedAnswer;
          if (det && det.name === resourceName) {
            return det;
          }
          if (t.assistAnswer === resourceName || t.answer === resourceName) {
            if (det) return det;
          }
        }
        const matchTurn = turns.find(t => t.assistAnswer === resourceName || t.answer === resourceName);
        if (matchTurn) {
          const matchDet = (matchTurn as any).detailedAssistAnswer || (matchTurn as any).detailedAnswer;
          if (matchDet) return matchDet;
        }
      } catch (sessErr: any) {
        logger.debug(`Session hydration for answer ${resourceName} failed: ${sessErr.message}`);
      }
    }

    // 2. Direct fetch fallback
    const token = await this.getAuthToken(userEmail);
    const projectId = resourceName.split('/')[1] || this.config.source.projectId;
    const parts = resourceName.split('/');
    const locIndex = parts.indexOf('locations');
    const location = locIndex !== -1 ? parts[locIndex + 1] : this.config.source.appLocation || 'global';
    const baseUrl = getSafeDiscoveryEngineUrl(location);
    const url = `${baseUrl}/v1alpha/${resourceName}`;

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
      const combined = chunks.join('').trim();
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
          if (content.thought && content.text) {
            replyTexts.push(`> 💭 *Reasoning:* ${content.text.trim()}`);
          } else if (content.text) {
            replyTexts.push(content.text.trim());
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

  public async listSourceSessions(candidateUsers: string[] = []): Promise<ChatSession[]> {
    const env = this.config.source;
    const usersToScan = new Set<string>();
    const hasExplicitFilter = this.config.options?.userFilter && this.config.options.userFilter.length > 0 && !this.config.options.userFilter.includes('*') && !this.config.options.userFilter.includes('*@*');

    if (hasExplicitFilter) {
      for (const u of this.config.options!.userFilter!) {
        if (u.includes('@')) usersToScan.add(u.replace(/^user:/i, '').trim());
      }
    } else {
      for (const u of candidateUsers) {
        if (u.includes('@')) usersToScan.add(u.replace(/^user:/i, '').trim());
      }
      if (this.config.identityMapping) {
        for (const k of Object.keys(this.config.identityMapping)) {
          if (k.includes('@')) usersToScan.add(k.replace(/^user:/i, '').trim());
        }
      }
    }

    if (usersToScan.size === 0 && !hasExplicitFilter) {
      const defaultAdmin = process.env.ADMIN_EMAIL || process.env.DEFAULT_USER_EMAIL || '';
      if (defaultAdmin) usersToScan.add(defaultAdmin);
    }

    const allSessions: ChatSession[] = [];
    const seenSessionIds = new Set<string>();

    const scanList = usersToScan.size > 0 ? Array.from(usersToScan) : [undefined];

    for (const email of scanList) {
      try {
        const token = await this.getAuthToken(email);
        const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
        let pageToken = '';

        do {
          const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
          const userFilterParam = email ? `&filter=user_pseudo_id%3D%22${encodeURIComponent(email)}%22` : '';
          const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections/${env.collectionId || 'default_collection'}/engines/${env.appId}/sessions?pageSize=100&view=SESSION_VIEW_FULL${userFilterParam}${pageParam}`;

          const response = await fetch(url, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-Goog-User-Project': env.projectId
            }
          });

          if (response.ok) {
            const data = await response.json() as any;
            for (const s of (data.sessions || [])) {
              const sid = s.name.split('/').pop() || s.name;
              if (!seenSessionIds.has(sid)) {
                seenSessionIds.add(sid);
                if (email && (!s.userPseudoId || !s.userPseudoId.includes('@'))) {
                  s.userPseudoId = email;
                }
                allSessions.push(s);
              }
            }
            pageToken = data.nextPageToken || '';
          } else {
            const errText = await response.text();
            logger.warn(`Could not list sessions for user ${email || 'all'} (${response.status}): ${errText}`);
            break;
          }
        } while (pageToken);
      } catch (err: any) {
        logger.warn(`Could not list sessions for user ${email || 'all'}: ${err.message}`);
      }
    }

    return allSessions;
  }

  public async listTargetSessions(userEmail?: string): Promise<ChatSession[]> {
    const env = this.config.target;
    const token = await this.getAuthToken(userEmail);
    const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
    const allSessions: ChatSession[] = [];
    let pageToken = '';

    do {
      const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections/${env.collectionId || 'default_collection'}/engines/${env.appId}/sessions?pageSize=100${pageParam}`;

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
      if (data.sessions && Array.isArray(data.sessions)) {
        allSessions.push(...data.sessions);
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    return allSessions;
  }

  public async migrateSession(session: ChatSession, targetUserOverride?: string): Promise<ChatSession> {
    const target = this.config.target;
    
    // Resolve target user email (maps numeric pseudo ID to target user account)
    let targetUserId = targetUserOverride;
    if (!targetUserId) {
      const srcUser = session.userPseudoId;
      const defaultUser = this.config.options?.userFilter?.[0]?.replace(/^.*\/subject\//i, '').replace(/^user:/i, '').trim();
      let cleanSrcUser = srcUser ? srcUser.replace(/^.*\/subject\//i, '').replace(/^user:/i, '').trim() : '';
      try { cleanSrcUser = decodeURIComponent(cleanSrcUser); } catch {}

      const mappedFromDict = IdentityMappingService.lookupTargetIdentity(cleanSrcUser || srcUser, this.config.identityMapping, '');
      if (mappedFromDict && mappedFromDict !== (cleanSrcUser || srcUser)) {
        targetUserId = mappedFromDict;
      } else if (cleanSrcUser && this.config.identityMapping?.[cleanSrcUser]) {
        targetUserId = this.config.identityMapping[cleanSrcUser];
      } else if (srcUser && this.config.identityMapping?.[srcUser]) {
        targetUserId = this.config.identityMapping[srcUser];
      } else if (cleanSrcUser && cleanSrcUser.includes('@')) {
        targetUserId = cleanSrcUser;
      } else if (defaultUser && defaultUser.includes('@')) {
        targetUserId = defaultUser;
      } else {
        targetUserId = process.env.DEFAULT_USER_EMAIL || process.env.ADMIN_EMAIL || 'admin';
      }
    }

    const token = await this.getAuthToken(targetUserId.includes('@') ? targetUserId : undefined);

    // If session has turns with answer references but lacks detailed answers, hydrate session once
    let currentSession = session;
    const srcUserEmail = currentSession.userPseudoId?.includes('@') ? currentSession.userPseudoId : undefined;
    const needsSessionHydration = currentSession.turns?.some(
      t => !((t as any).detailedAssistAnswer || (t as any).detailedAnswer) && (t.assistAnswer || (t.answer && t.answer.startsWith('projects/')))
    );
    if (needsSessionHydration && currentSession.name) {
      try {
        currentSession = await this.getSession(currentSession.name, srcUserEmail);
      } catch (e: any) {
        logger.debug(`Could not hydrate full session ${currentSession.name}: ${e.message}`);
      }
    }

    const rawTurns = currentSession.turns || [];
    const srcSessionId = currentSession.name.split('/').pop() || 'unknown';

    // Derive a clean, meaningful displayName
    const firstTurnWithQuery = rawTurns.find(t => t.query?.text || t.query?.parts?.some(p => p.text));
    const firstQueryText = firstTurnWithQuery?.query?.text ||
      firstTurnWithQuery?.query?.parts?.map(p => p.text || '').join(' ').trim() || '';

    let displayName = (currentSession.displayName || '').trim();
    if (!displayName || (displayName.length > 120 && firstQueryText && firstQueryText.length < 100)) {
      displayName = firstQueryText || displayName || 'Untitled Chat';
    }
    if (displayName.length > 150) {
      displayName = displayName.substring(0, 147) + '...';
    }

    const pairedTurns: Array<{ queryText: string; answerText?: string }> = [];

    for (const turn of rawTurns) {
      let qText = turn.query?.text;
      if (!qText && turn.query?.parts) {
        qText = turn.query.parts.map(p => p.text || '').join(' ').trim();
      }

      let ansText = '';
      if ((turn as any).detailedAssistAnswer || (turn as any).detailedAnswer) {
        ansText = this.extractTextFromAnswer((turn as any).detailedAssistAnswer || (turn as any).detailedAnswer);
      }
      if (!ansText) {
        const ansRef = turn.assistAnswer || turn.answer;
        if (ansRef && typeof ansRef === 'string' && ansRef.startsWith('projects/')) {
          try {
            const ansData = await this.getAnswer(ansRef, srcUserEmail);
            ansText = this.extractTextFromAnswer(ansData);
          } catch (e: any) {
            logger.debug(`Could not hydrate answer ${ansRef}: ${e.message}`);
          }
        } else if (turn.answer && typeof turn.answer === 'string' && !turn.answer.startsWith('projects/')) {
          ansText = turn.answer;
        }
      }

      // Check if session labels have workflow summary text (for scheduled workflow agents)
      if (!ansText && currentSession.labels) {
        const wfSummary = currentSession.labels.find(l => l.startsWith('workflow-summary-text:'));
        if (wfSummary) {
          ansText = wfSummary.substring('workflow-summary-text:'.length);
        }
      }

      if (qText) {
        const last = pairedTurns[pairedTurns.length - 1];
        if (last && last.queryText === qText) {
          if (ansText && (!last.answerText || last.answerText.startsWith('> 📋 **Archived Dialogue Record**'))) {
            last.answerText = ansText;
          }
        } else {
          pairedTurns.push({ queryText: qText, answerText: ansText || undefined });
        }
      } else if (ansText && pairedTurns.length > 0 && (!pairedTurns[pairedTurns.length - 1].answerText || pairedTurns[pairedTurns.length - 1].answerText?.startsWith('> 📋 **Archived Dialogue Record**'))) {
        pairedTurns[pairedTurns.length - 1].answerText = ansText;
      }
    }

    // Only after ALL raw turns are processed, apply fallback to any turns that STILL lack an answer
    for (const p of pairedTurns) {
      if (!p.answerText) {
        const timeStr = currentSession.startTime || new Date().toISOString();
        const srcProj = this.config.source?.projectId || 'source-workspace';
        p.answerText = `> 📋 **Archived Dialogue Record**\n> * **Source Project**: \`${srcProj}\`\n> * **Recorded Query**: \`${p.queryText}\`\n> * **Timestamp**: \`${timeStr}\`\n> * **Status**: Executed in source workspace. Restored for historical auditing and reference.`;
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
        query: { text: turnContent }
      });
    }

    const targetSessionLabels = [
      `source-session-id:${srcSessionId}`,
      `migrated-from-project:${this.config.source?.projectId || 'source'}`
    ];

    const payload: any = {
      displayName: displayName,
      userPseudoId: targetUserId,
      state: currentSession.state || 'IN_PROGRESS',
      labels: targetSessionLabels,
      turns: hydratedTurns
    };

    const baseUrl = getSafeDiscoveryEngineUrl(target.appLocation);
    const targetUrl = `${baseUrl}/v1alpha/projects/${target.projectId}/locations/${target.appLocation}/collections/${target.collectionId || 'default_collection'}/engines/${target.appId}/sessions`;

    // Probe target engine to avoid duplicate session creation on retry
    try {
      const existingSessions = await this.listTargetSessions(targetUserId.includes('@') ? targetUserId : undefined);
      const match = existingSessions.find(s => {
        if (s.labels?.includes(`source-session-id:${srcSessionId}`)) {
          return true;
        }
        if (
          displayName !== 'Restored Chat Session' &&
          displayName !== 'Untitled Chat' &&
          s.displayName === displayName &&
          hydratedTurns.length > 0 &&
          s.turns?.length === hydratedTurns.length
        ) {
          const sFirstQuery = s.turns?.[0]?.query?.text || '';
          const hFirstQuery = hydratedTurns[0]?.query?.text || '';
          if (sFirstQuery && hFirstQuery && sFirstQuery === hFirstQuery) {
            return true;
          }
        }
        return false;
      });
      if (match) {
        logger.info(`Session "${displayName}" already exists in target engine (Target ID: ${match.name.split('/').pop()}). Skipping duplicate creation.`);
        return match;
      }
    } catch (probeErr: any) {
      logger.debug(`Could not probe target sessions before create: ${probeErr.message}`);
    }

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
    logger.info(`Restored session "${displayName}" for ${targetUserId} with ${hydratedTurns.length} turns -> Target ID: ${created.name.split('/').pop()}`);
    return created as ChatSession;
  }
}
