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

import { describe, it, expect } from 'vitest';
import {
  classifyImpersonationFailure,
  isSafeToDropForUser
} from '../src/utils/impersonationFailure.js';

/**
 * Guards against silent data loss.
 *
 * The migrators decide whether to DISCARD a user's agents and notebooks based on this
 * classification. Before the fix, the predicate included the string
 * 'DWD Impersonation Failed' -- the wrapper prefix present on EVERY impersonation
 * error -- so configuration failures were recorded as "user not found ... data safely
 * dropped", excluded from totalFailed, and the CLI exited 0 reporting SUCCESS.
 *
 * Measured before the fix: 3 of 5 real error strings were misclassified.
 */

const WRAPPER = (reason: string) => `DWD Impersonation Failed for user "a@x.com": ${reason}`;

describe('classifyImpersonationFailure', () => {
  describe('configuration errors must never drop data', () => {
    it.each([
      ['no service account key', WRAPPER('No Service Account Key configured for Domain-Wide Delegation')],
      ['unauthorized_client', WRAPPER('unauthorized_client: Client is unauthorized to retrieve access tokens using this method')],
      ['client_is_not_authorized', WRAPPER('client_is_not_authorized')],
      ['invalid impersonation', WRAPPER('Invalid impersonation target')],
      ['invalid_client', WRAPPER('invalid_client: The OAuth client was not found')],
      ['access_denied', WRAPPER('access_denied')],
      ['insufficient scopes', 'Request had insufficient authentication scopes.'],
      ['missing token creator role', 'Permission iam.serviceAccountTokenCreator is required']
    ])('%s is MISCONFIGURED and not safe to drop', (_label, message) => {
      const result = classifyImpersonationFailure(message);
      expect(result.kind).toBe('MISCONFIGURED');
      expect(result.safeToDropData).toBe(false);
    });
  });

  describe('genuinely absent users may be dropped', () => {
    it.each([
      ['invalid_grant', WRAPPER('invalid_grant: Invalid email or User ID')],
      ['user does not exist', WRAPPER('User does not exist')],
      ['userNotFound', WRAPPER('userNotFound')]
    ])('%s is MISSING_USER and safe to drop', (_label, message) => {
      const result = classifyImpersonationFailure(message);
      expect(result.kind).toBe('MISSING_USER');
      expect(result.safeToDropData).toBe(true);
    });
  });

  describe('unrecognised errors default to unsafe', () => {
    it.each([
      ['the bare wrapper', WRAPPER('User impersonation failed')],
      ['a network error', 'ECONNRESET'],
      ['an empty message', ''],
      ['an HTTP 500', 'Discovery Engine API Request Failed [500]: Internal error'],
      ['undefined', undefined as any]
    ])('%s is UNKNOWN and not safe to drop', (_label, message) => {
      const result = classifyImpersonationFailure(message);
      expect(result.kind).toBe('UNKNOWN');
      expect(result.safeToDropData).toBe(false);
    });
  });

  it('does not treat the wrapper prefix alone as evidence the user is absent', () => {
    // This is the precise regression. The old predicate returned true here.
    expect(isSafeToDropForUser('DWD Impersonation Failed for user "a@x.com": something unexpected')).toBe(false);
  });

  it('prefers the configuration verdict when a message mentions both', () => {
    // A scope problem reported alongside a grant error is still a configuration problem;
    // dropping data would be unrecoverable.
    const result = classifyImpersonationFailure(
      WRAPPER('unauthorized_client after invalid_grant retry')
    );
    expect(result.kind).toBe('MISCONFIGURED');
    expect(result.safeToDropData).toBe(false);
  });

  it('always explains the verdict so operators can act on it', () => {
    for (const message of [WRAPPER('unauthorized_client'), WRAPPER('invalid_grant'), 'weird']) {
      expect(classifyImpersonationFailure(message).explanation.length).toBeGreaterThan(30);
    }
  });
});
