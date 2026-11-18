import fs from 'fs';
import { GcpAuthService, isCredentialAutoloadDisabled, isGroupOrNonHumanPrincipal } from '../services/gcpAuth.js';
import { ValidatedMigrationConfig } from '../config/configSchema.js';
import { getSafeDiscoveryEngineUrl, SecurityValidationError } from '../security/validator.js';
import { IdentityMappingService } from '../services/identityMappingService.js';
import { logger } from '../utils/logger.js';

export interface PersonReferencePart {
  documentName?: string;
  personId?: string;
  email?: string;
  displayName?: string;
  displayPhotoUri?: string;
  destinationUri?: string;
  fileId?: string;
}

export interface DriveDocumentReferencePart {
  driveId?: string;
  documentName?: string;
  displayTitle?: string;
  destinationUri?: string;
  iconUri?: string;
  fileId?: string;
}

export interface DocumentReferencePart {
  documentName?: string;
  displayTitle?: string;
  destinationUri?: string;
  iconUri?: string;
  fileId?: string;
  urlForConnector?: string;
}

export interface ChatQueryPart {
  text?: string;
  uiJsonPayload?: string;
  personReference?: PersonReferencePart;
  driveDocumentReference?: DriveDocumentReferencePart;
  documentReference?: DocumentReferencePart;
}

export interface ChatSessionTurn {
  query?: {
    queryId?: string;
    text?: string;
    parts?: ChatQueryPart[];
    createTime?: string;
  };
  answer?: string;
  assistAnswer?: string;
  detailedAssistAnswer?: any;
  detailedAnswer?: any;
  queryConfig?: Record<string, string>;
  live?: boolean;
  assistToken?: string;
  name?: string;
  turnId?: string;
  createdAt?: string;
}

export interface SessionFileMetadata {
  fileId: string;
  name: string;
  mimeType?: string;
  byteSize?: string | number;
  originalUri?: string;
  originalSourceType?: string;
  fileOriginType?: string;
  uploadTime?: string;
  lastAddTime?: string;
  downloadUri?: string;
  metadata?: Record<string, string>;
}

export interface InlineBinaryAttachment {
  fileName: string;
  mimeType: string;
  data: Buffer;
}

export interface ChatSession {
  name: string;
  displayName?: string;
  userPseudoId?: string;
  state?: string;
  isPinned?: boolean;
  turns?: ChatSessionTurn[];
  startTime?: string;
  endTime?: string;
  expireTime?: string;
  labels?: string[];
  migratedFilesCount?: number;
  migratedFileIds?: Record<string, string>;
  continuableSeeded?: boolean;
}

const MAX_INLINE_CONTINUABLE_TRANSCRIPT_CHARS = 200_000;

/**
 * Parses a REST `AssistantService.StreamAssist` HTTP payload (which Google's HTTP/JSON
 * transcoding emits either as a JSON array `[chunk1, chunk2, ...]`, a single JSON object,
 * or newline-delimited JSON objects) into an array of response chunks.
 */
export function parseStreamAssistChunks(rawBody: string): any[] {
  const trimmed = String(rawBody || '').trim();
  if (!trimmed) {
    throw new Error('StreamAssist returned an empty response body.');
  }
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (arrayParseErr: any) {
    // Fallback for NDJSON (one JSON object per line)
    const lines = trimmed
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0 && l !== '[' && l !== ']' && l !== ',');
    if (lines.length === 0) {
      throw new Error(`Malformed StreamAssist JSON response: ${arrayParseErr.message}`);
    }
    const chunks: any[] = [];
    for (const line of lines) {
      const normalized = line.endsWith(',') ? line.slice(0, -1).trim() : line;
      try {
        chunks.push(JSON.parse(normalized));
      } catch (lineErr: any) {
        throw new Error(`Malformed StreamAssist stream chunk: ${lineErr.message}`);
      }
    }
    return chunks;
  }
}

const SESSION_RESOURCE_REGEX =
  /^projects\/[a-zA-Z0-9_-]+\/locations\/(global|us|eu)\/(?:collections\/[a-zA-Z0-9_-]+\/)?(?:engines|dataStores)\/[a-zA-Z0-9_-]+\/sessions\/[a-zA-Z0-9_-]+$/;

const SESSION_FILE_ID_REGEX = /^[a-zA-Z0-9._-]+$/;

// Matches Discovery Engine's CreateSessionRequest.session_id validator (`session_validator.cc`):
// `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`
const CREATE_SESSION_ID_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Inline AddContextFile limit before switching to raw Scotty media upload (`:uploadFile`)
const MAX_INLINE_CONTEXT_FILE_BYTES = 15 * 1024 * 1024;

export function validateSessionResourceName(sessionName: string): string {
  const trimmed = (sessionName || '').trim().replace(/^\/+/, '');
  if (
    !trimmed ||
    trimmed.includes('..') ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    trimmed.includes('\\') ||
    !SESSION_RESOURCE_REGEX.test(trimmed)
  ) {
    throw new SecurityValidationError(
      `Invalid Discovery Engine Session resource name: "${sessionName}".`
    );
  }
  return trimmed;
}

export function validateSessionFileId(fileId: string): string {
  const trimmed = (fileId || '').trim();
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('..') ||
    !SESSION_FILE_ID_REGEX.test(trimmed)
  ) {
    throw new SecurityValidationError(
      `Invalid Discovery Engine Session fileId: "${fileId}".`
    );
  }
  return trimmed;
}

export function sanitizeSessionUploadFileName(rawName: string, fallbackExt: string = 'bin'): string {
  const base = (rawName || '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .split(/[/\\]/)
    .pop()
    ?.trim() || '';
  if (!base || base === '.' || base === '..') {
    return `attachment.${fallbackExt}`;
  }
  return base;
}

function extensionForMimeType(mimeType: string): string {
  const normalized = (mimeType || '').toLowerCase().split(';')[0].trim();
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'text/csv': 'csv',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'video/mp4': 'mp4',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
  };
  return map[normalized] || 'bin';
}

function isBinaryMediaMimeType(mimeType: string): boolean {
  const normalized = (mimeType || '').toLowerCase().split(';')[0].trim();
  if (!normalized) return false;
  if (normalized === 'text/html' || normalized === 'application/json') return false;
  return (
    normalized.startsWith('image/') ||
    normalized.startsWith('audio/') ||
    normalized.startsWith('video/') ||
    normalized === 'application/pdf' ||
    normalized === 'text/csv' ||
    normalized.startsWith('application/vnd.')
  );
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

  private parseResourceContext(resourceName: string, fallbackEnv: { projectId: string; appLocation?: string }) {
    const parts = resourceName.split('/');
    const projIdx = parts.indexOf('projects');
    const locIdx = parts.indexOf('locations');
    const projectId = projIdx !== -1 && parts[projIdx + 1] ? parts[projIdx + 1] : fallbackEnv.projectId;
    const location = locIdx !== -1 && parts[locIdx + 1] ? parts[locIdx + 1] : fallbackEnv.appLocation || 'global';
    const baseUrl = getSafeDiscoveryEngineUrl(location);
    return { projectId, location, baseUrl };
  }

  public async getSession(sessionName: string, userEmail?: string): Promise<ChatSession> {
    const cleanSessionName = validateSessionResourceName(sessionName);
    const cached = this.sessionCache.get(cleanSessionName);
    if (cached) return cached;

    const fetchPromise = (async () => {
      const token = await this.getAuthToken(userEmail);
      const { projectId, baseUrl } = this.parseResourceContext(cleanSessionName, this.config.source);
      const url = `${baseUrl}/v1alpha/${cleanSessionName}?includeAnswerDetails=true`;

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

    this.sessionCache.set(cleanSessionName, fetchPromise);
    try {
      return await fetchPromise;
    } catch (err) {
      this.sessionCache.delete(cleanSessionName);
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
    const { projectId, baseUrl } = this.parseResourceContext(resourceName, this.config.source);
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

  /**
   * Lists context files and AI-generated files attached to a session via public
   * `SessionService.ListFiles` (`GET /v1alpha/{session}/files`), falling back to
   * `AssistantService.ListSessionFileMetadata` (`:listSessionFileMetadata`) on 404.
   */
  public async listSessionFiles(sessionName: string, userEmail?: string): Promise<SessionFileMetadata[]> {
    const cleanSessionName = validateSessionResourceName(sessionName);
    const token = await this.getAuthToken(userEmail);
    const { projectId, baseUrl } = this.parseResourceContext(cleanSessionName, this.config.source);
    const files: SessionFileMetadata[] = [];
    let pageToken = '';

    do {
      const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const url = `${baseUrl}/v1alpha/${cleanSessionName}/files?pageSize=1000${pageParam}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Goog-User-Project': projectId
        }
      });

      if (response.status === 404) {
        // Fallback to AssistantService.ListSessionFileMetadata if SessionService.ListFiles is 404
        const fallbackUrl = `${baseUrl}/v1alpha/${cleanSessionName}:listSessionFileMetadata?pageSize=1000`;
        const fbResp = await fetch(fallbackUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Goog-User-Project': projectId
          }
        });
        if (fbResp.status === 404) {
          logger.debug(`Session "${cleanSessionName}" has no session file endpoint (404); skipping file listing.`);
          return [];
        }
        if (!fbResp.ok) {
          const fbErr = await fbResp.text();
          throw new Error(`Failed to list session file metadata (${fbResp.status}): ${fbErr}`);
        }
        const fbData = await fbResp.json() as any;
        const fbItems: any[] = fbData.fileMetadata || fbData.files || [];
        return fbItems.filter((f: any) => f && f.fileId);
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to list session files (${response.status}): ${errText}`);
      }

      const data = await response.json() as any;
      const pageItems: any[] = data.files || data.fileMetadata || [];
      for (const item of pageItems) {
        if (item && item.fileId) {
          files.push(item as SessionFileMetadata);
        }
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    return files;
  }

  /**
   * Downloads raw bytes for a session file via Scotty `AssistantService.DownloadSessionFile`
   * (`GET /download/v1alpha/{session}:downloadFile?fileId={fileId}&alt=media`, public via `skip_filters`).
   */
  public async downloadSessionFile(
    sessionName: string,
    fileId: string,
    userEmail?: string
  ): Promise<Buffer> {
    const cleanSessionName = validateSessionResourceName(sessionName);
    const cleanFileId = validateSessionFileId(fileId);
    const token = await this.getAuthToken(userEmail);
    const { projectId, baseUrl } = this.parseResourceContext(cleanSessionName, this.config.source);
    const url = `${baseUrl}/download/v1alpha/${cleanSessionName}:downloadFile?fileId=${encodeURIComponent(cleanFileId)}&alt=media`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Goog-User-Project': projectId
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Failed to download session file "${cleanFileId}" from "${cleanSessionName}" (${response.status}): ${errText}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Uploads and attaches a context/generated file to a target session using public
   * `AssistantService.AddContextFile` (`POST /v1alpha/{session}:addContextFile`) for files <= 15 MiB,
   * or Scotty `AssistantService.UploadSessionFile` (`POST /upload/v1alpha/{session}:uploadFile?uploadType=media`)
   * for larger payloads.
   */
  public async uploadSessionFile(
    targetSessionName: string,
    fileName: string,
    mimeType: string,
    data: Buffer,
    userEmail?: string
  ): Promise<{ fileId: string; fileName?: string; mimeType?: string }> {
    const cleanSessionName = validateSessionResourceName(targetSessionName);
    const resolvedMime = (mimeType || 'application/octet-stream').trim() || 'application/octet-stream';
    const safeFileName = sanitizeSessionUploadFileName(fileName, extensionForMimeType(resolvedMime));
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw new Error(`Cannot upload empty session file "${safeFileName}" to "${cleanSessionName}".`);
    }

    const token = await this.getAuthToken(userEmail);
    const { projectId, baseUrl } = this.parseResourceContext(cleanSessionName, this.config.target);

    if (data.length <= MAX_INLINE_CONTEXT_FILE_BYTES) {
      const addUrl = `${baseUrl}/v1alpha/${cleanSessionName}:addContextFile`;
      const addResp = await fetch(addUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Goog-User-Project': projectId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fileName: safeFileName,
          mimeType: resolvedMime,
          fileContents: data.toString('base64')
        })
      });

      if (addResp.ok) {
        const result = await addResp.json() as any;
        return {
          fileId: result.fileId || '',
          fileName: result.fileName || safeFileName,
          mimeType: result.mimeType || resolvedMime
        };
      }

      // Fall through to Scotty raw upload only if payload was rejected for size (413)
      if (addResp.status !== 413) {
        const errText = await addResp.text();
        throw new Error(
          `Failed to attach context file "${safeFileName}" to "${cleanSessionName}" (${addResp.status}): ${errText}`
        );
      }
    }

    const uploadUrl = `${baseUrl}/upload/v1alpha/${cleanSessionName}:uploadFile?uploadType=media`;
    const bodyBytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Goog-User-Project': projectId,
        'Content-Type': resolvedMime,
        'X-Goog-Upload-Protocol': 'raw',
        'X-Goog-Upload-File-Name': encodeURIComponent(safeFileName)
      },
      body: bodyBytes
    });

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      throw new Error(
        `Failed to upload session file "${safeFileName}" via Scotty to "${cleanSessionName}" (${uploadResp.status}): ${errText}`
      );
    }

    const uploadResult = await uploadResp.json() as any;
    return {
      fileId: uploadResult.fileId || '',
      fileName: safeFileName,
      mimeType: resolvedMime
    };
  }

  /**
   * Rewrites source DataStore / Document paths in `@`-mention references to target environment equivalents.
   */
  private rewriteDocumentResourcePath(docName?: string): string | undefined {
    if (!docName) return undefined;
    const src = this.config.source;
    const tgt = this.config.target;
    let rewritten = docName;

    if (src.projectId && tgt.projectId) {
      rewritten = rewritten.replace(`projects/${src.projectId}/`, `projects/${tgt.projectId}/`);
    }
    if (src.appLocation && tgt.appLocation) {
      rewritten = rewritten.replace(`/locations/${src.appLocation}/`, `/locations/${tgt.appLocation}/`);
    }
    const srcCol = src.collectionId || 'default_collection';
    const tgtCol = tgt.collectionId || 'default_collection';
    rewritten = rewritten.replace(`/collections/${srcCol}/`, `/collections/${tgtCol}/`);

    const dsMapping = (this.config as any).datastoreMapping as Record<string, string> | undefined;
    if (dsMapping) {
      for (const [srcDs, tgtDs] of Object.entries(dsMapping)) {
        if (srcDs && tgtDs) {
          rewritten = rewritten.replace(`/dataStores/${srcDs}/`, `/dataStores/${tgtDs}/`);
        }
      }
    }
    return rewritten;
  }

  /**
   * Remaps structured `Query.parts` (`personReference`, `driveDocumentReference`, `documentReference`)
   * across source -> target identities and data stores while stripping output-only `fileId` fields.
   */
  public remapQueryParts(parts: ChatQueryPart[]): ChatQueryPart[] {
    return parts.map(part => {
      if (part.personReference) {
        const srcEmail = part.personReference.email || '';
        const mappedEmail = srcEmail
          ? IdentityMappingService.lookupTargetIdentity(srcEmail, this.config.identityMapping, srcEmail)
          : undefined;
        const cleanRef: PersonReferencePart = {
          ...(part.personReference.personId ? { personId: part.personReference.personId } : {}),
          ...(mappedEmail ? { email: mappedEmail } : {}),
          ...(part.personReference.displayName ? { displayName: part.personReference.displayName } : {}),
          ...(part.personReference.displayPhotoUri ? { displayPhotoUri: part.personReference.displayPhotoUri } : {}),
          ...(part.personReference.destinationUri ? { destinationUri: part.personReference.destinationUri } : {})
        };
        const rewrittenDoc = this.rewriteDocumentResourcePath(part.personReference.documentName);
        if (rewrittenDoc) cleanRef.documentName = rewrittenDoc;
        return { personReference: cleanRef };
      }

      if (part.driveDocumentReference) {
        const cleanDrive: DriveDocumentReferencePart = {
          ...(part.driveDocumentReference.driveId ? { driveId: part.driveDocumentReference.driveId } : {}),
          ...(part.driveDocumentReference.displayTitle ? { displayTitle: part.driveDocumentReference.displayTitle } : {}),
          ...(part.driveDocumentReference.destinationUri ? { destinationUri: part.driveDocumentReference.destinationUri } : {}),
          ...(part.driveDocumentReference.iconUri ? { iconUri: part.driveDocumentReference.iconUri } : {})
        };
        const rewrittenDoc = this.rewriteDocumentResourcePath(part.driveDocumentReference.documentName);
        if (rewrittenDoc) cleanDrive.documentName = rewrittenDoc;
        return { driveDocumentReference: cleanDrive };
      }

      if (part.documentReference) {
        const cleanDoc: DocumentReferencePart = {
          ...(part.documentReference.displayTitle ? { displayTitle: part.documentReference.displayTitle } : {}),
          ...(part.documentReference.destinationUri ? { destinationUri: part.documentReference.destinationUri } : {}),
          ...(part.documentReference.iconUri ? { iconUri: part.documentReference.iconUri } : {}),
          ...(part.documentReference.urlForConnector ? { urlForConnector: part.documentReference.urlForConnector } : {})
        };
        const rewrittenDoc = this.rewriteDocumentResourcePath(part.documentReference.documentName);
        if (rewrittenDoc) cleanDoc.documentName = rewrittenDoc;
        return { documentReference: cleanDoc };
      }

      if (part.uiJsonPayload !== undefined) {
        return { uiJsonPayload: part.uiJsonPayload };
      }

      return { text: part.text || '' };
    });
  }

  /**
   * Formats `Query.parts` into human-readable Markdown text, preserving `@Person`,
   * `@DriveDocument`, and `@Document` chips instead of dropping non-text parts.
   */
  public formatQueryPartsToText(parts?: ChatQueryPart[]): string {
    if (!parts || !Array.isArray(parts) || parts.length === 0) return '';
    const segments: string[] = [];

    for (const p of parts) {
      if (p.text) {
        segments.push(p.text);
      } else if (p.personReference) {
        const rawEmail = p.personReference.email || '';
        const mappedEmail = rawEmail
          ? IdentityMappingService.lookupTargetIdentity(rawEmail, this.config.identityMapping, rawEmail)
          : '';
        const label = p.personReference.displayName || mappedEmail || p.personReference.personId || 'Person';
        segments.push(mappedEmail && label !== mappedEmail ? `@${label} <${mappedEmail}>` : `@${label}`);
      } else if (p.driveDocumentReference) {
        const title = p.driveDocumentReference.displayTitle || p.driveDocumentReference.driveId || 'Drive Document';
        if (p.driveDocumentReference.destinationUri) {
          segments.push(`@[${title}](${p.driveDocumentReference.destinationUri})`);
        } else {
          segments.push(`@[${title}]`);
        }
      } else if (p.documentReference) {
        const title = p.documentReference.displayTitle || p.documentReference.documentName?.split('/').pop() || 'Document';
        if (p.documentReference.destinationUri) {
          segments.push(`@[${title}](${p.documentReference.destinationUri})`);
        } else {
          segments.push(`@[${title}]`);
        }
      }
    }

    return segments.join(' ').replace(/\s+/g, ' ').trim();
  }

  private hasStructuredReferenceParts(parts?: ChatQueryPart[]): boolean {
    if (!parts || !Array.isArray(parts)) return false;
    return parts.some(
      p => Boolean(p.personReference || p.driveDocumentReference || p.documentReference || p.uiJsonPayload)
    );
  }

  private extractQueryComparableText(query?: ChatSessionTurn['query']): string {
    if (!query) return '';
    if (query.text) return query.text;
    return this.formatQueryPartsToText(query.parts);
  }

  private formatGroundingReferences(references?: any[]): string {
    if (!Array.isArray(references) || references.length === 0) return '';
    const seen = new Set<string>();
    const items: string[] = [];

    for (const ref of references) {
      const docMeta = ref?.documentMetadata || {};
      const title = (docMeta.title || '').trim();
      const uri = (docMeta.uri || '').trim();
      const page = docMeta.pageIdentifier ? ` (p. ${docMeta.pageIdentifier})` : '';
      if (!title && !uri) continue;

      const dedupeKey = `${title}|${uri}|${page}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      if (title && uri) {
        items.push(`- [${title}](${uri})${page}`);
      } else if (uri) {
        items.push(`- <${uri}>${page}`);
      } else {
        items.push(`- ${title}${page}`);
      }
    }

    if (items.length === 0) return '';
    return `📚 **Sources & Citations:**\n${items.join('\n')}`;
  }

  private extractTextFromAnswer(
    ansData: any,
    fileMap?: Map<string, SessionFileMetadata>,
    inlineAttachmentsOut?: InlineBinaryAttachment[],
    turnNumber: number = 1
  ): string {
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

    // 2. Check replies array (AssistantGroundedContent: text, thought, executableCode, codeExecutionResult, inlineData, file, citations)
    if (ansData.replies && Array.isArray(ansData.replies)) {
      const replyTexts: string[] = [];
      const allReferences: any[] = [];
      let inlineCounter = 0;

      for (const r of ansData.replies) {
        const grounded = r.groundedContent;
        const content = grounded?.content;
        if (Array.isArray(grounded?.textGroundingMetadata?.references)) {
          allReferences.push(...grounded.textGroundingMetadata.references);
        }

        if (content) {
          if (content.thought && content.text) {
            replyTexts.push(`> 💭 *Reasoning:* ${content.text.trim()}`);
          } else if (content.text) {
            replyTexts.push(content.text.trim());
          }

          if (content.executableCode?.code) {
            replyTexts.push(`\`\`\`python\n${String(content.executableCode.code).trim()}\n\`\`\``);
          }

          if (content.codeExecutionResult) {
            const outcome = content.codeExecutionResult.outcome || 'OUTCOME_OK';
            const output = (content.codeExecutionResult.output || '').trim();
            if (output) {
              replyTexts.push(`**Code Execution (${outcome}):**\n\`\`\`text\n${output}\n\`\`\``);
            } else if (outcome !== 'OUTCOME_UNSPECIFIED') {
              replyTexts.push(`*Code Execution Outcome: \`${outcome}\`*`);
            }
          }

          if (content.inlineData?.data) {
            const inlineMime = content.inlineData.mimeType || 'application/octet-stream';
            let b64 = String(content.inlineData.data);
            const pad = b64.length % 4;
            if (pad) b64 += '='.repeat(4 - pad);

            try {
              const rawBuf = Buffer.from(b64, 'base64');
              if (isBinaryMediaMimeType(inlineMime) && rawBuf.length > 0) {
                inlineCounter++;
                const ext = extensionForMimeType(inlineMime);
                const generatedName = `turn-${turnNumber}-generated-${inlineCounter}.${ext}`;
                if (inlineAttachmentsOut) {
                  inlineAttachmentsOut.push({
                    fileName: generatedName,
                    mimeType: inlineMime,
                    data: rawBuf
                  });
                }
                replyTexts.push(`[📎 Generated Media Attached to Session: \`${generatedName}\` (${inlineMime})]`);
              } else {
                const decoded = rawBuf.toString('utf-8');
                const match =
                  decoded.match(/<h1[^>]*>(.*?)<\/h1>/i) ||
                  decoded.match(/literalString":\s*"([^"]+)"/);
                if (match) {
                  replyTexts.push(`[Interactive Canvas Panel: ${match[1].replace(/<[^>]+>/g, '').trim()}]`);
                }
              }
            } catch (decodeErr: any) {
              logger.debug(`Failed to decode inlineData in session answer reply: ${decodeErr.message}`);
            }
          }

          if (content.file) {
            const fid = content.file.fileId || '';
            const meta = fid && fileMap ? fileMap.get(fid) : undefined;
            const label = meta?.name || fid || content.file.mimeType || 'attachment';
            const mimeInfo = content.file.mimeType || meta?.mimeType;
            replyTexts.push(
              meta
                ? `[📎 Attached Session File: \`${label}\`${mimeInfo ? ` (${mimeInfo})` : ''}]`
                : `[Generated File: ${mimeInfo || label}]`
            );
          }
        }
      }

      const citationBlock = this.formatGroundingReferences(allReferences);
      if (citationBlock) {
        replyTexts.push(citationBlock);
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
    const humanFilterEntries = (this.config.options?.userFilter || []).filter(u => {
      if (isGroupOrNonHumanPrincipal(u)) {
        logger.debug(`Skipping non-user principal "${u}" during chat session discovery.`);
        return false;
      }
      return true;
    });
    const rawFilters = humanFilterEntries.map(u => u.replace(/^user:/i, '').trim()).filter(Boolean);
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
    const hasExplicitExactOnly = exactUserFilters.length > 0 && wildcardFilters.length === 0 && !rawFilters.includes('*') && !rawFilters.includes('*@*');

    if (hasExplicitExactOnly) {
      for (const u of exactUserFilters) {
        usersToScan.add(u);
      }
    } else {
      for (const u of exactUserFilters) {
        usersToScan.add(u);
      }
      for (const u of candidateUsers) {
        if (isGroupOrNonHumanPrincipal(u)) continue;
        const clean = u.replace(/^user:/i, '').trim();
        if (clean.includes('@') && !clean.includes('*') && matchesWildcards(clean)) usersToScan.add(clean);
      }
      if (this.config.identityMapping) {
        for (const k of Object.keys(this.config.identityMapping)) {
          if (isGroupOrNonHumanPrincipal(k)) continue;
          const clean = k.replace(/^user:/i, '').trim();
          if (clean.includes('@') && !clean.includes('*') && matchesWildcards(clean)) usersToScan.add(clean);
        }
      }
    }

    if (usersToScan.size === 0 && !hasExplicitExactOnly) {
      const defaultAdmin = process.env.ADMIN_EMAIL || process.env.DEFAULT_USER_EMAIL || '';
      if (defaultAdmin && !isGroupOrNonHumanPrincipal(defaultAdmin) && matchesWildcards(defaultAdmin)) {
        usersToScan.add(defaultAdmin);
      }
    }

    const allSessions: ChatSession[] = [];
    const seenSessionIds = new Set<string>();

    const scanList = usersToScan.size > 0 ? Array.from(usersToScan) : [undefined];

    for (const email of scanList) {
      try {
        const token = await this.getAuthToken(email);
        // Per `ListSessionsHandler` (`VERTEX_AI_MANAGED`) and `CreateSessionHandler` in Discovery Engine:
        // when calling `ListSessions` with an end-user OAuth token (DWD or WiF), Spanner already scopes results
        // strictly to that user's `owner_id`, whereas Web-UI sessions often default `user_pseudo_id` to the numeric
        // `session_id` rather than the user's email. Passing `filter=user_pseudo_id="<email>"` on an EUC-impersonated
        // request therefore hides native Web-UI chats! Only apply `filter=user_pseudo_id` when using a non-impersonated
        // shared/static admin credential (`impersonationMode === undefined`).
        const impersonationMode = email && typeof this.auth.getLastUsedImpersonationMode === 'function'
          ? this.auth.getLastUsedImpersonationMode(email)
          : undefined;
        const isEucImpersonated = impersonationMode === 'DWD' || impersonationMode === 'WIF';

        const baseUrl = getSafeDiscoveryEngineUrl(env.appLocation);
        let pageToken = '';
        let includeFullView = true;
        let userDiscoveredCount = 0;

        do {
          const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
          const userFilterParam = email && !isEucImpersonated
            ? `&filter=user_pseudo_id%3D%22${encodeURIComponent(email)}%22`
            : '';
          const viewParam = includeFullView ? '&view=SESSION_VIEW_FULL' : '';
          const url = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections/${env.collectionId || 'default_collection'}/engines/${env.appId}/sessions?pageSize=100${viewParam}${userFilterParam}${pageParam}`;

          let response = await fetch(url, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-Goog-User-Project': env.projectId
            }
          });

          // If strict customer endpoint rejects `view=SESSION_VIEW_FULL` (TRUSTED_TESTER field) with 400,
          // retry cleanly without the view query parameter.
          if (response.status === 400 && includeFullView) {
            includeFullView = false;
            const fallbackUrl = `${baseUrl}/v1alpha/projects/${env.projectId}/locations/${env.appLocation}/collections/${env.collectionId || 'default_collection'}/engines/${env.appId}/sessions?pageSize=100${userFilterParam}${pageParam}`;
            response = await fetch(fallbackUrl, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${token}`,
                'X-Goog-User-Project': env.projectId
              }
            });
          }

          if (response.ok) {
            const data = await response.json() as any;
            for (const s of (data.sessions || [])) {
              const sid = s.name.split('/').pop() || s.name;
              const existingPseudo = (s.userPseudoId || '').replace(/^user:/i, '').trim();
              // Defense-in-depth for legacy non-ACL engines (`SESSION_MANAGEMENT_POLICY_UNSPECIFIED`):
              // never attribute a session explicitly tagged with a different user's email to `email`.
              if (
                isEucImpersonated &&
                email &&
                existingPseudo.includes('@') &&
                existingPseudo.toLowerCase() !== email.toLowerCase()
              ) {
                continue;
              }
              if (!seenSessionIds.has(sid)) {
                seenSessionIds.add(sid);
                if (email && (!s.userPseudoId || !s.userPseudoId.includes('@'))) {
                  s.userPseudoId = email;
                }
                allSessions.push(s);
                userDiscoveredCount++;
              }
            }
            pageToken = data.nextPageToken || '';
          } else {
            const errText = await response.text();
            logger.warn(`Could not list sessions for user ${email || 'all'} (${response.status}): ${errText}`);
            break;
          }
        } while (pageToken);

        if (email && userDiscoveredCount > 0) {
          logger.info(`Discovered ${userDiscoveredCount} chat session(s) for "${email}".`);
        }
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
      const singleUserFilter =
        this.config.options?.userFilter?.length === 1 && !this.config.options.userFilter[0].includes('*')
          ? this.config.options.userFilter[0].replace(/^.*\/subject\//i, '').replace(/^user:/i, '').trim()
          : undefined;
      let cleanSrcUser = srcUser ? srcUser.replace(/^.*\/subject\//i, '').replace(/^user:/i, '').trim() : '';
      try {
        cleanSrcUser = decodeURIComponent(cleanSrcUser);
      } catch (uriErr: any) {
        logger.debug(`Could not URI-decode session userPseudoId "${cleanSrcUser}": ${uriErr.message}`);
      }

      const mappedFromDict = IdentityMappingService.lookupTargetIdentity(cleanSrcUser || srcUser, this.config.identityMapping, '');
      if (mappedFromDict && mappedFromDict !== (cleanSrcUser || srcUser)) {
        targetUserId = mappedFromDict;
      } else if (cleanSrcUser && this.config.identityMapping?.[cleanSrcUser]) {
        targetUserId = this.config.identityMapping[cleanSrcUser];
      } else if (srcUser && this.config.identityMapping?.[srcUser]) {
        targetUserId = this.config.identityMapping[srcUser];
      } else if (cleanSrcUser && cleanSrcUser.includes('@') && !cleanSrcUser.includes('*')) {
        targetUserId = cleanSrcUser;
      } else if (singleUserFilter && singleUserFilter.includes('@')) {
        targetUserId = singleUserFilter;
      } else {
        throw new Error(
          `Cannot migrate session "${session.displayName || session.name}": owner "${srcUser || 'unknown'}" is an unmapped opaque ID and cannot be safely assigned in a multi-user run.`
        );
      }
    }

    const targetUserEmail = targetUserId.includes('@') ? targetUserId : undefined;
    const token = await this.getAuthToken(targetUserEmail);

    // If session has turns with answer references but lacks detailed answers, hydrate session once
    let currentSession = session;
    const srcUserEmail = currentSession.userPseudoId?.replace(/^user:/i, '').includes('@')
      ? currentSession.userPseudoId.replace(/^user:/i, '').trim()
      : undefined;
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

    // Discover source session files (both user-uploaded attachments and AI-generated files)
    const shouldMigrateFiles = this.config.options?.migrateSessionFiles !== false;
    let sourceFiles: SessionFileMetadata[] = [];
    const sourceFileMap = new Map<string, SessionFileMetadata>();
    if (shouldMigrateFiles && currentSession.name) {
      try {
        sourceFiles = await this.listSessionFiles(currentSession.name, srcUserEmail);
        for (const f of sourceFiles) {
          if (f.fileId) {
            sourceFileMap.set(f.fileId, f);
          }
        }
      } catch (fileListErr: any) {
        logger.warn(`Could not list files for source session "${currentSession.name}": ${fileListErr.message}`);
      }
    }

    const rawTurns = currentSession.turns || [];
    const srcSessionId = currentSession.name.split('/').pop() || 'unknown';

    // Derive a clean, meaningful displayName (including rich @-mention text if query used parts)
    const firstTurnWithQuery = rawTurns.find(
      t => t.query?.text || (t.query?.parts && t.query.parts.length > 0)
    );
    const firstQueryText =
      firstTurnWithQuery?.query?.text ||
      this.formatQueryPartsToText(firstTurnWithQuery?.query?.parts) ||
      '';

    let displayName = (currentSession.displayName || '').trim();
    if (!displayName || (displayName.length > 120 && firstQueryText && firstQueryText.length < 100)) {
      displayName = firstQueryText || displayName || 'Untitled Chat';
    }
    if (displayName.length > 150) {
      displayName = displayName.substring(0, 147) + '...';
    }

    interface PairedTurnRecord {
      queryText: string;
      structuredParts?: ChatQueryPart[];
      queryConfig?: Record<string, string>;
      live?: boolean;
      answerText?: string;
    }

    const pairedTurns: PairedTurnRecord[] = [];
    const inlineBinaryAttachments: InlineBinaryAttachment[] = [];

    for (let idx = 0; idx < rawTurns.length; idx++) {
      const turn = rawTurns[idx];
      let qText = turn.query?.text;
      if (!qText && turn.query?.parts) {
        qText = this.formatQueryPartsToText(turn.query.parts);
      }

      const structuredParts = this.hasStructuredReferenceParts(turn.query?.parts)
        ? this.remapQueryParts(turn.query!.parts!)
        : undefined;

      const cleanQueryConfig: Record<string, string> | undefined = (() => {
        if (!turn.queryConfig || typeof turn.queryConfig !== 'object') return undefined;
        const entries = Object.entries(turn.queryConfig).filter(
          ([k, v]) => typeof k === 'string' && k.length > 0 && typeof v === 'string'
        );
        return entries.length > 0 ? Object.fromEntries(entries) : undefined;
      })();

      let ansText = '';
      if ((turn as any).detailedAssistAnswer || (turn as any).detailedAnswer) {
        ansText = this.extractTextFromAnswer(
          (turn as any).detailedAssistAnswer || (turn as any).detailedAnswer,
          sourceFileMap,
          shouldMigrateFiles ? inlineBinaryAttachments : undefined,
          idx + 1
        );
      }
      if (!ansText) {
        const ansRef = turn.assistAnswer || turn.answer;
        if (ansRef && typeof ansRef === 'string' && ansRef.startsWith('projects/')) {
          try {
            const ansData = await this.getAnswer(ansRef, srcUserEmail);
            ansText = this.extractTextFromAnswer(
              ansData,
              sourceFileMap,
              shouldMigrateFiles ? inlineBinaryAttachments : undefined,
              idx + 1
            );
          } catch (e: any) {
            logger.debug(`Could not hydrate answer ${ansRef}: ${e.message}`);
          }
        } else if (turn.answer && typeof turn.answer === 'string' && !turn.answer.startsWith('projects/')) {
          ansText = turn.answer;
        }
      }

      // Check if session labels have workflow summary text (for scheduled workflow agents)
      if (!ansText && currentSession.labels && Array.isArray(currentSession.labels)) {
        const wfSummary = currentSession.labels.find((l: string) => l.startsWith('workflow-summary-text:'));
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
          if (!last.structuredParts && structuredParts) {
            last.structuredParts = structuredParts;
          }
          if (!last.queryConfig && cleanQueryConfig) {
            last.queryConfig = cleanQueryConfig;
          }
        } else {
          pairedTurns.push({
            queryText: qText,
            structuredParts,
            queryConfig: cleanQueryConfig,
            live: turn.live,
            answerText: ansText || undefined
          });
        }
      } else if (
        ansText &&
        pairedTurns.length > 0 &&
        (!pairedTurns[pairedTurns.length - 1].answerText ||
          pairedTurns[pairedTurns.length - 1].answerText?.startsWith('> 📋 **Archived Dialogue Record**'))
      ) {
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

      let responseSuffix = '';
      if (p.answerText) {
        responseSuffix += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🤖 **Gemini Response:**\n\n${p.answerText}`;
      }

      if (isLast && sourceFiles.length > 0) {
        const fileNames = sourceFiles.map(f => `\`${f.name || f.fileId}\``).join(', ');
        responseSuffix += `\n\n📎 **Session Files Restored (${sourceFiles.length}):** ${fileNames}`;
      }

      if (isLast) {
        responseSuffix += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📋 **Archived History** — *Migrated from \`${srcProj}\` for reference.*`;
      }

      const turnObj: any = {};
      if (p.structuredParts && p.structuredParts.length > 0) {
        // Per `session.proto`, `parts` and `text` are mutually exclusive on `Query`:
        // preserve genuine `@Person` / `@DriveDoc` / `@Document` chips in `parts` followed by the response text part.
        turnObj.query = {
          parts: responseSuffix
            ? [...p.structuredParts, { text: responseSuffix }]
            : [...p.structuredParts]
        };
      } else {
        turnObj.query = {
          text: `${p.queryText}${responseSuffix}`
        };
      }

      if (p.queryConfig) {
        turnObj.queryConfig = p.queryConfig;
      }
      if (typeof p.live === 'boolean') {
        turnObj.live = p.live;
      }

      hydratedTurns.push(turnObj);
    }

    const targetSessionLabels = [
      `source-session-id:${srcSessionId}`,
      `migrated-from-project:${this.config.source?.projectId || 'source'}`
    ];

    const enableContinuableHandshake =
      this.config.options?.continuableSessions === true && pairedTurns.length > 0;

    const payload: any = {
      displayName: displayName,
      userPseudoId: targetUserId,
      state: currentSession.state || 'IN_PROGRESS',
      labels: targetSessionLabels,
      // When continuableSessions is enabled, create an empty session container first so `:streamAssist`
      // writes a genuine Spanner `AssistAnswer` row on the consolidated historical context turn.
      turns: enableContinuableHandshake ? [] : hydratedTurns
    };

    if (currentSession.isPinned === true) {
      payload.isPinned = true;
    }

    const baseUrl = getSafeDiscoveryEngineUrl(target.appLocation);
    const sessionsEndpoint = `${baseUrl}/v1alpha/projects/${target.projectId}/locations/${target.appLocation}/collections/${target.collectionId || 'default_collection'}/engines/${target.appId}/sessions`;
    const canPreserveSessionId = CREATE_SESSION_ID_REGEX.test(srcSessionId);
    const targetUrl = canPreserveSessionId
      ? `${sessionsEndpoint}?sessionId=${encodeURIComponent(srcSessionId)}`
      : sessionsEndpoint;

    // Probe target engine to avoid duplicate session creation on retry
    try {
      const existingSessions = await this.listTargetSessions(targetUserEmail);
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
          const sFirstQuery = this.extractQueryComparableText(s.turns?.[0]?.query);
          const hFirstQuery = this.extractQueryComparableText(hydratedTurns[0]?.query);
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

    let response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Goog-User-Project': target.projectId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    // If deterministic `sessionId` collides in target engine (409 ALREADY_EXISTS), fall back to server-assigned ID
    if (response.status === 409 && canPreserveSessionId) {
      logger.debug(`Session ID "${srcSessionId}" already exists in target engine (409); retrying CreateSession with server-assigned session ID.`);
      response = await fetch(sessionsEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Goog-User-Project': target.projectId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to create session in target (${response.status}): ${errText}`);
    }

    const created = await response.json() as ChatSession;

    // Migrate binary session files (both source context/generated files and inline generated media blobs)
    const migratedFileIds: Record<string, string> = {};
    let migratedCount = 0;

    if (shouldMigrateFiles && created?.name && (sourceFiles.length > 0 || inlineBinaryAttachments.length > 0)) {
      for (const fileMeta of sourceFiles) {
        try {
          const fileBytes = await this.downloadSessionFile(currentSession.name, fileMeta.fileId, srcUserEmail);
          const uploaded = await this.uploadSessionFile(
            created.name,
            fileMeta.name || fileMeta.fileId,
            fileMeta.mimeType || 'application/octet-stream',
            fileBytes,
            targetUserEmail
          );
          if (uploaded.fileId) {
            migratedFileIds[fileMeta.fileId] = uploaded.fileId;
          }
          migratedCount++;
        } catch (fileErr: any) {
          logger.warn(
            `Failed to migrate session file "${fileMeta.name || fileMeta.fileId}" (${fileMeta.fileId}) for session "${displayName}": ${fileErr.message}`
          );
        }
      }

      for (const inlineBlob of inlineBinaryAttachments) {
        try {
          const uploaded = await this.uploadSessionFile(
            created.name,
            inlineBlob.fileName,
            inlineBlob.mimeType,
            inlineBlob.data,
            targetUserEmail
          );
          if (uploaded.fileId) {
            migratedFileIds[inlineBlob.fileName] = uploaded.fileId;
          }
          migratedCount++;
        } catch (inlineErr: any) {
          logger.warn(
            `Failed to upload inline generated attachment "${inlineBlob.fileName}" for session "${displayName}": ${inlineErr.message}`
          );
        }
      }

      created.migratedFilesCount = migratedCount;
      created.migratedFileIds = migratedFileIds;
    }

    // Opt-in `:streamAssist` Context Handshake (`continuableSessions: true`):
    // Seeds one live turn containing the exact verbatim historical Q&A with `toolsSpec: {}` so Spanner
    // stores a real `AssistAnswer` row — enabling `CreatePlannerStepsFromSessionTurns` to feed the
    // entire migrated history into Gemini's context window on all subsequent follow-up turns.
    if (enableContinuableHandshake && created?.name) {
      const cleanSessionResource = validateSessionResourceName(created.name);
      const filesFooter = sourceFiles.length > 0
        ? `\n\n📎 **Session Files Restored (${sourceFiles.length}):** ${sourceFiles.map(f => `\`${f.name || f.fileId}\``).join(', ')}`
        : '';
      const handshakeDirective =
        `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📋 **Archived History** — *Migrated verbatim from \`${srcProj}\`.*\n` +
        `*(System Instruction: The conversation above is historical context restored from \`${srcProj}\`. ` +
        `Do NOT invoke any tools, connectors, or searches, and do NOT rewrite the historical answers above. ` +
        `Reply ONLY with: "✅ Restored conversation context from \`${srcProj}\` — ready for follow-up questions.")*`;

      try {
        let handshakeQuery: { text?: string; parts?: ChatQueryPart[] };
        const hasAnyStructuredParts = pairedTurns.some(pt => pt.structuredParts && pt.structuredParts.length > 0);

        if (pairedTurns.length === 1 && hasAnyStructuredParts && pairedTurns[0].structuredParts) {
          const p0 = pairedTurns[0];
          const structuredParts0 = p0.structuredParts!;
          const suffix =
            (p0.answerText
              ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🤖 **Gemini Response:**\n\n${p0.answerText}`
              : '') +
            filesFooter +
            handshakeDirective;
          handshakeQuery = {
            parts: [...structuredParts0, { text: suffix }]
          };
        } else {
          const fullTranscriptBody = pairedTurns.length === 1
            ? `${pairedTurns[0].queryText}` +
              (pairedTurns[0].answerText
                ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🤖 **Gemini Response:**\n\n${pairedTurns[0].answerText}`
                : '')
            : pairedTurns
                .map((pt, idx) =>
                  `💬 **Turn ${idx + 1} — User:**\n${pt.queryText}\n\n` +
                  `🤖 **Turn ${idx + 1} — Gemini Response:**\n${pt.answerText || ''}`
                )
                .join('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');

          let inlineTranscriptBody = fullTranscriptBody;
          if (fullTranscriptBody.length > MAX_INLINE_CONTINUABLE_TRANSCRIPT_CHARS) {
            if (shouldMigrateFiles) {
              try {
                const overflowBuf = Buffer.from(fullTranscriptBody, 'utf8');
                const uploadedTranscript = await this.uploadSessionFile(
                  cleanSessionResource,
                  'migrated_conversation_transcript.md',
                  'text/plain',
                  overflowBuf,
                  targetUserEmail
                );
                if (uploadedTranscript.fileId) {
                  migratedFileIds['migrated_conversation_transcript.md'] = uploadedTranscript.fileId;
                  migratedCount++;
                  created.migratedFilesCount = migratedCount;
                  created.migratedFileIds = migratedFileIds;
                }
              } catch (overflowErr: any) {
                logger.warn(`Could not upload overflow transcript file for session "${displayName}": ${overflowErr.message}`);
              }
            }
            inlineTranscriptBody =
              `*(Earlier turns archived in attached \`migrated_conversation_transcript.md\`)*\n\n` +
              fullTranscriptBody.slice(-MAX_INLINE_CONTINUABLE_TRANSCRIPT_CHARS);
          }

          handshakeQuery = {
            text: `${inlineTranscriptBody}${filesFooter}${handshakeDirective}`
          };
        }

        const assistantId = target.assistantId || 'default_assistant';
        const streamAssistUrl = `${baseUrl}/v1alpha/projects/${target.projectId}/locations/${target.appLocation}/collections/${target.collectionId || 'default_collection'}/engines/${target.appId}/assistants/${assistantId}:streamAssist`;

        const streamRes = await fetch(streamAssistUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Goog-User-Project': target.projectId,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            session: cleanSessionResource,
            query: handshakeQuery,
            toolsSpec: {}
          }),
          signal: AbortSignal.timeout(90000)
        });

        if (!streamRes.ok) {
          const streamErrText = await streamRes.text();
          throw new Error(`StreamAssist handshake returned HTTP ${streamRes.status}: ${streamErrText}`);
        }

        const rawStreamBody = await streamRes.text();
        const chunks = parseStreamAssistChunks(rawStreamBody);
        const hasProducedAnswer = chunks.some(
          c =>
            (Array.isArray(c?.answer?.replies) && c.answer.replies.length > 0) ||
            (typeof c?.answer?.name === 'string' && c.answer.name.length > 0 && c?.answer?.state !== 'SKIPPED') ||
            (typeof c?.assistToken === 'string' && c.assistToken.length > 0 && c?.answer?.state !== 'SKIPPED')
        );
        const wasExplicitlySkipped =
          !hasProducedAnswer && chunks.some(c => c?.answer?.state === 'SKIPPED');

        if (!hasProducedAnswer || wasExplicitlySkipped) {
          throw new Error(
            wasExplicitlySkipped
              ? 'StreamAssist skipped answer generation (Model Armor or assist-skipping policy).'
              : 'StreamAssist returned no AssistAnswer chunks.'
          );
        }

        // Lock in the original `displayName` (and `isPinned`) via PATCH without `turns` in `updateMask`
        // so `StreamAssist` auto-titling never overwrites the source session's title, while keeping the
        // newly persisted Spanner `AssistAnswer` turn intact.
        const maskFields = currentSession.isPinned === true ? 'displayName,isPinned' : 'displayName';
        const patchMetaUrl = `${baseUrl}/v1alpha/${cleanSessionResource}?updateMask=${maskFields}`;
        const patchMetaBody: Record<string, any> = {
          name: cleanSessionResource,
          displayName
        };
        if (currentSession.isPinned === true) {
          patchMetaBody.isPinned = true;
        }
        const patchMetaRes = await fetch(patchMetaUrl, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Goog-User-Project': target.projectId,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(patchMetaBody)
        });
        if (!patchMetaRes.ok) {
          const patchErr = await patchMetaRes.text();
          logger.warn(`Could not restore displayName "${displayName}" after StreamAssist handshake (${patchMetaRes.status}): ${patchErr}`);
        }

        created.continuableSeeded = true;
      } catch (handshakeErr: any) {
        logger.warn(
          `Continuable chat handshake failed for "${displayName}" (${handshakeErr.message}); falling back to verbatim archive turns so no history is lost.`
        );
        const fallbackPatchUrl = `${baseUrl}/v1alpha/${cleanSessionResource}?updateMask=turns,displayName`;
        const fallbackRes = await fetch(fallbackPatchUrl, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Goog-User-Project': target.projectId,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: cleanSessionResource,
            displayName,
            turns: hydratedTurns
          })
        });
        if (!fallbackRes.ok) {
          const fbErrText = await fallbackRes.text();
          throw new Error(
            `Continuable handshake failed (${handshakeErr.message}) and archive fallback PATCH also failed (${fallbackRes.status}): ${fbErrText}`
          );
        }
        created.continuableSeeded = false;
      }
    }

    logger.info(
      `Restored session "${displayName}" for ${targetUserId} with ${hydratedTurns.length} turns` +
      (created.continuableSeeded ? ' [continuable]' : '') +
      (created.migratedFilesCount ? ` and ${created.migratedFilesCount} attached file(s)` : '') +
      ` -> Target ID: ${created.name.split('/').pop()}`
    );
    return created;
  }
}
