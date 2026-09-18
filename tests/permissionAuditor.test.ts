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

/**
 * PermissionAuditor verdict-integrity suite.
 *
 * The auditor grades a customer's security posture. Every verdict it emits must be
 * backed by an observation it actually made. These tests exist because it previously
 * emitted:
 *   - GRANTED "Organization policy allows service account key creation" when the
 *     org-policy read had failed with PERMISSION_DENIED,
 *   - SAFE "Source environment is immutable. No destructive teardown permissions
 *     exposed." without performing any check at all,
 *   - GRANTED "External IdP user successfully mapped to target identity" with no check,
 *   - and labelled cloud-platform, the broadest GCP scope, "Recommended Least-Privilege".
 *
 * Each test below drives a real code path and asserts on observable output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORG_POLICY_DENIED =
  "ERROR: (gcloud.org-policies.describe) PERMISSION_DENIED: Permission 'orgpolicy.policy.get' denied";

/** Controls what the mocked `gcloud org-policies describe` does for a given constraint. */
let orgPolicyBehavior: (constraint: string) => { stdout: string } | Error;

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (cmd: string, args: string[], cb: any) => {
      const constraint = (args || []).find((a) => a.startsWith('constraints/')) || '';
      const result = orgPolicyBehavior(constraint);
      if (result instanceof Error) {
        // Mirror the real failure shape: gcloud writes the reason to stderr.
        const err: any = result;
        err.stderr = result.message;
        setImmediate(() => cb(err, null));
      } else {
        setImmediate(() => cb(null, { stdout: result.stdout, stderr: '' }));
      }
      return {} as any;
    }
  };
});

const enforcedPolicy = (constraint: string) =>
  JSON.stringify({ name: constraint, spec: { rules: [{ enforce: true }] } });
const unenforcedPolicy = (constraint: string) =>
  JSON.stringify({ name: constraint, spec: { rules: [{ enforce: false }] } });

interface FetchPlan {
  /** Scopes reported by the tokeninfo endpoint. Omit to skip the scope audit entirely. */
  scopes?: string[];
  /** Destructive permissions testIamPermissions should report as HELD. */
  heldDestructive?: string[];
  /** Force testIamPermissions to fail with this HTTP status. */
  testIamStatus?: number;
}

function installFetch(plan: FetchPlan) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: any, init?: any) => {
    const u = String(url);

    if (u.includes('tokeninfo')) {
      if (!plan.scopes) return { ok: false, status: 400, text: async () => 'no scopes' } as any;
      return { ok: true, status: 200, json: async () => ({ scope: plan.scopes!.join(' ') }) } as any;
    }

    if (u.includes('testIamPermissions')) {
      if (plan.testIamStatus) {
        return {
          ok: false,
          status: plan.testIamStatus,
          text: async () => 'probe rejected'
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ permissions: plan.heldDestructive ?? [] })
      } as any;
    }

    // Discovery Engine endpoints: irrelevant to these assertions.
    return { ok: false, status: 403, statusText: 'Forbidden', text: async () => 'denied' } as any;
  }) as any);
}

async function runAudit(plan: FetchPlan, overrides: Record<string, any> = {}) {
  const { PermissionAuditor } = await import('../src/services/permissionAuditor.js');
  const fetchSpy = installFetch(plan);
  // A stub auth service keeps gcloud/ADC out of the auth path so these tests are hermetic.
  const auditor = new PermissionAuditor({ getAccessToken: async () => 'stub-token' } as any);

  try {
    return await auditor.audit({
      authMode: 'dwd',
      sourceIdp: 'google',
      targetIdp: 'google',
      sourceProject: 'src-proj',
      sourceLocation: 'global',
      sourceAppId: 'src-engine',
      targetProject: 'tgt-proj',
      targetLocation: 'global',
      targetAppId: 'tgt-engine',
      sourceUserEmail: 'user@example.com',
      targetUserEmail: 'user@example.com',
      ...overrides
    });
  } finally {
    fetchSpy.mockRestore();
  }
}

const find = (report: any, id: string) => report.permissions.find((p: any) => p.id === id);

describe('PermissionAuditor verdict integrity', () => {
  beforeEach(() => {
    // Default: every org policy reads successfully and is NOT enforced.
    orgPolicyBehavior = (c) => ({ stdout: unenforcedPolicy(c) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Org policy reads', () => {
    it('reports UNKNOWN - never GRANTED - when the org policy read is denied', async () => {
      orgPolicyBehavior = () => new Error(ORG_POLICY_DENIED);

      const report = await runAudit({});
      const item = find(report, 'ORG_POLICY_KEY_CREATION');

      expect(item).toBeDefined();
      expect(item.status).toBe('UNKNOWN');
      // The operator must be able to see WHY it could not be determined.
      expect(item.details).toContain('PERMISSION_DENIED');
      // The old fabricated sentence must never reappear.
      expect(item.details).not.toMatch(/policy allows service account key creation/i);
      expect(item.remediation).toMatch(/orgpolicy/i);
      expect(report.summary.totalUnknown).toBeGreaterThan(0);
    });

    it('does not credit an unreadable policy to the granted count', async () => {
      orgPolicyBehavior = () => new Error(ORG_POLICY_DENIED);
      const denied = await runAudit({});

      // Re-arm the mock so this run differs ONLY in org-policy readability.
      orgPolicyBehavior = (c) => ({ stdout: unenforcedPolicy(c) });
      const readable = await runAudit({});

      expect(denied.summary.totalGranted).toBeLessThan(readable.summary.totalGranted);
      expect(denied.summary.totalUnknown).toBeGreaterThan(readable.summary.totalUnknown);
    });


    it('still reports GRANTED when the policy genuinely reads back as unenforced', async () => {
      // Guards against "fix everything to UNKNOWN", which would be equally dishonest.
      const report = await runAudit({});
      const item = find(report, 'ORG_POLICY_KEY_CREATION');

      expect(item.status).toBe('GRANTED');
      expect(item.details).toMatch(/Verified/i);
    });

    it('reports MISSING when key creation is actively enforced', async () => {
      orgPolicyBehavior = (c) =>
        c.includes('disableServiceAccountKeyCreation')
          ? { stdout: enforcedPolicy(c) }
          : { stdout: unenforcedPolicy(c) };

      const report = await runAudit({});
      const item = find(report, 'ORG_POLICY_KEY_CREATION');

      expect(item.status).toBe('MISSING');
      expect(report.summary.totalMissing).toBeGreaterThan(0);
    });

    it('treats an enforced cross-project constraint as INFO, not as a granted permission', async () => {
      orgPolicyBehavior = (c) =>
        c.includes('disableCrossProjectServiceAccountUsage')
          ? { stdout: enforcedPolicy(c) }
          : { stdout: unenforcedPolicy(c) };

      const report = await runAudit({});
      const item = find(report, 'ORG_POLICY_CROSS_PROJECT');

      expect(item).toBeDefined();
      expect(item.status).toBe('INFO');
      // An org constraint that restricts us is not a permission we hold.
      expect(item.status).not.toBe('GRANTED');
      expect(item.remediation).toBeTruthy();
    });
  });

  describe('Source destructive-permission exposure', () => {
    it('reports OVER_PROVISIONED when the principal really holds delete permissions', async () => {
      const report = await runAudit({
        heldDestructive: ['discoveryengine.engines.delete', 'discoveryengine.documents.delete']
      });
      const item = find(report, 'SEC_DESTRUCTIVE_ENGINE_DELETE');

      expect(item.status).toBe('OVER_PROVISIONED');
      expect(item.level).toBe('DANGEROUS');
      expect(item.details).toContain('discoveryengine.engines.delete');
      expect(report.summary.totalOverProvisioned).toBeGreaterThan(0);
    });

    it('never claims the source is immutable', async () => {
      // The exact fabricated claim that shipped previously.
      const report = await runAudit({
        heldDestructive: ['discoveryengine.engines.delete']
      });

      for (const p of report.permissions) {
        expect(p.details).not.toMatch(/source environment is immutable/i);
        expect(p.details).not.toMatch(/no destructive teardown permissions exposed/i);
      }
    });

    it('reports GRANTED only when the probe actually returns an empty permission set', async () => {
      const report = await runAudit({ heldDestructive: [] });
      const item = find(report, 'SEC_DESTRUCTIVE_ENGINE_DELETE');

      expect(item.status).toBe('GRANTED');
      expect(item.details).toMatch(/testIamPermissions/);
    });

    it('reports UNKNOWN when the probe itself fails', async () => {
      const report = await runAudit({ testIamStatus: 403 });
      const item = find(report, 'SEC_DESTRUCTIVE_ENGINE_DELETE');

      expect(item.status).toBe('UNKNOWN');
      expect(item.details).toMatch(/must NOT be assumed read-only/i);
      expect(report.summary.totalUnknown).toBeGreaterThan(0);
    });
  });

  describe('OAuth scope classification', () => {
    const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform';

    it('never describes cloud-platform as least-privilege', async () => {
      const report = await runAudit({ scopes: [CLOUD_PLATFORM] });
      const entry = report.scopesAudit.find((s: any) => s.scope === CLOUD_PLATFORM);

      expect(entry).toBeDefined();
      // The shipped text was "Full Google Cloud API Gateway (Recommended Least-Privilege Scope)".
      // Reject any POSITIVE least-privilege claim, while allowing the corrected wording
      // which explicitly says it is NOT least-privilege.
      expect(entry.description).not.toMatch(/recommended least.privilege/i);
      expect(entry.description).toMatch(/not least.privilege/i);
      expect(entry.description).toMatch(/broadest/i);
      expect(entry.status).toBe('BROAD');
      expect(entry.status).not.toBe('ALLOWED');
    });


    it('flags cloud-platform as over-provisioned in DWD mode', async () => {
      const report = await runAudit({ scopes: [CLOUD_PLATFORM] });
      const item = find(report, 'SCOPE_BROAD_CLOUD_PLATFORM');

      expect(item.status).toBe('OVER_PROVISIONED');
      expect(item.level).toBe('DANGEROUS');
      expect(report.summary.totalOverProvisioned).toBeGreaterThan(0);
    });

    it('still flags genuinely dangerous scopes such as full Drive access', async () => {
      const report = await runAudit({
        scopes: [CLOUD_PLATFORM, 'https://www.googleapis.com/auth/drive']
      });
      const drive = report.scopesAudit.find((s: any) => s.scope.endsWith('/auth/drive'));

      expect(drive.status).toBe('EXCESSIVE');
      expect(report.summary.totalOverProvisioned).toBeGreaterThanOrEqual(2);
    });
  });

  describe('WiF cross-IdP identity resolution', () => {
    it('does not claim identity mapping succeeded when no audience is configured', async () => {
      const report = await runAudit(
        {},
        {
          authMode: 'wif',
          sourceIdp: 'wif',
          wifConfigPath: '/nonexistent/workforce-identity-config.json'
        }
      );

      const mapping = find(report, 'AUTH_WIF_MAPPING');
      expect(mapping.status).toBe('UNKNOWN');
      expect(mapping.status).not.toBe('GRANTED');
      expect(mapping.details).not.toMatch(/successfully mapped/i);
    });

    it('does not report a missing WiF config file as GRANTED', async () => {
      const report = await runAudit(
        {},
        {
          authMode: 'wif',
          sourceIdp: 'wif',
          wifConfigPath: '/nonexistent/workforce-identity-config.json'
        }
      );

      const cfg = find(report, 'AUTH_WIF_CONFIG');
      expect(cfg.status).toBe('UNKNOWN');
      expect(cfg.status).not.toBe('GRANTED');
    });
  });

  describe('Grading honesty', () => {
    it('cannot grade LEAST_PRIVILEGE_COMPLIANT while checks remain unverified', async () => {
      orgPolicyBehavior = () => new Error(ORG_POLICY_DENIED);

      const report = await runAudit({ heldDestructive: [] });

      expect(report.summary.totalUnknown).toBeGreaterThan(0);
      expect(report.overallStatus).not.toBe('LEAST_PRIVILEGE_COMPLIANT');
      expect(report.overallGrade).not.toBe('A+');
    });

    it('excludes INFO items from the score denominator so context cannot dilute findings', async () => {
      orgPolicyBehavior = (c) =>
        c.includes('disableCrossProjectServiceAccountUsage')
          ? { stdout: enforcedPolicy(c) }
          : { stdout: unenforcedPolicy(c) };

      const report = await runAudit({ heldDestructive: [] });
      const infoCount = report.permissions.filter((p: any) => p.status === 'INFO').length;

      expect(infoCount).toBeGreaterThan(0);
      // totalChecked still lists everything, but INFO must not be counted as granted.
      expect(report.summary.totalGranted + report.summary.totalMissing + report.summary.totalUnknown +
        report.summary.totalOverProvisioned + infoCount).toBe(report.summary.totalChecked);
    });

    it('reports totalUnknown so an incomplete audit is visible to the operator', async () => {
      orgPolicyBehavior = () => new Error(ORG_POLICY_DENIED);
      const report = await runAudit({ testIamStatus: 500 });

      expect(report.summary).toHaveProperty('totalUnknown');
      expect(report.summary.totalUnknown).toBeGreaterThanOrEqual(2);
    });
  });
});
