import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryMigrator } from '../src/engines/memoryMigrator.js';
import { DiscoveryEngineClient } from '../src/services/discoveryEngine.js';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import { ValidatedMigrationConfig } from '../src/config/configSchema.js';
import { Memory } from '../src/types/index.js';
import * as fs from 'fs';
import * as path from 'path';

describe('MemoryMigrator Engine', () => {
  const dummyAuth = new GcpAuthService({ staticToken: 'test-token' });
  const dummyClient = new DiscoveryEngineClient(dummyAuth);
  const testOutputDir = path.join(process.cwd(), '.tmp-test-memory-exports');

  const sampleConfig: ValidatedMigrationConfig = {
    source: {
      projectId: 'source-project',
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: 'source-engine',
      assistantId: 'default_assistant'
    },
    target: {
      projectId: 'target-project',
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: 'target-engine',
      assistantId: 'default_assistant'
    },
    options: {
      migrateMemories: true,
      exportMemories: true,
      dryRun: false,
      concurrency: 5,
      userFilter: [],
      preserveOwnership: true
    },
    identityMapping: {
      'alice@source.com': 'alice@target.com'
    },
    datastoreMapping: {},
    collectionMapping: {}
  };

  const sampleMemories: Memory[] = [
    {
      name: 'projects/123/locations/global/collections/default_collection/engines/source-engine/memories/mem-1',
      fact: 'User is a Senior Solutions Architect focusing on Vertex AI.',
      owner: 'alice@source.com',
      userEmail: 'alice@source.com',
      createTime: '2026-08-20T10:00:00Z',
      updateTime: '2026-08-20T10:00:00Z',
      originalResourcePath: 'projects/123/locations/us-central1/reasoningEngines/12345/memories/fact-1'
    },
    {
      name: 'projects/123/locations/global/collections/default_collection/engines/source-engine/memories/mem-2',
      fact: 'User prefers concise TypeScript code examples with GitHub links.',
      owner: 'bob@source.com',
      userEmail: 'bob@source.com',
      createTime: '2026-08-21T11:00:00Z',
      updateTime: '2026-08-21T11:00:00Z',
      originalResourcePath: 'projects/123/locations/us-central1/reasoningEngines/12345/memories/fact-2'
    }
  ];

  beforeEach(() => {
    if (fs.existsSync(testOutputDir)) {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testOutputDir)) {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  it('should list source memories using client.listMemories', async () => {
    const migrator = new MemoryMigrator(sampleConfig, dummyAuth, dummyClient);
    dummyClient.listMemories = vi.fn().mockResolvedValue(sampleMemories);

    const memories = await migrator.listSourceMemories();
    expect(memories.length).toBe(2);
    expect(memories[0].fact).toContain('Senior Solutions Architect');
    expect(dummyClient.listMemories).toHaveBeenCalled();
  });

  it('should filter memories by userFilter if specified in config', async () => {
    const userFilteredConfig: ValidatedMigrationConfig = {
      ...sampleConfig,
      options: {
        ...sampleConfig.options,
        userFilter: ['alice@source.com']
      }
    };
    const migrator = new MemoryMigrator(userFilteredConfig, dummyAuth, dummyClient);
    dummyClient.listMemories = vi.fn().mockResolvedValue(sampleMemories);

    const memories = await migrator.listSourceMemories();
    expect(memories.length).toBe(1);
    expect(memories[0].owner).toBe('alice@source.com');
  });

  it('should migrate memory fact to target and map user identity', async () => {
    const migrator = new MemoryMigrator(sampleConfig, dummyAuth, dummyClient);
    dummyClient.generateMemories = vi.fn().mockResolvedValue({
      name: 'projects/999/locations/global/collections/default_collection/engines/target-engine/memories/target-mem-1',
      fact: sampleMemories[0].fact
    });

    const result = await migrator.migrateMemory(sampleMemories[0]);
    expect(result).toBeDefined();
    expect(dummyClient.generateMemories).toHaveBeenCalledWith(
      sampleConfig.target,
      sampleMemories[0].fact,
      'alice@target.com' // Mapped from alice@source.com
    );
  });

  it('should export all memories to disk snapshot files', async () => {
    const migrator = new MemoryMigrator(sampleConfig, dummyAuth, dummyClient);
    dummyClient.listMemories = vi.fn().mockResolvedValue(sampleMemories);

    const result = await migrator.exportAllMemoriesToDirectory(testOutputDir);
    expect(result.count).toBe(2);
    expect(fs.existsSync(result.exportPath)).toBe(true);

    const latestJsonPath = path.join(testOutputDir, 'latest.json');
    expect(fs.existsSync(latestJsonPath)).toBe(true);

    const raw = fs.readFileSync(latestJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.total).toBe(2);
    expect(parsed.memories[0].fact).toContain('Senior Solutions Architect');

    // Per-user JSON backup
    const userBackupPath = path.join(testOutputDir, 'users/alice_source_com.json');
    expect(fs.existsSync(userBackupPath)).toBe(true);
  });

  it('should import and restore memories from a JSON backup file', async () => {
    const migrator = new MemoryMigrator(sampleConfig, dummyAuth, dummyClient);
    dummyClient.listMemories = vi.fn().mockResolvedValue(sampleMemories);
    dummyClient.generateMemories = vi.fn().mockResolvedValue({ success: true });

    // 1. Export first
    const exportResult = await migrator.exportAllMemoriesToDirectory(testOutputDir);

    // 2. Import from exported file
    const restoreResult = await migrator.importMemoriesFromFile(exportResult.exportPath);
    expect(restoreResult.total).toBe(2);
    expect(restoreResult.successCount).toBe(2);
    expect(restoreResult.failedCount).toBe(0);
    expect(dummyClient.generateMemories).toHaveBeenCalledTimes(2);
  });

  it('should delete memory fact via client.deleteMemory', async () => {
    const migrator = new MemoryMigrator(sampleConfig, dummyAuth, dummyClient);
    dummyClient.deleteMemory = vi.fn().mockResolvedValue({});

    await migrator.deleteMemory(sampleMemories[0].name, 'alice@source.com', false);
    expect(dummyClient.deleteMemory).toHaveBeenCalledWith(
      sampleMemories[0].name,
      sampleConfig.source,
      'alice@source.com'
    );
  });
});
