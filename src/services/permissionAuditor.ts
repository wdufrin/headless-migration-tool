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

import { GcpAuthService } from './gcpAuth.js';
import { getSafeDiscoveryEngineUrl } from '../security/validator.js';
import { logger } from '../utils/logger.js';
import fs from 'fs';

export interface PermissionAuditRequest {
  authMode?: 'dwd' | 'wif';
  sourceIdp?: 'google' | 'entra' | 'okta' | 'wif';
  targetIdp?: 'google' | 'entra' | 'okta' | 'wif';
  sourceProject?: string;
  sourceLocation?: string;
  sourceAppId?: string;
  targetProject?: string;
  targetLocation?: string;
  targetAppId?: string;
  sourceUserEmail?: string;
  targetUserEmail?: string;
  testUserEmail?: string; // backwards compatibility
  keyPath?: string;
  wifConfigPath?: string;
  serviceAccountToImpersonate?: string;
}

export interface PermissionCheckItem {
  id: string;
  category: 'SOURCE_DISCOVERY' | 'TARGET_RESTORE' | 'WORKSPACE_OAUTH' | 'WIF_FEDERATION' | 'OVER_PROVISIONING';
  name: string;
  /**
   * GRANTED / MISSING / OVER_PROVISIONED are *evidence-backed* verdicts: the auditor
   * performed a check and observed the result.
   *
   * UNKNOWN means the check could not be completed (no permission, gcloud missing,
   * network failure). It must never be rendered as a pass - the previous code turned
   * failed org-policy reads into GRANTED, which fabricated verdicts.
   *
   * INFO is contextual information that verifies nothing and therefore earns no score.
   */
  status: 'GRANTED' | 'MISSING' | 'OVER_PROVISIONED' | 'UNKNOWN' | 'INFO';
  level: 'REQUIRED' | 'RECOMMENDED' | 'DANGEROUS';
  details: string;
  remediation?: string;
  fixAction?: {
    type: 'IAM_AUTO_FIX' | 'GUIDANCE_DRAWER' | 'NAVIGATE_TAB' | 'GENERATE_WIF_CONFIG';
    title: string;
    projectId?: string;
    member?: string;
    role?: string;
    targetTab?: string;
    steps?: string[];
  };
}

export interface ScopeAuditItem {
  /** BROAD = functional but far wider than least-privilege (e.g. cloud-platform). */
  scope: string;
  status: 'ALLOWED' | 'EXCESSIVE' | 'OPTIONAL' | 'BROAD';
  description: string;
}

export interface PermissionAuditReport {
  overallGrade: 'A+' | 'A' | 'B' | 'C' | 'F';
  overallStatus:
    | 'LEAST_PRIVILEGE_COMPLIANT'
    | 'OVER_PROVISIONED'
    | 'MISSING_PERMISSIONS'
    | 'AUTHENTICATION_FAILED'
    | 'VERIFICATION_INCOMPLETE';
  authArchitecture: {
    sourceAuthType: 'WORKFORCE_IDENTITY_FEDERATION' | 'GOOGLE_WORKSPACE_DWD' | 'GCP_SERVICE_ACCOUNT';
    targetAuthType: 'WORKFORCE_IDENTITY_FEDERATION' | 'GOOGLE_WORKSPACE_DWD' | 'GCP_SERVICE_ACCOUNT';
    sourceUser: string;
    targetUser: string;
    wifAudience?: string;
  };
  summary: {
    totalChecked: number;
    totalGranted: number;
    totalMissing: number;
    totalOverProvisioned: number;
    /** Checks that could not be completed. A non-zero value means this report is incomplete. */
    totalUnknown: number;
    score: number; // 0 - 100
  };
  scopesAudit: ScopeAuditItem[];
  permissions: PermissionCheckItem[];
  remediations: string[];
}

export class PermissionAuditor {
  private authService: GcpAuthService;

  constructor(authService?: GcpAuthService) {
    this.authService = authService || new GcpAuthService();
  }

  async audit(req: PermissionAuditRequest): Promise<PermissionAuditReport> {
    const sourceProject = req.sourceProject || process.env.SOURCE_PROJECT_ID || '';
    const sourceLocation = req.sourceLocation || process.env.SOURCE_LOCATION || 'global';
    const sourceAppId = req.sourceAppId || process.env.SOURCE_APP_ID || '';

    const targetProject = req.targetProject || process.env.TARGET_PROJECT_ID || '';
    const targetLocation = req.targetLocation || process.env.TARGET_LOCATION || 'global';
    const targetAppId = req.targetAppId || process.env.TARGET_APP_ID || '';

    const rawUser = (req.sourceUserEmail || req.testUserEmail || process.env.DEFAULT_USER_EMAIL || process.env.ADMIN_EMAIL || 'user@example.com').trim();
    const targetUser = (req.targetUserEmail || process.env.DEFAULT_USER_EMAIL || process.env.ADMIN_EMAIL || 'user@example.com').trim();

    // Explicit Source & Target IdP determination
    const isSourceWif = req.sourceIdp === 'entra' || req.sourceIdp === 'okta' || req.sourceIdp === 'wif' || 
      (req.authMode === 'wif' && !req.sourceIdp) ||
      rawUser.toLowerCase().includes('.onmicrosoft.com');

    const isTargetWif = req.targetIdp === 'entra' || req.targetIdp === 'okta' || req.targetIdp === 'wif' ||
      (req.authMode === 'wif' && !req.targetIdp && targetUser.toLowerCase().includes('.onmicrosoft.com'));

    const sourceAuthType = isSourceWif ? 'WORKFORCE_IDENTITY_FEDERATION' : 'GOOGLE_WORKSPACE_DWD';
    const targetAuthType = isTargetWif ? 'WORKFORCE_IDENTITY_FEDERATION' : 'GOOGLE_WORKSPACE_DWD';

    const permissions: PermissionCheckItem[] = [];
    const scopesAudit: ScopeAuditItem[] = [];
    const remediations: string[] = [];

    let totalGranted = 0;
    let totalMissing = 0;
    let totalOverProvisioned = 0;
    let totalUnknown = 0;


    let wifAudience = '';

    let srcToken: string | null = null;

    // 1. Audit Source Auth (WiF or DWD)
    if (isSourceWif) {
      // 1a. Check Workforce Identity Federation Configuration
      const wifPath = req.wifConfigPath || './workforce-identity-config.json';
      let wifConfigExists = fs.existsSync(wifPath);
      let parsedWif: any = null;

      if (wifConfigExists) {
        try {
          parsedWif = JSON.parse(fs.readFileSync(wifPath, 'utf8'));
          wifAudience = parsedWif.audience || '';
        } catch (e: any) {
          wifConfigExists = false;
        }
      }

      if (wifConfigExists && parsedWif?.audience) {
        permissions.push({
          id: 'AUTH_WIF_CONFIG',
          category: 'WIF_FEDERATION',
          name: 'Source Workforce Identity Federation (WiF) Pool Config',
          status: 'GRANTED',
          level: 'REQUIRED',
          details: `Valid WiF configuration detected on server (workforce-identity-config.json exists). Audience: "${parsedWif.audience}".`
        });
        totalGranted++;
      } else {
        // No parseable WiF config on disk. The tool can still mint tokens programmatically,
        // but nothing here has been *verified*, so this must not be reported as GRANTED.
        permissions.push({
          id: 'AUTH_WIF_CONFIG',
          category: 'WIF_FEDERATION',
          name: 'Source Workforce Identity Federation (WiF) Pool Config',
          status: 'UNKNOWN',
          level: 'RECOMMENDED',
          details:
            `No valid Workforce Identity Federation config was found at "${wifPath}"` +
            `${wifConfigExists ? ' (the file exists but could not be parsed as JSON)' : ' (file not present)'}. ` +
            `The audience and pool could not be read, so the federation setup for "${rawUser}" was not verified.`,
          remediation: `Save workforce-identity-config.json from the WiF tab so the audience and pool can be validated.`,
          fixAction: {
            type: 'GENERATE_WIF_CONFIG',
            title: '1-Click Save WiF ADC Config',
            steps: [
              '1. Generates workforce-identity-config.json from the active workforce pool and provider.',
              '2. Saves the file to the root directory for standard Google Cloud SDK / ADC token exchange.',
              '3. Allows standard Google Cloud client libraries to authenticate without manual token injection.'
            ]
          }
        });
        totalUnknown++;
      }

      // 1b. Validate Source User Identity Mapping.
      //
      // This previously asserted GRANTED - "successfully mapped to target identity" -
      // unconditionally, without performing any check. That is precisely the failure mode
      // seen in the field: when the migration provider maps google.subject=assertion.sub
      // but the pool's real providers map assertion.email.lowerAscii(), impersonation of
      // mixed-case addresses silently fails while this check reported a pass.
      if (wifAudience) {
        try {
          const { checkSubjectMapping } = await import('./wifPreflight.js');
          const preflight = await checkSubjectMapping(wifAudience);

          if (preflight.verdict === 'MATCH') {
            permissions.push({
              id: 'AUTH_WIF_MAPPING',
              category: 'WIF_FEDERATION',
              name: 'Cross-IdP User Identity Resolution',
              status: 'GRANTED',
              level: 'REQUIRED',
              details: `Verified against the live workforce pool: ${preflight.summary}`
            });
            totalGranted++;
          } else if (preflight.verdict === 'MISMATCH') {
            permissions.push({
              id: 'AUTH_WIF_MAPPING',
              category: 'WIF_FEDERATION',
              name: 'Cross-IdP User Identity Resolution',
              status: 'MISSING',
              level: 'REQUIRED',
              details:
                `Subject mapping mismatch detected in the live workforce pool: ${preflight.summary} ` +
                `IAM bindings reference a pool-scoped subject, so impersonation of "${rawUser}" will be denied ` +
                `whenever the signed subject does not match the subject the production provider produces.`,
              remediation:
                `Align the migration provider's google.subject mapping with the pool's production providers, e.g.: ` +
                `gcloud iam workforce-pools providers update-oidc migration-dwd-provider ` +
                `--workforce-pool=${preflight.poolId || '<POOL>'} --location=global ` +
                `--attribute-mapping='google.subject=assertion.email.lowerAscii(),attribute.user_email=assertion.email'`
            });
            totalMissing++;
          } else {
            permissions.push({
              id: 'AUTH_WIF_MAPPING',
              category: 'WIF_FEDERATION',
              name: 'Cross-IdP User Identity Resolution',
              status: 'UNKNOWN',
              level: 'REQUIRED',
              details: `Subject mapping could not be verified: ${preflight.summary}${preflight.error ? ` (${preflight.error})` : ''}`,
              remediation:
                `Inspect the pool manually: gcloud iam workforce-pools providers list ` +
                `--workforce-pool=${preflight.poolId || '<POOL>'} --location=global ` +
                `--format="table(name, attributeMapping['google.subject'])"`
            });
            totalUnknown++;
          }
        } catch (mapErr: any) {
          permissions.push({
            id: 'AUTH_WIF_MAPPING',
            category: 'WIF_FEDERATION',
            name: 'Cross-IdP User Identity Resolution',
            status: 'UNKNOWN',
            level: 'REQUIRED',
            details: `Subject mapping preflight could not run for "${rawUser}": ${mapErr.message}`,
            remediation: `Verify the workforce pool provider mappings manually before migrating.`
          });
          totalUnknown++;
        }
      } else {
        permissions.push({
          id: 'AUTH_WIF_MAPPING',
          category: 'WIF_FEDERATION',
          name: 'Cross-IdP User Identity Resolution',
          status: 'UNKNOWN',
          level: 'REQUIRED',
          details:
            `No WiF audience is configured, so the workforce pool could not be identified and the ` +
            `google.subject mapping for "${rawUser}" was not checked. A subject mismatch here causes ` +
            `silent per-user impersonation failures.`,
          remediation: `Save workforce-identity-config.json from the WiF tab, then re-run this audit.`
        });
        totalUnknown++;
      }
    } else {

      // Source is Google Workspace DWD
      try {
        srcToken = await this.authService.getAccessToken(rawUser);
        permissions.push({
          id: 'AUTH_SRC_DWD_TOKEN',
          category: 'WORKSPACE_OAUTH',
          name: 'Source Domain-Wide Delegation (Google Workspace)',
          status: srcToken ? 'GRANTED' : 'MISSING',
          level: 'REQUIRED',
          details: srcToken
            ? `Successfully verified DWD impersonation token for source user "${rawUser}".`
            : `Could not verify DWD impersonation token for source user "${rawUser}".`
        });
        if (srcToken) totalGranted++;
        else totalMissing++;
      } catch (srcErr: any) {
        permissions.push({
          id: 'AUTH_SRC_DWD_TOKEN',
          category: 'WORKSPACE_OAUTH',
          name: 'Source Domain-Wide Delegation (Google Workspace)',
          status: 'MISSING',
          level: 'REQUIRED',
          details: `Failed to mint source DWD token for user "${rawUser}": ${srcErr.message}`
        });
        totalMissing++;
      }
    }

    // 2. Audit Target Auth (WiF or Google Workspace DWD)
    let dwdToken: string | null = null;
    let tokenInfo: any = null;

    if (isTargetWif) {
      // Target uses Workforce Identity Federation
      try {
        const wifToken = await this.authService.getAccessToken(targetUser);
        if (wifToken) {
          dwdToken = wifToken;
          permissions.push({
            id: 'AUTH_TGT_WIF_TOKEN',
            category: 'WIF_FEDERATION',
            name: 'Target Workforce Identity Federation (WiF / STS)',
            status: 'GRANTED',
            level: 'REQUIRED',
            details: `Target environment uses Workforce Identity Federation (WiF). Successfully verified STS token for "${targetUser}".`
          });
          totalGranted++;
        } else {
          permissions.push({
            id: 'AUTH_TGT_WIF_TOKEN',
            category: 'WIF_FEDERATION',
            name: 'Target Workforce Identity Federation (WiF / STS)',
            status: 'MISSING',
            level: 'REQUIRED',
            details: `Target environment uses Workforce Identity Federation (WiF), but no valid STS token could be acquired for "${targetUser}".`,
            remediation: `Ensure Workforce Identity Pool and Provider are correctly configured and credentials file exists.`
          });
          totalMissing++;
        }
      } catch (wifErr: any) {
        permissions.push({
          id: 'AUTH_TGT_WIF_TOKEN',
          category: 'WIF_FEDERATION',
          name: 'Target Workforce Identity Federation (WiF / STS)',
          status: 'MISSING',
          level: 'REQUIRED',
          details: `Target Workforce Identity Federation (WiF) token acquisition failed for "${targetUser}": ${wifErr.message}`,
          remediation: `Verify Workforce Identity Federation credentials and STS exchange configuration.`
        });
        totalMissing++;
      }
    } else {
      // Target uses Google Workspace Domain-Wide Delegation
      try {
        dwdToken = await this.authService.getAccessToken(targetUser);
        if (dwdToken) {
          try {
            const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${dwdToken}`);
            if (infoRes.ok) {
              tokenInfo = await infoRes.json();
            }
          } catch (e: any) {
            logger.warn(`Could not inspect token info: ${e.message}`);
          }
        }
        permissions.push({
          id: 'AUTH_DWD_TOKEN',
          category: 'WORKSPACE_OAUTH',
          name: 'Target Domain-Wide Delegation (Google Workspace)',
          status: 'GRANTED',
          level: 'REQUIRED',
          details: `Successfully minted user-scoped DWD token for target Google Workspace user "${targetUser}".`
        });
        totalGranted++;
      } catch (authErr: any) {
        permissions.push({
          id: 'AUTH_DWD_TOKEN',
          category: 'WORKSPACE_OAUTH',
          name: 'Target Domain-Wide Delegation (Google Workspace)',
          status: 'MISSING',
          level: 'REQUIRED',
          details: `Failed to mint DWD token for target user "${targetUser}": ${authErr.message}`,
          remediation: `Authorize Service Account Client ID in Google Workspace Admin Console (admin.google.com > Security > API Controls > Domain-Wide Delegation). If "${targetUser}" is an external Microsoft Entra ID account, change Target IdP to Microsoft Entra ID (WiF).`
        });
        totalMissing++;
      }
    }

    if (tokenInfo && tokenInfo.scope) {
      const activeScopes = tokenInfo.scope.split(' ').map((s: string) => s.trim()).filter(Boolean);

      // cloud-platform is the single broadest Google Cloud OAuth scope. It is handled
      // separately because it is genuinely REQUIRED for the WiF flow (iamcredentials
      // generateAccessToken rejects Discovery-Engine-only scopes), yet in a Workspace
      // Domain-Wide Delegation allowlist it lets the service account act as ANY user
      // against EVERY Google Cloud API. Labelling it "least-privilege" was wrong in
      // both modes; the real privilege boundary is the principal's IAM roles.
      const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform';

      const knownSafeScopes: Record<string, string> = {
        'https://www.googleapis.com/auth/discoveryengine.readwrite': 'Discovery Engine Full Read/Write Scope',
        'https://www.googleapis.com/auth/discoveryengine.assist.readwrite': 'Gemini Enterprise Assist Conversation Scope',
        'https://www.googleapis.com/auth/gmail.send': 'Send-Only Email Scope for Migration Notifications (Safe)'
      };

      const dangerousScopes: Record<string, string> = {
        'https://mail.google.com/': 'Full Mailbox Access (Can read, delete, and download all user emails)',
        'https://www.googleapis.com/auth/drive': 'Full Google Drive Access (Can read and delete all corporate files)',
        'https://www.googleapis.com/auth/admin.directory.user': 'Google Workspace User Admin (Can modify passwords and accounts)',
        'https://www.googleapis.com/auth/admin.directory.group': 'Google Workspace Group Admin'
      };

      for (const scope of activeScopes) {
        if (scope === CLOUD_PLATFORM) {
          scopesAudit.push({
            scope,
            status: 'BROAD',
            description:
              'Full access to every Google Cloud API the principal is authorised for. ' +
              'This is the broadest GCP scope - it is NOT least-privilege. ' +
              'Effective privilege is bounded by the principal\'s IAM roles, not by this scope.'
          });

          // In WiF this scope is required; in DWD it is a real over-provisioning finding,
          // because the DWD allowlist grants it for impersonation of every user in the domain.
          if (isTargetWif) {
            permissions.push({
              id: 'SCOPE_BROAD_CLOUD_PLATFORM',
              category: 'OVER_PROVISIONING',
              name: 'Broad Scope: cloud-platform (required for WiF)',
              status: 'INFO',
              level: 'RECOMMENDED',
              details:
                'cloud-platform is present and is required by Workforce Identity Federation: ' +
                'iamcredentials.generateAccessToken rejects Discovery-Engine-only scopes. ' +
                'It is not least-privilege, so restrict the federated principal using IAM roles.'
            });
          } else {
            permissions.push({
              id: 'SCOPE_BROAD_CLOUD_PLATFORM',
              category: 'OVER_PROVISIONING',
              name: 'Over-Provisioned Scope: cloud-platform (DWD)',
              status: 'OVER_PROVISIONED',
              level: 'DANGEROUS',
              details:
                'The Domain-Wide Delegation allowlist grants cloud-platform, which lets this service account ' +
                'impersonate any user in the domain against every Google Cloud API - far beyond what a ' +
                'Gemini Enterprise migration requires.',
              remediation:
                'In admin.google.com > Security > API Controls > Domain-Wide Delegation, replace cloud-platform with the ' +
                'narrow migration scopes: https://www.googleapis.com/auth/discoveryengine.readwrite and ' +
                'https://www.googleapis.com/auth/discoveryengine.assist.readwrite'
            });
            totalOverProvisioned++;
          }
        } else if (dangerousScopes[scope]) {
          scopesAudit.push({
            scope,
            status: 'EXCESSIVE',
            description: dangerousScopes[scope]
          });
          permissions.push({
            id: `SCOPE_OVER_${scope.split('/').pop()}`,
            category: 'OVER_PROVISIONING',
            name: `Over-Provisioned Scope: ${scope}`,
            status: 'OVER_PROVISIONED',
            level: 'DANGEROUS',
            details: `The Service Account holds dangerous non-migration scope: ${dangerousScopes[scope]}`,
            remediation: `Remove "${scope}" from Domain-Wide Delegation in Google Workspace Admin Console.`
          });
          totalOverProvisioned++;
        } else if (knownSafeScopes[scope]) {
          scopesAudit.push({
            scope,
            status: scope.includes('gmail.send') ? 'OPTIONAL' : 'ALLOWED',
            description: knownSafeScopes[scope]
          });

        } else {
          scopesAudit.push({
            scope,
            status: 'ALLOWED',
            description: 'Custom / Standard API Scope'
          });
        }
      }
    }

    // 3. Audit Source Project Read Access (Using user-delegated DWD / WiF / Service Account token)
    const effectiveToken = srcToken || dwdToken || (await this.authService.getAccessToken().catch(() => null));

    if (effectiveToken) {
      // 3a. Discovery Engine Chat Sessions (Read)
      try {
        const srcBaseUrl = getSafeDiscoveryEngineUrl(sourceLocation);
        const sessRes = await fetch(`${srcBaseUrl}/v1alpha/projects/${sourceProject}/locations/${sourceLocation}/collections/default_collection/engines/${sourceAppId}/sessions`, {
          headers: { 
            'Authorization': `Bearer ${effectiveToken}`,
            'X-Goog-User-Project': sourceProject
          }
        });
        if (sessRes.ok) {
          permissions.push({
            id: 'SRC_SESSIONS_READ',
            category: 'SOURCE_DISCOVERY',
            name: 'Discovery Engine: Read Chat History Sessions',
            status: 'GRANTED',
            level: 'REQUIRED',
            details: `Successfully listed chat sessions in source engine "${sourceAppId}".`
          });
          totalGranted++;
        } else {
          permissions.push({
            id: 'SRC_SESSIONS_READ',
            category: 'SOURCE_DISCOVERY',
            name: 'Discovery Engine: Read Chat History Sessions',
            status: 'MISSING',
            level: 'REQUIRED',
            details: `HTTP ${sessRes.status}: Cannot list chat sessions in source engine "${sourceAppId}".`,
            remediation: `Grant roles/discoveryengine.viewer on project ${sourceProject} to read chat history sessions.`
          });
          totalMissing++;
        }
      } catch (e: any) {
        permissions.push({
          id: 'SRC_SESSIONS_READ',
          category: 'SOURCE_DISCOVERY',
          name: 'Discovery Engine: Read Chat History Sessions',
          status: 'MISSING',
          level: 'REQUIRED',
          details: `Cannot access Discovery Engine sessions in "${sourceProject}": ${e.message}`,
          remediation: `Verify network connectivity and Discovery Engine permissions on project ${sourceProject}.`
        });
        totalMissing++;
      }

      // 3b. Discovery Engine Custom Agents (Read)
      try {
        const srcBaseUrl = getSafeDiscoveryEngineUrl(sourceLocation);
        const agRes = await fetch(`${srcBaseUrl}/v1alpha/projects/${sourceProject}/locations/${sourceLocation}/collections/default_collection/engines/${sourceAppId}/assistants/default_assistant/agents`, {
          headers: { 
            'Authorization': `Bearer ${effectiveToken}`,
            'X-Goog-User-Project': sourceProject
          }
        });
        if (agRes.ok) {
          permissions.push({
            id: 'SRC_AGENTS_READ',
            category: 'SOURCE_DISCOVERY',
            name: 'Discovery Engine: Read Custom Agents & Schemas',
            status: 'GRANTED',
            level: 'REQUIRED',
            details: `Successfully enumerated agents in source engine "${sourceAppId}".`
          });
          totalGranted++;
        } else {
          permissions.push({
            id: 'SRC_AGENTS_READ',
            category: 'SOURCE_DISCOVERY',
            name: 'Discovery Engine: Read Custom Agents & Schemas',
            status: 'MISSING',
            level: 'REQUIRED',
            details: `HTTP ${agRes.status}: Cannot list agents in "${sourceProject}".`,
            remediation: `Grant roles/discoveryengine.viewer on ${sourceProject}.`,
            fixAction: {
              type: 'IAM_AUTO_FIX',
              title: '1-Click Auto-Grant Discovery Engine Viewer',
              projectId: sourceProject,
              member: `serviceAccount:${this.getSaEmail()}`,
              role: 'roles/discoveryengine.viewer',
              steps: [`Grants roles/discoveryengine.viewer on project ${sourceProject} to allow discovery of custom agents.`]
            }
          });
          totalMissing++;
        }
      } catch (e: any) {
        permissions.push({
          id: 'SRC_AGENTS_READ',
          category: 'SOURCE_DISCOVERY',
          name: 'Discovery Engine: Read Custom Agents & Schemas',
          status: 'MISSING',
          level: 'REQUIRED',
          details: `Error querying agents in "${sourceProject}": ${e.message}`,
          remediation: `Grant roles/discoveryengine.viewer on ${sourceProject}.`
        });
        totalMissing++;
      }

      // 3c. Discovery Engine Notebooks (Read)
      try {
        const srcBaseUrl = getSafeDiscoveryEngineUrl(sourceLocation);
        const nbRes = await fetch(`${srcBaseUrl}/v1alpha/projects/${sourceProject}/locations/${sourceLocation}/notebooks:listRecentlyViewed`, {
          headers: { 
            'Authorization': `Bearer ${srcToken || effectiveToken}`,
            'X-Goog-User-Project': sourceProject
          }
        });
        if (nbRes.ok) {
          const nbData: any = await nbRes.json().catch(() => ({}));
          const count = nbData.notebooks?.length || 0;
          permissions.push({
            id: 'SRC_NOTEBOOKS_READ',
            category: 'SOURCE_DISCOVERY',
            name: 'NotebookLM: Read Research Notebooks & Sources',
            status: 'GRANTED',
            level: 'REQUIRED',
            details: `Successfully enumerated notebook library (${count} notebook(s) accessible in source environment).`
          });
          totalGranted++;
        } else {
          permissions.push({
            id: 'SRC_NOTEBOOKS_READ',
            category: 'SOURCE_DISCOVERY',
            name: 'NotebookLM: Read Research Notebooks & Sources',
            status: 'MISSING',
            level: 'RECOMMENDED',
            details: `HTTP ${nbRes.status}: Cannot list private notebooks for "${rawUser}". User delegation or direct notebook URL required.`,
            remediation: isSourceWif
              ? `For Entra ID users, paste specific Notebook ID/URL or direct session token into the Single User Sandbox.`
              : `Ensure user exists in target domain or supply direct Notebook ID.`,
            fixAction: {
              type: 'NAVIGATE_TAB',
              title: 'Open Single User Sandbox Guide',
              targetTab: 'sandbox',
              steps: [
                '1. Click to navigate to the Single User Sandbox in the sidebar.',
                '2. Paste the exact NotebookLM URL (e.g. https://notebooklm.google.com/notebook/...) or Notebook ID.',
                '3. Click Extract Notebook to pull private notes & sources directly.'
              ]
            }
          });
          totalMissing++;
        }
      } catch (e: any) {
        permissions.push({
          id: 'SRC_NOTEBOOKS_READ',
          category: 'SOURCE_DISCOVERY',
          name: 'NotebookLM: Read Research Notebooks & Sources',
          status: 'MISSING',
          level: 'RECOMMENDED',
          details: `Error listing notebooks in "${sourceProject}": ${e.message}`,
          remediation: `Ensure user exists in target domain or supply direct Notebook ID.`
        });
        totalMissing++;
      }
    }

    // 4. Audit Target Project Write Access
    if (effectiveToken) {
      try {
        const tgtBaseUrl = getSafeDiscoveryEngineUrl(targetLocation);
        const tgtRes = await fetch(`${tgtBaseUrl}/v1alpha/projects/${targetProject}/locations/${targetLocation}/collections/default_collection/engines/${targetAppId}`, {
          headers: { 
            'Authorization': `Bearer ${effectiveToken}`,
            'X-Goog-User-Project': targetProject
          }
        });
        if (tgtRes.ok) {
          permissions.push({
            id: 'TGT_ENGINE_VERIFY',
            category: 'TARGET_RESTORE',
            name: 'Target Engine & Collection Verification',
            status: 'GRANTED',
            level: 'REQUIRED',
            details: `Target engine "${targetAppId}" verified and ready for restore in "${targetProject}".`
          });
          totalGranted++;
        } else {
          permissions.push({
            id: 'TGT_ENGINE_VERIFY',
            category: 'TARGET_RESTORE',
            name: 'Target Engine & Collection Verification',
            status: 'MISSING',
            level: 'REQUIRED',
            details: `HTTP ${tgtRes.status}: Target engine "${targetAppId}" could not be verified in "${targetProject}".`,
            remediation: `Ensure target engine "${targetAppId}" exists and migration identity has roles/discoveryengine.editor or roles/discoveryengine.admin on project ${targetProject}.`
          });
          totalMissing++;
        }
      } catch (e: any) {
        permissions.push({
          id: 'TGT_ENGINE_VERIFY',
          category: 'TARGET_RESTORE',
          name: 'Target Engine & Collection Verification',
          status: 'MISSING',
          level: 'REQUIRED',
          details: `Error verifying target engine in "${targetProject}": ${e.message}`,
          remediation: `Verify network connectivity and Discovery Engine permissions on target project ${targetProject}.`
        });
        totalMissing++;
      }
    }

    // 5. Audit Target Project Organization Policies (SA Key Creation, Cross-Project, Allowed Domains)
    //
    // IMPORTANT: a failed policy read is NOT evidence that the policy is unenforced.
    // `gcloud org-policies describe` fails with PERMISSION_DENIED when the caller lacks
    // orgpolicy.policy.get, when gcloud is absent, or when the project does not exist.
    // Reporting those cases as GRANTED ("policy allows key creation") fabricates a verdict
    // the tool never established, so every unreadable constraint is reported as UNKNOWN.
    if (targetProject) {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const safeTargetProj = targetProject.replace(/[^a-zA-Z0-9\-_]/g, '');

      type PolicyRead =
        | { ok: true; policy: any }
        | { ok: false; error: string };

      const checkPolicy = async (constraint: string): Promise<PolicyRead> => {
        try {
          const { stdout } = await execFileAsync('gcloud', [
            'org-policies',
            'describe',
            constraint,
            '--effective',
            `--project=${safeTargetProj}`,
            '--format=json'
          ]);
          return { ok: true, policy: JSON.parse(stdout || '{}') };
        } catch (err: any) {
          // Never swallow: the reason the read failed determines whether the
          // downstream verdict is trustworthy.
          const detail = (err?.stderr || err?.message || String(err)).toString().trim();
          logger.warn(
            `Org policy read failed for "${constraint}" on project "${safeTargetProj}": ${detail}`
          );
          return { ok: false, error: detail.split('\n')[0] || 'unknown error' };
        }
      };

      const [keyCreationRead, crossProjectRead, allowedDomainsRead] = await Promise.all([
        checkPolicy('constraints/iam.disableServiceAccountKeyCreation'),
        checkPolicy('constraints/iam.disableCrossProjectServiceAccountUsage'),
        checkPolicy('constraints/iam.allowedPolicyMemberDomains')
      ]);

      const isEnforced = (policy: any): boolean =>
        policy?.spec?.rules?.some((r: any) => r.enforce === true) ?? false;

      const pushPolicyUnknown = (
        id: string,
        name: string,
        constraint: string,
        error: string,
        category: PermissionCheckItem['category'] = 'TARGET_RESTORE'
      ) => {
        permissions.push({
          id,
          category,
          name,
          status: 'UNKNOWN',
          level: 'RECOMMENDED',
          details:
            `Could not read organization policy "${constraint}" on project ${safeTargetProj}: ${error}. ` +
            `This check did not run - no conclusion about this constraint should be drawn from this report.`,
          remediation:
            `Grant roles/orgpolicy.policyViewer (or orgpolicy.policy.get) on ${safeTargetProj} to the account running this tool, ` +
            `or verify the constraint manually: gcloud org-policies describe ${constraint} --effective --project=${safeTargetProj}`
        });
        totalUnknown++;
      };

      // 5a. Service Account Key Creation
      if (isTargetWif) {
        // Factually true, but it verifies nothing about this environment, so it earns no score.
        permissions.push({
          id: 'ORG_POLICY_KEY_CREATION',
          category: 'WIF_FEDERATION',
          name: 'Org Policy: Service Account Key Exemption (WiF)',
          status: 'INFO',
          level: 'RECOMMENDED',
          details:
            `Not applicable: Workforce Identity Federation uses short-lived STS tokens and does not create ` +
            `service account keys, so "constraints/iam.disableServiceAccountKeyCreation" cannot block this migration. ` +
            `This is a property of WiF, not a verified check against project ${safeTargetProj}.`
        });
      } else if (!keyCreationRead.ok) {
        pushPolicyUnknown(
          'ORG_POLICY_KEY_CREATION',
          'Org Policy: Service Account Key Creation (DWD)',
          'constraints/iam.disableServiceAccountKeyCreation',
          keyCreationRead.error
        );
      } else if (isEnforced(keyCreationRead.policy)) {
        permissions.push({
          id: 'ORG_POLICY_KEY_CREATION',
          category: 'TARGET_RESTORE',
          name: 'Org Policy: Service Account Key Creation (DWD)',
          status: 'MISSING',
          level: 'REQUIRED',
          details: `Organization policy "constraints/iam.disableServiceAccountKeyCreation" is enforced on ${safeTargetProj}. Generating sa-dwd-key.json will fail.`,
          remediation: `Apply a project-level override on ${safeTargetProj} (enforce: false) or switch to Workforce Identity Federation (WiF).`,
          fixAction: {
            type: 'NAVIGATE_TAB',
            title: 'Apply Org Policy Override in DWD Tab',
            targetTab: 'dwd',
            steps: [
              `1. Switch to the Domain-Wide Delegation (DWD) tab in the wizard.`,
              `2. Click "1-Click Project Override" under Step 1 to allow key creation for ${safeTargetProj}.`,
              `3. Or switch to the WiF tab for keyless authentication.`
            ]
          }
        });
        totalMissing++;
      } else {
        permissions.push({
          id: 'ORG_POLICY_KEY_CREATION',
          category: 'TARGET_RESTORE',
          name: 'Org Policy: Service Account Key Creation (DWD)',
          status: 'GRANTED',
          level: 'REQUIRED',
          details: `Verified: organization policy allows service account key creation on project ${safeTargetProj}.`
        });
        totalGranted++;
      }

      // 5b. Cross-Project Service Account Usage.
      // Enforcement is a CONSTRAINT on the migration, not a permission the tool holds,
      // so it is reported as INFO and never credited to the score.
      if (!crossProjectRead.ok) {
        pushPolicyUnknown(
          'ORG_POLICY_CROSS_PROJECT',
          'Org Policy: Cross-Project Service Account Usage',
          'constraints/iam.disableCrossProjectServiceAccountUsage',
          crossProjectRead.error
        );
      } else if (isEnforced(crossProjectRead.policy)) {
        permissions.push({
          id: 'ORG_POLICY_CROSS_PROJECT',
          category: 'TARGET_RESTORE',
          name: 'Org Policy: Cross-Project Service Account Usage',
          status: 'INFO',
          level: 'RECOMMENDED',
          details:
            `Cross-project service account usage is DISABLED by org policy on ${safeTargetProj}. ` +
            `The migration service account must be created natively inside ${safeTargetProj}; ` +
            `reusing a service account from another project will fail.`,
          remediation: `Create the migration service account directly in ${safeTargetProj}, or request an override for "constraints/iam.disableCrossProjectServiceAccountUsage".`
        });
      }

      // 5c. Domain-Restricted Sharing.
      if (!allowedDomainsRead.ok) {
        pushPolicyUnknown(
          'ORG_POLICY_ALLOWED_DOMAINS',
          'Org Policy: Domain-Restricted Sharing',
          'constraints/iam.allowedPolicyMemberDomains',
          allowedDomainsRead.error
        );
      } else {
        const allowedValues =
          allowedDomainsRead.policy?.spec?.rules?.flatMap((r: any) => r.values?.allowedValues || []) || [];
        if (allowedValues.length > 0) {
          permissions.push({
            id: 'ORG_POLICY_ALLOWED_DOMAINS',
            category: 'TARGET_RESTORE',
            name: 'Org Policy: Domain-Restricted Sharing',
            status: 'INFO',
            level: 'RECOMMENDED',
            details:
              `Domain-restricted sharing is ACTIVE on ${safeTargetProj} (${allowedValues.length} allowed customer IDs / principal sets). ` +
              `IAM bindings for external or federated users outside those domains will be rejected.`,
            remediation: `Confirm the target users' customer ID is present in "constraints/iam.allowedPolicyMemberDomains", or request an override on ${safeTargetProj}.`
          });
        }
      }
    }

    // 6. Destructive Permission Exposure on the Source Project.
    //
    // This previously asserted "Source environment is immutable. No destructive teardown
    // permissions exposed." without performing any check. That claim is frequently FALSE:
    // an operator with roles/discoveryengine.admin or roles/owner does hold engines.delete.
    // It is now resolved with a real cloudresourcemanager testIamPermissions probe.
    if (effectiveToken && sourceProject) {
      const DESTRUCTIVE_SOURCE_PERMISSIONS = [
        'discoveryengine.engines.delete',
        'discoveryengine.dataStores.delete',
        'discoveryengine.documents.delete'
      ];

      try {
        const permRes = await fetch(
          `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(sourceProject)}:testIamPermissions`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${effectiveToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ permissions: DESTRUCTIVE_SOURCE_PERMISSIONS })
          }
        );

        if (!permRes.ok) {
          const body = await permRes.text().catch(() => '');
          permissions.push({
            id: 'SEC_DESTRUCTIVE_ENGINE_DELETE',
            category: 'OVER_PROVISIONING',
            name: 'Source Destructive Permission Exposure',
            status: 'UNKNOWN',
            level: 'RECOMMENDED',
            details:
              `Could not determine whether the migration principal holds destructive permissions on source project ` +
              `"${sourceProject}" (HTTP ${permRes.status}${body ? `: ${body.slice(0, 200)}` : ''}). ` +
              `The source must NOT be assumed read-only.`,
            remediation: `Verify manually: gcloud projects get-iam-policy ${sourceProject} and confirm no principal used by this tool holds ${DESTRUCTIVE_SOURCE_PERMISSIONS.join(', ')}.`
          });
          totalUnknown++;
        } else {
          const heldRaw: any = await permRes.json().catch(() => ({}));
          const held: string[] = Array.isArray(heldRaw?.permissions) ? heldRaw.permissions : [];


          if (held.length > 0) {
            permissions.push({
              id: 'SEC_DESTRUCTIVE_ENGINE_DELETE',
              category: 'OVER_PROVISIONING',
              name: 'Source Destructive Permission Exposure',
              status: 'OVER_PROVISIONED',
              level: 'DANGEROUS',
              details:
                `The migration principal holds ${held.length} destructive permission(s) on the SOURCE project ` +
                `"${sourceProject}": ${held.join(', ')}. The source is therefore NOT immutable - a bug or ` +
                `misdirected teardown could permanently delete source data before the migration is verified.`,
              remediation: `Run the migration with a read-only principal on the source (e.g. roles/discoveryengine.viewer) and remove delete permissions from ${sourceProject}.`
            });
            totalOverProvisioned++;
          } else {
            permissions.push({
              id: 'SEC_DESTRUCTIVE_ENGINE_DELETE',
              category: 'OVER_PROVISIONING',
              name: 'Source Destructive Permission Exposure',
              status: 'GRANTED',
              level: 'RECOMMENDED',
              details:
                `Verified via testIamPermissions: the migration principal holds none of ` +
                `${DESTRUCTIVE_SOURCE_PERMISSIONS.join(', ')} on source project "${sourceProject}".`
            });
            totalGranted++;
          }
        }
      } catch (e: any) {
        permissions.push({
          id: 'SEC_DESTRUCTIVE_ENGINE_DELETE',
          category: 'OVER_PROVISIONING',
          name: 'Source Destructive Permission Exposure',
          status: 'UNKNOWN',
          level: 'RECOMMENDED',
          details: `Destructive-permission probe against "${sourceProject}" could not complete: ${e.message}. The source must NOT be assumed read-only.`,
          remediation: `Verify manually with: gcloud projects get-iam-policy ${sourceProject}`
        });
        totalUnknown++;
      }
    }

    // Calculate Summary & Security Grade
    const totalChecked = permissions.length;

    // Only checks that actually produced evidence can contribute to the score.
    // INFO items are contextual and are excluded from both numerator and denominator;
    // UNKNOWN items count against completeness so an unverifiable audit cannot grade A+.
    const scorable = permissions.filter((p) => p.status !== 'INFO').length;
    const score = Math.max(
      0,
      Math.round(((totalGranted - totalOverProvisioned * 1.5) / Math.max(scorable, 1)) * 100)
    );

    let overallGrade: 'A+' | 'A' | 'B' | 'C' | 'F' = 'A+';
    let overallStatus:
      | 'LEAST_PRIVILEGE_COMPLIANT'
      | 'OVER_PROVISIONED'
      | 'MISSING_PERMISSIONS'
      | 'AUTHENTICATION_FAILED'
      | 'VERIFICATION_INCOMPLETE' = 'LEAST_PRIVILEGE_COMPLIANT';

    if (!effectiveToken && !isTargetWif) {
      overallGrade = 'F';
      overallStatus = 'AUTHENTICATION_FAILED';
    } else if (totalMissing > 0 && totalOverProvisioned > 0) {
      overallGrade = 'C';
      overallStatus = 'OVER_PROVISIONED';
    } else if (totalOverProvisioned > 0) {
      overallGrade = 'B';
      overallStatus = 'OVER_PROVISIONED';
    } else if (totalMissing > 0) {
      overallGrade = 'B';
      overallStatus = 'MISSING_PERMISSIONS';
    } else if (totalUnknown > 0) {
      // Nothing failed, but the audit could not verify everything it claims to cover.
      // Reporting "LEAST_PRIVILEGE_COMPLIANT" here would be an unearned pass.
      overallGrade = 'B';
      overallStatus = 'VERIFICATION_INCOMPLETE';
    } else {
      overallGrade = 'A+';
      overallStatus = 'LEAST_PRIVILEGE_COMPLIANT';
    }


    // Gather unique remediations
    for (const p of permissions) {
      if (p.remediation && !remediations.includes(p.remediation)) {
        remediations.push(p.remediation);
      }
    }

    return {
      overallGrade,
      overallStatus,
      authArchitecture: {
        sourceAuthType,
        targetAuthType,
        sourceUser: rawUser,
        targetUser,
        wifAudience: wifAudience || undefined
      },
      summary: {
        totalChecked,
        totalGranted,
        totalMissing,
        totalOverProvisioned,
        totalUnknown,
        score
      },

      scopesAudit,
      permissions,
      remediations
    };
  }

  private getSaEmail(): string {
    try {
      const saPath = process.env.SERVICE_ACCOUNT_KEY_PATH || './sa-dwd-key.json';
      if (fs.existsSync(saPath)) {
        const key = JSON.parse(fs.readFileSync(saPath, 'utf8'));
        if (key.client_email) return key.client_email;
      }
    } catch {}
    return process.env.SERVICE_ACCOUNT_EMAIL || 'migration-service-account@project.iam.gserviceaccount.com';
  }
}
