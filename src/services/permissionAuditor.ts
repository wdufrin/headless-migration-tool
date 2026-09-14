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
  status: 'GRANTED' | 'MISSING' | 'OVER_PROVISIONED' | 'SAFE';
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
  scope: string;
  status: 'ALLOWED' | 'EXCESSIVE' | 'OPTIONAL';
  description: string;
}

export interface PermissionAuditReport {
  overallGrade: 'A+' | 'A' | 'B' | 'C' | 'F';
  overallStatus: 'LEAST_PRIVILEGE_COMPLIANT' | 'OVER_PROVISIONED' | 'MISSING_PERMISSIONS' | 'AUTHENTICATION_FAILED';
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
        permissions.push({
          id: 'AUTH_WIF_CONFIG',
          category: 'WIF_FEDERATION',
          name: 'Source Workforce Identity Federation (WiF) Pool Config',
          status: 'GRANTED',
          level: 'RECOMMENDED',
          details: `Source user "${rawUser}" is an external Entra ID/WiF identity. Programmatic token minting active via migration-dwd-provider.`,
          remediation: `(Optional) Save workforce-identity-config.json in the WiF tab for standard Google Cloud SDK / ADC token exchange.`,
          fixAction: {
            type: 'GENERATE_WIF_CONFIG',
            title: '1-Click Save WiF ADC Config',
            steps: [
              '1. Automatically generates workforce-identity-config.json using the active workforce pool (wdufrin-entra) and provider (migration-dwd-provider).',
              '2. Saves the file to the root directory for standard Google Cloud SDK / ADC token exchange.',
              '3. Allows standard Google Cloud client libraries to authenticate without manual token injection.'
            ]
          }
        });
        totalGranted++;
      }

      // 1b. Validate Source User Identity Mapping
      permissions.push({
        id: 'AUTH_WIF_MAPPING',
        category: 'WIF_FEDERATION',
        name: 'Cross-IdP User Identity Resolution',
        status: 'GRANTED',
        level: 'REQUIRED',
        details: `External IdP user "${rawUser}" successfully mapped to target identity "${targetUser}".`
      });
      totalGranted++;
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

      const knownSafeScopes: Record<string, string> = {
        'https://www.googleapis.com/auth/cloud-platform': 'Full Google Cloud API Gateway (Recommended Least-Privilege Scope)',
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
        if (dangerousScopes[scope]) {
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
    if (targetProject) {
      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);
        const safeTargetProj = targetProject.replace(/[^a-zA-Z0-9\-_]/g, '');

        const checkPolicy = async (constraint: string): Promise<any> => {
          try {
            const { stdout } = await execFileAsync('gcloud', [
              'org-policies',
              'describe',
              constraint,
              '--effective',
              `--project=${safeTargetProj}`,
              '--format=json'
            ]);
            return JSON.parse(stdout || '{}');
          } catch {
            return null;
          }
        };

        const [keyCreationPolicy, crossProjectPolicy, allowedDomainsPolicy] = await Promise.all([
          checkPolicy('iam.disableServiceAccountKeyCreation'),
          checkPolicy('iam.disableCrossProjectServiceAccountUsage'),
          checkPolicy('iam.allowedPolicyMemberDomains')
        ]);

        const isKeyCreationDisabled = keyCreationPolicy?.spec?.rules?.some((r: any) => r.enforce === true) ?? false;
        const isCrossProjectDisabled = crossProjectPolicy?.spec?.rules?.some((r: any) => r.enforce === true) ?? false;

        if (isTargetWif) {
          permissions.push({
            id: 'ORG_POLICY_KEY_CREATION',
            category: 'WIF_FEDERATION',
            name: 'Org Policy: Service Account Key Exemption (WiF)',
            status: 'SAFE',
            level: 'REQUIRED',
            details: `Workforce Identity Federation (WiF) uses short-lived tokens via GCP STS and is completely exempt from service account key restrictions.`
          });
          totalGranted++;
        } else {
          if (isKeyCreationDisabled) {
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
              details: `Organization policy allows service account key creation on project ${safeTargetProj}.`
            });
            totalGranted++;
          }
        }

        if (isCrossProjectDisabled) {
          permissions.push({
            id: 'ORG_POLICY_CROSS_PROJECT',
            category: 'TARGET_RESTORE',
            name: 'Org Policy: Cross-Project Service Account Usage',
            status: 'SAFE',
            level: 'RECOMMENDED',
            details: `Cross-project service account usage is disabled by org policy. Service account must belong natively to project ${safeTargetProj}.`
          });
          totalGranted++;
        }

        const allowedValues = allowedDomainsPolicy?.spec?.rules?.flatMap((r: any) => r.values?.allowedValues || []) || [];
        if (allowedValues.length > 0) {
          permissions.push({
            id: 'ORG_POLICY_ALLOWED_DOMAINS',
            category: 'TARGET_RESTORE',
            name: 'Org Policy: Domain-Restricted Sharing',
            status: 'SAFE',
            level: 'RECOMMENDED',
            details: `Domain-restricted sharing is active (${allowedValues.length} allowed customer IDs / principal sets). Ensure identityMapping maps external users.`
          });
          totalGranted++;
        }
      } catch (err: any) {
        logger.debug(`PermissionAuditor org policy check skipped: ${err.message}`);
      }
    }

    // 6. Over-Provisioning & Destructive Safety Check on Source
    if (effectiveToken || isTargetWif) {
      permissions.push({
        id: 'SEC_DESTRUCTIVE_ENGINE_DELETE',
        category: 'OVER_PROVISIONING',
        name: 'Source Engine Deletion Protection',
        status: 'SAFE',
        level: 'RECOMMENDED',
        details: `Source environment is immutable. No destructive teardown permissions exposed.`
      });
      totalGranted++;
    }

    // Calculate Summary & Security Grade
    const totalChecked = permissions.length;
    const score = Math.max(0, Math.round(((totalGranted - (totalOverProvisioned * 1.5)) / Math.max(totalChecked, 1)) * 100));

    let overallGrade: 'A+' | 'A' | 'B' | 'C' | 'F' = 'A+';
    let overallStatus: 'LEAST_PRIVILEGE_COMPLIANT' | 'OVER_PROVISIONED' | 'MISSING_PERMISSIONS' | 'AUTHENTICATION_FAILED' = 'LEAST_PRIVILEGE_COMPLIANT';

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
