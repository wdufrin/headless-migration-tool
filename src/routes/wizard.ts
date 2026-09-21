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

import express from 'express';
import fs from 'fs';
import path from 'path';
import { GcpAuthService, CLOUD_PLATFORM_SCOPE } from '../services/gcpAuth.js';
import { IdentityMappingService } from '../services/identityMappingService.js';
import { buildWorkforcePrincipal } from '../utils/wifPrincipal.js';
import {
  checkSubjectMapping,
  deriveAlignedMigrationAttributeMapping,
  inspectGeAppWorkforceConfig,
  listPoolProviders,
  parseProviders
} from '../services/wifPreflight.js';
import { logger } from '../utils/logger.js';

import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { getSafeDiscoveryEngineUrl } from '../security/validator.js';
import { extractUserIdentity } from './discovery.js';
import { AppStateTracker } from '../services/appStateTracker.js';

export const wizardRouter = express.Router();

// IdP Presets Endpoint
wizardRouter.get('/idp/presets', async (_req, res) => {
  try {
    const authService = new GcpAuthService();
    const callerIdentity = await authService.getCallerIdentity().catch(() => undefined);
    let detectedTargetDomain = '@yourcompany.com';
    if (callerIdentity && callerIdentity.includes('@')) {
      detectedTargetDomain = '@' + callerIdentity.split('@')[1];
    }
    return res.status(200).json({
      presets: IdentityMappingService.getIdpPresets(),
      detectedTargetDomain,
      callerIdentity
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'FailedToGetPresets', message: err.message });
  }
});

// IdP Auto-Mapping Preview & Transformation Endpoint
wizardRouter.post('/idp/auto-map', async (req, res) => {
  try {
    const { sourceUsers, domainRules, explicitMappings, fallbackUserEmail, sourceProjectId, sourceLocation, sourceAppId } = req.body || {};

    let usersToMap: string[] = Array.isArray(sourceUsers) ? sourceUsers : [];

    // If sourceUsers is empty and sourceProjectId is provided, discover users dynamically
    if (usersToMap.length === 0 && sourceProjectId) {
      try {
        const saKeyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || 
          (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);
        const wifConfigPath = process.env.WORKFORCE_IDENTITY_CONFIG_PATH ||
          (fs.existsSync('./workforce-identity-config.json') ? './workforce-identity-config.json' : undefined);
        const authService = new GcpAuthService({
          staticToken: req.accessToken,
          serviceAccountKeyPath: saKeyPath,
          wifConfigPath
        });
        const token = await authService.getAccessToken().catch(() => null);
        const location = sourceLocation || 'global';
        const baseUrl = getSafeDiscoveryEngineUrl(location);
        if (token) {
          const enginesToScan: string[] = [];
          if (sourceAppId && sourceAppId !== 'all' && sourceAppId !== 'custom') {
            enginesToScan.push(sourceAppId);
          } else {
            const client = new DiscoveryEngineClient(authService);
            const listed = await client.listEngines({ projectId: sourceProjectId, appLocation: location });
            for (const eng of listed) {
              const eid = eng.name?.split('/').pop() || eng.id;
              if (eid) enginesToScan.push(eid);
            }
          }
          for (const curApp of enginesToScan) {
            const agUrl = `${baseUrl}/v1alpha/projects/${sourceProjectId}/locations/${location}/collections/default_collection/engines/${curApp}/assistants/default_assistant/agents?pageSize=100`;
            const agResp = await fetch(agUrl, {
              headers: { 'Authorization': `Bearer ${token}`, 'X-Goog-User-Project': sourceProjectId }
            });
            if (agResp.ok) {
              const agData: any = await agResp.json();
              for (const a of (agData.agents || [])) {
                const directOwner = extractUserIdentity(a.owner || a.creator || a.skillAgentDefinition?.owner || '');
                if (directOwner && !usersToMap.includes(directOwner)) {
                  usersToMap.push(directOwner);
                }
                const iamRes = await fetch(`${baseUrl}/v1alpha/${a.name}:getIamPolicy`, {
                  headers: { 'Authorization': `Bearer ${token}`, 'X-Goog-User-Project': sourceProjectId }
                });
                if (iamRes.ok) {
                  const iamData: any = await iamRes.json();
                  for (const binding of iamData.bindings || []) {
                    for (const m of binding.members || []) {
                      const cleanEmail = extractUserIdentity(m);
                      if (cleanEmail && !usersToMap.includes(cleanEmail)) {
                        usersToMap.push(cleanEmail);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } catch (discErr: any) {
        logger.debug(`Could not discover users for auto-map preview: ${discErr.message}`);
      }
    }

    const mappingService = new IdentityMappingService({
      domainRules: domainRules || [],
      explicitMappings: explicitMappings || {},
      defaultFallbackEmail: fallbackUserEmail
    });

    const mappedResults = mappingService.autoMapUserList(usersToMap);
    return res.status(200).json({
      totalUsers: mappedResults.length,
      mappings: mappedResults
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'AutoMapFailed', message: err.message });
  }
});

// CSV Identity Mapping Upload / Parse & Audit Report Endpoint
wizardRouter.post('/idp/parse-csv', async (req, res) => {
  try {
    const {
      csvContent,
      defaultSourceDomain,
      defaultTargetDomain,
      discoveredUsers = [],
      domainRules = [],
      existingExplicitMappings = {}
    } = req.body || {};

    if (!csvContent || typeof csvContent !== 'string' || !csvContent.trim()) {
      return res.status(400).json({
        error: 'EmptyCsvContent',
        message: 'Please provide non-empty CSV content mapping source user IDs to target user IDs.'
      });
    }

    const parseResult = IdentityMappingService.parseCsvMappings(csvContent, {
      defaultSourceDomain,
      defaultTargetDomain
    });

    const mergedMappings: Record<string, string> = {
      ...(typeof existingExplicitMappings === 'object' ? existingExplicitMappings : {}),
      ...parseResult.mappings
    };

    const mappingService = new IdentityMappingService({
      domainRules: Array.isArray(domainRules) ? domainRules : [],
      explicitMappings: mergedMappings
    });

    const csvKeys = new Set(Object.keys(parseResult.mappings));
    const auditReport = mappingService.generateMappingAuditReport(
      Array.isArray(discoveredUsers) ? discoveredUsers : [],
      csvKeys
    );

    return res.status(200).json({
      parseResult,
      mergedMappings,
      auditReport
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'CsvParseFailed', message: err.message });
  }
});

// Generate Identity Mapping Audit & Reconciliation Report
wizardRouter.post('/idp/mapping-report', async (req, res) => {
  try {
    const {
      discoveredUsers = [],
      explicitMappings = {},
      csvMappedKeys = [],
      domainRules = [],
      fallbackUserEmail
    } = req.body || {};

    const mappingService = new IdentityMappingService({
      domainRules: Array.isArray(domainRules) ? domainRules : [],
      explicitMappings: typeof explicitMappings === 'object' ? explicitMappings : {},
      defaultFallbackEmail: fallbackUserEmail
    });

    const auditReport = mappingService.generateMappingAuditReport(
      Array.isArray(discoveredUsers) ? discoveredUsers : [],
      new Set(Array.isArray(csvMappedKeys) ? csvMappedKeys.map((k: string) => String(k).toLowerCase().trim()) : [])
    );

    return res.status(200).json({
      auditReport
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'MappingReportFailed', message: err.message });
  }
});

// Wizard: Inspect local DWD Service Account Key & Client ID
wizardRouter.get('/wizard/dwd-info', async (_req, res) => {
  try {
    let sourceProjectId = process.env.SOURCE_PROJECT_ID || process.env.GCP_PROJECT_ID || '';
    if (!sourceProjectId) {
      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync('gcloud', ['config', 'get-value', 'project']);
        sourceProjectId = stdout.trim();
      } catch {}
    }

    const keyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : null);
    if (!keyPath || !fs.existsSync(keyPath)) {
      return res.status(200).json({ exists: false, sourceProjectId: sourceProjectId || '' });
    }
    const content = fs.readFileSync(keyPath, 'utf-8');
    const parsed = JSON.parse(content);
    const targetProject = parsed.project_id || '';
    return res.status(200).json({
      exists: true,
      filePath: keyPath,
      clientEmail: parsed.client_email || '',
      clientId: parsed.client_id || '',
      projectId: targetProject,
      targetProjectId: targetProject,
      sourceProjectId: sourceProjectId || ''
    });
  } catch (err: any) {
    return res.status(200).json({ exists: false, error: err.message });
  }
});

// Wizard: Test Domain-Wide Delegation (DWD)
wizardRouter.post('/wizard/test-dwd', async (req, res) => {
  try {
    const { testUserEmail, keyPath, keyJson } = req.body || {};
    if (!testUserEmail) {
      return res.status(200).json({ 
        success: false, 
        error: 'MissingEmail', 
        message: 'testUserEmail is required to verify DWD impersonation.' 
      });
    }

    const effectiveKeyPath = keyPath || (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);
    const authService = new GcpAuthService({
      serviceAccountKeyPath: effectiveKeyPath,
      serviceAccountKeyJson: keyJson
    });

    if (!authService.hasDwdConfigured()) {
      return res.status(200).json({
        success: false,
        error: 'KeyNotFound',
        message: 'No Service Account Key found. Please upload or specify a valid sa-dwd-key.json path.'
      });
    }

    let clientId = '';
    let clientEmail = '';
    try {
      if (keyJson) {
        const k = typeof keyJson === 'string' ? JSON.parse(keyJson) : keyJson;
        clientId = k.client_id || '';
        clientEmail = k.client_email || '';
      } else if (effectiveKeyPath && fs.existsSync(effectiveKeyPath)) {
        const k = JSON.parse(fs.readFileSync(effectiveKeyPath, 'utf-8'));
        clientId = k.client_id || '';
        clientEmail = k.client_email || '';
      }
    } catch {}

    const scopes = [
      'https://www.googleapis.com/auth/discoveryengine.readwrite',
      'https://www.googleapis.com/auth/discoveryengine.assist.readwrite'
    ];

    try {
      const token = await authService.mintDwdToken(testUserEmail, scopes);

      return res.status(200).json({
        success: true,
        message: `DWD impersonation successful for "${testUserEmail}". Minted valid user-scoped OAuth2 token.`,
        tokenPrefix: token ? `${token.substring(0, 15)}...` : 'None',
        clientId,
        clientEmail,
        scopesVerified: scopes
      });
    } catch (dwdErr: any) {
      const isAccessDenied = dwdErr.message?.includes('access_denied') || dwdErr.message?.includes('Requested client not authorized');
      return res.status(200).json({
        success: false,
        error: 'DwdImpersonationFailed',
        clientId,
        clientEmail,
        testUserEmail,
        isAccessDenied,
        message: `DWD impersonation failed: ${dwdErr.message}`,
        remediation: isAccessDenied ? [
          `Authorize Client ID "${clientId || 'from sa-dwd-key.json'}" in Google Workspace Admin Console (admin.google.com/ac/owl/domainwidedelegation).`,
          `Ensure the user email "${testUserEmail}" belongs to the Google Workspace domain where the Client ID was authorized.`,
          `Ensure the exact OAuth scopes (${scopes.join(', ')}) are configured.`,
          `If you just added the Client ID to Google Admin Console, please allow 5-15 minutes for global Google Workspace propagation.`
        ] : [
          `Verify network connectivity to oauth2.googleapis.com.`,
          `Ensure the service account key has not been revoked or expired.`
        ]
      });
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'TestDwdError', message: err.message });
  }
});

// Wizard: Audit IAM & OAuth Permissions & Least-Privilege Compliance
wizardRouter.post('/wizard/audit-permissions', async (req, res) => {
  try {
    const { PermissionAuditor } = await import('../services/permissionAuditor.js');

    const {
      authMode,
      sourceIdp,
      targetIdp,
      sourceProject,
      sourceLocation,
      sourceAppId,
      targetProject,
      targetLocation,
      targetAppId,
      sourceUserEmail,
      targetUserEmail,
      testUserEmail,
      keyPath,
      wifConfigPath
    } = req.body || {};

    const authService = new GcpAuthService({
      serviceAccountKeyPath: keyPath || './sa-dwd-key.json'
    });

    const auditor = new PermissionAuditor(authService);
    const report = await auditor.audit({
      authMode,
      sourceIdp,
      targetIdp,
      sourceProject,
      sourceLocation,
      sourceAppId,
      targetProject,
      targetLocation,
      targetAppId,
      sourceUserEmail: sourceUserEmail || testUserEmail,
      targetUserEmail,
      testUserEmail,
      keyPath,
      wifConfigPath
    });

    return res.status(200).json(report);
  } catch (err: any) {
    return res.status(500).json({ error: 'AuditPermissionsFailed', message: err.message });
  }
});

// Strict allowlist of approved IAM roles for automated migration provisioning
export const ALLOWED_MIGRATION_ROLES = new Set([
  'roles/discoveryengine.admin',
  'roles/discoveryengine.viewer',
  'roles/discoveryengine.editor',
  'roles/serviceusage.serviceUsageConsumer',
  'roles/iam.serviceAccountTokenCreator',
  'roles/agentregistry.admin',
  'roles/agentregistry.viewer'
]);

// Wizard: 1-Click Auto-Fix IAM Policy Binding
wizardRouter.post('/wizard/auto-fix-iam', async (req, res) => {
  try {
    const { projectId, member, role } = req.body || {};
    if (!projectId || !member || !role) {
      return res.status(400).json({ error: 'MissingParameters', message: 'projectId, member, and role are required.' });
    }

    const safeProj = projectId.replace(/[^a-zA-Z0-9\-_]/g, '');
    const safeRole = role.replace(/[^a-zA-Z0-9\-_./]/g, '');
    const safeMember = member.replace(/[^a-zA-Z0-9\-_.@:/]/g, '');

    // Security Gate: Restrict role to pre-approved least-privilege migration roles
    if (!ALLOWED_MIGRATION_ROLES.has(safeRole)) {
      logger.warn(`Rejected unauthorized IAM auto-fix attempt: Role "${safeRole}" is not in approved allowlist.`);
      return res.status(403).json({
        error: 'ForbiddenRole',
        message: `Role "${safeRole}" is not approved for automated provisioning. Allowed migration roles: ${Array.from(ALLOWED_MIGRATION_ROLES).join(', ')}`
      });
    }

    // Security Gate: Validate member format (must be serviceAccount, user, group, or workforce principal)
    const validMemberPrefix = /^(serviceAccount|user|group|principal|principalSet):/i.test(safeMember);
    if (!validMemberPrefix || safeMember.length < 5) {
      return res.status(400).json({
        error: 'InvalidMemberFormat',
        message: `Member "${safeMember}" must include a valid GCP IAM principal prefix (e.g. serviceAccount:..., user:..., principal:...).`
      });
    }

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    logger.info(`Executing Auto-Fix IAM: gcloud projects add-iam-policy-binding ${safeProj} --member="${safeMember}" --role="${safeRole}"`);

    const { stdout } = await execFileAsync('gcloud', [
      'projects',
      'add-iam-policy-binding',
      safeProj,
      `--member=${safeMember}`,
      `--role=${safeRole}`,
      '--quiet'
    ]);
    return res.status(200).json({
      success: true,
      message: `Successfully granted "${safeRole}" to "${safeMember}" on project "${safeProj}".`,
      stdout
    });
  } catch (err: any) {
    logger.error(`Auto-Fix IAM failed: ${err.message}`);
    return res.status(500).json({ error: 'AutoFixFailed', message: err.message });
  }
});

// Wizard: Check Organization Policies on Project for DWD & WiF
wizardRouter.post('/wizard/check-org-policies', async (req, res) => {
  try {
    const { projectId, organizationId } = req.body || {};
    if (!projectId) {
      return res.status(400).json({ error: 'MissingProjectId', message: 'projectId is required to evaluate organization policies.' });
    }

    const safeProj = String(projectId).replace(/[^a-zA-Z0-9\-_]/g, '');
    const safeOrg = organizationId ? String(organizationId).replace(/[^0-9]/g, '') : undefined;

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const checkPolicy = async (constraint: string): Promise<any> => {
      try {
        const { stdout } = await execFileAsync('gcloud', [
          'org-policies',
          'describe',
          constraint,
          '--effective',
          `--project=${safeProj}`,
          '--format=json'
        ]);
        return JSON.parse(stdout || '{}');
      } catch (err: any) {
        return null;
      }
    };

    const [keyCreation, crossProject, allowedDomains, allowedDataSources, keyUpload] = await Promise.all([
      checkPolicy('iam.disableServiceAccountKeyCreation'),
      checkPolicy('iam.disableCrossProjectServiceAccountUsage'),
      checkPolicy('iam.allowedPolicyMemberDomains'),
      checkPolicy('discoveryengine.managed.allowedDataSources'),
      checkPolicy('iam.disableServiceAccountKeyUpload')
    ]);

    const isKeyCreationDisabled = keyCreation?.spec?.rules?.some((r: any) => r.enforce === true) ?? false;
    const isCrossProjectDisabled = crossProject?.spec?.rules?.some((r: any) => r.enforce === true) ?? false;
    const isKeyUploadDisabled = keyUpload?.spec?.rules?.some((r: any) => r.enforce === true) ?? false;
    const allowedDomainsList: string[] = allowedDomains?.spec?.rules?.flatMap((r: any) => r.values?.allowedValues || []) || [];
    const hasDomainRestriction = allowedDomainsList.length > 0;

    // Check if WiF principal set is covered by allowed domains
    const wifDomainCompliant = !hasDomainRestriction || allowedDomainsList.some((v: string) => 
      v.includes('principalSet://iam.googleapis.com') || (safeOrg && v.includes(safeOrg))
    );

    const remediations: Array<{ title: string; command: string; canAutoFix: boolean }> = [];
    if (isKeyCreationDisabled) {
      remediations.push({
        title: `Override iam.disableServiceAccountKeyCreation on ${safeProj}`,
        command: `gcloud org-policies set-policy <(echo -e "name: projects/${safeProj}/policies/iam.disableServiceAccountKeyCreation\\nspec:\\n  rules:\\n  - enforce: false") --project=${safeProj}`,
        canAutoFix: true
      });
    }

    return res.status(200).json({
      projectId: safeProj,
      policies: {
        disableServiceAccountKeyCreation: {
          enforced: isKeyCreationDisabled,
          rule: isKeyCreationDisabled ? 'ENFORCE_TRUE' : 'ENFORCE_FALSE_OR_NOT_SET'
        },
        disableCrossProjectServiceAccountUsage: {
          enforced: isCrossProjectDisabled,
          rule: isCrossProjectDisabled ? 'ENFORCE_TRUE' : 'PERMITTED'
        },
        disableServiceAccountKeyUpload: {
          enforced: isKeyUploadDisabled
        },
        allowedPolicyMemberDomains: {
          restricted: hasDomainRestriction,
          allowedValues: allowedDomainsList
        },
        allowedDataSources: {
          raw: allowedDataSources
        }
      },
      dwdAssessment: {
        blocked: isKeyCreationDisabled,
        blockReason: isKeyCreationDisabled 
          ? `Policy "constraints/iam.disableServiceAccountKeyCreation" is enforced on ${safeProj}. Downloading JSON keys (sa-dwd-key.json) will fail.`
          : null,
        crossProjectWarning: isCrossProjectDisabled 
          ? `Policy "constraints/iam.disableCrossProjectServiceAccountUsage" is enforced. Service account must belong natively to ${safeProj}.`
          : null
      },
      wifAssessment: {
        exemptFromKeyPolicies: true,
        domainCompliant: wifDomainCompliant,
        message: 'Workforce Identity Federation (WiF) is 100% exempt from service account key restrictions because tokens are minted via GCP Security Token Service (STS) without disk keys.',
        domainWarning: !wifDomainCompliant
          ? `Domain-restricted sharing is enforced with ${allowedDomainsList.length} allowed IDs. Ensure your workforce pool's principalSet is included in iam.allowedPolicyMemberDomains.`
          : null
      },
      remediations
    });
  } catch (err: any) {
    logger.error(`Check Org Policies failed: ${err.message}`);
    return res.status(500).json({ error: 'CheckOrgPoliciesFailed', message: err.message });
  }
});

// Wizard: 1-Click Project-Level Org Policy Override for SA Key Creation
wizardRouter.post('/wizard/override-key-creation-policy', async (req, res) => {
  try {
    const { projectId } = req.body || {};
    if (!projectId) {
      return res.status(400).json({ error: 'MissingProjectId', message: 'projectId is required.' });
    }

    const safeProj = String(projectId).replace(/[^a-zA-Z0-9\-_]/g, '');
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const os = await import('os');
    const path = await import('path');

    const yamlContent = `name: projects/${safeProj}/policies/iam.disableServiceAccountKeyCreation
spec:
  rules:
  - enforce: false
`;
    const tmpPath = path.join(os.tmpdir(), `override-key-creation-${Date.now()}.yaml`);
    fs.writeFileSync(tmpPath, yamlContent, 'utf-8');

    try {
      const { stdout } = await execFileAsync('gcloud', [
        'org-policies',
        'set-policy',
        tmpPath,
        `--project=${safeProj}`
      ]);
      AppStateTracker.recordOrgPolicyOverride(safeProj, 'iam.disableServiceAccountKeyCreation', { enforce: false });
      return res.status(200).json({
        success: true,
        message: `Successfully applied project override on "${safeProj}": Service Account Key creation is now permitted (enforce: false).`,
        stdout
      });
    } finally {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    }
  } catch (err: any) {
    logger.error(`Override Org Policy failed: ${err.message}`);
    return res.status(500).json({ error: 'OverridePolicyFailed', message: err.message });
  }
});

// Wizard: Auto-Discover Organizations, Workforce Pools, Providers, and Identities
wizardRouter.get('/wizard/wif-discovery', async (req, res) => {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const requestedOrgId = ((req.query.orgId as string) || '').replace(/[^0-9]/g, '');
    const warnings: string[] = [];

    // Detected Local Service Account
    let detectedSaEmail = '';
    let detectedClientId = '';
    if (fs.existsSync('./sa-dwd-key.json')) {
      try {
        const saData = JSON.parse(fs.readFileSync('./sa-dwd-key.json', 'utf-8'));
        detectedSaEmail = saData.client_email || '';
        detectedClientId = saData.client_id || '';
      } catch {}
    }

    // 1. Caller identity (check active gcloud CLI account + SA key)
    let callerEmail = '';
    try {
      const { stdout } = await execFileAsync('gcloud', ['config', 'get-value', 'account']);
      callerEmail = stdout.trim();
    } catch {}

    const authService = new GcpAuthService();
    const token = await authService.getAccessToken().catch(() => null);

    // 2. Organization Discovery (try gcloud CLI first, then REST API, or use manually provided orgId)
    let organization: { id: string; displayName: string; name: string } | null = null;
    if (requestedOrgId) {
      organization = {
        id: requestedOrgId,
        displayName: `Org ${requestedOrgId}`,
        name: `organizations/${requestedOrgId}`
      };
    }

    try {
      const { stdout: orgsOut } = await execFileAsync('gcloud', ['organizations', 'list', '--format=json']);
      const orgs = JSON.parse(orgsOut || '[]');
      if (orgs.length > 0) {
        const matched = requestedOrgId ? orgs.find((o: any) => o.name?.includes(requestedOrgId)) || orgs[0] : orgs[0];
        organization = {
          id: matched.name?.replace('organizations/', '') || '',
          displayName: matched.displayName || '',
          name: matched.name || ''
        };
      }
    } catch (orgErr: any) {
      logger.debug(`gcloud organizations list failed: ${orgErr.message}`);
    }

    // Fallback to Cloud Resource Manager REST API if gcloud CLI returned no org
    if (!organization && token) {
      try {
        const orgRes = await fetch('https://cloudresourcemanager.googleapis.com/v1/organizations:search', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        if (orgRes.ok) {
          const orgData: any = await orgRes.json();
          const orgs = orgData.organizations || [];
          if (orgs.length > 0) {
            organization = {
              id: orgs[0].name?.replace('organizations/', '') || '',
              displayName: orgs[0].displayName || '',
              name: orgs[0].name || ''
            };
          }
        } else if (orgRes.status === 403) {
          warnings.push(`Caller lacks 'resourcemanager.organizations.get' ('roles/resourcemanager.organizationViewer') at the GCP Organization level to auto-discover Organization ID. Enter your Organization ID manually in Step 2 below.`);
        }
      } catch {}
    }

    if (!organization) {
      warnings.push(`Could not auto-discover Google Cloud Organization ID. Workforce Identity Pools live at the GCP Organization root level—ensure your account has 'roles/resourcemanager.organizationViewer' or enter your 12-digit Organization ID manually.`);
    }

    // 3. Workforce Pools Discovery (try gcloud CLI first, then IAM REST API)
    const pools: Array<{ id: string; name: string; displayName?: string; description?: string; state?: string }> = [];
    if (organization?.id) {
      let poolsListed = false;
      try {
        const { stdout: poolsOut } = await execFileAsync('gcloud', [
          'iam',
          'workforce-pools',
          'list',
          `--organization=${organization.id}`,
          '--location=global',
          '--format=json'
        ]);
        const parsedPools = JSON.parse(poolsOut || '[]');
        for (const p of parsedPools) {
          const poolId = p.name?.split('/').pop() || '';
          pools.push({
            id: poolId,
            name: p.name,
            displayName: p.displayName,
            description: p.description,
            state: p.state
          });
        }
        poolsListed = true;
      } catch (poolErr: any) {
        logger.debug(`gcloud workforce-pools list failed: ${poolErr.message}`);
        if (poolErr.message?.includes('PERMISSION_DENIED') || poolErr.message?.includes('403')) {
          warnings.push(`Caller (${callerEmail || detectedSaEmail || 'active identity'}) lacks 'iam.workforcePools.list' on organization '${organization.id}'. Grant 'roles/iam.workforcePoolViewer' or 'roles/iam.workforcePoolAdmin' at the GCP Organization level (organizations/${organization.id}), or enter your Workforce Pool ID manually.`);
        }
      }

      if (!poolsListed && token) {
        try {
          const poolRes = await fetch(`https://iam.googleapis.com/v1/organizations/${encodeURIComponent(organization.id)}/locations/global/workforcePools`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (poolRes.ok) {
            const poolData: any = await poolRes.json();
            for (const p of poolData.workforcePools || []) {
              const poolId = p.name?.split('/').pop() || '';
              pools.push({
                id: poolId,
                name: p.name,
                displayName: p.displayName,
                description: p.description,
                state: p.state
              });
            }
          } else if (poolRes.status === 403 && warnings.length === 0) {
            warnings.push(`Caller lacks 'iam.workforcePools.list' ('roles/iam.workforcePoolViewer') on organization '${organization.id}'. Workforce Pools are Organization-level resources.`);
          }
        } catch {}
      }
    }

    // 4. Inspect Gemini Enterprise App (Discovery Engine aclConfig + Project IAM Policy) for Workforce Pool & google.subject alignment
    const sourceProjectId = ((req.query.sourceProjectId as string) || process.env.SOURCE_PROJECT_ID || '').trim();
    const sourceLocation = ((req.query.sourceLocation as string) || process.env.SOURCE_LOCATION || 'global').trim();
    const targetProjectId = ((req.query.targetProjectId as string) || process.env.TARGET_PROJECT_ID || '').trim();
    const targetLocation = ((req.query.targetLocation as string) || process.env.TARGET_LOCATION || 'global').trim();
    const requestedPoolId = ((req.query.poolId as string) || '').trim();

    const geAppInspection = await inspectGeAppWorkforceConfig({
      sourceProjectId,
      sourceLocation,
      targetProjectId,
      targetLocation,
      poolId: requestedPoolId || pools[0]?.id,
      bearerToken: token
    });

    if (geAppInspection.detectedPoolId && !pools.some((p) => p.id === geAppInspection.detectedPoolId)) {
      pools.unshift({
        id: geAppInspection.detectedPoolId,
        name: `locations/global/workforcePools/${geAppInspection.detectedPoolId}`,
        displayName: `GE App Pool (${geAppInspection.detectedPoolId})`,
        description: `Auto-detected from Gemini Enterprise ${geAppInspection.detectedFrom === 'ACL_CONFIG' ? 'aclConfig' : 'IAM policy'}`,
        state: 'ACTIVE'
      });
    }

    // 5. Local WIF Key Status
    const hasKey = fs.existsSync('wif-migration-key.pem');
    const hasJwks = fs.existsSync('wif-migration-jwks.json');

    // 6. Current workforce-identity-config.json status
    let currentConfig: any = null;
    if (fs.existsSync('workforce-identity-config.json')) {
      try {
        currentConfig = JSON.parse(fs.readFileSync('workforce-identity-config.json', 'utf-8'));
      } catch {}
    }

    return res.status(200).json({
      success: true,
      organization,
      pools,
      warnings,
      callerEmail: callerEmail || detectedSaEmail || 'Service Account / ADC',
      detectedSaEmail,
      detectedClientId,
      localKeys: {
        hasKey,
        hasJwks,
        ready: hasKey && hasJwks,
        keyPath: path.resolve('wif-migration-key.pem'),
        jwksPath: path.resolve('wif-migration-jwks.json')
      },
      currentConfig,
      geAppInspection
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'WifDiscoveryFailed', message: err.message });
  }
});

// Wizard: 1-Click Generate WIF Migration RSA Keys & Public JWKS
wizardRouter.post('/wizard/generate-wif-keys', async (_req, res) => {
  try {
    const crypto = await import('crypto');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const jwk: any = crypto.createPublicKey(publicKey).export({ format: 'jwk' });
    jwk.kid = 'wif-migration-key-1';
    jwk.use = 'sig';
    jwk.alg = 'RS256';

    const jwks = { keys: [jwk] };

    fs.writeFileSync('wif-migration-key.pem', privateKey, { mode: 0o600 });
    fs.writeFileSync('wif-migration-jwks.json', JSON.stringify(jwks, null, 2), 'utf-8');

    logger.info('Generated WIF Migration RSA Key Pair & JWKS');

    return res.status(200).json({
      success: true,
      message: 'Successfully generated wif-migration-key.pem and wif-migration-jwks.json.',
      hasKey: true,
      hasJwks: true
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'KeyGenFailed', message: err.message });
  }
});

// Wizard: 1-Click Register (or Update) Migration Provider in GCP Workforce Pool
wizardRouter.post('/wizard/register-migration-provider', async (req, res) => {
  try {
    const {
      workforcePoolId = 'wdufrin-okta',
      providerId = 'migration-dwd-provider',
      location = 'global',
      issuerUri = 'https://gemini-migration.internal',
      attributeCondition,
      attributeMapping
    } = req.body || {};

    const safePool = workforcePoolId.replace(/[^a-zA-Z0-9\-_]/g, '');
    const safeProvider = providerId.replace(/[^a-zA-Z0-9\-_]/g, '');
    const safeLoc = location.replace(/[^a-zA-Z0-9\-_]/g, '');

    // Ensure JWKS exists
    if (!fs.existsSync('wif-migration-jwks.json') || !fs.existsSync('wif-migration-key.pem')) {
      const crypto = await import('crypto');
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      });
      const jwk: any = crypto.createPublicKey(publicKey).export({ format: 'jwk' });
      jwk.kid = 'wif-migration-key-1';
      jwk.use = 'sig';
      jwk.alg = 'RS256';
      fs.writeFileSync('wif-migration-key.pem', privateKey, { mode: 0o600 });
      fs.writeFileSync('wif-migration-jwks.json', JSON.stringify({ keys: [jwk] }, null, 2), 'utf-8');
    }

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // Inspect existing providers in the pool so `--attribute-mapping` matches the GE App's production provider
    const authService = new GcpAuthService();
    const token = await authService.getAccessToken().catch(() => null);
    const { providers: poolProviders } = await listPoolProviders(safePool, safeLoc, token);
    const alignmentPlan = deriveAlignedMigrationAttributeMapping(poolProviders, safeProvider);
    const effectiveAttributeMapping =
      typeof attributeMapping === 'string' && attributeMapping.trim()
        ? attributeMapping.trim()
        : alignmentPlan.attributeMappingString;

    // Enterprise Security: Apply Attribute Condition to restrict token minting blast radius
    const condition = typeof attributeCondition === 'string' && attributeCondition.trim()
      ? attributeCondition.trim()
      : 'assertion.email != "" && !assertion.sub.startsWith("service-")';

    // Check if provider already exists
    let existing: any = null;
    try {
      const { stdout: provDescribe } = await execFileAsync('gcloud', [
        'iam',
        'workforce-pools',
        'providers',
        'describe',
        safeProvider,
        `--workforce-pool=${safePool}`,
        `--location=${safeLoc}`,
        '--format=json'
      ]);
      existing = JSON.parse(provDescribe || '{}');
    } catch (describeErr: any) {
      logger.debug(`Provider describe for "${safeProvider}" did not return an existing provider: ${describeErr.message}`);
    }

    if (existing && existing.name) {
      // Update the existing provider so its google.subject attribute mapping and JWKS key match the GE App's production provider!
      const updateArgs = [
        'iam',
        'workforce-pools',
        'providers',
        'update-oidc',
        safeProvider,
        `--workforce-pool=${safePool}`,
        `--location=${safeLoc}`,
        '--display-name=Migration DWD Impersonator',
        `--issuer-uri=${issuerUri}`,
        '--client-id=gemini-migration-tool',
        '--web-sso-response-type=id-token',
        '--web-sso-assertion-claims-behavior=only-id-token-claims',
        '--jwk-json-path=./wif-migration-jwks.json',
        `--attribute-mapping=${effectiveAttributeMapping}`
      ];
      if (condition && condition.toLowerCase() !== 'none') {
        updateArgs.push(`--attribute-condition=${condition}`);
      }

      const { stdout: updateStdout } = await execFileAsync('gcloud', updateArgs);

      AppStateTracker.recordWifProvider(safePool, safeProvider, safeLoc, {
        issuerUri,
        attributeCondition: condition && condition.toLowerCase() !== 'none' ? condition : undefined
      });

      return res.status(200).json({
        success: true,
        updatedExisting: true,
        alreadyExists: true,
        message:
          `Updated provider "${safeProvider}" in pool "${safePool}" with aligned mapping ` +
          `"${effectiveAttributeMapping}"${alignmentPlan.referenceProvider ? ` (matched to "${alignmentPlan.referenceProvider.providerId}")` : ''}.`,
        stdout: updateStdout,
        attributeMapping: effectiveAttributeMapping,
        alignmentPlan
      });
    }

    const gcloudArgs = [
      'iam',
      'workforce-pools',
      'providers',
      'create-oidc',
      safeProvider,
      `--workforce-pool=${safePool}`,
      `--location=${safeLoc}`,
      '--display-name=Migration DWD Impersonator',
      `--issuer-uri=${issuerUri}`,
      '--client-id=gemini-migration-tool',
      '--web-sso-response-type=id-token',
      '--web-sso-assertion-claims-behavior=only-id-token-claims',
      '--jwk-json-path=./wif-migration-jwks.json',
      `--attribute-mapping=${effectiveAttributeMapping}`
    ];

    if (condition && condition.toLowerCase() !== 'none') {
      gcloudArgs.push(`--attribute-condition=${condition}`);
    }

    const { stdout } = await execFileAsync('gcloud', gcloudArgs);

    // Record before responding: an untracked provider is one teardown cannot remove.
    AppStateTracker.recordWifProvider(safePool, safeProvider, safeLoc, {
      issuerUri,
      attributeCondition: condition && condition.toLowerCase() !== 'none' ? condition : undefined
    });

    return res.status(200).json({
      success: true,
      message:
        `Successfully created workforce pool provider "${safeProvider}" in pool "${safePool}" ` +
        `with aligned mapping "${effectiveAttributeMapping}".`,
      stdout,
      attributeMapping: effectiveAttributeMapping,
      alignmentPlan,
      attributeCondition: condition && condition.toLowerCase() !== 'none' ? condition : undefined
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'RegisterProviderFailed', message: err.message });
  }
});

// Wizard: Verify Workforce Identity Pool & Providers in GCP
wizardRouter.post('/wizard/verify-wif-pool', async (req, res) => {
  try {
    const {
      workforcePoolId = 'enterprise-workforce-pool',
      location = 'global',
      providerId = 'migration-dwd-provider'
    } = req.body || {};

    const safePool = workforcePoolId.replace(/[^a-zA-Z0-9\-_]/g, '');
    const safeLoc = location.replace(/[^a-zA-Z0-9\-_]/g, '');
    const safeProvider = providerId.replace(/[^a-zA-Z0-9\-_]/g, '');

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // 1. Describe Pool
    const { stdout: poolOut } = await execFileAsync('gcloud', [
      'iam',
      'workforce-pools',
      'describe',
      safePool,
      `--location=${safeLoc}`,
      '--format=json'
    ]);
    const poolData = JSON.parse(poolOut || '{}');

    // 2. List Providers
    const { stdout: provOut } = await execFileAsync('gcloud', [
      'iam',
      'workforce-pools',
      'providers',
      'list',
      `--workforce-pool=${safePool}`,
      `--location=${safeLoc}`,
      '--format=json'
    ]);
    const providers = JSON.parse(provOut || '[]');
    const parsedProviders = parseProviders(provOut || '[]');
    const alignmentPlan = deriveAlignedMigrationAttributeMapping(parsedProviders, safeProvider);

    const activeProvider = providers.find((p: any) => p.name?.endsWith(`/providers/${safeProvider}`)) || null;
    const isVerified = Boolean(activeProvider);

    return res.status(200).json({
      verified: isVerified,
      pool: poolData,
      provider: activeProvider,
      providers,
      alignmentPlan,
      audience: `//iam.googleapis.com/locations/${safeLoc}/workforcePools/${safePool}/providers/${safeProvider}`,
      message: isVerified
        ? `Workforce Pool "${safePool}" and provider "${safeProvider}" verified in GCP.`
        : `Workforce Pool "${safePool}" found, but provider "${safeProvider}" does not exist in this pool yet. Please run the Step 1 command to register it.`
    });
  } catch (err: any) {
    logger.warn(`Verify WiF Pool failed: ${err.message}`);
    return res.status(200).json({
      verified: false,
      message: err.message
    });
  }
});

// Wizard: Generate Workforce Identity Federation (WiF) Config
wizardRouter.post('/wizard/generate-wif-config', async (req, res) => {
  try {
    const {
      workforcePoolId = 'enterprise-workforce-pool',
      providerId = 'entra-id-provider',
      projectNumber,
      saveToFile = true
    } = req.body || {};

    const audience = `//iam.googleapis.com/locations/global/workforcePools/${workforcePoolId}/providers/${providerId}`;

    const wifConfig = {
      type: 'external_account',
      audience,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      credential_source: {
        file: './idp-subject-token.jwt',
        format: {
          type: 'text'
        }
      },
      workforce_pool_user_project: projectNumber || undefined
    };

    let filePath = './workforce-identity-config.json';
    if (saveToFile) {
      fs.writeFileSync(filePath, JSON.stringify(wifConfig, null, 2), 'utf-8');
      logger.info(`Wizard generated and saved WiF config to ${filePath}`);
    }

    return res.status(200).json({
      success: true,
      config: wifConfig,
      savedPath: saveToFile ? filePath : undefined,
      audience,
      instructions: `Workforce Identity Federation config generated. Save this file as workforce-identity-config.json to authenticate via external IdP.`
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'GenerateWifFailed', message: err.message });
  }
});

// Wizard: Test Workforce Identity Federation (WiF) Token Exchange & Impersonation
wizardRouter.post('/wizard/test-wif', async (req, res) => {
  try {
    const {
      wifConfig,
      wifConfigPath = './workforce-identity-config.json',
      serviceAccountToImpersonate,
      testUserEmail,
      targetProjectId
    } = req.body || {};

    let resolvedConfig = wifConfig;
    if (!resolvedConfig && fs.existsSync(wifConfigPath)) {
      try {
        resolvedConfig = JSON.parse(fs.readFileSync(wifConfigPath, 'utf-8'));
      } catch (err: any) {
        return res.status(200).json({
          success: false,
          error: 'InvalidConfigFile',
          message: `Failed to read ${wifConfigPath}: ${err.message}`
        });
      }
    }

    if (!resolvedConfig) {
      return res.status(200).json({
        success: false,
        error: 'ConfigNotFound',
        message: 'No Workforce Identity Federation config found. Please generate or save workforce-identity-config.json first.'
      });
    }

    const audience = resolvedConfig.audience || '';
    const tokenUrl = resolvedConfig.token_url || 'https://sts.googleapis.com/v1/token';
    const isWorkforce = audience.includes('/workforcePools/');
    const targetUser = (testUserEmail || '').trim() || process.env.DEFAULT_USER_EMAIL || process.env.ADMIN_EMAIL || 'user@example.com';
    const saEmail = (serviceAccountToImpersonate || '').trim();

    // 1. Acquire STS federated token
    let stsToken: string | undefined;
    const keyPath = 'wif-migration-key.pem';

    if (fs.existsSync(keyPath)) {
      const authService = new GcpAuthService({
        wifConfigPath,
        wifConfigJson: resolvedConfig,
        authType: 'WORKFORCE_IDENTITY_FEDERATION'
      });

      try {
        // iamcredentials.generateAccessToken (used below to verify impersonation) rejects
        // tokens scoped only to Discovery Engine, so request cloud-platform explicitly.
        stsToken = await authService.mintWorkforceToken(targetUser, undefined, [CLOUD_PLATFORM_SCOPE]);
      } catch (mintErr: any) {
        return res.status(200).json({
          success: false,
          error: 'WorkforceTokenMintFailed',
          message: `Workforce STS token exchange failed: ${mintErr.message}`,
          audience,
          tokenUrl
        });
      }
    }

    if (!stsToken) {
      try {
        const { GoogleAuth } = await import('google-auth-library');
        const auth = new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });
        const client = auth.fromJSON(resolvedConfig);
        const tokenRes = await client.getAccessToken();
        if (tokenRes && tokenRes.token) {
          stsToken = tokenRes.token;
        }
      } catch (stsErr: any) {
        const subTokenFile = resolvedConfig.credential_source?.file;
        const fileExists = subTokenFile ? fs.existsSync(subTokenFile) : false;
        const fileContent = fileExists ? fs.readFileSync(subTokenFile, 'utf-8').trim() : '';
        const isDummyToken = !fileContent || fileContent.includes('mock-idp-subject-token') || fileContent.length < 50;

        const remediation = [];
        if (!fs.existsSync(keyPath)) {
          remediation.push('For Pattern 1 (Migration DWD Key): Run Step 1 commands to generate "wif-migration-key.pem" and register the JWKS provider.');
        }
        if (isDummyToken) {
          remediation.push(`For Pattern 2 (External IdP OIDC/SAML): Place a genuine signed OIDC ID token or SAML assertion from your IdP into "${subTokenFile || './idp-subject-token.jwt'}".`);
        }
        remediation.push(`Ensure the Workforce Pool and Provider exist: ${audience}`);

        return res.status(200).json({
          success: false,
          error: 'WifExchangeFailed',
          message: `WiF Token Exchange failed against STS: ${stsErr.message}. Ambient local gcloud workstation credentials were NOT used for this test.`,
          audience,
          tokenUrl,
          isWorkforcePool: isWorkforce,
          remediation
        });
      }
    }

    if (!stsToken) {
      return res.status(200).json({
        success: false,
        error: 'NoStsTokenReturned',
        message: 'No access token returned from GCP Security Token Service (STS). Verify that wif-migration-key.pem exists or idp-subject-token.jwt contains a valid token.',
        audience,
        tokenUrl
      });
    }

    // 2. LIVE VERIFICATION OF IMPERSONATION & AUTHORIZATION (NO STUBS, NO FAKE SUCCESS)
    //
    // The principal must be POOL-scoped. Appending "/subject/<user>" to the raw audience
    // leaves the "/providers/<provider>" segment in place, which is not a valid IAM
    // principal -- every remediation command built from it was rejected by gcloud.
    let principalString: string;
    try {
      principalString = buildWorkforcePrincipal(audience, targetUser);
    } catch (principalErr: any) {
      logger.warn(`Could not build a Workforce principal for the remediation hints: ${principalErr.message}`);
      return res.status(200).json({
        success: false,
        error: 'InvalidWorkforceAudience',
        message: principalErr.message,
        audience,
        tokenUrl
      });
    }    // 2. LIVE VERIFICATION OF WORKFORCE USER ACCESS & SUBJECT PARITY (NO SHORT-CIRCUITING ON SA)
    //
    // Critical: User-scoped Discovery Engine assets (NotebookLM notebooks, memories, chat sessions)
    // are migrated using the direct Workforce STS token (principal://.../subject/<user>), NOT a
    // Service Account token. Previously, filling in `serviceAccountToImpersonate` caused this endpoint
    // to test IAM Credentials SA token minting and return `success: true` immediately without ever
    // testing whether the workforce user token matches the production provider's `google.subject`
    // or has `discoveryengine.notebooks.list` permission in the Gemini Enterprise project.
    const testProject = targetProjectId || resolvedConfig.workforce_pool_user_project || process.env.GCP_PROJECT_ID || 'testgebackupandrestorev3';
    const subjectCheck = await checkSubjectMapping(audience);

    // Optional Check A: Service Account Impersonation (if requested)
    let saImpersonationStatus: {
      attempted: boolean;
      success: boolean;
      serviceAccount?: string;
      tokenPrefix?: string;
      error?: string;
    } = { attempted: false, success: false };

    if (saEmail) {
      saImpersonationStatus.attempted = true;
      saImpersonationStatus.serviceAccount = saEmail;
      const saProject = saEmail.split('@')[1]?.split('.')[0] || testProject;
      try {
        const iamRes = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail)}:generateAccessToken`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${stsToken}`,
            'Content-Type': 'application/json',
            'x-goog-user-project': saProject
          },
          body: JSON.stringify({
            scope: ['https://www.googleapis.com/auth/cloud-platform']
          })
        });

        if (iamRes.ok) {
          const iamData: any = await iamRes.json();
          const saToken = iamData.accessToken || '';
          saImpersonationStatus.success = true;
          saImpersonationStatus.tokenPrefix = `${saToken.substring(0, 18)}...`;
        } else {
          const errText = await iamRes.text();
          let errMsg = errText;
          try {
            const errJson = JSON.parse(errText);
            errMsg = errJson.error?.message || errText;
          } catch (parseErr: any) {
            logger.debug(`SA impersonation error body was not JSON: ${parseErr.message}`);
          }
          saImpersonationStatus.error = `HTTP ${iamRes.status}: ${errMsg}`;
        }
      } catch (iamErr: any) {
        saImpersonationStatus.error = iamErr.message;
      }
    }

    // Mandatory Check B: Direct Workforce User Probe against `notebooks:listRecentlyViewed`
    // (`discoveryengine.notebooks.list` — the exact permission granted by `roles/discoveryengine.user`
    // and required to migrate user notebooks/sessions).
    try {
      const notebooksProbeUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${testProject}/locations/global/notebooks:listRecentlyViewed?pageSize=1`;
      const gcpRes = await fetch(notebooksProbeUrl, {
        headers: {
          'Authorization': `Bearer ${stsToken}`,
          'x-goog-user-project': testProject
        }
      });

      if (!gcpRes.ok) {
        const errText = await gcpRes.text();
        let errMsg = errText;
        try {
          const errJson = JSON.parse(errText);
          errMsg = errJson.error?.message || errText;
        } catch (parseErr: any) {
          // Body was not JSON. Keep the raw text -- it is the only diagnostic we have.
          logger.debug(`Authorization failure body was not JSON (${parseErr.message}); using raw text.`);
        }

        const remediation: string[] = [];
        if (subjectCheck.verdict === 'MISMATCH') {
          remediation.push(
            'SUBJECT MAPPING MISMATCH -- adding IAM bindings for the principal below will NOT fix this:'
          );
          remediation.push(subjectCheck.summary);
        } else {
          if (subjectCheck.verdict === 'UNKNOWN') {
            remediation.push(`Note: subject mapping was not verified. ${subjectCheck.summary}`);
          }
          remediation.push(`1. Ensure "${audience.split('/providers/')[1] || 'migration-dwd-provider'}" maps google.subject (and google.groups if using IdP group IAM bindings) identically to your GE App's production provider.`);
          remediation.push(`2. Grant Discovery Engine User (discoveryengine.notebooks.list) & Service Usage Consumer on project "${testProject}":`);
          remediation.push(
            `gcloud projects add-iam-policy-binding ${testProject} --role="roles/discoveryengine.user" --member="${principalString}"`
          );
          remediation.push(
            `gcloud projects add-iam-policy-binding ${testProject} --role="roles/serviceusage.serviceUsageConsumer" --member="${principalString}"`
          );
        }

        if (saImpersonationStatus.attempted && saImpersonationStatus.success) {
          remediation.push(
            `NOTE: Service Account impersonation (${saEmail}) succeeded, but Service Accounts CANNOT read or write user-scoped NotebookLM notebooks. The direct workforce user token (${principalString}) failed notebooks:listRecentlyViewed with HTTP ${gcpRes.status}.`
          );
        }

        return res.status(200).json({
          success: false,
          error: subjectCheck.verdict === 'MISMATCH' ? 'WorkforceSubjectMappingMismatch' : 'WorkforcePrincipalNotAuthorized',
          message: `STS token was minted for workforce user "${targetUser}"${saImpersonationStatus.success ? ` (and SA "${saEmail}" impersonation succeeded)` : ''}, BEFORE migration can work: direct user call to Discovery Engine (discoveryengine.notebooks.list) in project "${testProject}" FAILED (${gcpRes.status}): ${errMsg}`,
          audience,
          tokenUrl,
          isWorkforcePool: isWorkforce,
          impersonatedPrincipal: principalString,
          impersonatedServiceAccount: saImpersonationStatus.success ? `${saEmail} (SA OK, but Direct User Token 403)` : 'Direct Workforce Principal',
          saImpersonation: saImpersonationStatus,
          subjectMapping: subjectCheck,
          remediation
        });
      }

      let notebookCount = 0;
      try {
        const nbData: any = await gcpRes.json();
        if (Array.isArray(nbData?.notebooks)) {
          notebookCount = nbData.notebooks.length;
        }
      } catch (parseErr: any) {
        logger.debug(`Could not parse notebooks response JSON: ${parseErr.message}`);
      }

      // If notebooks.list succeeded with 200 OK, also check if subjectCheck found a mismatch warning
      if (subjectCheck.verdict === 'MISMATCH') {
        return res.status(200).json({
          success: false,
          error: 'WorkforceSubjectMappingMismatch',
          message: `Discovery Engine notebooks.list returned 200 OK (likely via a broad pool-wide /* IAM binding), BUT subject mapping mismatch was detected: ${subjectCheck.summary}. User-owned notebooks will land under the wrong subject ID unless aligned!`,
          audience,
          tokenUrl,
          isWorkforcePool: isWorkforce,
          impersonatedPrincipal: principalString,
          impersonatedServiceAccount: saImpersonationStatus.success ? saEmail : 'Direct Workforce Principal',
          saImpersonation: saImpersonationStatus,
          subjectMapping: subjectCheck,
          notebookCount,
          remediation: [subjectCheck.summary]
        });
      }

      const zeroNotebooksWarning = notebookCount === 0
        ? ` Note: 0 notebooks were returned for "${targetUser}". Because GCP Workforce Identity Pools are stateless (STS verifies your local wif-migration-key.pem signature without calling Okta/Entra) and pool-wide IAM bindings (workforcePools/.../*) authorize every subject string in the pool, even a non-existent email will return 200 OK with 0 notebooks. Test with a user known to own >=1 notebook to prove real data visibility.`
        : ` Confirmed real data visibility: ${notebookCount} notebook(s) visible for "${targetUser}".`;

      return res.status(200).json({
        success: true,
        message: `Verified End-to-End: Workforce user "${targetUser}" (${principalString}) exchanged STS token, verified subject mapping (${subjectCheck.verdict}), and passed live Discovery Engine notebooks:listRecentlyViewed (discoveryengine.notebooks.list) in project "${testProject}".${zeroNotebooksWarning}`,
        audience,
        tokenUrl,
        isWorkforcePool: isWorkforce,
        impersonatedPrincipal: principalString,
        impersonatedServiceAccount: saImpersonationStatus.success ? `${saEmail} + Direct User Principal` : 'Direct Workforce Principal (User-Scoped)',
        impersonatedUser: targetUser,
        saImpersonation: saImpersonationStatus,
        subjectMapping: subjectCheck,
        probedPermission: 'discoveryengine.notebooks.list',
        probedProject: testProject,
        notebookCount,
        tokenPrefix: `${stsToken.substring(0, 18)}...`
      });
    } catch (gcpErr: any) {
      // The STS mint succeeded but authorization was never verified. Reporting success
      // here told operators the setup worked when nothing had been proven.
      logger.warn(`WiF live verification could not be completed for "${targetUser}": ${gcpErr.message}`);
      return res.status(200).json({
        success: false,
        error: 'WorkforceVerificationIncomplete',
        message: `STS token minted for workforce user "${targetUser}" (${stsToken.substring(0, 18)}...), but the live Discovery Engine notebooks.list check could NOT be completed, so access is unverified: ${gcpErr.message}`,
        audience,
        tokenUrl,
        isWorkforcePool: isWorkforce,
        impersonatedPrincipal: principalString,
        impersonatedServiceAccount: 'Direct Workforce Principal',
        impersonatedUser: targetUser,
        saImpersonation: saImpersonationStatus,
        subjectMapping: subjectCheck,
        tokenPrefix: `${stsToken.substring(0, 18)}...`
      });
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'TestWifError', message: err.message });
  }
});
