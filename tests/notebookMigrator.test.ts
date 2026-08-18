import { describe, it, expect } from 'vitest';
import { NotebookMigrator } from '../src/engines/notebookMigrator.js';
import { DiscoveryEngineClient } from '../src/services/discoveryEngine.js';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import { Notebook, NotebookSource } from '../src/types/index.js';

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
  });
});
