import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { afterAll, beforeAll } from 'vitest';

/**
 * Global test setup: makes the suite hermetic with respect to on-disk credentials.
 *
 * Before this existed, running `npm test` in a configured checkout would:
 *   - auto-load ./workforce-identity-config.json and ./sa-dwd-key.json into
 *     GcpAuthService,
 *   - sign a fresh OIDC assertion with ./wif-migration-key.pem, and
 *   - overwrite ./idp-subject-token.jwt in the working tree.
 *
 * That made results depend on whether the developer happened to have live
 * credentials sitting in the repo root, and turned any shared CI runner into a
 * credential-handling surface.
 *
 * This file sets the gate that `isCredentialAutoloadDisabled()` reads, then
 * *verifies* the gate actually held by hashing the credential files before and
 * after the run. If any of them is modified, the run fails loudly rather than
 * reporting green while having mutated the developer's secrets.
 */

// Must be set before any module under test is imported.
process.env.NODE_ENV = 'test';
process.env.MIGRATION_DISABLE_CREDENTIAL_AUTOLOAD = 'true';

// Do not let a stale developer shell leak an identity into the tests.
delete process.env.WIF_USER_EMAIL;
delete process.env.ADMIN_EMAIL;
delete process.env.DEFAULT_USER_EMAIL;
delete process.env.SERVICE_ACCOUNT_KEY_PATH;

/** Credential files the tool is known to read from, or write to, the CWD. */
const CREDENTIAL_FILES = [
  'sa-dwd-key.json',
  'workforce-identity-config.json',
  'wif-migration-key.pem',
  'wif-migration-jwks.json',
  'idp-subject-token.jwt',
];

type FileFingerprint = { existed: boolean; sha256?: string };

const fingerprints = new Map<string, FileFingerprint>();

function fingerprint(file: string): FileFingerprint {
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    return { existed: false };
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  return { existed: true, sha256 };
}

beforeAll(() => {
  for (const file of CREDENTIAL_FILES) {
    fingerprints.set(file, fingerprint(file));
  }
});

afterAll(() => {
  const violations: string[] = [];

  for (const file of CREDENTIAL_FILES) {
    const before = fingerprints.get(file);
    if (!before) continue;
    const after = fingerprint(file);

    if (!before.existed && after.existed) {
      violations.push(`${file} was CREATED during the test run`);
    } else if (before.existed && !after.existed) {
      violations.push(`${file} was DELETED during the test run`);
    } else if (before.existed && after.existed && before.sha256 !== after.sha256) {
      violations.push(`${file} was MODIFIED during the test run`);
    }
  }

  if (violations.length > 0) {
    throw new Error(
      'Test run was not hermetic -- it mutated real credential files:\n' +
        violations.map((v) => `  - ${v}`).join('\n') +
        '\nThe credential autoload gate (isCredentialAutoloadDisabled) did not hold. ' +
        'Find the code path that reads these paths directly and route it through the gate.'
    );
  }
});
