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

import { Agent, ConnectorCollection, DataStore } from '../types/index.js';
import {
  ConnectorEntityMapping,
  ConnectorMappingEntry,
  ConnectorTargetCandidate
} from '../types/migration.js';

/**
 * Result of parsing a Discovery Engine Connector Collection or DataStore identifier
 * using Regex Pattern Matching.
 *
 * Known Regex Limits:
 * - Assumes GCP auto-generated numeric instance suffixes are at least 5 digits (`\d{5,}`).
 * - Assumes optional entity suffixes begin with an ASCII letter (`[a-zA-Z][a-zA-Z0-9_]*`),
 *   such as `_issue`, `_pull_request`, `_repository`, `_mcp_data`, or `_google_drive`.
 */
export interface ParsedTimestampedResourceId {
  rawId: string;
  baseName: string;
  separator?: '_' | '-';
  instanceNumericId?: string;
  entitySuffix?: string;
  parentCollectionId?: string;
  normalizedBase: string;
  normalizedFullKey: string;
}

const TIMESTAMPED_ID_REGEX = /^(.+?)([_-])(\d{5,})(?:_([a-zA-Z][a-zA-Z0-9_]*))?$/;
const SAFE_RESOURCE_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

/**
 * Validates a Connector Collection ID or DataStore ID against hostile/malformed inputs
 * (path traversal, slashes, control characters, whitespace, or empty strings).
 */
export function validateConnectorOrDataStoreId(id: string, fieldName: string = 'resourceId'): string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error(`Invalid ${fieldName}: identifier must be a non-empty string.`);
  }
  const trimmed = id.trim();
  if (trimmed === '__STRIP__') {
    return trimmed;
  }
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(`Invalid ${fieldName} "${trimmed}": path traversal or slash characters are forbidden.`);
  }
  if (!SAFE_RESOURCE_ID_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid ${fieldName} "${trimmed}": must contain only alphanumeric characters, hyphens, underscores, or dots.`
    );
  }
  return trimmed;
}

/**
 * Parses a Connector Collection or DataStore identifier via Regex Pattern Matching
 * to separate its base name, `_#####` numeric instance identifier, and optional entity suffix.
 */
export function parseTimestampedResourceId(id: string): ParsedTimestampedResourceId {
  const cleanId = validateConnectorOrDataStoreId(id);
  const match = cleanId.match(TIMESTAMPED_ID_REGEX);

  if (match) {
    const baseName = match[1];
    const separator = match[2] as '_' | '-';
    const instanceNumericId = match[3];
    const entitySuffix = match[4] || undefined;
    const parentCollectionId = entitySuffix ? `${baseName}${separator}${instanceNumericId}` : undefined;
    const normalizedBase = baseName.toLowerCase().replace(/[-_\s]+/g, '_');
    const normalizedFullKey = entitySuffix
      ? `${normalizedBase}__${entitySuffix.toLowerCase()}`
      : normalizedBase;

    return {
      rawId: cleanId,
      baseName,
      separator,
      instanceNumericId,
      entitySuffix,
      parentCollectionId,
      normalizedBase,
      normalizedFullKey
    };
  }

  const normalizedBase = cleanId.toLowerCase().replace(/[-_\s]+/g, '_');
  return {
    rawId: cleanId,
    baseName: cleanId,
    normalizedBase,
    normalizedFullKey: normalizedBase
  };
}

function normalizeLabel(label?: string): string {
  if (!label) return '';
  // Strip trailing _##### from display names if present, then normalize separators
  const withoutTimestamp = label.trim().replace(/[_-]\d{5,}$/, '');
  return withoutTimestamp.toLowerCase().replace(/[-_\s]+/g, '_');
}

/**
 * Extracts Connector Collection and DataStore references from Agent definitions
 * using structured object traversal and Regex Pattern Matching on serialized definitions.
 *
 * Known Regex Limits:
 * - Regex scanning over JSON-serialized agent definitions matches standard Discovery Engine
 *   resource URI patterns (`collections/{id}/dataConnector` and `/dataStores/{id}`) and may
 *   also match literal strings inside prompt instructions if they contain identical URI syntax.
 */
export function extractAgentConnectorAndDataStoreRefs(agents: Agent[]): {
  connectorRefs: Map<string, { dataSource?: string; referencedByAgents: Set<string>; childDataStoreIds: Set<string> }>;
  dataStoreRefs: Map<string, { referencedByAgents: Set<string> }>;
} {
  const connectorRefs = new Map<
    string,
    { dataSource?: string; referencedByAgents: Set<string>; childDataStoreIds: Set<string> }
  >();
  const dataStoreRefs = new Map<string, { referencedByAgents: Set<string> }>();

  const ensureConnectorRef = (colId: string, dataSource?: string) => {
    let entry = connectorRefs.get(colId);
    if (!entry) {
      entry = { dataSource, referencedByAgents: new Set<string>(), childDataStoreIds: new Set<string>() };
      connectorRefs.set(colId, entry);
    } else if (dataSource && !entry.dataSource) {
      entry.dataSource = dataSource;
    }
    return entry;
  };

  const ensureDataStoreRef = (dsId: string) => {
    let entry = dataStoreRefs.get(dsId);
    if (!entry) {
      entry = { referencedByAgents: new Set<string>() };
      dataStoreRefs.set(dsId, entry);
    }
    return entry;
  };

  for (const agent of agents || []) {
    const agentLabel = agent.displayName || agent.name?.split('/').pop() || 'Untitled Agent';

    // 1. Check top-level dataStoreConnections
    if (Array.isArray(agent.dataStoreConnections)) {
      for (const conn of agent.dataStoreConnections) {
        const dsId = conn?.dataStore?.split('/').pop();
        if (dsId && SAFE_RESOURCE_ID_REGEX.test(dsId)) {
          ensureDataStoreRef(dsId).referencedByAgents.add(agentLabel);
        }
      }
    }

    // 2. Inspect Low-Code and Workflow nodes for structured dataConnectors + dataStoreSpecs
    const definitions = [agent.lowCodeAgentDefinition, agent.workflowAgentDefinition].filter(Boolean);
    for (const def of definitions) {
      const nodeArrays = [def?.nodes, def?.deployedNodes].filter(Array.isArray);
      for (const nodes of nodeArrays) {
        for (const node of nodes) {
          const llmNode = node?.llmAgentNode;
          if (!llmNode) continue;

          const nodeConnectorIds: string[] = [];
          const toolContainers = [llmNode, llmNode.selectedTools].filter(Boolean);
          for (const container of toolContainers) {
            if (Array.isArray(container.dataConnectors)) {
              for (const dc of container.dataConnectors) {
                const rawName = typeof dc?.name === 'string' ? dc.name : '';
                const colMatch = rawName.match(/(?:^|\/)collections\/([a-zA-Z0-9._-]+)\/dataConnector$/);
                if (colMatch && colMatch[1] && colMatch[1] !== 'default_collection') {
                  const colId = colMatch[1];
                  nodeConnectorIds.push(colId);
                  ensureConnectorRef(colId, dc.dataSource).referencedByAgents.add(agentLabel);
                }
              }
            }
          }

          for (const container of toolContainers) {
            const specs = container.dataStoreSpecs?.specs || container.dataStoreConnections || [];
            if (Array.isArray(specs)) {
              for (const spec of specs) {
                const rawDs = typeof spec?.dataStore === 'string' ? spec.dataStore : '';
                const dsId = rawDs.split('/').pop();
                if (dsId && SAFE_RESOURCE_ID_REGEX.test(dsId)) {
                  ensureDataStoreRef(dsId).referencedByAgents.add(agentLabel);
                  for (const colId of nodeConnectorIds) {
                    if (dsId.startsWith(`${colId}_`)) {
                      ensureConnectorRef(colId).childDataStoreIds.add(dsId);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // 3. Fallback Regex Pattern Matching over any definition object for nested URIs
    const defKeys = Object.keys(agent).filter(k => k.toLowerCase().includes('definition'));
    for (const key of defKeys) {
      const defObj = agent[key];
      if (!defObj || typeof defObj !== 'object') continue;
      const serialized = JSON.stringify(defObj);

      const colRegex = /(?:^|["/])collections\/([a-zA-Z0-9._-]+)\/dataConnector/g;
      let colMatch: RegExpExecArray | null;
      while ((colMatch = colRegex.exec(serialized)) !== null) {
        const colId = colMatch[1];
        if (colId && colId !== 'default_collection' && SAFE_RESOURCE_ID_REGEX.test(colId)) {
          ensureConnectorRef(colId).referencedByAgents.add(agentLabel);
        }
      }

      const dsRegex = /\/dataStores\/([a-zA-Z0-9._-]+)/g;
      let dsMatch: RegExpExecArray | null;
      while ((dsMatch = dsRegex.exec(serialized)) !== null) {
        const dsId = dsMatch[1];
        if (dsId && SAFE_RESOURCE_ID_REGEX.test(dsId)) {
          ensureDataStoreRef(dsId).referencedByAgents.add(agentLabel);
        }
      }
    }
  }

  // Link any discovered child entity DataStore (`{connectorColId}_{entity}`) to its parent connector
  for (const [dsId, dsMeta] of dataStoreRefs.entries()) {
    const parsed = parseTimestampedResourceId(dsId);
    if (parsed.parentCollectionId && connectorRefs.has(parsed.parentCollectionId)) {
      const parent = connectorRefs.get(parsed.parentCollectionId)!;
      parent.childDataStoreIds.add(dsId);
      for (const ag of dsMeta.referencedByAgents) {
        parent.referencedByAgents.add(ag);
      }
    }
  }

  return { connectorRefs, dataStoreRefs };
}

export interface BuildConnectorMappingsInput {
  sourceCollections?: ConnectorCollection[];
  targetCollections?: ConnectorCollection[];
  sourceDataStores?: DataStore[];
  targetDataStores?: DataStore[];
  sourceEngineDataStoreIds?: string[];
  targetEngineDataStoreIds?: string[];
  sourceAgents?: Agent[];
  existingCollectionMapping?: Record<string, string>;
  existingDatastoreMapping?: Record<string, string>;
}

export interface BuildConnectorMappingsResult {
  entries: ConnectorMappingEntry[];
  collectionMapping: Record<string, string>;
  datastoreMapping: Record<string, string>;
  targetConnectorCandidates: ConnectorTargetCandidate[];
  targetDataStoreCandidates: ConnectorTargetCandidate[];
  unmappedEntries: ConnectorMappingEntry[];
  unmappedAgentEntries: ConnectorMappingEntry[];
}

interface InternalConnectorGroup {
  id: string;
  displayName: string;
  dataSource?: string;
  parsed: ParsedTimestampedResourceId;
  entities: Map<string, string>; // entityName -> dataStoreId
}

/**
 * Dynamically matches Source Connectors (and their child entity DataStores) and Standalone DataStores
 * against Target Connectors and DataStores.
 *
 * When Source and Target share the same base name / displayName with different `_#####` numeric identifiers
 * (e.g. `github_1773757636775` -> `github_1780931139999`), this automatically maps both the parent
 * Connector Collection and all child entity DataStores (`_issue`, `_pull_request`, `_repository`),
 * preventing a single No-Code Agent connector source from splitting into 3 separate DataStore sources.
 *
 * When automatic matching is ambiguous (multiple target candidates) or missing (0 target candidates),
 * the entry is marked `NEEDS_HITL` so Step 2 UI or the migration HITL prompt can request human confirmation.
 */
export function buildConnectorAndDataStoreMappings(
  input: BuildConnectorMappingsInput
): BuildConnectorMappingsResult {
  const sourceCollections = input.sourceCollections || [];
  const targetCollections = input.targetCollections || [];
  const sourceDataStores = input.sourceDataStores || [];
  const targetDataStores = input.targetDataStores || [];
  const sourceEngineDsSet = new Set(input.sourceEngineDataStoreIds || []);
  const existingColMap = input.existingCollectionMapping || {};
  const existingDsMap = input.existingDatastoreMapping || {};

  const { connectorRefs, dataStoreRefs } = extractAgentConnectorAndDataStoreRefs(input.sourceAgents || []);

  // Helper to assemble connector groups from collections + child entity datastores
  const buildConnectorGroups = (
    collections: ConnectorCollection[],
    dataStores: DataStore[],
    extraConnectorRefs?: Map<string, { dataSource?: string; referencedByAgents: Set<string>; childDataStoreIds: Set<string> }>
  ): {
    connectorGroups: Map<string, InternalConnectorGroup>;
    childToParentConnector: Map<string, string>;
    standaloneDataStores: Map<string, { ds: DataStore; parsed: ParsedTimestampedResourceId }>;
  } => {
    const connectorGroups = new Map<string, InternalConnectorGroup>();
    const childToParentConnector = new Map<string, string>();

    for (const col of collections) {
      const colId = col.name?.split('/').pop() || '';
      if (!colId || colId === 'default_collection') continue;
      if (!SAFE_RESOURCE_ID_REGEX.test(colId)) continue;

      const parsed = parseTimestampedResourceId(colId);
      const entities = new Map<string, string>();
      if (Array.isArray(col.dataConnector?.entities)) {
        for (const ent of col.dataConnector!.entities!) {
          const dsId = ent.dataStore?.split('/').pop();
          if (dsId && ent.entityName) {
            entities.set(ent.entityName, dsId);
            childToParentConnector.set(dsId, colId);
          }
        }
      }

      connectorGroups.set(colId, {
        id: colId,
        displayName: col.displayName || parsed.baseName,
        dataSource: col.dataConnector?.dataSource,
        parsed,
        entities
      });
    }

    // Include any connector referenced by agents that wasn't returned by listCollections
    if (extraConnectorRefs) {
      for (const [colId, refMeta] of extraConnectorRefs.entries()) {
        if (!SAFE_RESOURCE_ID_REGEX.test(colId)) continue;
        if (!connectorGroups.has(colId)) {
          const parsed = parseTimestampedResourceId(colId);
          connectorGroups.set(colId, {
            id: colId,
            displayName: parsed.baseName,
            dataSource: refMeta.dataSource,
            parsed,
            entities: new Map<string, string>()
          });
        }
        const group = connectorGroups.get(colId)!;
        if (refMeta.dataSource && !group.dataSource) {
          group.dataSource = refMeta.dataSource;
        }
        for (const childDsId of refMeta.childDataStoreIds) {
          const childParsed = parseTimestampedResourceId(childDsId);
          const entityName = childParsed.entitySuffix || childDsId.slice(colId.length + 1) || childDsId;
          group.entities.set(entityName, childDsId);
          childToParentConnector.set(childDsId, colId);
        }
      }
    }

    // Group DataStores that belong to an existing connector or share a `{base}_{numericId}_{entity}` pattern
    const byParentPrefix = new Map<string, Array<{ ds: DataStore; parsed: ParsedTimestampedResourceId }>>();
    for (const ds of dataStores) {
      const dsId = ds.name?.split('/').pop() || '';
      if (!dsId || !SAFE_RESOURCE_ID_REGEX.test(dsId)) continue;
      const parsed = parseTimestampedResourceId(dsId);

      // Direct prefix match against known connector collection
      let matchedParentColId: string | undefined;
      for (const colId of connectorGroups.keys()) {
        if (dsId.startsWith(`${colId}_`)) {
          matchedParentColId = colId;
          break;
        }
      }

      if (matchedParentColId) {
        const group = connectorGroups.get(matchedParentColId)!;
        const entityName = dsId.slice(matchedParentColId.length + 1);
        if (entityName) {
          group.entities.set(entityName, dsId);
          childToParentConnector.set(dsId, matchedParentColId);
        }
        continue;
      }

      if (parsed.parentCollectionId && parsed.entitySuffix) {
        const list = byParentPrefix.get(parsed.parentCollectionId) || [];
        list.push({ ds, parsed });
        byParentPrefix.set(parsed.parentCollectionId, list);
      }
    }

    // If 2+ DataStores share the same `{base}_{numericId}` parent prefix with different entity suffixes
    // (e.g. `github_1773757636775_issue`, `_pull_request`, `_repository`), synthesize the parent connector group
    // if listCollections did not already include it.
    for (const [parentColId, children] of byParentPrefix.entries()) {
      if (connectorGroups.has(parentColId) || children.length >= 1) {
        if (!connectorGroups.has(parentColId)) {
          const parentParsed = parseTimestampedResourceId(parentColId);
          connectorGroups.set(parentColId, {
            id: parentColId,
            displayName: parentParsed.baseName,
            parsed: parentParsed,
            entities: new Map<string, string>()
          });
        }
        const group = connectorGroups.get(parentColId)!;
        for (const child of children) {
          const entityName = child.parsed.entitySuffix!;
          group.entities.set(entityName, child.parsed.rawId);
          childToParentConnector.set(child.parsed.rawId, parentColId);
        }
      }
    }

    const standaloneDataStores = new Map<string, { ds: DataStore; parsed: ParsedTimestampedResourceId }>();
    for (const ds of dataStores) {
      const dsId = ds.name?.split('/').pop() || '';
      if (!dsId || !SAFE_RESOURCE_ID_REGEX.test(dsId)) continue;
      if (childToParentConnector.has(dsId)) continue;
      const parsed = parseTimestampedResourceId(dsId);
      if (parsed.parentCollectionId && parsed.entitySuffix) continue;
      standaloneDataStores.set(dsId, {
        ds,
        parsed
      });
    }

    return { connectorGroups, childToParentConnector, standaloneDataStores };
  };

  const srcGrouped = buildConnectorGroups(sourceCollections, sourceDataStores, connectorRefs);
  const tgtGrouped = buildConnectorGroups(targetCollections, targetDataStores);

  // Also ensure any standalone DataStore referenced by an agent or engine is in srcGrouped.standaloneDataStores
  for (const dsId of [...dataStoreRefs.keys(), ...sourceEngineDsSet]) {
    if (!SAFE_RESOURCE_ID_REGEX.test(dsId)) continue;
    if (srcGrouped.childToParentConnector.has(dsId)) continue;
    const parsed = parseTimestampedResourceId(dsId);
    if (parsed.parentCollectionId && parsed.entitySuffix) continue;
    if (!srcGrouped.standaloneDataStores.has(dsId)) {
      srcGrouped.standaloneDataStores.set(dsId, {
        ds: { name: dsId, displayName: dsId },
        parsed
      });
    }
  }

  // Build Target Candidate lists for UI dropdowns and matching
  const targetConnectorCandidates: ConnectorTargetCandidate[] = Array.from(
    tgtGrouped.connectorGroups.values()
  ).map(g => ({
    id: g.id,
    displayName: g.displayName,
    kind: 'CONNECTOR_COLLECTION',
    dataSource: g.dataSource,
    baseName: g.parsed.baseName,
    instanceNumericId: g.parsed.instanceNumericId,
    entityDataStores: Object.fromEntries(g.entities.entries())
  }));

  const targetDataStoreCandidates: ConnectorTargetCandidate[] = Array.from(
    tgtGrouped.standaloneDataStores.values()
  ).map(({ ds, parsed }) => ({
    id: parsed.rawId,
    displayName: ds.displayName || parsed.baseName,
    kind: 'DATASTORE',
    baseName: parsed.baseName,
    instanceNumericId: parsed.instanceNumericId,
    entitySuffix: parsed.entitySuffix
  }));

  const resolvedCollectionMapping: Record<string, string> = {};
  const resolvedDatastoreMapping: Record<string, string> = {};
  const entries: ConnectorMappingEntry[] = [];

  // Helper to populate child entity DataStore mappings when a Connector Collection is mapped
  const buildEntityMappingsForConnector = (
    srcGroup: InternalConnectorGroup,
    tgtGroup?: InternalConnectorGroup,
    explicitTargetColId?: string
  ): ConnectorEntityMapping[] => {
    const result: ConnectorEntityMapping[] = [];
    for (const [entityName, srcDsId] of srcGroup.entities.entries()) {
      let tgtDsId: string | undefined;
      if (existingDsMap[srcDsId] !== undefined) {
        tgtDsId = existingDsMap[srcDsId];
      } else if (explicitTargetColId === '__STRIP__' || explicitTargetColId === '') {
        tgtDsId = '__STRIP__';
      } else if (tgtGroup && tgtGroup.entities.has(entityName)) {
        tgtDsId = tgtGroup.entities.get(entityName)!;
      }

      if (tgtDsId) {
        resolvedDatastoreMapping[srcDsId] = tgtDsId;
      }
      result.push({
        entityName,
        sourceDataStoreId: srcDsId,
        targetDataStoreId: tgtDsId
      });
    }
    return result;
  };

  // Helper to determine which underlying entity DataStores from source connector are missing in target candidate
  const getMissingEntityDataStores = (
    srcGroup: InternalConnectorGroup,
    tgtGroup?: InternalConnectorGroup
  ): { entityName: string; sourceDataStoreId: string }[] => {
    const missing: { entityName: string; sourceDataStoreId: string }[] = [];
    for (const [entityName, srcDsId] of srcGroup.entities.entries()) {
      if (existingDsMap[srcDsId] !== undefined) continue;
      if (!tgtGroup || !tgtGroup.entities.has(entityName)) {
        missing.push({ entityName, sourceDataStoreId: srcDsId });
      }
    }
    return missing;
  };

  // 1. Match Parent Connector Collections
  for (const srcGroup of srcGrouped.connectorGroups.values()) {
    const refAgents = new Set<string>(connectorRefs.get(srcGroup.id)?.referencedByAgents || []);
    let attachedToEngine = false;
    for (const srcDsId of srcGroup.entities.values()) {
      if (sourceEngineDsSet.has(srcDsId)) attachedToEngine = true;
      const dsAg = dataStoreRefs.get(srcDsId)?.referencedByAgents;
      if (dsAg) {
        for (const a of dsAg) refAgents.add(a);
      }
    }

    const explicitOverride = existingColMap[srcGroup.id];
    if (explicitOverride !== undefined) {
      if (explicitOverride === '__STRIP__' || explicitOverride === '') {
        resolvedCollectionMapping[srcGroup.id] = '__STRIP__';
        const entityMappings = buildEntityMappingsForConnector(srcGroup, undefined, '__STRIP__');
        entries.push({
          sourceId: srcGroup.id,
          sourceDisplayName: srcGroup.displayName,
          kind: 'CONNECTOR_COLLECTION',
          dataSource: srcGroup.dataSource,
          baseName: srcGroup.parsed.baseName,
          sourceNumericId: srcGroup.parsed.instanceNumericId,
          targetId: '__STRIP__',
          targetDisplayName: 'Strip / Remove Connector',
          matchStatus: 'STRIPPED',
          matchReason: 'Explicitly configured to strip connector from migrated agents (HITL override).',
          referencedByAgents: Array.from(refAgents),
          attachedToEngine,
          entityMappings,
          candidateTargets: targetConnectorCandidates
        });
        continue;
      }

      const tgtGroup = tgtGrouped.connectorGroups.get(explicitOverride);
      const tgtParsed = parseTimestampedResourceId(explicitOverride);
      const missingEntities = getMissingEntityDataStores(srcGroup, tgtGroup);
      const entityMappings = buildEntityMappingsForConnector(srcGroup, tgtGroup, explicitOverride);

      if (missingEntities.length > 0) {
        const missingDesc = missingEntities
          .map(m => `"${m.entityName}" (source: ${m.sourceDataStoreId})`)
          .join(', ');
        entries.push({
          sourceId: srcGroup.id,
          sourceDisplayName: srcGroup.displayName,
          kind: 'CONNECTOR_COLLECTION',
          dataSource: srcGroup.dataSource,
          baseName: srcGroup.parsed.baseName,
          sourceNumericId: srcGroup.parsed.instanceNumericId,
          targetId: explicitOverride,
          targetDisplayName: tgtGroup?.displayName || tgtParsed.baseName,
          targetNumericId: tgtParsed.instanceNumericId,
          matchStatus: 'NEEDS_HITL',
          matchReason: `Target connector "${explicitOverride}" selected via HITL is missing required underlying entity DataStore(s): ${missingDesc}. Direct matching of underlying DataStores is skipped. Flagged connector as not matching.`,
          referencedByAgents: Array.from(refAgents),
          attachedToEngine,
          entityMappings,
          candidateTargets: targetConnectorCandidates,
          missingDataStoreIds: missingEntities.map(m => m.sourceDataStoreId),
          missingEntities: missingEntities.map(m => m.entityName)
        });
      } else {
        resolvedCollectionMapping[srcGroup.id] = explicitOverride;
        entries.push({
          sourceId: srcGroup.id,
          sourceDisplayName: srcGroup.displayName,
          kind: 'CONNECTOR_COLLECTION',
          dataSource: srcGroup.dataSource,
          baseName: srcGroup.parsed.baseName,
          sourceNumericId: srcGroup.parsed.instanceNumericId,
          targetId: explicitOverride,
          targetDisplayName: tgtGroup?.displayName || tgtParsed.baseName,
          targetNumericId: tgtParsed.instanceNumericId,
          matchStatus: 'HITL_CONFIRMED',
          matchReason: `Mapped via operator HITL selection to "${explicitOverride}". All ${entityMappings.length} underlying entity DataStore(s) verified present.`,
          referencedByAgents: Array.from(refAgents),
          attachedToEngine,
          entityMappings,
          candidateTargets: targetConnectorCandidates
        });
      }
      continue;
    }

    // Check 1a: Exact ID match
    if (tgtGrouped.connectorGroups.has(srcGroup.id)) {
      const tgtGroup = tgtGrouped.connectorGroups.get(srcGroup.id)!;
      const missingEntities = getMissingEntityDataStores(srcGroup, tgtGroup);
      const entityMappings = buildEntityMappingsForConnector(srcGroup, tgtGroup, tgtGroup.id);

      if (missingEntities.length > 0) {
        const missingDesc = missingEntities
          .map(m => `"${m.entityName}" (source: ${m.sourceDataStoreId})`)
          .join(', ');
        entries.push({
          sourceId: srcGroup.id,
          sourceDisplayName: srcGroup.displayName,
          kind: 'CONNECTOR_COLLECTION',
          dataSource: srcGroup.dataSource,
          baseName: srcGroup.parsed.baseName,
          sourceNumericId: srcGroup.parsed.instanceNumericId,
          targetId: tgtGroup.id,
          targetDisplayName: tgtGroup.displayName,
          targetNumericId: tgtGroup.parsed.instanceNumericId,
          matchStatus: 'NEEDS_HITL',
          matchReason: `Target connector "${tgtGroup.id}" has matching ID but is missing required underlying entity DataStore(s): ${missingDesc}. Direct matching of underlying DataStores is skipped. Flagged connector as not matching.`,
          referencedByAgents: Array.from(refAgents),
          attachedToEngine,
          entityMappings,
          candidateTargets: targetConnectorCandidates,
          missingDataStoreIds: missingEntities.map(m => m.sourceDataStoreId),
          missingEntities: missingEntities.map(m => m.entityName)
        });
        continue;
      }

      resolvedCollectionMapping[srcGroup.id] = tgtGroup.id;
      entries.push({
        sourceId: srcGroup.id,
        sourceDisplayName: srcGroup.displayName,
        kind: 'CONNECTOR_COLLECTION',
        dataSource: srcGroup.dataSource,
        baseName: srcGroup.parsed.baseName,
        sourceNumericId: srcGroup.parsed.instanceNumericId,
        targetId: tgtGroup.id,
        targetDisplayName: tgtGroup.displayName,
        targetNumericId: tgtGroup.parsed.instanceNumericId,
        matchStatus: 'EXACT_MATCH',
        matchReason: `Exact connector collection ID exists in target environment and all ${entityMappings.length} underlying entity DataStore(s) match. Direct matching of underlying DataStores skipped.`,
        referencedByAgents: Array.from(refAgents),
        attachedToEngine,
        entityMappings,
        candidateTargets: targetConnectorCandidates
      });
      continue;
    }

    // Check 1b: Auto-match by normalized baseName (different _##### suffix) or normalized displayName
    const srcNormBase = srcGroup.parsed.normalizedBase;
    const srcNormDisplay = normalizeLabel(srcGroup.displayName);

    const baseMatches = Array.from(tgtGrouped.connectorGroups.values()).filter(tgt => {
      const tgtNormBase = tgt.parsed.normalizedBase;
      const tgtNormDisplay = normalizeLabel(tgt.displayName);
      return (
        tgtNormBase === srcNormBase ||
        (srcNormDisplay && tgtNormDisplay === srcNormDisplay)
      );
    });

    const candidatesWithAllEntities = baseMatches.filter(tgt => {
      return getMissingEntityDataStores(srcGroup, tgt).length === 0;
    });

    if (candidatesWithAllEntities.length === 1) {
      const matchedTgt = candidatesWithAllEntities[0];
      resolvedCollectionMapping[srcGroup.id] = matchedTgt.id;
      const entityMappings = buildEntityMappingsForConnector(srcGroup, matchedTgt, matchedTgt.id);

      entries.push({
        sourceId: srcGroup.id,
        sourceDisplayName: srcGroup.displayName,
        kind: 'CONNECTOR_COLLECTION',
        dataSource: srcGroup.dataSource,
        baseName: srcGroup.parsed.baseName,
        sourceNumericId: srcGroup.parsed.instanceNumericId,
        targetId: matchedTgt.id,
        targetDisplayName: matchedTgt.displayName,
        targetNumericId: matchedTgt.parsed.instanceNumericId,
        matchStatus: 'AUTO_MATCHED',
        matchReason: `Auto-mapped base name "${srcGroup.parsed.baseName}" (_${srcGroup.parsed.instanceNumericId || 'src'} ➔ _${matchedTgt.parsed.instanceNumericId || 'tgt'}) with all ${entityMappings.length} matching entity DataStore(s). Direct matching of underlying DataStores skipped.`,
        referencedByAgents: Array.from(refAgents),
        attachedToEngine,
        entityMappings,
        candidateTargets: targetConnectorCandidates
      });
      continue;
    }

    if (candidatesWithAllEntities.length === 0 && baseMatches.length === 1) {
      const candidateTgt = baseMatches[0];
      const missingEntities = getMissingEntityDataStores(srcGroup, candidateTgt);
      const missingDesc = missingEntities
        .map(m => `"${m.entityName}" (source: ${m.sourceDataStoreId})`)
        .join(', ');
      const entityMappings = buildEntityMappingsForConnector(srcGroup, candidateTgt, undefined);

      entries.push({
        sourceId: srcGroup.id,
        sourceDisplayName: srcGroup.displayName,
        kind: 'CONNECTOR_COLLECTION',
        dataSource: srcGroup.dataSource,
        baseName: srcGroup.parsed.baseName,
        sourceNumericId: srcGroup.parsed.instanceNumericId,
        targetId: candidateTgt.id,
        targetDisplayName: candidateTgt.displayName,
        targetNumericId: candidateTgt.parsed.instanceNumericId,
        matchStatus: 'NEEDS_HITL',
        matchReason: `Target connector candidate "${candidateTgt.id}" matches base name "${srcGroup.parsed.baseName}" but is missing required underlying entity DataStore(s): ${missingDesc}. Direct matching of underlying DataStores is skipped. Flagged connector as not matching.`,
        referencedByAgents: Array.from(refAgents),
        attachedToEngine,
        entityMappings,
        candidateTargets: targetConnectorCandidates,
        missingDataStoreIds: missingEntities.map(m => m.sourceDataStoreId),
        missingEntities: missingEntities.map(m => m.entityName)
      });
      continue;
    }

    const reason =
      candidatesWithAllEntities.length > 1
        ? `Ambiguous auto-map: ${candidatesWithAllEntities.length} target connectors share base name "${srcGroup.parsed.baseName}" with all matching DataStores (${candidatesWithAllEntities.map(m => m.id).join(', ')}). Direct matching of underlying DataStores is skipped. HITL selection required.`
        : baseMatches.length > 1
          ? `Ambiguous auto-map: ${baseMatches.length} target connectors share base name "${srcGroup.parsed.baseName}" (${baseMatches.map(m => m.id).join(', ')}). Direct matching of underlying DataStores is skipped. HITL selection required.`
          : `No target connector with base name "${srcGroup.parsed.baseName}" found in destination. Direct matching of underlying DataStores is skipped. HITL mapping required.`;

    const entityMappings = buildEntityMappingsForConnector(srcGroup, undefined, undefined);
    entries.push({
      sourceId: srcGroup.id,
      sourceDisplayName: srcGroup.displayName,
      kind: 'CONNECTOR_COLLECTION',
      dataSource: srcGroup.dataSource,
      baseName: srcGroup.parsed.baseName,
      sourceNumericId: srcGroup.parsed.instanceNumericId,
      matchStatus: 'NEEDS_HITL',
      matchReason: reason,
      referencedByAgents: Array.from(refAgents),
      attachedToEngine,
      entityMappings,
      candidateTargets: targetConnectorCandidates,
      missingDataStoreIds: Array.from(srcGroup.entities.values()),
      missingEntities: Array.from(srcGroup.entities.keys())
    });
  }

  // 2. Match Standalone DataStores
  for (const [srcDsId, { ds: srcDs, parsed: srcParsed }] of srcGrouped.standaloneDataStores.entries()) {
    // Only match datastore to datastore if they are not part of a connector
    if (srcGrouped.childToParentConnector.has(srcDsId) || (srcParsed.parentCollectionId && srcParsed.entitySuffix)) {
      continue;
    }
    const refAgents = Array.from(dataStoreRefs.get(srcDsId)?.referencedByAgents || []);
    const attachedToEngine = sourceEngineDsSet.has(srcDsId);

    const explicitOverride = existingDsMap[srcDsId];
    if (explicitOverride !== undefined) {
      if (explicitOverride === '__STRIP__' || explicitOverride === '') {
        resolvedDatastoreMapping[srcDsId] = '__STRIP__';
        entries.push({
          sourceId: srcDsId,
          sourceDisplayName: srcDs.displayName || srcDsId,
          kind: 'DATASTORE',
          baseName: srcParsed.baseName,
          sourceNumericId: srcParsed.instanceNumericId,
          entitySuffix: srcParsed.entitySuffix,
          targetId: '__STRIP__',
          targetDisplayName: 'Strip / Skip DataStore',
          matchStatus: 'STRIPPED',
          matchReason: 'Explicitly configured to skip DataStore in target environment (HITL override).',
          referencedByAgents: refAgents,
          attachedToEngine,
          candidateTargets: targetDataStoreCandidates
        });
        continue;
      }

      const tgtEntry = tgtGrouped.standaloneDataStores.get(explicitOverride);
      const tgtParsed = parseTimestampedResourceId(explicitOverride);
      resolvedDatastoreMapping[srcDsId] = explicitOverride;
      entries.push({
        sourceId: srcDsId,
        sourceDisplayName: srcDs.displayName || srcDsId,
        kind: 'DATASTORE',
        baseName: srcParsed.baseName,
        sourceNumericId: srcParsed.instanceNumericId,
        entitySuffix: srcParsed.entitySuffix,
        targetId: explicitOverride,
        targetDisplayName: tgtEntry?.ds.displayName || tgtParsed.baseName,
        targetNumericId: tgtParsed.instanceNumericId,
        matchStatus: 'HITL_CONFIRMED',
        matchReason: `Mapped via operator HITL selection to "${explicitOverride}".`,
        referencedByAgents: refAgents,
        attachedToEngine,
        candidateTargets: targetDataStoreCandidates
      });
      continue;
    }

    // Check 2a: Exact ID match
    if (tgtGrouped.standaloneDataStores.has(srcDsId)) {
      const tgtEntry = tgtGrouped.standaloneDataStores.get(srcDsId)!;
      resolvedDatastoreMapping[srcDsId] = srcDsId;
      entries.push({
        sourceId: srcDsId,
        sourceDisplayName: srcDs.displayName || srcDsId,
        kind: 'DATASTORE',
        baseName: srcParsed.baseName,
        sourceNumericId: srcParsed.instanceNumericId,
        entitySuffix: srcParsed.entitySuffix,
        targetId: srcDsId,
        targetDisplayName: tgtEntry.ds.displayName || srcDsId,
        targetNumericId: tgtEntry.parsed.instanceNumericId,
        matchStatus: 'EXACT_MATCH',
        matchReason: 'Exact DataStore ID exists in target environment.',
        referencedByAgents: refAgents,
        attachedToEngine,
        candidateTargets: targetDataStoreCandidates
      });
      continue;
    }

    // Check 2b: Auto-match by normalizedFullKey (baseName + entitySuffix with different _#####) or displayName
    const srcNormFull = srcParsed.normalizedFullKey;
    const srcNormDisplay = normalizeLabel(srcDs.displayName);

    const dsMatches = Array.from(tgtGrouped.standaloneDataStores.values()).filter(({ ds: tgtDs, parsed: tgtParsed }) => {
      if (tgtParsed.normalizedFullKey === srcNormFull) return true;
      const tgtNormDisplay = normalizeLabel(tgtDs.displayName);
      return Boolean(
        srcNormDisplay &&
          tgtNormDisplay === srcNormDisplay &&
          (srcParsed.entitySuffix || '') === (tgtParsed.entitySuffix || '')
      );
    });

    if (dsMatches.length === 1) {
      const matchedTgt = dsMatches[0];
      resolvedDatastoreMapping[srcDsId] = matchedTgt.parsed.rawId;
      entries.push({
        sourceId: srcDsId,
        sourceDisplayName: srcDs.displayName || srcDsId,
        kind: 'DATASTORE',
        baseName: srcParsed.baseName,
        sourceNumericId: srcParsed.instanceNumericId,
        entitySuffix: srcParsed.entitySuffix,
        targetId: matchedTgt.parsed.rawId,
        targetDisplayName: matchedTgt.ds.displayName || matchedTgt.parsed.rawId,
        targetNumericId: matchedTgt.parsed.instanceNumericId,
        matchStatus: 'AUTO_MATCHED',
        matchReason: `Auto-mapped DataStore base name "${srcParsed.baseName}" (_${srcParsed.instanceNumericId || 'src'} ➔ _${matchedTgt.parsed.instanceNumericId || 'tgt'}).`,
        referencedByAgents: refAgents,
        attachedToEngine,
        candidateTargets: targetDataStoreCandidates
      });
      continue;
    }

    const reason =
      dsMatches.length > 1
        ? `Ambiguous auto-map: ${dsMatches.length} target DataStores match "${srcParsed.baseName}" (${dsMatches.map(m => m.parsed.rawId).join(', ')}). HITL selection required.`
        : `No matching target DataStore found for "${srcDsId}". HITL mapping required.`;

    entries.push({
      sourceId: srcDsId,
      sourceDisplayName: srcDs.displayName || srcDsId,
      kind: 'DATASTORE',
      baseName: srcParsed.baseName,
      sourceNumericId: srcParsed.instanceNumericId,
      entitySuffix: srcParsed.entitySuffix,
      matchStatus: 'NEEDS_HITL',
      matchReason: reason,
      referencedByAgents: refAgents,
      attachedToEngine,
      candidateTargets: targetDataStoreCandidates
    });
  }

  // Sort entries: items referenced by agents or needing HITL first, then Connectors before standalone DataStores
  entries.sort((a, b) => {
    const aAgentWeight = a.referencedByAgents.length > 0 ? 1 : 0;
    const bAgentWeight = b.referencedByAgents.length > 0 ? 1 : 0;
    if (aAgentWeight !== bAgentWeight) return bAgentWeight - aAgentWeight;

    const aHitl = a.matchStatus === 'NEEDS_HITL' ? 1 : 0;
    const bHitl = b.matchStatus === 'NEEDS_HITL' ? 1 : 0;
    if (aHitl !== bHitl) return bHitl - aHitl;

    if (a.kind !== b.kind) return a.kind === 'CONNECTOR_COLLECTION' ? -1 : 1;
    return a.sourceId.localeCompare(b.sourceId);
  });

  const unmappedEntries = entries.filter(e => e.matchStatus === 'NEEDS_HITL');
  const unmappedAgentEntries = unmappedEntries.filter(e => e.referencedByAgents.length > 0);

  return {
    entries,
    collectionMapping: resolvedCollectionMapping,
    datastoreMapping: resolvedDatastoreMapping,
    targetConnectorCandidates,
    targetDataStoreCandidates,
    unmappedEntries,
    unmappedAgentEntries
  };
}
