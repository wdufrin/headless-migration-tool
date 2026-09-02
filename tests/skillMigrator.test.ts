import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillMigrator } from '../src/engines/skillMigrator.js';
import { AgentRegistryClient } from '../src/services/agentRegistry.js';
import { DiscoveryEngineClient } from '../src/services/discoveryEngine.js';
import { EnvironmentConfig, MigrationOptions } from '../src/types/migration.js';
import { RegistrySkill, RegistrySkillRevision } from '../src/types/index.js';

describe('SkillMigrator', () => {
  let mockClient: AgentRegistryClient;
  let skillMigrator: SkillMigrator;

  const sourceEnv: EnvironmentConfig = {
    projectId: 'source-project',
    appLocation: 'global'
  };

  const targetEnv: EnvironmentConfig = {
    projectId: 'target-project',
    appLocation: 'global'
  };

  const sampleSkill: RegistrySkill = {
    name: 'projects/source-project/locations/global/skills/code-reviewer',
    skillId: 'code-reviewer',
    displayName: 'Code Reviewer Skill',
    description: 'Reviews pull requests and provides suggestions',
    type: 'SIMPLE',
    state: 'STATE_ACTIVE',
    targetState: 'TARGET_STATE_ACTIVE',
    publisher: 'developer@example.com'
  };

  const sampleRevision: RegistrySkillRevision = {
    name: 'projects/source-project/locations/global/skills/code-reviewer/revisions/1',
    state: 'ACTIVE',
    frontmatter: {
      name: 'code-reviewer',
      description: 'Reviews pull requests and provides suggestions'
    },
    archiveUploadSource: {
      archiveContent: Buffer.from('mock-zip-content').toString('base64')
    }
  };

  beforeEach(() => {
    mockClient = {
      listSkills: vi.fn(),
      getSkill: vi.fn(),
      createSkill: vi.fn(),
      updateSkill: vi.fn(),
      deleteSkill: vi.fn(),
      listSkillRevisions: vi.fn(),
      createSkillRevision: vi.fn(),
      downloadSkillRevisionMedia: vi.fn()
    } as unknown as AgentRegistryClient;

    skillMigrator = new SkillMigrator(mockClient);
  });

  describe('migrateSkills', () => {
    it('should return empty results if no skills are found in source', async () => {
      vi.mocked(mockClient.listSkills).mockResolvedValue([]);

      const results = await skillMigrator.migrateSkills(sourceEnv, targetEnv, {});
      expect(results).toHaveLength(0);
    });

    it('should simulate skill migration in dry-run mode without calling createSkill', async () => {
      vi.mocked(mockClient.listSkills).mockResolvedValue([sampleSkill]);
      vi.mocked(mockClient.getSkill).mockResolvedValue(sampleSkill);
      vi.mocked(mockClient.listSkillRevisions).mockResolvedValue([sampleRevision]);

      const options: MigrationOptions = { dryRun: true };
      const results = await skillMigrator.migrateSkills(sourceEnv, targetEnv, options);

      expect(mockClient.createSkill).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('DRY_RUN');
      expect(results[0].type).toBe('SKILL');
      expect(results[0].displayName).toBe('Code Reviewer Skill');
    });

    it('should directly create skill in target when it does not exist', async () => {
      vi.mocked(mockClient.listSkills).mockResolvedValue([sampleSkill]);
      vi.mocked(mockClient.getSkill).mockResolvedValue(sampleSkill);
      vi.mocked(mockClient.listSkillRevisions).mockResolvedValue([sampleRevision]);
      // Target check returns 404
      vi.mocked(mockClient.getSkill).mockImplementation(async (name, env) => {
        if (env.projectId === targetEnv.projectId) throw new Error('404 Not Found');
        return sampleSkill;
      });
      vi.mocked(mockClient.createSkill).mockResolvedValue({} as any);

      const results = await skillMigrator.migrateSkills(sourceEnv, targetEnv, { dryRun: false });

      expect(mockClient.createSkill).toHaveBeenCalledWith(
        'code-reviewer',
        expect.objectContaining({
          displayName: 'Code Reviewer Skill',
          type: 'SIMPLE',
          initialRevision: expect.objectContaining({
            archiveUploadSource: {
              archiveContent: Buffer.from('mock-zip-content').toString('base64')
            }
          })
        }),
        targetEnv
      );
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('SUCCESS');
    });

    it('should skip creation if skill already exists in target', async () => {
      vi.mocked(mockClient.listSkills).mockResolvedValue([sampleSkill]);
      vi.mocked(mockClient.getSkill).mockResolvedValue(sampleSkill);
      vi.mocked(mockClient.listSkillRevisions).mockResolvedValue([sampleRevision]);

      const results = await skillMigrator.migrateSkills(sourceEnv, targetEnv, { dryRun: false });

      expect(mockClient.createSkill).not.toHaveBeenCalled();
      expect(results[0].status).toBe('SUCCESS');
    });

    it('should capture failure gracefully if creation fails', async () => {
      vi.mocked(mockClient.listSkills).mockResolvedValue([sampleSkill]);
      vi.mocked(mockClient.getSkill).mockImplementation(async (name, env) => {
        if (env.projectId === targetEnv.projectId) throw new Error('404 Not Found');
        return sampleSkill;
      });
      vi.mocked(mockClient.listSkillRevisions).mockResolvedValue([sampleRevision]);
      vi.mocked(mockClient.createSkill).mockRejectedValue(new Error('Permission Denied (403)'));

      const results = await skillMigrator.migrateSkills(sourceEnv, targetEnv, { dryRun: false });

      expect(results[0].status).toBe('FAILED');
      expect(results[0].error).toContain('Permission Denied (403)');
    });

    it('should filter out public Google 1P catalog skills in Agent Registry', async () => {
      const publicSkill1: RegistrySkill = {
        name: 'projects/source-project/locations/global/skills/cloud.google.com-bigquery-basics',
        skillId: 'cloud.google.com-bigquery-basics',
        displayName: 'BigQuery Basics',
        type: 'SIMPLE',
        state: 'STATE_ACTIVE'
      };
      const publicSkill2: RegistrySkill = {
        name: 'projects/source-project/locations/global/skills/discoveryengine.googleapis.com-search-agent',
        skillId: 'discoveryengine.googleapis.com-search-agent',
        displayName: 'Search Agent',
        type: 'SIMPLE',
        state: 'STATE_ACTIVE'
      };
      const publicSkill3: RegistrySkill = {
        name: 'projects/source-project/locations/global/skills/google-calendar-helper',
        skillId: 'google-calendar-helper',
        displayName: 'Google Calendar Helper',
        type: 'SIMPLE',
        state: 'STATE_ACTIVE'
      };

      vi.mocked(mockClient.listSkills).mockResolvedValue([
        publicSkill1,
        sampleSkill,
        publicSkill2,
        publicSkill3
      ]);
      vi.mocked(mockClient.getSkill).mockImplementation(async (name, env) => {
        if (env.projectId === targetEnv.projectId) throw new Error('404 Not Found');
        return sampleSkill;
      });
      vi.mocked(mockClient.listSkillRevisions).mockResolvedValue([sampleRevision]);
      vi.mocked(mockClient.createSkill).mockResolvedValue({} as any);

      const results = await skillMigrator.migrateSkills(sourceEnv, targetEnv, { dryRun: false });

      // Only sampleSkill (user-created) should have been migrated
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('code-reviewer');
      expect(mockClient.createSkill).toHaveBeenCalledTimes(1);
      expect(mockClient.createSkill).toHaveBeenCalledWith('code-reviewer', expect.anything(), targetEnv);
    });

    it('should discover and migrate user skill agents in Discovery Engine while excluding public templates', async () => {
      const mockDiscoveryClient = {
        listAgents: vi.fn(),
        getAgent: vi.fn(),
        getAgentIamPolicy: vi.fn(),
        createAgent: vi.fn(),
        patchAgentSharing: vi.fn(),
        setAgentIamPolicy: vi.fn()
      } as unknown as DiscoveryEngineClient;

      const migratorWithDE = new SkillMigrator(mockClient, mockDiscoveryClient);

      const deSourceEnv: EnvironmentConfig = {
        ...sourceEnv,
        appId: 'source-engine'
      };
      const deTargetEnv: EnvironmentConfig = {
        ...targetEnv,
        appId: 'target-engine'
      };

      vi.mocked(mockClient.listSkills).mockResolvedValue([]);

      const publicSkillAgent = {
        name: 'projects/123/locations/global/collections/default_collection/engines/source-engine/assistants/default_assistant/agents/email-writing-style',
        displayName: 'email-writing-style',
        skillAgentDefinition: {
          instruction: 'public instruction',
          subfiles: [{ fileName: 'SKILL.md', mimeType: 'text/markdown' }]
        },
        owner: 'admin@company.com'
      };

      const userSkillAgent1 = {
        name: 'projects/123/locations/global/collections/default_collection/engines/source-engine/assistants/default_assistant/agents/sales-coaching',
        displayName: 'Sales Coaching',
        skillAgentDefinition: {
          instruction: 'enterprise sales instruction',
          subfiles: [{ fileName: 'SKILL.md', mimeType: 'text/markdown' }],
          gcsUri: 'gs://source-tenant-bucket/skills/123'
        },
        sharingConfig: { scope: 'ALL_USERS' },
        owner: 'user:admin@company.com'
      };

      const userSkillAgent2 = {
        name: 'projects/123/locations/global/collections/default_collection/engines/source-engine/assistants/default_assistant/agents/other-user-skill',
        displayName: 'Other User Skill',
        skillAgentDefinition: {
          instruction: 'other user instruction',
          subfiles: []
        },
        owner: 'user:other@company.com'
      };

      vi.mocked(mockDiscoveryClient.listAgents).mockResolvedValue([
        publicSkillAgent,
        userSkillAgent1,
        userSkillAgent2
      ] as any);

      vi.mocked(mockDiscoveryClient.getAgentIamPolicy).mockImplementation(async (name) => {
        if (name.includes('sales-coaching')) {
          return {
            bindings: [
              { role: 'roles/discoveryengine.agentOwner', members: ['user:admin@company.com'] },
              { role: 'roles/discoveryengine.agentUser', members: ['user:analyst@company.com'] }
            ],
            etag: 'etag-123'
          };
        }
        return { bindings: [] };
      });

      // Target doesn't have it (throws 404)
      vi.mocked(mockDiscoveryClient.getAgent).mockRejectedValue(new Error('404 Not Found'));
      vi.mocked(mockDiscoveryClient.createAgent).mockResolvedValue({
        name: 'projects/456/locations/global/collections/default_collection/engines/target-engine/assistants/default_assistant/agents/sales-coaching',
        displayName: 'Sales Coaching'
      } as any);

      const results = await migratorWithDE.migrateSkills(
        deSourceEnv,
        deTargetEnv,
        { dryRun: false, userFilter: ['admin@company.com'] },
        { 'analyst@company.com': 'analyst@target.com' }
      );

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('sales-coaching');
      expect(results[0].status).toBe('SUCCESS');
      expect(results[0].type).toBe('SKILL');

      // Verify createAgent was called with sanitized payload (no gcsUri or owner in skillAgentDefinition)
      expect(mockDiscoveryClient.createAgent).toHaveBeenCalledWith(
        deTargetEnv,
        expect.objectContaining({
          displayName: 'Sales Coaching',
          skillAgentDefinition: {
            instruction: 'enterprise sales instruction',
            subfiles: [{ fileName: 'SKILL.md', mimeType: 'text/markdown' }]
          }
        }),
        'sales-coaching',
        'admin@company.com'
      );

      // Verify sharing config was patched
      expect(mockDiscoveryClient.patchAgentSharing).toHaveBeenCalled();

      // Verify IAM policy was restored with mapped identities
      expect(mockDiscoveryClient.setAgentIamPolicy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          bindings: expect.arrayContaining([
            expect.objectContaining({
              role: 'roles/discoveryengine.agentUser',
              members: ['user:analyst@target.com']
            })
          ])
        }),
        deTargetEnv
      );
    });
  });
});
