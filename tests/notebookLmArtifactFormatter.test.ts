import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { NotebookLmArtifactFormatter } from '../src/services/notebookLmArtifactFormatter.js';
import { UserReportGenerator } from '../src/engines/userReportGenerator.js';
import { MigrationReport } from '../src/types/migration.js';

describe('NotebookLmArtifactFormatter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notebooklm-formatter-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('cleanArtifactFilename', () => {
    it('should strip "(Restored)" tags and avoid stuttering names', () => {
      const filename = NotebookLmArtifactFormatter.cleanArtifactFilename(
        'Trane Technologies (Restored)',
        'Trane Technologies - Q2 Strategic Blueprint',
        'pptx'
      );
      expect(filename).toBe('Trane Technologies - Q2 Strategic Blueprint.pptx');
      expect(filename).not.toContain('(Restored)');
      expect(filename).not.toContain('Trane Technologies - Trane Technologies');
    });

    it('should strip "(Copy)" tags and trailing copy markers', () => {
      const filename = NotebookLmArtifactFormatter.cleanArtifactFilename(
        'Cosmere Universe (Copy)',
        'Guide to Roshar (Restored)',
        '.docx'
      );
      expect(filename).toBe('Cosmere Universe - Guide to Roshar.docx');
    });

    it('should format clean base name when artifact title is identical to notebook', () => {
      const filename = NotebookLmArtifactFormatter.cleanArtifactFilename(
        'Machine Learning Handbook',
        'Machine Learning Handbook',
        'docx'
      );
      expect(filename).toBe('Machine Learning Handbook.docx');
    });

    it('should sanitize forbidden filesystem characters and normalize spaces', () => {
      const filename = NotebookLmArtifactFormatter.cleanArtifactFilename(
        'Project: Alpha / Beta *',
        'Executive <Summary> ?',
        'html'
      );
      expect(filename).toBe('Project Alpha Beta - Executive Summary.html');
      expect(filename).not.toMatch(/[:\/*?<>|]/);
    });
  });

  describe('cleanNotebookLmMarkdown', () => {
    it('should strip artificial debug headers like **Artifact Type:**', () => {
      const raw = `**Artifact Type:** \`CANVAS_DOCUMENT\`
---
Here is the real report content.`;
      const cleaned = NotebookLmArtifactFormatter.cleanNotebookLmMarkdown('Sales Report', raw);
      expect(cleaned).not.toContain('**Artifact Type:**');
      expect(cleaned).not.toContain('CANVAS_DOCUMENT');
      expect(cleaned).toContain('# Sales Report');
      expect(cleaned).toContain('Here is the real report content.');
    });

    it('should preserve existing heading 1 if already present', () => {
      const raw = `# Existing Title\n\nSome paragraphs here.`;
      const cleaned = NotebookLmArtifactFormatter.cleanNotebookLmMarkdown('Fallback Title', raw);
      expect(cleaned).toBe('# Existing Title\n\nSome paragraphs here.\n');
    });
  });

  describe('parseInlineMarkdown', () => {
    it('should parse bold, italic, inline code, and citations into TextRun objects', () => {
      const text = 'This is **bold**, this is *italic*, this is `code`, and citation [1].';
      const runs = NotebookLmArtifactFormatter.parseInlineMarkdown(text);
      expect(runs.length).toBeGreaterThan(0);
      
      const boldRun = runs.find(r => (r as any).root?.[1]?.[0]?.root?.[0] === 'bold' || JSON.stringify(r).includes('bold'));
      expect(boldRun).toBeDefined();
    });
  });

  describe('generateDocxDocument', () => {
    it('should generate a valid substantive Microsoft Word document with tables and lists', async () => {
      const outputPath = path.join(tmpDir, 'Test_Document.docx');
      const markdown = `
# Executive Strategy 2026

This is an introductory paragraph explaining strategic pillars with **bold emphasis** and citations [Roshar: Surgebinding].

## Key Objectives

- Objective Alpha: Modernize data architecture
- Objective Beta: Accelerate AI adoption
- Objective Gamma: Streamline migrations

## Financial Projections

| Quarter | Target Revenue | Growth Rate |
|---|---|---|
| Q1 2026 | $12.5M | +18% |
| Q2 2026 | $15.2M | +22% |
| Q3 2026 | $18.0M | +25% |

> "Excellence is not an act, but a habit."
`;

      await NotebookLmArtifactFormatter.generateDocxDocument(
        'Executive Strategy 2026',
        'Strategic Blueprint',
        'Enterprise Strategy',
        markdown,
        outputPath
      );

      expect(fs.existsSync(outputPath)).toBe(true);
      const stat = fs.statSync(outputPath);
      expect(stat.size).toBeGreaterThan(1500); // Substantive docx package
    });
  });

  describe('generatePptxPresentation', () => {
    it('should generate a valid 16:9 Microsoft PowerPoint presentation with slides and notes', async () => {
      const outputPath = path.join(tmpDir, 'Test_Presentation.pptx');
      const markdown = `
## Slide 1: Welcome to the Future of Work
- Introduction to Gemini Enterprise capabilities
- Accelerating productivity across teams

---

## Slide 2: Enterprise Architecture Overview
- **Zero-Trust Security**: Unified IAM and Cloud Identity
- **Federated Search**: Direct grounding across Google Workspace and Microsoft 365
- **High Concurrency**: Multi-user distributed migration

Notes: These are presenter notes explaining the architectural boundaries.
`;

      await NotebookLmArtifactFormatter.generatePptxPresentation(
        'Future of Work Deck',
        'Enterprise AI Transformation',
        markdown,
        outputPath
      );

      expect(fs.existsSync(outputPath)).toBe(true);
      const stat = fs.statSync(outputPath);
      expect(stat.size).toBeGreaterThan(1500); // Substantive pptx package
    });
  });

  describe('renderDocumentHtml & renderSlideDeckPresentation', () => {
    it('should generate clean standalone HTML document viewer', () => {
      const html = NotebookLmArtifactFormatter.renderDocumentHtml(
        'Q2 Report',
        'Briefing Doc',
        'Analytics Notebook',
        '# Executive Brief\n\nSummary text.'
      );
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Q2 Report');
      expect(html).toContain('Analytics Notebook');
    });

    it('should generate interactive 16:9 presentation carousel HTML', () => {
      const html = NotebookLmArtifactFormatter.renderSlideDeckPresentation(
        'Sales Pitch',
        'Pitch Notebook',
        '## Slide 1\n\nHello\n\n---\n\n## Slide 2\n\nWorld'
      );
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('NOTEBOOKLM PRESENTATION');
      expect(html).toContain('Slide 1 of 2');
    });
  });
});

describe('UserReportGenerator Bulk Email Dispatching', () => {
  let tmpReportsDir: string;

  beforeEach(() => {
    tmpReportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-report-bulk-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpReportsDir, { recursive: true, force: true });
    } catch {}
  });

  const dummyReport: MigrationReport = {
    migrationId: 'test-bulk-report-01',
    startTime: '2026-09-02T12:00:00Z',
    endTime: '2026-09-02T12:05:00Z',
    durationMs: 300000,
    dryRun: false,
    sourceEnvironment: { projectId: 'src-project', appLocation: 'global', appId: 'src-app' },
    targetEnvironment: { projectId: 'tgt-project', appLocation: 'global', appId: 'tgt-app' },
    summary: {
      totalDiscoveredAgents: 1,
      totalDiscoveredNotebooks: 1,
      totalMigratedAgents: 1,
      totalMigratedNotebooks: 1,
      totalSkipped: 0,
      totalFailed: 0
    },
    results: [
      {
        id: 'nb-1',
        displayName: 'Strategy Notebook',
        type: 'NOTEBOOK',
        status: 'SUCCESS',
        originalOwner: 'user1@company.com',
        targetOwner: 'user1@company.com',
        targetId: 'nb-1-target',
        details: {
          artifacts: [
            {
              title: 'Strategic Briefing',
              type: 'Briefing Doc',
              content: '# Strategic Briefing\n\nSubstantive content text for testing handover.'
            }
          ]
        }
      },
      {
        id: 'nb-2',
        displayName: 'Technical Architecture',
        type: 'NOTEBOOK',
        status: 'SUCCESS',
        originalOwner: 'user2@company.com',
        targetOwner: 'user2@company.com',
        targetId: 'nb-2-target',
        details: {
          artifacts: [
            {
              title: 'Tech Presentation',
              type: 'Slide Deck',
              content: '## Slide 1: Architecture\n- Scalable architecture overview.'
            }
          ]
        }
      }
    ],
    discoveredUsers: ['user1@company.com', 'user2@company.com'],
    logs: []
  };

  it('should dispatch bulk emails in safe staging mode and redirect all recipients', async () => {
    const generator = new UserReportGenerator(tmpReportsDir);

    // Mock sendUserEmail to simulate successful dispatch without calling real network
    const sendSpy = vi.spyOn(generator, 'sendUserEmail').mockImplementation(async (opts) => {
      return {
        success: true,
        mode: 'GMAIL_API',
        message: `Email successfully sent via Gmail API to ${opts.overrideRecipientEmail || opts.userEmail}`,
        messageId: `msg_${Math.random().toString(36).substring(7)}`,
        attachmentsCount: 1,
        emlPath: path.join(tmpReportsDir, 'test.eml')
      };
    });

    const bulkRes = await generator.sendBulkUserEmails({
      overrideRecipientEmail: 'staging-auditor@company.com',
      pacingDelayMs: 10 // small pacing delay for testing
    }, dummyReport);

    expect(bulkRes.success).toBe(true);
    expect(bulkRes.total).toBe(2);
    expect(bulkRes.sent).toBe(2);
    expect(bulkRes.failed).toBe(0);
    expect(bulkRes.results.length).toBe(2);

    // Verify all recipients were redirected to the safe staging address
    for (const r of bulkRes.results) {
      expect(r.recipient).toBe('staging-auditor@company.com');
      expect(r.success).toBe(true);
      expect(r.messageId).toBeDefined();
    }

    expect(sendSpy).toHaveBeenCalledTimes(2);
    sendSpy.mockRestore();
  });

  it('should support filtering to a subset of users in bulk dispatch', async () => {
    const generator = new UserReportGenerator(tmpReportsDir);

    const sendSpy = vi.spyOn(generator, 'sendUserEmail').mockImplementation(async (opts) => {
      return {
        success: true,
        mode: 'GMAIL_API',
        message: `Sent to ${opts.userEmail}`,
        attachmentsCount: 1
      };
    });

    const bulkRes = await generator.sendBulkUserEmails({
      userEmails: ['user1@company.com'],
      pacingDelayMs: 0
    }, dummyReport);

    expect(bulkRes.total).toBe(1);
    expect(bulkRes.sent).toBe(1);
    expect(bulkRes.results[0].userEmail).toBe('user1@company.com');

    expect(sendSpy).toHaveBeenCalledTimes(1);
    sendSpy.mockRestore();
  });

  it('should preserve existing substantive PowerPoint export without overwriting with fallback', async () => {
    const dummyPath = path.join(tmpReportsDir, 'Substantive_Deck.pptx');
    // Create a 600 KB dummy buffer simulating an authentic downloaded Google PPTX
    const largeBuf = Buffer.alloc(600 * 1024, 'A');
    fs.writeFileSync(dummyPath, largeBuf);

    // Call generatePptxPresentation without a signed URL (which normally triggers pptxgenjs fallback)
    await NotebookLmArtifactFormatter.generatePptxPresentation(
      'Substantive Presentation',
      'Test Notebook',
      '# Some fallback markdown',
      dummyPath
    );

    // Verify the file was preserved and not replaced by tiny fallback (~50 KB)
    const stat = fs.statSync(dummyPath);
    expect(stat.size).toBe(600 * 1024);
  });

  it('should bin-pack large attachments into multi-part emails when size exceeds 14.5 MB', async () => {
    const generator = new UserReportGenerator(tmpReportsDir);
    const userEmail = 'user1@company.com';
    const userFolder = path.join(tmpReportsDir, userEmail);
    const nbArtFolder = path.join(userFolder, 'notebook_artifacts');
    fs.mkdirSync(nbArtFolder, { recursive: true });

    // Create 2 large files (10 MB each, total 20 MB > 14.5 MB bucket limit)
    fs.writeFileSync(path.join(nbArtFolder, 'Large_Presentation_1.pptx'), Buffer.alloc(10 * 1024 * 1024, 'X'));
    fs.writeFileSync(path.join(nbArtFolder, 'Large_Presentation_2.pptx'), Buffer.alloc(10 * 1024 * 1024, 'Y'));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (typeof url === 'string' && url.includes('gmail.googleapis.com')) {
        return {
          ok: true,
          json: async () => ({ id: `msg_${Math.random().toString(36).substring(7)}`, threadId: 'thread_12345' })
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    const result = await generator.sendUserEmail({
      userEmail,
      senderEmail: 'admin@company.com',
      accessToken: 'mock-gmail-token',
      zipAttachments: false
    }, dummyReport);

    expect(result.success).toBe(true);
    expect(result.partsSent).toBe(2);
    expect(result.parts?.length).toBe(2);
    expect(result.attachmentsCount).toBe(3);
    expect(result.threadId).toBe('thread_12345');
    expect(fs.existsSync(path.join(userFolder, 'MIGRATION_CHECKLIST_Part1.eml'))).toBe(true);
    expect(fs.existsSync(path.join(userFolder, 'MIGRATION_CHECKLIST_Part2.eml'))).toBe(true);

    fetchSpy.mockRestore();
  });

  it('should deduplicate companion slide PDFs and thread follow-up parts with Re: subject and In-Reply-To headers', async () => {
    const generator = new UserReportGenerator(tmpReportsDir);
    const userEmail = 'user2@company.com';
    const userFolder = path.join(tmpReportsDir, userEmail);
    const nbArtFolder = path.join(userFolder, 'notebook_artifacts');
    fs.mkdirSync(nbArtFolder, { recursive: true });

    // 1. PPTX presentation (10 MB)
    fs.writeFileSync(path.join(nbArtFolder, 'Architecture_Deck.pptx'), Buffer.alloc(10 * 1024 * 1024, 'A'));
    // 2. Companion PDF of the same deck (10 MB) - SHOULD BE EXCLUDED
    fs.writeFileSync(path.join(nbArtFolder, 'Architecture_Deck.pdf'), Buffer.alloc(10 * 1024 * 1024, 'B'));
    // 3. Second PPTX presentation (8 MB) -> triggers Part 2
    fs.writeFileSync(path.join(nbArtFolder, 'Executive_Strategy.pptx'), Buffer.alloc(8 * 1024 * 1024, 'C'));
    // 4. Standalone PDF without matching PPTX -> SHOULD BE INCLUDED
    fs.writeFileSync(path.join(nbArtFolder, 'Whitepaper_Standalone.pdf'), Buffer.alloc(100 * 1024, 'D'));

    const sentThreadIds: (string | undefined)[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
      if (typeof url === 'string' && url.includes('gmail.googleapis.com')) {
        const bodyObj = JSON.parse(init?.body || '{}');
        sentThreadIds.push(bodyObj.threadId);
        return {
          ok: true,
          json: async () => ({ id: `msg_${Math.random().toString(36).substring(7)}`, threadId: 'thread_unified_999' })
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    const result = await generator.sendUserEmail({
      userEmail,
      senderEmail: 'admin@company.com',
      accessToken: 'mock-gmail-token',
      zipAttachments: false
    }, dummyReport);

    expect(result.success).toBe(true);
    expect(result.partsSent).toBe(2);
    // Verified: Architecture_Deck.pdf was excluded! Included: Architecture_Deck.pptx, Executive_Strategy.pptx, Whitepaper_Standalone.pdf + synthesized Tech Presentation.pptx
    const allFilenames = result.parts?.flatMap(p => p.filenames) || [];
    expect(allFilenames).not.toContain('Architecture_Deck.pdf');
    expect(allFilenames).toContain('Architecture_Deck.pptx');
    expect(allFilenames).toContain('Executive_Strategy.pptx');
    expect(allFilenames).toContain('Whitepaper_Standalone.pdf');

    // Verify .eml contents for threading safely without dumping huge attachment blobs
    const part1Eml = fs.readFileSync(path.join(userFolder, 'MIGRATION_CHECKLIST_Part1.eml'), 'utf8');
    const part2Eml = fs.readFileSync(path.join(userFolder, 'MIGRATION_CHECKLIST_Part2.eml'), 'utf8');

    const part1Headers = part1Eml.split(/\r?\n\r?\n/)[0];
    const part2Headers = part2Eml.split(/\r?\n\r?\n/)[0];

    expect(part1Headers.includes('Subject:')).toBe(true);
    expect(/Subject:.*Re(=3A|:)/i.test(part2Headers)).toBe(true);
    expect(part2Headers.includes('In-Reply-To: <migration-')).toBe(true);
    expect(part2Headers.includes('References: <migration-')).toBe(true);
    expect(part2Eml.includes('Part 2 of 2') || part2Eml.includes('PART 2 OF 2')).toBe(true);

    // Verify Gmail API postBody for Part 2 included threadId
    expect(sentThreadIds.length).toBe(2);
    expect(sentThreadIds[1]).toBe('thread_unified_999');

    fetchSpy.mockRestore();
  });

  it('should package attachments into a single NotebookLM_Artifacts.zip when zipAttachments is enabled', async () => {
    const generator = new UserReportGenerator(tmpReportsDir);
    const userEmail = 'user-zip-single@company.com';
    const userFolder = path.join(tmpReportsDir, userEmail);
    const nbArtFolder = path.join(userFolder, 'notebook_artifacts');
    fs.mkdirSync(nbArtFolder, { recursive: true });

    // 2 small presentation and image files (well under 14.5 MB)
    fs.writeFileSync(path.join(nbArtFolder, 'Deck_1.pptx'), Buffer.alloc(100 * 1024, 'A'));
    fs.writeFileSync(path.join(nbArtFolder, 'Infographic_1.jpg'), Buffer.alloc(50 * 1024, 'B'));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (typeof url === 'string' && url.includes('gmail.googleapis.com')) {
        return {
          ok: true,
          json: async () => ({ id: `msg_zip_single`, threadId: 'thread_zip_1' })
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    const result = await generator.sendUserEmail({
      userEmail,
      senderEmail: 'admin@company.com',
      accessToken: 'mock-gmail-token',
      zipAttachments: true,
      optimizeMedia: false
    }, dummyReport);

    expect(result.success).toBe(true);
    expect(result.partsSent).toBe(1);
    expect(result.parts?.[0]?.filenames).toEqual(['NotebookLM_Artifacts.zip']);
    expect(fs.existsSync(path.join(userFolder, 'NotebookLM_Artifacts.zip'))).toBe(true);

    const zipStat = fs.statSync(path.join(userFolder, 'NotebookLM_Artifacts.zip'));
    expect(zipStat.size).toBeGreaterThan(100);

    // Verify .eml mentions archive
    const emlContent = fs.readFileSync(path.join(userFolder, 'MIGRATION_CHECKLIST.eml'), 'utf8');
    expect(emlContent.includes('NotebookLM_Artifacts.zip') || emlContent.includes('NotebookLM Artifacts Archive')).toBe(true);

    fetchSpy.mockRestore();
  });

  it('should partition into multi-part zip archives (Part1.zip, Part2.zip) when zipped attachments exceed safe limit', async () => {
    const generator = new UserReportGenerator(tmpReportsDir);
    const userEmail = 'user-zip-multi@company.com';
    const userFolder = path.join(tmpReportsDir, userEmail);
    const nbArtFolder = path.join(userFolder, 'notebook_artifacts');
    fs.mkdirSync(nbArtFolder, { recursive: true });

    // Two 8 MB random uncompressible files: Combined zip size ~16 MB exceeds 14.5 MB limit
    const crypto = await import('crypto');
    fs.writeFileSync(path.join(nbArtFolder, 'Heavy_Deck_A.pptx'), crypto.randomBytes(8 * 1024 * 1024));
    fs.writeFileSync(path.join(nbArtFolder, 'Heavy_Deck_B.pptx'), crypto.randomBytes(8 * 1024 * 1024));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (typeof url === 'string' && url.includes('gmail.googleapis.com')) {
        return {
          ok: true,
          json: async () => ({ id: `msg_${Math.random().toString(36).substring(7)}`, threadId: 'thread_zip_multi' })
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    const result = await generator.sendUserEmail({
      userEmail,
      senderEmail: 'admin@company.com',
      accessToken: 'mock-gmail-token',
      zipAttachments: true,
      optimizeMedia: false
    }, dummyReport);

    expect(result.success).toBe(true);
    expect(result.partsSent).toBe(2);
    expect(result.parts?.[0]?.filenames).toEqual(['NotebookLM_Artifacts_Part1.zip']);
    expect(result.parts?.[1]?.filenames).toEqual(['NotebookLM_Artifacts_Part2.zip']);
    expect(fs.existsSync(path.join(userFolder, 'NotebookLM_Artifacts_Part1.zip'))).toBe(true);
    expect(fs.existsSync(path.join(userFolder, 'NotebookLM_Artifacts_Part2.zip'))).toBe(true);

    fetchSpy.mockRestore();
  });

  describe('Interactive Apps & Media Optimization', () => {
    it('should detect if ffmpeg is available in execution environment', () => {
      const available = UserReportGenerator.isFfmpegAvailable();
      expect(typeof available).toBe('boolean');
    });

    it('should extract structured app data from encoded HTML data-app-data attribute', () => {
      const mockHtml = `<app-root data-app-data="{&quot;quiz&quot;:[{&quot;question&quot;:&quot;What is Roshar?&quot;,&quot;answerOptions&quot;:[{&quot;text&quot;:&quot;A planet&quot;,&quot;isCorrect&quot;:true}]}]}"></app-root>`;
      const appData = NotebookLmArtifactFormatter.extractAppData({ content: mockHtml });
      expect(appData).toBeDefined();
      expect(appData?.quiz?.length).toBe(1);
      expect(appData?.quiz?.[0]?.question).toBe('What is Roshar?');
      expect(appData?.quiz?.[0]?.answerOptions?.[0]?.isCorrect).toBe(true);
    });

    it('should render standalone zero-dependency interactive quiz HTML', () => {
      const quizQuestions = [
        {
          question: 'What is Surgebinding?',
          hint: 'Magic system',
          answerOptions: [
            { text: 'A magic system utilizing Stormlight', isCorrect: true, rationale: 'Surgebinding uses Stormlight.' },
            { text: 'A type of cuisine', isCorrect: false }
          ]
        }
      ];
      const html = NotebookLmArtifactFormatter.renderInteractiveQuizHtml('Stormlight Quiz', 'Roshar Notebook', quizQuestions);
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Stormlight Quiz');
      expect(html).toContain('Surgebinding');
      expect(html).toContain('renderQuestion');
      expect(html).not.toContain('NotebookLMThemeProvider');
    });

    it('should render standalone zero-dependency interactive 3D flashcards HTML', () => {
      const flashcards = [
        { f: 'Highstorm direction', b: 'East to West', c: 1 },
        { f: 'Spren bond', b: 'Nahel Bond', c: 2 }
      ];
      const html = NotebookLmArtifactFormatter.renderInteractiveFlashcardsHtml('Roshar Flashcards', 'Roshar Notebook', flashcards);
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Roshar Flashcards');
      expect(html).toContain('Highstorm direction');
      expect(html).toContain('East to West');
      expect(html).toContain('card-flipper');
      expect(html).not.toContain('NotebookLMThemeProvider');
    });

    it('should inject window.notebookAppApi polyfill and strip CSP from raw Angular bundles', () => {
      const rawBundle = `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none';"></head><body><app-root></app-root></body></html>`;
      const polyfilled = NotebookLmArtifactFormatter.injectNotebookAppApiPolyfill(rawBundle);
      expect(polyfilled).not.toContain('Content-Security-Policy');
      expect(polyfilled).toContain('window.notebookAppApi');
      expect(polyfilled).toContain('addThemeChangeListener');
    });

    it('should preserve interactive HTML apps alongside companion DOCX files in sendUserEmail', async () => {
      const generator = new UserReportGenerator(tmpReportsDir);
      const userEmail = 'user1@company.com';

      const quizReport: MigrationReport = {
        ...dummyReport,
        results: [
          {
            id: 'nb-quiz',
            displayName: 'Roshar Study',
            type: 'NOTEBOOK',
            status: 'SUCCESS',
            originalOwner: userEmail,
            targetOwner: userEmail,
            targetId: 'nb-quiz-target',
            details: {
              artifacts: [
                {
                  title: 'Stormlight Quiz',
                  type: 'ARTIFACT_TYPE_APP',
                  rawArtifact: {
                    type: 'ARTIFACT_TYPE_APP',
                    app: {
                      appData: JSON.stringify({
                        quiz: [
                          {
                            question: 'What is Stormlight?',
                            answerOptions: [{ text: 'Investiture', isCorrect: true }]
                          }
                        ]
                      })
                    }
                  }
                },
                {
                  title: 'Executive Briefing',
                  type: 'Briefing Doc',
                  content: 'Substantive briefing document content for static testing.'
                }
              ]
            }
          }
        ]
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        if (typeof url === 'string' && url.includes('gmail.googleapis.com')) {
          return {
            ok: true,
            json: async () => ({ id: `msg_app_test`, threadId: 'thread_app_test' })
          } as any;
        }
        return { ok: false, status: 404 } as any;
      });

      const result = await generator.sendUserEmail({
        userEmail,
        senderEmail: 'admin@company.com',
        accessToken: 'mock-gmail-token',
        zipAttachments: false,
        optimizeMedia: false
      }, quizReport);

      expect(result.success).toBe(true);
      const attachedFilenames = result.parts?.[0]?.filenames || [];

      // Stormlight Quiz.html must be kept because it is an interactive app
      expect(attachedFilenames).toContain('Roshar Study - Stormlight Quiz.html');
      expect(attachedFilenames).toContain('Roshar Study - Stormlight Quiz.docx');

      // Executive Briefing.html must be deduplicated because it is a static document companion
      expect(attachedFilenames).toContain('Roshar Study - Executive Briefing.docx');
      expect(attachedFilenames).not.toContain('Roshar Study - Executive Briefing.html');

      fetchSpy.mockRestore();
    });
  });
});


