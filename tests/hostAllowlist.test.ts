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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createHostAllowlistMiddleware, parseHostname } from '../src/security/hostAllowlist.js';

/**
 * These tests drive a real HTTP server over a real socket, because the whole point
 * of the control is the raw `Host` header. `fetch` (undici) treats `Host` as a
 * forbidden header and silently refuses to override it, so a fetch-based test
 * would assert nothing. `http.request` lets us forge it the way a rebinding
 * attack actually would.
 */

/** Tracks whether the protected handler actually executed its side effect. */
let sideEffectCount = 0;

let server: http.Server;
let port: number;

function rawRequest(
  hostHeader: string | null,
  requestPath = '/api/destructive'
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (hostHeader !== null) {
      headers.Host = hostHeader;
    }

    const req = http.request(
      // setHost:false stops Node from helpfully adding its own Host header, which
      // would have masked the no-Host case entirely.
      { host: '127.0.0.1', port, path: requestPath, method: 'GET', headers, setHost: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const app = express();
  app.use(
    '/api',
    createHostAllowlistMiddleware({
      boundHost: '127.0.0.1',
      additionalHostnames: ['console.internal.example']
    })
  );
  app.get('/api/destructive', (_req, res) => {
    sideEffectCount += 1;
    res.status(200).json({ ok: true });
  });

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as any).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

describe('parseHostname', () => {
  it('strips the port from an IPv4 host', () => {
    expect(parseHostname('127.0.0.1:8080')).toBe('127.0.0.1');
  });

  it('handles a hostname with no port', () => {
    expect(parseHostname('localhost')).toBe('localhost');
  });

  it('handles bracketed IPv6 with and without a port', () => {
    expect(parseHostname('[::1]:8080')).toBe('[::1]');
    expect(parseHostname('[::1]')).toBe('[::1]');
  });

  it('does not mistake an IPv6 literal segment for a port', () => {
    expect(parseHostname('::1')).toBe('::1');
  });

  it('lowercases and trims', () => {
    expect(parseHostname('  LOCALHOST:3000  ')).toBe('localhost');
  });

  it('returns undefined for empty, whitespace, or malformed bracketed input', () => {
    expect(parseHostname(undefined)).toBeUndefined();
    expect(parseHostname('')).toBeUndefined();
    expect(parseHostname('   ')).toBeUndefined();
    expect(parseHostname('[::1')).toBeUndefined();
  });
});

describe('Host allowlist middleware (DNS rebinding protection)', () => {
  it('allows loopback hostnames through to the handler', async () => {
    const before = sideEffectCount;

    for (const hostHeader of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await rawRequest(hostHeader);
      expect(res.status, `expected ${hostHeader} to be allowed`).toBe(200);
    }

    expect(sideEffectCount).toBe(before + 3);
  });

  it('allows an explicitly configured additional hostname', async () => {
    const res = await rawRequest(`console.internal.example:${port}`);
    expect(res.status).toBe(200);
  });

  it('allows Google Cloud Shell Web Preview (*.cloudshell.dev) hostnames', async () => {
    const res = await rawRequest(`8080-cs-123456789-default.cs-us-east1-vpcf.cloudshell.dev`);
    expect(res.status).toBe(200);
  });

  // ---- Adversarial cases: each of these must NOT reach the handler. ----

  it('rejects a rebound attacker-controlled hostname and does not run the side effect', async () => {
    const before = sideEffectCount;
    const res = await rawRequest(`evil.attacker.example:${port}`);

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toBe('ForbiddenHost');
    // The actual security property: the handler never executed.
    expect(sideEffectCount).toBe(before);
  });

  it('rejects spoofed hostnames that mimic cloudshell.dev', async () => {
    const before = sideEffectCount;

    for (const hostHeader of [
      `cloudshell.dev.attacker.example:${port}`,
      `8080-cs-123.notcloudshell.dev:${port}`,
      `cloudshell.dev:${port}`
    ]) {
      const res = await rawRequest(hostHeader);
      expect(res.status, `expected ${hostHeader} to be rejected`).toBe(403);
    }

    expect(sideEffectCount).toBe(before);
  });

  it('rejects a hostname that merely contains an allowed name as a substring', async () => {
    const before = sideEffectCount;

    for (const hostHeader of [
      `localhost.attacker.example:${port}`,
      `notlocalhost:${port}`,
      `127.0.0.1.attacker.example:${port}`,
      `attacker.example#localhost:${port}`
    ]) {
      const res = await rawRequest(hostHeader);
      expect(res.status, `expected ${hostHeader} to be rejected`).toBe(403);
    }

    expect(sideEffectCount).toBe(before);
  });

  it('rejects a request with no Host header rather than failing open', async () => {
    const before = sideEffectCount;
    const res = await rawRequest(null);

    // Node's HTTP parser rejects a Host-less HTTP/1.1 request with 400 before the
    // request ever reaches Express, so we never see our own 403 here. Either way
    // the request is refused; what matters is that it does not reach the handler.
    expect(res.status).toBe(400);
    expect(sideEffectCount).toBe(before);
  });

  it('returns ForbiddenHost from the middleware itself when Host is absent', () => {
    // Exercises the branch the end-to-end test above cannot reach. This is not
    // dead code: it still guards HTTP/1.0 clients and proxy-stripped headers.
    const middleware = createHostAllowlistMiddleware({ boundHost: '127.0.0.1' });

    let statusCode = 0;
    let payload: any = null;
    let nextCalled = false;

    const req: any = { headers: {} };
    const res: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: any) {
        payload = body;
        return this;
      }
    };

    middleware(req, res, () => {
      nextCalled = true;
    });

    expect(statusCode).toBe(403);
    expect(payload.error).toBe('ForbiddenHost');
    expect(nextCalled).toBe(false);
  });

  it('rejects a non-allowed host even when the port matches the real one', async () => {
    const before = sideEffectCount;
    const res = await rawRequest(`rebind.example:${port}`);

    expect(res.status).toBe(403);
    expect(sideEffectCount).toBe(before);
  });
});
