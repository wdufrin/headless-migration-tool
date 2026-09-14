import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CheckpointManager } from '../src/services/checkpointManager.js';
import { MigrationItemResult, MigrationReport } from '../src/types/migration.js';
import * as fs from 'fs';
import * as path from 'path';

describe('CheckpointManager', () => {
  const testDir = path.join(process.cwd(), '.tmp-checkpoint-test');

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should incrementally record successes and write to disk', () => {
    const mgr = new CheckpointManager(testDir, 'test-run-1');
    const item1: MigrationItemResult = {
      id: 'agent-123',
      displayName: 'Customer Support Bot',
      type: 'AGENT',
      status: 'SUCCESS',
      originalOwner: 'user@company.com',
      targetOwner: 'user@company.com'
    };
    const item2: MigrationItemResult = {
      id: 'agent-456',
      displayName: 'Broken Agent',
      type: 'AGENT',
      status: 'FAILED',
      error: 'Permission denied',
      originalOwner: 'user@company.com'
    };

    mgr.recordSuccess(item1);
    mgr.recordSuccess(item2); // should NOT be recorded in checkpoint

    expect(mgr.has('AGENT', 'agent-123')).toBe(true);
    expect(mgr.has('AGENT', 'agent-456')).toBe(false);

    // Verify file on disk
    const filePath = mgr.getFilePath();
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(content.migrationId).toBe('test-run-1');
    expect(content.completedItems.length).toBe(1);
    expect(content.completedItems[0].id).toBe('agent-123');
  });

  it('should load previously completed items from checkpoint file', () => {
    const filePath = path.join(testDir, '.checkpoint-prev.json');
    const data = {
      migrationId: 'prev-run',
      updatedAt: new Date().toISOString(),
      completedItems: [
        { id: 'nb-1', displayName: 'Notebook A', type: 'NOTEBOOK', status: 'SUCCESS' },
        { id: 'skill-1', displayName: 'Skill A', type: 'SKILL', status: 'DRY_RUN' }
      ]
    };
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');

    const loaded = CheckpointManager.load(filePath);
    expect(loaded.size).toBe(2);
    expect(loaded.has('NOTEBOOK:nb-1')).toBe(true);
    expect(loaded.has('SKILL:skill-1')).toBe(true);
  });

  it('should load completed items from full MigrationReport JSON', () => {
    const filePath = path.join(testDir, 'full-report.json');
    const report: Partial<MigrationReport> = {
      migrationId: 'full-run',
      results: [
        { id: 'sess-1', displayName: 'Chat 1', type: 'SESSION', status: 'SUCCESS' },
        { id: 'sess-2', displayName: 'Chat 2', type: 'SESSION', status: 'FAILED' },
        { id: 'mem-1', displayName: 'Fact 1', type: 'MEMORY', status: 'DRY_RUN' }
      ]
    };
    fs.writeFileSync(filePath, JSON.stringify(report), 'utf8');

    const loaded = CheckpointManager.load(filePath);
    expect(loaded.size).toBe(2);
    expect(loaded.has('SESSION:sess-1')).toBe(true);
    expect(loaded.has('SESSION:sess-2')).toBe(false); // failed items skipped
    expect(loaded.has('MEMORY:mem-1')).toBe(true);
  });
});
