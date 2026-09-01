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

export const wizardRouter = express.Router();

// IdP Presets Endpoint
wizardRouter.get('/idp/presets', (_req, res) => {
  try {
    return res.status(200).json({
      presets: IdentityMappingService.getIdpPresets()
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'FailedToGetPresets', message: err.message });
  }
});

// IdP Auto-Mapping Preview & Transformation Endpoint
wizardRouter.post('/idp/auto-map', async (req, res) => {
  try {
    const { sourceUsers, domainRules, explicitMappings, fallbackUserEmail } = req.body || {};

    let usersToMap: string[] = Array.isArray(sourceUsers) ? sourceUsers : [];

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
