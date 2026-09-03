import { describe, it, expect } from 'vitest';
import { MigrationReporter } from '../src/services/reporter.js';
import { UserReportGenerator } from '../src/engines/userReportGenerator.js';
import { MigrationReport } from '../src/types/migration.js';

describe('MigrationReporter with Sources Audit', () => {
  const dummyReport: MigrationReport = {
    migrationId: 'test-sources-report-01',
    startTime: '2026-09-01T12:00:00Z',
    endTime: '2026-09-01T12:05:00Z',
    durationMs: 300000,
    dryRun: false,
    sourceEnvironment: { projectId: 'ancient-sandbox', appLocation: 'global', appId: 'ancient-app' },
    targetEnvironment: { projectId: 'target-sandbox', appLocation: 'global', appId: 'target-app' },
    summary: {
      totalDiscoveredAgents: 2,
      totalDiscoveredNotebooks: 1,
      totalDiscoveredSources: 3,
      totalMigratedAgents: 2,
      totalMigratedNotebooks: 1,
      totalMigratedSources: 2,
      totalFailedSources: 1,
      totalSkipped: 0,
      totalFailed: 0
    },
    results: [
      {
        id: 'nb-cosmere',
        displayName: 'Cosmere Universe Guide',
        type: 'NOTEBOOK',
        status: 'SUCCESS',
        originalOwner: 'admin@example.com',
        targetOwner: 'admin@example.com',
        targetId: 'nb-cosmere-target',
        details: {
          sourcesCount: 3,
          sourcesRestored: 2,
          sourcesFailed: 1,
          sources: [
            { title: 'The Way of Kings Wiki', type: 'URL', status: 'SUCCESS' },
            { title: 'Mistborn Characters.pdf', type: 'DOCUMENT', status: 'SUCCESS' },
            { title: 'Corrupt Map File.png', type: 'DOCUMENT', status: 'FAILED', error: '400 Bad Request: Unsupported format' }
          ]
        }
      }
    ],
    discoveredUsers: ['admin@example.com'],
    logs: []
  };

  it('should include source metrics in executive summary', () => {
    const md = MigrationReporter.generateMarkdownSummary(dummyReport);
    expect(md).toContain('| **Discovered Notebook Sources** | 3 |');
    expect(md).toContain('| **Successfully Migrated Sources** | 2 |');
    expect(md).toContain('| **Failed Notebook Sources** | 1 |');
  });

  it('should include sources columns in user reconciliation table', () => {
    const md = MigrationReporter.generateMarkdownSummary(dummyReport);
    expect(md).toContain('| Sources Restored | Sources Failed |');
    expect(md).toContain('| 2 | ⚠️ **1** |');
  });

  it('should include dedicated Section 5 for Notebook Sources Breakdown & Audit', () => {
    const md = MigrationReporter.generateMarkdownSummary(dummyReport);
    expect(md).toContain('## 5. Notebook Sources Breakdown & Integrity Audit (3 sources)');
    expect(md).toContain('| 📓 Cosmere Universe Guide | The Way of Kings Wiki | `URL` | ✅ SUCCESS | Indexed and ready in target notebook |');
    expect(md).toContain('| 📓 Cosmere Universe Guide | Corrupt Map File.png | `DOCUMENT` | ❌ FAILED | **Error:** 400 Bad Request: Unsupported format |');
  });

  it('should render source status in user handover bundle markdown and html', () => {
    const gen = new UserReportGenerator();
    const userMap = gen.groupReportByUser(dummyReport);
    const adminData = userMap.get('admin@example.com');

    expect(adminData).toBeDefined();
    
    // Markdown checklist
    const summaryMd = gen.generateMarkdownReport(adminData!);
    expect(summaryMd).toContain('**Sources Status:** 2 restored, ⚠️ **1 failed**');
    expect(summaryMd).toContain('✅ The Way of Kings Wiki `URL`');
    expect(summaryMd).toContain('❌ Corrupt Map File.png `DOCUMENT` *(Failed: 400 Bad Request: Unsupported format)*');

    // HTML checklist
    const htmlReport = gen.generateHtmlReport(adminData!);
    expect(htmlReport).toContain('📄 2 Sources Ready');
    expect(htmlReport).toContain('⚠️ 1 Failed');
    expect(htmlReport).toContain('View Restored Source Documents (3)');
  });
});
