import { describe, it, expect, vi } from 'vitest';
import { NotebookMigrator, isSameSource } from '../src/engines/notebookMigrator.js';
import { DiscoveryEngineClient } from '../src/services/discoveryEngine.js';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import { Notebook, NotebookSource } from '../src/types/index.js';
import { EnvironmentConfig } from '../src/types/migration.js';
import { MigrationOptionsSchema } from '../src/config/configSchema.js';
import { logger } from '../src/utils/logger.js';

describe('NotebookMigrator Engine', () => {
  const dummyAuth = new GcpAuthService({ staticToken: 'test-token' });
  const dummyClient = new DiscoveryEngineClient(dummyAuth);
  const migrator = new NotebookMigrator(dummyClient);

  describe('User Ownership Filtering', () => {
    const sampleNotebook: Notebook = {
      name: 'projects/123/locations/global/notebooks/nb-1',
      title: 'Finance Analysis Notebook',
      metadata: {
        ownerEmail: 'alice@fedex.com',
        creatorEmail: 'alice@fedex.com'
      }
    };

    it('should match user filter when email matches', () => {
      expect(migrator.isNotebookOwnedByUser(sampleNotebook, ['alice@fedex.com'])).toBe(true);
    });

    it('should match wildcard domain filters (*@fedex.com)', () => {
      expect(migrator.isNotebookOwnedByUser(sampleNotebook, ['*@fedex.com'])).toBe(true);
      expect(migrator.isNotebookOwnedByUser(sampleNotebook, ['*@other.com'])).toBe(false);
    });

    it('should match all when filter is empty or wildcard *', () => {
      expect(migrator.isNotebookOwnedByUser(sampleNotebook, [])).toBe(true);
      expect(migrator.isNotebookOwnedByUser(sampleNotebook, ['*'])).toBe(true);
    });

    it('should reject shared Editor/Viewer notebooks where metadata.isShareable is false or role is non-OWNER', () => {
      const sharedEditorNotebook: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-shared-1',
        title: 'Team Shared Notebook',
        metadata: {
          isShared: true,
          isShareable: false,
          ownerEmail: 'alice@fedex.com'
        }
      };
      const roleEditorNotebook: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-shared-2',
        title: 'Role Editor Notebook',
        userRole: 'EDITOR',
        metadata: {
          isShared: true,
          isShareable: true
        }
      };
      const ownedSharedNotebook: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-owned-1',
        title: 'My Shared Notebook (Owner)',
        metadata: {
          isShared: true,
          isShareable: true,
          ownerEmail: 'alice@fedex.com'
        }
      };

      const protoOmittedEditorNotebook: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-shared-proto',
        title: 'Proto3 Omitted isShareable Shared Notebook',
        metadata: {
          isShared: true,
          createTime: '2026-09-01T12:00:00Z',
          lastViewed: '2026-09-24T12:00:00Z'
          // isShareable is omitted (undefined) by Google Protobuf v3 JSON when false
        }
      };

      const projectRoleWriterNotebook: Notebook = {
        name: 'projects/123/locations/global/notebooks/nb-writer-1',
        title: 'Shared Writer Notebook',
        metadata: {
          userRole: 'PROJECT_ROLE_WRITER',
          isShared: true,
          isShareable: true,
          createTime: '2026-07-21T17:36:45.440384Z',
          lastViewed: '2026-09-24T18:13:50.004970Z'
        }
      };

      const projectRoleReaderNotebook: Notebook = {
        name: 'projects/123/locations/global/notebooks/nb-reader-1',
        title: 'Shared Reader Notebook',
        metadata: {
          userRole: 'PROJECT_ROLE_READER',
          isShared: true,
          isShareable: true,
          createTime: '2026-07-21T17:36:45.440384Z',
          lastViewed: '2026-09-24T18:13:48.870310Z'
        }
      };

      const regionalSharedNotebook: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-regional-shared',
        title: 'Regional Shared Notebook (userRole undefined, isShareable true)',
        metadata: {
          isShared: true,
          isShareable: true,
          createTime: '2026-07-21T17:36:45.440384Z',
          lastViewed: '2026-09-24T18:13:48.870310Z'
        }
      };

      const regionalPrivateNotebook: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-regional-private',
        title: 'Regional Private Notebook (isShared false)',
        metadata: {
          isShared: false,
          isShareable: true,
          createTime: '2026-07-21T17:36:45.440384Z',
          lastViewed: '2026-09-24T18:13:48.870310Z'
        }
      };

      expect(migrator.isCallerNotebookOwner(sharedEditorNotebook, 'alice@fedex.com')).toBe(false);
      expect(migrator.isNotebookOwnedByUser(sharedEditorNotebook, ['alice@fedex.com'])).toBe(false);
      expect(migrator.isCallerNotebookOwner(protoOmittedEditorNotebook, 'alice@fedex.com')).toBe(false);
      expect(migrator.isNotebookOwnedByUser(protoOmittedEditorNotebook, ['alice@fedex.com'])).toBe(false);
      expect(migrator.isCallerNotebookOwner(roleEditorNotebook, 'alice@fedex.com')).toBe(false);
      expect(migrator.isNotebookOwnedByUser(roleEditorNotebook, ['alice@fedex.com'])).toBe(false);
      expect(migrator.isCallerNotebookOwner(projectRoleWriterNotebook, 'editor@example.com')).toBe(false);
      expect(migrator.isNotebookOwnedByUser(projectRoleWriterNotebook, ['editor@example.com'])).toBe(false);
      expect(migrator.isCallerNotebookOwner(projectRoleReaderNotebook, 'viewer@example.com')).toBe(false);
      expect(migrator.isNotebookOwnedByUser(projectRoleReaderNotebook, ['viewer@example.com'])).toBe(false);
      expect(migrator.isCallerNotebookOwner(regionalSharedNotebook, 'editor@example.com')).toBe(false);
      expect(migrator.isNotebookOwnedByUser(regionalSharedNotebook, ['editor@example.com'])).toBe(false);
      expect(migrator.isCallerNotebookOwner(regionalPrivateNotebook, 'owner@example.com')).toBe(true);
      expect(migrator.isNotebookOwnedByUser(regionalPrivateNotebook, ['owner@example.com'])).toBe(true);
      expect(migrator.isCallerNotebookOwner(ownedSharedNotebook, 'alice@fedex.com')).toBe(true);
      expect(migrator.isNotebookOwnedByUser(ownedSharedNotebook, ['alice@fedex.com'])).toBe(true);
    });
  });

  describe('Source Payload Mapping', () => {
    it('should map Google Drive doc sources properly', () => {
      const docSource: NotebookSource = {
        title: 'Q3 Earnings Report',
        metadata: {
          googleDocsMetadata: {
            documentId: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
            mimeType: 'application/vnd.google-apps.document'
          }
        }
      };

      const mapped = migrator.mapSourceToPayload(docSource);
      expect(mapped.googleDriveContent).toBeDefined();
      expect(mapped.googleDriveContent.documentId).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz');
      expect(mapped.googleDriveContent.sourceName).toBe('Q3 Earnings Report');
    });

    it('should map YouTube video sources properly', () => {
      const videoSource: NotebookSource = {
        title: 'Product Keynote',
        metadata: {
          youtubeMetadata: {
            youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
          }
        }
      };

      const mapped = migrator.mapSourceToPayload(videoSource);
      expect(mapped.videoContent).toBeDefined();
      expect(mapped.videoContent.youtubeUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    it('should map Web URLs and text fallback sources', () => {
      const webSource: NotebookSource = {
        title: 'FedEx Developer Portal',
        metadata: {
          webpageMetadata: {
            webpageUrl: 'https://developer.fedex.com'
          }
        }
      };

      const mapped = migrator.mapSourceToPayload(webSource);
      expect(mapped.webContent).toBeDefined();
      expect(mapped.webContent.url).toBe('https://developer.fedex.com');
    });

    it('should extract text from tailwindDoc for uploaded PDF/document sources', () => {
      const pdfSource: NotebookSource = {
        title: 'Yumi_and_the_Nightmare_Painter.pdf',
        tailwindDoc: {
          body: {
            content: [
              {
                paragraph: {
                  elements: [
                    { textRun: { content: 'Chapter 1: The Nightmare Painter.\n' } },
                    { textRun: { content: 'Nikaro walked down the neon-lit street.' } }
                  ]
                }
              }
            ]
          }
        }
      };

      const mapped = migrator.mapSourceToPayload(pdfSource);
      expect(mapped.textContent).toBeDefined();
      expect(mapped.textContent.sourceName).toBe('Yumi_and_the_Nightmare_Painter.pdf');
      expect(mapped.textContent.content).toBe('Chapter 1: The Nightmare Painter.\nNikaro walked down the neon-lit street.');
    });

    it('should return null for metadata-only v1alpha sources without content or URL instead of fabricating a fake [Restored Source: ...] stub', () => {
      const metadataOnlySource: NotebookSource = {
        sourceId: { id: '73ad2b63-5747-41a8-b488-a74f141caab5' },
        title: 'Agent Designer overview | Gemini Enterprise | Google Cloud Documentation',
        metadata: {
          wordCount: 969,
          tokenCount: 1577,
          sourceAddedTimestamp: '2026-05-14T12:11:15.762355Z'
        }
      };

      const mapped = migrator.mapSourceToPayload(metadataOnlySource);
      expect(mapped).toBeNull();
    });

    it('should return null when _fetchError is present on a source (e.g. 30s timeout during getNotebookSource)', () => {
      const timedOutSource: NotebookSource = {
        sourceId: { id: 'src-timeout-1' },
        title: 'https://internal.ford.com/large-doc',
        metadata: {
          wordCount: 18500,
          tokenCount: 24000
        },
        ...({ _fetchError: 'Request to https://discoveryengine.googleapis.com/... timed out after 30000ms' } as any)
      };

      const mapped = migrator.mapSourceToPayload(timedOutSource);
      expect(mapped).toBeNull();
    });

    it('should extract text from tailwindDoc.chunks when present', () => {
      const chunkedSource: NotebookSource = {
        title: 'Architecture_Spec.pdf',
        tailwindDoc: {
          chunks: [
            { text: 'Section 1: Overview.' },
            { content: 'Section 2: Security Controls.' }
          ]
        }
      };

      const mapped = migrator.mapSourceToPayload(chunkedSource);
      expect(mapped.textContent).toBeDefined();
      expect(mapped.textContent.sourceName).toBe('Architecture_Spec.pdf');
      expect(mapped.textContent.content).toBe('Section 1: Overview.\nSection 2: Security Controls.');
    });

    it('should honestly report FAILED and MANUAL_REUPLOAD_REQUIRED sources in both Dry Run and Live Run without creating fake placeholder sources', async () => {
      const sourceEnv: EnvironmentConfig = {
        projectId: 'source-p',
        appLocation: 'global',
        collectionId: 'default_collection',
        appId: 'app-1',
        assistantId: 'default_assistant'
      };
      const targetEnv: EnvironmentConfig = {
        projectId: 'target-p',
        appLocation: 'global',
        collectionId: 'default_collection',
        appId: 'app-2',
        assistantId: 'default_assistant'
      };

      const nbWithMixedSources: Notebook = {
        name: 'projects/source-p/locations/global/notebooks/nb-mixed',
        notebookId: 'nb-mixed',
        title: 'Notebook With Mixed Sources',
        metadata: {
          userRole: 'PROJECT_ROLE_OWNER',
          isShared: false,
          isShareable: true,
          ownerEmail: 'alice@company.com'
        },
        sources: [
          {
            name: 'projects/source-p/locations/global/notebooks/nb-mixed/sources/src-valid',
            sourceId: { id: 'src-valid' },
            title: 'Valid_Architecture.pdf',
            metadata: { wordCount: 500 }
          },
          {
            name: 'projects/source-p/locations/global/notebooks/nb-mixed/sources/src-timeout',
            sourceId: { id: 'src-timeout' },
            title: 'Huge_Service_Manual.pdf',
            metadata: { wordCount: 95000 }
          },
          {
            name: 'projects/source-p/locations/global/notebooks/nb-mixed/sources/src-empty-meta',
            sourceId: { id: 'src-empty-meta' },
            title: 'Binary_Only_No_TailwindDoc.pdf',
            metadata: { wordCount: 1200, tokenCount: 1800 }
          }
        ]
      };

      const mockClient = {
        listNotebooks: vi.fn().mockImplementation(async (env: EnvironmentConfig) => {
          if (env.projectId === 'source-p') return [nbWithMixedSources];
          return [];
        }),
        getNotebook: vi.fn().mockResolvedValue(nbWithMixedSources),
        getNotebookSource: vi.fn().mockImplementation(async (_nbId: string, srcId: string) => {
          if (srcId === 'src-valid') {
            return {
              name: 'projects/source-p/locations/global/notebooks/nb-mixed/sources/src-valid',
              title: 'Valid_Architecture.pdf',
              content: 'Real extracted PDF text content.'
            };
          }
          if (srcId === 'src-timeout') {
            throw new Error('Request timed out after 30000ms');
          }
          // src-empty-meta returns only metadata without tailwindDoc or content
          return {
            name: 'projects/source-p/locations/global/notebooks/nb-mixed/sources/src-empty-meta',
            title: 'Binary_Only_No_TailwindDoc.pdf',
            metadata: { wordCount: 1200, tokenCount: 1800 }
          };
        }),
        createNotebook: vi.fn().mockResolvedValue({
          name: 'projects/target-p/locations/global/notebooks/nb-target-mixed',
          title: 'Notebook With Mixed Sources'
        }),
        batchCreateNotebookSources: vi.fn().mockResolvedValue({
          sources: [
            { name: 'projects/target-p/locations/global/notebooks/nb-target-mixed/sources/new-src-1' }
          ]
        }),
        listNotes: vi.fn().mockResolvedValue([]),
        listArtifacts: vi.fn().mockResolvedValue([])
      } as unknown as DiscoveryEngineClient;

      const testMigrator = new NotebookMigrator(mockClient);

      // 1. Verify Dry Run honestly reports 1 migratable source and 2 failed/manual sources
      const dryResults = await testMigrator.migrateNotebooks(
        sourceEnv,
        targetEnv,
        { dryRun: true, concurrency: 2, userFilter: ['alice@company.com'] }
      );
      expect(dryResults).toHaveLength(1);
      expect(dryResults[0].details?.sourcesCount).toBe(3);
      expect(dryResults[0].details?.sourcesRestored).toBe(1);
      expect(dryResults[0].details?.sourcesFailed).toBe(2);
      expect(dryResults[0].error).toContain('2 source(s) failed to restore in target');
      const drySourceStatuses = dryResults[0].details?.sources.map((s: any) => ({ title: s.title, status: s.status }));
      expect(drySourceStatuses).toEqual([
        { title: 'Valid_Architecture.pdf', status: 'DRY_RUN' },
        { title: 'Huge_Service_Manual.pdf', status: 'FAILED' },
        { title: 'Binary_Only_No_TailwindDoc.pdf', status: 'MANUAL_REUPLOAD_REQUIRED' }
      ]);

      // 2. Verify Live Run only sends the 1 valid source to batchCreateNotebookSources and never creates a fake stub
      const liveResults = await testMigrator.migrateNotebooks(
        sourceEnv,
        targetEnv,
        { dryRun: false, concurrency: 2, userFilter: ['alice@company.com'] }
      );
      expect(liveResults).toHaveLength(1);
      expect(liveResults[0].details?.sourcesCount).toBe(3);
      expect(liveResults[0].details?.sourcesRestored).toBe(1);
      expect(liveResults[0].details?.sourcesFailed).toBe(2);
      expect(mockClient.batchCreateNotebookSources).toHaveBeenCalledTimes(1);
      const sentPayloads = vi.mocked(mockClient.batchCreateNotebookSources).mock.calls[0][1];
      expect(sentPayloads).toHaveLength(1);
      expect(sentPayloads[0]).toEqual({
        textContent: {
          sourceName: 'Valid_Architecture.pdf',
          content: 'Real extracted PDF text content.'
        }
      });
    });

    it('should reject out-of-range or non-integer concurrency values in MigrationOptionsSchema (negative test)', () => {
      expect(() => MigrationOptionsSchema.parse({ concurrency: 0 })).toThrow();
      expect(() => MigrationOptionsSchema.parse({ concurrency: -3 })).toThrow();
      expect(() => MigrationOptionsSchema.parse({ concurrency: 51 })).toThrow();
      expect(() => MigrationOptionsSchema.parse({ concurrency: 2.5 })).toThrow();
      expect(MigrationOptionsSchema.parse({ concurrency: 3 }).concurrency).toBe(3);
    });
  });

  describe('Source Deduplication (isSameSource)', () => {
    it('should identify identical Google Drive sources by documentId', () => {
      const s1: NotebookSource = {
        title: 'Doc A',
        metadata: { googleDocsMetadata: { documentId: 'doc-123' } }
      };
      const s2: NotebookSource = {
        title: 'Doc A Renamed',
        metadata: { googleDocsMetadata: { documentId: 'doc-123' } }
      };
      const s3: NotebookSource = {
        title: 'Doc B',
        metadata: { googleDocsMetadata: { documentId: 'doc-456' } }
      };

      expect(isSameSource(s1, s2)).toBe(true);
      expect(isSameSource(s1, s3)).toBe(false);
    });

    it('should identify identical YouTube sources by url', () => {
      const s1: NotebookSource = {
        metadata: { youtubeMetadata: { youtubeUrl: 'https://youtube.com/watch?v=abc' } }
      };
      const s2: NotebookSource = {
        metadata: { youtubeMetadata: { youtubeUrl: 'https://youtube.com/watch?v=abc' } }
      };
      const s3: NotebookSource = {
        metadata: { youtubeMetadata: { youtubeUrl: 'https://youtube.com/watch?v=xyz' } }
      };

      expect(isSameSource(s1, s2)).toBe(true);
      expect(isSameSource(s1, s3)).toBe(false);
    });

    it('should identify identical Web URL sources', () => {
      const s1: NotebookSource = {
        url: 'https://example.com/guide'
      };
      const s2: NotebookSource = {
        metadata: { webpageMetadata: { webpageUrl: 'https://example.com/guide' } }
      };
      const s3: NotebookSource = {
        url: 'https://example.com/other'
      };

      expect(isSameSource(s1, s2)).toBe(true);
      expect(isSameSource(s1, s3)).toBe(false);
    });

    it('should identify identical sources by matching title/displayName', () => {
      const s1: NotebookSource = { title: 'Quarterly_Report_2026.pdf' };
      const s2: NotebookSource = { displayName: 'Quarterly_Report_2026.pdf' };
      const s3: NotebookSource = { title: 'Annual_Report_2026.pdf' };

      expect(isSameSource(s1, s2)).toBe(true);
      expect(isSameSource(s1, s3)).toBe(false);
    });
  });

  describe('Deduplication in migrateNotebooks on Re-runs', () => {
    it('should not duplicate sources when target notebook already contains matching sources', async () => {
      const sourceEnv: EnvironmentConfig = { projectId: 'source-p', appLocation: 'global', appId: 'source-app' };
      const targetEnv: EnvironmentConfig = { projectId: 'target-p', appLocation: 'global', appId: 'target-app' };

      const existingSourceInTarget: NotebookSource = {
        name: 'projects/target-p/locations/global/notebooks/nb-tgt-1/sources/src-tgt-1',
        title: 'Existing Source 1',
        metadata: {
          googleDocsMetadata: { documentId: 'doc-existing-1' }
        }
      };

      const existingTargetNotebook: Notebook = {
        name: 'projects/target-p/locations/global/notebooks/nb-tgt-1',
        title: 'Project Phoenix Research',
        sources: [existingSourceInTarget]
      };

      const sourceNotebook: Notebook = {
        name: 'projects/source-p/locations/global/notebooks/nb-src-1',
        title: 'Project Phoenix Research',
        owner: 'alice@company.com',
        sources: [
          // Source 1: Already exists in target
          {
            name: 'projects/source-p/locations/global/notebooks/nb-src-1/sources/src-1',
            title: 'Existing Source 1',
            metadata: {
              googleDocsMetadata: { documentId: 'doc-existing-1' }
            }
          },
          // Source 2: Brand new source
          {
            name: 'projects/source-p/locations/global/notebooks/nb-src-1/sources/src-2',
            title: 'New Whitepaper.pdf',
            content: 'Authentic whitepaper content'
          }
        ]
      };

      const mockClient = {
        listNotebooks: vi.fn(),
        getNotebook: vi.fn(),
        getNotebookSource: vi.fn(),
        createNotebook: vi.fn(),
        batchCreateNotebookSources: vi.fn(),
        listNotes: vi.fn().mockResolvedValue([]),
        createNote: vi.fn(),
        listArtifacts: vi.fn().mockResolvedValue([]),
        createArtifact: vi.fn()
      } as unknown as DiscoveryEngineClient;

      const testMigrator = new NotebookMigrator(mockClient);

      // 1. listNotebooks in source returns sourceNotebook
      vi.mocked(mockClient.listNotebooks).mockImplementation(async (env) => {
        if (env.projectId === sourceEnv.projectId) return [sourceNotebook];
        // Target already has the notebook
        return [existingTargetNotebook];
      });

      // 2. getNotebook
      vi.mocked(mockClient.getNotebook).mockImplementation(async (id, env) => {
        if (env.projectId === sourceEnv.projectId) return sourceNotebook;
        return existingTargetNotebook;
      });

      vi.mocked(mockClient.getNotebookSource).mockImplementation(async (nbId, srcId, env) => {
        const found = sourceNotebook.sources?.find(s => s.name?.endsWith(srcId));
        return found || { title: 'Unknown' };
      });

      // 3. batchCreateNotebookSources should only receive the NEW source
      vi.mocked(mockClient.batchCreateNotebookSources).mockResolvedValue({
        sources: [
          {
            name: 'projects/target-p/locations/global/notebooks/nb-tgt-1/sources/src-tgt-2',
            title: 'New Whitepaper.pdf'
          }
        ]
      });

      const results = await testMigrator.migrateNotebooks(
        sourceEnv,
        targetEnv,
        { dryRun: false, userFilter: ['alice@company.com'] }
      );

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('SUCCESS');
      expect(results[0].targetId).toBe('nb-tgt-1');
      // Should not call createNotebook because target notebook already exists
      expect(mockClient.createNotebook).not.toHaveBeenCalled();

      // batchCreateNotebookSources should be called with ONLY 1 payload (the new source), NOT 2!
      expect(mockClient.batchCreateNotebookSources).toHaveBeenCalledTimes(1);
      const batchArgs = vi.mocked(mockClient.batchCreateNotebookSources).mock.calls[0];
      expect(batchArgs[0]).toBe('nb-tgt-1');
      const payloads = batchArgs[1];
      expect(payloads).toHaveLength(1);
      expect(payloads[0].textContent?.sourceName).toBe('New Whitepaper.pdf');

      // Both sources should be accounted for in details
      expect(results[0].details?.sourcesCount).toBe(2);
      expect(results[0].details?.sourcesRestored).toBe(2);
      expect(results[0].details?.sourcesFailed).toBe(0);
    });

    it('should disambiguate owned-shared notebooks (get.isShared=false) from editor/viewer shared notebooks (get.isShared=true) and emit [DIAGNOSTIC] logs in debugMode', async () => {
      const sourceEnv: EnvironmentConfig = {
        projectId: 'source-us',
        appLocation: 'us',
        collectionId: 'default_collection',
        appId: 'app-src',
        assistantId: 'default_assistant'
      };
      const targetEnv: EnvironmentConfig = {
        projectId: 'target-us',
        appLocation: 'us',
        collectionId: 'default_collection',
        appId: 'app-tgt',
        assistantId: 'default_assistant'
      };

      // In regional v1alpha (`us`), listNotebooks omits `userRole` and sets `isShared: true` for all shared notebooks
      const listPrivateOwned: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-private-owned',
        notebookId: 'nb-private-owned',
        title: 'Private Owned Notebook',
        metadata: { isShared: false, isShareable: true }
      };
      const listSharedOwned: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-shared-owned',
        notebookId: 'nb-shared-owned',
        title: 'Owned Notebook Shared With Team',
        metadata: { isShared: true, isShareable: true }
      };
      const listSharedEditor: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-shared-editor',
        notebookId: 'nb-shared-editor',
        title: 'Colleague Notebook Shared With User As Editor',
        metadata: { isShared: true, isShareable: true }
      };

      const mockClient = {
        listNotebooks: vi.fn().mockImplementation(async (env) => {
          if (env.projectId === 'source-us') {
            return [listPrivateOwned, listSharedOwned, listSharedEditor];
          }
          return [];
        }),
        getNotebook: vi.fn().mockImplementation(async (id) => {
          if (id === 'nb-shared-owned') {
            // GetNotebook returns isShared: false for the Owner of a shared notebook!
            return {
              ...listSharedOwned,
              metadata: { isShared: false, isShareable: true },
              premiumFeatureInfo: { canEditAdvancedSettings: true },
              sources: []
            };
          }
          if (id === 'nb-shared-editor') {
            // GetNotebook returns isShared: true for an Editor/Viewer!
            return {
              ...listSharedEditor,
              metadata: { isShared: true, isShareable: true },
              premiumFeatureInfo: { canEditAdvancedSettings: true },
              sources: []
            };
          }
          return { ...listPrivateOwned, sources: [] };
        }),
        createNotebook: vi.fn().mockImplementation(async (nb) => ({
          ...nb,
          name: `projects/456/locations/us/notebooks/new-${nb.notebookId || 'id'}`
        })),
        batchCreateNotebookSources: vi.fn().mockResolvedValue({ sources: [] }),
        listNotes: vi.fn().mockResolvedValue([]),
        listAudioOverviews: vi.fn().mockResolvedValue([]),
        listArtifacts: vi.fn().mockResolvedValue([])
      } as unknown as DiscoveryEngineClient;

      const testMigrator = new NotebookMigrator(mockClient);
      const results = await testMigrator.migrateNotebooks(
        sourceEnv,
        targetEnv,
        { dryRun: true, debugMode: true, userFilter: ['owner@company.com'] } as any
      );

      // Should migrate BOTH the private owned notebook AND the owned-shared notebook, while skipping the editor notebook!
      expect(results).toHaveLength(2);
      const migratedTitles = results.map(r => r.displayName);
      expect(migratedTitles).toContain('Private Owned Notebook');
      expect(migratedTitles).toContain('Owned Notebook Shared With Team');
      expect(migratedTitles).not.toContain('Colleague Notebook Shared With User As Editor');
    });

    it('should detect and log [OWNERSHIP WARNING] when caller holds project-level discoveryengine.notebooks.delete', async () => {
      const sourceEnv: EnvironmentConfig = { projectId: 'cei-vertex-prd-01', appLocation: 'us', appId: 'app-1' };
      const targetEnv: EnvironmentConfig = { projectId: 'cei-gemini-prd-01', appLocation: 'us', appId: 'app-2' };

      const listSharedColleague: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-colleague',
        notebookId: 'nb-colleague',
        title: 'Colleague Shared Notebook',
        metadata: { userRole: 'UNSPECIFIED', isShared: true, isShareable: true }
      };

      const testProjectIamPermissionsMock = vi.fn().mockResolvedValue(['discoveryengine.notebooks.delete']);
      const warnSpy = vi.spyOn(logger, 'warn');

      const mockClient = {
        listNotebooks: vi.fn().mockImplementation(async (env) => (env.projectId === 'cei-vertex-prd-01' ? [listSharedColleague] : [])),
        getNotebook: vi.fn().mockResolvedValue({
          ...listSharedColleague,
          metadata: { userRole: 'UNSPECIFIED', isShared: false, isShareable: true },
          sources: []
        }),
        testProjectIamPermissions: testProjectIamPermissionsMock,
        createNotebook: vi.fn(),
        batchCreateNotebookSources: vi.fn().mockResolvedValue({ sources: [] }),
        listNotes: vi.fn().mockResolvedValue([]),
        listAudioOverviews: vi.fn().mockResolvedValue([]),
        listArtifacts: vi.fn().mockResolvedValue([])
      } as unknown as DiscoveryEngineClient;

      const testMigrator = new NotebookMigrator(mockClient);
      await testMigrator.migrateNotebooks(
        sourceEnv,
        targetEnv,
        { dryRun: true, debugMode: true, userFilter: ['azzolinig@coned.com'] } as any
      );

      expect(testProjectIamPermissionsMock).toHaveBeenCalledWith(
        'cei-vertex-prd-01',
        ['discoveryengine.notebooks.delete'],
        'azzolinig@coned.com'
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ADMIN PERMISSION ELEVATION DETECTED'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[DRY RUN AUDIT: PERMISSION ELEVATION]'));
      warnSpy.mockRestore();
    });

    it('should defer Admin users to the end of bulk runs, remove standard user-owned notebooks first, and flag remaining shared Admin notebooks', async () => {
      const sourceEnv: EnvironmentConfig = { projectId: 'cei-vertex-prd-01', appLocation: 'us', appId: 'app-src' };
      const targetEnv: EnvironmentConfig = { projectId: 'cei-gemini-prd-01', appLocation: 'us', appId: 'app-tgt' };

      const minglaeSharedNb: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-minglae-owned-shared',
        notebookId: 'nb-minglae-owned-shared',
        title: 'Minglae Shared Notebook',
        metadata: { userRole: 'UNSPECIFIED', isShared: true, isShareable: true }
      };
      const adminPrivateNb: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-admin-private',
        notebookId: 'nb-admin-private',
        title: 'Admin Private Notebook',
        metadata: { userRole: 'UNSPECIFIED', isShared: false, isShareable: true }
      };
      const adminAmbiguousSharedNb: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-admin-ambiguous-shared',
        notebookId: 'nb-admin-ambiguous-shared',
        title: 'Ambiguous Shared Notebook Seen By Admin',
        metadata: { userRole: 'UNSPECIFIED', isShared: true, isShareable: true }
      };

      const discoveryOrder: string[] = [];
      const migrationCreationOrder: string[] = [];

      const mockClient = {
        testProjectIamPermissions: vi.fn().mockImplementation(async (_proj: string, _perms: string[], userEmail?: string) => {
          // Admin holds project-level delete; standard user minglae does not
          if (userEmail === 'admin@coned.com') return ['discoveryengine.notebooks.delete'];
          return [];
        }),
        listNotebooks: vi.fn().mockImplementation(async (env: EnvironmentConfig, userEmail?: string) => {
          if (env.projectId !== 'cei-vertex-prd-01') return [];
          discoveryOrder.push(userEmail || 'root');
          if (userEmail === 'admin@coned.com') {
            // Admin sees their private notebook, Minglae's shared notebook, and another shared notebook
            return [
              { ...adminPrivateNb, metadata: { ...adminPrivateNb.metadata } },
              { ...minglaeSharedNb, metadata: { ...minglaeSharedNb.metadata } },
              { ...adminAmbiguousSharedNb, metadata: { ...adminAmbiguousSharedNb.metadata } }
            ];
          }
          if (userEmail === 'minglae@coned.com') {
            return [{ ...minglaeSharedNb, metadata: { ...minglaeSharedNb.metadata } }];
          }
          return [];
        }),
        getNotebook: vi.fn().mockImplementation(async (id: string) => {
          // Both return isShared: false on getNotebook (minglae because she is true owner; admin because of delete elevation)
          if (id === 'nb-minglae-owned-shared') {
            return { ...minglaeSharedNb, metadata: { isShared: false, isShareable: true }, sources: [] };
          }
          if (id === 'nb-admin-ambiguous-shared') {
            return { ...adminAmbiguousSharedNb, metadata: { isShared: false, isShareable: true }, sources: [] };
          }
          return { ...adminPrivateNb, metadata: { isShared: false, isShareable: true }, sources: [] };
        }),
        createNotebook: vi.fn().mockImplementation(async (_env: EnvironmentConfig, payload: any, owner?: string) => {
          migrationCreationOrder.push(`${owner}:${payload.title}`);
          return {
            name: `projects/456/locations/us/notebooks/tgt-${payload.title.replace(/\s+/g, '-').toLowerCase()}`,
            title: payload.title
          };
        }),
        batchCreateNotebookSources: vi.fn().mockResolvedValue({ sources: [] }),
        listNotes: vi.fn().mockResolvedValue([]),
        listArtifacts: vi.fn().mockResolvedValue([])
      } as unknown as DiscoveryEngineClient;

      const testMigrator = new NotebookMigrator(mockClient);

      // Pass admin FIRST in userFilter to verify that NotebookMigrator reorders standard users before admins
      const results = await testMigrator.migrateNotebooks(
        sourceEnv,
        targetEnv,
        {
          dryRun: false,
          concurrency: 1,
          userFilter: ['admin@coned.com', 'minglae@coned.com']
        }
      );

      // 1. Standard user minglae must be discovered BEFORE admin@coned.com
      expect(discoveryOrder).toEqual(['minglae@coned.com', 'admin@coned.com']);

      // 2. Minglae's shared notebook must be owned by minglae@coned.com and deduplicated from admin@coned.com
      expect(results).toHaveLength(3);
      const minglaeRes = results.find(r => r.id === 'nb-minglae-owned-shared')!;
      expect(minglaeRes.originalOwner).toBe('minglae@coned.com');
      expect(minglaeRes.details?.adminValidationFlagged).toBeUndefined();

      // 3. Admin's private notebook is NOT flagged as ambiguous shared
      const adminPrivateRes = results.find(r => r.id === 'nb-admin-private')!;
      expect(adminPrivateRes.originalOwner).toBe('admin@coned.com');
      expect(adminPrivateRes.details?.adminValidationFlagged).toBeFalsy();

      // 4. Remaining shared Admin notebook IS flagged for validation and migrated LAST (at the end of the run)
      const adminSharedRes = results.find(r => r.id === 'nb-admin-ambiguous-shared')!;
      expect(adminSharedRes.originalOwner).toBe('admin@coned.com');
      expect(adminSharedRes.details?.adminValidationFlagged).toBe(true);
      expect(adminSharedRes.details?.hasProjectLevelAdminElevation).toBe(true);
      expect(adminSharedRes.ownershipNote).toContain('FLAGGED FOR VALIDATION');

      expect(migrationCreationOrder).toEqual([
        'minglae@coned.com:Minglae Shared Notebook',
        'admin@coned.com:Admin Private Notebook',
        'admin@coned.com:Ambiguous Shared Notebook Seen By Admin'
      ]);
    });

    it('should prompt for HITL at the end of the migration when promptForAdminNotebookHitl is enabled, migrating approved and skipping rejected notebooks', async () => {
      const sourceEnv: EnvironmentConfig = { projectId: 'cei-vertex-prd-01', appLocation: 'us', appId: 'app-src' };
      const targetEnv: EnvironmentConfig = { projectId: 'cei-gemini-prd-01', appLocation: 'us', appId: 'app-tgt' };

      const adminSharedApprove: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-admin-shared-approve',
        notebookId: 'nb-admin-shared-approve',
        title: 'Admin True Shared Notebook',
        metadata: { userRole: 'UNSPECIFIED', isShared: true, isShareable: true }
      };
      const adminSharedReject: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-admin-shared-reject',
        notebookId: 'nb-admin-shared-reject',
        title: 'External Colleague Shared Notebook',
        metadata: { userRole: 'UNSPECIFIED', isShared: true, isShareable: true }
      };

      const mockClient = {
        testProjectIamPermissions: vi.fn().mockResolvedValue(['discoveryengine.notebooks.delete']),
        listNotebooks: vi.fn().mockImplementation(async (env: EnvironmentConfig) => {
          if (env.projectId === 'cei-vertex-prd-01') {
            return [
              { ...adminSharedApprove, metadata: { ...adminSharedApprove.metadata } },
              { ...adminSharedReject, metadata: { ...adminSharedReject.metadata } }
            ];
          }
          return [];
        }),
        getNotebook: vi.fn().mockImplementation(async (id: string) => ({
          name: `projects/123/locations/us/notebooks/${id}`,
          notebookId: id,
          title: id === 'nb-admin-shared-approve' ? 'Admin True Shared Notebook' : 'External Colleague Shared Notebook',
          metadata: { isShared: false, isShareable: true },
          sources: []
        })),
        createNotebook: vi.fn().mockImplementation(async (_env: EnvironmentConfig, payload: any) => ({
          name: `projects/456/locations/us/notebooks/new-${payload.title}`,
          title: payload.title
        })),
        batchCreateNotebookSources: vi.fn().mockResolvedValue({ sources: [] }),
        listNotes: vi.fn().mockResolvedValue([]),
        listArtifacts: vi.fn().mockResolvedValue([])
      } as unknown as DiscoveryEngineClient;

      const hitlPromptSpy = vi.fn().mockImplementation(async (candidates) => {
        expect(candidates).toHaveLength(2);
        // Operator approves ONLY nb-admin-shared-approve and rejects nb-admin-shared-reject
        return ['nb-admin-shared-approve'];
      });

      const testMigrator = new NotebookMigrator(mockClient);
      const results = await testMigrator.migrateNotebooks(
        sourceEnv,
        targetEnv,
        {
          dryRun: false,
          promptForAdminNotebookHitl: true,
          onAdminNotebookHitlPrompt: hitlPromptSpy,
          userFilter: ['admin@coned.com']
        }
      );

      expect(hitlPromptSpy).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);

      const approved = results.find(r => r.id === 'nb-admin-shared-approve')!;
      expect(approved.status).toBe('SUCCESS');
      expect(approved.details?.adminValidationFlagged).toBe(true);
      expect(approved.details?.adminHitlDecision).toBe('APPROVED');

      const rejected = results.find(r => r.id === 'nb-admin-shared-reject')!;
      expect(rejected.status).toBe('SKIPPED');
      expect(rejected.details?.adminValidationFlagged).toBe(true);
      expect(rejected.details?.adminHitlDecision).toBe('REJECTED');
      expect(rejected.ownershipNote).toContain('Skipped by operator during Admin Shared Notebook HITL validation');

      // Only the 1 approved notebook should have been created in target
      expect(mockClient.createNotebook).toHaveBeenCalledTimes(1);
    });

    it('should safely skip unverified shared Admin notebooks when promptForAdminNotebookHitl is true but no interactive callback or approvedAdminNotebookIds is provided (adversarial/headless guard)', async () => {
      const sourceEnv: EnvironmentConfig = { projectId: 'cei-vertex-prd-01', appLocation: 'us', appId: 'app-src' };
      const targetEnv: EnvironmentConfig = { projectId: 'cei-gemini-prd-01', appLocation: 'us', appId: 'app-tgt' };

      const unverifiedShared: Notebook = {
        name: 'projects/123/locations/us/notebooks/nb-unverified-shared',
        notebookId: 'nb-unverified-shared',
        title: 'Unverified Shared Admin Notebook',
        metadata: { userRole: 'UNSPECIFIED', isShared: true, isShareable: true }
      };

      const mockClient = {
        testProjectIamPermissions: vi.fn().mockResolvedValue(['discoveryengine.notebooks.delete']),
        listNotebooks: vi.fn().mockResolvedValue([unverifiedShared]),
        getNotebook: vi.fn().mockResolvedValue({
          ...unverifiedShared,
          metadata: { isShared: false, isShareable: true },
          sources: []
        }),
        createNotebook: vi.fn(),
        batchCreateNotebookSources: vi.fn(),
        listNotes: vi.fn().mockResolvedValue([]),
        listArtifacts: vi.fn().mockResolvedValue([])
      } as unknown as DiscoveryEngineClient;

      const testMigrator = new NotebookMigrator(mockClient);
      const results = await testMigrator.migrateNotebooks(
        sourceEnv,
        targetEnv,
        {
          dryRun: false,
          promptForAdminNotebookHitl: true,
          userFilter: ['admin@coned.com']
        }
      );

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('SKIPPED');
      expect(results[0].details?.adminHitlDecision).toBe('REJECTED');
      expect(mockClient.createNotebook).not.toHaveBeenCalled();
    });

    it('should explicitly reject malformed promptForAdminNotebookHitl and approvedAdminNotebookIds options with ZodError', () => {
      expect(() =>
        MigrationOptionsSchema.parse({
          promptForAdminNotebookHitl: 'yes-please' as any
        })
      ).toThrow(/Expected boolean/);

      expect(() =>
        MigrationOptionsSchema.parse({
          promptForAdminNotebookHitl: true,
          approvedAdminNotebookIds: [12345, { malicious: true }] as any
        })
      ).toThrow(/Expected string/);
    });

    it('should skip listing and recreating Studio artifacts when exportArtifacts is false', async () => {
      const sourceEnv: EnvironmentConfig = { projectId: 'ancient-sandbox-322523', appLocation: 'global', appId: 'app-src' };
      const targetEnv: EnvironmentConfig = { projectId: 'testgebackupandrestorev3', appLocation: 'global', appId: 'app-tgt' };

      const privateNotebook: Notebook = {
        name: 'projects/123/locations/global/notebooks/nb-no-artifacts',
        notebookId: 'nb-no-artifacts',
        title: 'Private Notebook',
        metadata: { userRole: 'PROJECT_ROLE_OWNER', isShared: false, isShareable: true }
      };

      const listArtifactsSpy = vi.fn().mockResolvedValue([{ title: 'Should Not Be Fetched', type: 'SLIDE_DECK' }]);
      const createArtifactSpy = vi.fn().mockResolvedValue({});

      const mockClient = {
        testProjectIamPermissions: vi.fn().mockResolvedValue([]),
        listNotebooks: vi.fn().mockImplementation(async (env: EnvironmentConfig) => {
          if (env.projectId === sourceEnv.projectId) return [privateNotebook];
          return [];
        }),
        getNotebook: vi.fn().mockResolvedValue({
          ...privateNotebook,
          sources: []
        }),
        createNotebook: vi.fn().mockResolvedValue({
          name: 'projects/456/locations/global/notebooks/nb-created',
          title: 'Private Notebook'
        }),
        batchCreateNotebookSources: vi.fn().mockResolvedValue({ sources: [] }),
        listNotes: vi.fn().mockResolvedValue([]),
        listArtifacts: listArtifactsSpy,
        createArtifact: createArtifactSpy
      } as unknown as DiscoveryEngineClient;

      const testMigrator = new NotebookMigrator(mockClient);
      const results = await testMigrator.migrateNotebooks(
        sourceEnv,
        targetEnv,
        {
          dryRun: false,
          exportArtifacts: false,
          userFilter: ['wdufrin@wdufrin.altostrat.com']
        }
      );

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('SUCCESS');
      expect(listArtifactsSpy).not.toHaveBeenCalled();
      expect(createArtifactSpy).not.toHaveBeenCalled();
    });

    it('should accurately detect Admin vs Standard users under DWD mode via Project IAM Policy and Custom Role inspection without failing on narrow DWD token scopes', async () => {
      const mockAuth = {
        getAuthType: () => 'SERVICE_ACCOUNT_KEY' as const,
        getServiceAccountProjectId: () => 'testgebackupandrestorev3',
        getLastUsedImpersonationMode: () => 'DWD' as const,
        getImpersonationMechanismStatus: (_email: string, mode: 'DWD' | 'WIF') => ({
          available: mode === 'DWD',
          reason: mode === 'DWD' ? 'DWD configured' : 'WIF not configured'
        }),
        getAccessToken: vi.fn().mockResolvedValue('base-or-user-token')
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.includes(':getIamPolicy')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              bindings: [
                {
                  role: 'projects/ancient-sandbox-322523/roles/agentspace',
                  members: ['user:admin@wdufrin.altostrat.com']
                },
                {
                  role: 'roles/editor',
                  members: ['user:mikesh@wdufrin.altostrat.com']
                },
                {
                  role: 'projects/ancient-sandbox-322523/roles/customRestrictedEndUser',
                  members: ['user:wdufrin@wdufrin.altostrat.com']
                },
                {
                  role: 'roles/discoveryengine.user',
                  members: ['user:bryankelly@wdufrin.altostrat.com']
                }
              ]
            })
          } as any;
        }
        if (url.includes('iam.googleapis.com/v1/projects/ancient-sandbox-322523/roles/agentspace')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              includedPermissions: ['discoveryengine.notebooks.delete', 'discoveryengine.notebooks.get']
            })
          } as any;
        }
        if (url.includes('iam.googleapis.com/v1/projects/ancient-sandbox-322523/roles/customRestrictedEndUser')) {
          return {
            ok: false,
            status: 403,
            text: async () => JSON.stringify({ error: { message: 'iam.roles.get denied' } })
          } as any;
        }
        throw new Error(`Unexpected URL in test: ${url}`);
      });

      try {
        const realClient = new DiscoveryEngineClient(mockAuth as any);
        const adminPerms = await realClient.testProjectIamPermissions(
          'ancient-sandbox-322523',
          ['discoveryengine.notebooks.delete'],
          'admin@wdufrin.altostrat.com'
        );
        const editorPerms = await realClient.testProjectIamPermissions(
          'ancient-sandbox-322523',
          ['discoveryengine.notebooks.delete'],
          'mikesh@wdufrin.altostrat.com'
        );
        const restrictedPerms = await realClient.testProjectIamPermissions(
          'ancient-sandbox-322523',
          ['discoveryengine.notebooks.delete'],
          'wdufrin@wdufrin.altostrat.com'
        );
        const standardPerms = await realClient.testProjectIamPermissions(
          'ancient-sandbox-322523',
          ['discoveryengine.notebooks.delete'],
          'bryankelly@wdufrin.altostrat.com'
        );

        expect(adminPerms).toEqual(['discoveryengine.notebooks.delete']);
        expect(editorPerms).toEqual(['discoveryengine.notebooks.delete']);
        expect(restrictedPerms).toEqual([]);
        expect(standardPerms).toEqual([]);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
