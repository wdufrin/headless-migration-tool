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

import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { workforcePoolIdFromAudience, workforceResourceFromAudience } from '../utils/wifPrincipal.js';

const execFileAsync = promisify(execFile);

/**
 * Preflight check for the "shadow IdP" migration provider.
 *
 * Background
 * ----------
 * The tool registers its own OIDC provider (default: migration-dwd-provider) inside an
 * EXISTING workforce pool and self-signs assertions so it can act as arbitrary users.
 *
 * Workforce IAM bindings are pool-scoped and provider-independent:
 *
 *   principal://iam.googleapis.com/locations/global/workforcePools/POOL/subject/SUBJECT
 *
 * So the impersonation only inherits the user's real permissions when BOTH hold:
 *
 *   1. the migration provider lives in the SAME pool as the production provider, and
 *   2. `google.subject` resolves to the SAME string for both providers.
 *
 * The tool signs `sub: <userEmail>` and maps `google.subject=assertion.sub`, so it can
 * only ever produce the email as the subject. Production IdPs frequently map
 * `google.subject` to an opaque identifier instead -- Okta's `00u...` user id, or an
 * Entra object GUID. When that happens STS still issues a token (the assertion is validly
 * signed), but the resulting principal matches no IAM binding and every user-scoped
 * request returns 403.
 *
 * That failure is invisible without this check: the mint succeeds, and the 403 arrives
 * later from a different API with a message that does not mention subject mapping.
 */

export interface ProviderSubjectMapping {
  providerId: string;
  displayName?: string;
  googleSubject?: string;
  issuerUri?: string;
  state?: string;
}

export type SubjectMappingVerdict = 'MATCH' | 'MISMATCH' | 'UNKNOWN';

/**
 * True when a google.subject CEL expression derives the subject from the user's email
 * address (so the tool, which signs the email, can reproduce it) rather than from an
 * opaque IdP identifier such as an Entra object id or an Okta user id.
 *
 * SAML `assertion.subject` counts: Okta's SAML NameID format for these pools is
 * emailAddress, so the subject is the email.
 */
export function isEmailDerivedMapping(expression: string): boolean {
  const expr = (expression || '').trim();
  return /^assertion\.(email|subject|sub)(\.lowerAscii\(\))?$/.test(expr);
}

export interface SubjectMappingPreflightResult {
  verdict: SubjectMappingVerdict;
  /** Human-readable explanation. Always populated. */
  summary: string;
  migrationProvider?: ProviderSubjectMapping;
  otherProviders: ProviderSubjectMapping[];
  /** Populated when the check could not run (permissions, gcloud missing, etc.). */
  error?: string;
  poolId?: string;
}

/**
 * Parses `gcloud iam workforce-pools providers list --format=json` output.
 * Exported for testing; throws on malformed input rather than returning a partial result.
 */
export function parseProviders(json: string): ProviderSubjectMapping[] {
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch (err: any) {
    throw new Error(`Could not parse provider list as JSON: ${err.message}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`Expected a JSON array of providers, received ${typeof raw}`);
  }

  return raw.map((p: any) => {
    // name looks like: locations/global/workforcePools/POOL/providers/PROVIDER
    const name: string = typeof p?.name === 'string' ? p.name : '';
    const providerId = name.split('/providers/')[1] || name || '(unnamed)';
    return {
      providerId,
      displayName: p?.displayName,
      googleSubject: p?.attributeMapping?.['google.subject'],
      issuerUri: p?.oidc?.issuerUri,
      state: p?.state
    };
  });
}

/**
 * Compares the migration provider's `google.subject` mapping against the other providers
 * in the same pool.
 *
 * Returns UNKNOWN (never a false MATCH) when the comparison cannot be made -- for example
 * when the caller lacks permission to list providers, or the pool contains no other
 * provider to compare against.
 */
export function evaluateSubjectMapping(
  providers: ProviderSubjectMapping[],
  migrationProviderId: string
): SubjectMappingPreflightResult {
  const migrationProvider = providers.find((p) => p.providerId === migrationProviderId);
  const otherProviders = providers.filter((p) => p.providerId !== migrationProviderId);

  if (!migrationProvider) {
    return {
      verdict: 'UNKNOWN',
      summary:
        `Provider "${migrationProviderId}" was not found in this pool, so its subject mapping could not be compared. ` +
        `Run the Step 1 setup commands to create it.`,
      otherProviders
    };
  }

  if (otherProviders.length === 0) {
    return {
      verdict: 'UNKNOWN',
      summary:
        `Pool contains only "${migrationProviderId}". There is no production provider to compare against, so it is ` +
        `not possible to confirm that migrated identities will match your existing IAM bindings.`,
      migrationProvider,
      otherProviders
    };
  }

  const mismatched = otherProviders.filter(
    (p) => p.googleSubject && migrationProvider.googleSubject && p.googleSubject !== migrationProvider.googleSubject
  );
  const comparable = otherProviders.filter((p) => p.googleSubject && migrationProvider.googleSubject);

  if (comparable.length === 0) {
    return {
      verdict: 'UNKNOWN',
      summary:
        `Could not read a "google.subject" attribute mapping for the providers in this pool, so subject equivalence ` +
        `could not be verified.`,
      migrationProvider,
      otherProviders
    };
  }

  if (mismatched.length > 0) {
    const detail = mismatched
      .map((p) => `  - ${p.providerId}: google.subject = ${p.googleSubject}`)
      .join('\n');

    // Distinguish a fixable expression difference from a genuinely unreachable subject.
    const emailBased = mismatched.filter((p) => isEmailDerivedMapping(p.googleSubject!));
    const opaque = mismatched.filter((p) => !isEmailDerivedMapping(p.googleSubject!));

    const advice: string[] = [];
    if (emailBased.length > 0) {
      const target = emailBased[0].googleSubject!;
      advice.push(
        `Provider(s) ${emailBased.map((p) => `"${p.providerId}"`).join(', ')} derive the subject from the user's ` +
          `email. The tool signs the email as both "sub" and "email", so this IS fixable: align the migration ` +
          `provider to the same expression.`
      );
      advice.push(
        `  gcloud iam workforce-pools providers update-oidc ${migrationProviderId} \\\n` +
          `    --workforce-pool=<POOL> --location=global \\\n` +
          `    --attribute-mapping="google.subject=${target},attribute.user_email=assertion.email"`
      );
      if (/lowerAscii\(\)/.test(target) && !/lowerAscii\(\)/.test(migrationProvider.googleSubject!)) {
        advice.push(
          `Note the .lowerAscii() call. Without it, users whose address contains uppercase letters ` +
            `(for example "First.Last@example.com") resolve to a different principal than their real identity and ` +
            `are denied, while users with all-lowercase addresses succeed. That produces a confusing ` +
            `"works for some users, fails for others" pattern.`
        );
      }
    }
    if (opaque.length > 0) {
      advice.push(
        `Provider(s) ${opaque.map((p) => `"${p.providerId}"`).join(', ')} map the subject to an identifier that is ` +
          `not derived from the email. The tool can only sign the email, so it cannot reproduce that subject: ` +
          `impersonation through this pool will not inherit those users' permissions.`
      );
    }

    return {
      verdict: 'MISMATCH',
      summary:
        `Subject mapping mismatch. "${migrationProviderId}" maps google.subject = ${migrationProvider.googleSubject}, ` +
        `but the following provider(s) in the same pool map it differently:\n${detail}\n` +
        `IAM bindings are granted to principal://.../workforcePools/<POOL>/subject/<SUBJECT> and do NOT name a ` +
        `provider, so a token minted by the migration provider only inherits a user's access when it resolves to ` +
        `the identical subject string.\n${advice.join('\n')}`,
      migrationProvider,
      otherProviders
    };
  }

  return {
    verdict: 'MATCH',
    summary:
      `"${migrationProviderId}" maps google.subject = ${migrationProvider.googleSubject}, matching the other ` +
      `provider(s) in this pool. Minted tokens should resolve to the same principal as your users' real identities.`,
    migrationProvider,
    otherProviders
  };
}

/**
 * Runs the preflight against live GCP. Read-only: performs a single `providers list`.
 */
export async function checkSubjectMapping(
  audience: string,
  migrationProviderId: string = 'migration-dwd-provider'
): Promise<SubjectMappingPreflightResult> {
  let poolId: string;
  try {
    poolId = workforcePoolIdFromAudience(audience);
    workforceResourceFromAudience(audience);
  } catch (err: any) {
    return {
      verdict: 'UNKNOWN',
      summary: 'Could not determine the workforce pool from the configured audience.',
      otherProviders: [],
      error: err.message
    };
  }

  try {
    const { stdout } = await execFileAsync('gcloud', [
      'iam',
      'workforce-pools',
      'providers',
      'list',
      `--workforce-pool=${poolId}`,
      '--location=global',
      '--format=json'
    ]);
    const providers = parseProviders(stdout);
    return { ...evaluateSubjectMapping(providers, migrationProviderId), poolId };
  } catch (err: any) {
    // Surface the reason; never report a MATCH we could not establish.
    const detail = (err?.stderr || err?.message || String(err)).toString().trim().slice(0, 600);
    logger.warn(`Workforce subject-mapping preflight could not run for pool "${poolId}": ${detail}`);
    return {
      verdict: 'UNKNOWN',
      summary:
        `Could not list providers in pool "${poolId}", so subject equivalence was not verified. ` +
        `This check needs roles/iam.workforcePoolViewer on the pool's organization.`,
      otherProviders: [],
      error: detail,
      poolId
    };
  }
}
