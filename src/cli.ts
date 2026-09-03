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

import { Command } from 'commander';
import { loadConfigFile, loadConfigFromEnv } from './config/loader.js';
import { MigrationConfigSchema } from './config/configSchema.js';
import { MigrationRunner } from './engines/migrationRunner.js';
import { GcpAuthService } from './services/gcpAuth.js';
import { logger } from './utils/logger.js';

const program = new Command();

program
  .name('gemini-migrate')
  .description('Enterprise admin-driven headless migration tool for Gemini Enterprise notebooks and custom agents.')
  .version('1.4.0')
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
  .option('--concurrency <number>', 'Maximum parallel worker concurrency (default: 10)', '10')
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

program.parse(process.argv);
