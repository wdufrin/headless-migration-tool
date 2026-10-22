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
import { EnvironmentConfig, MigrationOptions, MigrationItemResult, MigratedSourceItem, AdminHitlNotebookCandidate } from '../types/migration.js';
import { Notebook, NotebookSource, NotebookNote } from '../types/index.js';
import { mapConcurrent } from '../utils/concurrency.js';
import { classifyImpersonationFailure } from '../utils/impersonationFailure.js';
import { IdentityMappingService } from '../services/identityMappingService.js';
import { logger } from '../utils/logger.js';
/**
 * Compares two notebook sources to determine if they represent the same underlying resource.
 */
export function isSameSource(a: NotebookSource, b: NotebookSource): boolean {
  if (!a || !b) return false;

  // 1. Google Docs documentId
  const aDocId = a.metadata?.googleDocsMetadata?.documentId || a.metadata?.google_docs_metadata?.documentId;
  const bDocId = b.metadata?.googleDocsMetadata?.documentId || b.metadata?.google_docs_metadata?.documentId;
  if (aDocId && bDocId && aDocId === bDocId) return true;

  // 2. YouTube URL or videoId
  const aYt = a.metadata?.youtubeMetadata?.youtubeUrl || a.metadata?.youtubeMetadata?.videoId || a.metadata?.youtubeMetadata?.uri || a.metadata?.youtubeMetadata?.url || a.metadata?.youtube_metadata?.youtubeUrl || a.metadata?.youtube_metadata?.videoId || a.metadata?.youtube_metadata?.uri || a.metadata?.youtube_metadata?.url;
  const bYt = b.metadata?.youtubeMetadata?.youtubeUrl || b.metadata?.youtubeMetadata?.videoId || b.metadata?.youtubeMetadata?.uri || b.metadata?.youtubeMetadata?.url || b.metadata?.youtube_metadata?.youtubeUrl || b.metadata?.youtube_metadata?.videoId || b.metadata?.youtube_metadata?.uri || b.metadata?.youtube_metadata?.url;
  if (aYt && bYt && aYt === bYt) return true;

  // 3. Web URL
  const aWeb = a.metadata?.webpageMetadata?.webpageUrl || a.metadata?.webpage_metadata?.webpageUrl || a.webScrapeConfig?.url || a.url;
  const bWeb = b.metadata?.webpageMetadata?.webpageUrl || b.metadata?.webpage_metadata?.webpageUrl || b.webScrapeConfig?.url || b.url;
  if (aWeb && bWeb && aWeb === bWeb) return true;

  // 4. Agentspace document name
  const aAs = a.metadata?.agentspaceMetadata?.documentName || a.metadata?.agentspace_metadata?.documentName;
  const bAs = b.metadata?.agentspaceMetadata?.documentName || b.metadata?.agentspace_metadata?.documentName;
  if (aAs && bAs && aAs === bAs) return true;

  // 5. Title / DisplayName matching (e.g. for uploaded PDFs, documents, text files)
  const aTitle = (a.displayName || a.title || '').trim().toLowerCase();
  const bTitle = (b.displayName || b.title || '').trim().toLowerCase();
  if (aTitle && bTitle && aTitle === bTitle) return true;

  return false;
}

export class NotebookMigrator {
  private client: DiscoveryEngineClient;

  constructor(client: DiscoveryEngineClient) {
    this.client = client;
  }

  /**
   * Formats the caller's role on a source notebook as a human-readable label
   * (e.g., `OWNER (PROJECT_ROLE_OWNER)`, `EDITOR (PROJECT_ROLE_WRITER)`, `VIEWER (PROJECT_ROLE_READER)`).
   */
  describeNotebookAccessRole(notebook: Notebook): string {
    const meta = notebook?.metadata;
    const rawRole = String(
      meta?.userRole ||
      notebook?.userRole ||
      notebook?.role ||
      notebook?.accessRole ||
      meta?.role ||
      ''
    ).toUpperCase().trim();

    if (meta?.isOwnerVerifiedByGet === true) {
      if (meta?.hasProjectLevelAdminElevation) {
        return 'OWNER (WARNING: user has project-level Admin permissions; shared colleague notebooks appear as owned)';
      }
      return 'OWNER (shared by owner: list.isShared=true, get.isShared=false)';
    }
    if (rawRole === 'PROJECT_ROLE_OWNER' || rawRole === 'OWNER' || rawRole.endsWith('_OWNER')) {
      return `OWNER (${rawRole})`;
    }
    if (rawRole === 'PROJECT_ROLE_WRITER' || rawRole === 'WRITER' || rawRole === 'EDITOR' || rawRole.endsWith('_WRITER') || rawRole.endsWith('_EDITOR')) {
      return `EDITOR (${rawRole})`;
    }
    if (rawRole === 'PROJECT_ROLE_READER' || rawRole === 'READER' || rawRole === 'VIEWER' || rawRole.endsWith('_READER') || rawRole.endsWith('_VIEWER')) {
      return `VIEWER (${rawRole})`;
    }
    if (rawRole && rawRole !== 'UNSPECIFIED' && rawRole !== 'PROJECT_ROLE_UNSPECIFIED') {
      return rawRole;
    }
    if (meta?.isShareable === false) {
      return 'EDITOR/VIEWER (isShareable=false)';
    }
    if (meta?.inferredRoleFromGet) {
      return String(meta.inferredRoleFromGet);
    }
    if (meta?.isShared === true) {
      return 'SHARED_NON_OWNER (isShared=true, userRole=UNSPECIFIED)';
    }
    if (meta?.isShared === false) {
      return 'OWNER (private, isShared=false)';
    }
    return `UNSPECIFIED (isShared=${meta?.isShared ?? 'unknown'}, isShareable=${meta?.isShareable ?? 'unknown'})`;
  }

  /**
   * Mirrors `isNotebookOwnedByUser` from Backup_Restore_App (`src/BackupPage.tsx:492-548`)
   * plus `GetNotebook` (`GET .../notebooks/{id}`) disambiguation when `listRecentlyViewed`
   * omits `userRole` in regional (`us`/`eu`) endpoints:
   * - In `listRecentlyViewed`, `isShared: true` means the notebook has collaborators (true for BOTH Owner-who-shared and Editor/Viewer).
   * - In `getNotebook`, `isShared: false` is returned for the Owner (`PROJECT_ROLE_OWNER`), while `isShared: true` is returned for Editor/Viewer.
   */
  isCallerNotebookOwner(notebook: Notebook, callerEmail?: string): boolean {
    if (!notebook) return false;
    const meta = notebook.metadata;

    if (meta?.isOwnerVerifiedByGet === true) {
      return true;
    }

    // 1. Standard project role check (from Backup_Restore_App BackupPage.tsx:508)
    const role = String(
      meta?.userRole ||
      notebook.userRole ||
      notebook.role ||
      notebook.accessRole ||
      meta?.role ||
      ''
    ).toUpperCase().trim();

    if (role && role !== 'UNSPECIFIED' && role !== 'PROJECT_ROLE_UNSPECIFIED') {
      if (role === 'PROJECT_ROLE_OWNER' || role === 'OWNER' || role.endsWith('_OWNER')) {
        // Still verify explicit owner email if a different owner email is explicitly stamped
        if (callerEmail) {
          const cleanCaller = callerEmail.toLowerCase().trim().replace(/^.*\/subject\//i, '').replace(/^user:/i, '');
          const explicitOwners = [
            notebook.owner,
            notebook.creator,
            meta?.owner,
            meta?.creator,
            meta?.ownerEmail,
            meta?.creatorEmail
          ]
            .filter(Boolean)
            .map((o) => String(o).toLowerCase().trim().replace(/^.*\/subject\//i, '').replace(/^user:/i, ''));
          if (explicitOwners.length > 0 && !explicitOwners.includes(cleanCaller)) {
            return false;
          }
        }
        return true;
      }
      // Any non-OWNER role (PROJECT_ROLE_WRITER, PROJECT_ROLE_READER, EDITOR, VIEWER, etc.) is NOT the owner
      return false;
    }

    if (meta?.isShareable === false) {
      return false;
    }

    // 2. Email checks against possible owner/creator fields (from Backup_Restore_App BackupPage.tsx:520)
    if (callerEmail) {
      const cleanCaller = callerEmail.toLowerCase().trim().replace(/^.*\/subject\//i, '').replace(/^user:/i, '');
      const explicitOwners = [
        notebook.owner,
        notebook.creator,
        meta?.owner,
        meta?.creator,
        meta?.ownerEmail,
        meta?.creatorEmail
      ]
        .filter(Boolean)
        .map((o) => String(o).toLowerCase().trim().replace(/^.*\/subject\//i, '').replace(/^user:/i, ''));

      if (explicitOwners.length > 0) {
        return explicitOwners.includes(cleanCaller);
      }
    }

    // 3. Fallback (from Backup_Restore_App BackupPage.tsx:539-547):
    // If `isShared` is true and `userRole` was NOT `PROJECT_ROLE_OWNER`, return false!
    if (meta) {
      if (meta.isShared === true) {
        return false;
      }
      const hasProtoMetadata =
        meta.createTime !== undefined ||
        meta.lastViewed !== undefined ||
        meta.isShared !== undefined;
      if (hasProtoMetadata && meta.isShareable !== true && meta.isShared !== false) {
        return false;
      }
      if (meta.isShared === false) {
        return true;
      }
    }

    return true;
  }

  /**
   * Evaluates if a notebook is owned by a specific user or user filter (excluding shared Editor/Viewer notebooks).
   */
  isNotebookOwnedByUser(notebook: Notebook, userFilter: string[] = []): boolean {
    const nonWildcardUsers = userFilter.filter((u) => u && !u.includes('*'));
    const primaryCaller = nonWildcardUsers.length === 1 ? nonWildcardUsers[0] : undefined;
    if (!this.isCallerNotebookOwner(notebook, primaryCaller)) {
      return false;
    }

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

    if (candidateOwners.length === 0) {
      return true;
    }

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
   * Supports Studio Notes (body.content[].paragraph.elements[].textRun.content)
   * as well as Notebook Source tailwindDoc structures (chunks[], text, sections[], etc.).
   */
  private extractTextFromTailwindDoc(doc: any): string {
    if (!doc) return '';
    if (typeof doc === 'string') return doc;

    let text = '';

    // 1. Direct text/content string on tailwindDoc
    if (typeof doc.text === 'string' && doc.text.trim()) {
      text += doc.text;
    } else if (typeof doc.content === 'string' && doc.content.trim()) {
      text += doc.content;
    }

    // 2. Chunks array (common in NotebookLM getNotebookSource responses)
    if (Array.isArray(doc.chunks)) {
      for (const chunk of doc.chunks) {
        if (typeof chunk === 'string') {
          text += chunk + '\n';
        } else if (chunk && typeof chunk === 'object') {
          const chunkText = chunk.text || chunk.content || chunk.rawText || chunk.markdown || '';
          if (typeof chunkText === 'string' && chunkText) {
            text += chunkText + '\n';
          } else if (chunk.body || chunk.paragraph) {
            text += this.extractTextFromTailwindDoc(chunk) + '\n';
          }
        }
      }
    }

    // 3. Sections / blocks array (paragraphs, tables, codeBlocks)
    const blockList = doc.body?.content || doc.sections || doc.blocks || (Array.isArray(doc.content) ? doc.content : undefined);
    if (Array.isArray(blockList)) {
      for (const block of blockList) {
        if (typeof block === 'string') {
          text += block + '\n';
        } else if (block?.paragraph?.elements) {
          for (const element of block.paragraph.elements) {
            if (element.textRun?.content) {
              text += element.textRun.content;
            }
          }
        } else if (block?.codeBlock?.content && typeof block.codeBlock.content === 'string') {
          text += block.codeBlock.content + '\n';
        } else if (block?.code_block?.content && typeof block.code_block.content === 'string') {
          text += block.code_block.content + '\n';
        } else if (block?.table?.tableRows || block?.table?.table_rows) {
          const rows = block.table.tableRows || block.table.table_rows || [];
          for (const row of rows) {
            const cells = row?.tableCells || row?.table_cells || [];
            const cellTexts: string[] = [];
            for (const cell of cells) {
              const cellText = this.extractTextFromTailwindDoc({ content: cell?.content });
              if (cellText) cellTexts.push(cellText);
            }
            if (cellTexts.length > 0) {
              text += cellTexts.join(' | ') + '\n';
            }
          }
        } else if (typeof block?.text === 'string') {
          text += block.text + '\n';
        } else if (typeof block?.content === 'string') {
          text += block.content + '\n';
        }
      }
    }

    return text.trim();
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
   * Extracts unformatted plain/markdown text from any available field on a NotebookSource
   * (content, text, markdownString, plainText, or tailwindDoc).
   */
  extractSourceText(source: NotebookSource): string {
    if (!source) return '';

    const rawPlainObj =
      (typeof source.plainText === 'object' && source.plainText) ||
      (typeof source.plain_text === 'object' && source.plain_text) ||
      null;
    const plainHeaderBody =
      rawPlainObj && (typeof rawPlainObj.body === 'string' || typeof rawPlainObj.header === 'string')
        ? [rawPlainObj.header, rawPlainObj.body].filter(Boolean).join('\n\n')
        : '';

    const plainTextVal =
      typeof source.plainText === 'string'
        ? source.plainText
        : typeof source.plain_text === 'string'
        ? source.plain_text
        : plainHeaderBody ||
          source.plainText?.text ||
          source.plainText?.content ||
          source.plain_text?.text ||
          source.plain_text?.content ||
          this.extractTextFromTailwindDoc(source.plainText || source.plain_text);

    const extracted =
      source.content ||
      source.text ||
      source.rawText ||
      source.raw_text ||
      source.markdown ||
      source.markdownString ||
      source.markdown_string ||
      plainTextVal ||
      source.userContent?.textContent?.content ||
      source.documentContent?.content ||
      this.extractTextFromTailwindDoc(
        source.tailwindDoc ||
          source.tailwind_doc ||
          source.tailwindDocContent ||
          source.tailwind_doc_content ||
          (source.chunks ? { chunks: source.chunks } : undefined)
      );

    return typeof extracted === 'string' ? extracted.trim() : '';
  }

  /**
   * Strips leading "Excerpts from ..." headers and inline citation markers (e.g. "[1]", "[1, 2]")
   * returned by the v1alpha `:interactSources` endpoint using Regex Pattern Matching.
   * Known limits: only strips numeric bracketed citations like [1] or [1, 2] to avoid
   * removing markdown links [label](url) or code array indexing.
   */
  cleanInteractSourcesResponse(rawResponse: string): string {
    if (!rawResponse || typeof rawResponse !== 'string') return '';
    let cleaned = rawResponse.trim();
    cleaned = cleaned.replace(/^\*\*Excerpts from\s+["']?.*?["']?\*\*\s*\n+/i, '');
    cleaned = cleaned.replace(/^Excerpts from\s+["']?.*?["']?:?\s*\n+/i, '');
    cleaned = cleaned.replace(/(\S)[ \t]+\[\d+(?:\s*,\s*\d+)*\](?!\()/g, '$1');
    cleaned = cleaned.trim();
    if (DiscoveryEngineClient.isBlockedOrRefusalResponse(cleaned)) {
      return '';
    }
    return cleaned;
  }

  /**
   * Extracts readable text from a Discovery Engine DataStore Document object
   * (content.rawBytes base64 UTF-8, structData, or jsonData).
   */
  extractTextFromDataStoreDocument(doc: any): string {
    if (!doc || typeof doc !== 'object') return '';

    if (typeof doc.content?.rawBytes === 'string' && doc.content.rawBytes.trim()) {
      const mimeType = String(doc.content.mimeType || '').toLowerCase();
      if (!mimeType || mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('markdown') || mimeType.includes('csv') || mimeType.includes('html')) {
        try {
          const decoded = Buffer.from(doc.content.rawBytes, 'base64').toString('utf8').trim();
          if (decoded && !decoded.includes('\uFFFD')) {
            return decoded;
          }
        } catch (decodeErr: any) {
          logger.debug(`Could not decode DataStore document rawBytes as UTF-8: ${decodeErr.message}`);
        }
      }
    }

    if (typeof doc.jsonData === 'string' && doc.jsonData.trim()) {
      return doc.jsonData.trim();
    }

    if (doc.structData && typeof doc.structData === 'object') {
      const s = doc.structData;
      const directText = s.content || s.text || s.body || s.description || s.markdown;
      if (typeof directText === 'string' && directText.trim()) {
        return directText.trim();
      }
      return JSON.stringify(doc.structData, null, 2);
    }

    return '';
  }

  /**
   * Builds a complete MigratedSourceItem entry for the JSON report, preserving the extracted
   * text content, URL/Drive/YouTube metadata, and the `userContent` recreation payload.
   */
  buildMigratedSourceItem(
    source: NotebookSource,
    status: MigratedSourceItem['status'],
    payload?: any,
    options?: { targetSourceId?: string; error?: string }
  ): MigratedSourceItem {
    const sTitle = source.displayName || source.title || 'Source';
    const sType =
      source.metadata?.originalSourceContentType ||
      (source.metadata?.googleDocsMetadata || source.metadata?.google_docs_metadata
        ? 'GOOGLE_DOCS'
        : source.metadata?.youtubeMetadata || source.metadata?.youtube_metadata
        ? 'YOUTUBE'
        : source.metadata?.webpageMetadata || source.metadata?.webpage_metadata
        ? 'URL'
        : 'DOCUMENT');
    const sourceId = source.name?.split('/').pop() || source.sourceId?.id;
    const resolvedPayload = payload !== undefined ? payload : this.mapSourceToPayload(source);
    const extractedContent = resolvedPayload?.textContent?.content || this.extractSourceText(source) || undefined;
    const webUrl =
      resolvedPayload?.webContent?.url ||
      source.metadata?.webpageMetadata?.webpageUrl ||
      source.metadata?.webpage_metadata?.webpageUrl ||
      source.webScrapeConfig?.url ||
      source.url ||
      undefined;
    const gDocId =
      resolvedPayload?.googleDriveContent?.documentId ||
      source.metadata?.googleDocsMetadata?.documentId ||
      source.metadata?.google_docs_metadata?.documentId ||
      undefined;
    const ytUrl =
      resolvedPayload?.videoContent?.youtubeUrl ||
      source.metadata?.youtubeMetadata?.youtubeUrl ||
      source.metadata?.youtube_metadata?.youtubeUrl ||
      undefined;

    const item: MigratedSourceItem = {
      title: sTitle,
      sourceId,
      type: sType,
      status
    };

    if (options?.targetSourceId) item.targetSourceId = options.targetSourceId;
    if (extractedContent) item.content = extractedContent;
    if (webUrl) item.url = webUrl;
    if (gDocId) item.googleDriveDocumentId = gDocId;
    if (ytUrl) item.youtubeUrl = ytUrl;
    if (resolvedPayload) item.userContent = resolvedPayload;
    if (options?.error) item.error = options.error;

    return item;
  }

  /**
   * Groups `{ raw, payload }` items into batches respecting both a maximum item count
   * and a maximum UTF-8 byte budget so large extracted PDF/book sources do not exceed
   * HTTP request payload limits during `sources:batchCreate`.
   */
  chunkSourcesForBatchCreate(
    items: Array<{ raw: NotebookSource; payload: any }>,
    maxCount: number = 5,
    maxBytes: number = 4 * 1024 * 1024
  ): Array<Array<{ raw: NotebookSource; payload: any }>> {
    const chunks: Array<Array<{ raw: NotebookSource; payload: any }>> = [];
    let currentChunk: Array<{ raw: NotebookSource; payload: any }> = [];
    let currentBytes = 0;

    for (const item of items) {
      const serialized = JSON.stringify(item.payload || {});
      const itemBytes = Buffer.byteLength(serialized, 'utf8');

      if (
        currentChunk.length > 0 &&
        (currentChunk.length >= maxCount || currentBytes + itemBytes > maxBytes)
      ) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentBytes = 0;
      }

      currentChunk.push(item);
      currentBytes += itemBytes;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  /**
   * Rewrites a source Agentspace document resource name (`projects/.../locations/.../collections/.../dataStores/.../branches/.../documents/...`)
   * to point to the target project, location, collection, and mapped DataStore ID when a target environment is provided.
   */
  rewriteAgentspaceDocumentName(
    documentName: string,
    targetEnv?: EnvironmentConfig,
    datastoreMapping: Record<string, string> = {},
    collectionMapping: Record<string, string> = {}
  ): string {
    if (!documentName || !targetEnv?.projectId) return documentName;
    const clean = documentName.replace(/^\/+/, '');
    const match = clean.match(
      /^projects\/([^/]+)\/locations\/([^/]+)\/collections\/([^/]+)\/dataStores\/([^/]+)\/(.+)$/
    );
    if (!match) return documentName;

    const [, , , oldColId, oldDsId, restPath] = match;
    const newColId = collectionMapping[oldColId] || targetEnv.collectionId || oldColId;
    const newDsId = datastoreMapping[oldDsId] || oldDsId;
    const newLoc = targetEnv.appLocation || match[2];

    return `projects/${targetEnv.projectId}/locations/${newLoc}/collections/${newColId}/dataStores/${newDsId}/${restPath}`;
  }

  /**
   * Maps a source from the source environment into a payload accepted by target sources:batchCreate.
   */
  mapSourceToPayload(
    source: NotebookSource,
    targetEnv?: EnvironmentConfig,
    datastoreMapping: Record<string, string> = {},
    collectionMapping: Record<string, string> = {}
  ): any {
    if ((source as any)?._fetchError) {
      return null;
    }

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

    const extractedText = this.extractSourceText(source);

    if (asMeta) {
      if (extractedText) {
        return {
          textContent: {
            sourceName,
            content: extractedText
          }
        };
      }
      if (asMeta.documentName) {
        return {
          agentspaceContent: {
            documentName: this.rewriteAgentspaceDocumentName(
              asMeta.documentName,
              targetEnv,
              datastoreMapping,
              collectionMapping
            )
          }
        };
      }
    }

    if (webMeta?.webpageUrl || source.webScrapeConfig?.url || source.url || /^https?:\/\/\S+$/i.test(sourceName.trim())) {
      return {
        webContent: {
          sourceName,
          url: webMeta?.webpageUrl || source.webScrapeConfig?.url || source.url || sourceName.trim()
        }
      };
    }

    // Fallback: Check for inline text, markdownString, plainText, or tailwindDoc text across all possible API response fields
    if (extractedText) {
      return {
        textContent: {
          sourceName,
          content: extractedText
        }
      };
    }

    // Do not fabricate a metadata-only text stub when full source content or link metadata is unavailable.
    // Returning null signals that this source cannot be migrated automatically and requires manual re-upload.
    return null;
  }

  /**
   * Migrates notebooks from source environment to target environment on behalf of users.
   */
  async migrateNotebooks(
    sourceEnv: EnvironmentConfig,
    targetEnv: EnvironmentConfig,
    options: MigrationOptions = {},
    identityMapping: Record<string, string> = {},
    discoveredUsers: string[] = [],
    datastoreMapping: Record<string, string> = {},
    collectionMapping: Record<string, string> = {}
  ): Promise<MigrationItemResult[]> {
    logger.info(`Discovering notebooks in source project: ${sourceEnv.projectId} (${sourceEnv.appLocation})...`);
    logger.info(
      `[NOTEBOOKLM API LIMITATION] Google's public NotebookLM API only returns external source references (Google Drive files, Web URLs, YouTube videos, and Agentspace DataStore documents). Locally uploaded files (PDF/DOCX/TXT/audio) and pasted text omit body content on customer projects and will be flagged as MANUAL_REUPLOAD_REQUIRED.`
    );

    // 1. Resolve Candidate Users for Multi-User DWD Notebook Discovery
    const candidateUsers = new Set<string>();
    const rawFilters = (options.userFilter || []).map(u => u.replace(/^user:/i, '').trim()).filter(Boolean);
    const exactUserFilters = rawFilters.filter(u => u.includes('@') && !u.includes('*'));
    const wildcardFilters = rawFilters.filter(u => u.includes('*') && u !== '*' && u !== '*@*');
    const matchesWildcards = (email: string): boolean => {
      if (wildcardFilters.length === 0) return true;
      const lower = email.toLowerCase();
      return wildcardFilters.some(pattern => {
        const regex = new RegExp('^' + pattern.toLowerCase().split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        return regex.test(lower);
      });
    };

    if (exactUserFilters.length > 0 && wildcardFilters.length === 0 && !rawFilters.includes('*') && !rawFilters.includes('*@*')) {
      for (const u of exactUserFilters) {
        candidateUsers.add(u);
      }
    } else {
      for (const u of exactUserFilters) {
        candidateUsers.add(u);
      }
      for (const u of discoveredUsers) {
        const clean = u.replace(/^user:/i, '').trim();
        if (clean.includes('@') && !clean.includes('*') && matchesWildcards(clean)) candidateUsers.add(clean);
      }
      for (const u of Object.keys(identityMapping)) {
        const clean = u.replace(/^user:/i, '').trim();
        if (clean.includes('@') && !clean.includes('*') && matchesWildcards(clean)) candidateUsers.add(clean);
      }
    }

    if (candidateUsers.size === 0) {
      const defaultAdmin = process.env.ADMIN_EMAIL || process.env.DEFAULT_USER_EMAIL || '';
      if (defaultAdmin && matchesWildcards(defaultAdmin)) candidateUsers.add(defaultAdmin);
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
            const candidateOwner = Array.from(candidateUsers)[0] || 'admin';
            const nb = await this.client.getNotebook(nbId, sourceEnv, candidateOwner !== 'admin' ? candidateOwner : undefined);
            const owner = nb.owner || (nb.metadata?.ownerEmail as string) || candidateOwner;
            const explicitRole = String(nb.metadata?.userRole || nb.userRole || nb.role || '').toUpperCase().trim();
            const isExplicitNonOwner =
              (Boolean(explicitRole) && explicitRole !== 'PROJECT_ROLE_OWNER' && explicitRole !== 'OWNER' && !explicitRole.endsWith('_OWNER')) ||
              nb.metadata?.isShareable === false;
            if (isExplicitNonOwner) {
              logger.info(`Skipping explicitly specified Notebook "${nb.title || nbId}" (${nbId}) for "${owner}" (user is Editor/Viewer, not Owner).`);
              continue;
            }
            seenNotebookIds.add(nbId);
            nb.owner = owner;
            allSourceNotebooks.push(nb);
            logger.info(`Explicitly added Notebook "${nb.title || nbId}" (ID: ${nbId}) for owner "${owner}".`);
          } catch (getErr: any) {
            logger.warn(`Could not fetch specified Notebook ID "${nbId}": ${getErr.message}`);
          }
        }
      }
    }

    // 2b. Discover Notebooks per user via Domain-Wide Delegation / WIF
    // In bulk migrations (multiple candidate users), classify users into standardUsers and adminUsers
    // so standard users run FIRST and claim their owned notebooks before Admin users are processed.
    const isDebug = Boolean((options as any).debugMode) || logger.isDebugEnabled();
    const userHasAdminDelete = new Map<string, boolean>();
    let orderedCandidateUsers = Array.from(candidateUsers);

    if (orderedCandidateUsers.length > 1 && typeof (this.client as any).testProjectIamPermissions === 'function') {
      const standardUsers: string[] = [];
      const adminUsers: string[] = [];
      for (const uEmail of orderedCandidateUsers) {
        let hasDelete = false;
        try {
          const granted = await (this.client as any).testProjectIamPermissions(
            sourceEnv.projectId,
            ['discoveryengine.notebooks.delete'],
            uEmail
          );
          hasDelete = Array.isArray(granted) && granted.includes('discoveryengine.notebooks.delete');
        } catch (permErr: any) {
          logger.debug(`Could not pre-probe project-level discoveryengine.notebooks.delete for "${uEmail}": ${permErr.message}`);
        }
        userHasAdminDelete.set(uEmail, hasDelete);
        if (hasDelete) {
          adminUsers.push(uEmail);
          logger.warn(
            `[ADMIN DETECTED] User "${uEmail}" holds project-level "discoveryengine.notebooks.delete" (Admin permissions) on "${sourceEnv.projectId}". Deferring "${uEmail}" to the end of notebook discovery so standard user-owned notebooks are claimed and removed first.`
          );
        } else {
          standardUsers.push(uEmail);
        }
      }
      orderedCandidateUsers = [...standardUsers, ...adminUsers];
    }

    const verifiedStandardUserOwners = new Map<string, string>();

    for (const userEmail of orderedCandidateUsers) {
      try {
        const userNotebooks = await this.client.listNotebooks(sourceEnv, userEmail);
        logger.info(`Discovered ${userNotebooks.length} notebooks for user "${userEmail}".`);
        let projectLevelDeleteChecked = userHasAdminDelete.has(userEmail);
        let callerHasProjectLevelDelete = userHasAdminDelete.get(userEmail) ?? false;
        let elevationBannerLogged = false;

        const logElevationBannerOnce = () => {
          if (elevationBannerLogged) return;
          elevationBannerLogged = true;
          const elevationBanner =
            `[DRY RUN AUDIT: ADMIN PERMISSION ELEVATION DETECTED]\n` +
            `================================================================================\n` +
            `⚠️  User "${userEmail}" holds project-level "discoveryengine.notebooks.delete" (Admin permissions) on source project "${sourceEnv.projectId}".\n` +
            `   WHY THIS MATTERS IN NOTEBOOKLM:\n` +
            `   When an impersonated user has project-level Admin permissions (e.g. "roles/discoveryengine.admin" on the Workforce Pool),\n` +
            `   Google's Discovery Engine API classifies them as PROJECT_ROLE_OWNER on ALL shared notebooks in the project.\n` +
            `   This causes the user to see and include MORE notebooks than expected (shared colleague notebooks will appear as owned).\n\n` +
            `   RECOMMENDED FIX BEFORE LIVE MIGRATION:\n` +
            `   Ensure the Workforce Pool on "${sourceEnv.projectId}" uses "roles/discoveryengine.user" (User permissions),\n` +
            `   NOT "roles/discoveryengine.admin" (Admin permissions):\n` +
            `     gcloud projects add-iam-policy-binding "${sourceEnv.projectId}" \\\n` +
            `       --member="principalSet://iam.googleapis.com/locations/global/workforcePools/<POOL>/*" \\\n` +
            `       --role="roles/discoveryengine.user"\n` +
            `     gcloud projects remove-iam-policy-binding "${sourceEnv.projectId}" \\\n` +
            `       --member="principalSet://iam.googleapis.com/locations/global/workforcePools/<POOL>/*" \\\n` +
            `       --role="roles/discoveryengine.admin"\n` +
            `================================================================================`;
          logger.warn(elevationBanner);
        };

        for (const nb of userNotebooks) {
          const nbId = nb.name?.split('/').pop() || nb.notebookId || '';
          const listSnapshot = nb.metadata ? { ...nb.metadata } : {};

          // Cross-user deduplication: if a standard user already claimed ownership of this notebook,
          // remove it from the Admin's (or subsequent user's) queue immediately.
          if (nbId && verifiedStandardUserOwners.has(nbId)) {
            const trueOwner = verifiedStandardUserOwners.get(nbId)!;
            logger.info(
              `[ADMIN DEDUPLICATION] Removing notebook "${nb.title || nb.displayName || nbId}" (${nbId}) from "${userEmail}" queue — already claimed as owned by standard user "${trueOwner}".`
            );
            continue;
          }
          if (nbId && seenNotebookIds.has(nbId)) {
            logger.info(
              `[Notebook Deduplication] Skipping notebook "${nb.title || nb.displayName || nbId}" (${nbId}) for "${userEmail}" — already queued earlier in this migration run.`
            );
            continue;
          }

          let getProbeNotebook: Notebook | undefined;
          const listRole = String(
            nb.metadata?.userRole ||
            nb.userRole ||
            nb.role ||
            nb.accessRole ||
            nb.metadata?.role ||
            ''
          ).toUpperCase().trim();

          if (nb.metadata?.isShared === true && !projectLevelDeleteChecked && typeof (this.client as any).testProjectIamPermissions === 'function') {
            projectLevelDeleteChecked = true;
            try {
              const granted = await (this.client as any).testProjectIamPermissions(
                sourceEnv.projectId,
                ['discoveryengine.notebooks.delete'],
                userEmail
              );
              callerHasProjectLevelDelete = Array.isArray(granted) && granted.includes('discoveryengine.notebooks.delete');
              userHasAdminDelete.set(userEmail, callerHasProjectLevelDelete);
            } catch (permErr: any) {
              logger.debug(`Could not probe project-level discoveryengine.notebooks.delete for "${userEmail}": ${permErr.message}`);
            }
          }

          if (callerHasProjectLevelDelete && nb.metadata?.isShared === true) {
            logElevationBannerOnce();
          }

          // When regional v1alpha (`us`/`eu`) omits `userRole` in `listRecentlyViewed`,
          // `list.metadata.isShared = true` applies to BOTH:
          //   (a) Notebooks the user OWNS and shared with others, AND
          //   (b) Notebooks shared WITH the user as Editor/Viewer.
          // Calling `getNotebook` (`GET .../notebooks/{id}`) disambiguates them because
          // `GetNotebook` returns `metadata.isShared: false` for the Owner (`PROJECT_ROLE_OWNER`)
          // and `metadata.isShared: true` for Editors/Viewers -- UNLESS the caller's token holds
          // project-level `discoveryengine.notebooks.delete` (e.g., `roles/discoveryengine.admin`
          // granted to `workforcePools/<pool>/*`), which forces `PROJECT_ROLE_OWNER` on all notebooks.
          if ((!listRole || listRole === 'UNSPECIFIED') && nb.metadata?.isShared === true && nbId) {
            try {
              getProbeNotebook = await this.client.getNotebook(nbId, sourceEnv, userEmail);
              const getRole = String(
                getProbeNotebook?.metadata?.userRole ||
                getProbeNotebook?.userRole ||
                getProbeNotebook?.role ||
                ''
              ).toUpperCase().trim();
              const getIsShared = getProbeNotebook?.metadata?.isShared;
              const canEdit = Boolean((getProbeNotebook as any)?.premiumFeatureInfo?.canEditAdvancedSettings);

              if (!nb.metadata) nb.metadata = {};
              if (getRole === 'PROJECT_ROLE_OWNER' || getRole === 'OWNER' || getRole.endsWith('_OWNER') || getIsShared === false) {
                nb.metadata.isOwnerVerifiedByGet = true;
                if (callerHasProjectLevelDelete) {
                  nb.metadata.hasProjectLevelAdminElevation = true;
                }
                if (getRole) nb.metadata.userRole = getRole;
                if (getProbeNotebook?.sources && (!nb.sources || nb.sources.length === 0)) {
                  nb.sources = getProbeNotebook.sources;
                }
              } else {
                nb.metadata.inferredRoleFromGet = canEdit
                  ? 'EDITOR (shared with user: list.isShared=true, get.isShared=true, canEdit=true)'
                  : 'VIEWER (shared with user: list.isShared=true, get.isShared=true, canEdit=false)';
              }
            } catch (probeErr: any) {
              if (isDebug) {
                logger.info(`[DIAGNOSTIC] getNotebook ownership probe failed for "${nb.title || nbId}" (${nbId}): ${probeErr.message}`);
              }
            }
          }

          const isSharedFlag = Boolean(listSnapshot.isShared ?? nb.metadata?.isShared);
          const isOwner = this.isCallerNotebookOwner(nb, userEmail);

          if (callerHasProjectLevelDelete && isSharedFlag && isOwner) {
            if (!nb.metadata) nb.metadata = {};
            nb.metadata.hasProjectLevelAdminElevation = true;
            nb.metadata.wasSharedInList = true;
            nb.metadata.requiresAdminHitlValidation = true;
          }

          const roleLabel = this.describeNotebookAccessRole(nb);

          if (callerHasProjectLevelDelete && isSharedFlag && isOwner) {
            logger.warn(
              `[DRY RUN AUDIT: PERMISSION ELEVATION] Notebook "${nb.title || nb.displayName || nbId}" (${nbId}) was marked INCLUDED_OWNER because "${userEmail}" has project-level Admin permissions. If this notebook was actually created by a colleague, it will be migrated under this user's account unless Workforce Pool permissions are changed to "roles/discoveryengine.user".`
            );
            logger.warn(
              `[ADMIN NOTEBOOK FLAGGED] Shared notebook "${nb.title || nb.displayName || nbId}" (${nbId}) under Admin "${userEmail}" has been flagged for validation and deferred to the end of the migration run.`
            );
          }

          if (isDebug) {
            const listDiag = {
              userRole: listSnapshot.userRole ?? 'UNSPECIFIED',
              isShared: listSnapshot.isShared ?? 'UNSPECIFIED',
              isShareable: listSnapshot.isShareable ?? 'UNSPECIFIED',
              createTime: listSnapshot.createTime,
              lastViewed: listSnapshot.lastViewed,
              canEditAdvancedSettings: (nb as any).premiumFeatureInfo?.canEditAdvancedSettings
            };
            const getDiag = getProbeNotebook ? {
              userRole: getProbeNotebook.metadata?.userRole ?? 'UNSPECIFIED',
              isShared: getProbeNotebook.metadata?.isShared ?? 'UNSPECIFIED',
              isShareable: getProbeNotebook.metadata?.isShareable ?? 'UNSPECIFIED',
              sourceCount: (getProbeNotebook.sources || []).length,
              canEditAdvancedSettings: (getProbeNotebook as any).premiumFeatureInfo?.canEditAdvancedSettings
            } : 'NOT_PROBED (list metadata was unambiguous)';
            logger.info(`[DIAGNOSTIC] Notebook "${nb.title || nb.displayName || nbId}" (${nbId}) user="${userEmail}" | listMetadata=${JSON.stringify(listDiag)} | getMetadata=${JSON.stringify(getDiag)} | verdict=${isOwner ? 'INCLUDED_OWNER' : 'SKIPPED_NON_OWNER'} (${roleLabel})`);
          }

          if (!isOwner) {
            logger.info(`[Notebook Access] "${nb.title || nb.displayName || nbId}" (${nbId}) -> User "${userEmail}" role is ${roleLabel} [isShared=${isSharedFlag}] -> SKIPPING (user is not Owner).`);
            continue;
          }
          logger.info(`[Notebook Access] "${nb.title || nb.displayName || nbId}" (${nbId}) -> User "${userEmail}" role is ${roleLabel} [isShared=${isSharedFlag}] -> INCLUDED (user is Owner).`);
          if (nbId && !seenNotebookIds.has(nbId)) {
            seenNotebookIds.add(nbId);
            if (!callerHasProjectLevelDelete) {
              verifiedStandardUserOwners.set(nbId, userEmail);
            }
            nb.owner = userEmail;
            if (!nb.metadata) nb.metadata = {};
            nb.metadata.ownerEmail = userEmail;
            allSourceNotebooks.push(nb);
          }
        }
      } catch (err: any) {
        logger.warn(`Per-user notebook discovery failed for "${userEmail}" on source project "${sourceEnv.projectId}": ${err.message}`);
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
          const effectiveOwner = selectedUser || nb.owner || (nb.metadata?.ownerEmail as string) || fallbackOwner;
          const roleLabel = this.describeNotebookAccessRole(nb);
          const isSharedFlag = Boolean(nb.metadata?.isShared);
          if (!this.isCallerNotebookOwner(nb, selectedUser || undefined)) {
            logger.info(`[Notebook Access] "${nb.title || nb.displayName || nbId}" (${nbId}) -> User "${effectiveOwner}" role is ${roleLabel} [isShared=${isSharedFlag}] -> SKIPPING (user is not Owner).`);
            continue;
          }
          logger.info(`[Notebook Access] "${nb.title || nb.displayName || nbId}" (${nbId}) -> User "${effectiveOwner}" role is ${roleLabel} [isShared=${isSharedFlag}] -> INCLUDED (user is Owner).`);
          if (nbId && !seenNotebookIds.has(nbId)) {
            seenNotebookIds.add(nbId);
            if (!nb.owner && !nb.metadata?.ownerEmail) {
              nb.owner = fallbackOwner;
              if (!nb.metadata) nb.metadata = {};
              nb.metadata.ownerEmail = fallbackOwner;
            }
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

    const concurrency = options.concurrency || 3;
    const isDryRun = options.dryRun === true;

    // Partition into immediate (standard users + private Admin notebooks) vs deferred (shared Admin notebooks)
    const immediateNotebooks = filteredNotebooks.filter(nb => !nb.metadata?.requiresAdminHitlValidation);
    const deferredAdminSharedNotebooks = filteredNotebooks.filter(nb => Boolean(nb.metadata?.requiresAdminHitlValidation));

    if (deferredAdminSharedNotebooks.length > 0) {
      logger.info(
        `[ADMIN DEFERRAL] Migrating ${immediateNotebooks.length} standard/private notebook(s) first; deferring ${deferredAdminSharedNotebooks.length} flagged shared Admin notebook(s) to the end of the run.`
      );
    }

    const immediateResults = await mapConcurrent(immediateNotebooks, concurrency, (nb: Notebook) =>
      this.migrateSingleNotebook(nb, sourceEnv, targetEnv, options, identityMapping, candidateUsers, isDryRun, datastoreMapping, collectionMapping)
    );

    if (deferredAdminSharedNotebooks.length === 0) {
      return immediateResults;
    }

    // End-of-run processing for deferred shared Admin notebooks
    if (options.promptForAdminNotebookHitl) {
      logger.warn(
        `[ADMIN HITL VALIDATION] ${deferredAdminSharedNotebooks.length} shared notebook(s) remain under Admin account(s) at the end of the migration. Prompting operator for Human-in-the-Loop (HITL) validation...`
      );

      const candidates: AdminHitlNotebookCandidate[] = deferredAdminSharedNotebooks.map(nb => {
        const nbId = nb.name.split('/').pop() || nb.notebookId || '';
        const adminEmail = String(nb.metadata?.ownerEmail || nb.owner || 'admin');
        const targetOwner = IdentityMappingService.lookupTargetIdentity(adminEmail, identityMapping, adminEmail);
        return {
          id: nbId,
          title: nb.title || nb.displayName || 'Untitled Notebook',
          adminEmail,
          targetOwner,
          isShared: true,
          createTime: nb.metadata?.createTime,
          lastViewed: nb.metadata?.lastViewed,
          sourceCount: (nb.sources || []).length,
          roleDescription: this.describeNotebookAccessRole(nb)
        };
      });

      let approvedIds = new Set<string>();
      if (typeof options.onAdminNotebookHitlPrompt === 'function') {
        const operatorApproved = await options.onAdminNotebookHitlPrompt(candidates);
        approvedIds = new Set((operatorApproved || []).map(id => String(id).trim()).filter(Boolean));
      } else if (Array.isArray(options.approvedAdminNotebookIds) && options.approvedAdminNotebookIds.length > 0) {
        approvedIds = new Set(options.approvedAdminNotebookIds.map(id => String(id).trim()).filter(Boolean));
      } else {
        logger.warn(
          `[ADMIN HITL VALIDATION] promptForAdminNotebookHitl is enabled, but no interactive HITL handler or approvedAdminNotebookIds was supplied. Skipping ${deferredAdminSharedNotebooks.length} unverified shared Admin notebook(s) by default.`
        );
      }

      const approvedNotebooks: Notebook[] = [];
      const rejectedResults: MigrationItemResult[] = [];

      for (const nb of deferredAdminSharedNotebooks) {
        const nbId = nb.name.split('/').pop() || nb.notebookId || '';
        if (approvedIds.has(nbId)) {
          if (!nb.metadata) nb.metadata = {};
          nb.metadata.adminHitlDecision = 'APPROVED';
          approvedNotebooks.push(nb);
        } else {
          const originalOwner = String(nb.metadata?.ownerEmail || nb.owner || 'admin');
          const targetOwner = IdentityMappingService.lookupTargetIdentity(originalOwner, identityMapping, originalOwner);
          const skippedResult: MigrationItemResult = {
            id: nbId,
            displayName: nb.title || nb.displayName || 'Untitled Notebook',
            type: 'NOTEBOOK',
            status: 'SKIPPED',
            originalOwner,
            targetOwner,
            ownershipNote: 'Skipped by operator during Admin Shared Notebook HITL validation',
            details: {
              adminValidationFlagged: true,
              hasProjectLevelAdminElevation: true,
              isSharedInSourceList: true,
              adminHitlDecision: 'REJECTED',
              sourcesCount: (nb.sources || []).length,
              sourcesRestored: 0,
              sourcesFailed: 0,
              notesCount: 0,
              artifactsCount: 0
            },
            durationMs: 0
          };
          logger.info(
            `[ADMIN HITL VALIDATION] Operator skipped shared Admin notebook "${skippedResult.displayName}" (${nbId}) for "${originalOwner}".`
          );
          options.onItemCompleted?.(skippedResult);
          rejectedResults.push(skippedResult);
        }
      }

      const approvedResults = await mapConcurrent(approvedNotebooks, concurrency, (nb: Notebook) =>
        this.migrateSingleNotebook(nb, sourceEnv, targetEnv, options, identityMapping, candidateUsers, isDryRun, datastoreMapping, collectionMapping)
      );

      return [...immediateResults, ...approvedResults, ...rejectedResults];
    }

    logger.info(
      `[ADMIN DEFERRAL] Processing ${deferredAdminSharedNotebooks.length} deferred shared Admin notebook(s) at the end of the run (Tip: enable "Prompt for HITL on Admin Notebooks" to manually approve/reject these).`
    );
    const deferredResults = await mapConcurrent(deferredAdminSharedNotebooks, concurrency, (nb: Notebook) =>
      this.migrateSingleNotebook(nb, sourceEnv, targetEnv, options, identityMapping, candidateUsers, isDryRun, datastoreMapping, collectionMapping)
    );
    return [...immediateResults, ...deferredResults];
  }

  /**
   * Migrates a single notebook (used by both immediate pass and end-of-run deferred Admin pass).
   */
  private async migrateSingleNotebook(
    nb: Notebook,
    sourceEnv: EnvironmentConfig,
    targetEnv: EnvironmentConfig,
    options: MigrationOptions,
    identityMapping: Record<string, string>,
    candidateUsers: Set<string>,
    isDryRun: boolean,
    datastoreMapping: Record<string, string> = {},
    collectionMapping: Record<string, string> = {}
  ): Promise<MigrationItemResult> {
      const startTime = Date.now();
      const notebookId = nb.name.split('/').pop() || '';
      const selectedUser = (options.userFilter && options.userFilter.length === 1 && !options.userFilter[0].includes('*')) 
        ? options.userFilter[0].replace(/^.*\/subject\//i, '').replace(/^user:/i, '').trim()
        : null;
      const fallbackUser = selectedUser || Array.from(candidateUsers)[0] || process.env.ADMIN_EMAIL || 'admin';
      let rawOwner = nb.metadata?.ownerEmail || nb.owner || fallbackUser;
      rawOwner = rawOwner.replace(/^.*\/subject\//i, '').replace(/^user:/i, '').trim();
      try {
        rawOwner = decodeURIComponent(rawOwner);
      } catch (decodeErr: any) {
        // URIError on malformed percent-encoding is safe to ignore; retain un-decoded rawOwner
        logger.debug(`Could not URI-decode rawOwner "${rawOwner}": ${decodeErr.message}`);
      }
      const originalOwner = (rawOwner === 'unknown' || !rawOwner.includes('@')) ? fallbackUser : rawOwner;
      const targetOwner = IdentityMappingService.lookupTargetIdentity(originalOwner, identityMapping, selectedUser || originalOwner);

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
      const shouldExportArtifacts = options.exportArtifacts !== false;

      try {
        logger.info(
          shouldExportArtifacts
            ? `Fetching detailed sources & Studio artifacts for Notebook "${result.displayName}" (${notebookId})...`
            : `Fetching detailed sources & notes for Notebook "${result.displayName}" (${notebookId}) (Studio artifacts export disabled)...`
        );
        fullNotebook = await this.client.getNotebook(notebookId, sourceEnv, userImpersonation);

        // Preserve `userRole`, `isShared`, and `isShareable` from `listRecentlyViewed` (`nb.metadata`)
        // because `getNotebook` can omit or reset `isShared` to false even on shared notebooks.
        if (nb.metadata) {
          fullNotebook.metadata = {
            ...nb.metadata,
            ...(fullNotebook.metadata || {}),
            userRole: fullNotebook.metadata?.userRole || nb.metadata.userRole,
            isShared: nb.metadata.isShared === true ? true : fullNotebook.metadata?.isShared,
            isShareable:
              nb.metadata.isShareable === false
                ? false
                : (fullNotebook.metadata?.isShareable ?? nb.metadata.isShareable)
          };
        }

        const detailRoleLabel = this.describeNotebookAccessRole(fullNotebook);
        if (!this.isCallerNotebookOwner(fullNotebook, originalOwner)) {
          logger.info(`[Notebook Access] "${result.displayName}" (${notebookId}) -> User "${originalOwner}" role is ${detailRoleLabel} -> SKIPPING shared notebook (not Owner).`);
          result.status = 'SKIPPED';
          result.ownershipNote = `Skipped shared notebook (user role: ${detailRoleLabel})`;
          result.durationMs = Date.now() - startTime;
          options.onItemCompleted?.(result);
          return result;
        }

        // Retain all sources inside an owned notebook (including collaborator-contributed sources in shared notebooks)
        // because non-owners skip shared notebooks during discovery and stripping collaborator sources here would drop them permanently.

        // Fetch detailed source data (tailwindDoc, document text, or fallback extraction) for each source
        if (fullNotebook.sources && fullNotebook.sources.length > 0) {
          const totalSources = fullNotebook.sources.length;
          if (totalSources > 10) {
            logger.info(`Fetching detailed content for ${totalSources} sources in Notebook "${result.displayName}" (${notebookId})...`);
          }
          let completedSources = 0;
          const sourceFetchConcurrency = Math.min(3, Math.max(1, options.concurrency || 3));
          fullNotebook.sources = await mapConcurrent(
            fullNotebook.sources,
            sourceFetchConcurrency,
            async (s) => {
              const sourceId = s.name?.split('/').pop() || s.sourceId?.id;
              const sTitle = s.title || s.displayName || sourceId || 'Source';
              try {
                if (!sourceId) return s;
                const fullSource = await this.client.getNotebookSource(notebookId, sourceId, sourceEnv, userImpersonation);
                const merged: NotebookSource = { ...s, ...fullSource };

                // 1. Pre-extract unformatted text from tailwindDoc / plainText / markdownString so it is stored directly on merged.content
                let extractedText = this.extractSourceText(merged);

                // 2. If this is an Agentspace document without extracted text, attempt to read the document from the source DataStore
                const asDocName =
                  merged.metadata?.agentspaceMetadata?.documentName ||
                  merged.metadata?.agentspace_metadata?.documentName;
                if (!extractedText && asDocName && typeof (this.client as any).getDataStoreDocument === 'function') {
                  try {
                    const dsDoc = await this.client.getDataStoreDocument(asDocName, sourceEnv, userImpersonation);
                    const dsText = this.extractTextFromDataStoreDocument(dsDoc);
                    if (dsText) {
                      extractedText = dsText;
                      logger.info(`Extracted ${dsText.length} chars of text from source DataStore document "${asDocName}" for source "${sTitle}"`);
                    }
                  } catch (dsErr: any) {
                    logger.debug(`Could not fetch DataStore document "${asDocName}" for source "${sTitle}": ${dsErr.message}`);
                  }
                }

                if (extractedText) {
                  merged.content = extractedText;
                }

                // Note: On external customer projects, Google's NotebookService.GetSource omits tailwindDoc/plainText/markdownString
                // (restricted behind internal NOTEBOOKLM_SOURCE_CONTENT proto visibility), and both :interactSources and :streamAssist
                // cannot extract raw uploaded/pasted source content. Sources without external reference links (Drive, Web, YouTube, DataStore)
                // return null in mapSourceToPayload and are honestly reported as MANUAL_REUPLOAD_REQUIRED.

                return merged;
              } catch (err: any) {
                logger.warn(`Could not fetch detailed source "${sTitle}" (${sourceId}) in notebook ${notebookId}: ${err.message}`);
                return { ...s, _fetchError: err.message } as NotebookSource;
              } finally {
                completedSources++;
                if (totalSources > 10 && completedSources % 25 === 0 && completedSources < totalSources) {
                  logger.info(`Fetched ${completedSources}/${totalSources} sources for Notebook "${result.displayName}" (${notebookId})...`);
                }
              }
            }
          );
        }

        // Fetch notes if available
        try {
          notes = await this.client.listNotes(notebookId, sourceEnv, userImpersonation);
        } catch (noteErr: any) {
          const isMethodNotFound =
            noteErr?.status === 404 || String(noteErr?.message || '').includes('Method not found');
          if (isMethodNotFound) {
            logger.debug(`NoteService (notes:batchGet) not exposed on project "${sourceEnv.projectId}" (404 Method not found); skipping notes fetch for "${result.displayName}".`);
          } else {
            logger.warn(`Could not list notes for Notebook "${result.displayName}" (${notebookId}): ${noteErr.message}`);
          }
        }

        // Fetch artifacts (Studio outputs: Slide Decks, Infographics, Audio Overview, Reports) only when exportArtifacts is enabled
        if (shouldExportArtifacts) {
          try {
            artifacts = await this.client.listArtifacts(notebookId, sourceEnv, userImpersonation);
            if (artifacts.length > 0) {
              logger.info(`Found ${artifacts.length} Studio artifacts for Notebook "${result.displayName}"`);
            }
          } catch (artErr: any) {
            const isMethodNotFound =
              artErr?.status === 404 || String(artErr?.message || '').includes('Method not found');
            if (isMethodNotFound) {
              logger.debug(`ArtifactService not exposed on project "${sourceEnv.projectId}" (404 Method not found); skipping Studio artifacts fetch for "${result.displayName}".`);
            } else {
              logger.warn(`Could not list Studio artifacts for Notebook "${result.displayName}" (${notebookId}): ${artErr.message}`);
            }
          }
        }
      } catch (fetchErr: any) {
        logger.warn(`Could not fetch detailed notebook object for "${result.displayName}" (${notebookId}): ${fetchErr.message}`);
      }

      const rawSources = fullNotebook.sources || [];
      let dryRunSourcesRestored = 0;
      let dryRunSourcesFailed = 0;
      const dryRunSources: MigratedSourceItem[] = rawSources.map(s => {
        const fetchError = (s as any)._fetchError;
        if (fetchError) {
          dryRunSourcesFailed++;
          return this.buildMigratedSourceItem(s, 'FAILED', null, {
            error: `Source content fetch failed: ${fetchError}`
          });
        }
        const payload = this.mapSourceToPayload(s, targetEnv, datastoreMapping, collectionMapping);
        if (payload === null) {
          dryRunSourcesFailed++;
          return this.buildMigratedSourceItem(s, 'MANUAL_REUPLOAD_REQUIRED', null, {
            error: 'Document binary content unavailable across tenant boundary. Manual re-upload required to restore full grounding.'
          });
        }
        dryRunSourcesRestored++;
        return this.buildMigratedSourceItem(s, 'DRY_RUN', payload);
      });

      const unmigratableSamples = rawSources
        .filter(s => !(s as any)._fetchError && this.mapSourceToPayload(s, targetEnv, datastoreMapping, collectionMapping) === null)
        .slice(0, 3)
        .map(s => {
          const sTitle = s.displayName || s.title || 'Source';
          const topKeys = Object.keys(s).join(',');
          const metaKeys = s.metadata ? Object.keys(s.metadata).join(',') : 'none';
          return `"${sTitle}" [keys: ${topKeys} | metadata: ${metaKeys}]`;
        });
      if (unmigratableSamples.length > 0) {
        logger.info(
          `[DIAGNOSTIC] Notebook "${result.displayName}" (${notebookId}) has ${dryRunSourcesFailed}/${rawSources.length} metadata-only source(s) (no tailwindDoc/plainText/markdownString/URL returned by getNotebookSource). Sample(s): ${unmigratableSamples.join('; ')}`
        );
      }

      const adminMetadataFlags = nb.metadata?.hasProjectLevelAdminElevation ? {
        hasProjectLevelAdminElevation: true,
        adminValidationFlagged: Boolean(nb.metadata?.requiresAdminHitlValidation),
        isSharedInSourceList: Boolean(nb.metadata?.wasSharedInList),
        adminHitlDecision: nb.metadata?.adminHitlDecision || (options.promptForAdminNotebookHitl ? 'APPROVED' : 'NOT_PROMPTED')
      } : {};

      if (nb.metadata?.requiresAdminHitlValidation && !result.ownershipNote) {
        result.ownershipNote = nb.metadata?.adminHitlDecision === 'APPROVED'
          ? 'Approved by operator via Admin HITL validation (shared notebook under Admin permissions)'
          : 'FLAGGED FOR VALIDATION: User holds project-level Admin permissions on this shared notebook; verify true ownership';
      }

      result.details = {
        ...adminMetadataFlags,
        sourcesCount: rawSources.length,
        sourcesRestored: isDryRun ? dryRunSourcesRestored : 0,
        sourcesFailed: isDryRun ? dryRunSourcesFailed : 0,
        sources: isDryRun ? dryRunSources : [],
        notesCount: notes.length,
        notes: (notes || []).map((n: any) => ({
          title: n.title || 'Studio Note',
          content: n.content || this.extractTextFromTailwindDoc(n.tailwindDoc || n.tailwindDocContent || n)
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
        if (dryRunSourcesFailed > 0) {
          result.error = `${dryRunSourcesFailed} source(s) failed to restore in target`;
        }
        logger.info(`[DRY RUN] Would migrate Notebook "${result.displayName}" (ID: ${notebookId}) with ${result.details.sourcesRestored}/${result.details.sourcesCount} migratable sources (${result.details.sourcesFailed} failed/manual), ${result.details.notesCount} notes, and ${result.details.artifactsCount} Studio artifacts for owner ${targetOwner}`);
        result.status = 'DRY_RUN';
        result.durationMs = Date.now() - startTime;
        options.onItemCompleted?.(result);
        return result;
      }

      try {

        const userOwner = (targetOwner && targetOwner !== 'unknown') ? targetOwner : undefined;

        // 1. Create Target Notebook (with idempotency probe)
        const notebookPayload: any = {
          title: fullNotebook.title || fullNotebook.displayName || 'Restored Notebook'
        };
        if (fullNotebook.emoji) {
          notebookPayload.emoji = fullNotebook.emoji;
        }

        let createdNotebook: Notebook | undefined;
        let notebookAlreadyExisted = false;
        try {
          const targetNotebooks = await this.client.listNotebooks(targetEnv, userOwner);
          createdNotebook = targetNotebooks.find(n => (n.title || n.displayName) === notebookPayload.title);
          if (createdNotebook) {
            notebookAlreadyExisted = true;
            logger.info(`Notebook "${result.displayName}" already exists in target environment (ID: ${createdNotebook.name.split('/').pop()}). Skipping duplicate creation.`);
          }
        } catch (probeErr: any) {
          logger.debug(`Could not probe target notebooks for existing title: ${probeErr.message}`);
        }

        if (!createdNotebook) {
          createdNotebook = await this.client.createNotebook(targetEnv, notebookPayload, userOwner);
          logger.info(`Created target Notebook "${result.displayName}" with new ID "${createdNotebook.name.split('/').pop()}" (Owner: ${userOwner || 'admin'})`);
        }

        const newNotebookId = createdNotebook.name.split('/').pop() || '';
        result.targetId = newNotebookId;

        // Fetch existing target notebook state (sources, notes, artifacts) for deduplication if notebook already existed
        let existingTargetSources: NotebookSource[] = [];
        let existingNotes: NotebookNote[] = [];
        let existingArtifacts: any[] = [];

        if (notebookAlreadyExisted) {
          try {
            const existingNb = await this.client.getNotebook(newNotebookId, targetEnv, userOwner);
            existingTargetSources = existingNb.sources || [];
            if (existingTargetSources.length > 0) {
              logger.info(`Found ${existingTargetSources.length} existing sources in target Notebook "${result.displayName}" (${newNotebookId}). Re-use will be deduplicated.`);
            }
          } catch (getErr: any) {
            logger.debug(`Could not fetch existing target notebook sources: ${getErr.message}`);
          }

          try {
            existingNotes = await this.client.listNotes(newNotebookId, targetEnv, userOwner);
          } catch (notesErr: any) {
            logger.debug(`Could not list existing target notes: ${notesErr.message}`);
          }

          if (shouldExportArtifacts) {
            try {
              existingArtifacts = await this.client.listArtifacts(newNotebookId, targetEnv, userOwner);
            } catch (artErr: any) {
              logger.debug(`Could not list existing target artifacts: ${artErr.message}`);
            }
          }
        }

        const sourceIdMap: Record<string, string> = {};
        const sourceDetails: MigratedSourceItem[] = [];
        let sourcesRestored = 0;
        let sourcesFailed = 0;

        // 2. Batch inject sources with idempotency and deduplication
        if (rawSources.length > 0) {
          // Internal deduplication within rawSources
          const uniqueRawSources: NotebookSource[] = [];
          for (const s of rawSources) {
            const existingInUnique = uniqueRawSources.find(u => isSameSource(s, u));
            if (existingInUnique) {
              const oldId = s.name?.split('/').pop() || s.sourceId?.id;
              const canonId = existingInUnique.name?.split('/').pop() || existingInUnique.sourceId?.id;
              if (oldId && canonId) {
                sourceIdMap[oldId] = canonId;
              }
            } else {
              uniqueRawSources.push(s);
            }
          }

          const itemsToCreate: Array<{ raw: NotebookSource; payload: any }> = [];

          for (const s of uniqueRawSources) {
            const oldSourceId = s.name?.split('/').pop() || s.sourceId?.id;
            const sTitle = s.displayName || s.title || 'Source';

            // Check if source already exists in target notebook
            const existingMatch = existingTargetSources.find(ets => isSameSource(s, ets));
            if (existingMatch) {
              const existingTargetId = existingMatch.name?.split('/').pop() || existingMatch.sourceId?.id || oldSourceId;
              if (oldSourceId && existingTargetId) {
                sourceIdMap[oldSourceId] = existingTargetId;
              }
              sourceDetails.push(
                this.buildMigratedSourceItem(s, 'SUCCESS', this.mapSourceToPayload(s, targetEnv, datastoreMapping, collectionMapping) || undefined, {
                  targetSourceId: existingTargetId
                })
              );
              sourcesRestored++;
              logger.info(`Source "${sTitle}" already exists in target Notebook ${newNotebookId}. Skipping re-creation.`);
              continue;
            }

            const fetchError = (s as any)._fetchError;
            if (fetchError) {
              sourceDetails.push(
                this.buildMigratedSourceItem(s, 'FAILED', null, {
                  error: `Source content fetch failed: ${fetchError}`
                })
              );
              sourcesFailed++;
              continue;
            }

            const payload = this.mapSourceToPayload(s, targetEnv, datastoreMapping, collectionMapping);
            if (payload === null) {
              sourceDetails.push(
                this.buildMigratedSourceItem(s, 'MANUAL_REUPLOAD_REQUIRED', null, {
                  error: 'Document binary content unavailable across tenant boundary. Manual re-upload required to restore full grounding.'
                })
              );
              sourcesFailed++;
            } else {
              itemsToCreate.push({ raw: s, payload });
            }
          }

          const sourceChunks = this.chunkSourcesForBatchCreate(itemsToCreate, 5, 4 * 1024 * 1024);
          for (const chunkItems of sourceChunks) {
            const chunkPayloads = chunkItems.map(it => it.payload);

            try {
              const createdBatch = await this.client.batchCreateNotebookSources(newNotebookId, chunkPayloads, targetEnv, userOwner);
              const batchReturnedSources = Array.isArray(createdBatch?.sources) ? createdBatch.sources : [];
              for (let idx = 0; idx < chunkItems.length; idx++) {
                const it = chunkItems[idx];
                const s = it.raw;
                const oldSourceId = s.name?.split('/').pop() || s.sourceId?.id;
                const newSourceId = batchReturnedSources[idx]?.name?.split('/').pop() || batchReturnedSources[idx]?.sourceId?.id;
                if (oldSourceId && newSourceId) {
                  sourceIdMap[oldSourceId] = newSourceId;
                }
                sourceDetails.push(
                  this.buildMigratedSourceItem(s, 'SUCCESS', it.payload, {
                    targetSourceId: newSourceId
                  })
                );
                sourcesRestored++;
              }
            } catch (chunkErr: any) {
              logger.warn(`Batch source creation failed for Notebook ${newNotebookId} (${chunkErr.message}). Retrying individual sources in chunk...`);
              for (let j = 0; j < chunkItems.length; j++) {
                const singleItem = chunkItems[j];
                const rawSingle = singleItem.raw;
                const sTitle = rawSingle.displayName || rawSingle.title || 'Source';
                const oldSourceId = rawSingle.name?.split('/').pop() || rawSingle.sourceId?.id;
                try {
                  const singleBatch = await this.client.batchCreateNotebookSources(newNotebookId, [singleItem.payload], targetEnv, userOwner);
                  const singleReturned = Array.isArray(singleBatch?.sources) ? singleBatch.sources[0] : undefined;
                  const newSourceId = singleReturned?.name?.split('/').pop() || singleReturned?.sourceId?.id;
                  if (oldSourceId && newSourceId) {
                    sourceIdMap[oldSourceId] = newSourceId;
                  }
                  sourceDetails.push(
                    this.buildMigratedSourceItem(rawSingle, 'SUCCESS', singleItem.payload, {
                      targetSourceId: newSourceId
                    })
                  );
                  sourcesRestored++;
                } catch (singleErr: any) {
                  logger.error(`Failed to migrate Source "${sTitle}" in Notebook ${newNotebookId}: ${singleErr.message}`);
                  sourceDetails.push(
                    this.buildMigratedSourceItem(rawSingle, 'FAILED', singleItem.payload, {
                      error: singleErr.message
                    })
                  );
                  sourcesFailed++;
                }
              }
            }
          }
          logger.info(`Restored ${sourcesRestored} sources (${sourcesFailed} failed/manual) to Notebook ${newNotebookId}`);
        }

        // 3. Recreate notes if available (with deduplication against existing notes)
        if (notes && notes.length > 0) {
          for (const note of notes) {
            const noteTitle = (note.title || 'Note').trim().toLowerCase();
            const noteContent = (note.content || this.extractTextFromTailwindDoc(note.tailwindDoc || note.tailwindDocContent || note) || '').trim();
            const noteAlreadyExists = existingNotes.some(en => {
              const enTitle = (en.title || 'Note').trim().toLowerCase();
              const enContent = (en.content || this.extractTextFromTailwindDoc(en.tailwindDoc || en.tailwindDocContent || en) || '').trim();
              return enTitle === noteTitle && (!noteContent || enContent === noteContent);
            });
            if (noteAlreadyExists) {
              logger.info(`Note "${note.title || 'Untitled'}" already exists in target Notebook. Skipping duplicate creation.`);
              continue;
            }
            try {
              const notePayload = {
                title: note.title || 'Note',
                content: noteContent
              };
              await this.client.createNote(newNotebookId, notePayload, targetEnv, userOwner);
            } catch (noteErr: any) {
              logger.warn(`Could not create note "${note.title || 'Untitled'}" in target Notebook (${noteErr.message}). Notes are preserved as distinct artifacts in the user handover package.`);
            }
          }
        }

        // 4. Recreate artifacts / Studio outputs (with deduplication against existing artifacts)
        if (artifacts && artifacts.length > 0) {
          let restoredArtifactCount = 0;
          for (const artifact of artifacts) {
            const artTitle = (artifact.title || this.formatArtifactTypeName(artifact.type) || '').trim().toLowerCase();
            const artType = artifact.type;
            const artifactAlreadyExists = existingArtifacts.some(ea => {
              const eaTitle = (ea.title || this.formatArtifactTypeName(ea.type) || '').trim().toLowerCase();
              return ea.type === artType && (artTitle ? eaTitle === artTitle : true);
            });
            if (artifactAlreadyExists) {
              logger.info(`Artifact "${artifact.title || this.formatArtifactTypeName(artType)}" already exists in target Notebook. Skipping duplicate creation.`);
              restoredArtifactCount++;
              continue;
            }

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
          ...adminMetadataFlags,
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
            content: n.content || this.extractTextFromTailwindDoc(n.tailwindDoc || n.tailwindDocContent || n)
          }))
        };

        if (sourcesFailed > 0) {
          result.error = `${sourcesFailed} source(s) failed to restore in target`;
        }

      } catch (err: any) {
        // Only discard the notebook when the target user genuinely does not exist.
        // See utils/impersonationFailure.ts -- the previous predicate matched the
        // wrapper prefix and so dropped data on pure configuration errors.
        const classification = classifyImpersonationFailure(err.message);
        if (classification.safeToDropData) {
          logger.warn(`[DROPPED / SKIPPED] Notebook "${result.displayName}" for offboarded/unmapped user "${originalOwner}" was dropped (target: "${targetOwner}"). Admin account will not be polluted.`);
          result.status = 'SKIPPED';
          result.error = `Skipped: User "${targetOwner || originalOwner}" not found in target Google Identity. Data safely dropped to prevent admin account pollution.`;
        } else if (classification.kind === 'MISCONFIGURED' || classification.kind === 'UNKNOWN') {
          logger.error(`Failed to migrate Notebook "${result.displayName}" for "${originalOwner}": ${err.message}. ${classification.explanation}`);
          result.status = 'FAILED';
          result.error = `${err.message} -- ${classification.explanation}`;
        } else {
          logger.error(`Failed to migrate Notebook "${result.displayName}" (${notebookId}): ${err.message}`);
          result.status = 'FAILED';
          result.error = err.message;
        }
      }

      result.durationMs = Date.now() - startTime;
      options.onItemCompleted?.(result);
      return result;
  }
}
