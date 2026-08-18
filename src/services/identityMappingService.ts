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

import { logger } from '../utils/logger.js';

export interface DomainRule {
  fromDomain: string; // e.g. "@legacy.onmicrosoft.com" or "legacy.onmicrosoft.com"
  toDomain: string;   // e.g. "@company.com" or "company.com"
}

export interface IdpMappingConfig {
  sourceIdp?: 'MICROSOFT_ENTRA' | 'OKTA' | 'PING' | 'GOOGLE_WORKSPACE' | 'CUSTOM';
  targetIdp?: 'GOOGLE_CLOUD_IDENTITY' | 'GOOGLE_WORKSPACE' | 'CUSTOM';
  domainRules?: DomainRule[];
  explicitMappings?: Record<string, string>;
  defaultFallbackEmail?: string;
  stripPrefixes?: string[]; // e.g. ["user:", "group:", "corp\\"]
}

export interface MappedIdentityResult {
  sourceIdentity: string;
  targetIdentity: string;
  matchedRule?: string;
  isCustomOverride: boolean;
  status: 'AUTO_MAPPED' | 'MANUAL_OVERRIDE' | 'FALLBACK_APPLIED' | 'UNCHANGED';
}

export class IdentityMappingService {
  private config: IdpMappingConfig;
  private explicitMappings: Map<string, string> = new Map();
  private domainRules: DomainRule[] = [];

  constructor(config: IdpMappingConfig = {}) {
    this.config = config;
    this.domainRules = (config.domainRules || []).map(r => ({
      fromDomain: r.fromDomain.startsWith('@') ? r.fromDomain.toLowerCase() : `@${r.fromDomain.toLowerCase()}`,
      toDomain: r.toDomain.startsWith('@') ? r.toDomain.toLowerCase() : `@${r.toDomain.toLowerCase()}`
    }));

    if (config.explicitMappings) {
      for (const [src, tgt] of Object.entries(config.explicitMappings)) {
        this.explicitMappings.set(this.normalizeEmail(src), this.normalizeEmail(tgt));
      }
    }
  }

  /**
   * Normalizes an identity string by stripping user: / group: prefixes and trimming whitespace.
   */
  normalizeEmail(identity: string): string {
    if (!identity) return '';
    let clean = identity.trim().toLowerCase();
    clean = clean.replace(/^user:/i, '');
    clean = clean.replace(/^group:/i, '');
    clean = clean.replace(/^corp\\/i, '');
    return clean;
  }

  /**
   * Translates a single source identity into its corresponding target Google Cloud Identity.
   */
  resolveIdentity(sourceIdentity: string): MappedIdentityResult {
    const rawClean = this.normalizeEmail(sourceIdentity);
    if (!rawClean) {
      return {
        sourceIdentity,
        targetIdentity: this.config.defaultFallbackEmail || sourceIdentity,
        isCustomOverride: false,
        status: 'UNCHANGED'
      };
    }

    // 1. Check explicit mappings first (highest priority)
    if (this.explicitMappings.has(rawClean)) {
      const target = this.explicitMappings.get(rawClean)!;
      return {
        sourceIdentity,
        targetIdentity: target,
        matchedRule: 'Explicit Mapping',
        isCustomOverride: true,
        status: 'MANUAL_OVERRIDE'
      };
    }

    // 2. Check Domain / Suffix transformation rules
    for (const rule of this.domainRules) {
      if (rawClean.endsWith(rule.fromDomain)) {
        const usernamePart = rawClean.slice(0, rawClean.length - rule.fromDomain.length);
        const target = `${usernamePart}${rule.toDomain}`;
        return {
          sourceIdentity,
          targetIdentity: target,
          matchedRule: `${rule.fromDomain} -> ${rule.toDomain}`,
          isCustomOverride: false,
          status: 'AUTO_MAPPED'
        };
      }
    }

    // 3. Check fallback if configured
    if (this.config.defaultFallbackEmail) {
      return {
        sourceIdentity,
        targetIdentity: this.config.defaultFallbackEmail,
        matchedRule: 'Default Fallback',
        isCustomOverride: false,
        status: 'FALLBACK_APPLIED'
      };
    }

    // 4. Default: keep unchanged
    return {
      sourceIdentity,
      targetIdentity: rawClean,
      isCustomOverride: false,
      status: 'UNCHANGED'
    };
  }

  /**
   * Bulk auto-maps a collection of discovered source identities.
   */
  autoMapUserList(sourceIdentities: string[]): MappedIdentityResult[] {
    const results: MappedIdentityResult[] = [];
    const seen = new Set<string>();

    for (const raw of sourceIdentities) {
      const clean = this.normalizeEmail(raw);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      results.push(this.resolveIdentity(clean));
    }

    return results;
  }

  /**
   * Returns standard preset domain transformation templates for enterprise IdP migrations.
   */
  static getIdpPresets(): Record<string, { name: string; description: string; domainRules: DomainRule[] }> {
    return {
      'ENTRA_TO_GOOGLE': {
        name: 'Microsoft Entra ID to Google Cloud Identity',
        description: 'Translates Azure AD / Entra ID .onmicrosoft.com or corporate UPNs to Google Cloud Identity domain.',
        domainRules: [
          { fromDomain: '@company.onmicrosoft.com', toDomain: '@company.com' }
        ]
      },
      'OKTA_TO_GOOGLE': {
        name: 'Okta Universal Directory to Google Cloud Identity',
        description: 'Translates Okta federated tenant users into Google Cloud Identity accounts.',
        domainRules: [
          { fromDomain: '@company.okta.com', toDomain: '@company.com' }
        ]
      },
      'PING_TO_GOOGLE': {
        name: 'Ping Identity (PingFederate) to Google Cloud Identity',
        description: 'Translates PingFederate SAML assertions into target Google Cloud Identity accounts.',
        domainRules: [
          { fromDomain: '@ping.company.com', toDomain: '@company.com' }
        ]
      }
    };
  }
}
