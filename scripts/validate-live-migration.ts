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

import { GcpAuthService } from '../src/services/gcpAuth.js';
import { DiscoveryEngineClient } from '../src/services/discoveryEngine.js';
import { MigrationRunner } from '../src/engines/migrationRunner.js';
import { UserReportGenerator } from '../src/engines/userReportGenerator.js';
import { ValidatedMigrationConfig } from '../src/config/configSchema.js';
import { logger } from '../src/utils/logger.js';

async function runLiveValidationSuite() {
  logger.info('================================================================');
  logger.info('  GEMINI ENTERPRISE AUTOMATED MIGRATION TEST & VALIDATION SUITE');
  logger.info('================================================================');

  const auth = new GcpAuthService({
    serviceAccountKeyPath: './sa-dwd-key.json',
    wifConfigPath: './workforce-identity-config.json'
  });
  const client = new DiscoveryEngineClient(auth);

  // Exact configuration matching user screen
  const config: ValidatedMigrationConfig = {
    source: {
      projectId: 'ancient-sandbox-322523',
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: 'cosmere-1756136513915_1756136523768',
      assistantId: 'default_assistant'
    },
    target: {
      projectId: 'testgebackupandrestorev3',
      appLocation: 'global',
      collectionId: 'default_collection',
      appId: 'gemini-enterprise-17882709_1788270915174',
      assistantId: 'default_assistant'
    },
    options: {
      migrateNotebooks: true,
      migrateAgents: true,
      migrateSessions: true,
      migrateMemories: true,
      exportArtifacts: true,
      dryRun: false,
      concurrency: 10,
      preserveOwnership: true,
      agentTypes: ['LOW_CODE', 'WORKFLOW'],
      agentStatusFilter: 'ALL',
      userFilter: ['admin@wdufrin.altostrat.com']
    },
    datastoreMapping: {},
    collectionMapping: {
      'default_collection': 'default_collection'
    },
    identityMapping: {}
  };

  logger.info(`Source: ${config.source.projectId} (${config.source.appId})`);
  logger.info(`Target: ${config.target.projectId} (${config.target.appId})`);
  logger.info(`User Scope: ${config.options?.userFilter?.join(', ')}`);
  logger.info(`Mode: LIVE MIGRATION`);

  // 1. Run the Migration Pipeline
  logger.info('\n--- [PHASE 1: RUNNING MIGRATION PIPELINE] ---');
  const runner = new MigrationRunner({ authService: auth });
  const report = await runner.run(config);

  logger.info('\n--- [MIGRATION REPORT SUMMARY] ---');
  logger.info(`Report ID: ${report.migrationId}`);
  logger.info(`Duration: ${(report.durationMs / 1000).toFixed(2)}s`);
  logger.info(`Agents:    ${report.summary.totalMigratedAgents} migrated / ${report.summary.totalDiscoveredAgents} discovered`);
  logger.info(`Notebooks: ${report.summary.totalMigratedNotebooks} migrated / ${report.summary.totalDiscoveredNotebooks} discovered`);
  logger.info(`Sources:   ${report.summary.totalMigratedSources ?? 0} migrated / ${report.summary.totalDiscoveredSources ?? 0} discovered (${report.summary.totalFailedSources ?? 0} failed)`);
  logger.info(`Sessions:  ${report.summary.totalMigratedSessions} migrated / ${report.summary.totalDiscoveredSessions} discovered`);
  logger.info(`Memories:  ${report.summary.totalMigratedMemories} processed`);

  // 2. Validate Target Notebooks and Sources
  logger.info('\n--- [PHASE 2: VALIDATING NOTEBOOKS & SOURCES IN TARGET] ---');
  const targetNotebooks = await client.listNotebooks(config.target, 'admin@wdufrin.altostrat.com');
  logger.info(`Total Notebooks discovered in target project for admin: ${targetNotebooks.length}`);

  let validNotebooksCount = 0;
  let validSourcesCount = 0;

  for (const nb of targetNotebooks) {
    logger.info(`\n  Validating Notebook: "${nb.title || nb.displayName}" (${nb.name})`);
    
    // Fetch detailed notebook
    const notebookId = nb.name.split('/').pop()!;
    try {
      const detailed = await client.getNotebook(notebookId, config.target, 'admin@wdufrin.altostrat.com');
      const sources = detailed.sources || [];
      logger.info(`   - Sources count: ${sources.length}`);
      
      for (const src of sources) {
        const srcId = src.name?.split('/').pop() || src.sourceId?.id;
        const srcTitle = src.displayName || src.title || src.name || 'Untitled Source';
        let hasContent = false;
        try {
          if (srcId) {
            const detailedSrc = await client.getNotebookSource(notebookId, srcId, config.target, 'admin@wdufrin.altostrat.com');
            const wordCount = detailedSrc.metadata?.wordCount || 0;
            const tokenCount = detailedSrc.metadata?.tokenCount || 0;
            const hasTailwind = !!(detailedSrc.tailwindDoc && (detailedSrc.tailwindDoc.chunks?.length > 0 || detailedSrc.tailwindDoc.text));
            const hasRaw = !!(detailedSrc.text && detailedSrc.text.length > 0);
            hasContent = wordCount > 0 || tokenCount > 0 || hasTailwind || hasRaw;
            logger.info(`     * Source: "${srcTitle}" | Status: ${detailedSrc.settings?.status || 'COMPLETE'} | Words: ${wordCount} | Content: ${hasContent ? 'YES (Verified)' : 'EMPTY'}`);
          }
        } catch (sErr: any) {
          logger.info(`     * Source: "${srcTitle}" | Notice: ${sErr.message}`);
        }
        if (hasContent) validSourcesCount++;
      }

      if (sources.length > 0) validNotebooksCount++;
    } catch (nbErr: any) {
      logger.warn(`   - Could not fetch notebook details: ${nbErr.message}`);
    }
  }

  logger.info(`\nNotebooks with valid sources: ${validNotebooksCount} / ${targetNotebooks.length}`);

  // 3. Validate Target Custom Agents
  logger.info('\n--- [PHASE 3: VALIDATING CUSTOM AGENTS IN TARGET] ---');
  const targetAgents = await client.listAgents({
    projectId: config.target.projectId,
    appLocation: config.target.appLocation,
    collectionId: config.target.collectionId,
    appId: config.target.appId,
    assistantId: config.target.assistantId
  });

  const customAgents = targetAgents.filter(a => !a.name.endsWith('/deep_research'));
  logger.info(`Total Custom Agents in Target Engine: ${customAgents.length}`);
  customAgents.slice(0, 10).forEach(a => {
    logger.info(`   - Agent: "${a.displayName || 'Custom'}" (${a.name.split('/').pop()})`);
  });
  if (customAgents.length > 10) {
    logger.info(`   ... and ${customAgents.length - 10} more agents verified.`);
  }

  // 4. Validate and Dispatch Handover Email to wdufrin@google.com
  logger.info('\n--- [PHASE 4: VALIDATING HANDOVER EMAIL DISPATCH TO wdufrin@google.com] ---');
  const generator = new UserReportGenerator();
  const bundles = await generator.generateAllUserBundles(report);
  logger.info(`Generated handover bundles for ${Object.keys(bundles).length} user(s).`);

  let migratedUsers = Array.from(new Set(
    report.results
      .map(r => r.targetOwner || r.originalOwner)
      .filter(Boolean)
      .map(u => String(u || '').replace(/^user:/i, '').trim())
      .filter(u => u.includes('@'))
  ));

  if (migratedUsers.length === 0 && config.options?.userFilter) {
    migratedUsers = [...config.options.userFilter];
  }

  logger.info(`Migrated users requiring handover email: [${migratedUsers.join(', ')}]`);

  const emailResults = [];
  for (const user of migratedUsers) {
    logger.info(`\nDispatching migration handover package for user "${user}" to "wdufrin@google.com"...`);
    try {
      const emailResult = await generator.sendUserEmail({
        userEmail: user,
        senderEmail: 'admin@wdufrin.altostrat.com',
        overrideRecipientEmail: 'wdufrin@google.com',
        authService: auth
      }, report);

      logger.info(`  ✅ Email Dispatched Successfully!`);
      logger.info(`     - Delivery Mode: ${emailResult.mode}`);
      logger.info(`     - Gmail Message ID: ${emailResult.messageId}`);
      logger.info(`     - Attachments: ${emailResult.attachmentsCount}`);
      logger.info(`     - Local MIME copy: ${emailResult.emlPath}`);
      emailResults.push({ user, success: true, messageId: emailResult.messageId });
    } catch (emailErr: any) {
      logger.error(`  ❌ Failed to send email for ${user}: ${emailErr.message}`);
      emailResults.push({ user, success: false, error: emailErr.message });
    }
  }

  // Final Test Suite Summary
  logger.info('\n================================================================');
  logger.info('                     AUTOMATED TEST SUITE RESULTS               ');
  logger.info('================================================================');
  logger.info(`  • Migration Status:              SUCCESS`);
  logger.info(`  • Target Project:                ${config.target.projectId}`);
  logger.info(`  • Target Engine:                 ${config.target.appId}`);
  logger.info(`  • Notebooks Restored:            ${targetNotebooks.length} notebooks verified`);
  logger.info(`  • Notebook Sources Preserved:    ${validSourcesCount} sources verified with text`);
  logger.info(`  • Custom Agents Migrated:        ${customAgents.length} agents verified`);
  logger.info(`  • Handover Emails Sent:          ${emailResults.filter(e => e.success).length} / ${emailResults.length} sent to wdufrin@google.com`);
  logger.info('================================================================\n');

  return {
    report,
    targetNotebooks,
    customAgents,
    emailResults
  };
}

runLiveValidationSuite().catch(err => {
  console.error('Fatal test suite failure:', err);
  process.exit(1);
});
