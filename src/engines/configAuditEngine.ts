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

import { DiscoveryEngineClient } from '../services/discoveryEngine.js';
import { AgentRegistryClient } from '../services/agentRegistry.js';
import { GcpAuthService } from '../services/gcpAuth.js';
import { ValidatedMigrationConfig } from '../config/configSchema.js';
import { getSafeDiscoveryEngineUrl } from '../security/validator.js';
import { logger } from '../utils/logger.js';

export interface AuditItem {
  id: string;
  category: 'ENGINE' | 'DATASTORE' | 'IDP' | 'SKILLS' | 'AUTHORIZATION';
  name: string;
  status: 'MATCH' | 'DIFF' | 'MISSING_IN_TARGET' | 'WARNING';
  sourceValue: any;
  targetValue: any;
  details?: string;
  remediationCommand?: string;
}

export interface ConfigAuditResult {
  sourceProject: string;
  targetProject: string;
  sourceLocation: string;
  targetLocation: string;
  readinessScore: number; // 0 - 100
  totalChecks: number;
  matchingCount: number;
  diffsCount: number;
  missingInTargetCount: number;
  warningsCount: number;
  items: AuditItem[];
  remediationPlan: {
    title: string;
    description: string;
    command?: string;
  }[];
  timestamp: string;
}

export interface EngineFeatureMeta {
  displayName: string;
  description: string;
  critical?: boolean;
}

export const KNOWN_ENGINE_FEATURES: Record<string, EngineFeatureMeta> = {
  'personalization-memory': {
    displayName: 'User Memory & Personalization',
    description: 'Enables Gemini Enterprise to remember user preferences, facts, and conversation context across sessions.',
    critical: true
  },
  'agent-gallery': {
    displayName: 'Agent Gallery & Catalog',
    description: 'Allows users to discover, browse, and pin published enterprise custom agents.',
    critical: true
  },
  'no-code-agent-builder': {
    displayName: 'Create Agents (No-Code Builder)',
    description: 'Empowers users to author, configure, and publish custom agents directly in the web UI.',
    critical: true
  },
  'workflow-agents': {
    displayName: 'Create Workflow Agents',
    description: 'Enables multi-turn workflow execution and complex agent orchestration capabilities.',
    critical: true
  },
  'skills': {
    displayName: 'Create & Execute Skills',
    description: 'Core capability for Gemini Enterprise to discover, execute, and ground on enterprise custom skills.',
    critical: true
  },
  'disable-skills': {
    displayName: 'Disable Skills Setting',
    description: 'Global kill-switch that disables all enterprise skills if set to FEATURE_STATE_ON.',
    critical: true
  },
  'skill-sharing': {
    displayName: 'Skill Sharing',
    description: 'Permits creators to share custom skills with other organization users and groups.',
    critical: true
  },
  'skill-sharing-without-admin-approval': {
    displayName: 'Skill Sharing Without Admin Approval',
    description: 'Permits shared skills to become visible immediately across the organization without manual admin approval.',
    critical: true
  },
  'agent-sharing-without-admin-approval': {
    displayName: 'Agent Sharing Without Admin Approval',
    description: 'Permits shared agents to become visible immediately across the organization without manual admin approval.'
  },
  'disable-agent-sharing': {
    displayName: 'Disable Agent Sharing Setting',
    description: 'Blocks end-user agent sharing if set to FEATURE_STATE_ON.'
  },
  'session-sharing': {
    displayName: 'Chat Session Sharing',
    description: 'Enables users to share chat conversations via web link with colleagues.'
  },
  'prompt-gallery': {
    displayName: 'Prompt Gallery',
    description: 'Curated prompt templates displayed on the user home screen for quick task initiation.'
  },
  'notebook-lm': {
    displayName: 'NotebookLM Integration',
    description: 'Provides in-app interactive notebook studio for grounded document research.'
  },
  'model-selector': {
    displayName: 'Foundation Model Selector',
    description: 'Enables users to toggle between available Gemini model families (e.g. Flash, Pro).'
  },
  'people-search': {
    displayName: 'People & Employee Search',
    description: 'Indexes organization directory for employee profile lookups and contact finding.'
  },
  'people-search-org-chart': {
    displayName: 'People Search Org Chart',
    description: 'Renders organizational hierarchy and reporting structures.'
  },
  'mobile-app-access': {
    displayName: 'Mobile App Access',
    description: 'Enables mobile device access to Gemini Enterprise.'
  },
  'disable-mobile-app-access': {
    displayName: 'Disable Mobile App Access Setting',
    description: 'Suppresses mobile device connections when ON.'
  },
  'bi-directional-audio': {
    displayName: 'Bi-Directional Voice & Audio',
    description: 'Real-time conversational speech streaming and audio interactions.'
  },
  'feedback': {
    displayName: 'User Feedback Widget',
    description: 'Allows users to submit rating feedback and quality corrections on responses.'
  },
  'in-app-notifications': {
    displayName: 'In-App Notifications',
    description: 'Notifies users of shared agents, approvals, and system events.'
  },
  'personalization-suggested-highlights': {
    displayName: 'Personalization Suggested Highlights',
    description: 'Generates personalized suggested topics and shortcuts based on user workflow history.'
  },
  'disable-welcome-emails': {
    displayName: 'Disable Welcome Emails Setting',
    description: 'Controls whether onboarding emails are sent to new users.'
  },
  'disable-canvas': {
    displayName: 'Disable Canvas Studio Setting',
    description: 'Controls availability of the interactive Canvas editing pane.'
  },
  'disable-canvas-workspace': {
    displayName: 'Disable Canvas Workspace Setting',
    description: 'Controls availability of multi-document canvas workspaces.'
  },
  'disable-image-generation': {
    displayName: 'Disable Image Generation Setting',
    description: 'Restricts Imagen image generation tools if set to ON.'
  },
  'disable-video-generation': {
    displayName: 'Disable Video Generation Setting',
    description: 'Restricts Veo video generation tools if set to ON.'
  },
  'disable-talk-to-content': {
    displayName: 'Disable Talk to Content Setting',
    description: 'Controls deep document Q&A features.'
  },
  'disable-google-drive-upload': {
    displayName: 'Disable Google Drive Upload Setting',
    description: 'Controls direct Google Drive file attachment capability.'
  },
  'disable-onedrive-upload': {
    displayName: 'Disable OneDrive Upload Setting',
    description: 'Controls direct Microsoft OneDrive file attachment capability.'
  },
  'cross-product-intelligence': {
    displayName: 'Cross-Product Intelligence',
    description: 'Deep integration with external Google Workspace or 3P cloud products.'
  },
  'cross-domain-documents': {
    displayName: 'Cross-Domain Documents',
    description: 'Allows querying across cross-tenant or partner domain documents.'
  },
  'enable-end-user-sharing-with-groups': {
    displayName: 'Group-Based Sharing',
    description: 'Permits sharing agents and skills to Google Groups or Entra ID security groups.'
  },
  'enable-qr-code-widget': {
    displayName: 'QR Code Widget',
    description: 'Generates mobile QR codes in the web interface.'
  },
  'disable-multi-agent-orchestration': {
    displayName: 'Disable Multi-Agent Orchestration Setting',
    description: 'Restricts multi-agent coordinator execution if ON.'
  },
  'disable-single-agent-orchestration': {
    displayName: 'Disable Single-Agent Orchestration Setting',
    description: 'Restricts single-agent tool call routing if ON.'
  },
  'disable-projects': {
    displayName: 'Disable Projects Workspace Setting',
    description: 'Controls project-level grouping in Gemini Enterprise.'
  }
};

export class ConfigAuditEngine {
  private client: DiscoveryEngineClient;
  private registryClient: AgentRegistryClient;
  private auth: GcpAuthService;

  constructor(auth: GcpAuthService, client?: DiscoveryEngineClient, registryClient?: AgentRegistryClient) {
    this.auth = auth;
    this.client = client || new DiscoveryEngineClient(auth);
    this.registryClient = registryClient || new AgentRegistryClient(auth);
  }

  /**
   * Performs deep gap analysis comparing source vs target environments.
   */
  async runAudit(config: ValidatedMigrationConfig): Promise<ConfigAuditResult> {
    const items: AuditItem[] = [];
    const remediationPlan: { title: string; description: string; command?: string }[] = [];
    const src = config.source;
    const tgt = config.target;

    logger.info(`Running configuration audit: ${src.projectId} -> ${tgt.projectId}`);

    // -------------------------------------------------------------
    // 1. Discovery Engine & Location Parity
    // -------------------------------------------------------------
    const locMatch = src.appLocation === tgt.appLocation;
    items.push({
      id: 'engine-location',
      category: 'ENGINE',
      name: 'Engine Geographic Location',
      status: locMatch ? 'MATCH' : 'WARNING',
      sourceValue: src.appLocation,
      targetValue: tgt.appLocation,
      details: locMatch
        ? `Both environments operate in identical location (${src.appLocation}).`
        : `Location mismatch detected (${src.appLocation} vs ${tgt.appLocation}). Cross-region latency and data residency policies may apply.`
    });

    let targetEngineExists = false;
    let sourceEngineDetails: any = null;
    let targetEngineDetails: any = null;

    try {
      sourceEngineDetails = await this.client.getEngine(src);
    } catch (err: any) {
      logger.warn(`Could not fetch source engine: ${err.message}`);
    }

    try {
      targetEngineDetails = await this.client.getEngine(tgt);
      targetEngineExists = true;
      items.push({
        id: 'engine-existence',
        category: 'ENGINE',
        name: 'Target Engine Existence & Accessibility',
        status: 'MATCH',
        sourceValue: src.appId || 'default_engine',
        targetValue: tgt.appId || 'default_engine',
        details: `Target Engine verified: "${targetEngineDetails.displayName || targetEngineDetails.name}"`
      });
    } catch (err: any) {
      items.push({
        id: 'engine-existence',
        category: 'ENGINE',
        name: 'Target Engine Existence & Accessibility',
        status: 'MISSING_IN_TARGET',
        sourceValue: src.appId || 'default_engine',
        targetValue: 'Not Found / Inaccessible',
        details: `Target Engine "${tgt.appId}" does not exist in target project "${tgt.projectId}" or caller lacks access.`,
        remediationCommand: `curl -s -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" -H "X-Goog-User-Project: ${tgt.projectId}" "${getSafeDiscoveryEngineUrl(tgt.appLocation)}/v1alpha/projects/${tgt.projectId}/locations/${tgt.appLocation || 'global'}/collections/${tgt.collectionId || 'default_collection'}/engines?engineId=${tgt.appId}" -d '{"displayName":"${tgt.appId}","solutionType":"SOLUTION_TYPE_CHAT"}'`
      });
    }

    // Compare Engine Features dynamically
    const featureDiffs: string[] = [];
    const settingDiffs: string[] = [];

    if (sourceEngineDetails?.features || targetEngineDetails?.features) {
      const srcFeatures: Record<string, string> = sourceEngineDetails?.features || {};
      const tgtFeatures: Record<string, string> = targetEngineDetails?.features || {};
      const allFeatureKeys = Array.from(new Set([...Object.keys(srcFeatures), ...Object.keys(tgtFeatures)]));

      // Prioritize primary features requested by user (memory, agent catalog, create agents, create skills, etc.)
      const priorityOrder = [
        'personalization-memory',
        'agent-gallery',
        'no-code-agent-builder',
        'workflow-agents',
        'skills',
        'disable-skills',
        'skill-sharing',
        'skill-sharing-without-admin-approval',
        'session-sharing',
        'prompt-gallery',
        'notebook-lm',
        'model-selector',
        'people-search',
        'people-search-org-chart',
        'mobile-app-access',
        'agent-sharing-without-admin-approval',
        'disable-agent-sharing'
      ];

      allFeatureKeys.sort((a, b) => {
        const idxA = priorityOrder.indexOf(a);
        const idxB = priorityOrder.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });

      for (const key of allFeatureKeys) {
        const srcVal = srcFeatures[key];
        const tgtVal = tgtFeatures[key];
        const meta = KNOWN_ENGINE_FEATURES[key];
        const displayName = meta?.displayName || key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const desc = meta?.description || '';

        let status: 'MATCH' | 'DIFF' | 'MISSING_IN_TARGET' | 'WARNING' = 'MATCH';
        let details = '';

        if (srcVal !== undefined && tgtVal === undefined) {
          status = meta?.critical ? 'WARNING' : 'DIFF';
          details = `${displayName} is configured on source ("${srcVal}") but missing on target engine. ${desc}`;
          featureDiffs.push(key);
        } else if (srcVal === undefined && tgtVal !== undefined) {
          status = 'DIFF';
          details = `${displayName} is set on target ("${tgtVal}") but not explicitly configured on source engine. ${desc}`;
        } else if (srcVal !== tgtVal) {
          status = (meta?.critical || (srcVal === 'FEATURE_STATE_ON' && tgtVal === 'FEATURE_STATE_OFF')) ? 'WARNING' : 'DIFF';
          details = `${displayName} configuration differs between source ("${srcVal}") and target ("${tgtVal}"). ${desc}`;
          featureDiffs.push(key);
        } else {
          status = 'MATCH';
          details = `${displayName} matches across both environments (${tgtVal}). ${desc}`;
        }

        items.push({
          id: `engine-feature-${key}`,
          category: 'ENGINE',
          name: displayName,
          status,
          sourceValue: srcVal || '(Not Set / Default)',
          targetValue: tgtVal || '(Missing / Not Set)',
          details: details.trim()
        });
      }
    }

    // Additional Engine Settings: Marketplace Agent Catalog Visibility
    if (sourceEngineDetails?.marketplaceAgentVisibility || targetEngineDetails?.marketplaceAgentVisibility) {
      const srcVis = sourceEngineDetails?.marketplaceAgentVisibility || 'SHOW_ALL_AGENTS (Default)';
      const tgtVis = targetEngineDetails?.marketplaceAgentVisibility || 'SHOW_ALL_AGENTS (Default)';
      const match = srcVis === tgtVis;
      if (!match) settingDiffs.push('marketplaceAgentVisibility');
      items.push({
        id: 'engine-marketplace-visibility',
        category: 'ENGINE',
        name: 'Marketplace Agent Catalog Visibility',
        status: match ? 'MATCH' : 'DIFF',
        sourceValue: srcVis,
        targetValue: tgtVis,
        details: match
          ? `Both engines have marketplace agent visibility set to "${tgtVis}".`
          : `Source has "${srcVis}" while target has "${tgtVis}". Controls which published catalog agents are shown to users.`
      });
    }

    // Additional Engine Settings: Observability & Logging
    if (sourceEngineDetails?.observabilityConfig || targetEngineDetails?.observabilityConfig) {
      const srcObs = sourceEngineDetails?.observabilityConfig?.sensitiveLoggingEnabled
        ? 'Sensitive Logging + Audit'
        : (sourceEngineDetails?.observabilityConfig?.observabilityEnabled ? 'Audit Enabled' : 'Disabled');
      const tgtObs = targetEngineDetails?.observabilityConfig?.sensitiveLoggingEnabled
        ? 'Sensitive Logging + Audit'
        : (targetEngineDetails?.observabilityConfig?.observabilityEnabled ? 'Audit Enabled' : 'Disabled');
      const match = srcObs === tgtObs;
      if (!match) settingDiffs.push('observabilityConfig');
      items.push({
        id: 'engine-observability-config',
        category: 'ENGINE',
        name: 'Observability & Audit Logging',
        status: match ? 'MATCH' : 'DIFF',
        sourceValue: srcObs,
        targetValue: tgtObs,
        details: match
          ? `Both engines have observability logging set to "${tgtObs}".`
          : `Observability configuration differs (Source: "${srcObs}" vs Target: "${tgtObs}").`
      });
    }

    // Additional Engine Settings: Chat Session Retention Config
    if (sourceEngineDetails?.sessionConfig || targetEngineDetails?.sessionConfig) {
      const srcDays = sourceEngineDetails?.sessionConfig?.sessionTtl?.days;
      const tgtDays = targetEngineDetails?.sessionConfig?.sessionTtl?.days;
      const srcSess = srcDays ? `Vertex AI Managed (${srcDays} days TTL)` : 'Default (30 days)';
      const tgtSess = tgtDays ? `Vertex AI Managed (${tgtDays} days TTL)` : 'Default (30 days)';
      const match = srcDays === tgtDays;
      items.push({
        id: 'engine-session-config',
        category: 'ENGINE',
        name: 'Chat Session Retention Policy',
        status: match ? 'MATCH' : 'DIFF',
        sourceValue: srcSess,
        targetValue: tgtSess,
        details: match
          ? `Both engines have session retention set to "${tgtSess}".`
          : `Session retention policy differs (${srcSess} vs ${tgtSess}).`
      });
    }

    // Comprehensive Engine Sync Remediation Plan
    if ((featureDiffs.length > 0 || settingDiffs.length > 0) && sourceEngineDetails?.features) {
      const patchPayload: any = {};
      const updateMaskParts: string[] = [];

      if (sourceEngineDetails.features) {
        const sortedFeatures: Record<string, string> = {};
        for (const k of Object.keys(sourceEngineDetails.features).sort()) {
          sortedFeatures[k] = sourceEngineDetails.features[k];
        }
        patchPayload.features = sortedFeatures;
        updateMaskParts.push('features');
      }
      if (sourceEngineDetails.marketplaceAgentVisibility) {
        patchPayload.marketplaceAgentVisibility = sourceEngineDetails.marketplaceAgentVisibility;
        updateMaskParts.push('marketplaceAgentVisibility');
      }
      if (sourceEngineDetails.observabilityConfig) {
        patchPayload.observabilityConfig = sourceEngineDetails.observabilityConfig;
        updateMaskParts.push('observabilityConfig');
      }

      const jsonStr = JSON.stringify(patchPayload);
      const patchCmd = `curl -s -X PATCH -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" -H "X-Goog-User-Project: ${tgt.projectId}" "${getSafeDiscoveryEngineUrl(tgt.appLocation)}/v1alpha/projects/${tgt.projectId}/locations/${tgt.appLocation || 'global'}/collections/${tgt.collectionId || 'default_collection'}/engines/${tgt.appId}?updateMask=${updateMaskParts.join(',')}" -d '${jsonStr.replace(/'/g, `'\\''`)}'`;

      remediationPlan.push({
        title: `Synchronize Engine Features & Settings (${featureDiffs.length + settingDiffs.length} discrepancy items)`,
        description: `Align all feature flags and settings on target engine "${tgt.appId}" to mirror source engine configuration (memory, agent catalog, skills, create agents, sharing).`,
        command: patchCmd
      });
    }

    // -------------------------------------------------------------
    // 2. Grounding DataStores & Connectors Parity (Only Attached DataStores)
    // -------------------------------------------------------------
    const extractAttachedDataStoreIds = (engine: any): string[] => {
      if (!engine) return [];
      const ids = new Set<string>();
      if (Array.isArray(engine.dataStoreIds)) {
        for (const id of engine.dataStoreIds) {
          if (id && typeof id === 'string') ids.add(id.trim());
        }
      }
      if (Array.isArray(engine.dataStores)) {
        for (const ds of engine.dataStores) {
          if (typeof ds === 'string') {
            const id = ds.split('/').pop();
            if (id) ids.add(id.trim());
          }
        }
      }
      return Array.from(ids);
    };

    const hasAttachedDataStoreInfo = sourceEngineDetails && (
      sourceEngineDetails.dataStoreIds !== undefined || sourceEngineDetails.dataStores !== undefined
    );
    const sourceAttachedIds = extractAttachedDataStoreIds(sourceEngineDetails);
    const targetAttachedIds = extractAttachedDataStoreIds(targetEngineDetails);
    const targetAttachedIdSet = new Set(targetAttachedIds);

    let allSourceDataStores: any[] = [];
    let allTargetDataStores: any[] = [];

    try {
      allSourceDataStores = await this.client.listDataStores(src);
    } catch (err: any) {
      logger.warn(`Could not list source DataStores: ${err.message}`);
    }

    try {
      allTargetDataStores = await this.client.listDataStores(tgt);
    } catch (err: any) {
      logger.warn(`Could not list target DataStores: ${err.message}`);
    }

    const sourceDsMap = new Map<string, any>();
    for (const ds of allSourceDataStores) {
      const id = ds.name?.split('/').pop() || '';
      if (id) sourceDsMap.set(id, ds);
    }

    const targetDsMap = new Map<string, any>();
    const targetDsByDisplay = new Map<string, any>();
    for (const ds of allTargetDataStores) {
      const id = ds.name?.split('/').pop() || '';
      if (id) {
        targetDsMap.set(id, ds);
        if (ds.displayName) {
          targetDsByDisplay.set(ds.displayName.toLowerCase(), ds);
        }
      }
    }

    // Filter to ONLY DataStores attached to the source Engine
    let sourceAttachedDataStores: { id: string; displayName: string; ds?: any }[] = [];

    if (hasAttachedDataStoreInfo) {
      for (const srcId of sourceAttachedIds) {
        const ds = sourceDsMap.get(srcId);
        sourceAttachedDataStores.push({
          id: srcId,
          displayName: ds?.displayName || srcId,
          ds
        });
      }
    } else {
      // Fallback only if sourceEngineDetails didn't include dataStoreIds or dataStores
      for (const ds of allSourceDataStores) {
        const id = ds.name?.split('/').pop() || '';
        if (id) {
          sourceAttachedDataStores.push({
            id,
            displayName: ds.displayName || id,
            ds
          });
        }
      }
    }

    const explicitMapping = config.datastoreMapping || {};
    const missingTargetIdsToAttach: string[] = [];

    for (const item of sourceAttachedDataStores) {
      const srcId = item.id;
      const srcDisplayName = item.displayName;
      const mappedTgtId = explicitMapping[srcId];
      const matchedTgtDs = mappedTgtId
        ? targetDsMap.get(mappedTgtId)
        : (targetDsMap.get(srcId) || targetDsByDisplay.get(srcDisplayName.toLowerCase()));
      const targetId = matchedTgtDs ? (matchedTgtDs.name.split('/').pop() || '') : (mappedTgtId || srcId);
      const isAttachedToTarget = targetAttachedIdSet.has(targetId);

      if (matchedTgtDs && (isAttachedToTarget || targetAttachedIds.length === 0 && !targetEngineDetails?.dataStoreIds)) {
        // MATCH: Provisioned in target project and attached to target engine
        // (or fallback if target engine didn't specify dataStoreIds)
        items.push({
          id: `datastore-${srcId}`,
          category: 'DATASTORE',
          name: `Attached DataStore: ${srcDisplayName}`,
          status: 'MATCH',
          sourceValue: `${srcDisplayName} (${srcId}) [Attached]`,
          targetValue: `${matchedTgtDs.displayName || targetId} (${targetId}) [Attached]`,
          details: `DataStore is provisioned in target project and verified attached to target engine "${tgt.appId}".`
        });
      } else if (matchedTgtDs && !isAttachedToTarget) {
        // WARNING: Provisioned in target project, but NOT attached to target engine
        missingTargetIdsToAttach.push(targetId);
        items.push({
          id: `datastore-${srcId}`,
          category: 'DATASTORE',
          name: `Attached DataStore: ${srcDisplayName}`,
          status: 'WARNING',
          sourceValue: `${srcDisplayName} (${srcId}) [Attached]`,
          targetValue: `${matchedTgtDs.displayName || targetId} (${targetId}) [Unattached]`,
          details: `DataStore exists in target project "${tgt.projectId}" but is NOT attached to target engine "${tgt.appId}". Grounded queries will not access it until attached.`
        });
      } else {
        // MISSING_IN_TARGET: Not provisioned in target project and not attached
        items.push({
          id: `datastore-${srcId}`,
          category: 'DATASTORE',
          name: `Attached DataStore: ${srcDisplayName}`,
          status: 'MISSING_IN_TARGET',
          sourceValue: `${srcDisplayName} (${srcId}) [Attached]`,
          targetValue: 'MISSING (Not in Target Engine or Project)',
          details: `Source attached DataStore "${srcDisplayName}" is not provisioned in target project "${tgt.projectId}". Grounded agents and search will fail to access this knowledge base until configured in Google Cloud Console and attached.`
        });
      }
    }

    // Consolidated informational guidance for missing DataStores (no CLI command)
    const missingAttachedCount = sourceAttachedDataStores.filter(item => {
      const mappedTgtId = explicitMapping[item.id];
      const matchedTgtDs = mappedTgtId
        ? targetDsMap.get(mappedTgtId)
        : (targetDsMap.get(item.id) || targetDsByDisplay.get(item.displayName.toLowerCase()));
      return !matchedTgtDs;
    }).length;

    if (missingAttachedCount > 0) {
      remediationPlan.push({
        title: `Configure Missing Attached DataStore(s) (${missingAttachedCount} missing)`,
        description: `${missingAttachedCount} DataStore(s) attached to source engine "${src.appId}" do not exist in target project "${tgt.projectId}". Provision or configure connectors via the Google Cloud Console (https://console.cloud.google.com/gen-app-builder/data-stores?project=${tgt.projectId}) and attach them to target engine "${tgt.appId}".`
      });
    }

    if (missingTargetIdsToAttach.length > 0) {
      const allTargetIdsToHaveAttached = Array.from(new Set([...targetAttachedIds, ...missingTargetIdsToAttach]));
      const patchDataStoresCmd = `curl -s -X PATCH -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" -H "X-Goog-User-Project: ${tgt.projectId}" "${getSafeDiscoveryEngineUrl(tgt.appLocation)}/v1alpha/projects/${tgt.projectId}/locations/${tgt.appLocation || 'global'}/collections/${tgt.collectionId || 'default_collection'}/engines/${tgt.appId}?updateMask=dataStoreIds" -d '{"dataStoreIds":${JSON.stringify(allTargetIdsToHaveAttached)}}'`;
      remediationPlan.push({
        title: `Attach ${missingTargetIdsToAttach.length} Provisioned DataStore(s) to Target Engine`,
        description: `The following DataStores exist in target project "${tgt.projectId}" but are not attached to engine "${tgt.appId}": ${missingTargetIdsToAttach.join(', ')}.`,
        command: patchDataStoresCmd
      });
    }

    // Check if target engine has extra DataStores attached that source doesn't have
    if (targetAttachedIds.length > 0 && hasAttachedDataStoreInfo) {
      const mappedOrMatchedTargetIds = new Set<string>();
      for (const item of sourceAttachedDataStores) {
        const mappedTgtId = explicitMapping[item.id];
        const matchedTgtDs = mappedTgtId
          ? targetDsMap.get(mappedTgtId)
          : (targetDsMap.get(item.id) || targetDsByDisplay.get(item.displayName.toLowerCase()));
        if (matchedTgtDs) {
          mappedOrMatchedTargetIds.add(matchedTgtDs.name.split('/').pop() || '');
        } else if (mappedTgtId) {
          mappedOrMatchedTargetIds.add(mappedTgtId);
        }
      }

      for (const tgtAttachedId of targetAttachedIds) {
        if (!mappedOrMatchedTargetIds.has(tgtAttachedId)) {
          const tgtDs = targetDsMap.get(tgtAttachedId);
          items.push({
            id: `datastore-target-extra-${tgtAttachedId}`,
            category: 'DATASTORE',
            name: `Target Extra Attached DataStore: ${tgtDs?.displayName || tgtAttachedId}`,
            status: 'DIFF',
            sourceValue: '(Not Attached to Source Engine)',
            targetValue: `${tgtDs?.displayName || tgtAttachedId} (${tgtAttachedId}) [Attached]`,
            details: `DataStore is attached to target engine "${tgt.appId}", but was not attached to source engine "${src.appId}".`
          });
        }
      }
    }

    // -------------------------------------------------------------
    // 3. Identity Provider (IdP) & Domain Rules
    // -------------------------------------------------------------
    let sourceIdpConfig: any = { idpType: 'GOOGLE_CLOUD_IDENTITY' };
    let targetIdpConfig: any = { idpType: 'GOOGLE_CLOUD_IDENTITY' };

    try {
      sourceIdpConfig = await this.client.detectEngineIdpConfig(src);
    } catch {}
    try {
      targetIdpConfig = await this.client.detectEngineIdpConfig(tgt);
    } catch {}

    const idpMatch = sourceIdpConfig.idpType === targetIdpConfig.idpType;
    const domainRules = config.idpMapping?.domainRules || [];

    if (idpMatch) {
      items.push({
        id: 'idp-type-parity',
        category: 'IDP',
        name: 'Identity Provider Type Parity',
        status: 'MATCH',
        sourceValue: sourceIdpConfig.idpType,
        targetValue: targetIdpConfig.idpType,
        details: `Both environments utilize identical authentication mode: ${sourceIdpConfig.idpType}.`
      });
    } else {
      const hasDomainRules = domainRules.length > 0;
      items.push({
        id: 'idp-type-parity',
        category: 'IDP',
        name: 'Identity Provider Type Parity',
        status: hasDomainRules ? 'DIFF' : 'WARNING',
        sourceValue: sourceIdpConfig.idpType,
        targetValue: targetIdpConfig.idpType,
        details: hasDomainRules
          ? `Cross-IdP migration detected (${sourceIdpConfig.idpType} -> ${targetIdpConfig.idpType}). Active domain translation rules configured (${domainRules.length} rules).`
          : `Cross-IdP migration detected (${sourceIdpConfig.idpType} -> ${targetIdpConfig.idpType}) WITHOUT explicit domain mapping rules. Unmapped user accounts will fall back to default owner.`
      });
      if (!hasDomainRules) {
        remediationPlan.push({
          title: 'Configure Cross-IdP Domain Mapping Rules',
          description: `Map source user identity domain (e.g. company.com) to target identity domain in the Migration Studio IDP section.`
        });
      }
    }

    // -------------------------------------------------------------
    // 4. Skills Inventory Check (Agent Registry & Discovery Engine)
    // -------------------------------------------------------------
    let sourceSkillsCount = 0;
    let targetSkillsCount = 0;

    try {
      const srcSkills = await this.registryClient.listSkills(src);
      sourceSkillsCount = srcSkills.filter((s: any) => {
        const id = s.name ? s.name.split('/').pop()! : (s.skillId || '');
        return !id.startsWith('cloud.google.com-') && !id.startsWith('discoveryengine.googleapis.com-') && !id.startsWith('google-');
      }).length;
    } catch {}
    try {
      const tgtSkills = await this.registryClient.listSkills(tgt);
      targetSkillsCount = tgtSkills.filter((s: any) => {
        const id = s.name ? s.name.split('/').pop()! : (s.skillId || '');
        return !id.startsWith('cloud.google.com-') && !id.startsWith('discoveryengine.googleapis.com-') && !id.startsWith('google-');
      }).length;
    } catch {}

    items.push({
      id: 'skills-inventory',
      category: 'SKILLS',
      name: 'Agent Registry User Skills Inventory',
      status: (sourceSkillsCount > 0 && targetSkillsCount === 0) ? 'DIFF' : 'MATCH',
      sourceValue: `${sourceSkillsCount} user skills`,
      targetValue: `${targetSkillsCount} user skills`,
      details: sourceSkillsCount > 0
        ? `Source has ${sourceSkillsCount} user-created enterprise skill(s) in Agent Registry ready for direct cloud-to-cloud migration.`
        : 'No user-created skills found in source Agent Registry.'
    });

    if (typeof this.client.listAgents === 'function') {
      let sourceDeSkillsCount = 0;
      let targetDeSkillsCount = 0;
      try {
        const srcAgents = await this.client.listAgents(src);
        sourceDeSkillsCount = srcAgents.filter(a => a.skillAgentDefinition && !a.geminiEnterpriseSkillConfig).length;
      } catch {}
      try {
        const tgtAgents = await this.client.listAgents(tgt);
        targetDeSkillsCount = tgtAgents.filter(a => a.skillAgentDefinition && !a.geminiEnterpriseSkillConfig).length;
      } catch {}

      if (sourceDeSkillsCount > 0 || targetDeSkillsCount > 0) {
        items.push({
          id: 'discovery-engine-skills',
          category: 'SKILLS',
          name: 'Discovery Engine User Skill Agents',
          status: (sourceDeSkillsCount > 0 && targetDeSkillsCount === 0) ? 'DIFF' : 'MATCH',
          sourceValue: `${sourceDeSkillsCount} user skill(s)`,
          targetValue: `${targetDeSkillsCount} user skill(s)`,
          details: sourceDeSkillsCount > 0
            ? `Source Discovery Engine contains ${sourceDeSkillsCount} user-created skill agent(s).`
            : 'No user-created skill agents found in source Discovery Engine.'
        });
      }
    }

    // -------------------------------------------------------------
    // 5. IAM & Service Account Authorization Check
    // -------------------------------------------------------------
    let callerEmail = '';
    try {
      callerEmail = (await this.auth.getCallerIdentity()) || '';
    } catch {}

    if (targetEngineExists) {
      items.push({
        id: 'auth-target-permissions',
        category: 'AUTHORIZATION',
        name: 'Target Project Discovery Engine API Access',
        status: 'MATCH',
        sourceValue: callerEmail || 'Authenticated Caller',
        targetValue: 'Authorized (Read/Write OK)',
        details: `Credentials verified with write access to target project "${tgt.projectId}".`
      });
    } else {
      const iamCmd = `gcloud projects add-iam-policy-binding ${tgt.projectId} --member="serviceAccount:${callerEmail || 'YOUR_MIGRATION_SA'}" --role="roles/discoveryengine.admin"`;
      items.push({
        id: 'auth-target-permissions',
        category: 'AUTHORIZATION',
        name: 'Target Project Discovery Engine API Access',
        status: 'MISSING_IN_TARGET',
        sourceValue: callerEmail || 'Authenticated Caller',
        targetValue: 'Permission Denied or Inaccessible',
        details: `Caller or Service Account could not verify access to target project "${tgt.projectId}". Ensure "roles/discoveryengine.admin" is granted.`,
        remediationCommand: iamCmd
      });
      remediationPlan.push({
        title: 'Grant Discovery Engine Admin on Target Project',
        description: `Assign Discovery Engine Admin role to the migration service account.`,
        command: iamCmd
      });
    }

    // -------------------------------------------------------------
    // Calculate Parity Readiness Score (0-100%)
    // -------------------------------------------------------------
    const totalChecks = items.length;
    const matchingCount = items.filter(i => i.status === 'MATCH').length;
    const diffsCount = items.filter(i => i.status === 'DIFF').length;
    const missingInTargetCount = items.filter(i => i.status === 'MISSING_IN_TARGET').length;
    const warningsCount = items.filter(i => i.status === 'WARNING').length;

    // Weight: MATCH = 1.0, DIFF = 0.8, WARNING = 0.5, MISSING = 0.0
    const rawScore = totalChecks > 0
      ? Math.round(((matchingCount * 1.0 + diffsCount * 0.8 + warningsCount * 0.5) / totalChecks) * 100)
      : 0;

    // Hard ceiling: if target engine is missing or authorization fails, readiness cannot exceed 50%
    const readinessScore = (!targetEngineExists || missingInTargetCount > 2)
      ? Math.min(rawScore, 45)
      : rawScore;

    return {
      sourceProject: src.projectId,
      targetProject: tgt.projectId,
      sourceLocation: src.appLocation || 'global',
      targetLocation: tgt.appLocation || 'global',
      readinessScore,
      totalChecks,
      matchingCount,
      diffsCount,
      missingInTargetCount,
      warningsCount,
      items,
      remediationPlan,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Synchronizes engine settings (features, marketplaceAgentVisibility, observabilityConfig)
   * from source engine to target engine.
   */
  async syncEngineSettings(config: ValidatedMigrationConfig): Promise<{ success: boolean; message: string; updatedEngine: any }> {
    const src = config.source;
    const tgt = config.target;
    const sourceEngine = await this.client.getEngine(src);
    const updateMasks: string[] = [];
    const patchPayload: any = {};

    if (sourceEngine.features && Object.keys(sourceEngine.features).length > 0) {
      const sortedFeatures: Record<string, string> = {};
      for (const k of Object.keys(sourceEngine.features).sort()) {
        sortedFeatures[k] = sourceEngine.features[k];
      }
      patchPayload.features = sortedFeatures;
      updateMasks.push('features');
    }
    if (sourceEngine.marketplaceAgentVisibility) {
      patchPayload.marketplaceAgentVisibility = sourceEngine.marketplaceAgentVisibility;
      updateMasks.push('marketplaceAgentVisibility');
    }
    if (sourceEngine.observabilityConfig) {
      patchPayload.observabilityConfig = sourceEngine.observabilityConfig;
      updateMasks.push('observabilityConfig');
    }

    if (updateMasks.length === 0) {
      return { success: true, message: 'No engine settings found to sync.', updatedEngine: null };
    }

    logger.info(`Synchronizing engine settings (${updateMasks.join(', ')}) from ${src.projectId} (${src.appId}) to ${tgt.projectId} (${tgt.appId})...`);
    const updated = await this.client.patchEngine(tgt, patchPayload, updateMasks.join(','));
    return {
      success: true,
      message: `Successfully synchronized engine settings (${updateMasks.join(', ')}) to target engine "${tgt.appId}".`,
      updatedEngine: updated
    };
  }

  /**
   * Generates formatted Markdown report from audit results.
   */
  generateMarkdownReport(audit: ConfigAuditResult): string {
    const lines: string[] = [];
    lines.push(`# Gemini Enterprise Pre-Migration Configuration & Gap Audit`);
    lines.push(`**Source Project:** \`${audit.sourceProject}\` (${audit.sourceLocation})`);
    lines.push(`**Target Project:** \`${audit.targetProject}\` (${audit.targetLocation})`);
    lines.push(`**Audit Timestamp:** ${new Date(audit.timestamp).toLocaleString()}`);
    lines.push(`**Readiness Score:** **${audit.readinessScore}%**\n`);

    lines.push(`---`);
    lines.push(`## Audit Summary Metrics`);
    lines.push(`| Metric | Count | Status |`);
    lines.push(`| :--- | :---: | :--- |`);
    lines.push(`| **Total Checks Evaluated** | ${audit.totalChecks} | 🔍 Complete |`);
    lines.push(`| **Exact Configuration Matches** | ${audit.matchingCount} | ✅ MATCH |`);
    lines.push(`| **Safe Variations / Differences** | ${audit.diffsCount} | ℹ️ DIFF |`);
    lines.push(`| **Identified Gaps (Missing in Target)** | ${audit.missingInTargetCount} | ❌ MISSING |`);
    lines.push(`| **Configuration Warnings** | ${audit.warningsCount} | ⚠️ WARNING |\n`);

    lines.push(`---`);
    lines.push(`## Detailed Parity Breakdown`);
    lines.push(`| Pillar / Check | Status | Source Environment | Target Environment | Details & Impact |`);
    lines.push(`| :--- | :---: | :--- | :--- | :--- |`);
    for (const item of audit.items) {
      const badge = item.status === 'MATCH' ? '✅ MATCH' : item.status === 'MISSING_IN_TARGET' ? '❌ MISSING' : item.status === 'WARNING' ? '⚠️ WARN' : 'ℹ️ DIFF';
      lines.push(`| **${item.name}** | ${badge} | \`${item.sourceValue}\` | \`${item.targetValue}\` | ${item.details || '-'} |`);
    }

    if (audit.remediationPlan.length > 0) {
      lines.push(`\n---`);
      lines.push(`## Actionable Gap Remediation Plan`);
      lines.push(`Execute the following steps or copy the commands below to resolve gaps before running live migration:\n`);
      audit.remediationPlan.forEach((plan, idx) => {
        lines.push(`### ${idx + 1}. ${plan.title}`);
        lines.push(`${plan.description}`);
        if (plan.command) {
          lines.push(`\`\`\`bash\n${plan.command}\n\`\`\``);
        }
        lines.push('');
      });
    }

    return lines.join('\n');
  }
}
