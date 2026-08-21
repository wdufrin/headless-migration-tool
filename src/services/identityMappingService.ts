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
  sourceIdp?: string;
  targetIdp?: string;
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
      fromDomain: r.fromDomain.toLowerCase().trim(),
      toDomain: r.toDomain.toLowerCase().trim()
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
    clean = clean.replace(/^.*\/subject\//i, '');
    clean = clean.replace(/^.*_subject_/i, '');
    clean = clean.replace(/^principal(set)?:\/\/.*?\//i, '');
    clean = clean.replace(/^user:/i, '');
    clean = clean.replace(/^group:/i, '');
    clean = clean.replace(/^corp\\/i, '');
    return clean.trim();
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
      const from = rule.fromDomain;
      const to = rule.toDomain.startsWith('@') ? rule.toDomain : `@${rule.toDomain}`;

      // Case A: Exact domain match (e.g. "@company.onmicrosoft.com")
      const normalizedFrom = from.startsWith('@') ? from : `@${from}`;
      if (!from.includes('*') && !from.startsWith('.') && rawClean.endsWith(normalizedFrom)) {
        const usernamePart = rawClean.slice(0, rawClean.length - normalizedFrom.length);
        const target = `${usernamePart}${to}`;
        return {
          sourceIdentity,
          targetIdentity: target,
          matchedRule: `${rule.fromDomain} -> ${rule.toDomain}`,
          isCustomOverride: false,
          status: 'AUTO_MAPPED'
        };
      }

      // Case B: Wildcard or Subdomain Suffix match (e.g. ".onmicrosoft.com", "*.onmicrosoft.com", "@*.onmicrosoft.com", "onmicrosoft.com")
      const cleanSuffix = from.replace(/^[@*.]*/, ''); // e.g. "onmicrosoft.com"
      if (cleanSuffix && (rawClean.endsWith(`.${cleanSuffix}`) || rawClean.endsWith(`@${cleanSuffix}`))) {
        const atIndex = rawClean.indexOf('@');
        const usernamePart = atIndex > -1 ? rawClean.substring(0, atIndex) : rawClean;
        const target = `${usernamePart}${to}`;
        return {
          sourceIdentity,
          targetIdentity: target,
          matchedRule: `*.${cleanSuffix} -> ${rule.toDomain}`,
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

    // 4. Default: Unchanged identity
    return {
      sourceIdentity,
      targetIdentity: sourceIdentity,
      isCustomOverride: false,
      status: 'UNCHANGED'
    };
  }

  /**
   * Bulk auto-maps a list of users discovered from the source project.
   */
  autoMapUserList(users: string[]): MappedIdentityResult[] {
    const results: MappedIdentityResult[] = [];
    const seen = new Set<string>();

    for (const u of users) {
      const clean = this.normalizeEmail(u);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      results.push(this.resolveIdentity(u));
    }

    return results;
  }

  /**
   * Returns standard preset identity mapping configurations.
   */
  static getIdpPresets(): Record<string, { name: string; domainRules: DomainRule[] }> {
    return {
      ENTRA_TO_GOOGLE: {
        name: 'Microsoft Entra ID -> Google Cloud Identity',
        domainRules: [
          { fromDomain: '.onmicrosoft.com', toDomain: '@company.com' }
        ]
      },
      OKTA_TO_GOOGLE: {
        name: 'Okta Universal Directory -> Google Cloud Identity',
        domainRules: [
          { fromDomain: '.okta.com', toDomain: '@company.com' }
        ]
      },
      PING_TO_GOOGLE: {
        name: 'Ping Identity -> Google Cloud Identity',
        domainRules: [
          { fromDomain: '.pingidentity.com', toDomain: '@company.com' }
        ]
      }
    };
  }
}
