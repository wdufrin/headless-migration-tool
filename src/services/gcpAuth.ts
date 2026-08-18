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

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { JWT, GoogleAuth } from 'google-auth-library';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

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
    this.wifConfig = options.wifConfigJson;

    if (options.wifConfigPath && fs.existsSync(options.wifConfigPath)) {
      try {
        const content = fs.readFileSync(options.wifConfigPath, 'utf-8');
        this.wifConfig = JSON.parse(content);
        this.authType = 'WORKFORCE_IDENTITY_FEDERATION';
        logger.info(`Loaded Workforce Identity Federation (WiF) Config from: ${options.wifConfigPath}`);
      } catch (err: any) {
        logger.warn(`Failed to parse WiF config file: ${err.message}`);
      }
    } else if (fs.existsSync('./workforce-identity-config.json')) {
      try {
        const content = fs.readFileSync('./workforce-identity-config.json', 'utf-8');
        this.wifConfig = JSON.parse(content);
        this.authType = 'WORKFORCE_IDENTITY_FEDERATION';
        logger.info('Auto-loaded Workforce Identity Federation (WiF) Config from ./workforce-identity-config.json');
      } catch {}
    }

    if (options.serviceAccountKeyJson) {
      this.serviceAccountKey = options.serviceAccountKeyJson;
    } else if (options.serviceAccountKeyPath && fs.existsSync(options.serviceAccountKeyPath)) {
      try {
        const content = fs.readFileSync(options.serviceAccountKeyPath, 'utf-8');
        this.serviceAccountKey = JSON.parse(content);
        logger.info(`Loaded Service Account Key for Domain-Wide Delegation: ${this.serviceAccountKey.client_email}`);
      } catch (err: any) {
        logger.warn(`Failed to parse Service Account Key file: ${err.message}`);
      }
    } else if (fs.existsSync('./sa-dwd-key.json')) {
      try {
        const content = fs.readFileSync('./sa-dwd-key.json', 'utf-8');
        this.serviceAccountKey = JSON.parse(content);
        logger.info(`Auto-loaded Service Account Key for DWD: ${this.serviceAccountKey.client_email}`);
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

  hasDwdConfigured(): boolean {
    return !!this.serviceAccountKey;
  }

  /**
   * Retrieves an active GCP access token.
   * If forUserEmail is specified and a Service Account with Domain-Wide Delegation is configured,
   * mints a user-impersonated OAuth2 token (subject: forUserEmail) so resources are created
   * with literal user ownership.
   */
  async getAccessToken(forUserEmail?: string, scopes?: string[]): Promise<string> {
    const cleanEmail = forUserEmail?.replace(/^user:/i, '').trim();
    const requestedScopes = scopes && scopes.length > 0 ? scopes : [
      'https://www.googleapis.com/auth/discoveryengine.readwrite',
      'https://www.googleapis.com/auth/discoveryengine.assist.readwrite'
    ];
    const cacheKey = `${cleanEmail || 'default'}_${requestedScopes.slice().sort().join(',')}`;

    // 1. Domain-Wide Delegation Impersonation
    if (cleanEmail && this.serviceAccountKey) {
      const lower = cleanEmail.toLowerCase();
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
        const cached = this.userTokenCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now() + 60000) {
          return cached.token;
        }

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
            logger.warn(`DWD impersonation skipped/failed for ${cleanEmail} (${err.message}). Using admin credentials.`);
          }
        }
      }
    }

    if (this.staticToken) {
      return this.staticToken;
    }

    // 2. Workforce Identity Federation (WiF) Token Exchange via GCP STS
    if (this.wifConfig) {
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
      const { stdout } = await execAsync('gcloud auth print-access-token');
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
}
