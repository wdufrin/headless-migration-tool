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
 * Builders for Workforce Identity Federation IAM principal identifiers.
 *
 * Workforce principals are POOL-scoped and provider-independent. Per
 * https://cloud.google.com/iam/docs/workforce-identity-federation the only valid forms are:
 *
 *   principal://iam.googleapis.com/locations/global/workforcePools/POOL/subject/SUBJECT
 *   principalSet://iam.googleapis.com/locations/global/workforcePools/POOL/group/GROUP
 *   principalSet://iam.googleapis.com/locations/global/workforcePools/POOL/attribute.NAME/VALUE
 *   principalSet://iam.googleapis.com/locations/global/workforcePools/POOL/*
 *
 * None of them contain a `/providers/PROVIDER` segment.
 *
 * This matters: the STS *audience* DOES contain `/providers/PROVIDER`, and previously the
 * remediation commands shown to operators were built by appending `/subject/USER` directly
 * to the audience. That produced an identifier that gcloud rejects, so every remediation
 * command the tool told a customer to run was unusable.
 *
 * It also explains why a custom "shadow IdP" provider added to an existing pool inherits
 * the pool's IAM bindings: the binding does not name a provider. The binding matches only
 * if `google.subject` resolves to the SAME value the production provider produces.
 */

/** Thrown when an audience cannot be interpreted as a workforce pool resource. */
export class InvalidWorkforceAudienceError extends Error {
  constructor(audience: string, detail: string) {
    super(`Invalid Workforce Identity audience "${audience}": ${detail}`);
    this.name = 'InvalidWorkforceAudienceError';
  }
}

/**
 * Reduces an STS audience to the pool-scoped IAM resource path, dropping the
 * provider segment and the leading `//`.
 *
 * Throws rather than returning a best-effort string: a silently malformed principal
 * produces IAM commands that appear plausible but cannot work.
 */
export function workforceResourceFromAudience(audience: string): string {
  if (typeof audience !== 'string' || audience.trim() === '') {
    throw new InvalidWorkforceAudienceError(String(audience), 'audience is empty');
  }

  const trimmed = audience.trim().replace(/^\/\//, '').replace(/\/+$/, '');

  if (!trimmed.includes('/workforcePools/')) {
    throw new InvalidWorkforceAudienceError(
      audience,
      'expected the audience to contain "/workforcePools/". Workload Identity audiences ' +
        '("/workloadIdentityPools/") use a different principal syntax and are not handled here.'
    );
  }

  // Everything from `/providers/` onward is provider-scoped and must not appear in a principal.
  const poolScoped = trimmed.split('/providers/')[0];

  const poolId = poolScoped.split('/workforcePools/')[1];
  if (!poolId || poolId.includes('/')) {
    throw new InvalidWorkforceAudienceError(
      audience,
      `could not extract a single pool id (got ${JSON.stringify(poolId ?? null)})`
    );
  }

  return poolScoped;
}

/** Extracts just the workforce pool id from an STS audience. */
export function workforcePoolIdFromAudience(audience: string): string {
  return workforceResourceFromAudience(audience).split('/workforcePools/')[1];
}

/**
 * Builds the IAM principal identifier for a single federated user.
 *
 * `subject` must be the value the provider's `google.subject` attribute mapping produces --
 * NOT necessarily the user's email. If the production provider maps `google.subject` to an
 * opaque IdP id (Okta's `00u...`, an Entra object GUID), a principal built from the email
 * will not match any binding.
 */
export function buildWorkforcePrincipal(audience: string, subject: string): string {
  const cleanSubject = (subject ?? '').trim();
  if (!cleanSubject) {
    throw new InvalidWorkforceAudienceError(audience, 'a non-empty subject is required');
  }
  return `principal://${workforceResourceFromAudience(audience)}/subject/${cleanSubject}`;
}

/** Builds the IAM principalSet identifier matching every identity in the pool. */
export function buildWorkforcePrincipalSet(audience: string): string {
  return `principalSet://${workforceResourceFromAudience(audience)}/*`;
}
