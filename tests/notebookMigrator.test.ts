import { describe, it, expect, vi } from 'vitest';
import { NotebookMigrator, isSameSource } from '../src/engines/notebookMigrator.js';
import { DiscoveryEngineClient } from '../src/services/discoveryEngine.js';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import { Notebook, NotebookSource } from '../src/types/index.js';
import { EnvironmentConfig } from '../src/types/migration.js';

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

      expect(migrator.isCallerNotebookOwner(sharedEditorNotebook, 'alice@fedex.com')).toBe(false);
      expect(migrator.isNotebookOwnedByUser(sharedEditorNotebook, ['alice@fedex.com'])).toBe(false);
      expect(migrator.isCallerNotebookOwner(roleEditorNotebook, 'alice@fedex.com')).toBe(false);
      expect(migrator.isNotebookOwnedByUser(roleEditorNotebook, ['alice@fedex.com'])).toBe(false);
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

    it('should recreate metadata-only v1alpha sources as textContent with source metadata', () => {
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
      expect(mapped).not.toBeNull();
      expect(mapped.textContent).toBeDefined();
      expect(mapped.textContent.sourceName).toBe('Agent Designer overview | Gemini Enterprise | Google Cloud Documentation');
      expect(mapped.textContent.content).toContain('Word Count: 969');
      expect(mapped.textContent.content).toContain('Token Count: 1577');
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
  });
});
