import { describe, it, expect, vi } from 'vitest';
import { validateEnvironmentConfig, getSafeDiscoveryEngineUrl, SecurityValidationError } from '../src/security/validator.js';
import { extractBearerToken, sanitizeHeadersForLogging } from '../src/security/headers.js';

describe('Security Layer & SSRF Protection (Mitigation #1)', () => {
  it('should accept valid GCP regions and alphanumeric project IDs', () => {
    expect(() => {
      validateEnvironmentConfig({
        projectId: 'fedex-test-project-123',
        appLocation: 'global',
        collectionId: 'default_collection',
        appId: 'test_engine_1',
        assistantId: 'default_assistant'
      });
    }).not.toThrow();

    expect(() => {
      validateEnvironmentConfig({
        projectId: 'prod-analytics-456',
        appLocation: 'us',
        appId: 'chat_engine'
      });
    }).not.toThrow();

    expect(() => {
      validateEnvironmentConfig({
        projectId: 'prod-eu-789',
        appLocation: 'eu',
        appId: 'chat_engine'
      });
    }).not.toThrow();
  });

  it('should reject invalid or malicious GCP regions (SSRF attack prevention)', () => {
    expect(() => {
      validateEnvironmentConfig({
        projectId: 'valid-project',
        appLocation: 'attacker.com/steal?q=',
        appId: 'engine1'
      });
    }).toThrow(SecurityValidationError);

    expect(() => {
      validateEnvironmentConfig({
        projectId: 'valid-project',
        appLocation: 'us-central1',
        appId: 'engine1'
      });
    }).toThrow(/Invalid or unapproved/);

    expect(() => {
      validateEnvironmentConfig({
        projectId: 'valid-project',
        appLocation: 'evil-region',
        appId: 'engine1'
      });
    }).toThrow(/Invalid or unapproved/);
  });

  it('should reject project IDs with invalid characters', () => {
    expect(() => {
      validateEnvironmentConfig({
        projectId: 'bad_project!@#',
        appLocation: 'global',
        appId: 'engine1'
      });
    }).toThrow(SecurityValidationError);
  });

  it('should construct correct and safe Discovery Engine base URLs', () => {
    expect(getSafeDiscoveryEngineUrl('global')).toBe('https://discoveryengine.googleapis.com');
    expect(getSafeDiscoveryEngineUrl('us')).toBe('https://us-discoveryengine.googleapis.com');
    expect(getSafeDiscoveryEngineUrl('EU')).toBe('https://eu-discoveryengine.googleapis.com');
  });
});

describe('Header Transport & Token Redaction (Mitigation #4)', () => {
  it('should extract Bearer tokens from authorization header', () => {
    expect(extractBearerToken('Bearer mock-test-token-value')).toBe('mock-test-token-value');
    expect(extractBearerToken('bearer mock-test-token-value')).toBe('mock-test-token-value');
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('should redact sensitive tokens in headers before logging', () => {
    const headers = {
      'Authorization': 'Bearer mock-super-secret-token',
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': 'mock-secret-api-key',
      'User-Agent': 'Vitest-Agent'
    };

    const sanitized = sanitizeHeadersForLogging(headers);
    expect(sanitized['Authorization']).toBe('[REDACTED]');
    expect(sanitized['X-Goog-Api-Key']).toBe('[REDACTED]');
    expect(sanitized['Content-Type']).toBe('application/json');
  });
});

describe('Phase 1 Security & Identity Lockdown Tests', () => {
  it('Fix 1.1: ALLOWED_MIGRATION_ROLES should strictly allow only migration roles and reject dangerous privilege escalation', async () => {
    const { ALLOWED_MIGRATION_ROLES } = await import('../src/routes/wizard.js');

    // Approved least-privilege roles
    expect(ALLOWED_MIGRATION_ROLES.has('roles/discoveryengine.viewer')).toBe(true);
    expect(ALLOWED_MIGRATION_ROLES.has('roles/discoveryengine.editor')).toBe(true);
    expect(ALLOWED_MIGRATION_ROLES.has('roles/discoveryengine.admin')).toBe(true);
    expect(ALLOWED_MIGRATION_ROLES.has('roles/serviceusage.serviceUsageConsumer')).toBe(true);
    expect(ALLOWED_MIGRATION_ROLES.has('roles/iam.serviceAccountTokenCreator')).toBe(true);

    // Dangerous / Over-privileged roles that MUST be rejected
    expect(ALLOWED_MIGRATION_ROLES.has('roles/owner')).toBe(false);
    expect(ALLOWED_MIGRATION_ROLES.has('roles/editor')).toBe(false);
    expect(ALLOWED_MIGRATION_ROLES.has('roles/resourcemanager.organizationAdmin')).toBe(false);
    expect(ALLOWED_MIGRATION_ROLES.has('roles/iam.securityAdmin')).toBe(false);
    expect(ALLOWED_MIGRATION_ROLES.has('roles/viewer')).toBe(false);
  });

  it('Fix 1.4: GcpAuthService should fail-closed and throw on user impersonation rather than leaking admin token', async () => {
    const { GcpAuthService } = await import('../src/services/gcpAuth.js');
    // Service configured with ambient static token, but NO DWD service account key
    const authService = new GcpAuthService({ staticToken: 'admin-ambient-token' });
    // Mock workforce federation to return undefined to test pure DWD fail-closed path
    vi.spyOn(authService, 'mintWorkforceToken').mockResolvedValue(undefined);

    // Administrative / engine-level call without user succeeds with ambient credentials
    const adminToken = await authService.getAccessToken();
    expect(adminToken).toBe('admin-ambient-token');

    // Explicit user impersonation MUST fail-closed to prevent leaking admin memories to employees
    await expect(authService.getAccessToken('employee@company.com')).rejects.toThrow(
      /DWD Impersonation Failed for user "employee@company.com"/
    );
  });

  it('Fix 1.5: executeTargetAssetCleanup should block destruction when targetProject matches sourceProject', async () => {
    const { executeTargetAssetCleanup } = await import('../src/routes/maintenance.js');

    await expect(executeTargetAssetCleanup({
      sourceProject: 'prod-source-project',
      targetProject: 'prod-source-project'
    })).rejects.toThrow(
      /Destructive asset cleanup is blocked to prevent accidental deletion/
    );
  });

  it('Fix 1.3: PermissionAuditor should truthfully record MISSING when Discovery Engine endpoints fail', async () => {
    const { GcpAuthService } = await import('../src/services/gcpAuth.js');
    const { PermissionAuditor } = await import('../src/services/permissionAuditor.js');

    const authService = new GcpAuthService({ staticToken: 'test-token' });
    const auditor = new PermissionAuditor(authService);

    // Mock fetch to simulate 403 / 404 failure from Discovery Engine
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'Permission denied'
    } as any);

    const report = await auditor.audit({
      sourceProject: 'test-src',
      sourceLocation: 'global',
      sourceAppId: 'test-engine',
      targetProject: 'test-tgt',
      targetLocation: 'global',
      targetAppId: 'test-tgt-engine'
    });

    fetchSpy.mockRestore();

    const sessionPerm = report.permissions.find(p => p.id === 'SRC_SESSIONS_READ');
    const targetEnginePerm = report.permissions.find(p => p.id === 'TGT_ENGINE_VERIFY');

    expect(sessionPerm).toBeDefined();
    expect(sessionPerm?.status).toBe('MISSING');

    expect(targetEnginePerm).toBeDefined();
    expect(targetEnginePerm?.status).toBe('MISSING');

    expect(report.summary.totalMissing).toBeGreaterThan(0);
    expect(report.overallGrade).not.toBe('A+');
  });
});
