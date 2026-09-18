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

  describe('Fix 1.7: mintWorkforceToken STS scope handling', () => {
    const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform';

    /**
     * Builds a GcpAuthService with a real signing key and a scripted STS.
     * `stsResponder` receives the attempt index (0-based) and the parsed request body.
     */
    async function withMockedSts(
      stsResponder: (attempt: number, body: any) => { ok: boolean; status: number; payload: any }
    ) {
      const { GcpAuthService } = await import('../src/services/gcpAuth.js');
      const authService = new GcpAuthService({
        wifConfigJson: {
          type: 'external_account',
          audience: '//iam.googleapis.com/locations/global/workforcePools/test-pool/providers/migration-dwd-provider',
          token_url: 'https://sts.googleapis.com/v1/token',
          credential_source: { file: './idp-subject-token.jwt' }
        }
      });

      const crypto = await import('crypto');
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      });

      const fs = await import('fs');
      const existsSpy = vi.spyOn(fs.default, 'existsSync').mockImplementation((p: any) => p === 'wif-migration-key.pem');
      const readSpy = vi.spyOn(fs.default, 'readFileSync').mockImplementation((p: any) => {
        if (p === 'wif-migration-key.pem') return privateKey;
        return '';
      });

      const scopes: string[] = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, opts: any) => {
        if (typeof url !== 'string' || !url.includes('sts.googleapis.com')) {
          throw new Error(`Unexpected fetch to ${String(url)} -- the test only scripts STS.`);
        }
        const body = JSON.parse(opts.body);
        const attempt = scopes.length;
        scopes.push(body.scope);
        const { ok, status, payload } = stsResponder(attempt, body);
        return {
          ok,
          status,
          json: async () => payload,
          text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload))
        } as any;
      });

      const restore = () => {
        fetchSpy.mockRestore();
        existsSpy.mockRestore();
        readSpy.mockRestore();
      };

      return { authService, scopes, restore };
    }

    it('requests cloud-platform by default, because iamcredentials rejects Discovery-Engine-only tokens', async () => {
      const { authService, scopes, restore } = await withMockedSts(() => ({
        ok: true,
        status: 200,
        payload: { access_token: 'default-scope-token' }
      }));

      try {
        const token = await authService.mintWorkforceToken('user@company.com');
        expect(token).toBe('default-scope-token');
        expect(scopes.length).toBe(1);
        // Regression guard: narrowing this default produced a token that STS accepts
        // but generateAccessToken rejects with "insufficient authentication scopes".
        expect(scopes[0]).toContain(CLOUD_PLATFORM);
      } finally {
        restore();
      }
    });

    it('honours caller-supplied narrow scopes verbatim (least privilege is opt-in)', async () => {
      const { authService, scopes, restore } = await withMockedSts(() => ({
        ok: true,
        status: 200,
        payload: { access_token: 'narrow-scope-token' }
      }));

      try {
        const token = await authService.mintWorkforceToken('user@company.com', undefined, [
          'https://www.googleapis.com/auth/discoveryengine.readwrite'
        ]);
        expect(token).toBe('narrow-scope-token');
        expect(scopes).toEqual(['https://www.googleapis.com/auth/discoveryengine.readwrite']);
        expect(scopes[0]).not.toContain(CLOUD_PLATFORM);
      } finally {
        restore();
      }
    });

    it('retries with cloud-platform when STS rejects the scopes with invalid_scope', async () => {
      const { authService, scopes, restore } = await withMockedSts((attempt) =>
        attempt === 0
          ? { ok: false, status: 400, payload: { error: 'invalid_scope', error_description: 'Invalid OAuth scope' } }
          : { ok: true, status: 200, payload: { access_token: 'retry-token' } }
      );

      try {
        const token = await authService.mintWorkforceToken('user@company.com', undefined, [
          'https://www.googleapis.com/auth/some-scope-sts-hates'
        ]);
        expect(token).toBe('retry-token');
        expect(scopes.length).toBe(2);
        expect(scopes[1]).toBe(CLOUD_PLATFORM);
      } finally {
        restore();
      }
    });

    it('does NOT retry when STS fails for a reason unrelated to scope', async () => {
      // A bad audience / unknown provider is not fixable by changing scope. Retrying
      // would double the latency and bury the real error.
      const { authService, scopes, restore } = await withMockedSts(() => ({
        ok: false,
        status: 400,
        payload: { error: 'invalid_request', error_description: 'Invalid value for "audience"' }
      }));

      try {
        const token = await authService.mintWorkforceToken('user@company.com');
        expect(token).toBeUndefined();
        expect(scopes.length).toBe(1);
      } finally {
        restore();
      }
    });

    it('does not retry indefinitely when the retry itself fails', async () => {
      const { authService, scopes, restore } = await withMockedSts(() => ({
        ok: false,
        status: 400,
        payload: { error: 'invalid_scope', error_description: 'Invalid OAuth scope' }
      }));

      try {
        const token = await authService.mintWorkforceToken('user@company.com', undefined, ['https://example.invalid/scope']);
        expect(token).toBeUndefined();
        expect(scopes.length).toBe(2);
      } finally {
        restore();
      }
    });

    it('treats HTTP 200 without an access_token as a failure, not success', async () => {
      const { authService, restore } = await withMockedSts(() => ({
        ok: true,
        status: 200,
        payload: { issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' }
      }));

      try {
        await expect(authService.mintWorkforceToken('user@company.com')).resolves.toBeUndefined();
      } finally {
        restore();
      }
    });
  });
});

