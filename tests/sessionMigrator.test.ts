import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionMigrator } from '../src/engines/sessionMigrator.js';
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
