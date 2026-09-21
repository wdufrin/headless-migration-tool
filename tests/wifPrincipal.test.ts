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
  buildWorkforcePrincipal,
  buildWorkforcePrincipalSet,
  workforcePoolIdFromAudience,
  workforceResourceFromAudience,
  InvalidWorkforceAudienceError
} from '../src/utils/wifPrincipal.js';
import {
  parseProviders,
  evaluateSubjectMapping,
  isEmailDerivedMapping,
  deriveAlignedMigrationAttributeMapping,
  inspectGeAppWorkforceConfig,
  getDiscoveredPoolGroups
} from '../src/services/wifPreflight.js';

const AUDIENCE =
  '//iam.googleapis.com/locations/global/workforcePools/wdufrin-okta/providers/migration-dwd-provider';

describe('Workforce IAM principal construction', () => {
  /**
   * Ground truth, confirmed two independent ways:
   *  1. https://cloud.google.com/iam/docs/workforce-identity-federation lists the valid
   *     principal forms; none contains a "/providers/" segment.
   *  2. The live IAM policy on testgebackupandrestorev3 contains three workforce bindings,
   *     none of which contains "/providers/".
   */
  it('omits the provider segment, which is not part of a workforce principal', () => {
    const principal = buildWorkforcePrincipal(AUDIENCE, 'will@wdufrin.altostrat.com');

    expect(principal).toBe(
      'principal://iam.googleapis.com/locations/global/workforcePools/wdufrin-okta/subject/will@wdufrin.altostrat.com'
    );
    // The precise regression: appending to the raw audience left the provider in place,
    // producing an identifier gcloud rejects.
    expect(principal).not.toContain('/providers/');
    expect(principal).not.toContain('migration-dwd-provider');
  });

  it('builds the pool-wide principalSet without a provider segment', () => {
    expect(buildWorkforcePrincipalSet(AUDIENCE)).toBe(
      'principalSet://iam.googleapis.com/locations/global/workforcePools/wdufrin-okta/*'
    );
  });

  it('extracts the pool id', () => {
    expect(workforcePoolIdFromAudience(AUDIENCE)).toBe('wdufrin-okta');
  });

  it('accepts an audience that already lacks a provider segment', () => {
    const bare = '//iam.googleapis.com/locations/global/workforcePools/wdufrin-okta';
    expect(workforceResourceFromAudience(bare)).toBe(
      'iam.googleapis.com/locations/global/workforcePools/wdufrin-okta'
    );
  });

  it('handles the project-scoped audience form', () => {
    const scoped =
      '//iam.googleapis.com/projects/12345/locations/global/workforcePools/pool-a/providers/prov-b';
    expect(buildWorkforcePrincipal(scoped, 'u@example.com')).toBe(
      'principal://iam.googleapis.com/projects/12345/locations/global/workforcePools/pool-a/subject/u@example.com'
    );
  });

  // ---- Negative cases: must throw rather than emit a plausible-but-broken identifier ----

  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['a workload identity audience', '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x'],
    ['a random URL', 'https://example.com/foo'],
    ['a pool path with an extra segment', '//iam.googleapis.com/locations/global/workforcePools/a/b']
  ])('throws on %s', (_label, audience) => {
    expect(() => buildWorkforcePrincipal(audience as string, 'u@example.com')).toThrow(
      InvalidWorkforceAudienceError
    );
  });

  it('throws when the subject is empty rather than emitting a dangling /subject/', () => {
    expect(() => buildWorkforcePrincipal(AUDIENCE, '   ')).toThrow(InvalidWorkforceAudienceError);
  });
});

describe('Workforce subject-mapping preflight', () => {
  const MIGRATION = 'migration-dwd-provider';

  function provider(id: string, googleSubject?: string) {
    return {
      name: `locations/global/workforcePools/pool-x/providers/${id}`,
      displayName: id,
      ...(googleSubject ? { attributeMapping: { 'google.subject': googleSubject } } : {})
    };
  }

  it('parses provider ids and google.subject mappings from gcloud JSON', () => {
    const parsed = parseProviders(
      JSON.stringify([provider('okta-prod', 'assertion.sub'), provider(MIGRATION, 'assertion.sub')])
    );
    expect(parsed.map((p) => p.providerId)).toEqual(['okta-prod', MIGRATION]);
    expect(parsed[0].googleSubject).toBe('assertion.sub');
  });

  it.each([
    ['malformed JSON', 'not json at all'],
    ['a JSON object instead of an array', '{"name":"x"}']
  ])('throws on %s rather than returning an empty list', (_label, payload) => {
    expect(() => parseProviders(payload as string)).toThrow();
  });

  it('flags MISMATCH when the production provider maps a different subject', () => {
    // The suspected structural cause of the customer failure: Okta maps google.subject to
    // its opaque user id, while the tool can only ever sign the user's email as `sub`.
    const providers = parseProviders(
      JSON.stringify([
        provider('okta-prod', 'assertion.oktaUserId'),
        provider(MIGRATION, 'assertion.sub')
      ])
    );
    const result = evaluateSubjectMapping(providers, MIGRATION);

    expect(result.verdict).toBe('MISMATCH');
    expect(result.summary).toContain('okta-prod');
    expect(result.summary).toContain('assertion.oktaUserId');
  });

  it('reports MATCH when both providers map google.subject identically', () => {
    const providers = parseProviders(
      JSON.stringify([provider('okta-prod', 'assertion.sub'), provider(MIGRATION, 'assertion.sub')])
    );
    expect(evaluateSubjectMapping(providers, MIGRATION).verdict).toBe('MATCH');
  });

  it('reports UNKNOWN, never MATCH, when the migration provider is absent', () => {
    const providers = parseProviders(JSON.stringify([provider('okta-prod', 'assertion.sub')]));
    const result = evaluateSubjectMapping(providers, MIGRATION);

    expect(result.verdict).toBe('UNKNOWN');
    expect(result.summary).toMatch(/not found/i);
  });

  it('reports UNKNOWN when there is no other provider to compare against', () => {
    const providers = parseProviders(JSON.stringify([provider(MIGRATION, 'assertion.sub')]));
    const result = evaluateSubjectMapping(providers, MIGRATION);

    expect(result.verdict).toBe('UNKNOWN');
    expect(result.summary).toMatch(/no production provider/i);
  });

  it('reports UNKNOWN when google.subject mappings cannot be read', () => {
    const providers = parseProviders(
      JSON.stringify([provider('okta-prod'), provider(MIGRATION)])
    );
    expect(evaluateSubjectMapping(providers, MIGRATION).verdict).toBe('UNKNOWN');
  });

  it('never returns MATCH for any input where a mismatch exists', () => {
    // Property-style guard: with three providers, a single divergent mapping must not be
    // averaged away into a MATCH.
    const providers = parseProviders(
      JSON.stringify([
        provider('okta-prod', 'assertion.sub'),
        provider('entra-prod', 'assertion.oid'),
        provider(MIGRATION, 'assertion.sub')
      ])
    );
    const result = evaluateSubjectMapping(providers, MIGRATION);

    expect(result.verdict).toBe('MISMATCH');
    expect(result.summary).toContain('entra-prod');
  });
});

describe('Email-derived subject mapping classifier', () => {
  it.each([
    'assertion.email',
    'assertion.email.lowerAscii()',
    'assertion.subject',
    'assertion.subject.lowerAscii()',
    'assertion.sub',
    'assertion.sub.lowerAscii()'
  ])('treats %s as reproducible from the signed email', (expr) => {
    expect(isEmailDerivedMapping(expr)).toBe(true);
  });

  it.each([
    'assertion.oid',
    'assertion.oktaUserId',
    'assertion.attributes["uid"]',
    'assertion.sub + "@example.com"',
    ''
  ])('treats %s as an opaque identifier the tool cannot reproduce', (expr) => {
    expect(isEmailDerivedMapping(expr)).toBe(false);
  });
});

describe('Real wdufrin-okta pool configuration', () => {
  /**
   * Captured live on 2026-09-18 via:
   *   gcloud iam workforce-pools providers list --workforce-pool=wdufrin-okta --location=global
   *
   * This is the configuration that produces the customer-visible symptom, because the tool
   * signs `sub: <email>` with the ORIGINAL casing while production lowercases it.
   */
  const REAL_POOL = JSON.stringify([
    { name: 'locations/global/workforcePools/wdufrin-okta/providers/migration-dwd-provider',
      attributeMapping: { 'google.subject': 'assertion.sub' } },
    { name: 'locations/global/workforcePools/wdufrin-okta/providers/oidc-okta',
      attributeMapping: { 'google.subject': 'assertion.email.lowerAscii()' } },
    { name: 'locations/global/workforcePools/wdufrin-okta/providers/okta-saml',
      attributeMapping: { 'google.subject': 'assertion.subject.lowerAscii()' } },
    { name: 'locations/global/workforcePools/wdufrin-okta/providers/okta-spa-provider',
      attributeMapping: { 'google.subject': 'assertion.email.lowerAscii()' } },
    { name: 'locations/global/workforcePools/wdufrin-okta/providers/okta-spa-provider2',
      attributeMapping: { 'google.subject': 'assertion.sub' } }
  ]);

  it('detects the mismatch against the lowercasing production providers', () => {
    const result = evaluateSubjectMapping(parseProviders(REAL_POOL), 'migration-dwd-provider');

    expect(result.verdict).toBe('MISMATCH');
    expect(result.summary).toContain('oidc-okta');
    expect(result.summary).toContain('okta-saml');
  });

  it('explains the case-sensitivity trap rather than calling it unfixable', () => {
    const result = evaluateSubjectMapping(parseProviders(REAL_POOL), 'migration-dwd-provider');

    // The failure mode operators actually observe: some users work, others do not.
    expect(result.summary).toMatch(/lowerAscii/);
    expect(result.summary).toMatch(/uppercase/i);
    expect(result.summary).toMatch(/IS fixable/i);
    expect(result.summary).not.toMatch(/cannot be corrected by configuration alone/i);
  });

  it('emits a concrete gcloud command to align the mapping', () => {
    const result = evaluateSubjectMapping(parseProviders(REAL_POOL), 'migration-dwd-provider');

    expect(result.summary).toContain('workforce-pools providers update-oidc migration-dwd-provider');
    expect(result.summary).toContain('google.subject=assertion.email.lowerAscii()');
  });

  it('does not flag a pool whose migration provider already matches', () => {
    const aligned = JSON.stringify([
      { name: 'locations/global/workforcePools/p/providers/migration-dwd-provider',
        attributeMapping: { 'google.subject': 'assertion.email.lowerAscii()' } },
      { name: 'locations/global/workforcePools/p/providers/oidc-okta',
        attributeMapping: { 'google.subject': 'assertion.email.lowerAscii()' } }
    ]);
    expect(evaluateSubjectMapping(parseProviders(aligned), 'migration-dwd-provider').verdict).toBe('MATCH');
  });

  it('returns MATCH on the full 5-provider wdufrin-okta pool once migration-dwd-provider is updated to assertion.email.lowerAscii()', () => {
    const alignedFullPool = JSON.stringify([
      { name: 'locations/global/workforcePools/wdufrin-okta/providers/migration-dwd-provider',
        attributeMapping: { 'google.subject': 'assertion.email.lowerAscii()' } },
      { name: 'locations/global/workforcePools/wdufrin-okta/providers/oidc-okta',
        attributeMapping: { 'google.subject': 'assertion.email.lowerAscii()' } },
      { name: 'locations/global/workforcePools/wdufrin-okta/providers/okta-saml',
        attributeMapping: { 'google.subject': 'assertion.subject.lowerAscii()' } },
      { name: 'locations/global/workforcePools/wdufrin-okta/providers/okta-spa-provider',
        attributeMapping: { 'google.subject': 'assertion.email.lowerAscii()' } },
      { name: 'locations/global/workforcePools/wdufrin-okta/providers/okta-spa-provider2',
        attributeMapping: { 'google.subject': 'assertion.sub' } }
    ]);
    const res = evaluateSubjectMapping(parseProviders(alignedFullPool), 'migration-dwd-provider');
    expect(res.verdict).toBe('MATCH');
  });

  it('derives the aligned attribute-mapping from the GE App production provider (including google.groups)', () => {
    const plan = deriveAlignedMigrationAttributeMapping(parseProviders(REAL_POOL), 'migration-dwd-provider');
    expect(plan.referenceProvider?.providerId).toBe('oidc-okta');
    expect(plan.targetGoogleSubject).toBe('assertion.email.lowerAscii()');
    expect(plan.attributeMappingString).toBe(
      'google.subject=assertion.email.lowerAscii(),google.groups=assertion.groups,attribute.user_email=assertion.email'
    );
    expect(plan.isAligned).toBe(false);
    expect(plan.isOpaqueSubject).toBe(false);
  });

  it('translates SAML assertion.attributes expressions into valid OIDC claim expressions', () => {
    const samlPool = parseProviders(
      JSON.stringify([
        {
          name: 'locations/global/workforcePools/gea-pool/providers/gea-saml-sso',
          saml: { idpMetadataXml: '<xml/>' },
          attributeMapping: { 'google.subject': 'assertion.attributes.email[0].lowerAscii()' }
        }
      ])
    );
    const plan = deriveAlignedMigrationAttributeMapping(samlPool, 'migration-dwd-provider');
    expect(plan.targetGoogleSubject).toBe('assertion.email.lowerAscii()');
    expect(plan.attributeMappingString).toBe(
      'google.subject=assertion.email.lowerAscii(),google.groups=assertion.groups,attribute.user_email=assertion.email'
    );
    expect(plan.isOpaqueSubject).toBe(false);
  });

  it('flags opaque non-email google.subject mappings (e.g. assertion.oid) as isOpaqueSubject=true', () => {
    const entraGuidPool = parseProviders(
      JSON.stringify([
        {
          name: 'locations/global/workforcePools/entra-pool/providers/entra-oidc',
          oidc: { issuerUri: 'https://login.microsoftonline.com/tenant/v2.0' },
          attributeMapping: { 'google.subject': 'assertion.oid' }
        }
      ])
    );
    const plan = deriveAlignedMigrationAttributeMapping(entraGuidPool, 'migration-dwd-provider');
    expect(plan.isOpaqueSubject).toBe(true);
    expect(plan.explanation).toMatch(/opaque IdP identifier/i);
  });

  it('discovers GE App Workforce Pool from aclConfig and extracts group bindings from IAM policy', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: any) => {
        const u = String(url);
        if (u.includes('/aclConfig')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              idpConfig: {
                idpType: 'THIRD_PARTY',
                externalIdpConfig: {
                  workforcePoolName: 'locations/global/workforcePools/gea-enterprise-pool'
                }
              }
            })
          } as any;
        }
        if (u.includes(':getIamPolicy')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              bindings: [
                {
                  role: 'roles/discoveryengine.user',
                  members: [
                    'principalSet://iam.googleapis.com/locations/global/workforcePools/gea-enterprise-pool/group/GEA-AI-Users',
                    'principal://iam.googleapis.com/locations/global/workforcePools/gea-enterprise-pool/subject/rakshitha.shetty@geappliances.com'
                  ]
                }
              ]
            })
          } as any;
        }
        if (u.includes('/workforcePools/gea-enterprise-pool/providers')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              workforcePoolProviders: [
                {
                  name: 'locations/global/workforcePools/gea-enterprise-pool/providers/gea-okta',
                  oidc: { issuerUri: 'https://geappliances.okta.com' },
                  attributeMapping: {
                    'google.subject': 'assertion.email.lowerAscii()',
                    'google.groups': 'assertion.groups'
                  }
                }
              ]
            })
          } as any;
        }
        return { ok: false, status: 404, text: async () => 'Not found' } as any;
      }) as any;

      const inspection = await inspectGeAppWorkforceConfig({
        sourceProjectId: 'agntspce-agntspace-ai-d-1-eced',
        sourceLocation: 'global',
        bearerToken: 'test-admin-token'
      });

      expect(inspection.detectedPoolId).toBe('gea-enterprise-pool');
      expect(inspection.detectedFrom).toBe('ACL_CONFIG');
      expect(inspection.idpType).toBe('THIRD_PARTY');
      expect(inspection.discoveredIamGroups).toContain('GEA-AI-Users');
      expect(getDiscoveredPoolGroups('gea-enterprise-pool')).toContain('GEA-AI-Users');
      expect(inspection.discoveredSampleSubjects).toContain('rakshitha.shetty@geappliances.com');
      expect(inspection.alignmentPlan.targetGoogleSubject).toBe('assertion.email.lowerAscii()');
      expect(inspection.alignmentPlan.attributeMappingString).toBe(
        'google.subject=assertion.email.lowerAscii(),google.groups=assertion.groups,attribute.user_email=assertion.email'
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

