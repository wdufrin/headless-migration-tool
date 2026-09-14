/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AppStateTracker } from '../src/services/appStateTracker.js';
import { maintenanceRouter } from '../src/routes/maintenance.js';

describe('AppStateTracker & Decommissioning Suite', () => {
  let tempDir: string;
  let testStatePath: string;
  const originalDefaultPath = AppStateTracker.getStateFilePath();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-state-test-'));
    testStatePath = path.join(tempDir, '.test-migration-state.json');
    AppStateTracker.setStateFilePath(testStatePath);
    AppStateTracker.clearTrackedState();
  });

  afterEach(() => {
    AppStateTracker.clearTrackedState();
    AppStateTracker.setStateFilePath(originalDefaultPath);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('AppStateTracker Unit Tests', () => {
    it('should initialize with empty collections when no state exists', () => {
      const state = AppStateTracker.loadState();
      expect(state).toBeDefined();
      expect(state.overriddenOrgPolicies).toEqual([]);
      expect(state.appliedIamBindings).toEqual([]);
    });

    it('should record an overridden org policy and prevent duplicate entries', () => {
      AppStateTracker.recordOrgPolicyOverride(
        'target-unit-test-proj',
        'constraints/iam.disableServiceAccountKeyCreation',
        'enforced'
      );

      let state = AppStateTracker.loadState();
      expect(state.overriddenOrgPolicies.length).toBe(1);
      expect(state.overriddenOrgPolicies[0].constraint).toBe('constraints/iam.disableServiceAccountKeyCreation');
      expect(state.overriddenOrgPolicies[0].projectId).toBe('target-unit-test-proj');
      expect(state.overriddenOrgPolicies[0].overriddenValue).toBe('enforced');

      // Attempt duplicate recording
      AppStateTracker.recordOrgPolicyOverride(
        'target-unit-test-proj',
        'constraints/iam.disableServiceAccountKeyCreation',
        'enforced'
      );
      state = AppStateTracker.loadState();
      expect(state.overriddenOrgPolicies.length).toBe(1);
    });

    it('should record created service accounts', () => {
      AppStateTracker.recordServiceAccount(
        'test-proj',
        'gemini-dwd-migrator@test-proj.iam.gserviceaccount.com',
        '1092837465'
      );

      const state = AppStateTracker.loadState();
      const match = state.createdServiceAccounts.find(s => s.projectId === 'test-proj');
      expect(match).toBeDefined();
      expect(match?.email).toBe('gemini-dwd-migrator@test-proj.iam.gserviceaccount.com');
      expect(match?.clientId).toBe('1092837465');
    });

    it('should record applied IAM bindings', () => {
      AppStateTracker.recordIamBinding(
        'test-proj',
        'migrator@test-proj.iam.gserviceaccount.com',
        'roles/discoveryengine.admin'
      );

      const state = AppStateTracker.loadState();
      expect(state.appliedIamBindings.length).toBe(1);
      expect(state.appliedIamBindings[0].role).toBe('roles/discoveryengine.admin');
      expect(state.appliedIamBindings[0].projectId).toBe('test-proj');
      expect(state.appliedIamBindings[0].email).toBe('migrator@test-proj.iam.gserviceaccount.com');
    });

    it('should clear tracked state on clearTrackedState()', () => {
      AppStateTracker.recordOrgPolicyOverride(
        'test-proj',
        'constraints/iam.disableServiceAccountKeyCreation'
      );
      expect(AppStateTracker.loadState().overriddenOrgPolicies.length).toBe(1);

      AppStateTracker.clearTrackedState();
      expect(AppStateTracker.loadState().overriddenOrgPolicies.length).toBe(0);
      expect(fs.existsSync(testStatePath)).toBe(false);
    });
  });

  describe('Maintenance Router Endpoints', () => {
    let app: express.Express;
    let server: http.Server;
    let baseUrl: string;

    beforeEach(async () => {
      app = express();
      app.use(express.json());
      app.use('/api', maintenanceRouter);

      await new Promise<void>((resolve) => {
        server = app.listen(0, () => {
          const addr = server.address() as any;
          baseUrl = `http://127.0.0.1:${addr.port}/api`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('GET /api/maintenance/status should return live environment status', async () => {
      AppStateTracker.recordOrgPolicyOverride(
        'unit-proj-123',
        'constraints/iam.disableServiceAccountKeyCreation'
      );

      const res = await fetch(`${baseUrl}/maintenance/status`);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.trackedState).toBeDefined();
      expect(Array.isArray(data.detectedLocalFiles)).toBe(true);
      expect(typeof data.reportCount).toBe('number');
    });

    it('POST /api/cleanup should reject requests without matching confirmProjectId', async () => {
      const res = await fetch(`${baseUrl}/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tgtProjectId: 'prod-target-project',
          confirmProjectId: 'wrong-project'
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('ConfirmationMismatch');
      expect(data.message).toContain('Safety check failed');
    });

    it('POST /api/cleanup should require targetEngine when cleaning custom agents or sessions', async () => {
      const res = await fetch(`${baseUrl}/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tgtProjectId: 'prod-target-project',
          confirmProjectId: 'prod-target-project',
          cleanAgents: true
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('MissingTargetEngine');
      expect(data.message).toContain('Target GE App (Engine) instance must be specified');
    });

    it('POST /api/maintenance/decommission should require target project ID', async () => {
      const res = await fetch(`${baseUrl}/maintenance/decommission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmProjectId: 'DECOMMISSION'
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('MissingProject');
    });

    it('POST /api/maintenance/decommission should reject mismatched confirmProjectId', async () => {
      const res = await fetch(`${baseUrl}/maintenance/decommission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetProjectId: 'target-decom-proj',
          confirmProjectId: 'other-proj'
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('ConfirmationMismatch');
    });

    it('POST /api/maintenance/decommission should execute safely with flags', async () => {
      AppStateTracker.recordOrgPolicyOverride(
        'safe-decom-proj',
        'constraints/iam.disableServiceAccountKeyCreation'
      );

      const res = await fetch(`${baseUrl}/maintenance/decommission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetProjectId: 'safe-decom-proj',
          confirmProjectId: 'safe-decom-proj',
          resetOrgPolicies: false, // skip real gcloud exec in unit test
          removeIamBindings: false,
          deleteServiceAccount: false,
          deleteLocalFiles: false
        })
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.targetProject).toBe('safe-decom-proj');
      expect(data.message).toContain('decommission completed');
    });

    it('GET /api/maintenance/verify-rollback should require target project ID', async () => {
      const res = await fetch(`${baseUrl}/maintenance/verify-rollback`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('MissingProjectId');
    });

    it('GET /api/maintenance/verify-rollback should return verification result when project is provided', async () => {
      const res = await fetch(`${baseUrl}/maintenance/verify-rollback?targetProject=verify-test-proj`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.targetProject).toBe('verify-test-proj');
      expect(Array.isArray(data.checks)).toBe(true);
      expect(data.checks.length).toBeGreaterThanOrEqual(6);
      expect(typeof data.isFullyRolledBack).toBe('boolean');
      expect(['VERIFIED_CLEAN', 'ROLLBACK_INCOMPLETE']).toContain(data.overallStatus);
    }, 15000);

    it('POST /api/maintenance/verify-rollback should return verification result from request body', async () => {
      const res = await fetch(`${baseUrl}/maintenance/verify-rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetProjectId: 'verify-post-proj',
          serviceAccountEmail: 'custom-sa@verify-post-proj.iam.gserviceaccount.com'
        })
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.targetProject).toBe('verify-post-proj');
      expect(data.serviceAccount).toBe('custom-sa@verify-post-proj.iam.gserviceaccount.com');
      expect(data.checks.some((c: any) => c.id === 'org_policy_key_creation')).toBe(true);
      expect(data.checks.some((c: any) => c.id === 'service_account_existence')).toBe(true);
      expect(data.checks.some((c: any) => c.id === 'iam_role_bindings')).toBe(true);
      expect(data.checks.some((c: any) => c.id === 'dwd_delegation_status')).toBe(true);
      expect(data.checks.some((c: any) => c.id === 'local_credential_files')).toBe(true);
      expect(data.checks.some((c: any) => c.id === 'local_output_directories')).toBe(true);
      expect(data.checks.some((c: any) => c.id === 'app_state_tracker')).toBe(true);
    }, 15000);
  });

  describe('validateRollbackCompleteness Engine', () => {
    it('should flag residual state and detect non-clean baseline when state is populated', async () => {
      AppStateTracker.recordOrgPolicyOverride('dirty-proj', 'constraints/iam.disableServiceAccountKeyCreation');
      AppStateTracker.recordServiceAccount('dirty-proj', 'sa@dirty-proj.iam.gserviceaccount.com', '12345');

      const { validateRollbackCompleteness } = await import('../src/routes/maintenance.js');
      const result = await validateRollbackCompleteness({
        targetProject: 'dirty-proj'
      });

      expect(result.success).toBe(true);
      expect(result.targetProject).toBe('dirty-proj');
      const trackerCheck = result.checks.find(c => c.id === 'app_state_tracker');
      expect(trackerCheck).toBeDefined();
      expect(trackerCheck?.passed).toBe(false);
      expect(trackerCheck?.statusText).toBe('Active State Entries');
      expect(result.isFullyRolledBack).toBe(false);
      expect(result.overallStatus).toBe('ROLLBACK_INCOMPLETE');
    }, 15000);
  });
});
