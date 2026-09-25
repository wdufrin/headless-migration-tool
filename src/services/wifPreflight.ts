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
  googleGroups?: string;
  userEmailAttribute?: string;
  attributeMapping?: Record<string, string>;
  attributeCondition?: string;
  providerType?: 'OIDC' | 'SAML' | 'UNKNOWN';
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
  return (
    /^assertion\.(email|subject|sub|upn|preferred_username)(\.lowerAscii\(\))?(\.split\(['"]@['"]\)\[0\])?$/.test(expr) ||
    /^assertion\.(email|subject|sub|upn|preferred_username)\.split\(['"]@['"]\)\[0\](\.lowerAscii\(\))?$/.test(expr) ||
    /^assertion\.attributes\.(email|mail|upn|uid|samAccountName)\[0\](\.lowerAscii\(\))?$/.test(expr)
  );
}

/**
 * Classifies an email-derived CEL expression into its runtime output shape when
 * minted by GcpAuthService.mintWorkforceToken (which signs the user's email into
 * sub, subject, email, upn, and preferred_username).
 */
export function canonicalEmailSubjectKind(
  expression: string
): 'LOWER_EMAIL' | 'RAW_EMAIL' | 'LOWER_SHORT_USER' | 'RAW_SHORT_USER' | 'NON_EMAIL' {
  const expr = (expression || '').trim();
  if (!isEmailDerivedMapping(expr)) return 'NON_EMAIL';
  const isShort = /uid|samaccountname|split\(['"]@['"]\)/i.test(expr);
  const isLower = /lowerAscii\(\)/.test(expr);
  if (isShort) return isLower ? 'LOWER_SHORT_USER' : 'RAW_SHORT_USER';
  return isLower ? 'LOWER_EMAIL' : 'RAW_EMAIL';
}

/**
 * True when two email-derived google.subject expressions evaluate to the exact same
 * runtime subject string (e.g. OIDC `assertion.email.lowerAscii()` and SAML
 * `assertion.subject.lowerAscii()` both produce the lowercase email address).
 */
export function areEmailMappingsSemanticallyAligned(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  if (a.trim() === b.trim()) return true;
  const kindA = canonicalEmailSubjectKind(a);
  const kindB = canonicalEmailSubjectKind(b);
  return kindA !== 'NON_EMAIL' && kindA === kindB;
}

export interface AlignedMigrationMappingPlan {
  /** Full --attribute-mapping value to pass to gcloud create-oidc / update-oidc */
  attributeMappingString: string;
  /** The specific google.subject expression chosen for migration-dwd-provider */
  targetGoogleSubject: string;
  /** The specific google.groups expression chosen */
  targetGoogleGroups: string;
  /** The production provider(s) discovered in the pool */
  productionProviders: ProviderSubjectMapping[];
  /** The primary production provider used as the reference template */
  referenceProvider?: ProviderSubjectMapping;
  /** Current migration provider in the pool, if already registered */
  migrationProvider?: ProviderSubjectMapping;
  /** True if migration-dwd-provider already exists and its google.subject matches */
  isAligned: boolean;
  /** True if the production provider uses an opaque non-email subject (e.g. assertion.oid / assertion.oktaUserId) */
  isOpaqueSubject: boolean;
  /** Human-readable explanation of how the mapping was aligned (or why it needs attention) */
  explanation: string;
}

export interface GeAppWorkforceInspection {
  detectedPoolId?: string;
  detectedFrom?: 'ACL_CONFIG' | 'PROJECT_IAM_POLICY' | 'WIF_CONFIG' | 'MANUAL';
  idpType?: 'GSUITE' | 'THIRD_PARTY' | 'UNKNOWN';
  aclConfigRaw?: {
    source?: { projectId: string; idpType?: string; workforcePoolName?: string; poolId?: string };
    target?: { projectId: string; idpType?: string; workforcePoolName?: string; poolId?: string };
  };
  discoveredIamGroups: string[];
  discoveredSampleSubjects: string[];
  hasPoolWideDiscoveryRole: boolean;
  alignmentPlan: AlignedMigrationMappingPlan;
}

// Cache discovered Workforce Pool IAM groups per pool ID so mintWorkforceToken can include them in assertion.groups
const discoveredPoolGroupsCache: Map<string, string[]> = new Map();

export function getDiscoveredPoolGroups(poolId?: string): string[] {
  if (poolId) {
    return discoveredPoolGroupsCache.get(poolId) || [];
  }
  // If no poolId was provided but only one pool has been discovered, safely use that pool
  if (discoveredPoolGroupsCache.size === 1) {
    return Array.from(discoveredPoolGroupsCache.values())[0] || [];
  }
  return [];
}

export function registerDiscoveredPoolGroups(poolId: string, groups: string[]): void {
  if (!poolId || !Array.isArray(groups) || groups.length === 0) return;
  const existing = new Set(discoveredPoolGroupsCache.get(poolId) || []);
  for (const g of groups) {
    if (g && typeof g === 'string') existing.add(g.trim());
  }
  discoveredPoolGroupsCache.set(poolId, Array.from(existing));
}

/**
 * Given the providers in a Workforce Identity Pool, inspects the production provider(s)
 * used by the Gemini Enterprise app and derives the exact `--attribute-mapping` string
 * that `migration-dwd-provider` needs so its minted tokens resolve to the identical
 * `google.subject` and `google.groups` principals.
 */
export function deriveAlignedMigrationAttributeMapping(
  providers: ProviderSubjectMapping[],
  migrationProviderId: string = 'migration-dwd-provider'
): AlignedMigrationMappingPlan {
  const migrationProvider = providers.find(
    (p) => p.providerId.toLowerCase() === migrationProviderId.toLowerCase()
  );
  const productionProviders = providers.filter(
    (p) =>
      p.providerId.toLowerCase() !== migrationProviderId.toLowerCase() &&
      !p.providerId.toLowerCase().includes('migration-dwd') &&
      !(p.issuerUri && p.issuerUri.includes('gemini-migration.internal'))
  );

  // Choose the most authoritative production provider:
  // 1. Prefer active providers with a defined googleSubject that includes .lowerAscii() (strictest canonical form)
  // 2. Otherwise the first active provider with a defined googleSubject
  const withSubject = productionProviders.filter((p) => Boolean(p.googleSubject?.trim()));
  const referenceProvider =
    withSubject.find((p) => /lowerAscii\(\)/.test(p.googleSubject!)) ||
    withSubject[0] ||
    productionProviders[0];

  const targetGoogleGroups = 'assertion.groups';

  if (!referenceProvider || !referenceProvider.googleSubject) {
    const fallbackSubject = migrationProvider?.googleSubject || 'assertion.sub';
    const attributeMappingString = `google.subject=${fallbackSubject},google.groups=${targetGoogleGroups},attribute.user_email=assertion.email`;
    return {
      attributeMappingString,
      targetGoogleSubject: fallbackSubject,
      targetGoogleGroups,
      productionProviders,
      referenceProvider,
      migrationProvider,
      isAligned: Boolean(migrationProvider?.googleSubject === fallbackSubject),
      isOpaqueSubject: false,
      explanation:
        productionProviders.length === 0
          ? `No separate production IdP provider was found in this pool. Using default mapping "${attributeMappingString}".`
          : `Could not read "google.subject" from production provider "${referenceProvider?.providerId}". Using "${attributeMappingString}".`
    };
  }

  const rawRefExpr = referenceProvider.googleSubject.trim();
  let targetGoogleSubject = rawRefExpr;
  let isOpaqueSubject = false;

  // Determine the optimal OIDC google.subject expression for migration-dwd-provider
  // Note: GcpAuthService.mintWorkforceToken signs sub, subject, email, upn, preferred_username, uid, samAccountName
  if (/^assertion\.attributes\./.test(rawRefExpr)) {
    // SAML attribute array syntax (e.g. assertion.attributes.email[0].lowerAscii()) must be translated
    // to top-level OIDC JWT claim syntax so `gcloud iam workforce-pools providers create-oidc` accepts it.
    const isShortUser = /uid|samaccountname|login|split\(['"]@['"]\)/i.test(rawRefExpr);
    const hasLower = /lowerAscii\(\)/.test(rawRefExpr);
    if (isShortUser) {
      targetGoogleSubject = hasLower ? "assertion.sub.lowerAscii().split('@')[0]" : "assertion.sub.split('@')[0]";
    } else {
      targetGoogleSubject = hasLower ? 'assertion.email.lowerAscii()' : 'assertion.email';
    }
  } else if (!isEmailDerivedMapping(rawRefExpr) && !/^assertion\.(uid|samAccountName)(\.lowerAscii\(\))?$/.test(rawRefExpr)) {
    isOpaqueSubject = true;
    // Keep the exact claim name if it's a simple assertion.<claim> so if the user maps opaque IDs in CSV, STS still resolves it
    if (/^assertion\.[a-zA-Z0-9_]+(\.lowerAscii\(\))?$/.test(rawRefExpr)) {
      targetGoogleSubject = rawRefExpr;
    } else {
      targetGoogleSubject = 'assertion.sub';
    }
  }

  const attributeMappingString = `google.subject=${targetGoogleSubject},google.groups=${targetGoogleGroups},attribute.user_email=assertion.email`;

  const currentMigSubject = migrationProvider?.googleSubject?.trim();
  const isAligned = Boolean(
    currentMigSubject &&
      (currentMigSubject === targetGoogleSubject ||
        currentMigSubject === rawRefExpr ||
        areEmailMappingsSemanticallyAligned(currentMigSubject, targetGoogleSubject))
  );

  let explanation = '';
  if (isOpaqueSubject) {
    explanation =
      `Production provider "${referenceProvider.providerId}" maps google.subject = ${rawRefExpr}, which is an opaque IdP identifier ` +
      `(not derived from email). To impersonate users in this pool, either align the provider mapping or upload an Identity Mapping CSV ` +
      `that maps each user's opaque IdP ID to their email.`;
  } else if (isAligned) {
    explanation =
      `Migration provider "${migrationProviderId}" is aligned with GE App production provider "${referenceProvider.providerId}" ` +
      `(google.subject = ${targetGoogleSubject}).`;
  } else if (migrationProvider) {
    explanation =
      `Mismatch detected: GE App production provider "${referenceProvider.providerId}" maps google.subject = ${rawRefExpr}, ` +
      `while "${migrationProviderId}" currently maps google.subject = ${currentMigSubject || '(unset)'}. ` +
      `Update "${migrationProviderId}" to use "${attributeMappingString}" so impersonated tokens match user IAM bindings.`;
  } else {
    explanation =
      `Auto-aligned with GE App production provider "${referenceProvider.providerId}" (google.subject = ${rawRefExpr}). ` +
      `When registering "${migrationProviderId}", use --attribute-mapping="${attributeMappingString}".`;
  }

  return {
    attributeMappingString,
    targetGoogleSubject,
    targetGoogleGroups,
    productionProviders,
    referenceProvider,
    migrationProvider,
    isAligned,
    isOpaqueSubject,
    explanation
  };
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
  /** Recommended attribute mapping string aligned to the pool's production provider */
  recommendedAttributeMapping?: string;
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
      googleGroups: p?.attributeMapping?.['google.groups'],
      userEmailAttribute: p?.attributeMapping?.['attribute.user_email'],
      attributeMapping: p?.attributeMapping,
      attributeCondition: p?.attributeCondition,
      providerType: p?.oidc ? 'OIDC' : p?.saml ? 'SAML' : 'UNKNOWN',
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
  const plan = deriveAlignedMigrationAttributeMapping(providers, migrationProviderId);

  if (!migrationProvider) {
    return {
      verdict: 'UNKNOWN',
      summary:
        `Provider "${migrationProviderId}" was not found in this pool, so its subject mapping could not be compared. ` +
        `Run the Step 1 setup commands to create it with --attribute-mapping="${plan.attributeMappingString}".`,
      otherProviders,
      recommendedAttributeMapping: plan.attributeMappingString
    };
  }

  if (otherProviders.length === 0) {
    return {
      verdict: 'UNKNOWN',
      summary:
        `Pool contains only "${migrationProviderId}". There is no production provider to compare against, so it is ` +
        `not possible to confirm that migrated identities will match your existing IAM bindings.`,
      migrationProvider,
      otherProviders,
      recommendedAttributeMapping: plan.attributeMappingString
    };
  }

  const migSubject = migrationProvider.googleSubject;
  const migKind = canonicalEmailSubjectKind(migSubject || '');
  const mismatched = otherProviders.filter((p) => {
    if (!p.googleSubject || !migSubject) return false;
    if (p.googleSubject === migSubject) return false;
    if (areEmailMappingsSemanticallyAligned(p.googleSubject, migSubject)) return false;
    // If migration-dwd-provider is already aligned with the pool's canonical lowercase-email
    // reference provider (e.g. `assertion.email.lowerAscii()`), do not fail the pool just
    // because a secondary email-based provider in the same pool (e.g. `okta-spa-provider2`)
    // uses `assertion.sub` without `.lowerAscii()`.
    if (plan.isAligned && migKind === 'LOWER_EMAIL' && canonicalEmailSubjectKind(p.googleSubject) === 'RAW_EMAIL') {
      return false;
    }
    return true;
  });
  const comparable = otherProviders.filter((p) => p.googleSubject && migrationProvider.googleSubject);

  if (comparable.length === 0) {
    return {
      verdict: 'UNKNOWN',
      summary:
        `Could not read a "google.subject" attribute mapping for the providers in this pool, so subject equivalence ` +
        `could not be verified.`,
      migrationProvider,
      otherProviders,
      recommendedAttributeMapping: plan.attributeMappingString
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
          `    --attribute-mapping="google.subject=${target},google.groups=assertion.groups,attribute.user_email=assertion.email"`
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
      otherProviders,
      recommendedAttributeMapping: plan.attributeMappingString
    };
  }

  return {
    verdict: 'MATCH',
    summary:
      `"${migrationProviderId}" maps google.subject = ${migrationProvider.googleSubject}, matching the other ` +
      `provider(s) in this pool. Minted tokens should resolve to the same principal as your users' real identities.`,
    migrationProvider,
    otherProviders,
    recommendedAttributeMapping: plan.attributeMappingString
  };
}

/**
 * Lists providers in a Workforce Pool via gcloud CLI with fallback to IAM REST API.
 */
export async function listPoolProviders(
  poolId: string,
  location: string = 'global',
  bearerToken?: string | null
): Promise<{ providers: ProviderSubjectMapping[]; rawProviders: any[]; error?: string }> {
  if (!poolId) {
    return { providers: [], rawProviders: [] };
  }
  try {
    const { stdout } = await execFileAsync('gcloud', [
      'iam',
      'workforce-pools',
      'providers',
      'list',
      `--workforce-pool=${poolId}`,
      `--location=${location}`,
      '--format=json'
    ]);
    const rawProviders = JSON.parse(stdout || '[]');
    return {
      providers: parseProviders(stdout || '[]'),
      rawProviders: Array.isArray(rawProviders) ? rawProviders : []
    };
  } catch (cliErr: any) {
    if (bearerToken) {
      try {
        const res = await fetch(
          `https://iam.googleapis.com/v1/locations/${encodeURIComponent(location)}/workforcePools/${encodeURIComponent(poolId)}/providers`,
          { headers: { Authorization: `Bearer ${bearerToken}` } }
        );
        if (res.ok) {
          const data: any = await res.json();
          const list = Array.isArray(data.workforcePoolProviders) ? data.workforcePoolProviders : [];
          return {
            providers: parseProviders(JSON.stringify(list)),
            rawProviders: list
          };
        }
      } catch (restErr: any) {
        logger.debug(`IAM REST fallback for workforce pool providers failed: ${restErr.message}`);
      }
    }
    const detail = (cliErr?.stderr || cliErr?.message || String(cliErr)).toString().trim().slice(0, 600);
    return { providers: [], rawProviders: [], error: detail };
  }
}

/**
 * Inspects the Gemini Enterprise (Discovery Engine) project's `aclConfig` and project IAM bindings
 * to discover the exact Workforce Pool (`workforcePoolName`), production IdP provider, `google.subject`
 * expression, and group-based IAM bindings (`principalSet://.../group/...`) used by the GE app.
 */
export async function inspectGeAppWorkforceConfig(options: {
  sourceProjectId?: string;
  sourceLocation?: string;
  targetProjectId?: string;
  targetLocation?: string;
  poolId?: string;
  migrationProviderId?: string;
  bearerToken?: string | null;
}): Promise<GeAppWorkforceInspection> {
  const migrationProviderId = options.migrationProviderId || 'migration-dwd-provider';
  const token = options.bearerToken || null;
  let detectedPoolId = options.poolId?.trim() || '';
  let detectedFrom: GeAppWorkforceInspection['detectedFrom'] = detectedPoolId ? 'MANUAL' : undefined;
  let idpType: GeAppWorkforceInspection['idpType'] = 'UNKNOWN';

  const aclConfigRaw: GeAppWorkforceInspection['aclConfigRaw'] = {};
  const discoveredIamGroups = new Set<string>();
  const discoveredSampleSubjects = new Set<string>();
  let hasPoolWideDiscoveryRole = false;

  const fetchProjectAclConfig = async (projectId: string, location: string = 'global') => {
    if (!projectId || !token) return null;
    const prefix = location === 'eu' || location === 'us' ? `${location}-` : '';
    const url = `https://${prefix}discoveryengine.googleapis.com/v1alpha/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/aclConfig`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Goog-User-Project': projectId
        }
      });
      if (res.ok) {
        const data: any = await res.json();
        const type = data?.idpConfig?.idpType;
        const wfPoolName: string = data?.idpConfig?.externalIdpConfig?.workforcePoolName || '';
        const extractedPool = wfPoolName.split('/workforcePools/')[1]?.split('/')[0] || '';
        return { projectId, idpType: type, workforcePoolName: wfPoolName, poolId: extractedPool };
      }
    } catch (err: any) {
      logger.debug(`Could not read Discovery Engine aclConfig for ${projectId}: ${err.message}`);
    }
    return null;
  };

  if (options.sourceProjectId) {
    const srcAcl = await fetchProjectAclConfig(options.sourceProjectId, options.sourceLocation || 'global');
    if (srcAcl) {
      aclConfigRaw.source = srcAcl;
      if (srcAcl.idpType) idpType = srcAcl.idpType;
      if (srcAcl.poolId && !detectedPoolId) {
        detectedPoolId = srcAcl.poolId;
        detectedFrom = 'ACL_CONFIG';
      }
    }
  }

  if (options.targetProjectId && options.targetProjectId !== options.sourceProjectId) {
    const tgtAcl = await fetchProjectAclConfig(options.targetProjectId, options.targetLocation || 'global');
    if (tgtAcl) {
      aclConfigRaw.target = tgtAcl;
      if (tgtAcl.idpType && idpType === 'UNKNOWN') idpType = tgtAcl.idpType;
      if (tgtAcl.poolId && !detectedPoolId) {
        detectedPoolId = tgtAcl.poolId;
        detectedFrom = 'ACL_CONFIG';
      }
    }
  }

  // Inspect project IAM policy to discover Workforce Pool ID, group bindings (google.groups), and sample subjects
  const projectsToInspect = Array.from(
    new Set([options.sourceProjectId, options.targetProjectId].filter((p): p is string => Boolean(p && p.trim())))
  );

  for (const proj of projectsToInspect) {
    try {
      let policy: any = null;
      if (token) {
        const res = await fetch(
          `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(proj)}:getIamPolicy`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          }
        );
        if (res.ok) {
          policy = await res.json();
        }
      }
      if (!policy) {
        const { stdout } = await execFileAsync('gcloud', [
          'projects',
          'get-iam-policy',
          proj,
          '--format=json'
        ]);
        policy = JSON.parse(stdout || '{}');
      }
      const ADMIN_DELETE_ROLES = new Set([
        'roles/discoveryengine.admin',
        'roles/discoveryengine.agentspaceadmin',
        'roles/discoveryengine.notebooklmowner',
        'roles/discoveryengine.notebookowner',
        'roles/owner',
        'roles/editor'
      ]);
      for (const binding of policy?.bindings || []) {
        const role: string = binding?.role || '';
        const lowerRole = role.toLowerCase().trim();
        const isDiscoveryRole =
          role.includes('discoveryengine') || role === 'roles/viewer' || role === 'roles/editor' || role === 'roles/owner';
        // Never inject groups bound to project-level admin/delete roles into end-user WIF tokens:
        // project-wide `discoveryengine.notebooks.delete` causes Google's GetNotebook handler
        // to classify the caller as PROJECT_ROLE_OWNER on colleagues' shared notebooks.
        const isSafeEndUserGroupRole = isDiscoveryRole && !ADMIN_DELETE_ROLES.has(lowerRole);
        for (const member of binding?.members || []) {
          if (typeof member !== 'string') continue;
          const poolMatch = member.match(/workforcePools\/([^/]+)/);
          if (poolMatch && poolMatch[1]) {
            const pId = poolMatch[1];
            if (!detectedPoolId) {
              detectedPoolId = pId;
              detectedFrom = 'PROJECT_IAM_POLICY';
              idpType = 'THIRD_PARTY';
            }
            if (!detectedPoolId || pId === detectedPoolId) {
              const groupMatch = member.match(/\/group\/(.+)$/);
              if (groupMatch && groupMatch[1] && isSafeEndUserGroupRole) {
                discoveredIamGroups.add(groupMatch[1]);
              }
              const subjMatch = member.match(/\/subject\/(.+)$/);
              if (subjMatch && subjMatch[1]) {
                discoveredSampleSubjects.add(subjMatch[1]);
              }
              if (member.endsWith(`/workforcePools/${pId}/*`) && role.includes('discoveryengine')) {
                hasPoolWideDiscoveryRole = true;
              }
            }
          }
        }
      }
    } catch (iamErr: any) {
      logger.debug(`Could not inspect IAM policy on project ${proj}: ${iamErr.message}`);
    }
  }

  if (detectedPoolId && discoveredIamGroups.size > 0) {
    registerDiscoveredPoolGroups(detectedPoolId, Array.from(discoveredIamGroups));
  }

  const { providers } = detectedPoolId
    ? await listPoolProviders(detectedPoolId, 'global', token)
    : { providers: [] as ProviderSubjectMapping[] };

  const alignmentPlan = deriveAlignedMigrationAttributeMapping(providers, migrationProviderId);

  return {
    detectedPoolId: detectedPoolId || undefined,
    detectedFrom,
    idpType,
    aclConfigRaw,
    discoveredIamGroups: Array.from(discoveredIamGroups),
    discoveredSampleSubjects: Array.from(discoveredSampleSubjects).slice(0, 10),
    hasPoolWideDiscoveryRole,
    alignmentPlan
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

