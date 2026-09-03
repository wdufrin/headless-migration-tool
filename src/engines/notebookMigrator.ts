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

import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { EnvironmentConfig, MigrationOptions, MigrationItemResult, MigratedSourceItem } from '../types/migration.js';
import { Notebook, NotebookSource, NotebookNote } from '../types/index.js';
import { mapConcurrent } from '../utils/concurrency.js';
import { logger } from '../utils/logger.js';

export class NotebookMigrator {
  private client: DiscoveryEngineClient;

  constructor(client: DiscoveryEngineClient) {
    this.client = client;
  }

  /**
   * Evaluates if a notebook is associated with a specific user or user filter.
   */
  isNotebookOwnedByUser(notebook: Notebook, userFilter: string[] = []): boolean {
    if (userFilter.length === 0 || userFilter.includes('*') || userFilter.includes('*@*')) {
      return true;
    }

    const candidateOwners = [
      notebook.owner,
      notebook.creator,
      notebook.metadata?.owner,
      notebook.metadata?.creator,
      notebook.metadata?.ownerEmail,
      notebook.metadata?.creatorEmail
    ].filter(Boolean) as string[];

    const lowerFilters = userFilter.map(u => u.toLowerCase().trim().replace(/^user:/i, ''));
    return candidateOwners.some(owner => {
      const lowerOwner = owner.toLowerCase().trim().replace(/^user:/i, '');
      return lowerFilters.some(filter => {
        if (filter.startsWith('*@')) {
          const domain = filter.substring(2);
          return lowerOwner.endsWith(`@${domain}`);
        }
        return lowerOwner === filter;
      });
    });
  }

  /**
   * Extracts readable text content from rich text / Tailwind doc structures.
   */
  private extractTextFromTailwindDoc(doc: any): string {
    if (!doc?.body?.content) return '';
    let text = '';
    for (const block of doc.body.content) {
      if (block.paragraph?.elements) {
        for (const element of block.paragraph.elements) {
          if (element.textRun?.content) {
            text += element.textRun.content;
          }
        }
      }
    }
    return text;
  }

  /**
   * Formats raw artifact enum types into human-friendly strings.
   */
  private formatArtifactTypeName(type?: string): string {
    switch (type) {
      case 'ARTIFACT_TYPE_SLIDES': return 'Slide Deck';
      case 'ARTIFACT_TYPE_INFOGRAPHIC': return 'Infographic';
      case 'ARTIFACT_TYPE_TAILORED_REPORT': return 'Briefing Document / Report';
      case 'ARTIFACT_TYPE_AUDIO_OVERVIEW': return 'Audio Overview';
      case 'ARTIFACT_TYPE_MIND_MAP': return 'Mind Map';
      case 'ARTIFACT_TYPE_EXPLAINER_VIDEO': return 'Video Overview';
      case 'ARTIFACT_TYPE_APP': return 'Interactive App (Quiz / Flashcards)';
      default: return 'Studio Document';
    }
  }

  /**
   * Extracts structured text and analysis from Studio artifacts (Slide Decks, Infographics, Reports, etc.)
   */
  private extractTextFromArtifact(artifact: any): string {
    if (!artifact) return '';

    // 1. Slide Deck Artifacts
    if (artifact.slides?.slides && Array.isArray(artifact.slides.slides)) {
      let content = `# Slide Deck: ${artifact.title || artifact.slides.title || 'Presentation'}\n\n`;
      artifact.slides.slides.forEach((slide: any, idx: number) => {
        content += `## Slide ${idx + 1}: ${slide.title || 'Slide'}\n`;
        if (slide.fullDescription) {
          content += `${slide.fullDescription}\n\n`;
        } else if (slide.description) {
          content += `${slide.description}\n\n`;
        }
      });
      return content.trim();
    }

    // 2. Infographics
    if (artifact.infographic?.infographics && Array.isArray(artifact.infographic.infographics)) {
      let content = `# Infographic: ${artifact.title || artifact.infographic.title || 'Infographic'}\n\n`;
      artifact.infographic.infographics.forEach((info: any, idx: number) => {
        content += `## Section ${idx + 1}: ${info.title || 'Section'}\n`;
        if (info.fullDescription) {
          content += `${info.fullDescription}\n\n`;
        } else if (info.description) {
          content += `${info.description}\n\n`;
        }
      });
      return content.trim();
    }

    // 3. Tailored Reports / Briefing Docs
    if (artifact.tailoredReport?.content) {
      return artifact.tailoredReport.content;
    }

    // 4. Interactive Learning Apps (Quizzes / Flashcards)
    if (artifact.app?.appHtml) {
      return `# Interactive App: ${artifact.title || 'Studio App'}\n\nThis is an authentic, self-contained interactive HTML5 learning application (Quiz / Flashcards) generated by NotebookLM Studio. The standalone interactive application is preserved as an offline HTML file.`;
    }

    // 5. Explainer Video Overview
    if (artifact.explainerVideo) {
      return `# Video Overview: ${artifact.title || 'Video Overview'}\n\nHigh-definition video overview synthesized by NotebookLM Studio. Preserved as an MP4 media file.`;
    }

    // 6. Audio Overview / Podcast
    if (artifact.audioOverview) {
      return `# Audio Overview: ${artifact.title || 'Audio Overview'}\n\nAutonomous multi-speaker podcast audio overview synthesized by NotebookLM Studio. Preserved as a high-fidelity WAV audio file.`;
    }

    // 7. Generic content or TailwindDoc
    if (artifact.content) {
      return artifact.content;
    }

    if (artifact.tailwindDocContent || artifact.tailwindDoc) {
      const extracted = this.extractTextFromTailwindDoc(artifact.tailwindDocContent || artifact.tailwindDoc);
      if (extracted) return extracted;
    }

    return '';
  }

  /**
   * Maps a source from the source environment into a payload accepted by target sources:batchCreate.
   */
  mapSourceToPayload(source: NotebookSource): any {
    const sourceName = source.title || source.displayName || 'Restored Source';
    const gDocsMeta = source.metadata?.googleDocsMetadata || source.metadata?.google_docs_metadata;
    const ytMeta = source.metadata?.youtubeMetadata || source.metadata?.youtube_metadata;
    const asMeta = source.metadata?.agentspaceMetadata || source.metadata?.agentspace_metadata;
    const webMeta = source.metadata?.webpageMetadata || source.metadata?.webpage_metadata;

    if (gDocsMeta?.documentId) {
      return {
        googleDriveContent: {
          sourceName,
          documentId: gDocsMeta.documentId,
          mimeType: gDocsMeta.mimeType || 'application/vnd.google-apps.document'
        }
      };
    }

    if (ytMeta) {
      const youtubeUrl = ytMeta.youtubeUrl || ytMeta.uri || ytMeta.url || (ytMeta.videoId ? `https://www.youtube.com/watch?v=${ytMeta.videoId}` : undefined);
      if (youtubeUrl) {
        return {
          videoContent: { youtubeUrl }
        };
      }
    }

    if (asMeta) {
      const extractedText = source.content || source.text || this.extractTextFromTailwindDoc(source.tailwindDoc);
      if (extractedText) {
        return {
          textContent: {
            sourceName,
            content: extractedText
          }
        };
      }
      return {
        agentspaceContent: {
          documentName: asMeta.documentName
        }
      };
    }

    if (webMeta?.webpageUrl || source.webScrapeConfig?.url || source.url) {
      return {
        webContent: {
          sourceName,
          url: webMeta?.webpageUrl || source.webScrapeConfig?.url || source.url
        }
      };
    }

    // Default Fallback: Raw text content
    return {
      textContent: {
        sourceName,
        content: source.content || source.text || this.extractTextFromTailwindDoc(source.tailwindDoc) || `[Restored Source: ${sourceName}]`
      }
    };
  }

  /**
   * Migrates notebooks from source environment to target environment on behalf of users.
   */
  async migrateNotebooks(
    sourceEnv: EnvironmentConfig,
    targetEnv: EnvironmentConfig,
    options: MigrationOptions = {},
    identityMapping: Record<string, string> = {},
    discoveredUsers: string[] = []
  ): Promise<MigrationItemResult[]> {
    logger.info(`Discovering notebooks in source project: ${sourceEnv.projectId} (${sourceEnv.appLocation})...`);

    // 1. Resolve Candidate Users for Multi-User DWD Notebook Discovery
    const candidateUsers = new Set<string>();
    const hasExplicitFilter = options.userFilter && options.userFilter.length > 0 && !options.userFilter.includes('*') && !options.userFilter.includes('*@*');

    if (hasExplicitFilter) {
      for (const u of options.userFilter!) {
        if (u.includes('@')) candidateUsers.add(u.replace(/^user:/i, '').trim());
      }
    } else {
      for (const u of discoveredUsers) {
        if (u.includes('@')) candidateUsers.add(u.replace(/^user:/i, '').trim());
      }
      for (const u of Object.keys(identityMapping)) {
        if (u.includes('@')) candidateUsers.add(u.replace(/^user:/i, '').trim());
      }
    }

    if (candidateUsers.size === 0) {
      const defaultAdmin = process.env.ADMIN_EMAIL || process.env.DEFAULT_USER_EMAIL || '';
      if (defaultAdmin) candidateUsers.add(defaultAdmin);
    }

    // 2. Discover Notebooks
    const allSourceNotebooks: Notebook[] = [];
    const seenNotebookIds = new Set<string>();

    // 2a. Explicit Notebook IDs (if specified)
    if (options.notebookIds && options.notebookIds.length > 0) {
      for (let rawId of options.notebookIds) {
        rawId = (rawId || '').trim();
        if (!rawId) continue;
        const nbId = rawId.includes('/') ? rawId.split('/').pop()! : rawId;
        if (nbId && !seenNotebookIds.has(nbId)) {
          try {
            const nb = await this.client.getNotebook(nbId, sourceEnv);
            seenNotebookIds.add(nbId);
            const owner = nb.owner || (nb.metadata?.ownerEmail as string) || Array.from(candidateUsers)[0] || 'admin';
            nb.owner = owner;
            allSourceNotebooks.push(nb);
            logger.info(`Explicitly added Notebook "${nb.title || nbId}" (ID: ${nbId}) for owner "${owner}".`);
          } catch (getErr: any) {
            logger.warn(`Could not fetch specified Notebook ID "${nbId}": ${getErr.message}`);
          }
        }
      }
    }

    // 2b. Discover Notebooks per user via Domain-Wide Delegation
    for (const userEmail of candidateUsers) {
      try {
        const userNotebooks = await this.client.listNotebooks(sourceEnv, userEmail);
        logger.info(`Discovered ${userNotebooks.length} notebooks for user "${userEmail}".`);
        for (const nb of userNotebooks) {
          const nbId = nb.name?.split('/').pop() || nb.notebookId || '';
          if (nbId && !seenNotebookIds.has(nbId)) {
            seenNotebookIds.add(nbId);
            nb.owner = userEmail;
            if (!nb.metadata) nb.metadata = {};
            nb.metadata.ownerEmail = userEmail;
            allSourceNotebooks.push(nb);
          }
        }
      } catch (err: any) {
        logger.debug(`Per-user notebook discovery skipped for "${userEmail}": ${err.message}`);
      }
    }

    // Fallback: If per-user discovery returned 0, query project root
    if (allSourceNotebooks.length === 0) {
      try {
        const rootNotebooks = await this.client.listNotebooks(sourceEnv);
        const selectedUser = (options.userFilter && options.userFilter.length === 1 && !options.userFilter[0].includes('*')) 
          ? options.userFilter[0].replace(/^user:/i, '').trim()
          : null;
        const fallbackOwner = selectedUser || Array.from(candidateUsers)[0] || 'admin';
        for (const nb of rootNotebooks) {
          const nbId = nb.name?.split('/').pop() || nb.notebookId || '';
          if (nbId && !seenNotebookIds.has(nbId)) {
            seenNotebookIds.add(nbId);
            nb.owner = fallbackOwner;
            if (!nb.metadata) nb.metadata = {};
            nb.metadata.ownerEmail = fallbackOwner;
            allSourceNotebooks.push(nb);
          }
        }
      } catch (rootErr: any) {
        logger.debug(`Root project notebook query skipped: ${rootErr.message}`);
      }
    }

    logger.info(`Total discovered source notebooks across all users: ${allSourceNotebooks.length}`);

    const userFilter = options.userFilter || [];
    const filteredNotebooks = allSourceNotebooks.filter(nb => {
      const nbId = nb.name.split('/').pop() || '';
      if (options.skipIds && (options.skipIds.includes(nbId) || options.skipIds.includes(`NOTEBOOK:${nbId}`))) {
        logger.info(`Skipping already-migrated Notebook "${nb.title || nbId}" (${nbId}) from previous checkpoint.`);
        return false;
      }
      return this.isNotebookOwnedByUser(nb, userFilter);
    });
    logger.info(`Selected ${filteredNotebooks.length} notebooks matching user filters.`);

    const concurrency = options.concurrency || 10;
    const isDryRun = options.dryRun === true;

    return mapConcurrent(filteredNotebooks, concurrency, async (nb: Notebook) => {
      const startTime = Date.now();
      const notebookId = nb.name.split('/').pop() || '';
      const selectedUser = (options.userFilter && options.userFilter.length === 1 && !options.userFilter[0].includes('*')) 
        ? options.userFilter[0].replace(/^.*\/subject\//i, '').replace(/^user:/i, '').trim()
        : null;
      const fallbackUser = selectedUser || Array.from(candidateUsers)[0] || process.env.ADMIN_EMAIL || 'admin';
      let rawOwner = nb.metadata?.ownerEmail || nb.owner || fallbackUser;
      rawOwner = rawOwner.replace(/^.*\/subject\//i, '').replace(/^user:/i, '').trim();
      try { rawOwner = decodeURIComponent(rawOwner); } catch {}
      const originalOwner = (rawOwner === 'unknown' || !rawOwner.includes('@')) ? fallbackUser : rawOwner;
      const targetOwner = identityMapping[originalOwner] || identityMapping[`user:${originalOwner}`] || (selectedUser || originalOwner);

      const result: MigrationItemResult = {
        id: notebookId,
        displayName: nb.title || nb.displayName || 'Untitled Notebook',
        type: 'NOTEBOOK',
        status: 'SUCCESS',
        originalOwner,
        targetOwner
      };

      const userImpersonation = (originalOwner && originalOwner !== 'unknown') ? originalOwner : (targetOwner && targetOwner !== 'unknown' ? targetOwner : undefined);

      let fullNotebook: Notebook = nb;
      let notes: NotebookNote[] = [];
      let artifacts: any[] = [];

      try {
        logger.info(`Fetching detailed sources & Studio artifacts for Notebook "${result.displayName}" (${notebookId})...`);
        fullNotebook = await this.client.getNotebook(notebookId, sourceEnv, userImpersonation);

        // Fetch detailed source data (tailwindDoc, document text) for each source
        if (fullNotebook.sources && fullNotebook.sources.length > 0) {
          fullNotebook.sources = await Promise.all(
            fullNotebook.sources.map(async (s) => {
              const sourceId = s.name?.split('/').pop() || s.sourceId?.id;
              if (!sourceId) return s;
              try {
                const fullSource = await this.client.getNotebookSource(notebookId, sourceId, sourceEnv, userImpersonation);
                return { ...s, ...fullSource };
              } catch (err: any) {
                logger.debug(`Could not fetch detailed source ${sourceId}: ${err.message}`);
                return s;
              }
            })
          );
        }

        // Fetch notes if available
        try {
          notes = await this.client.listNotes(notebookId, sourceEnv, userImpersonation);
        } catch (noteErr: any) {
          logger.debug(`No notes or failed to list notes for notebook ${notebookId}: ${noteErr.message}`);
        }

        // Fetch artifacts (Studio outputs: Slide Decks, Infographics, Audio Overview, Reports)
        try {
          artifacts = await this.client.listArtifacts(notebookId, sourceEnv, userImpersonation);
          if (artifacts.length > 0) {
            logger.info(`Found ${artifacts.length} Studio artifacts for Notebook "${result.displayName}"`);
          }
        } catch (artErr: any) {
          logger.debug(`Could not list artifacts for notebook ${notebookId}: ${artErr.message}`);
        }
      } catch (fetchErr: any) {
        logger.debug(`Could not fetch detailed notebook object for ${notebookId}: ${fetchErr.message}`);
      }

      const rawSources = fullNotebook.sources || [];
      const dryRunSources: MigratedSourceItem[] = rawSources.map(s => {
        const sTitle = s.displayName || s.title || 'Source';
        const sType = s.metadata?.originalSourceContentType || (s.metadata?.googleDocsMetadata ? 'GOOGLE_DOCS' : s.metadata?.webpageMetadata ? 'URL' : 'DOCUMENT');
        return {
          title: sTitle,
          sourceId: s.name?.split('/').pop() || s.sourceId?.id,
          type: sType,
          status: 'DRY_RUN'
        };
      });

      result.details = {
        sourcesCount: rawSources.length,
        sourcesRestored: rawSources.length,
        sourcesFailed: 0,
        sources: dryRunSources,
        notesCount: notes.length,
        notes: (notes || []).map((n: any) => ({
          title: n.title || 'Studio Note',
          content: n.content || this.extractTextFromTailwindDoc(n)
        })),
        artifactsCount: artifacts.length,
        artifacts: artifacts.map(a => ({
          id: a.artifactId || a.name?.split('/').pop(),
          title: a.title || this.formatArtifactTypeName(a.type),
          type: this.formatArtifactTypeName(a.type),
          content: this.extractTextFromArtifact(a),
          rawArtifact: a
        }))
      };

      if (isDryRun) {
        logger.info(`[DRY RUN] Would migrate Notebook "${result.displayName}" (ID: ${notebookId}) with ${result.details.sourcesCount} sources, ${result.details.notesCount} notes, and ${result.details.artifactsCount} Studio artifacts for owner ${targetOwner}`);
        result.status = 'DRY_RUN';
        result.durationMs = Date.now() - startTime;
        return result;
      }

      try {

        const userOwner = (targetOwner && targetOwner !== 'unknown') ? targetOwner : undefined;

        // 1. Create Target Notebook
        const notebookPayload: any = {
          title: fullNotebook.title || fullNotebook.displayName || 'Restored Notebook'
        };
        if (fullNotebook.emoji) {
          notebookPayload.emoji = fullNotebook.emoji;
        }

        const createdNotebook = await this.client.createNotebook(targetEnv, notebookPayload, userOwner);
        const newNotebookId = createdNotebook.name.split('/').pop() || '';
        result.targetId = newNotebookId;
        logger.info(`Created target Notebook "${result.displayName}" with new ID "${newNotebookId}" (Owner: ${userOwner || 'admin'})`);

        const sourceIdMap: Record<string, string> = {};
        const sourceDetails: MigratedSourceItem[] = [];
        let sourcesRestored = 0;
        let sourcesFailed = 0;

        // 2. Batch inject sources
        if (rawSources.length > 0) {
          const mappedSources = rawSources.map(s => this.mapSourceToPayload(s));
          const createdSources: any[] = [];
          const BATCH_SIZE = 5;
          for (let i = 0; i < mappedSources.length; i += BATCH_SIZE) {
            const chunk = mappedSources.slice(i, i + BATCH_SIZE);
            const rawChunk = rawSources.slice(i, i + BATCH_SIZE);

            try {
              const createdBatch = await this.client.batchCreateNotebookSources(newNotebookId, chunk, targetEnv, userOwner);
              if (createdBatch?.sources) {
                createdSources.push(...createdBatch.sources);
              }
              for (const s of rawChunk) {
                const sTitle = s.displayName || s.title || 'Source';
                const sType = s.metadata?.originalSourceContentType || (s.metadata?.googleDocsMetadata ? 'GOOGLE_DOCS' : s.metadata?.webpageMetadata ? 'URL' : 'DOCUMENT');
                sourceDetails.push({
                  title: sTitle,
                  sourceId: s.name?.split('/').pop() || s.sourceId?.id,
                  type: sType,
                  status: 'SUCCESS'
                });
                sourcesRestored++;
              }
            } catch (chunkErr: any) {
              logger.warn(`Batch source creation failed for Notebook ${newNotebookId} (${chunkErr.message}). Retrying individual sources in chunk...`);
              for (let j = 0; j < chunk.length; j++) {
                const singleSource = chunk[j];
                const rawSingle = rawChunk[j];
                const sTitle = rawSingle.displayName || rawSingle.title || 'Source';
                const sType = rawSingle.metadata?.originalSourceContentType || (rawSingle.metadata?.googleDocsMetadata ? 'GOOGLE_DOCS' : rawSingle.metadata?.webpageMetadata ? 'URL' : 'DOCUMENT');
                try {
                  const singleBatch = await this.client.batchCreateNotebookSources(newNotebookId, [singleSource], targetEnv, userOwner);
                  if (singleBatch?.sources) {
                    createdSources.push(...singleBatch.sources);
                  }
                  sourceDetails.push({
                    title: sTitle,
                    sourceId: rawSingle.name?.split('/').pop() || rawSingle.sourceId?.id,
                    type: sType,
                    status: 'SUCCESS'
                  });
                  sourcesRestored++;
                } catch (singleErr: any) {
                  logger.error(`Failed to migrate Source "${sTitle}" in Notebook ${newNotebookId}: ${singleErr.message}`);
                  sourceDetails.push({
                    title: sTitle,
                    sourceId: rawSingle.name?.split('/').pop() || rawSingle.sourceId?.id,
                    type: sType,
                    status: 'FAILED',
                    error: singleErr.message
                  });
                  sourcesFailed++;
                }
              }
            }
          }

          for (let i = 0; i < rawSources.length; i++) {
            const oldSourceId = rawSources[i].name?.split('/').pop() || rawSources[i].sourceId?.id;
            const newSourceId = createdSources[i]?.name?.split('/').pop() || createdSources[i]?.sourceId?.id;
            if (oldSourceId && newSourceId) {
              sourceIdMap[oldSourceId] = newSourceId;
            }
          }
          logger.info(`Restored ${sourcesRestored} sources (${sourcesFailed} failed) to Notebook ${newNotebookId}`);
        }

        // 3. Recreate notes if available
        if (notes && notes.length > 0) {
          for (const note of notes) {
            try {
              const notePayload = {
                title: note.title || 'Note',
                content: note.content || ''
              };
              await this.client.createNote(newNotebookId, notePayload, targetEnv, userOwner);
            } catch (noteErr: any) {
              logger.warn(`Could not create note "${note.title || 'Untitled'}" in target Notebook (${noteErr.message}). Notes are preserved as distinct artifacts in the user handover package.`);
            }
          }
        }

        // 4. Recreate artifacts / Studio outputs
        if (artifacts && artifacts.length > 0) {
          let restoredArtifactCount = 0;
          for (const artifact of artifacts) {
            try {
              // Rewrite source references
              const remappedSources = (artifact.sources || []).map((s: any) => {
                const oldId = s.sourceId?.id || s.sourceId;
                return { sourceId: { id: sourceIdMap[oldId] || oldId } };
              });

              const artifactPayload: any = {
                title: artifact.title || 'Artifact',
                type: artifact.type,
                sources: remappedSources
              };
              if (artifact.slides) artifactPayload.slides = artifact.slides;
              if (artifact.infographic) artifactPayload.infographic = artifact.infographic;
              if (artifact.tailoredReport) artifactPayload.tailoredReport = artifact.tailoredReport;
              if (artifact.audioOverview) artifactPayload.audioOverview = artifact.audioOverview;

              await this.client.createArtifact(newNotebookId, artifactPayload, targetEnv, userOwner);
              restoredArtifactCount++;
            } catch (artErr: any) {
              const artTypeName = this.formatArtifactTypeName(artifact.type);
              logger.warn(`Could not recreate native artifact "${artifact.title || artTypeName}" in target Notebook (${artErr.message}). Artifacts are preserved as distinct exports in the user handover package.`);
            }
          }
          if (restoredArtifactCount > 0) {
            logger.info(`Restored ${restoredArtifactCount} native artifacts to Notebook ${newNotebookId}`);
          }
        }

        result.details = {
          sourcesCount: rawSources.length,
          sourcesRestored,
          sourcesFailed,
          sources: sourceDetails,
          notesCount: notes ? notes.length : 0,
          artifactsCount: artifacts ? artifacts.length : 0,
          artifacts: (artifacts || []).map((a: any) => ({
            id: a.artifactId || a.name?.split('/').pop(),
            title: a.title || this.formatArtifactTypeName(a.type),
            type: this.formatArtifactTypeName(a.type),
            content: this.extractTextFromArtifact(a),
            rawArtifact: a
          })),
          notes: (notes || []).map((n: any) => ({
            title: n.title || 'Studio Note',
            content: n.content || this.extractTextFromTailwindDoc(n)
          }))
        };

        if (sourcesFailed > 0) {
          result.error = `${sourcesFailed} source(s) failed to restore in target`;
        }

      } catch (err: any) {
        if (err.message.includes('DWD Impersonation Failed') || err.message.includes('User does not exist') || err.message.includes('client_is_not_authorized') || err.message.includes('unauthorized_client')) {
          logger.warn(`[DROPPED / SKIPPED] Notebook "${result.displayName}" for offboarded/unmapped user "${originalOwner}" was dropped (target: "${targetOwner}"). Admin account will not be polluted.`);
          result.status = 'SKIPPED';
          result.error = `Skipped: User "${targetOwner || originalOwner}" not found in target Google Identity. Data safely dropped to prevent admin account pollution.`;
        } else {
          logger.error(`Failed to migrate Notebook "${result.displayName}" (${notebookId}): ${err.message}`);
          result.status = 'FAILED';
          result.error = err.message;
        }
      }

      result.durationMs = Date.now() - startTime;
      return result;
    });
  }
}
