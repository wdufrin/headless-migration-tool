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
import express from 'express';
import http from 'http';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import { classifyImpersonationFailure } from '../src/utils/impersonationFailure.js';
import { wizardRouter } from '../src/routes/wizard.js';

const SA_EMAIL = 'gemini-dwd-migrator@acme-target-proj.iam.gserviceaccount.com';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Experimental Keyless DWD (IAM signJwt)', () => {
  it('mints a user-scoped DWD token via iamcredentials signJwt + oauth2 token exchange without a local key', async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      fetchCalls.push({ url, init });

      if (url.includes('iamcredentials.googleapis.com') && url.endsWith(':signJwt')) {
        return new Response(JSON.stringify({ keyId: 'key-123', signedJwt: 'header.payload.google_signature' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({
            access_token: 'mock-oauth-keyless-dwd-user-token',
            expires_in: 3600,
            token_type: 'Bearer'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('Unexpected URL', { status: 500 });
    });

    const auth = new GcpAuthService({
      staticToken: 'mock-oauth-operator-adc-token',
      dwdServiceAccountEmail: SA_EMAIL,
      dwdClientId: '112233445566778899'
    });

    expect(auth.hasDwdConfigured()).toBe(true);
    expect(auth.isKeylessDwd()).toBe(true);
    expect(auth.getDwdServiceAccountEmail()).toBe(SA_EMAIL);
    expect(auth.getDwdClientId()).toBe('112233445566778899');
    expect(auth.getServiceAccountProjectId()).toBe('acme-target-proj');
    expect(auth.getImpersonationMechanismStatus('alice@company.com', 'DWD')).toEqual({
      available: true,
      reason: `Keyless Domain-Wide Delegation (IAM signJwt) is configured for ${SA_EMAIL}`
    });

    const token = await auth.getAccessToken('alice@company.com');
    expect(token).toBe('mock-oauth-keyless-dwd-user-token');
    expect(auth.getLastUsedImpersonationMode('alice@company.com')).toBe('DWD');

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].url).toBe(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA_EMAIL)}:signJwt`
    );
    const signBody = JSON.parse(String(fetchCalls[0].init?.body));
    const claimSet = JSON.parse(signBody.payload);
    expect(claimSet.iss).toBe(SA_EMAIL);
    expect(claimSet.sub).toBe('alice@company.com');
    expect(claimSet.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claimSet.scope).toContain('discoveryengine.readwrite');

    expect(fetchCalls[1].url).toBe('https://oauth2.googleapis.com/token');
    expect(String(fetchCalls[1].init?.body)).toContain(
      'assertion=header.payload.google_signature'
    );
  });

  it('retries signJwt with x-goog-user-project header when initial call fails with 403 USER_PROJECT_DENIED', async () => {
    const signHeaders: Array<Record<string, string>> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes(':signJwt')) {
        const hdrs = (init?.headers || {}) as Record<string, string>;
        signHeaders.push(hdrs);
        if (!hdrs['x-goog-user-project']) {
          return new Response(
            JSON.stringify({
              error: { code: 403, message: 'USER_PROJECT_DENIED: API requires a quota project.' }
            }),
            { status: 403 }
          );
        }
        return new Response(JSON.stringify({ signedJwt: 'signed.jwt.after_quota_retry' }), { status: 200 });
      }
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'mock-oauth-quota-retry-ok' }), { status: 200 });
      }
      return new Response('Unexpected', { status: 500 });
    });

    const auth = new GcpAuthService({
      staticToken: 'mock-oauth-operator-adc-token',
      dwdServiceAccountEmail: SA_EMAIL
    });

    const token = await auth.mintDwdToken('bob@company.com');
    expect(token).toBe('mock-oauth-quota-retry-ok');
    expect(signHeaders).toHaveLength(2);
    expect(signHeaders[0]['x-goog-user-project']).toBeUndefined();
    expect(signHeaders[1]['x-goog-user-project']).toBe('acme-target-proj');
  });

  it('rejects with actionable error and classifies as MISCONFIGURED (never dropping user data) when signJwt returns 403 permission denied', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: "Permission 'iam.serviceAccounts.signJwt' denied on resource (or it may not exist)."
          }
        }),
        { status: 403 }
      );
    });

    const auth = new GcpAuthService({
      staticToken: 'mock-oauth-operator-without-token-creator',
      dwdServiceAccountEmail: SA_EMAIL
    });

    await expect(auth.getAccessToken('carol@company.com')).rejects.toThrow(
      /Keyless DWD signJwt failed.*roles\/iam\.serviceAccountTokenCreator/
    );

    try {
      await auth.getAccessToken('carol@company.com');
    } catch (err: any) {
      const verdict = classifyImpersonationFailure(err.message);
      expect(verdict.kind).toBe('MISCONFIGURED');
      expect(verdict.safeToDropData).toBe(false);
    }
  });

  it('rejects when signJwt returns HTTP 200 without a signedJwt field', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ keyId: 'empty-response' }), { status: 200 });
    });

    const auth = new GcpAuthService({
      staticToken: 'mock-oauth-operator-token',
      dwdServiceAccountEmail: SA_EMAIL
    });

    await expect(auth.mintDwdToken('dave@company.com')).rejects.toThrow(/without a signedJwt field/);
  });

  it('rejects invalid service account emails in POST /api/wizard/configure-keyless-dwd', async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.use('/api', wizardRouter);

    const server = http.createServer(testApp);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const res1 = await fetch(`${baseUrl}/api/wizard/configure-keyless-dwd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceAccountEmail: 'not-a-service-account@company.com' })
      });
      const body1: any = await res1.json();

      expect(res1.status).toBe(400);
      expect(body1.error).toBe('InvalidServiceAccountEmail');
      expect(body1.success).toBe(false);

      const res2 = await fetch(`${baseUrl}/api/wizard/configure-keyless-dwd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceAccountEmail: '' })
      });
      const body2: any = await res2.json();

      expect(res2.status).toBe(400);
      expect(body2.error).toBe('InvalidServiceAccountEmail');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
