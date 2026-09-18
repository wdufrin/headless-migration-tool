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

export interface CsvParseOptions {
  defaultSourceDomain?: string;
  defaultTargetDomain?: string;
}

export interface CsvMappingRow {
  lineNumber: number;
  sourceIdentity: string;
  targetIdentity: string;
}

export interface CsvCollision {
  type: 'DUPLICATE_SOURCE' | 'DUPLICATE_TARGET';
  identity: string;
  conflictingIdentities: string[];
  lineNumbers: number[];
}

export interface CsvParseResult {
  mappings: Record<string, string>;
  rows: CsvMappingRow[];
  totalRowsParsed: number;
  skippedHeaderRows: number;
  malformedRows: { lineNumber: number; rawLine: string; reason: string }[];
  collisions: CsvCollision[];
}

export interface MappingReportEntry {
  sourceIdentity: string;
  targetIdentity: string;
  mappingMethod: 'CSV_MAP' | 'MANUAL_OVERRIDE' | 'DOMAIN_RULE' | 'FALLBACK' | 'UNMAPPED';
  matchedRule?: string;
  inDiscoveredScope: boolean;
  validationStatus: 'VALID' | 'UNMAPPED_WARNING' | 'TARGET_COLLISION' | 'INVALID_EMAIL';
  validationMessage?: string;
}

export interface IdentityMappingAuditReport {
  generatedAt: string;
  summary: {
    totalIdentities: number;
    csvOrExplicitMapped: number;
    domainRuleMapped: number;
    unmappedCount: number;
    collisionCount: number;
    readyCount: number;
  };
  entries: MappingReportEntry[];
  collisions: CsvCollision[];
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
   * Case-insensitive and prefix-tolerant lookup against an identityMapping dictionary.
   * Handles "user:First.Last@XXXX.com", "first.last@xxxx.com", and principal:// URIs.
   */
  static lookupTargetIdentity(
    sourceIdentity: string | undefined,
    identityMapping: Record<string, string> | undefined,
    fallback?: string
  ): string {
    if (!sourceIdentity) return fallback || '';
    const trimmed = sourceIdentity.trim();
    const clean = trimmed
      .replace(/^.*\/subject\//i, '')
      .replace(/^.*_subject_/i, '')
      .replace(/^principal(set)?:\/\/.*?\//i, '')
      .replace(/^user:/i, '')
      .replace(/^group:/i, '')
      .replace(/^corp\\/i, '')
      .trim();

    if (!identityMapping || Object.keys(identityMapping).length === 0) {
      return fallback || clean;
    }

    // 1. Direct exact checks
    if (identityMapping[clean]) return identityMapping[clean];
    if (identityMapping[trimmed]) return identityMapping[trimmed];
    if (identityMapping[`user:${clean}`]) return identityMapping[`user:${clean}`];

    // 2. Case-insensitive lookup
    const lowerClean = clean.toLowerCase();
    if (identityMapping[lowerClean]) return identityMapping[lowerClean];
    if (identityMapping[`user:${lowerClean}`]) return identityMapping[`user:${lowerClean}`];

    for (const [k, v] of Object.entries(identityMapping)) {
      const cleanKey = k
        .replace(/^.*\/subject\//i, '')
        .replace(/^user:/i, '')
        .trim()
        .toLowerCase();
      if (cleanKey === lowerClean && v) {
        return v;
      }
    }

    return fallback || clean;
  }

  /**
   * Parses CSV / TSV / delimiter-separated user ID mapping content (e.g. first.last@XXXX.com,#####@YYYY.com).
   * Automatically detects headers, supports optional default domains when bare IDs are given,
   * and detects source/target collisions.
   */
  static parseCsvMappings(csvContent: string, options: CsvParseOptions = {}): CsvParseResult {
    const mappings: Record<string, string> = {};
    const rows: CsvMappingRow[] = [];
    const malformedRows: { lineNumber: number; rawLine: string; reason: string }[] = [];
    const collisions: CsvCollision[] = [];
    let skippedHeaderRows = 0;

    if (!csvContent || typeof csvContent !== 'string') {
      return {
        mappings,
        rows,
        totalRowsParsed: 0,
        skippedHeaderRows: 0,
        malformedRows,
        collisions
      };
    }

    const cleanDefaultSrcDomain = (options.defaultSourceDomain || '').trim().toLowerCase().replace(/^@/, '');
    const cleanDefaultTgtDomain = (options.defaultTargetDomain || '').trim().toLowerCase().replace(/^@/, '');

    const rawLines = csvContent.replace(/^\uFEFF/, '').split(/\r?\n/);
    const sourceToTargets = new Map<string, { targets: Set<string>; lines: number[] }>();
    const targetToSources = new Map<string, { sources: Set<string>; lines: number[] }>();

    const headerKeywords = new Set([
      'source', 'target', 'old_id', 'new_id', 'old_email', 'new_email',
      'source_email', 'target_email', 'destination_email', 'source_user',
      'target_user', 'source_user_id', 'target_user_id', 'from', 'to',
      'source_identity', 'target_identity', 'old_user', 'new_user',
      'legacy_email', 'google_email', 'upn', 'employee_id'
    ]);

    for (let i = 0; i < rawLines.length; i++) {
      const lineNumber = i + 1;
      const rawLine = rawLines[i].trim();
      if (!rawLine || rawLine.startsWith('#') || rawLine.startsWith('//')) {
        continue;
      }

      // Split by arrow (->, =>), comma, tab, semicolon, or pipe
      let parts: string[];
      if (rawLine.includes('->') || rawLine.includes('=>')) {
        parts = rawLine.split(/->|=>/).map(p => p.trim());
      } else if (rawLine.includes('\t')) {
        parts = rawLine.split('\t').map(p => p.trim());
      } else if (rawLine.includes(';')) {
        parts = rawLine.split(';').map(p => p.trim());
      } else if (rawLine.includes('|')) {
        parts = rawLine.split('|').map(p => p.trim());
      } else {
        parts = rawLine.split(',').map(p => p.trim());
      }

      // Strip surrounding quotes
      parts = parts.map(p => p.replace(/^["']+|["']+$/g, '').trim()).filter(Boolean);

      if (parts.length < 2) {
        malformedRows.push({
          lineNumber,
          rawLine,
          reason: 'Expected at least 2 columns (source_id, target_id)'
        });
        continue;
      }

      let rawSrc = parts[0].toLowerCase().replace(/^user:/i, '').trim();
      let rawTgt = parts[1].toLowerCase().replace(/^user:/i, '').trim();

      // Detect header row on first non-empty line (or if both tokens match header labels without @)
      if (
        !rawSrc.includes('@') &&
        !rawTgt.includes('@') &&
        (headerKeywords.has(rawSrc.replace(/[\s-]+/g, '_')) || headerKeywords.has(rawTgt.replace(/[\s-]+/g, '_')))
      ) {
        skippedHeaderRows++;
        continue;
      }

      // Append default domains if bare username / employee number was provided
      if (!rawSrc.includes('@') && cleanDefaultSrcDomain) {
        rawSrc = `${rawSrc}@${cleanDefaultSrcDomain}`;
      }
      if (!rawTgt.includes('@') && cleanDefaultTgtDomain) {
        rawTgt = `${rawTgt}@${cleanDefaultTgtDomain}`;
      }

      if (!rawSrc.includes('@') || !rawTgt.includes('@')) {
        malformedRows.push({
          lineNumber,
          rawLine,
          reason: `Missing email domain (@) in source "${rawSrc}" or target "${rawTgt}". Provide full emails or set Source/Target domains.`
        });
        continue;
      }

      mappings[rawSrc] = rawTgt;
      rows.push({
        lineNumber,
        sourceIdentity: rawSrc,
        targetIdentity: rawTgt
      });

      if (!sourceToTargets.has(rawSrc)) {
        sourceToTargets.set(rawSrc, { targets: new Set(), lines: [] });
      }
      sourceToTargets.get(rawSrc)!.targets.add(rawTgt);
      sourceToTargets.get(rawSrc)!.lines.push(lineNumber);

      if (!targetToSources.has(rawTgt)) {
        targetToSources.set(rawTgt, { sources: new Set(), lines: [] });
      }
      targetToSources.get(rawTgt)!.sources.add(rawSrc);
      targetToSources.get(rawTgt)!.lines.push(lineNumber);
    }

    for (const [src, info] of sourceToTargets.entries()) {
      if (info.targets.size > 1) {
        collisions.push({
          type: 'DUPLICATE_SOURCE',
          identity: src,
          conflictingIdentities: Array.from(info.targets),
          lineNumbers: info.lines
        });
      }
    }

    for (const [tgt, info] of targetToSources.entries()) {
      if (info.sources.size > 1) {
        collisions.push({
          type: 'DUPLICATE_TARGET',
          identity: tgt,
          conflictingIdentities: Array.from(info.sources),
          lineNumbers: info.lines
        });
      }
    }

    return {
      mappings,
      rows,
      totalRowsParsed: rows.length,
      skippedHeaderRows,
      malformedRows,
      collisions
    };
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
        matchedRule: 'Explicit / CSV Mapping',
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
   * Generates a full audit & reconciliation report comparing discovered users,
   * CSV mappings, manual overrides, and domain rules.
   */
  generateMappingAuditReport(
    discoveredUsers: string[] = [],
    csvMappedKeys: Set<string> = new Set()
  ): IdentityMappingAuditReport {
    const discoveredSet = new Set(discoveredUsers.map(u => this.normalizeEmail(u)).filter(Boolean));
    const allSources = new Set<string>([
      ...discoveredSet,
      ...Array.from(this.explicitMappings.keys())
    ]);

    const entries: MappingReportEntry[] = [];
    const targetToSources = new Map<string, string[]>();

    for (const src of allSources) {
      const resolved = this.resolveIdentity(src);
      const tgt = this.normalizeEmail(resolved.targetIdentity);

      let method: MappingReportEntry['mappingMethod'] = 'UNMAPPED';
      if (this.explicitMappings.has(src)) {
        method = csvMappedKeys.has(src) ? 'CSV_MAP' : 'MANUAL_OVERRIDE';
      } else if (resolved.status === 'AUTO_MAPPED') {
        method = 'DOMAIN_RULE';
      } else if (resolved.status === 'FALLBACK_APPLIED') {
        method = 'FALLBACK';
      }

      if (!targetToSources.has(tgt)) {
        targetToSources.set(tgt, []);
      }
      targetToSources.get(tgt)!.push(src);

      entries.push({
        sourceIdentity: src,
        targetIdentity: tgt,
        mappingMethod: method,
        matchedRule: resolved.matchedRule,
        inDiscoveredScope: discoveredSet.has(src),
        validationStatus: 'VALID'
      });
    }

    const collisions: CsvCollision[] = [];
    const collidingTargets = new Set<string>();
    for (const [tgt, sources] of targetToSources.entries()) {
      if (sources.length > 1) {
        collidingTargets.add(tgt);
        collisions.push({
          type: 'DUPLICATE_TARGET',
          identity: tgt,
          conflictingIdentities: sources,
          lineNumbers: []
        });
      }
    }

    let csvOrExplicitMapped = 0;
    let domainRuleMapped = 0;
    let unmappedCount = 0;
    let collisionCount = 0;
    let readyCount = 0;

    for (const entry of entries) {
      if (entry.mappingMethod === 'CSV_MAP' || entry.mappingMethod === 'MANUAL_OVERRIDE') {
        csvOrExplicitMapped++;
      } else if (entry.mappingMethod === 'DOMAIN_RULE') {
        domainRuleMapped++;
      } else if (entry.mappingMethod === 'UNMAPPED') {
        unmappedCount++;
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(entry.sourceIdentity) || !emailRegex.test(entry.targetIdentity)) {
        entry.validationStatus = 'INVALID_EMAIL';
        entry.validationMessage = 'Source or destination ID is not a valid email address.';
      } else if (collidingTargets.has(entry.targetIdentity)) {
        entry.validationStatus = 'TARGET_COLLISION';
        const others = (targetToSources.get(entry.targetIdentity) || []).filter(s => s !== entry.sourceIdentity);
        entry.validationMessage = `Target collision: also mapped from ${others.join(', ')}`;
        collisionCount++;
      } else if (entry.mappingMethod === 'UNMAPPED' && (this.explicitMappings.size > 0 || this.domainRules.length > 0)) {
        entry.validationStatus = 'UNMAPPED_WARNING';
        entry.validationMessage = 'User discovered in source project but missing from CSV / mapping rules (will remain unchanged).';
      } else {
        entry.validationStatus = 'VALID';
        readyCount++;
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        totalIdentities: entries.length,
        csvOrExplicitMapped,
        domainRuleMapped,
        unmappedCount,
        collisionCount,
        readyCount
      },
      entries,
      collisions
    };
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
