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

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import { DiscoveryEngineClient } from '../src/services/discoveryEngine.js';
import { logger } from '../src/utils/logger.js';

/**
 * Regression suite for the false "retrying with DWD impersonation token" log.
 *
 * Reported by a customer (GE Appliances). Their log showed, per user:
 *
 *   [INFO] Minted GCP Workforce Identity Token for "X" via migration-dwd-provider.
 *   [INFO] Minted GCP Workforce Identity Token for "X" via migration-dwd-provider.
 *   [INFO] Permission denied with initial token for "X"; retrying request with DWD
 *          impersonation token...
 *
 * They had no Domain-Wide Delegation service account key. The retry guard compared
 * access token STRINGS; re-minting via the SAME mechanism yields a different string
 * (the JWT `iat` advances), so the guard passed, the log claimed DWD, and the request
 * was retried with another Workforce Identity token -- the same credential class --
 * guaranteeing an identical 403.
 */

const SA_KEY = {
  client_email: 'migrator@example-project.iam.gserviceaccount.com',
  private_key: 'unused-in-these-tests',
  project_id: 'example-project'
};

const WIF_CONFIG = {
  type: 'external_account',
  audience: '//iam.googleapis.com/locations/global/workforcePools/test-pool/providers/migration-dwd-provider',
  token_url: 'https://sts.googleapis.com/v1/token',
  credential_source: { file: './idp-subject-token.jwt' }
};

const DENIED_BODY = JSON.stringify({
  error: {
    code: 403,
    status: 'PERMISSION_DENIED',
    message: 'Permission "discoveryengine.notebooks.list" denied on resource projects/acme/locations/global.'
  }
});

function makeAuth(opts: { withSaKey: boolean; withWifKeyOnDisk: boolean }) {
  const auth = new GcpAuthService({
    wifConfigJson: WIF_CONFIG,
    authType: 'WORKFORCE_IDENTITY_FEDERATION',
    ...(opts.withSaKey ? { serviceAccountKeyJson: SA_KEY } : {})
  } as any);

  // getImpersonationMechanismStatus probes the signing key on disk. Pin it so the
  // result does not depend on whether the developer's repo happens to contain one.
  vi.spyOn(fs, 'existsSync').mockImplementation(
    (p: any) => (p === 'wif-migration-key.pem' ? opts.withWifKeyOnDisk : false)
  );

  return auth;
}

/** Captures log output so we can assert on what an operator would actually see. */
function captureLogs() {
  const lines: string[] = [];
  const record = (level: string) => (msg: any) => {
    lines.push(`[${level}] ${String(msg)}`);
  };
  const spies = [
    vi.spyOn(logger, 'info').mockImplementation(record('INFO')),
    vi.spyOn(logger, 'warn').mockImplementation(record('WARN')),
    vi.spyOn(logger, 'debug').mockImplementation(record('DEBUG'))
  ];
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GcpAuthService.getImpersonationMechanismStatus', () => {
  it('reports DWD unavailable, with a reason, when no service account key is configured', () => {
    const auth = makeAuth({ withSaKey: false, withWifKeyOnDisk: true });
    const status = auth.getImpersonationMechanismStatus('dharuna.selvaraj@geappliances.com', 'DWD');

    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/no Service Account Key/i);
  });

  it('reports DWD unavailable for external IdP identities even when a key IS configured', () => {
    const auth = makeAuth({ withSaKey: true, withWifKeyOnDisk: true });

    for (const email of ['user@contoso.onmicrosoft.com', 'person@okta-corp.com', 'someone@entra-tenant.net']) {
      const status = auth.getImpersonationMechanismStatus(email, 'DWD');
      expect(status.available, `${email} should not be DWD-impersonable`).toBe(false);
      expect(status.reason).toMatch(/external IdP/i);
    }
  });

  it('reports DWD available for a normal Workspace domain when a key is configured', () => {
    const auth = makeAuth({ withSaKey: true, withWifKeyOnDisk: true });
    expect(auth.getImpersonationMechanismStatus('user@company.com', 'DWD').available).toBe(true);
  });

  it('reports WIF unavailable, with a reason, when the signing key is absent', () => {
    const auth = makeAuth({ withSaKey: true, withWifKeyOnDisk: false });
    const status = auth.getImpersonationMechanismStatus('user@company.com', 'WIF');

    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/wif-migration-key\.pem/);
  });
});

describe('DiscoveryEngineClient 403 impersonation retry', () => {
  /** Drives the real private request() path so the production logic is exercised. */
  function request(client: DiscoveryEngineClient, userEmail: string) {
    return (client as any).request(
      'https://discoveryengine.googleapis.com/v1/projects/acme/locations/global/notebooks',
      'GET',
      undefined,
      undefined,
      undefined,
      userEmail
    );
  }

  it('GE Appliances case: does NOT claim a DWD retry when no DWD key exists', async () => {
    const auth = makeAuth({ withSaKey: false, withWifKeyOnDisk: true });
    // Each call returns a DIFFERENT string, exactly like re-minting a JWT whose `iat`
    // has advanced. The old string-comparison guard was fooled by precisely this.
    let mint = 0;
    vi.spyOn(auth, 'getAccessToken').mockImplementation(async () => `wif-token-${++mint}`);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => DENIED_BODY
    } as any);

    const { lines, restore } = captureLogs();
    const client = new DiscoveryEngineClient(auth);

    try {
      await expect(request(client, 'dharuna.selvaraj@geappliances.com')).rejects.toThrow(/403/);

      // The decisive assertion: exactly ONE HTTP call. The old code made two.
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const joined = lines.join('\n');
      expect(joined).not.toMatch(/retrying (request )?with DWD impersonation token/i);
      expect(joined).toMatch(/no DWD fallback is possible/i);
      expect(joined).toMatch(/no Service Account Key/i);
    } finally {
      restore();
    }
  });

  it('surfaces the original 403 message so the failure is diagnosable from logs alone', async () => {
    const auth = makeAuth({ withSaKey: false, withWifKeyOnDisk: true });
    vi.spyOn(auth, 'getAccessToken').mockResolvedValue('wif-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => DENIED_BODY
    } as any);

    const { lines, restore } = captureLogs();
    const client = new DiscoveryEngineClient(auth);

    try {
      await expect(request(client, 'vishnu.prasad@geappliances.com')).rejects.toThrow();
      // Previously the first 403 body was discarded entirely, making it impossible to
      // tell a missing role from a wrong principal from a quota-project problem.
      expect(lines.join('\n')).toContain('discoveryengine.notebooks.list');
    } finally {
      restore();
    }
  });

  it('still performs a genuine retry when the alternate mechanism IS configured', async () => {
    const auth = makeAuth({ withSaKey: true, withWifKeyOnDisk: true });
    const modes: Array<string | undefined> = [];
    vi.spyOn(auth, 'getAccessToken').mockImplementation(async (_e, _s, mode) => {
      modes.push(mode);
      return mode === 'DWD' ? 'dwd-token' : 'wif-token';
    });

    let call = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return { ok: false, status: 403, statusText: 'Forbidden', text: async () => DENIED_BODY } as any;
      }
      return { ok: true, status: 200, json: async () => ({ notebooks: [] }) } as any;
    });

    const { lines, restore } = captureLogs();
    const client = new DiscoveryEngineClient(auth);

    try {
      await expect(request(client, 'user@company.com')).resolves.toEqual({ notebooks: [] });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(modes).toContain('DWD');
      expect(lines.join('\n')).toMatch(/retrying with DWD impersonation token/i);
    } finally {
      restore();
    }
  });

  it('does not retry when the alternate mechanism is unavailable for an external IdP user', async () => {
    // SA key present, but an Okta identity cannot be DWD-impersonated.
    const auth = makeAuth({ withSaKey: true, withWifKeyOnDisk: true });
    vi.spyOn(auth, 'getAccessToken').mockImplementation(async () => `tok-${Math.random()}`);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => DENIED_BODY
    } as any);

    const { lines, restore } = captureLogs();
    const client = new DiscoveryEngineClient(auth);

    try {
      await expect(request(client, 'contractor@okta-partner.com')).rejects.toThrow();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(lines.join('\n')).toMatch(/external IdP/i);
    } finally {
      restore();
    }
  });

  it('reports plainly when the configured fallback throws instead of silently swallowing it', async () => {
    const auth = makeAuth({ withSaKey: true, withWifKeyOnDisk: true });
    vi.spyOn(auth, 'getAccessToken').mockImplementation(async (_e, _s, mode) => {
      if (mode === 'DWD') throw new Error('unauthorized_client: client not authorized for scopes');
      return 'wif-token';
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => DENIED_BODY
    } as any);

    const { lines, restore } = captureLogs();
    const client = new DiscoveryEngineClient(auth);

    try {
      await expect(request(client, 'user@company.com')).rejects.toThrow();
      const joined = lines.join('\n');
      expect(joined).toMatch(/DWD fallback failed/i);
      expect(joined).toMatch(/unauthorized_client/);
    } finally {
      restore();
    }
  });
});
