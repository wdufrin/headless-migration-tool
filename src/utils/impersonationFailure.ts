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

/**
 * Classification of a failure to impersonate a user.
 *
 * Why this exists
 * ---------------
 * The migrators previously decided "this user does not exist in the target directory,
 * so drop their data" using a predicate that included the string
 * `'DWD Impersonation Failed'`. That string is the WRAPPER prefix attached to every
 * impersonation error, including pure configuration failures. The predicate therefore
 * matched essentially everything.
 *
 * The consequence was severe: if the service account's scopes were not authorised in
 * the Workspace admin console (`unauthorized_client`), or no service account key was
 * present at all, every user's agents and notebooks were discarded and recorded as
 * `SKIPPED` with the message "User not found in target Google Identity. Data safely
 * dropped." Skipped items were excluded from `totalFailed`, so the CLI printed
 * SUCCESS and exited 0.
 *
 * Dropping data is only defensible when the user genuinely is not present in the
 * target directory. A misconfiguration must fail loudly instead.
 */
export type ImpersonationFailureKind = 'MISSING_USER' | 'MISCONFIGURED' | 'UNKNOWN';

export interface ImpersonationFailureClassification {
  kind: ImpersonationFailureKind;
  /** True only when discarding the user's assets is a defensible outcome. */
  safeToDropData: boolean;
  /** Operator-facing explanation of what actually went wrong. */
  explanation: string;
}

/**
 * Google's OAuth/DWD error codes that mean the subject is not a resolvable user in
 * the target Workspace directory.
 */
const MISSING_USER_PATTERNS: RegExp[] = [
  /\binvalid_grant\b/i,
  /invalid email or user id/i,
  /user does not exist/i,
  /\buserNotFound\b/i,
  /does not exist in.{0,40}(domain|directory|workspace)/i
];

/**
 * Error codes that indicate the CALLER is misconfigured. The user's existence is
 * unknown in these cases, so their data must not be discarded.
 */
const MISCONFIGURED_PATTERNS: RegExp[] = [
  /\bunauthorized_client\b/i,
  /\bclient_is_not_authorized\b/i,
  /client is unauthorized/i,
  /no service account key configured/i,
  /invalid impersonation/i,
  /\binvalid_client\b/i,
  /\baccess_denied\b/i,
  /not authorized to act as/i,
  /insufficient authentication scopes/i,
  /iam\.serviceAccountTokenCreator/i
];

/**
 * Classifies an impersonation failure message.
 *
 * Deliberately defaults to UNKNOWN (which is NOT safe to drop) rather than assuming a
 * missing user. An unrecognised error is a reason to stop, not a reason to delete.
 */
export function classifyImpersonationFailure(message: string): ImpersonationFailureClassification {
  const text = String(message ?? '');

  if (MISCONFIGURED_PATTERNS.some((re) => re.test(text))) {
    return {
      kind: 'MISCONFIGURED',
      safeToDropData: false,
      explanation:
        'Impersonation is misconfigured, so it could not be determined whether this user exists. ' +
        'Verify Domain-Wide Delegation scopes in the Workspace admin console, the service account key, ' +
        'and the Workforce Identity provider configuration.'
    };
  }

  if (MISSING_USER_PATTERNS.some((re) => re.test(text))) {
    return {
      kind: 'MISSING_USER',
      safeToDropData: true,
      explanation: 'The target Google identity does not exist, so the asset has no valid owner in the target tenant.'
    };
  }

  return {
    kind: 'UNKNOWN',
    safeToDropData: false,
    explanation:
      'Impersonation failed for an unrecognised reason. Treating this as a failure rather than assuming the ' +
      'user is absent, because discarding data on an unknown error is not recoverable.'
  };
}

/**
 * True only when the asset may be dropped and recorded as SKIPPED.
 */
export function isSafeToDropForUser(message: string): boolean {
  return classifyImpersonationFailure(message).safeToDropData;
}
