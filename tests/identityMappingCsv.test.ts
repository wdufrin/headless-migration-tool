import { describe, it, expect } from 'vitest';
import { IdentityMappingService } from '../src/services/identityMappingService';
import { MigrationReporter } from '../src/services/reporter';
import { MigrationReport } from '../src/types/migration';

describe('IdentityMappingService — CSV User ID Mapping & Mapping Audit Report', () => {
  describe('parseCsvMappings (first.last@XXXX.com -> #####@YYYY.com)', () => {
    it('parses standard 2-column CSV with header and maps first.last@XXXX.com to #####@YYYY.com', () => {
      const csv = [
        'source_user_id,target_user_id',
        'alice.smith@xxxx.com,849201@yyyy.com',
        'bob.jones@xxxx.com,849202@yyyy.com',
        '"carol.williams@xxxx.com","849203@yyyy.com"'
      ].join('\n');

      const result = IdentityMappingService.parseCsvMappings(csv);
      expect(result.totalRowsParsed).toBe(3);
      expect(result.skippedHeaderRows).toBe(1);
      expect(result.malformedRows).toHaveLength(0);
      expect(result.collisions).toHaveLength(0);
      expect(result.mappings['alice.smith@xxxx.com']).toBe('849201@yyyy.com');
      expect(result.mappings['bob.jones@xxxx.com']).toBe('849202@yyyy.com');
      expect(result.mappings['carol.williams@xxxx.com']).toBe('849203@yyyy.com');
    });

    it('supports semicolon, tab, and arrow (-> / =>) delimiters and appends default domains for bare IDs', () => {
      const csv = [
        '# Comment row should be ignored',
        'first.last@xxxx.com ; 10001@yyyy.com',
        'david.miller\t10002',
        'eve.adams@xxxx.com -> 10003@yyyy.com',
        'frank.clark => 10004'
      ].join('\n');

      const result = IdentityMappingService.parseCsvMappings(csv, {
        defaultSourceDomain: 'xxxx.com',
        defaultTargetDomain: 'yyyy.com'
      });

      expect(result.totalRowsParsed).toBe(4);
      expect(result.malformedRows).toHaveLength(0);
      expect(result.mappings['first.last@xxxx.com']).toBe('10001@yyyy.com');
      expect(result.mappings['david.miller@xxxx.com']).toBe('10002@yyyy.com');
      expect(result.mappings['eve.adams@xxxx.com']).toBe('10003@yyyy.com');
      expect(result.mappings['frank.clark@xxxx.com']).toBe('10004@yyyy.com');
    });

    it('rejects malformed rows (missing target column or missing @ domain without defaults)', () => {
      const hostileCsv = [
        'old_email,new_email',
        'valid.user@xxxx.com,99901@yyyy.com',
        'orphan_single_column_only@xxxx.com',
        'bare_source_no_domain,bare_target_no_domain',
        'missing_target_domain@xxxx.com,88888_no_domain'
      ].join('\n');

      const result = IdentityMappingService.parseCsvMappings(hostileCsv);
      expect(result.totalRowsParsed).toBe(1);
      expect(result.mappings['valid.user@xxxx.com']).toBe('99901@yyyy.com');
      expect(result.malformedRows).toHaveLength(3);
      expect(result.malformedRows[0].reason).toContain('Expected at least 2 columns');
      expect(result.malformedRows[1].reason).toContain('Missing email domain (@)');
      expect(result.malformedRows[2].reason).toContain('Missing email domain (@)');
    });

    it('detects DUPLICATE_SOURCE and DUPLICATE_TARGET collisions in CSV uploads', () => {
      const csvWithBothCollisions = [
        'source_email,target_email',
        'alice.smith@xxxx.com,849201@yyyy.com',
        'alice.smith@xxxx.com,849202@yyyy.com', // DUPLICATE_SOURCE
        'bob.jones@xxxx.com,849202@yyyy.com'    // DUPLICATE_TARGET (both alice and bob -> 849202@yyyy.com)
      ].join('\n');

      const result = IdentityMappingService.parseCsvMappings(csvWithBothCollisions);
      expect(result.collisions.length).toBeGreaterThanOrEqual(2);
      const sourceCollision = result.collisions.find(c => c.type === 'DUPLICATE_SOURCE');
      const targetCollision = result.collisions.find(c => c.type === 'DUPLICATE_TARGET');
      expect(sourceCollision).toBeDefined();
      expect(sourceCollision?.identity).toBe('alice.smith@xxxx.com');
      expect(targetCollision).toBeDefined();
      expect(targetCollision?.identity).toBe('849202@yyyy.com');
      expect(targetCollision?.conflictingIdentities).toContain('alice.smith@xxxx.com');
      expect(targetCollision?.conflictingIdentities).toContain('bob.jones@xxxx.com');
    });
  });

  describe('lookupTargetIdentity — Case-Insensitive & Prefix-Tolerant Resolution', () => {
    it('resolves mixed-case source owner strings against lowercase CSV keys', () => {
      const mapping = {
        'first.last@xxxx.com': '849201@yyyy.com'
      };

      expect(IdentityMappingService.lookupTargetIdentity('First.Last@XXXX.com', mapping)).toBe('849201@yyyy.com');
      expect(IdentityMappingService.lookupTargetIdentity('user:First.Last@XXXX.com', mapping)).toBe('849201@yyyy.com');
      expect(
        IdentityMappingService.lookupTargetIdentity(
          'principal://iam.googleapis.com/locations/global/workforcePools/okta-pool/subject/First.Last@XXXX.com',
          mapping
        )
      ).toBe('849201@yyyy.com');
    });
  });

  describe('generateMappingAuditReport', () => {
    it('flags UNMAPPED_WARNING when local-part format changes across users and TARGET_COLLISION on duplicate targets', () => {
      const service = new IdentityMappingService({
        sourceIdp: 'OKTA',
        targetIdp: 'GOOGLE_CLOUD_IDENTITY',
        explicitMappings: {
          'alice.smith@xxxx.com': '849201@yyyy.com',
          'bob.jones@xxxx.com': '849201@yyyy.com' // Intentional collision with Alice
        }
      });

      const report = service.generateMappingAuditReport(
        ['alice.smith@xxxx.com', 'bob.jones@xxxx.com', 'unmapped.user@xxxx.com'],
        new Set(['alice.smith@xxxx.com', 'bob.jones@xxxx.com'])
      );

      expect(report.summary.totalIdentities).toBe(3);
      expect(report.summary.csvOrExplicitMapped).toBe(2);
      expect(report.summary.unmappedCount).toBe(1);
      expect(report.summary.collisionCount).toBe(2); // Both Alice and Bob share target 849201@yyyy.com

      const unmappedRow = report.entries.find(e => e.sourceIdentity === 'unmapped.user@xxxx.com');
      expect(unmappedRow?.validationStatus).toBe('UNMAPPED_WARNING');

      const aliceRow = report.entries.find(e => e.sourceIdentity === 'alice.smith@xxxx.com');
      expect(aliceRow?.validationStatus).toBe('TARGET_COLLISION');
    });
  });

  describe('MigrationReporter.generateMarkdownSummary — Section 2b Identity Mapping Report', () => {
    it('includes Section 2b User Identity Mapping Report in Markdown output', () => {
      const mockReport: MigrationReport = {
        migrationId: 'test-csv-map-job',
        startTime: '2026-09-18T18:00:00.000Z',
        endTime: '2026-09-18T18:01:00.000Z',
        durationMs: 60000,
        sourceEnvironment: {
          projectId: 'src-proj',
          appLocation: 'global',
          collectionId: 'default_collection',
          appId: 'src-app'
        },
        targetEnvironment: {
          projectId: 'tgt-proj',
          appLocation: 'global',
          collectionId: 'default_collection',
          appId: 'tgt-app'
        },
        dryRun: true,
        summary: {
          totalDiscoveredAgents: 0,
          totalDiscoveredNotebooks: 1,
          totalMigratedAgents: 0,
          totalMigratedNotebooks: 1,
          totalSkipped: 0,
          totalFailed: 0
        },
        results: [
          {
            id: 'nb-1',
            displayName: 'Q3 Strategy Notebook',
            type: 'NOTEBOOK',
            originalOwner: 'alice.smith@xxxx.com',
            targetOwner: '849201@yyyy.com',
            status: 'DRY_RUN'
          }
        ],
        discoveredUsers: ['alice.smith@xxxx.com'],
        identityMapping: {
          'alice.smith@xxxx.com': '849201@yyyy.com'
        },
        logs: []
      };

      const mdContent = MigrationReporter.generateMarkdownSummary(mockReport);
      expect(mdContent).toContain('## 2b. User Identity Mapping Report (Source ID ➔ Destination ID)');
      expect(mdContent).toContain('`alice.smith@xxxx.com`');
      expect(mdContent).toContain('`849201@yyyy.com`');
      expect(mdContent).toContain('🔄 Mapped (`Old ➔ New`)');
    });
  });
});
