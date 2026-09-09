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
import { GcpAuthService } from '../services/gcpAuth.js';
import { IdentityMappingService } from '../services/identityMappingService.js';
import { logger } from '../utils/logger.js';

import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { getSafeDiscoveryEngineUrl } from '../security/validator.js';
import { extractUserIdentity } from './discovery.js';

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

// Wizard: Test Domain-Wide Delegation (DWD)
wizardRouter.post('/wizard/test-dwd', async (req, res) => {
  try {
    const { testUserEmail, keyPath, keyJson } = req.body || {};
    if (!testUserEmail) {
      return res.status(400).json({ error: 'MissingEmail', message: 'testUserEmail is required to verify DWD impersonation.' });
    }

    const authService = new GcpAuthService({
      serviceAccountKeyPath: keyPath || './sa-dwd-key.json',
      serviceAccountKeyJson: keyJson
    });

    if (!authService.hasDwdConfigured()) {
      return res.status(400).json({
        success: false,
        error: 'KeyNotFound',
        message: 'No Service Account Key found. Please upload or specify a valid sa-dwd-key.json path.'
      });
    }

    try {
      const token = await authService.mintDwdToken(testUserEmail, [
        'https://www.googleapis.com/auth/discoveryengine.readwrite',
        'https://www.googleapis.com/auth/discoveryengine.assist.readwrite'
      ]);

      return res.status(200).json({
        success: true,
        message: `DWD impersonation successful for "${testUserEmail}". Minted valid user-scoped OAuth2 token.`,
        tokenPrefix: token ? `${token.substring(0, 15)}...` : 'None',
        scopesVerified: [
          'https://www.googleapis.com/auth/discoveryengine.readwrite',
          'https://www.googleapis.com/auth/discoveryengine.assist.readwrite'
        ]
      });
    } catch (dwdErr: any) {
      return res.status(400).json({
        success: false,
        error: 'DwdImpersonationFailed',
        message: `DWD impersonation failed: ${dwdErr.message}. Ensure the Client ID is authorized in Google Workspace Admin Console (admin.google.com).`
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

    const activeProvider = providers.find((p: any) => p.name?.endsWith(`/providers/${safeProvider}`)) || providers[0] || null;

    return res.status(200).json({
      verified: true,
      pool: poolData,
      provider: activeProvider,
      providers,
      audience: `//iam.googleapis.com/locations/${safeLoc}/workforcePools/${safePool}/providers/${safeProvider}`
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
      testUserEmail
    } = req.body || {};

    let resolvedConfig = wifConfig;
    if (!resolvedConfig && fs.existsSync(wifConfigPath)) {
      try {
        resolvedConfig = JSON.parse(fs.readFileSync(wifConfigPath, 'utf-8'));
      } catch (err: any) {
        return res.status(400).json({
          success: false,
          error: 'InvalidConfigFile',
          message: `Failed to read ${wifConfigPath}: ${err.message}`
        });
      }
    }

    if (!resolvedConfig) {
      return res.status(400).json({
        success: false,
        error: 'ConfigNotFound',
        message: 'No Workforce Identity Federation config found. Please generate or save workforce-identity-config.json first.'
      });
    }

    const audience = resolvedConfig.audience || '';
    const tokenUrl = resolvedConfig.token_url || 'https://sts.googleapis.com/v1/token';
    const isWorkforce = audience.includes('/workforcePools/');

    const authService = new GcpAuthService({
      wifConfigPath,
      wifConfigJson: resolvedConfig,
      authType: 'WORKFORCE_IDENTITY_FEDERATION'
    });

    const targetUser = testUserEmail || process.env.DEFAULT_USER_EMAIL || process.env.ADMIN_EMAIL || 'user@example.com';

    try {
      const token = await authService.mintWorkforceToken(targetUser);
      if (token) {
        return res.status(200).json({
          success: true,
          message: `Successfully minted and exchanged token with GCP Security Token Service (STS) for workforce user "${targetUser}".`,
          audience,
          tokenUrl,
          isWorkforcePool: isWorkforce,
          tokenPrefix: `${token.substring(0, 18)}...`,
          impersonatedPrincipal: `principal://${audience.replace(/^\/\//, '')}/subject/${targetUser}`,
          impersonatedServiceAccount: serviceAccountToImpersonate || 'Direct Workforce Principal',
          impersonatedUser: targetUser
        });
      }

      // If key is missing, attempt standard fromJSON WiF client
      const standardToken = await authService.getAccessToken();
      return res.status(200).json({
        success: true,
        message: 'Successfully exchanged token with GCP Security Token Service (STS) via Workforce Identity Federation config.',
        audience,
        tokenUrl,
        isWorkforcePool: isWorkforce,
        tokenPrefix: standardToken ? `${standardToken.substring(0, 15)}...` : 'Active',
        impersonatedServiceAccount: serviceAccountToImpersonate || 'Direct Workforce Principal',
        impersonatedUser: targetUser
      });
    } catch (wifErr: any) {
      return res.status(400).json({
        success: false,
        error: 'WifExchangeFailed',
        message: `WiF Token Exchange failed: ${wifErr.message}`,
        audience,
        tokenUrl
      });
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'TestWifError', message: err.message });
  }
});
