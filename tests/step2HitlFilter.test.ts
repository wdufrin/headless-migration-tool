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
import { readIndexHtml, extractFunctionSource } from './helpers/htmlFunctionExtractor.js';

const html = readIndexHtml();

describe('Step 2 Config & Parity Audit — HITL & Action Items Filtering Suite', () => {
  describe('HTML Markup & DOM Element Verification', () => {
    it('contains the Step 2 Global HITL/Action Filter button and live badge', () => {
      expect(html).toContain('id="btnStep2GlobalHitlFilter"');
      expect(html).toContain('onclick="toggleStep2GlobalHitlFilter()"');
      expect(html).toContain('id="step2HitlFilterLabel"');
      expect(html).toContain('id="step2HitlGlobalCountBadge"');
    });

    it('contains interactive onclick handlers on the metric cards', () => {
      expect(html).toContain('onclick="setAuditStatusFilter(\'ALL\')"');
      expect(html).toContain('onclick="setAuditStatusFilter(\'MATCH\')"');
      expect(html).toContain('onclick="setAuditStatusFilter(\'ACTION_NEEDED\')"');
    });

    it('contains the Dynamic Connector & DataStore Mapping filter controls', () => {
      expect(html).toContain('id="cmFilterAll"');
      expect(html).toContain('onclick="setConnectorMappingFilter(\'ALL\')"');
      expect(html).toContain('id="cmFilterHitl"');
      expect(html).toContain('onclick="setConnectorMappingFilter(\'HITL_ONLY\')"');
      expect(html).toContain('id="cmFilterMapped"');
      expect(html).toContain('onclick="setConnectorMappingFilter(\'MAPPED_ONLY\')"');
      expect(html).toContain('id="cmCountAll"');
      expect(html).toContain('id="cmCountHitl"');
      expect(html).toContain('id="cmCountMapped"');
      expect(html).toContain('id="cmSearchInput"');
      expect(html).toContain('oninput="onConnectorSearchInput(this.value)"');
      expect(html).toContain('id="auditConnectorHitlBadge"');
    });

    it('contains the Parity Checklist & Gaps status filter toolbar', () => {
      expect(html).toContain('id="auditStatusBtnAll"');
      expect(html).toContain('id="auditStatusBtnAction"');
      expect(html).toContain('id="auditActionNeededCountBadge"');
      expect(html).toContain('id="auditStatusBtnMatch"');
    });
  });

  describe('Extracted Client Function Execution & Behavioral Logic', () => {
    interface ConnectorEntry {
      kind: 'CONNECTOR_COLLECTION' | 'DATASTORE';
      sourceId: string;
      sourceDisplayName: string;
      sourceNumericId?: string;
      baseName?: string;
      targetId?: string;
      matchStatus: 'EXACT_MATCH' | 'AUTO_MATCHED' | 'NEEDS_HITL' | 'NO_MATCH';
      candidateTargets?: Array<{ id: string; displayName: string }>;
      referencedByAgents?: string[];
      entityMappings?: Array<{
        entityName: string;
        sourceDataStoreId: string;
        targetDataStoreId?: string;
      }>;
    }

    interface AuditItem {
      id: string;
      name: string;
      category: string;
      status: 'MATCH' | 'MISSING_IN_TARGET' | 'WARNING' | 'DIFF';
      sourceValue?: any;
      targetValue?: any;
      details?: string;
    }

    interface AuditDashboardPayload {
      totalChecks: number;
      matchingCount: number;
      missingInTargetCount: number;
      diffsCount: number;
      warningsCount: number;
      readinessScore: number;
      items: AuditItem[];
      connectorMappings?: {
        collectionMapping: Record<string, string>;
        datastoreMapping: Record<string, string>;
        entries: ConnectorEntry[];
      };
    }

    let mockTbodyConnector: { innerHTML: string };
    let mockAutoBadge: { textContent: string };
    let mockHitlBadge: { textContent: string; classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean; classes: Set<string> } };
    let mockCmCountAll: { textContent: string };
    let mockCmCountHitl: { textContent: string };
    let mockCmCountMapped: { textContent: string };
    let mockBtnCmAll: { className: string };
    let mockBtnCmHitl: { className: string };
    let mockBtnCmMapped: { className: string };

    let mockTbodyAudit: { innerHTML: string };
    let mockAuditItemsBadge: { textContent: string };
    let mockAuditActionNeededCountBadge: { textContent: string; classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean; classes: Set<string> } };
    let mockAuditStatusBtnAll: { className: string };
    let mockAuditStatusBtnAction: { className: string };
    let mockAuditStatusBtnMatch: { className: string };
    let mockAuditSearchInput: { value: string };

    let mockStep2HitlGlobalCountBadge: { textContent: string; className: string; classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean; classes: Set<string> } };
    let mockBtnStep2GlobalHitlFilter: { className: string; title: string; setAttribute: (k: string, v: string) => void };
    let mockStep2HitlFilterLabel: { textContent: string };

    function createClassList() {
      const classes = new Set<string>();
      return {
        classes,
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
        contains: (c: string) => classes.has(c)
      };
    }

    function createSandbox() {
      mockTbodyConnector = { innerHTML: '' };
      mockAutoBadge = { textContent: '' };
      mockHitlBadge = { textContent: '', classList: createClassList() };
      mockCmCountAll = { textContent: '' };
      mockCmCountHitl = { textContent: '' };
      mockCmCountMapped = { textContent: '' };
      mockBtnCmAll = { className: '' };
      mockBtnCmHitl = { className: '' };
      mockBtnCmMapped = { className: '' };

      mockTbodyAudit = { innerHTML: '' };
      mockAuditItemsBadge = { textContent: '' };
      mockAuditActionNeededCountBadge = { textContent: '', classList: createClassList() };
      mockAuditStatusBtnAll = { className: '' };
      mockAuditStatusBtnAction = { className: '' };
      mockAuditStatusBtnMatch = { className: '' };
      mockAuditSearchInput = { value: '' };

      mockStep2HitlGlobalCountBadge = { textContent: '', className: '', classList: createClassList() };
      mockBtnStep2GlobalHitlFilter = {
        className: '',
        title: '',
        setAttribute: function(k: string, v: string) { if (k === 'title') this.title = v; }
      };
      mockStep2HitlFilterLabel = { textContent: '' };

      const documentStub = {
        getElementById: (id: string) => {
          switch (id) {
            case 'auditConnectorMappingTableBody': return mockTbodyConnector;
            case 'auditConnectorAutoBadge': return mockAutoBadge;
            case 'auditConnectorHitlBadge': return mockHitlBadge;
            case 'cmCountAll': return mockCmCountAll;
            case 'cmCountHitl': return mockCmCountHitl;
            case 'cmCountMapped': return mockCmCountMapped;
            case 'cmFilterAll': return mockBtnCmAll;
            case 'cmFilterHitl': return mockBtnCmHitl;
            case 'cmFilterMapped': return mockBtnCmMapped;
            case 'auditTableBody': return mockTbodyAudit;
            case 'auditItemsBadge': return mockAuditItemsBadge;
            case 'auditActionNeededCountBadge': return mockAuditActionNeededCountBadge;
            case 'auditStatusBtnAll': return mockAuditStatusBtnAll;
            case 'auditStatusBtnAction': return mockAuditStatusBtnAction;
            case 'auditStatusBtnMatch': return mockAuditStatusBtnMatch;
            case 'auditSearchInput': return mockAuditSearchInput;
            case 'step2HitlGlobalCountBadge': return mockStep2HitlGlobalCountBadge;
            case 'btnStep2GlobalHitlFilter': return mockBtnStep2GlobalHitlFilter;
            case 'step2HitlFilterLabel': return mockStep2HitlFilterLabel;
            default: return null;
          }
        },
        querySelectorAll: (_selector: string) => []
      };

      const escapeHtml = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const srcRenderConnector = extractFunctionSource(html, 'renderConnectorMappingPanel');
      const srcSetConnectorFilter = extractFunctionSource(html, 'setConnectorMappingFilter');
      const srcOnConnectorSearch = extractFunctionSource(html, 'onConnectorSearchInput');
      const srcSetAuditStatusFilter = extractFunctionSource(html, 'setAuditStatusFilter');
      const srcGetStep2Counts = extractFunctionSource(html, 'getStep2HitlRemainingCounts');
      const srcUpdateStep2GlobalCount = extractFunctionSource(html, 'updateStep2HitlGlobalCount');
      const srcToggleStep2Global = extractFunctionSource(html, 'toggleStep2GlobalHitlFilter');
      const srcCheckGlobalSync = extractFunctionSource(html, 'checkGlobalFilterSync');
      const srcFilterAuditTable = extractFunctionSource(html, 'filterAuditTable');
      const srcOnDropdownChange = extractFunctionSource(html, 'onConnectorMappingDropdownChange');

      const fullSource = `
        let activeAuditResult = null;
        let selectedAuditCategory = 'ALL';
        let selectedAuditStatusFilter = 'ALL';
        let connectorMappingFilter = 'ALL';
        let connectorSearchQuery = '';
        let isStep2GlobalHitlFilterActive = false;
        let userCollectionMappingOverrides = {};
        let userDatastoreMappingOverrides = {};

        function loadSavedConnectorMappingOverrides() {}
        function saveConnectorMappingOverrides() {}

        ${srcRenderConnector}
        ${srcSetConnectorFilter}
        ${srcOnConnectorSearch}
        ${srcSetAuditStatusFilter}
        ${srcGetStep2Counts}
        ${srcUpdateStep2GlobalCount}
        ${srcToggleStep2Global}
        ${srcCheckGlobalSync}
        ${srcFilterAuditTable}
        ${srcOnDropdownChange}

        return {
          getActiveAuditResult: () => activeAuditResult,
          setActiveAuditResult: (val) => { activeAuditResult = val; },
          getConnectorFilter: () => connectorMappingFilter,
          setConnectorFilterVal: (val) => { connectorMappingFilter = val; },
          getAuditStatusFilter: () => selectedAuditStatusFilter,
          setAuditStatusFilterVal: (val) => { selectedAuditStatusFilter = val; },
          getIsStep2GlobalActive: () => isStep2GlobalHitlFilterActive,
          setIsStep2GlobalActive: (val) => { isStep2GlobalHitlFilterActive = val; },
          getUserCollectionOverrides: () => userCollectionMappingOverrides,
          getUserDatastoreOverrides: () => userDatastoreMappingOverrides,
          renderConnectorMappingPanel,
          setConnectorMappingFilter,
          onConnectorSearchInput,
          setAuditStatusFilter,
          getStep2HitlRemainingCounts,
          updateStep2HitlGlobalCount,
          toggleStep2GlobalHitlFilter,
          checkGlobalFilterSync,
          filterAuditTable,
          onConnectorMappingDropdownChange
        };
      `;

      const sandboxFactory = new Function('document', 'escapeHtml', fullSource);
      return sandboxFactory(documentStub, escapeHtml);
    }

    const sampleAuditData: AuditDashboardPayload = {
      totalChecks: 4,
      matchingCount: 2,
      missingInTargetCount: 1,
      diffsCount: 1,
      warningsCount: 0,
      readinessScore: 65,
      items: [
        { id: '1', name: 'Identity Provider Match', category: 'SECURITY', status: 'MATCH', sourceValue: 'OKTA', targetValue: 'OKTA' },
        { id: '2', name: 'Engine Schema Definition', category: 'ENGINE', status: 'MATCH', sourceValue: 'v2', targetValue: 'v2' },
        { id: '3', name: 'Grounding DataStore Jira', category: 'DATASTORE', status: 'MISSING_IN_TARGET', sourceValue: 'jira_ds_1', targetValue: '(not found)' },
        { id: '4', name: 'Engine Serving Configuration', category: 'ENGINE', status: 'DIFF', sourceValue: 'chunk_500', targetValue: 'chunk_250' }
      ],
      connectorMappings: {
        collectionMapping: {},
        datastoreMapping: {},
        entries: [
          {
            kind: 'CONNECTOR_COLLECTION',
            sourceId: 'conn_github_123',
            sourceDisplayName: 'GitHub Enterprise',
            sourceNumericId: '123',
            baseName: 'conn_github',
            targetId: 'conn_github_999',
            matchStatus: 'AUTO_MATCHED',
            candidateTargets: [{ id: 'conn_github_999', displayName: 'GitHub Enterprise' }]
          },
          {
            kind: 'DATASTORE',
            sourceId: 'ds_confluence_888',
            sourceDisplayName: 'Confluence Wiki Space',
            sourceNumericId: '888',
            baseName: 'ds_confluence',
            matchStatus: 'NEEDS_HITL',
            candidateTargets: [
              { id: 'ds_confluence_111', displayName: 'Confluence Target A' },
              { id: 'ds_confluence_222', displayName: 'Confluence Target B' }
            ]
          },
          {
            kind: 'DATASTORE',
            sourceId: 'ds_jira_777',
            sourceDisplayName: 'Jira Cloud Tickets',
            sourceNumericId: '777',
            baseName: 'ds_jira',
            matchStatus: 'NEEDS_HITL',
            candidateTargets: [
              { id: 'ds_jira_target', displayName: 'Jira Target' }
            ]
          }
        ]
      }
    };

    it('Connector Mapping Panel correctly tallies total, mapped, and HITL required counts', () => {
      const sandbox = createSandbox();
      sandbox.setActiveAuditResult(sampleAuditData);

      sandbox.renderConnectorMappingPanel(sampleAuditData);

      expect(mockCmCountAll.textContent).toBe('3');
      expect(mockCmCountHitl.textContent).toBe('2');
      expect(mockCmCountMapped.textContent).toBe('1');
      expect(mockAutoBadge.textContent).toBe('1 Mapped');
      expect(mockHitlBadge.textContent).toBe('⚠️ 2 HITL Required');
      expect(mockHitlBadge.classList.contains('hidden')).toBe(false);
    });

    it('Filtering to HITL_ONLY in Connector Mapping displays only items needing action', () => {
      const sandbox = createSandbox();
      sandbox.setActiveAuditResult(sampleAuditData);

      // In ALL mode, all 3 entries are in HTML
      sandbox.setConnectorFilterVal('ALL');
      sandbox.renderConnectorMappingPanel(sampleAuditData);
      expect(mockTbodyConnector.innerHTML).toContain('conn_github_123');
      expect(mockTbodyConnector.innerHTML).toContain('ds_confluence_888');
      expect(mockTbodyConnector.innerHTML).toContain('ds_jira_777');

      // Switch to HITL_ONLY
      sandbox.setConnectorMappingFilter('HITL_ONLY');
      expect(sandbox.getConnectorFilter()).toBe('HITL_ONLY');
      expect(mockBtnCmHitl.className).toContain('bg-amber-600');

      // Now auto-matched GitHub must NOT be rendered, only Confluence and Jira
      expect(mockTbodyConnector.innerHTML).not.toContain('conn_github_123');
      expect(mockTbodyConnector.innerHTML).toContain('ds_confluence_888');
      expect(mockTbodyConnector.innerHTML).toContain('ds_jira_777');
    });

    it('Resolving a HITL connector immediately removes it from HITL_ONLY view and decrements counts', () => {
      const sandbox = createSandbox();
      sandbox.setActiveAuditResult(sampleAuditData);
      sandbox.setConnectorMappingFilter('HITL_ONLY');

      // Initially 2 HITL items
      expect(mockCmCountHitl.textContent).toBe('2');
      expect(mockTbodyConnector.innerHTML).toContain('ds_confluence_888');

      // Operator maps Confluence to ds_confluence_111
      const selectStub = { value: 'ds_confluence_111' };
      sandbox.onConnectorMappingDropdownChange('DATASTORE', 'ds_confluence_888', selectStub);

      // HITL count decrements to 1, Confluence is gone from HITL_ONLY view!
      expect(mockCmCountHitl.textContent).toBe('1');
      expect(mockCmCountMapped.textContent).toBe('2');
      expect(mockTbodyConnector.innerHTML).not.toContain('ds_confluence_888');
      expect(mockTbodyConnector.innerHTML).toContain('ds_jira_777');

      // Operator now maps Jira to ds_jira_target
      const selectJira = { value: 'ds_jira_target' };
      sandbox.onConnectorMappingDropdownChange('DATASTORE', 'ds_jira_777', selectJira);

      // Now 0 HITL items remain!
      expect(mockCmCountHitl.textContent).toBe('0');
      expect(mockCmCountMapped.textContent).toBe('3');
      // Success zero-state is displayed!
      expect(mockTbodyConnector.innerHTML).toContain('Zero HITL Actions Remaining!');
      expect(mockTbodyConnector.innerHTML).toContain('All 3 discovered Connectors and DataStores have resolved targets');
    });

    it('Parity Checklist filter correctly isolates ACTION_NEEDED items from MATCH items', () => {
      const sandbox = createSandbox();
      sandbox.setActiveAuditResult(sampleAuditData);

      // In ALL mode, all 4 items render
      sandbox.setAuditStatusFilter('ALL');
      expect(mockAuditItemsBadge.textContent).toBe('4 Items');
      expect(mockTbodyAudit.innerHTML).toContain('Identity Provider Match');
      expect(mockTbodyAudit.innerHTML).toContain('Engine Schema Definition');
      expect(mockTbodyAudit.innerHTML).toContain('Grounding DataStore Jira');
      expect(mockTbodyAudit.innerHTML).toContain('Engine Serving Configuration');

      // Switch to ACTION_NEEDED (items needing action: MISSING_IN_TARGET & DIFF)
      sandbox.setAuditStatusFilter('ACTION_NEEDED');
      expect(sandbox.getAuditStatusFilter()).toBe('ACTION_NEEDED');
      expect(mockAuditItemsBadge.textContent).toBe('2 Items');
      expect(mockAuditActionNeededCountBadge.textContent).toBe('2');
      expect(mockAuditActionNeededCountBadge.classList.contains('hidden')).toBe(false);

      // Matches must NOT be in the table
      expect(mockTbodyAudit.innerHTML).not.toContain('Identity Provider Match');
      expect(mockTbodyAudit.innerHTML).not.toContain('Engine Schema Definition');
      // Action items must be present
      expect(mockTbodyAudit.innerHTML).toContain('Grounding DataStore Jira');
      expect(mockTbodyAudit.innerHTML).toContain('Engine Serving Configuration');

      // Switch to MATCH mode
      sandbox.setAuditStatusFilter('MATCH');
      expect(mockAuditItemsBadge.textContent).toBe('2 Items');
      expect(mockTbodyAudit.innerHTML).toContain('Identity Provider Match');
      expect(mockTbodyAudit.innerHTML).toContain('Engine Schema Definition');
      expect(mockTbodyAudit.innerHTML).not.toContain('Grounding DataStore Jira');
    });

    it('Parity Checklist shows success zero-state when all items match', () => {
      const sandbox = createSandbox();
      const cleanAudit: AuditDashboardPayload = {
        totalChecks: 2,
        matchingCount: 2,
        missingInTargetCount: 0,
        diffsCount: 0,
        warningsCount: 0,
        readinessScore: 100,
        items: [
          { id: '1', name: 'Item A', category: 'SECURITY', status: 'MATCH' },
          { id: '2', name: 'Item B', category: 'ENGINE', status: 'MATCH' }
        ]
      };
      sandbox.setActiveAuditResult(cleanAudit);

      sandbox.setAuditStatusFilter('ACTION_NEEDED');
      expect(mockAuditActionNeededCountBadge.textContent).toBe('0');
      expect(mockAuditActionNeededCountBadge.classList.contains('hidden')).toBe(true);
      expect(mockTbodyAudit.innerHTML).toContain('100% Configuration Parity Achieved!');
    });

    it('Global Step 2 Filter Button toggles both boxes into Action/HITL view simultaneously', () => {
      const sandbox = createSandbox();
      sandbox.setActiveAuditResult(sampleAuditData);

      // Before toggle: both ALL
      expect(sandbox.getIsStep2GlobalActive()).toBe(false);
      expect(sandbox.getConnectorFilter()).toBe('ALL');
      expect(sandbox.getAuditStatusFilter()).toBe('ALL');

      // Toggle ON
      sandbox.toggleStep2GlobalHitlFilter();
      expect(sandbox.getIsStep2GlobalActive()).toBe(true);
      expect(sandbox.getConnectorFilter()).toBe('HITL_ONLY');
      expect(sandbox.getAuditStatusFilter()).toBe('ACTION_NEEDED');
      expect(mockBtnStep2GlobalHitlFilter.className).toContain('bg-amber-600');
      expect(mockStep2HitlFilterLabel.textContent).toBe('Show All Step 2 Items');

      // Both boxes are filtered:
      // Connector mapping shows only HITL (Confluence and Jira, NOT github)
      expect(mockTbodyConnector.innerHTML).not.toContain('conn_github_123');
      expect(mockTbodyConnector.innerHTML).toContain('ds_confluence_888');
      // Parity table shows only action items (Jira DS missing, Engine serving diff)
      expect(mockTbodyAudit.innerHTML).not.toContain('Identity Provider Match');
      expect(mockTbodyAudit.innerHTML).toContain('Grounding DataStore Jira');

      // Toggle OFF
      sandbox.toggleStep2GlobalHitlFilter();
      expect(sandbox.getIsStep2GlobalActive()).toBe(false);
      expect(sandbox.getConnectorFilter()).toBe('ALL');
      expect(sandbox.getAuditStatusFilter()).toBe('ALL');
      expect(mockBtnStep2GlobalHitlFilter.className).toContain('bg-gray-800');
      expect(mockStep2HitlFilterLabel.textContent).toBe('Filter: Action / HITL Only');
    });

    it('Global badge accurately computes total actions remaining across Step 2 boxes', () => {
      const sandbox = createSandbox();
      sandbox.setActiveAuditResult(sampleAuditData);

      // 2 connector HITL + 2 parity action items = 4 total remaining
      const counts = sandbox.getStep2HitlRemainingCounts();
      expect(counts.connectorHitlCount).toBe(2);
      expect(counts.parityActionCount).toBe(2);
      expect(counts.totalRemaining).toBe(4);

      sandbox.updateStep2HitlGlobalCount();
      expect(mockStep2HitlGlobalCountBadge.textContent).toBe('4');
      expect(mockStep2HitlGlobalCountBadge.className).toContain('bg-amber-950');
      expect(mockStep2HitlGlobalCountBadge.classList.contains('hidden')).toBe(false);
    });

    it('Search input in Connector Mapping filters by display name, id, and entity sources', () => {
      const sandbox = createSandbox();
      sandbox.setActiveAuditResult(sampleAuditData);

      sandbox.onConnectorSearchInput('github');
      expect(mockTbodyConnector.innerHTML).toContain('GitHub Enterprise');
      expect(mockTbodyConnector.innerHTML).not.toContain('Confluence');
      expect(mockTbodyConnector.innerHTML).not.toContain('Jira');

      sandbox.onConnectorSearchInput('confluence');
      expect(mockTbodyConnector.innerHTML).not.toContain('GitHub');
      expect(mockTbodyConnector.innerHTML).toContain('Confluence Wiki Space');

      // Non-matching search
      sandbox.onConnectorSearchInput('nonexistent-service');
      expect(mockTbodyConnector.innerHTML).toContain('No Connectors or DataStores match "nonexistent-service"');
    });

    it('Gracefully handles empty and adversarial inputs without throwing exceptions', () => {
      const sandbox = createSandbox();
      // Null audit
      expect(() => sandbox.renderConnectorMappingPanel(null)).not.toThrow();
      expect(() => sandbox.filterAuditTable()).not.toThrow();
      expect(() => sandbox.updateStep2HitlGlobalCount()).not.toThrow();

      // Empty entries
      const emptyAudit = { totalChecks: 0, matchingCount: 0, missingInTargetCount: 0, diffsCount: 0, warningsCount: 0, readinessScore: 0, items: [] };
      sandbox.setActiveAuditResult(emptyAudit);
      expect(() => sandbox.renderConnectorMappingPanel(emptyAudit)).not.toThrow();
      expect(mockTbodyConnector.innerHTML).toContain('No Connectors or DataStores discovered');
      expect(mockAutoBadge.textContent).toBe('0 Connectors / DataStores');
      expect(mockHitlBadge.classList.contains('hidden')).toBe(true);

      expect(() => sandbox.filterAuditTable()).not.toThrow();
      expect(mockTbodyAudit.innerHTML).toContain('No items match');
    });
  });
});
