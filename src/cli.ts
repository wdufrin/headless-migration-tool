#!/usr/bin/env node
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

import fs from 'fs';
import { Command } from 'commander';
import { loadConfigFile, loadConfigFromEnv } from './config/loader.js';
import { MigrationConfigSchema } from './config/configSchema.js';
import { MigrationRunner } from './engines/migrationRunner.js';
import { GcpAuthService } from './services/gcpAuth.js';
import { DiscoveryEngineClient } from './services/discoveryEngine.js';
import { AgentRegistryClient } from './services/agentRegistry.js';
import { ConfigAuditEngine } from './engines/configAuditEngine.js';
import { logger } from './utils/logger.js';

const program = new Command();

program
  .name('gemini-migrate')
  .description('Enterprise admin-driven headless migration tool for Gemini Enterprise notebooks and custom agents.')
  .version('1.4.1')
  .option('-c, --config <path>', 'Path to JSON configuration file')
  .option('--dry-run', 'Simulate migration without applying changes to target')
  .option('--no-notebooks', 'Skip notebook migration')
  .option('--no-agents', 'Skip custom agent migration')
  .option('--no-sessions', 'Skip chat conversation history migration')
  .option('--no-memories', 'Skip user personalized memories and facts migration')
  .option('--no-skills', 'Skip Agent Registry skills migration')
  .option('--export-memories', 'Export backup snapshot of user memories to disk')
  .option('--export-artifacts', 'Export chat attachments and notebook studio artifacts to disk')
  .option('--agent-types <types...>', 'Filter agent migration by type: LOW_CODE, WORKFLOW, ADK, A2A, OTHER, ALL (default: ALL)')
  .option('--publish-agents', 'Publish migrated agents to the organization gallery/catalog')
  .option('--no-preserve-sharing', 'Do not replicate sharing configurations (ALL_USERS/RESTRICTED)')
  .option('--users <users...>', 'Filter migration to specific user email(s) or patterns (e.g. *@company.com)')
  .option('--concurrency <number>', 'Maximum parallel worker concurrency (default: 10)')
  .option('--token <token>', 'Explicit Google OAuth Access Token (overrides ADC)')
  .option('--service-account-key <path>', 'Path to Google Cloud Service Account JSON key for Domain-Wide Delegation (DWD)')
  .option('--output-dir <dir>', 'Directory to output migration reports', './reports')
  .option('--resume <reportPath>', 'Resume migration by skipping already-successful assets from a previous migration report JSON')
  .option('--generate-user-reports', 'Generate post-migration handover bundles and checklists per user')
  .option('--notify-users [overrideEmail]', 'Dispatch bulk handover emails to migrated users (or provide override email for safe staging validation)')
  .option('--no-zip-attachments', 'Disable packaging user NotebookLM artifacts into .zip archive before emailing')
  .option('--no-optimize-media', 'Disable automatic media optimization for slide decks and images')
  .action(async (options) => {
    try {
      let baseConfig: any = {};

      if (options.config) {
        logger.info(`Loading configuration from: ${options.config}`);
        baseConfig = loadConfigFile(options.config);
      } else {
        const envConfig = loadConfigFromEnv();
        if (!envConfig.source || !envConfig.target) {
          logger.error('Error: Either --config <path> or environment variables (SOURCE_PROJECT_ID, TARGET_PROJECT_ID, etc.) must be provided.');
          process.exit(1);
        }
        baseConfig = envConfig;
      }

      // Merge CLI flag overrides
      if (options.resume) {
        baseConfig.options = { ...baseConfig.options, resumeFrom: options.resume };
      }
      if (options.dryRun !== undefined) {
        baseConfig.options = { ...baseConfig.options, dryRun: options.dryRun };
      }
      if (options.notebooks === false) {
        baseConfig.options = { ...baseConfig.options, migrateNotebooks: false };
      }
      if (options.agents === false) {
        baseConfig.options = { ...baseConfig.options, migrateAgents: false };
      }
      if (options.sessions === false) {
        baseConfig.options = { ...baseConfig.options, migrateSessions: false };
      }
      if (options.memories === false) {
        baseConfig.options = { ...baseConfig.options, migrateMemories: false };
      }
      if (options.skills === false) {
        baseConfig.options = { ...baseConfig.options, migrateSkills: false };
      }
      if (options.exportMemories !== undefined) {
        baseConfig.options = { ...baseConfig.options, exportMemories: true };
      }
      if (options.exportArtifacts !== undefined) {
        baseConfig.options = { ...baseConfig.options, exportArtifacts: true };
      }
      if (options.agentTypes && options.agentTypes.length > 0) {
        baseConfig.options = { ...baseConfig.options, agentTypes: options.agentTypes };
      }
      if (options.publishAgents !== undefined) {
        baseConfig.options = { ...baseConfig.options, publishAgents: true };
      }
      if (options.preserveSharing === false) {
        baseConfig.options = { ...baseConfig.options, preserveSharing: false };
      }
      if (options.users && options.users.length > 0) {
        baseConfig.options = { ...baseConfig.options, userFilter: options.users };
      }
      if (options.concurrency) {
        baseConfig.options = { ...baseConfig.options, concurrency: parseInt(options.concurrency, 10) };
      }

      const validatedConfig = MigrationConfigSchema.parse(baseConfig);

      const authService = new GcpAuthService({
        staticToken: options.token,
        serviceAccountKeyPath: options.serviceAccountKey || process.env.SERVICE_ACCOUNT_KEY_PATH
      });

      const runner = new MigrationRunner({
        authService,
        outputDir: options.outputDir
      });

      const report = await runner.run(validatedConfig);

      console.log('\n========================================');
      console.log('       MIGRATION RUN COMPLETED          ');
      console.log('========================================');
      console.log(`Status:               ${report.summary.totalFailed === 0 ? 'SUCCESS' : 'COMPLETED WITH ERRORS'}`);
      console.log(`Duration:             ${(report.durationMs / 1000).toFixed(2)}s`);
      console.log(`Migrated Agents:      ${report.summary.totalMigratedAgents}`);
      console.log(`Migrated Notebooks:   ${report.summary.totalMigratedNotebooks}`);
      console.log(`Migrated Skills:      ${report.summary.totalMigratedSkills ?? 0}`);
      console.log(`Migrated Sessions:    ${report.summary.totalMigratedSessions ?? 0}`);
      console.log(`Migrated Memories:    ${report.summary.totalMigratedMemories ?? 0}`);
      console.log(`Failed Items:         ${report.summary.totalFailed}`);
      console.log('========================================\n');

      if (report.summary.totalFailed > 0 && !validatedConfig.options?.dryRun) {
        process.exit(1);
      }

      if (options.generateUserReports || options.notifyUsers !== undefined) {
        try {
          const { UserReportGenerator } = await import('./engines/userReportGenerator.js');
          const generator = new UserReportGenerator();
          const bundles = await generator.generateAllUserBundles(report);
          console.log(`Generated ${Object.keys(bundles).length} User Handover Bundles in ./user_handover_reports/`);

          if (options.notifyUsers !== undefined) {
            const overrideEmail = typeof options.notifyUsers === 'string' && options.notifyUsers.includes('@')
              ? options.notifyUsers.trim()
              : undefined;
            const bulkRes = await generator.sendBulkUserEmails({
              overrideRecipientEmail: overrideEmail,
              senderEmail: options.senderEmail || process.env.SENDER_EMAIL,
              accessToken: options.token,
              zipAttachments: options.zipAttachments !== false,
              optimizeMedia: options.optimizeMedia !== false,
              authService
            }, report);
            console.log(`Bulk Email Handover: ${bulkRes.sent} sent, ${bulkRes.failed} failed of ${bulkRes.total} total.`);
          }
        } catch (repErr: any) {
          logger.warn(`User handover processing error: ${repErr.message}`);
        }
      }
    } catch (err: any) {
      logger.error(`Fatal Migration Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('decommission')
  .alias('cleanup-install')
  .description('Clean up install & decommission migration app: reset org policies, delete service account & IAM bindings, invalidate DWD, and wipe local credentials')
  .requiredOption('-p, --project <projectId>', 'Target Google Cloud project ID')
  .option('--confirm <projectId>', 'Confirmation target project ID (must match --project or be "DECOMMISSION")')
  .option('--wipe-target-assets', 'Also wipe migrated target Discovery Engine assets (notebooks, agents, chats, memories)')
  .action(async (cmdOptions) => {
    try {
      const targetProject = (cmdOptions.project || '').trim();
      const confirmProject = (cmdOptions.confirm || '').trim();

      if (!confirmProject || (confirmProject !== targetProject && confirmProject !== 'DECOMMISSION')) {
        console.error(`\n❌ Error: For safety, you must pass --confirm ${targetProject} to verify decommissioning.`);
        process.exit(1);
      }

      console.log(`\n======================================================`);
      console.log(`  CLEAN UP INSTALL & DECOMMISSION MIGRATION APP       `);
      console.log(`======================================================`);
      console.log(`Target Project:       ${targetProject}`);
      console.log(`Wipe Target Assets:   ${cmdOptions.wipeTargetAssets ? 'YES' : 'NO'}`);
      console.log(`======================================================\n`);

      const { executeTargetAssetCleanup } = await import('./routes/maintenance.js');
      const { AppStateTracker } = await import('./services/appStateTracker.js');
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const fs = await import('fs');
      const path = await import('path');

      // 0. Target assets
      if (cmdOptions.wipeTargetAssets) {
        console.log('• Wiping target Discovery Engine assets (notebooks, agents, chats, memories)...');
        try {
          const res = await executeTargetAssetCleanup({
            targetProject,
            cleanNotebooks: true,
            cleanAgents: true,
            cleanSessions: true,
            cleanMemories: true,
            cleanArtifacts: true,
            cleanReports: true
          });
          console.log(`  ✓ Assets wiped: ${res.deletedNotebooks} notebooks, ${res.deletedAgents} agents, ${res.deletedSessions} chats, ${res.deletedMemories} memories.`);
        } catch (e: any) {
          console.warn(`  ⚠️ Asset wipe warning: ${e.message}`);
        }
      }

      // 1. Service Account
      let saEmail = '';
      let clientId: string | undefined;
      const saKeyPath = path.resolve(process.cwd(), 'sa-dwd-key.json');
      if (fs.existsSync(saKeyPath)) {
        try {
          const saData = JSON.parse(fs.readFileSync(saKeyPath, 'utf-8'));
          saEmail = saData.client_email;
          clientId = saData.client_id;
        } catch {}
      }
      const trackedState = AppStateTracker.loadState();
      if (!saEmail) {
        const trackedSa = trackedState.createdServiceAccounts.find(s => s.projectId === targetProject);
        if (trackedSa) {
          saEmail = trackedSa.email;
          clientId = trackedSa.clientId;
        }
      }
      if (!saEmail) {
        saEmail = `gemini-dwd-migrator@${targetProject}.iam.gserviceaccount.com`;
      }

      // 2. Reset Org Policies
      console.log('• Resetting overwritten organization policies...');
      const constraintsToReset = new Set<string>();
      trackedState.overriddenOrgPolicies
        .filter(p => p.projectId === targetProject)
        .forEach(p => constraintsToReset.add(p.constraint));
      constraintsToReset.add('iam.disableServiceAccountKeyCreation');

      for (const constraint of constraintsToReset) {
        try {
          await execFileAsync('gcloud', ['org-policies', 'reset', constraint, `--project=${targetProject}`]);
          console.log(`  ✓ Reset org policy "${constraint}" to inherited default.`);
        } catch (opErr: any) {
          console.log(`  ℹ️ Org policy "${constraint}": ${opErr.message?.split('\n')[0] || 'Already default'}`);
        }
      }

      // 3. Revoke IAM roles
      console.log(`• Revoking IAM roles from ${saEmail}...`);
      const roles = ['roles/discoveryengine.admin', 'roles/serviceusage.serviceUsageConsumer', 'roles/iam.serviceAccountTokenCreator'];
      for (const role of roles) {
        try {
          await execFileAsync('gcloud', ['projects', 'remove-iam-policy-binding', targetProject, `--member=serviceAccount:${saEmail}`, `--role=${role}`, '--quiet']);
          console.log(`  ✓ Revoked ${role}`);
        } catch {}
      }

      // 4. Delete SA (which also permanently revokes DWD)
      console.log(`• Deleting Service Account ${saEmail} (invalidating DWD)...`);
      try {
        await execFileAsync('gcloud', ['iam', 'service-accounts', 'delete', saEmail, `--project=${targetProject}`, '--quiet']);
        console.log(`  ✓ Deleted ${saEmail}. Numeric client ID ${clientId || ''} permanently invalidated in Google Workspace.`);
      } catch (saErr: any) {
        console.log(`  ℹ️ Service account deletion notice: ${saErr.message?.split('\n')[0] || 'Not found'}`);
      }

      // 5. Delete local files & purge directories
      console.log('• Wiping local credentials and output directories...');
      const filesToDelete = [
        'sa-dwd-key.json',
        'workforce-identity-config.json',
        'wif-migration-key.pem',
        'wif-migration-jwks.json',
        'idp-subject-token.jwt',
        'migration-config.json',
        '.migration-state.json'
      ];
      for (const f of filesToDelete) {
        const fp = path.resolve(process.cwd(), f);
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          console.log(`  ✓ Deleted ${f}`);
        }
      }

      const dirsToPurge = ['reports', 'exports/artifacts', 'exports/memories', 'exports', 'user_handover_reports', 'user_artifacts'];
      for (const d of dirsToPurge) {
        const dp = path.resolve(process.cwd(), d);
        if (fs.existsSync(dp)) {
          fs.rmSync(dp, { recursive: true, force: true });
          fs.mkdirSync(dp, { recursive: true });
          console.log(`  ✓ Purged ${d}/`);
        }
      }

      AppStateTracker.clearTrackedState();

      // 6. Automatically Validate Rollback Completeness
      console.log('• Validating rollback completeness across cloud and workstation...');
      const { validateRollbackCompleteness } = await import('./routes/maintenance.js');
      const audit = await validateRollbackCompleteness({ targetProject, serviceAccountEmail: saEmail, clientId });

      console.log('\nROLLBACK AUDIT CHECKLIST:');
      for (const chk of audit.checks) {
        const symbol = chk.passed ? '  ✅ [PASS]' : '  ❌ [FAIL]';
        console.log(`${symbol} ${chk.name}: ${chk.statusText}`);
        console.log(`             ${chk.details}`);
      }

      console.log('\n------------------------------------------------------');
      console.log('📋 GOOGLE WORKSPACE DOMAIN-WIDE DELEGATION NOTICE:');
      console.log('  Google Workspace does not offer an API to programmatically');
      console.log('  delete DWD client authorizations.');
      console.log(`  GCP Service Account ${saEmail} was permanently deleted,`);
      console.log('  cryptographically neutralizing all token minting authority.');
      console.log('  To remove the remaining registration row in Google Workspace:');
      console.log('  1. Open: https://admin.google.com/ac/owl/domainwidedelegation');
      if (clientId) {
        console.log(`  2. Locate Client ID: ${clientId}`);
      }
      console.log('  3. Hover or click the client row and select "Delete"');
      console.log('------------------------------------------------------');

      console.log('\n======================================================');
      if (audit.isFullyRolledBack) {
        console.log('  🎉 100% VERIFIED: Environment Restored to Pre-Setup Baseline');
      } else {
        console.log(`  ⚠️ Notice: Rollback completed with ${audit.failedChecks} advisory item(s)`);
      }
      console.log(`  Passed Checks: ${audit.passedChecks} / ${audit.totalChecks}`);
      console.log('======================================================\n');
    } catch (err: any) {
      console.error(`\n❌ Decommission failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('audit')
  .description('Run configuration parity and readiness gap audit between source and target engines')
  .option('-c, --config <path>', 'Path to migration config JSON file')
  .option('--sync', 'Automatically synchronize missing engine settings to target')
  .option('--format <format>', 'Output format: text, json, or markdown (default: text)', 'text')
  .action(async (cmdOptions) => {
    try {
      let baseConfig: any = {};
      if (cmdOptions.config) {
        baseConfig = loadConfigFile(cmdOptions.config);
      } else {
        baseConfig = loadConfigFromEnv();
      }

      const validatedConfig = MigrationConfigSchema.parse(baseConfig);
      const saKeyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || (fs.existsSync('./sa-dwd-key.json') ? './sa-dwd-key.json' : undefined);
      const authService = new GcpAuthService({ serviceAccountKeyPath: saKeyPath });
      const client = new DiscoveryEngineClient(authService);
      const registryClient = new AgentRegistryClient(authService);
      const auditEngine = new ConfigAuditEngine(authService, client, registryClient);

      const auditResult = await auditEngine.runAudit(validatedConfig);

      if (cmdOptions.sync) {
        console.log('\n[SYNC] Synchronizing engine settings to target...');
        const syncResult = await auditEngine.syncEngineSettings(validatedConfig);
        console.log(`[SYNC] ${syncResult.message}`);
      }

      if (cmdOptions.format === 'json') {
        console.log(JSON.stringify(auditResult, null, 2));
      } else if (cmdOptions.format === 'markdown') {
        console.log(auditEngine.generateMarkdownReport(auditResult));
      } else {
        console.log('\n======================================================');
        console.log('       GEMINI ENTERPRISE CONFIGURATION AUDIT         ');
        console.log('======================================================');
        console.log(`Source Project:       ${auditResult.sourceProject}`);
        console.log(`Target Project:       ${auditResult.targetProject}`);
        console.log(`Readiness Score:      ${auditResult.readinessScore}%`);
        console.log(`Matching Settings:    ${auditResult.matchingCount} / ${auditResult.totalChecks}`);
        console.log(`Missing in Target:    ${auditResult.missingInTargetCount}`);
        console.log(`Differences:          ${auditResult.diffsCount}`);
        console.log(`Warnings:             ${auditResult.warningsCount}`);
        console.log('======================================================\n');

        console.log('FINDINGS:');
        for (const item of auditResult.items) {
          const icon = item.status === 'MATCH' ? '✅' : item.status === 'WARNING' ? '⚠️' : '❌';
          console.log(`  ${icon} [${item.status}] ${item.name}`);
          if (item.sourceValue !== undefined || item.targetValue !== undefined) {
            console.log(`      Source: ${JSON.stringify(item.sourceValue)} | Target: ${JSON.stringify(item.targetValue)}`);
          }
          if (item.details) {
            console.log(`      ${item.details}`);
          }
        }

        if (auditResult.remediationPlan.length > 0) {
          console.log('\nREMEDIATION RECOMMENDATIONS:');
          for (const plan of auditResult.remediationPlan) {
            console.log(`  • ${plan.title}: ${plan.description}`);
            if (plan.command) {
              console.log(`    Command: ${plan.command}`);
            }
          }
        }
      }

      if (auditResult.readinessScore < 50) {
        process.exit(1);
      }
    } catch (err: any) {
      console.error(`\n❌ Configuration audit failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('verify-rollback')
  .description('Validate that all migration resources, service accounts, org policies, and local files have been completely rolled back')
  .requiredOption('-p, --project <projectId>', 'Target Google Cloud project ID')
  .option('--service-account <email>', 'Explicit service account email to verify')
  .option('--client-id <clientId>', 'Explicit OAuth2 numeric client ID to verify')
  .action(async (cmdOptions) => {
    try {
      const targetProject = (cmdOptions.project || '').trim();
      const saEmail = cmdOptions.serviceAccount ? cmdOptions.serviceAccount.trim() : undefined;
      const clientId = cmdOptions.clientId ? cmdOptions.clientId.trim() : undefined;

      console.log(`\n======================================================`);
      console.log(`  VALIDATING ROLLBACK & DECOMMISSION COMPLETENESS     `);
      console.log(`======================================================`);
      console.log(`Target Project:       ${targetProject}`);
      console.log(`======================================================\n`);

      const { validateRollbackCompleteness } = await import('./routes/maintenance.js');
      const result = await validateRollbackCompleteness({ targetProject, serviceAccountEmail: saEmail, clientId });

      console.log('AUDIT CHECKLIST:');
      for (const chk of result.checks) {
        const symbol = chk.passed ? '  ✅ [PASS]' : '  ❌ [FAIL]';
        console.log(`${symbol} ${chk.name}: ${chk.statusText}`);
        console.log(`             ${chk.details}`);
      }

      if (result.dwdActionRequired) {
        console.log(`\n------------------------------------------------------`);
        console.log(`📋 GOOGLE WORKSPACE ADMIN CONSOLE NOTE:`);
        console.log(`  Google Workspace requires manual removal of DWD client rows.`);
        console.log(`  Console URL: ${result.dwdActionRequired.consoleUrl}`);
        if (result.clientId) {
          console.log(`  Client ID:   ${result.clientId}`);
        }
        console.log(`------------------------------------------------------`);
      }

      console.log(`\n------------------------------------------------------`);
      console.log(`Result:               ${result.overallStatus === 'VERIFIED_CLEAN' ? '✨ 100% VERIFIED CLEAN PRE-SETUP BASELINE' : '⚠️ ROLLBACK INCOMPLETE'}`);
      console.log(`Checks Passed:        ${result.passedChecks} / ${result.totalChecks}`);
      console.log(`------------------------------------------------------\n`);

      if (!result.isFullyRolledBack) {
        process.exit(1);
      }
    } catch (err: any) {
      console.error(`\n❌ Rollback verification failed: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
