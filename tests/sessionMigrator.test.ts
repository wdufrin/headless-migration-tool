import { describe, it, expect } from 'vitest';
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

  it('should keep query.text strictly as user prompt without concatenating assistant answers', async () => {
    let capturedPayload: any = null;

    // Mock global fetch to capture payload sent to Discovery Engine
    const originalFetch = global.fetch;
    global.fetch = async (url: any, init: any) => {
      if (typeof url === 'string' && url.includes('/sessions')) {
        capturedPayload = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ name: 'projects/target-corp/locations/global/collections/default_collection/engines/target-engine/sessions/sess-123' })
        } as any;
      }
      return originalFetch(url, init);
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
      // Query text must be strictly the user's prompt
      expect(capturedPayload.turns[0].query.text).toBe('What is the daily meal limit?');
      expect(capturedPayload.turns[0].query.text).not.toContain('Gemini Response');
      expect(capturedPayload.turns[0].query.text).not.toContain('Conversation Closed');
      expect(capturedPayload.turns[0].answer).toBe('The daily meal limit is $75.');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
