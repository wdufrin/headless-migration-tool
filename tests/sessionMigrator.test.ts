import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SessionMigrator,
  validateSessionResourceName,
  validateSessionFileId,
  sanitizeSessionUploadFileName,
  parseStreamAssistChunks
} from '../src/engines/sessionMigrator.js';
import { SecurityValidationError } from '../src/security/validator.js';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import { ValidatedMigrationConfig } from '../src/config/configSchema.js';

describe('SessionMigrator Engine (Fix 2.5)', () => {
  const dummyAuth = new GcpAuthService({ staticToken: 'test-token' });
  const mockConfig: ValidatedMigrationConfig = {
    source: {
      projectId: 'source-corp',
      appLocation: 'global',
      appId: 'source-engine'
    },
    target: {
      projectId: 'target-corp',
      appLocation: 'global',
      appId: 'target-engine'
    },
    options: {
      dryRun: false,
      concurrency: 1
    }
  } as ValidatedMigrationConfig;

  const migrator = new SessionMigrator(mockConfig, dummyAuth);

  // `getAccessToken(userEmail)` takes the DWD impersonation path and ignores
  // `staticToken`. Without this stub the test only passed when a real
  // ./sa-dwd-key.json happened to be present, and it performed a live token mint
  // against oauth2.googleapis.com. Stub the boundary explicitly.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should extract text while preserving thought reasoning and citations', () => {
    const ansData = {
      replies: [
        {
          groundedContent: {
            content: {
              thought: true,
              text: 'Analyzing corporate travel policy document'
            }
          }
        },
        {
          groundedContent: {
            content: {
              text: 'According to [[section:travel-policy-2026.pdf#p4]], meals are capped at $75/day.'
            }
          }
        }
      ]
    };

    const extracted = (migrator as any).extractTextFromAnswer(ansData);
    expect(extracted).toContain('💭 *Reasoning:* Analyzing corporate travel policy document');
    expect(extracted).toContain('[[section:travel-policy-2026.pdf#p4]]');
  });

  it('should hydrate turns cleanly into query.text without setting turn.answer to an invalid plain text resource name', async () => {
    let capturedPayload: any = null;

    vi.spyOn(dummyAuth, 'getAccessToken').mockResolvedValue('stub-access-token');

    const originalFetch = global.fetch;
    const unexpectedRequests: string[] = [];
    global.fetch = async (url: any, init: any) => {
      if (typeof url === 'string' && url.includes('/sessions')) {
        if (init?.method === 'POST') {
          capturedPayload = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({ name: 'projects/target-corp/locations/global/collections/default_collection/engines/target-engine/sessions/sess-123' })
          } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: [] })
        } as any;
      }
      unexpectedRequests.push(String(url));
      throw new Error(`Unexpected outbound request in test: ${url}`);
    };

    try {
      const sourceSession = {
        name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-old',
        displayName: 'Travel Reimbursement Help',
        userPseudoId: 'user:alice@source.com',
        turns: [
          {
            query: { text: 'What is the daily meal limit?' },
            answer: 'The daily meal limit is $75.'
          }
        ]
      };

      await migrator.migrateSession(sourceSession, 'alice@target.com');

      expect(capturedPayload).toBeDefined();
      expect(capturedPayload.turns).toHaveLength(1);
      // Query text contains the user's prompt and the response
      expect(capturedPayload.turns[0].query.text).toContain('What is the daily meal limit?');
      expect(capturedPayload.turns[0].query.text).toContain('Gemini Response');
      expect(capturedPayload.turns[0].query.text).toContain('The daily meal limit is $75.');
      // Turn answer must NOT be set to raw text (which causes frontend 404s when treated as resource URI)
      expect(capturedPayload.turns[0].answer).toBeUndefined();
      // Hermeticity assertion: the engine must not reach anything but the stub.
      expect(unexpectedRequests).toEqual([]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should retrieve and cache full session details with includeAnswerDetails=true via getSession', async () => {
    vi.spyOn(dummyAuth, 'getAccessToken').mockResolvedValue('stub-access-token');

    let fetchCount = 0;
    let fetchedUrl = '';
    const originalFetch = global.fetch;

    const mockHydratedSession = {
      name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-abc',
      displayName: 'Strategy Planning',
      turns: [
        {
          query: { text: 'What is our Q3 goal?' },
          detailedAssistAnswer: {
            name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-abc/assistAnswers/ans-123',
            replies: [
              {
                groundedContent: {
                  content: { text: 'The Q3 goal is 20% growth.' }
                }
              }
            ]
          }
        }
      ]
    };

    global.fetch = async (url: any) => {
      fetchCount++;
      fetchedUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => mockHydratedSession
      } as any;
    };

    try {
      const sessName = 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-abc';
      const sessionFirst = await migrator.getSession(sessName, 'alice@source.com');

      expect(fetchCount).toBe(1);
      expect(fetchedUrl).toContain('includeAnswerDetails=true');
      expect(sessionFirst.displayName).toBe('Strategy Planning');

      // Second getSession call for same session must hit cache
      const sessionSecond = await migrator.getSession(sessName, 'alice@source.com');
      expect(fetchCount).toBe(1); // Cache hit, no additional network call
      expect(sessionSecond.name).toBe(sessName);

      // getAnswer for an answer belonging to that session must resolve from the session cache
      const ansData = await migrator.getAnswer(
        'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-abc/assistAnswers/ans-123',
        'alice@source.com'
      );
      expect(fetchCount).toBe(1); // Resolved from cache, zero additional network calls
      expect(ansData).toBeDefined();
      expect(ansData.replies[0].groundedContent.content.text).toBe('The Q3 goal is 20% growth.');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should properly pair and preserve assistant response when turns are split into query-only and companion turns', async () => {
    let capturedPayload: any = null;
    vi.spyOn(dummyAuth, 'getAccessToken').mockResolvedValue('stub-access-token');

    const originalFetch = global.fetch;
    global.fetch = async (url: any, init: any) => {
      if (typeof url === 'string' && url.includes('/sessions')) {
        if (init?.method === 'POST') {
          capturedPayload = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({ name: 'projects/target-corp/locations/global/collections/default_collection/engines/target-engine/sessions/sess-created' })
          } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: [] })
        } as any;
      }
      throw new Error(`Unexpected call to ${url}`);
    };

    try {
      // Discovery Engine multi-turn structure: turn 0 has query only, companion turn 1 has query + detailedAssistAnswer
      const sourceSession = {
        name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-split',
        displayName: 'Quantum Computing Briefing',
        userPseudoId: 'alice@source.com',
        turns: [
          {
            query: { text: 'Explain quantum computing principles.' }
          },
          {
            query: { text: 'Explain quantum computing principles.' },
            detailedAssistAnswer: {
              replies: [
                {
                  groundedContent: {
                    content: { text: 'Quantum computing harnesses superposition and entanglement.' }
                  }
                }
              ]
            }
          }
        ]
      };

      await migrator.migrateSession(sourceSession, 'alice@target.com');

      expect(capturedPayload).toBeDefined();
      // Turns must be deduplicated to 1 combined turn
      expect(capturedPayload.turns).toHaveLength(1);
      const turnText = capturedPayload.turns[0].query.text;
      expect(turnText).toContain('Explain quantum computing principles.');
      expect(turnText).toContain('Quantum computing harnesses superposition and entanglement.');
      // Must NOT contain the fallback archived dialogue record placeholder
      expect(turnText).not.toContain('Archived Dialogue Record');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should filter sessions by user_pseudo_id and request full view in listSourceSessions', async () => {
    vi.spyOn(dummyAuth, 'getAccessToken').mockResolvedValue('stub-access-token');

    let requestedUrls: string[] = [];
    const originalFetch = global.fetch;

    global.fetch = async (url: any) => {
      requestedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessions: [
            {
              name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-user1',
              displayName: 'User 1 Session',
              userPseudoId: 'alice@company.com'
            }
          ]
        })
      } as any;
    };

    try {
      const sessions = await migrator.listSourceSessions(['alice@company.com']);

      expect(sessions).toHaveLength(1);
      expect(requestedUrls).toHaveLength(1);
      const calledUrl = requestedUrls[0];
      expect(calledUrl).toContain('filter=user_pseudo_id%3D%22alice%40company.com%22');
      expect(calledUrl).toContain('view=SESSION_VIEW_FULL');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should recognize existing target session by source-session-id label and skip duplicate creation', async () => {
    vi.spyOn(dummyAuth, 'getAccessToken').mockResolvedValue('stub-access-token');

    let postCalled = false;
    const originalFetch = global.fetch;

    global.fetch = async (url: any, init: any) => {
      if (typeof url === 'string' && url.includes('/sessions')) {
        if (init?.method === 'POST') {
          postCalled = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ name: 'projects/target-corp/.../sessions/sess-new' })
          } as any;
        }
        // Return existing target session with matching source-session-id label
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sessions: [
              {
                name: 'projects/target-corp/locations/global/collections/default_collection/engines/target-engine/sessions/sess-already-there',
                displayName: 'Restored Session',
                labels: ['source-session-id:sess-existing-id']
              }
            ]
          })
        } as any;
      }
      throw new Error(`Unexpected call to ${url}`);
    };

    try {
      const sourceSession = {
        name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-existing-id',
        displayName: 'Restored Session',
        userPseudoId: 'alice@source.com',
        turns: [{ query: { text: 'Hello' }, answer: 'Hi there' }]
      };

      const result = await migrator.migrateSession(sourceSession, 'alice@target.com');

      expect(postCalled).toBe(false);
      expect(result.name).toContain('sess-already-there');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should throw descriptive error when target session creation fails with non-200 status', async () => {
    vi.spyOn(dummyAuth, 'getAccessToken').mockResolvedValue('stub-access-token');

    const originalFetch = global.fetch;
    global.fetch = async (url: any, init: any) => {
      if (typeof url === 'string' && url.includes('/sessions')) {
        if (init?.method === 'POST') {
          return {
            ok: false,
            status: 403,
            text: async () => 'Permission denied on target engine'
          } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: [] })
        } as any;
      }
      throw new Error(`Unexpected call to ${url}`);
    };

    try {
      const sourceSession = {
        name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-err',
        displayName: 'Error Chat',
        userPseudoId: 'alice@source.com',
        turns: [{ query: { text: 'Hello' }, answer: 'Hi' }]
      };

      await expect(migrator.migrateSession(sourceSession, 'alice@target.com')).rejects.toThrow(
        /Failed to create session in target \(403\): Permission denied on target engine/
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('SessionMigrator Customer Chat Upgrades & Adversarial Security', () => {
  const dummyAuth = new GcpAuthService({ staticToken: 'test-token' });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildConfig(overrides: Partial<ValidatedMigrationConfig> = {}): ValidatedMigrationConfig {
    return {
      source: {
        projectId: 'source-corp',
        appLocation: 'global',
        collectionId: 'default_collection',
        appId: 'source-engine'
      },
      target: {
        projectId: 'target-corp',
        appLocation: 'us',
        collectionId: 'default_collection',
        appId: 'target-engine'
      },
      identityMapping: {
        'alice@source.com': 'alice@target.com',
        'bob@source.com': 'bob@target.com'
      },
      datastoreMapping: {
        'src-ds-people': 'tgt-ds-people',
        'src-ds-docs': 'tgt-ds-docs'
      },
      options: {
        dryRun: false,
        concurrency: 1,
        migrateSessionFiles: true
      },
      ...overrides
    } as ValidatedMigrationConfig;
  }

  it('rejects hostile session resource names and fileIds with SecurityValidationError', async () => {
    const migrator = new SessionMigrator(buildConfig(), dummyAuth);

    // Malformed / SSRF / traversal session resource names
    expect(() =>
      validateSessionResourceName(
        'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/../../admin'
      )
    ).toThrow(SecurityValidationError);

    expect(() =>
      validateSessionResourceName(
        'projects/source-corp/locations/us-central1/collections/default_collection/engines/source-engine/sessions/s1'
      )
    ).toThrow(SecurityValidationError);

    expect(() =>
      validateSessionResourceName(
        'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/s1?admin=true'
      )
    ).toThrow(SecurityValidationError);

    expect(() => validateSessionResourceName('')).toThrow(SecurityValidationError);

    // Malformed / parameter-injecting file IDs
    expect(() => validateSessionFileId('../etc/passwd')).toThrow(SecurityValidationError);
    expect(() => validateSessionFileId('..')).toThrow(SecurityValidationError);
    expect(() => validateSessionFileId('file-1&alt=json')).toThrow(SecurityValidationError);
    expect(() => validateSessionFileId('file/subpath')).toThrow(SecurityValidationError);
    expect(() => validateSessionFileId('')).toThrow(SecurityValidationError);

    await expect(
      migrator.downloadSessionFile(
        'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-1',
        '../secret',
        'alice@source.com'
      )
    ).rejects.toThrow(SecurityValidationError);

    // Sanitizes traversal & control characters in upload filenames and rejects empty buffers
    expect(sanitizeSessionUploadFileName('../../etc/passwd\x00.pdf', 'pdf')).toBe('passwd.pdf');
    expect(sanitizeSessionUploadFileName('..', 'png')).toBe('attachment.png');

    await expect(
      migrator.uploadSessionFile(
        'projects/target-corp/locations/us/collections/default_collection/engines/target-engine/sessions/sess-1',
        'empty.pdf',
        'application/pdf',
        Buffer.alloc(0),
        'alice@target.com'
      )
    ).rejects.toThrow(/Cannot upload empty session file/);
  });

  it('migrates binary session attachments, inline generated charts, isPinned, codeExecution, citations, and deterministic sessionId end-to-end', async () => {
    vi.spyOn(dummyAuth, 'getAccessToken').mockResolvedValue('stub-token');
    const migrator = new SessionMigrator(buildConfig(), dummyAuth);

    const pdfBytes = Buffer.from('%PDF-1.7 quarterly-forecast-bytes');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    let createSessionUrl = '';
    let createSessionBody: any = null;
    const downloadedUrls: string[] = [];
    const addContextFileCalls: Array<{ url: string; body: any }> = [];

    const originalFetch = global.fetch;
    global.fetch = async (url: any, init: any) => {
      const urlStr = String(url);

      // 1. Source SessionService.ListFiles (`GET .../sessions/{id}/files`)
      if (urlStr.includes('/sessions/sess-pinned-42/files') && (!init?.method || init.method === 'GET')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            files: [
              {
                fileId: 'file_pdf_001',
                name: 'Q4-Forecast.pdf',
                mimeType: 'application/pdf',
                byteSize: String(pdfBytes.length),
                fileOriginType: 'USER_PROVIDED'
              }
            ]
          })
        } as any;
      }

      // 2. Source Scotty DownloadSessionFile (`GET /download/v1alpha/...:downloadFile?fileId=...&alt=media`)
      if (urlStr.includes('/download/v1alpha/') && urlStr.includes(':downloadFile')) {
        downloadedUrls.push(urlStr);
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength)
        } as any;
      }

      // 3. Target AddContextFile (`POST /v1alpha/.../sessions/{id}:addContextFile`)
      if (urlStr.includes(':addContextFile') && init?.method === 'POST') {
        const parsed = JSON.parse(init.body);
        addContextFileCalls.push({ url: urlStr, body: parsed });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            fileId: `tgt_${addContextFileCalls.length}`,
            fileName: parsed.fileName,
            mimeType: parsed.mimeType
          })
        } as any;
      }

      // 4. Target ListSessions & CreateSession
      if (urlStr.includes('/engines/target-engine/sessions')) {
        if (init?.method === 'POST') {
          createSessionUrl = urlStr;
          createSessionBody = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              name: 'projects/target-corp/locations/us/collections/default_collection/engines/target-engine/sessions/sess-pinned-42',
              isPinned: createSessionBody.isPinned
            })
          } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: [] })
        } as any;
      }

      throw new Error(`Unexpected outbound request: ${urlStr}`);
    };

    try {
      const sourceSession = {
        name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-pinned-42',
        displayName: 'Executive Revenue Analysis',
        userPseudoId: 'alice@source.com',
        isPinned: true,
        turns: [
          {
            query: { text: 'Analyze Q4-Forecast.pdf and plot revenue.' },
            queryConfig: { 'model-id': 'gemini-2.5-pro' },
            detailedAssistAnswer: {
              replies: [
                {
                  groundedContent: {
                    content: {
                      executableCode: {
                        code: 'import pandas as pd\nprint(142.5)'
                      }
                    }
                  }
                },
                {
                  groundedContent: {
                    content: {
                      codeExecutionResult: {
                        outcome: 'OUTCOME_OK',
                        output: '142.5'
                      }
                    }
                  }
                },
                {
                  groundedContent: {
                    content: {
                      text: 'Q4 revenue is projected at $142.5M.'
                    },
                    textGroundingMetadata: {
                      references: [
                        {
                          documentMetadata: {
                            title: 'Q4 Board Deck',
                            uri: 'https://docs.google.com/presentation/d/deck123',
                            pageIdentifier: '7'
                          }
                        }
                      ]
                    }
                  }
                },
                {
                  groundedContent: {
                    content: {
                      inlineData: {
                        mimeType: 'image/png',
                        data: pngBytes.toString('base64')
                      }
                    }
                  }
                },
                {
                  groundedContent: {
                    content: {
                      file: {
                        fileId: 'file_pdf_001',
                        mimeType: 'application/pdf'
                      }
                    }
                  }
                }
              ]
            }
          }
        ]
      };

      const migrated = await migrator.migrateSession(sourceSession);

      // Deterministic sessionId + regional us endpoint
      expect(createSessionUrl).toBe(
        'https://us-discoveryengine.googleapis.com/v1alpha/projects/target-corp/locations/us/collections/default_collection/engines/target-engine/sessions?sessionId=sess-pinned-42'
      );
      expect(createSessionBody.isPinned).toBe(true);
      expect(createSessionBody.userPseudoId).toBe('alice@target.com');
      expect(createSessionBody.turns[0].queryConfig).toEqual({ 'model-id': 'gemini-2.5-pro' });

      const turnText = createSessionBody.turns[0].query.text;
      expect(turnText).toContain('```python\nimport pandas as pd\nprint(142.5)\n```');
      expect(turnText).toContain('**Code Execution (OUTCOME_OK):**\n```text\n142.5\n```');
      expect(turnText).toContain('[Q4 Board Deck](https://docs.google.com/presentation/d/deck123) (p. 7)');
      expect(turnText).toContain('`turn-1-generated-1.png` (image/png)');
      expect(turnText).toContain('`Q4-Forecast.pdf` (application/pdf)');
      expect(turnText).toContain('Session Files Restored (1):** `Q4-Forecast.pdf`');

      // Verify binary download & target re-uploads (1 source PDF + 1 inline generated PNG)
      expect(downloadedUrls).toEqual([
        'https://discoveryengine.googleapis.com/download/v1alpha/projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-pinned-42:downloadFile?fileId=file_pdf_001&alt=media'
      ]);
      expect(addContextFileCalls).toHaveLength(2);
      expect(addContextFileCalls[0].body).toEqual({
        fileName: 'Q4-Forecast.pdf',
        mimeType: 'application/pdf',
        fileContents: pdfBytes.toString('base64')
      });
      expect(addContextFileCalls[1].body).toEqual({
        fileName: 'turn-1-generated-1.png',
        mimeType: 'image/png',
        fileContents: pngBytes.toString('base64')
      });
      expect(migrated.migratedFilesCount).toBe(2);
      expect(migrated.migratedFileIds).toEqual({
        file_pdf_001: 'tgt_1',
        'turn-1-generated-1.png': 'tgt_2'
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('preserves and remaps structured @-mention Query.parts (personReference, driveDocumentReference, documentReference) without setting conflicting query.text', async () => {
    vi.spyOn(dummyAuth, 'getAccessToken').mockResolvedValue('stub-token');
    const migrator = new SessionMigrator(buildConfig({ options: { dryRun: false, concurrency: 1, migrateSessionFiles: false } as any }), dummyAuth);

    let capturedBody: any = null;
    const originalFetch = global.fetch;
    global.fetch = async (url: any, init: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/engines/target-engine/sessions')) {
        if (init?.method === 'POST') {
          capturedBody = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              name: 'projects/target-corp/locations/us/collections/default_collection/engines/target-engine/sessions/sess-mentions'
            })
          } as any;
        }
        return { ok: true, status: 200, json: async () => ({ sessions: [] }) } as any;
      }
      throw new Error(`Unexpected outbound request: ${urlStr}`);
    };

    try {
      const sourceSession = {
        name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-mentions',
        userPseudoId: 'alice@source.com',
        turns: [
          {
            query: {
              parts: [
                { text: 'Please summarize ' },
                {
                  driveDocumentReference: {
                    driveId: '1DriveDocAbc',
                    displayTitle: 'FY27 Roadmap',
                    destinationUri: 'https://docs.google.com/document/d/1DriveDocAbc',
                    documentName: 'projects/source-corp/locations/global/collections/default_collection/dataStores/src-ds-docs/branches/0/documents/doc1',
                    fileId: 'output-only-strip-me'
                  }
                },
                { text: ' for ' },
                {
                  personReference: {
                    email: 'bob@source.com',
                    displayName: 'Bob Vance',
                    documentName: 'projects/source-corp/locations/global/collections/default_collection/dataStores/src-ds-people/branches/0/documents/person-bob',
                    fileId: 'output-only-person-file'
                  }
                }
              ]
            },
            answer: 'Here is the FY27 summary for Bob.'
          }
        ]
      };

      await migrator.migrateSession(sourceSession);

      expect(capturedBody).toBeDefined();
      // Display name derived cleanly including @-mentions
      expect(capturedBody.displayName).toContain('FY27 Roadmap');
      expect(capturedBody.displayName).toContain('@Bob Vance <bob@target.com>');

      const migratedQuery = capturedBody.turns[0].query;
      // Mutual exclusivity: query.text must be undefined when structured parts are populated
      expect(migratedQuery.text).toBeUndefined();
      expect(migratedQuery.parts).toHaveLength(5);
      expect(migratedQuery.parts[1].driveDocumentReference).toEqual({
        driveId: '1DriveDocAbc',
        displayTitle: 'FY27 Roadmap',
        destinationUri: 'https://docs.google.com/document/d/1DriveDocAbc',
        documentName: 'projects/target-corp/locations/us/collections/default_collection/dataStores/tgt-ds-docs/branches/0/documents/doc1'
      });
      expect(migratedQuery.parts[1].driveDocumentReference.fileId).toBeUndefined();
      expect(migratedQuery.parts[3].personReference).toEqual({
        email: 'bob@target.com',
        displayName: 'Bob Vance',
        documentName: 'projects/target-corp/locations/us/collections/default_collection/dataStores/tgt-ds-people/branches/0/documents/person-bob'
      });
      expect(migratedQuery.parts[3].personReference.fileId).toBeUndefined();
      expect(migratedQuery.parts[4].text).toContain('Here is the FY27 summary for Bob.');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('handles API fallbacks: /files 404 -> :listSessionFileMetadata, :addContextFile 413 -> Scotty :uploadFile, ListSessions 400 without view, and CreateSession 409 collision', async () => {
    vi.spyOn(dummyAuth, 'getAccessToken').mockResolvedValue('stub-token');
    const migrator = new SessionMigrator(buildConfig(), dummyAuth);

    const calledUrls: string[] = [];
    let scottyUploadHeaders: Record<string, string> = {};
    let createAttempts = 0;

    const originalFetch = global.fetch;
    global.fetch = async (url: any, init: any) => {
      const urlStr = String(url);
      calledUrls.push(urlStr);

      // ListSessions: reject view=SESSION_VIEW_FULL with 400, succeed without view
      if (urlStr.includes('/engines/source-engine/sessions?pageSize=100')) {
        if (urlStr.includes('view=SESSION_VIEW_FULL')) {
          return { ok: false, status: 400, text: async () => 'Invalid view parameter' } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sessions: [
              {
                name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/sess-fb',
                displayName: 'Fallback Session',
                userPseudoId: 'alice@source.com',
                turns: [{ query: { text: 'Check attachment' }, answer: 'Checked.' }]
              }
            ]
          })
        } as any;
      }

      // ListFiles returns 404 -> triggers :listSessionFileMetadata fallback
      if (urlStr.endsWith('/sessions/sess-fb/files?pageSize=1000')) {
        return { ok: false, status: 404, text: async () => 'Not found' } as any;
      }
      if (urlStr.includes(':listSessionFileMetadata')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            fileMetadata: [{ fileId: 'f_legacy_1', name: 'large-dataset.csv', mimeType: 'text/csv' }]
          })
        } as any;
      }

      // DownloadSessionFile
      if (urlStr.includes(':downloadFile?fileId=f_legacy_1&alt=media')) {
        const csv = Buffer.from('col1,col2\n1,2\n');
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => csv.buffer.slice(csv.byteOffset, csv.byteOffset + csv.byteLength)
        } as any;
      }

      // Target ListSessions
      if (urlStr.includes('/engines/target-engine/sessions') && (!init?.method || init.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ sessions: [] }) } as any;
      }

      // Target CreateSession: first attempt with ?sessionId=sess-fb returns 409, retry without sessionId succeeds
      if (
        urlStr.includes('/engines/target-engine/sessions') &&
        init?.method === 'POST' &&
        !urlStr.includes(':addContextFile') &&
        !urlStr.includes(':uploadFile')
      ) {
        createAttempts++;
        if (urlStr.includes('?sessionId=sess-fb')) {
          return { ok: false, status: 409, text: async () => 'Session already exists' } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'projects/target-corp/locations/us/collections/default_collection/engines/target-engine/sessions/sess-server-gen'
          })
        } as any;
      }

      // AddContextFile returns 413 Payload Too Large -> triggers Scotty :uploadFile?uploadType=media
      if (urlStr.includes(':addContextFile')) {
        return { ok: false, status: 413, text: async () => 'Payload Too Large' } as any;
      }
      if (urlStr.includes('/upload/v1alpha/') && urlStr.includes(':uploadFile?uploadType=media')) {
        scottyUploadHeaders = init.headers;
        return {
          ok: true,
          status: 200,
          json: async () => ({ fileId: 'scotty_file_99' })
        } as any;
      }

      throw new Error(`Unexpected URL in fallback test: ${urlStr}`);
    };

    try {
      const discovered = await migrator.listSourceSessions(['alice@source.com']);
      expect(discovered).toHaveLength(1);

      const created = await migrator.migrateSession(discovered[0]);
      expect(createAttempts).toBe(2);
      expect(created.name).toContain('sess-server-gen');
      expect(created.migratedFilesCount).toBe(1);
      expect(created.migratedFileIds).toEqual({ f_legacy_1: 'scotty_file_99' });
      expect(scottyUploadHeaders['X-Goog-Upload-Protocol']).toBe('raw');
      expect(scottyUploadHeaders['X-Goog-Upload-File-Name']).toBe('large-dataset.csv');
      expect(scottyUploadHeaders['Content-Type']).toBe('text/csv');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('omits filter=user_pseudo_id during DWD/WiF EUC impersonation so Web-UI sessions with numeric session_id userPseudoId are discovered, while skipping group principals and foreign-email sessions', async () => {
    const eucAuth = new GcpAuthService({
      staticToken: 'operator-base-token',
      dwdServiceAccountEmail: 'gemini-dwd-migrator@source-corp.iam.gserviceaccount.com'
    });

    const multiUserConfig: ValidatedMigrationConfig = {
      source: {
        projectId: 'source-corp',
        appLocation: 'global',
        appId: 'source-engine'
      },
      target: {
        projectId: 'target-corp',
        appLocation: 'global',
        appId: 'target-engine'
      },
      options: {
        dryRun: true,
        concurrency: 1,
        userFilter: [
          'admin@wdufrin.altostrat.com',
          'mikesh@wdufrin.altostrat.com',
          'group:test2@wdufrin.altostrat.com',
          'serviceAccount:bot@source-corp.iam.gserviceaccount.com'
        ]
      }
    } as ValidatedMigrationConfig;

    const multiUserMigrator = new SessionMigrator(multiUserConfig, eucAuth);
    const impersonatedEmails: string[] = [];
    const sessionListUrls: Array<{ authHeader: string; url: string }> = [];

    const originalFetch = global.fetch;
    global.fetch = async (input: any, init?: any) => {
      const urlStr = typeof input === 'string' ? input : input.url;

      if (urlStr.includes('iamcredentials.googleapis.com') && urlStr.endsWith(':signJwt')) {
        const payload = JSON.parse(JSON.parse(String(init?.body)).payload);
        impersonatedEmails.push(payload.sub);
        return new Response(JSON.stringify({ signedJwt: `jwt-for-${payload.sub}` }), { status: 200 });
      }

      if (urlStr === 'https://oauth2.googleapis.com/token') {
        const bodyStr = String(init?.body || '');
        const match = bodyStr.match(/assertion=jwt-for-([^&]+)/);
        const sub = match ? decodeURIComponent(match[1]) : 'unknown';
        return new Response(JSON.stringify({ access_token: `dwd-token-${sub}`, expires_in: 3600 }), { status: 200 });
      }

      if (urlStr.includes('/engines/source-engine/sessions')) {
        const authHeader = String(init?.headers?.Authorization || '');
        sessionListUrls.push({ authHeader, url: urlStr });

        if (authHeader === 'Bearer dwd-token-admin@wdufrin.altostrat.com') {
          return new Response(
            JSON.stringify({
              sessions: [
                {
                  name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/10242290474895466107',
                  displayName: 'Who is Vasher?',
                  userPseudoId: 'admin@wdufrin.altostrat.com'
                }
              ]
            }),
            { status: 200 }
          );
        }

        if (authHeader === 'Bearer dwd-token-mikesh@wdufrin.altostrat.com') {
          return new Response(
            JSON.stringify({
              sessions: [
                {
                  // Native Gemini Enterprise Web-UI session where user_pseudo_id defaulted to numeric session_id
                  name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/431653424115234044',
                  displayName: 'Q4 Forecast Review',
                  userPseudoId: '431653424115234044'
                },
                {
                  // Adversarial case: legacy non-ACL engine returning a session tagged with a foreign user's email
                  name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/999999999',
                  displayName: 'Other User Leak',
                  userPseudoId: 'someone-else@wdufrin.altostrat.com'
                }
              ]
            }),
            { status: 200 }
          );
        }
      }

      throw new Error(`Unexpected URL in multi-user EUC session test: ${urlStr}`);
    };

    try {
      const discovered = await multiUserMigrator.listSourceSessions([
        'admin@wdufrin.altostrat.com',
        'mikesh@wdufrin.altostrat.com',
        'group:test2@wdufrin.altostrat.com'
      ]);

      // Group and serviceAccount principals must NEVER be passed to DWD signJwt
      expect(impersonatedEmails).toEqual([
        'admin@wdufrin.altostrat.com',
        'mikesh@wdufrin.altostrat.com'
      ]);

      // Neither EUC ListSessions request may include `filter=user_pseudo_id`
      expect(sessionListUrls).toHaveLength(2);
      expect(sessionListUrls[0].url).not.toContain('filter=user_pseudo_id');
      expect(sessionListUrls[1].url).not.toContain('filter=user_pseudo_id');

      // Both admin's session and mikesh's numeric-userPseudoId Web-UI session are discovered; foreign email is excluded
      expect(discovered).toHaveLength(2);
      expect(discovered[0].displayName).toBe('Who is Vasher?');
      expect(discovered[0].userPseudoId).toBe('admin@wdufrin.altostrat.com');
      expect(discovered[1].displayName).toBe('Q4 Forecast Review');
      expect(discovered[1].userPseudoId).toBe('mikesh@wdufrin.altostrat.com');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should seed a live AssistAnswer via :streamAssist with verbatim Q&A and restore displayName when continuableSessions is enabled', async () => {
    vi.spyOn(dummyAuth, 'getAccessToken').mockResolvedValue('euc-token');

    const continuableMigrator = new SessionMigrator(
      buildConfig({
        target: {
          projectId: 'target-corp',
          appLocation: 'global',
          collectionId: 'default_collection',
          appId: 'target-engine',
          assistantId: 'default_assistant'
        },
        options: {
          dryRun: false,
          concurrency: 1,
          continuableSessions: true,
          migrateSessionFiles: false
        }
      }),
      dummyAuth
    );

    const recordedCalls: Array<{ method: string; url: string; body?: any }> = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      const urlStr = url.toString();
      const method = (init?.method || 'GET').toUpperCase();
      const parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      recordedCalls.push({ method, url: urlStr, body: parsedBody });

      // 1. Probe target sessions (empty)
      if (method === 'GET' && urlStr.includes('/engines/target-engine/sessions?pageSize=100')) {
        return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
      }

      // 2. Create empty session container
      if (method === 'POST' && urlStr.includes('/engines/target-engine/sessions?sessionId=report-sess-42')) {
        return new Response(
          JSON.stringify({
            name: 'projects/target-corp/locations/global/collections/default_collection/engines/target-engine/sessions/report-sess-42',
            displayName: parsedBody.displayName,
            turns: []
          }),
          { status: 200 }
        );
      }

      // 3. :streamAssist handshake
      if (method === 'POST' && urlStr.includes('/engines/target-engine/assistants/default_assistant:streamAssist')) {
        return new Response(
          JSON.stringify([
            {
              answer: {
                name: 'projects/target-corp/locations/global/collections/default_collection/engines/target-engine/sessions/report-sess-42/assistAnswers/ans-1',
                state: 'SUCCEEDED',
                replies: [
                  {
                    groundedContent: {
                      content: {
                        role: 'model',
                        text: '✅ Restored conversation context from `source-corp` — ready for follow-up questions.'
                      }
                    }
                  }
                ]
              },
              sessionInfo: {
                session: 'projects/target-corp/locations/global/collections/default_collection/engines/target-engine/sessions/report-sess-42'
              },
              assistToken: 'tok-continuable-1'
            }
          ]),
          { status: 200 }
        );
      }

      // 4. PATCH displayName,isPinned (preserves title after StreamAssist auto-titling)
      if (
        method === 'PATCH' &&
        urlStr.includes('/engines/target-engine/sessions/report-sess-42?updateMask=displayName,isPinned')
      ) {
        return new Response(
          JSON.stringify({
            name: 'projects/target-corp/locations/global/collections/default_collection/engines/target-engine/sessions/report-sess-42',
            displayName: parsedBody.displayName,
            isPinned: true
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected HTTP call in continuableSessions test: ${method} ${urlStr}`);
    };

    try {
      const migrated = await continuableMigrator.migrateSession({
        name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/report-sess-42',
        displayName: 'Ancient-sandbox-322523 report',
        userPseudoId: 'wdufrin@wdufrin.altostrat.com',
        isPinned: true,
        turns: [
          {
            query: { text: 'Give me a report on ancient-sandbox-322523' },
            detailedAssistAnswer: {
              replies: [
                {
                  groundedContent: {
                    content: {
                      text: 'Executive Summary: 14 Cloud Run services and 3 BigQuery datasets active.'
                    }
                  }
                }
              ]
            }
          } as any,
          {
            query: { text: 'Which dataset is largest?' },
            detailedAssistAnswer: {
              replies: [
                {
                  groundedContent: {
                    content: {
                      text: 'telemetry_prod is largest at 4.2 TB.'
                    }
                  }
                }
              ]
            }
          } as any
        ]
      });

      expect(migrated.continuableSeeded).toBe(true);

      const createCall = recordedCalls.find(c => c.method === 'POST' && c.url.includes('?sessionId=report-sess-42'));
      expect(createCall?.body.turns).toEqual([]);
      expect(createCall?.body.displayName).toBe('Ancient-sandbox-322523 report');
      expect(createCall?.body.labels).toContain('source-session-id:report-sess-42');

      const streamCall = recordedCalls.find(c => c.method === 'POST' && c.url.includes(':streamAssist'));
      expect(streamCall?.body.session).toBe(
        'projects/target-corp/locations/global/collections/default_collection/engines/target-engine/sessions/report-sess-42'
      );
      expect(streamCall?.body.toolsSpec).toEqual({});
      // Verbatim preservation of every historical prompt and answer
      expect(streamCall?.body.query.text).toContain('Give me a report on ancient-sandbox-322523');
      expect(streamCall?.body.query.text).toContain('Executive Summary: 14 Cloud Run services and 3 BigQuery datasets active.');
      expect(streamCall?.body.query.text).toContain('Which dataset is largest?');
      expect(streamCall?.body.query.text).toContain('telemetry_prod is largest at 4.2 TB.');

      const patchCall = recordedCalls.find(c => c.method === 'PATCH');
      expect(patchCall?.url).toContain('updateMask=displayName,isPinned');
      expect(patchCall?.body).toEqual({
        name: 'projects/target-corp/locations/global/collections/default_collection/engines/target-engine/sessions/report-sess-42',
        displayName: 'Ancient-sandbox-322523 report',
        isPinned: true
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should gracefully fall back to PATCH verbatim archive turns when :streamAssist returns SKIPPED', async () => {
    vi.spyOn(dummyAuth, 'getAccessToken').mockResolvedValue('euc-token');

    const continuableMigrator = new SessionMigrator(
      buildConfig({
        target: {
          projectId: 'target-corp',
          appLocation: 'global',
          collectionId: 'default_collection',
          appId: 'target-engine'
        },
        options: {
          dryRun: false,
          concurrency: 1,
          continuableSessions: true,
          migrateSessionFiles: false
        }
      }),
      dummyAuth
    );

    const recordedCalls: Array<{ method: string; url: string; body?: any }> = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      const urlStr = url.toString();
      const method = (init?.method || 'GET').toUpperCase();
      const parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      recordedCalls.push({ method, url: urlStr, body: parsedBody });

      if (method === 'GET' && urlStr.includes('/engines/target-engine/sessions?pageSize=100')) {
        return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
      }
      if (method === 'POST' && urlStr.includes('/engines/target-engine/sessions?sessionId=skipped-sess-9')) {
        return new Response(
          JSON.stringify({
            name: 'projects/target-corp/locations/global/collections/default_collection/engines/target-engine/sessions/skipped-sess-9',
            displayName: parsedBody.displayName,
            turns: []
          }),
          { status: 200 }
        );
      }
      if (method === 'POST' && urlStr.includes(':streamAssist')) {
        // Simulate Model Armor / policy assist-skipping response
        return new Response(
          JSON.stringify([
            {
              answer: {
                state: 'SKIPPED',
                assistSkippedReasons: ['CUSTOMER_POLICY_VIOLATION']
              }
            }
          ]),
          { status: 200 }
        );
      }
      if (
        method === 'PATCH' &&
        urlStr.includes('/engines/target-engine/sessions/skipped-sess-9?updateMask=turns,displayName')
      ) {
        return new Response(
          JSON.stringify({
            name: 'projects/target-corp/locations/global/collections/default_collection/engines/target-engine/sessions/skipped-sess-9',
            displayName: parsedBody.displayName,
            turns: parsedBody.turns
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected HTTP call in fallback test: ${method} ${urlStr}`);
    };

    try {
      const result = await continuableMigrator.migrateSession({
        name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/skipped-sess-9',
        displayName: 'Sensitive Audit',
        userPseudoId: 'wdufrin@wdufrin.altostrat.com',
        turns: [
          {
            query: { text: 'Show Q3 compliance findings' },
            answer: 'Zero P0 violations recorded.'
          }
        ]
      });

      expect(result.continuableSeeded).toBe(false);
      const fallbackPatch = recordedCalls.find(c => c.method === 'PATCH');
      expect(fallbackPatch?.url).toContain('updateMask=turns,displayName');
      expect(fallbackPatch?.body.turns).toHaveLength(1);
      expect(fallbackPatch?.body.turns[0].query.text).toContain('Show Q3 compliance findings');
      expect(fallbackPatch?.body.turns[0].query.text).toContain('Zero P0 violations recorded.');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should reject malformed :streamAssist JSON payloads and propagate explicit error if both handshake and fallback PATCH fail', async () => {
    // Adversarial parser checks
    expect(() => parseStreamAssistChunks('')).toThrow(/empty response body/i);
    expect(() => parseStreamAssistChunks('   \n  ')).toThrow(/empty response body/i);
    expect(() => parseStreamAssistChunks('[{"answer": {corrupt')).toThrow(/Malformed StreamAssist stream chunk/i);
    expect(() => parseStreamAssistChunks('{"answer":{"state":"SUCCEEDED"}}\n{corrupt_ndjson')).toThrow(
      /Malformed StreamAssist stream chunk/i
    );

    // Valid NDJSON parsing check
    const validNdjson = parseStreamAssistChunks(
      '{"answer":{"state":"IN_PROGRESS"}}\n{"answer":{"name":"projects/p/locations/global/collections/default_collection/engines/e/sessions/s/assistAnswers/a","state":"SUCCEEDED"}}'
    );
    expect(validNdjson).toHaveLength(2);

    // Dual failure propagation (no swallowed exceptions)
    vi.spyOn(dummyAuth, 'getAccessToken').mockResolvedValue('euc-token');
    const continuableMigrator = new SessionMigrator(
      buildConfig({
        target: {
          projectId: 'target-corp',
          appLocation: 'global',
          collectionId: 'default_collection',
          appId: 'target-engine'
        },
        options: {
          dryRun: false,
          concurrency: 1,
          continuableSessions: true,
          migrateSessionFiles: false
        }
      }),
      dummyAuth
    );

    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      const urlStr = url.toString();
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET' && urlStr.includes('/sessions?pageSize=100')) {
        return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
      }
      if (method === 'POST' && urlStr.includes('/sessions?sessionId=dual-fail-1')) {
        return new Response(
          JSON.stringify({
            name: 'projects/target-corp/locations/global/collections/default_collection/engines/target-engine/sessions/dual-fail-1',
            displayName: 'Dual Fail Chat',
            turns: []
          }),
          { status: 200 }
        );
      }
      if (method === 'POST' && urlStr.includes(':streamAssist')) {
        return new Response('{"error":"QUOTA_EXCEEDED"}', { status: 429 });
      }
      if (method === 'PATCH') {
        return new Response('{"error":"SPANNER_UNAVAILABLE"}', { status: 503 });
      }
      throw new Error(`Unexpected call: ${method} ${urlStr}`);
    };

    try {
      await expect(
        continuableMigrator.migrateSession({
          name: 'projects/source-corp/locations/global/collections/default_collection/engines/source-engine/sessions/dual-fail-1',
          displayName: 'Dual Fail Chat',
          userPseudoId: 'wdufrin@wdufrin.altostrat.com',
          turns: [{ query: { text: 'Test prompt' }, answer: 'Test answer' }]
        })
      ).rejects.toThrow(/Continuable handshake failed.*429.*archive fallback PATCH also failed.*503/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});



