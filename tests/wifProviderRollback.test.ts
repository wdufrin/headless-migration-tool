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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import util from 'util';

/**
 * Rollback verification for the custom Workforce Identity OIDC provider -- the
 * "Shadow IdP" this tool registers in order to impersonate users headlessly.
 *
 * Every gcloud invocation is mocked. The tests run from a temporary working
 * directory so that the developer's real ./workforce-identity-config.json cannot
 * leak into the candidate list and make results depend on the machine.
 */

/** Queue of gcloud responses, matched by a predicate against argv. */
type GcloudHandler = (args: string[]) => { stdout: string; stderr?: string };
let gcloudHandler: GcloudHandler;
let gcloudCalls: string[][] = [];

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();

  const execFile: any = (..._unused: any[]) => {
    throw new Error('Callback-style execFile is not supported by this mock.');
  };

  // The code under test does `promisify(execFile)` and destructures `{ stdout }`,
  // so the promisified form must resolve to an object, not a bare string.
  execFile[util.promisify.custom] = async (_cmd: string, args: string[]) => {
    gcloudCalls.push(args);
    return gcloudHandler(args);
  };

  return { ...actual, execFile, default: { ...actual, execFile } };
});

const { AppStateTracker } = await import('../src/services/appStateTracker.js');
const { validateRollbackCompleteness } = await import('../src/routes/maintenance.js');

function isProviderDescribe(args: string[]): boolean {
  return (
    args.includes('workforce-pools') && args.includes('providers') && args.includes('describe')
  );
}

/** Default: everything that is not a provider describe reports "already clean". */
function notFound(): never {
  throw new Error('NOT_FOUND: The resource does not exist.');
}

let tempDir: string;
let originalCwd: string;
const originalStatePath = AppStateTracker.getStateFilePath();

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wif-provider-rollback-'));
  process.chdir(tempDir);

  AppStateTracker.setStateFilePath(path.join(tempDir, '.migration-state.json'));
  AppStateTracker.clearTrackedState();

  gcloudCalls = [];
  gcloudHandler = () => notFound();
});

afterEach(() => {
  process.chdir(originalCwd);
  AppStateTracker.setStateFilePath(originalStatePath);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Rollback verification: custom Workforce Identity OIDC provider', () => {
  it('FAILS the rollback when the tracked provider is still active', async () => {
    AppStateTracker.recordWifProvider('wdufrin-okta', 'migration-dwd-provider', 'global');

    gcloudHandler = (args) => {
      if (isProviderDescribe(args)) {
        return {
          stdout: JSON.stringify({
            name: 'locations/global/workforcePools/wdufrin-okta/providers/migration-dwd-provider',
            state: 'ACTIVE'
          })
        };
      }
      return notFound();
    };

    const result = await validateRollbackCompleteness({ targetProject: 'proj-under-test' });

    const check = result.checks.find((c) => c.id.startsWith('wif_oidc_provider_'));
    expect(check, 'a provider check must be emitted').toBeDefined();
    expect(check?.passed).toBe(false);
    expect(check?.statusText).toBe('Provider Still Active');
    // The operator must be told what the residual capability actually is.
    expect(check?.details).toContain('bypassing MFA');
    expect(check?.details).toContain('gcloud iam workforce-pools providers delete');

    expect(result.isFullyRolledBack).toBe(false);
    expect(result.overallStatus).toBe('ROLLBACK_INCOMPLETE');
  });

  it('passes when the provider is soft-deleted (GCP describe still succeeds)', async () => {
    AppStateTracker.recordWifProvider('wdufrin-okta', 'migration-dwd-provider', 'global');

    gcloudHandler = (args) => {
      if (isProviderDescribe(args)) {
        return {
          stdout: JSON.stringify({
            name: 'locations/global/workforcePools/wdufrin-okta/providers/migration-dwd-provider',
            state: 'DELETED'
          })
        };
      }
      return notFound();
    };

    const result = await validateRollbackCompleteness({ targetProject: 'proj-under-test' });
    const check = result.checks.find((c) => c.id.startsWith('wif_oidc_provider_'));

    expect(check?.passed).toBe(true);
    expect(check?.statusText).toBe('Deleted (Pending Purge)');
  });

  it('passes when describe reports NOT_FOUND', async () => {
    AppStateTracker.recordWifProvider('wdufrin-okta', 'migration-dwd-provider', 'global');
    gcloudHandler = () => notFound();

    const result = await validateRollbackCompleteness({ targetProject: 'proj-under-test' });
    const check = result.checks.find((c) => c.id.startsWith('wif_oidc_provider_'));

    expect(check?.passed).toBe(true);
    expect(check?.statusText).toBe('Provider Removed');
  });

  it('FAILS CLOSED when the provider cannot be verified due to permissions', async () => {
    AppStateTracker.recordWifProvider('wdufrin-okta', 'migration-dwd-provider', 'global');

    gcloudHandler = (args) => {
      if (isProviderDescribe(args)) {
        throw new Error('PERMISSION_DENIED: caller lacks iam.workforcePoolProviders.get');
      }
      return notFound();
    };

    const result = await validateRollbackCompleteness({ targetProject: 'proj-under-test' });
    const check = result.checks.find((c) => c.id.startsWith('wif_oidc_provider_'));

    // An unverifiable Shadow IdP must not be reported as a clean rollback.
    expect(check?.passed).toBe(false);
    expect(check?.statusText).toBe('Verification Inconclusive (Permission Denied)');
    expect(result.overallStatus).toBe('ROLLBACK_INCOMPLETE');
  });

  it('discovers an untracked provider from a surviving workforce-identity-config.json', async () => {
    // No tracked state at all -- simulates a provider created before tracking existed.
    fs.writeFileSync(
      path.join(tempDir, 'workforce-identity-config.json'),
      JSON.stringify({
        type: 'external_account',
        audience:
          '//iam.googleapis.com/locations/global/workforcePools/legacy-pool/providers/legacy-provider'
      }),
      'utf-8'
    );

    let describedProvider: string | undefined;
    gcloudHandler = (args) => {
      if (isProviderDescribe(args)) {
        describedProvider = args[args.indexOf('describe') + 1];
        return { stdout: JSON.stringify({ name: 'legacy', state: 'ACTIVE' }) };
      }
      return notFound();
    };

    const result = await validateRollbackCompleteness({ targetProject: 'proj-under-test' });

    expect(describedProvider).toBe('legacy-provider');
    const check = result.checks.find((c) => c.id.startsWith('wif_oidc_provider_'));
    expect(check?.passed).toBe(false);
    expect(check?.details).toContain('legacy-pool');
  });

  it('is explicit that "nothing recorded" does not prove no provider exists', async () => {
    const result = await validateRollbackCompleteness({ targetProject: 'proj-under-test' });
    const check = result.checks.find((c) => c.id === 'wif_oidc_provider');

    expect(check?.passed).toBe(true);
    expect(check?.statusText).toBe('No Provider Recorded');
    // Guards against this check quietly becoming a false reassurance.
    expect(check?.details).toContain('cannot prove');

    // And it must not have invoked a provider describe with nothing to describe.
    expect(gcloudCalls.filter(isProviderDescribe)).toHaveLength(0);
  });

  it('counts tracked providers in the residual-state check', async () => {
    AppStateTracker.recordWifProvider('wdufrin-okta', 'migration-dwd-provider', 'global');

    const result = await validateRollbackCompleteness({ targetProject: 'proj-under-test' });
    const tracker = result.checks.find((c) => c.id === 'app_state_tracker');

    expect(tracker?.passed).toBe(false);
    expect(tracker?.details).toContain('1 WiF provider(s)');
  });
});

describe('AppStateTracker provider tracking', () => {
  it('round-trips a provider and does not duplicate on re-record', () => {
    AppStateTracker.recordWifProvider('pool-a', 'prov-a', 'global', {
      issuerUri: 'https://gemini-migration.internal',
      attributeCondition: "assertion.email != ''"
    });
    AppStateTracker.recordWifProvider('pool-a', 'prov-a', 'global');

    const state = AppStateTracker.loadState();
    expect(state.createdWifProviders).toHaveLength(1);
    expect(state.createdWifProviders[0].providerId).toBe('prov-a');
    expect(state.createdWifProviders[0].workforcePoolId).toBe('pool-a');
  });

  it('tracks distinct providers separately', () => {
    AppStateTracker.recordWifProvider('pool-a', 'prov-a', 'global');
    AppStateTracker.recordWifProvider('pool-a', 'prov-b', 'global');

    expect(AppStateTracker.loadState().createdWifProviders).toHaveLength(2);
  });

  it('loads legacy state files that predate provider tracking without throwing', () => {
    fs.writeFileSync(
      AppStateTracker.getStateFilePath(),
      JSON.stringify({
        overriddenOrgPolicies: [],
        createdServiceAccounts: [],
        appliedIamBindings: []
        // no createdWifProviders key
      }),
      'utf-8'
    );

    const state = AppStateTracker.loadState();
    expect(state.createdWifProviders).toEqual([]);
  });
});
