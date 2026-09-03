import fs from 'fs';
import { UserReportGenerator } from '../src/engines/userReportGenerator.js';
import { GcpAuthService } from '../src/services/gcpAuth.js';
import { MigrationRunner } from '../src/engines/migrationRunner.js';

async function main() {
  const authService = new GcpAuthService();
  const config = JSON.parse(fs.readFileSync('migration-config.json', 'utf8'));

  // Use dryRun: true to discover all live notebooks and artifacts without mutating target
  config.options = { ...config.options, dryRun: true };

  const runner = new MigrationRunner({ authService, outputDir: './reports' });
  console.log('Discovering notebooks, sources, and artifacts...');
  const report = await runner.run(config);

  const generator = new UserReportGenerator();

  console.log('Dispatching zipped handover email to wdufrin@google.com...');
  const result = await generator.sendUserEmail({
    userEmail: 'admin@wdufrin.altostrat.com',
    overrideRecipientEmail: 'wdufrin@google.com',
    senderEmail: 'admin@wdufrin.altostrat.com',
    zipAttachments: true,
    optimizeMedia: true,
    authService
  }, report);

  console.log('\n=============================================');
  console.log('         DISPATCH COMPLETED                  ');
  console.log('=============================================');
  console.log('Success:', result.success);
  console.log('Mode:', result.mode);
  console.log('Message ID:', result.messageId);
  console.log('Thread ID:', result.threadId);
  console.log('Parts Sent:', result.partsSent);
  console.log('Attachments Count:', result.attachmentsCount);
  console.log('Attachments:', result.parts?.[0]?.filenames);
  console.log('=============================================\n');
}

main().catch(err => {
  console.error('Fatal Dispatch Error:', err);
  process.exit(1);
});
