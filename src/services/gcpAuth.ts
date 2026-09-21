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
import crypto from 'crypto';
import { JWT, GoogleAuth } from 'google-auth-library';
import { getDiscoveredPoolGroups } from './wifPreflight.js';
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

/**
 * Controls *implicit* credential discovery from the current working directory
 * (./sa-dwd-key.json, ./workforce-identity-config.json, ./wif-migration-key.pem).
 *
 * Explicitly-configured credentials (serviceAccountKeyPath / wifConfigPath / *Json options)
 * are ALWAYS honoured and are unaffected by this gate.
 *
 * Rationale: implicit CWD pickup meant `vitest` silently loaded live production
 * credentials from the repo root and performed real DWD mints, real STS exchanges
 * and real `gcloud` subprocess calls. That made test results depend on the
 * developer's machine and turned any shared CI runner into a credential
 * exfiltration surface.
 */
export function isCredentialAutoloadDisabled(): boolean {
  return process.env.MIGRATION_DISABLE_CREDENTIAL_AUTOLOAD === 'true' || process.env.NODE_ENV === 'test';
}

/**
 * Discovery Engine scopes. Sufficient for reading/writing notebooks, notes,
 * artifacts, sessions, memories and agents via discoveryengine.googleapis.com.
 */
export const DISCOVERY_ENGINE_SCOPES = [
  'https://www.googleapis.com/auth/discoveryengine.readwrite',
  'https://www.googleapis.com/auth/discoveryengine.assist.readwrite'
];

export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * Default scopes for the Workforce Identity STS exchange.
 *
 * This deliberately includes cloud-platform. Scope narrowing on a workforce token
 * is defence-in-depth only -- what the principal may actually do is governed by the
 * IAM bindings on the pool, not by the OAuth scope. Narrowing the default breaks
 * real call paths: STS returns 200 for a Discovery Engine-only scope, but
 * iamcredentials.generateAccessToken then rejects that token with
 * "Request had insufficient authentication scopes".
 *
 * Callers that only touch Discovery Engine should pass DISCOVERY_ENGINE_SCOPES
 * explicitly rather than relying on a narrow default here.
 */
export const DEFAULT_WORKFORCE_SCOPES = [CLOUD_PLATFORM_SCOPE, ...DISCOVERY_ENGINE_SCOPES];

export class GcpAuthService {
  /**
   * Identities federated from an external IdP (Entra, Okta) have no Google Workspace
   * account, so Domain-Wide Delegation cannot impersonate them.
   */
  public static isExternalIdentityDomain(email: string): boolean {
    const lower = (email || '').toLowerCase();
    return lower.endsWith('.onmicrosoft.com') || lower.includes('entra') || lower.includes('okta');
  }

  private staticToken?: string;
  private serviceAccountKey?: any;
  private wifConfig?: any;
  private wifConfigPath?: string;
  private authType: 'SERVICE_ACCOUNT_KEY' | 'WORKFORCE_IDENTITY_FEDERATION' | 'APPLICATION_DEFAULT_CREDENTIALS' = 'SERVICE_ACCOUNT_KEY';
  private cachedAdcToken?: { token: string; expiresAt: number };
  private cachedWifToken?: { token: string; expiresAt: number };
  private userTokenCache: Map<string, { token: string; expiresAt: number }> = new Map();
  private userMechanismCache: Map<string, 'DWD' | 'WIF'> = new Map();
  private failedDwdUsers: Set<string> = new Set();

  public getLastUsedImpersonationMode(forUserEmail?: string): 'DWD' | 'WIF' | undefined {
    if (!forUserEmail) return undefined;
    const lower = forUserEmail.replace(/^user:/i, '').trim().toLowerCase();
    return this.userMechanismCache.get(lower);
  }

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
    } else if (!isCredentialAutoloadDisabled() && fs.existsSync('./workforce-identity-config.json')) {
      try {
        const content = fs.readFileSync('./workforce-identity-config.json', 'utf-8');
        this.wifConfig = JSON.parse(content);
        logger.info('Auto-loaded Workforce Identity Federation (WiF) Config from ./workforce-identity-config.json');
      } catch (err: any) {
        // Previously an empty catch: a corrupt config silently became `undefined`,
        // and the operator only found out via a confusing downstream auth failure.
        logger.warn(`Failed to parse ./workforce-identity-config.json: ${err.message}. WiF is NOT configured.`);
      }
    }

    if (this.wifConfig?.credential_source?.file) {
      this.ensureSubjectTokenFile();
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
    } else if (!isCredentialAutoloadDisabled() && fs.existsSync('./sa-dwd-key.json')) {
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
    if (this.staticToken) {
      try {
        const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(this.staticToken)}`);
        if (resp.ok) {
          const data: any = await resp.json();
          if (data.email && !data.email.endsWith('.gserviceaccount.com')) {
            this.callerEmailCache = data.email;
            return this.callerEmailCache;
          }
        }
      } catch {}
    }

    try {
      const { stdout } = await execFileAsync('gcloud', ['config', 'get-value', 'account']);
      const email = stdout.trim();
      if (email && email.includes('@') && !email.endsWith('.gserviceaccount.com')) {
        this.callerEmailCache = email;
        return this.callerEmailCache;
      }
    } catch {}

    return undefined;
  }

  /**
   * Returns the home GCP project_id of the loaded Service Account key (if any).
   * Used as the fallback quota project (X-Goog-User-Project) when cross-project
   * requests fail with 403 USER_PROJECT_DENIED.
   */
  getServiceAccountProjectId(): string | undefined {
    return this.serviceAccountKey?.project_id;
  }

  /**
   * Retrieves an active GCP access token.
   * If forUserEmail is specified and a Service Account with Domain-Wide Delegation is configured,
   * mints a user-impersonated OAuth2 token (subject: forUserEmail) so resources are created
   * with literal user ownership.
   */
  async getAccessToken(forUserEmail?: string, scopes?: string[], preferredMode?: 'DWD' | 'WIF'): Promise<string> {
    const cleanEmail = typeof forUserEmail === 'string' ? forUserEmail.replace(/^user:/i, '').trim() : undefined;
    const requestedScopes = scopes && scopes.length > 0 ? scopes : [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/discoveryengine.readwrite',
      'https://www.googleapis.com/auth/discoveryengine.assist.readwrite'
    ];
    // For Google Workspace DWD user impersonation, default strictly to least-privilege Discovery Engine scopes
    // so Workspace admins who did not authorize cloud-platform in admin.google.com do not get unauthorized_client.
    const dwdScopes = scopes && scopes.length > 0 ? scopes : [
      'https://www.googleapis.com/auth/discoveryengine.readwrite',
      'https://www.googleapis.com/auth/discoveryengine.assist.readwrite'
    ];
    const effectiveMode = preferredMode || (this.authType === 'WORKFORCE_IDENTITY_FEDERATION' ? 'WIF' : 'DWD');
    const cacheKey = `${cleanEmail || 'default'}_${cleanEmail ? effectiveMode : 'ADMIN'}_${requestedScopes.slice().sort().join(',')}`;

    const cached = this.userTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60000) {
      return cached.token;
    }

    // Helper to mint DWD token with automatic scope fallback on unauthorized_client
    const tryMintDwd = async (emailToImpersonate: string): Promise<string | null> => {
      if (!this.serviceAccountKey) return null;
      const scopeSetsToTry = [
        dwdScopes,
        ['https://www.googleapis.com/auth/discoveryengine.readwrite', 'https://www.googleapis.com/auth/discoveryengine.assist.readwrite'],
        ['https://www.googleapis.com/auth/discoveryengine.readwrite'],
        ['https://www.googleapis.com/auth/cloud-platform']
      ];
      let lastErr: any = null;
      for (const scopeSet of scopeSetsToTry) {
        try {
          const jwtClient = new JWT({
            email: this.serviceAccountKey.client_email,
            key: this.serviceAccountKey.private_key,
            subject: emailToImpersonate,
            scopes: scopeSet
          });
          const tokenResponse = await jwtClient.getAccessToken();
          if (tokenResponse.token) {
            logger.info(`Minted Google Workspace DWD Token for "${emailToImpersonate}" via ${this.serviceAccountKey.client_email}.`);
            return tokenResponse.token;
          }
        } catch (err: any) {
          lastErr = err;
          if (!err.message?.includes('unauthorized_client')) {
            // If invalid_grant (user does not exist in Google Workspace), break early
            break;
          }
        }
      }
      if (lastErr) throw lastErr;
      return null;
    };

    // 1. User Impersonation Flow
    if (cleanEmail) {
      const lower = cleanEmail.toLowerCase();
      if (lower === 'unknown') {
        throw new Error(`Cannot obtain access token for unknown user identity ("unknown"). Provide a valid user email or service account.`);
      }
      const isServiceIdentity = (
        lower.endsWith('.gserviceaccount.com') ||
        lower.startsWith('service-')
      );

      if (!isServiceIdentity) {
        const isExternalDomain = GcpAuthService.isExternalIdentityDomain(lower);
        const isStrictMode = preferredMode === 'DWD' || preferredMode === 'WIF';
        let lastDwdError: Error | null = null;
        let lastWifError: Error | null = null;

        if (effectiveMode === 'DWD') {
          if (!isExternalDomain && this.serviceAccountKey) {
            try {
              const dwdToken = await tryMintDwd(cleanEmail);
              if (dwdToken) {
                this.userMechanismCache.set(lower, 'DWD');
                this.userTokenCache.set(cacheKey, { token: dwdToken, expiresAt: Date.now() + 3000 * 1000 });
                return dwdToken;
              }
            } catch (err: any) {
              lastDwdError = err;
              if (!this.failedDwdUsers.has(cleanEmail)) {
                this.failedDwdUsers.add(cleanEmail);
                logger.debug(`DWD impersonation note for ${cleanEmail} (${err.message}).`);
              }
            }
          }
          // Only fall back to WIF when the caller did NOT explicitly request 'DWD' (e.g. during a retry)
          if (!isStrictMode) {
            try {
              const wifToken = await this.mintWorkforceToken(cleanEmail, undefined, requestedScopes);
              if (wifToken) {
                this.userMechanismCache.set(lower, 'WIF');
                this.userTokenCache.set(cacheKey, { token: wifToken, expiresAt: Date.now() + 3000 * 1000 });
                return wifToken;
              }
            } catch (wifErr: any) {
              lastWifError = wifErr;
            }
          }
        } else {
          // Try WiF first
          try {
            const wifToken = await this.mintWorkforceToken(cleanEmail, undefined, requestedScopes);
            if (wifToken) {
              this.userMechanismCache.set(lower, 'WIF');
              this.userTokenCache.set(cacheKey, { token: wifToken, expiresAt: Date.now() + 3000 * 1000 });
              return wifToken;
            }
          } catch (wifErr: any) {
            lastWifError = wifErr;
            logger.debug(`Workforce token minting failed for ${cleanEmail}: ${wifErr.message}`);
          }
          // Only fall back to DWD when the caller did NOT explicitly request 'WIF' (e.g. during a retry)
          if (!isStrictMode && this.serviceAccountKey && !isExternalDomain) {
            try {
              const dwdToken = await tryMintDwd(cleanEmail);
              if (dwdToken) {
                this.userMechanismCache.set(lower, 'DWD');
                this.userTokenCache.set(cacheKey, { token: dwdToken, expiresAt: Date.now() + 3000 * 1000 });
                return dwdToken;
              }
            } catch (err: any) {
              lastDwdError = err;
            }
          }
        }

        // 1.c Fallback: If DWD/WiF is not configured (or failed) AND target user matches active local gcloud caller (only when not in strict retry mode)
        if (!isStrictMode) {
          const callerEmail = await this.getCallerIdentity().catch(() => undefined);
          if (callerEmail && callerEmail.toLowerCase() === lower) {
            if (this.staticToken) {
              return this.staticToken;
            }
            if (this.cachedAdcToken && this.cachedAdcToken.expiresAt > Date.now() + 60000) {
              return this.cachedAdcToken.token;
            }
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
              logger.warn(`Failed to obtain caller token via gcloud ADC: ${err.message}`);
            }
          }
        }

        // Fail-closed: User impersonation was requested for a specific human user identity.
        const failureReason = lastDwdError
          ? lastDwdError.message
          : lastWifError
          ? lastWifError.message
          : (!this.serviceAccountKey ? 'No Service Account Key configured for Domain-Wide Delegation' : 'User impersonation failed');
        throw new Error(`${effectiveMode} Impersonation Failed for user "${cleanEmail}": ${failureReason}`);
      }
    }

    if (this.staticToken) {
      return this.staticToken;
    }

    // 2. Service Account Token for service-level administrative / non-impersonated calls
    if (this.serviceAccountKey) {
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
      this.ensureSubjectTokenFile();
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
        logger.debug(`Workforce Identity Federation token exchange failed: ${err.message}`);
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
   * Reports whether a given user-impersonation mechanism is actually usable for this
   * user, and if not, why.
   *
   * This exists because callers previously inferred "a different mechanism was used"
   * by comparing access token strings. Two tokens minted by the SAME mechanism differ
   * (the JWT `iat` changes), so that check reported success for a retry that in
   * reality re-used the identical credential class and was guaranteed to fail again.
   */
  public getImpersonationMechanismStatus(
    userEmail: string,
    mode: 'DWD' | 'WIF'
  ): { available: boolean; reason: string } {
    const lower = (userEmail || '').replace(/^user:/i, '').trim().toLowerCase();

    if (mode === 'DWD') {
      if (!this.serviceAccountKey) {
        return {
          available: false,
          reason: 'no Service Account Key is configured for Domain-Wide Delegation'
        };
      }
      if (GcpAuthService.isExternalIdentityDomain(lower)) {
        return {
          available: false,
          reason: `"${lower}" is an external IdP identity, which Google Workspace Domain-Wide Delegation cannot impersonate`
        };
      }
      return { available: true, reason: 'Domain-Wide Delegation service account key is configured' };
    }

    if (!fs.existsSync('wif-migration-key.pem')) {
      return {
        available: false,
        reason: 'the Workforce Identity signing key "wif-migration-key.pem" is not present'
      };
    }
    if (!this.wifConfig?.audience) {
      return {
        available: false,
        reason: 'no Workforce Identity audience is configured'
      };
    }
    return { available: true, reason: 'Workforce Identity signing key and audience are configured' };
  }

  /**
   * Mints a GCP Workforce Identity access token by signing an OIDC JWT and exchanging it with GCP STS.
   *
   * Uses DEFAULT_WORKFORCE_SCOPES unless the caller passes `scopes`. If STS rejects the
   * requested scopes with `invalid_scope`, retries once with cloud-platform. Note that this
   * retry cannot rescue a token that STS accepts but a downstream API rejects for insufficient
   * scope -- that must be handled by requesting adequate scopes up front.
   */
  public async mintWorkforceToken(userEmail: string, poolName?: string, scopes?: string[]): Promise<string | undefined> {
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
      const shortUser = userEmail.includes('@') ? userEmail.split('@')[0] : userEmail;
      const envGroups = (process.env.WIF_DEFAULT_GROUPS || '')
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      const poolGroups = getDiscoveredPoolGroups(pool);
      const allGroups = Array.from(new Set([...envGroups, ...poolGroups]));

      const payload: Record<string, any> = {
        iss: 'https://gemini-migration.internal',
        sub: userEmail,
        subject: userEmail,
        email: userEmail,
        upn: userEmail,
        preferred_username: userEmail,
        uid: shortUser,
        samAccountName: shortUser,
        groups: allGroups,
        aud: 'gemini-migration-tool',
        iat: now,
        exp: now + 3600
      };

      const encodeBase64Url = (obj: any) => Buffer.from(JSON.stringify(obj)).toString('base64url');
      const unsignedToken = `${encodeBase64Url(header)}.${encodeBase64Url(payload)}`;

      const sign = crypto.createSign('RSA-SHA256');
      sign.update(unsignedToken);
      sign.end();
      const signature = sign.sign(privateKeyPem, 'base64url');
      const signedJwt = `${unsignedToken}.${signature}`;

      const stsUrl = 'https://sts.googleapis.com/v1/token';
      const effectiveAudience = audience || `//iam.googleapis.com/locations/global/workforcePools/${pool}/providers/${provider}`;

      const exchangeForScope = async (scopeStr: string) => fetch(stsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audience: effectiveAudience,
          grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
          requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
          scope: scopeStr,
          subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token',
          subjectToken: signedJwt
        })
      });

      let usedScopeStr = (scopes && scopes.length > 0 ? scopes : DEFAULT_WORKFORCE_SCOPES).join(' ');
      let stsRes = await exchangeForScope(usedScopeStr);

      if (!stsRes.ok) {
        const errBody = await stsRes.text();
        // Only retry when STS specifically rejected the scope set. Retrying on any other
        // error (bad audience, unknown provider, bad signature) just repeats the failure.
        if (/invalid_scope/i.test(errBody) && usedScopeStr !== CLOUD_PLATFORM_SCOPE) {
          logger.warn(`STS rejected scopes "${usedScopeStr}" as invalid_scope for "${userEmail}"; retrying with cloud-platform.`);
          usedScopeStr = CLOUD_PLATFORM_SCOPE;
          stsRes = await exchangeForScope(usedScopeStr);
          if (!stsRes.ok) {
            const retryBody = await stsRes.text();
            logger.warn(`STS workforce token exchange failed for "${userEmail}" after scope retry (HTTP ${stsRes.status}): ${retryBody}`);
            return undefined;
          }
        } else {
          logger.warn(`STS workforce token exchange failed for "${userEmail}" (HTTP ${stsRes.status}): ${errBody}`);
          return undefined;
        }
      }

      const stsData: any = await stsRes.json();
      if (!stsData.access_token) {
        logger.warn(`STS returned HTTP ${stsRes.status} for "${userEmail}" but no access_token was present in the response.`);
        return undefined;
      }
      logger.info(`Minted GCP Workforce Identity Token for "${userEmail}" via ${provider} (scopes: ${usedScopeStr}).`);
      return stsData.access_token;
    } catch (err: any) {
      logger.debug(`Could not mint workforce token for ${userEmail}: ${err.message}`);
    }
    return undefined;
  }

  /**
   * Ensures that the static credential_source file required by workforce-identity-config.json
   * (e.g. ./idp-subject-token.jwt) exists on disk with a valid, signed OIDC JWT.
   * If the file is missing or expiring, mints and writes a signed JWT using wif-migration-key.pem.
   */
  public ensureSubjectTokenFile(userEmail?: string): boolean {
    const tokenFilePath = this.wifConfig?.credential_source?.file || './idp-subject-token.jwt';
    const keyPath = 'wif-migration-key.pem';

    // `keyPath` is an implicit CWD lookup, so it obeys the same gate as the other
    // credential files. Without this, `vitest` signed real IdP assertions with the
    // operator's live key and rewrote ./idp-subject-token.jwt in the working tree.
    if (isCredentialAutoloadDisabled()) {
      logger.debug('Subject token generation skipped: implicit credential autoload is disabled.');
      return false;
    }

    // Not an error: service-account-key and ADC deployments never have this file.
    if (!fs.existsSync(keyPath)) {
      logger.debug(`No WiF signing key at ${keyPath}; skipping subject token generation.`);
      return false;
    }

    // Fail closed. This previously fell back to a hardcoded personal address, so a
    // misconfigured deployment would mint a valid assertion for a principal the
    // operator never asked for.
    const email = userEmail || process.env.WIF_USER_EMAIL || process.env.ADMIN_EMAIL;
    if (!email) {
      logger.warn(
        'Cannot generate subject token: no user email supplied and neither WIF_USER_EMAIL nor ADMIN_EMAIL is set.'
      );
      return false;
    }

    try {
      if (fs.existsSync(tokenFilePath)) {
        const existing = fs.readFileSync(tokenFilePath, 'utf8').trim();
        if (existing) {
          const parts = existing.split('.');
          if (parts.length === 3) {
            try {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
              const now = Math.floor(Date.now() / 1000);
              if (payload.exp && payload.exp > now + 300 && payload.sub === email) {
                return true;
              }
            } catch (err: any) {
              // Deliberately non-fatal, but no longer silent: a corrupt or truncated
              // token file falls through to regeneration below.
              logger.debug(
                `Existing subject token at ${tokenFilePath} is malformed (${err.message}); refreshing.`
              );
            }
          }
        }
      }

      const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
      const header = {
        alg: 'RS256',
        typ: 'JWT',
        kid: 'wif-migration-key-1'
      };
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: 'https://gemini-migration.internal',
        sub: email,
        email: email,
        aud: 'gemini-migration-tool',
        iat: now,
        exp: now + 3600
      };

      const encodeBase64Url = (obj: any) => Buffer.from(JSON.stringify(obj)).toString('base64url');
      const unsignedToken = `${encodeBase64Url(header)}.${encodeBase64Url(payload)}`;

      const sign = crypto.createSign('RSA-SHA256');
      sign.update(unsignedToken);
      sign.end();
      const signature = sign.sign(privateKeyPem, 'base64url');
      const signedJwt = `${unsignedToken}.${signature}`;

      // This JWT is a bearer credential: anyone who can read it can exchange it at
      // STS for a token impersonating `email`. `mode` is ignored when the file already
      // exists, so chmod explicitly to repair tokens left 0644 by earlier versions.
      fs.writeFileSync(tokenFilePath, signedJwt, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(tokenFilePath, 0o600);
      } catch (err: any) {
        logger.warn(
          `Subject token written but could not be restricted to 0600 at ${tokenFilePath}: ${err.message}`
        );
      }
      logger.info(`Generated new subject token file at ${tokenFilePath} for ${email}`);
      return true;
    } catch (err: any) {
      logger.error(`Failed to ensure subject token file at ${tokenFilePath}: ${err.message}`);
      return false;
    }
  }
}
