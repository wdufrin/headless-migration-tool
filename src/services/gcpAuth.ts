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

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { JWT, GoogleAuth } from 'google-auth-library';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export interface TokenProviderOptions {
  staticToken?: string;
  useAdc?: boolean;
  serviceAccountKeyPath?: string;
  serviceAccountKeyJson?: any;
  wifConfigPath?: string;
  wifConfigJson?: any;
  authType?: 'SERVICE_ACCOUNT_KEY' | 'WORKFORCE_IDENTITY_FEDERATION' | 'APPLICATION_DEFAULT_CREDENTIALS';
}

export class GcpAuthService {
  private staticToken?: string;
  private serviceAccountKey?: any;
  private wifConfig?: any;
  private wifConfigPath?: string;
  private authType: 'SERVICE_ACCOUNT_KEY' | 'WORKFORCE_IDENTITY_FEDERATION' | 'APPLICATION_DEFAULT_CREDENTIALS' = 'SERVICE_ACCOUNT_KEY';
  private cachedAdcToken?: { token: string; expiresAt: number };
  private cachedWifToken?: { token: string; expiresAt: number };
  private userTokenCache: Map<string, { token: string; expiresAt: number }> = new Map();
  private failedDwdUsers: Set<string> = new Set();

  constructor(options: TokenProviderOptions = {}) {
    this.staticToken = options.staticToken;
    this.authType = options.authType || 'SERVICE_ACCOUNT_KEY';
    this.wifConfigPath = options.wifConfigPath;
    // Auto-load Workforce Identity Federation (WiF) Config if present
    if (options.wifConfigJson) {
      this.wifConfig = options.wifConfigJson;
    } else if (options.wifConfigPath && fs.existsSync(options.wifConfigPath)) {
      try {
        const content = fs.readFileSync(options.wifConfigPath, 'utf-8');
        this.wifConfig = JSON.parse(content);
        logger.info(`Loaded Workforce Identity Federation (WiF) Config from: ${options.wifConfigPath}`);
      } catch (err: any) {
        logger.warn(`Failed to parse WiF config file: ${err.message}`);
      }
    } else if (fs.existsSync('./workforce-identity-config.json')) {
      try {
        const content = fs.readFileSync('./workforce-identity-config.json', 'utf-8');
        this.wifConfig = JSON.parse(content);
        logger.info('Auto-loaded Workforce Identity Federation (WiF) Config from ./workforce-identity-config.json');
      } catch {}
    }

    if (options.serviceAccountKeyJson) {
      this.serviceAccountKey = options.serviceAccountKeyJson;
    } else if (options.serviceAccountKeyPath && fs.existsSync(options.serviceAccountKeyPath)) {
      try {
        const content = fs.readFileSync(options.serviceAccountKeyPath, 'utf-8').trim();
        if (content) {
          this.serviceAccountKey = JSON.parse(content);
          logger.info(`Loaded Service Account Key for Domain-Wide Delegation: ${this.serviceAccountKey.client_email}`);
        }
      } catch (err: any) {
        logger.warn(`Failed to parse Service Account Key file: ${err.message}`);
      }
    } else if (fs.existsSync('./sa-dwd-key.json')) {
      try {
        const content = fs.readFileSync('./sa-dwd-key.json', 'utf-8').trim();
        if (content) {
          this.serviceAccountKey = JSON.parse(content);
          logger.info(`Auto-loaded Service Account Key for DWD: ${this.serviceAccountKey.client_email}`);
        }
      } catch (err: any) {
        logger.warn(`Failed to parse default sa-dwd-key.json: ${err.message}`);
      }
    }
  }

  setToken(token: string) {
    this.staticToken = token;
  }

  setWifConfig(config: any) {
    this.wifConfig = config;
    this.authType = 'WORKFORCE_IDENTITY_FEDERATION';
  }

  setServiceAccountKey(keyInput: any) {
    if (typeof keyInput === 'string') {
      try {
        if (fs.existsSync(keyInput)) {
          const content = fs.readFileSync(keyInput, 'utf-8');
          this.serviceAccountKey = JSON.parse(content);
        } else {
          this.serviceAccountKey = JSON.parse(keyInput);
        }
      } catch (err: any) {
        logger.warn(`Failed to parse Service Account Key: ${err.message}`);
      }
    } else {
      this.serviceAccountKey = keyInput;
    }
  }

  private callerEmailCache?: string;

  hasDwdConfigured(): boolean {
    return !!this.serviceAccountKey;
  }

  /**
   * Resolves the primary email identity of the active caller credentials.
   */
  async getCallerIdentity(): Promise<string | undefined> {
    if (this.callerEmailCache) return this.callerEmailCache;
    const envEmail = process.env.ADMIN_EMAIL || process.env.DEFAULT_USER_EMAIL;
    if (envEmail && envEmail.includes('@')) {
      this.callerEmailCache = envEmail.replace(/^user:/i, '').trim();
      return this.callerEmailCache;
    }
    try {
      const token = await this.getAccessToken().catch(() => null);
      if (token) {
        const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
        if (resp.ok) {
          const data: any = await resp.json();
          if (data.email && !data.email.endsWith('.gserviceaccount.com')) {
            this.callerEmailCache = data.email;
            return this.callerEmailCache;
          }
        }
      }
    } catch {}
    return undefined;
  }

  /**
   * Retrieves an active GCP access token.
   * If forUserEmail is specified and a Service Account with Domain-Wide Delegation is configured,
   * mints a user-impersonated OAuth2 token (subject: forUserEmail) so resources are created
   * with literal user ownership.
   */
  async getAccessToken(forUserEmail?: string, scopes?: string[]): Promise<string> {
    const cleanEmail = typeof forUserEmail === 'string' ? forUserEmail.replace(/^user:/i, '').trim() : undefined;
    const requestedScopes = scopes && scopes.length > 0 ? scopes : [
      'https://www.googleapis.com/auth/discoveryengine.readwrite',
      'https://www.googleapis.com/auth/discoveryengine.assist.readwrite'
    ];
    const cacheKey = `${cleanEmail || 'default'}_${requestedScopes.slice().sort().join(',')}`;

    const cached = this.userTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60000) {
      return cached.token;
    }

    // 1. User Impersonation Flow
    if (cleanEmail) {
      // 1.a Workforce Identity Federation Impersonation (active if WIF configured or external domain)
      const lower = cleanEmail.toLowerCase();
      const isExternalDomain = lower.endsWith('.onmicrosoft.com') || lower.includes('entra') || lower.includes('okta');
      if (this.authType === 'WORKFORCE_IDENTITY_FEDERATION' || isExternalDomain || fs.existsSync('wif-migration-key.pem')) {
        try {
          const wifToken = await this.mintWorkforceToken(cleanEmail);
          if (wifToken) {
            this.userTokenCache.set(cacheKey, {
              token: wifToken,
              expiresAt: Date.now() + 3000 * 1000
            });
            return wifToken;
          }
        } catch (wifErr: any) {
          logger.debug(`Workforce token minting failed for ${cleanEmail}: ${wifErr.message}`);
        }
      }

      // 1.b Domain-Wide Delegation Impersonation
      if (this.serviceAccountKey && !isExternalDomain) {
        const isEligible = (
          lower.includes('@') &&
          !lower.endsWith('.gserviceaccount.com') &&
          !lower.includes('serviceaccount') &&
          !lower.startsWith('service-') &&
          !lower.endsWith('@example.com') &&
          lower !== 'unknown' &&
          lower !== 'admin'
        );

        if (isEligible) {
          try {
            logger.debug(`Minting DWD impersonated token for user: ${cleanEmail} with scopes: ${requestedScopes.join(', ')}`);
            const jwtClient = new JWT({
              email: this.serviceAccountKey.client_email,
              key: this.serviceAccountKey.private_key,
              subject: cleanEmail,
              scopes: requestedScopes
            });

            const tokenResponse = await jwtClient.getAccessToken();
            if (tokenResponse.token) {
              this.userTokenCache.set(cacheKey, {
                token: tokenResponse.token,
                expiresAt: Date.now() + 3000 * 1000
              });
              return tokenResponse.token;
            }
          } catch (err: any) {
            if (!this.failedDwdUsers.has(cleanEmail)) {
              this.failedDwdUsers.add(cleanEmail);
              logger.warn(`DWD impersonation failed for ${cleanEmail} (${err.message}). Falling back to Workforce / Service Account token.`);
            }
            // Try WiF token minting as fallback before giving up
            try {
              const fallbackWifToken = await this.mintWorkforceToken(cleanEmail);
              if (fallbackWifToken) return fallbackWifToken;
            } catch {}
          }
        }
      }
    }

    if (this.staticToken) {
      return this.staticToken;
    }

    // 2. Service Account Token for service-level non-impersonated calls
    if (this.authType === 'SERVICE_ACCOUNT_KEY' && this.serviceAccountKey) {
      try {
        const jwtClient = new JWT({
          email: this.serviceAccountKey.client_email,
          key: this.serviceAccountKey.private_key,
          scopes: requestedScopes
        });
        const tokenResponse = await jwtClient.getAccessToken();
        if (tokenResponse.token) {
          this.userTokenCache.set(cacheKey, {
            token: tokenResponse.token,
            expiresAt: Date.now() + 3000 * 1000
          });
          return tokenResponse.token;
        }
      } catch (err: any) {
        logger.warn(`Service Account token minting failed: ${err.message}`);
      }
    }

    // 3. Workforce Identity Federation (WiF) Token Exchange via GCP STS
    if (this.authType === 'WORKFORCE_IDENTITY_FEDERATION' && this.wifConfig) {
      if (this.cachedWifToken && this.cachedWifToken.expiresAt > Date.now() + 60000) {
        return this.cachedWifToken.token;
      }
      try {
        const auth = new GoogleAuth({
          scopes: requestedScopes
        });
        const client = auth.fromJSON(this.wifConfig);
        const tokenRes = await client.getAccessToken();
        if (tokenRes.token) {
          this.cachedWifToken = {
            token: tokenRes.token,
            expiresAt: Date.now() + 3000 * 1000
          };
          return tokenRes.token;
        }
      } catch (err: any) {
        logger.warn(`Workforce Identity Federation token exchange failed: ${err.message}`);
      }
    }

    if (this.cachedAdcToken && this.cachedAdcToken.expiresAt > Date.now() + 60000) {
      return this.cachedAdcToken.token;
    }

    // 3. Try GCE/GKE Metadata Server
    try {
      const metaRes = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(1000)
      });
      if (metaRes.ok) {
        const metaData: any = await metaRes.json();
        if (metaData.access_token) {
          this.cachedAdcToken = {
            token: metaData.access_token,
            expiresAt: Date.now() + (metaData.expires_in || 3600) * 1000
          };
          return metaData.access_token;
        }
      }
    } catch {
      // Ignore metadata server timeout outside GCP
    }

    // 3. Fallback to local gcloud ADC
    try {
      const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token']);
      const token = stdout.trim();
      if (token) {
        this.cachedAdcToken = {
          token,
          expiresAt: Date.now() + 3000 * 1000
        };
        return token;
      }
    } catch (err: any) {
      logger.warn(`Failed to obtain token via gcloud ADC: ${err.message}`);
    }

    throw new Error('No valid GCP credentials found. Please run "gcloud auth login", configure a Service Account Key with DWD, or provide an Authorization Bearer token.');
  }

  /**
   * Mints a strict Domain-Wide Delegation (DWD) impersonated token for a specific user.
   * Unlike getAccessToken(), this throws directly if impersonation fails instead of falling back to the service account.
   */
  async mintDwdToken(userEmail: string, scopes?: string[]): Promise<string> {
    if (!this.serviceAccountKey) {
      throw new Error('No Service Account Key configured for Domain-Wide Delegation.');
    }
    const cleanEmail = userEmail.replace(/^user:/i, '').trim();
    const requestedScopes = scopes && scopes.length > 0 ? scopes : [
      'https://www.googleapis.com/auth/discoveryengine.readwrite',
      'https://www.googleapis.com/auth/discoveryengine.assist.readwrite'
    ];

    const jwtClient = new JWT({
      email: this.serviceAccountKey.client_email,
      key: this.serviceAccountKey.private_key,
      subject: cleanEmail,
      scopes: requestedScopes
    });

    const tokenResponse = await jwtClient.getAccessToken();
    if (!tokenResponse.token) {
      throw new Error(`Failed to mint token for ${cleanEmail}: No token returned.`);
    }
    return tokenResponse.token;
  }

  /**
   * Mints a GCP Workforce Identity access token by signing an OIDC JWT and exchanging it with GCP STS.
   */
  public async mintWorkforceToken(userEmail: string, poolName?: string): Promise<string | undefined> {
    const keyPath = 'wif-migration-key.pem';
    if (!fs.existsSync(keyPath)) {
      return undefined;
    }

    const audience = this.wifConfig?.audience || '';
    const pool = poolName || (audience.match(/workforcePools\/([^\/]+)/)?.[1]) || process.env.WIF_POOL_ID || '';
    const provider = (audience.match(/providers\/([^\/]+)/)?.[1]) || process.env.WIF_PROVIDER_ID || 'migration-dwd-provider';

    try {
      const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
      const header = {
        alg: 'RS256',
        typ: 'JWT',
        kid: 'wif-migration-key-1'
      };
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: 'https://gemini-migration.internal',
        sub: userEmail,
        email: userEmail,
        aud: 'gemini-migration-tool',
        iat: now,
        exp: now + 3600
      };

      const encodeBase64Url = (obj: any) => Buffer.from(JSON.stringify(obj)).toString('base64url');
      const unsignedToken = `${encodeBase64Url(header)}.${encodeBase64Url(payload)}`;

      const crypto = await import('crypto');
      const sign = crypto.createSign('RSA-SHA256');
      sign.update(unsignedToken);
      sign.end();
      const signature = sign.sign(privateKeyPem, 'base64url');
      const signedJwt = `${unsignedToken}.${signature}`;

      const stsUrl = 'https://sts.googleapis.com/v1/token';
      const effectiveAudience = audience || `//iam.googleapis.com/locations/global/workforcePools/${pool}/providers/${provider}`;

      const stsRes = await fetch(stsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audience: effectiveAudience,
          grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
          requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
          scope: 'https://www.googleapis.com/auth/cloud-platform',
          subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token',
          subjectToken: signedJwt
        })
      });

      if (!stsRes.ok) {
        const errBody = await stsRes.text();
        logger.debug(`STS workforce token exchange returned ${stsRes.status}: ${errBody}`);
        return undefined;
      }

      const stsData: any = await stsRes.json();
      if (stsData.access_token) {
        logger.info(`Minted GCP Workforce Identity Token for "${userEmail}" via migration-dwd-provider.`);
        return stsData.access_token;
      }
    } catch (err: any) {
      logger.debug(`Could not mint workforce token for ${userEmail}: ${err.message}`);
    }
    return undefined;
  }
}
