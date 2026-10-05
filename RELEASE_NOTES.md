# 🚀 Gemini Enterprise Admin Migration Platform (`gemini-migrate`)
## Release Notes — Version 1.7.0

**Release Date:** October 5, 2026  
**License:** Apache-2.0  
**Build Target:** Node.js >= 20.0.0 / TypeScript 5.x  

---

### Executive Summary

Gemini Enterprise Admin Migration Platform (`gemini-migrate`) **v1.7.0** introduces **Step 3 Worker Concurrency Control (`#optConcurrency`) with Adaptive Source Read Throttling**, the **Ignore Draft Agents (`excludeDraftAgents` / `--exclude-draft-agents`)** sub-option to skip unsaved UI draft agents (`"My Agent"` / `"My Workflow"`) while migrating both **Private (created/deployed)** and **Published/Shared** agents, and **Honest Notebook Source Failure Reporting** by removing the `[Restored Source: ...]` metadata stub when a notebook source cannot be migrated or times out during fetch. v1.7.0 includes **375 passing automated tests across 31 test suites at 100%**.

---

### 🌟 Key Highlights & New Features

#### 1. ⚡ Step 3 Worker Concurrency Control & Adaptive Source Read Throttling (`public/index.html` & `src/engines/notebookMigrator.ts`)
* **Configurable Parallel Worker Concurrency in Step 3**: Operators can now select **Worker Concurrency (`1`, `2`, `3`, `5`, `10`, or `20` Parallel API Workers)** directly inside Step 3 (*Migration Scope, Sharing & Delegation*).
* **Per-Notebook Source Fetch Throttling**: Lowering concurrency to `1` or `2` automatically scales down inner per-notebook `getNotebookSource` concurrency (`Math.min(3, Math.max(1, options.concurrency || 10))`), preventing 30-second read timeouts when migrating large notebooks containing dozens of heavy PDFs.

#### 2. 🚫 Ignore Draft Agents Sub-Option (`Private & Published Only`) (`public/index.html`, `src/engines/agentMigrator.ts`, `src/cli.ts`)
* **Step 3 Sub-Checkbox & CLI Flag**: Added the indented **`🚫 Ignore Draft Agents (Private & Published Only)`** checkbox (`#optExcludeDraftAgents`) directly underneath **🤖 Migrate Agents & Workflows** in Step 3 (synchronized with `#optAgentLifecycle` and `--exclude-draft-agents` on the CLI).
* **Accurate Draft vs. Private vs. Published Classification**: `AgentMigrator.isSourceAgentPublished` and `AgentMigrator.isSourceAgentDraft` inspect `state`, `sharingConfig.scope`, `lowCodeAgentDefinition.deployedNodes` / `deployedRootAgentId`, `workflowAgentDefinition.deployedAgentFlow`, and `activeRevision` so unsaved/undeployed UI drafts (such as auto-created `"My Agent"` and `"My Workflow"` stubs with `validationErrors`) are skipped while both **Private (author-only created)** and **Published/Shared** agents are migrated.

#### 3. 🛡️ Honest Notebook Source Failure Reporting (Removed Fake `[Restored Source: ...]` Metadata Stub) (`src/engines/notebookMigrator.ts` & `src/services/reporter.ts`)
* **No Fabricated Source Placeholders**: Removed the `[Restored Source: ...]` text stub from `NotebookMigrator.mapSourceToPayload(source)`. If `getNotebookSource` fails (`_fetchError`) or a source only contains bare metadata without extracted text, Google Drive ID, YouTube URL, Agentspace document, or Web URL, `mapSourceToPayload` returns `null`.
* **Dry Run & Live Run Parity**: Both Dry Run and Live Run modes now evaluate every source and honestly report `sourcesFailed`, `FAILED` (when `getNotebookSource` errors/times out), and `MANUAL_REUPLOAD_REQUIRED` (when binary content is unavailable across tenants), marking affected users as `🟡 PARTIALLY MIGRATED` in the Markdown reconciliation table.

#### 4. 🧪 Automated Test Suite Stability (375/375 Tests Passing across 31 suites)
* Added unit, behavioral, and negative/adversarial tests in `tests/notebookMigrator.test.ts` and `tests/agentMigrator.test.ts` covering unmigratable/timed-out notebook sources, Dry Run vs. Live Run source reporting, `concurrency` schema bounds, and Draft vs. Private vs. Published agent filtering.

---

## Release Notes — Version 1.6.3

**Release Date:** October 2, 2026  
**License:** Apache-2.0  
**Build Target:** Node.js >= 20.0.0 / TypeScript 5.x  

---

### Executive Summary

Gemini Enterprise Admin Migration Platform (`gemini-migrate`) **v1.6.3** resolves a **Multi-Page Agent Pagination Bug in Step 3 User Discovery & Auto-Mapping** (`GET /api/users/discover` and `POST /api/idp/auto-map`) where engines with `> 100` agents previously only inspected the first 100 agents (`?pageSize=100` without following `nextPageToken`), causing agent owners on subsequent pages to be omitted from `userFilter` and producing inconsistent discovered agent counts across runs. v1.6.3 also sanitizes `package-lock.json` to use public `https://registry.npmjs.org/` tarball URLs and includes **369 passing automated tests across 31 test suites at 100%**.

---

### 🌟 Key Highlights & Fixes

#### 1. 🔄 Full Multi-Page Agent Pagination in User Discovery (`src/routes/discovery.ts` & `src/routes/wizard.ts`)
* **Complete Agent Enumeration**: Both `GET /api/users/discover` and `POST /api/idp/auto-map` now loop through all `nextPageToken` pages (with `seenPageTokens` cycle protection) so every custom agent and skill agent across engines with hundreds of agents is inspected for direct ownership and IAM policy bindings.
* **Batched IAM Policy Inspection in Auto-Map**: Updated `POST /api/idp/auto-map` to fetch `:getIamPolicy` in concurrent batches of 10 (`Promise.all`), matching `discovery.ts` and avoiding sequential request bottlenecks on large engines.

#### 2. 📦 Public Registry `package-lock.json` Sanitization
* Replaced internal proxy `"resolved"` URLs in `package-lock.json` with `https://registry.npmjs.org/` so external customer deployments can run `npm ci` / `npm install` cleanly.

#### 3. 🧪 Automated Test Suite Stability (369/369 Tests Passing across 31 suites)
* Added `tests/userDiscoveryPagination.test.ts` covering multi-page agent pagination, IAM binding extraction, non-user principal filtering, cyclic `nextPageToken` termination, and HTTP 403 warning propagation.

---

## Release Notes — Version 1.6.2

**Release Date:** October 1, 2026  
**License:** Apache-2.0  
**Build Target:** Node.js >= 20.0.0 / TypeScript 5.x  

---

### Executive Summary

Gemini Enterprise Admin Migration Platform (`gemini-migrate`) **v1.6.2** introduces **Comprehensive Step 2 HITL & Action Items Filtering** and **Targeted User Discovery Enhancements**. Operators can now instantly filter Step 2 (`Config & Parity Audit`) down to only items requiring human action (`Needs HITL` in Dynamic Connector Mapping, `Action Needed` in Parity Checklist & Gaps, or globally via `#btnStep2GlobalHitlFilter` with unified remaining action badge `#step2HitlGlobalCountBadge`). In Targeted User Selection, operators can clear staging lists with a 1-click **"Delete All"** button, and user management now robustly handles email addresses containing single quotes / apostrophes without JavaScript syntax errors. v1.6.2 includes **366 passing automated tests across 30 test suites at 100%**.

---

### 🌟 Key Highlights & New Features

#### 1. ⚡ Step 2 Config & Parity Audit — HITL & Action Items Filtering
* **Dynamic Connector & DataStore Mapping Filter Toolbar**:
  * Added filter buttons (`All`, `⚠️ Needs HITL`, `Mapped`), real-time search input (`#cmSearchInput`), and an interactive `#auditConnectorHitlBadge` trigger.
  * When an operator selects a target from the dropdown or inputs a custom target ID, the entry dynamically transitions out of `NEEDS_HITL` (`HITL_CONFIRMED`) and immediately leaves the `HITL_ONLY` view with real-time count decrementing.
  * When all items are resolved, the table renders a celebratory zero-state: `🎉 Zero HITL Actions Remaining!`.
* **Parity Checklist & Gaps Status Filters**:
  * Added filter buttons (`All Statuses`, `⚠️ Action Needed`, `Matches`) to isolate actionable gaps (`MISSING_IN_TARGET`, `WARNING`, `DIFF`) from `MATCH` checks.
  * Made top metric cards ("Missing in Target (Gaps)" and "Differences / Warnings") interactive click triggers for `ACTION_NEEDED`.
  * Displays celebratory zero-state when all checks match: `🎉 100% Configuration Parity Achieved!`.
* **Global Step 2 Action Filter (`#btnStep2GlobalHitlFilter`)**:
  * 1-click master filter in the audit header that simultaneously filters both panels to show only items needing action.
  * Includes a live unified remaining action count badge (`#step2HitlGlobalCountBadge`) showing total remaining actions across both boxes.

#### 2. 👥 Targeted User Selection & Discovery Enhancements
* **"Delete All" User Action**: Added quick clear buttons across section headers and table action columns to easily wipe discovered users and reset staging fields before new CSV imports.
* **Apostrophe & Special Character Resilience**: Hardened deletion and selection handlers against email addresses containing apostrophes (e.g., `o'connor@company.com`) using HTML5 `data-email` dataset passing instead of string literal interpolation.

#### 3. 🧪 Automated Test Suite Stability (366/366 Tests Passing across 30 suites)
* Full 366 automated unit, DOM, and behavioral tests passing across 30 test suites with zero failures or skipped assertions.

---

## Release Notes — Version 1.6.1

**Release Date:** September 30, 2026  
**License:** Apache-2.0  
**Build Target:** Node.js >= 20.0.0 / TypeScript 5.x  

---

### Executive Summary

Gemini Enterprise Admin Migration Platform (`gemini-migrate`) **v1.6.1** resolves a hang during multi-notebook migrations by fixing an infinite retry loop in `retryWithBackoff` (missing `attempt++` counter increment on HTTP `429`/`5xx` responses), enforcing per-request `AbortSignal.timeout` (default `30s`) across `DiscoveryEngineClient` and `AgentRegistryClient`, emitting 15-second SSE `: keepalive` heartbeats on `/api/migrate/stream` to prevent proxy/browser stream disconnects (`network error`), and surfacing all notebook/source/artifact fetch warnings and large-notebook progress in real time. v1.6.1 includes **327 passing automated tests across 26 test suites at 100%**.

---

## Release Notes — Version 1.6.0

**Release Date:** September 28, 2026  
**License:** Apache-2.0  
**Build Target:** Node.js >= 20.0.0 / TypeScript 5.x  

---

### Executive Summary

Gemini Enterprise Admin Migration Platform (`gemini-migrate`) **v1.6.0** introduces **Dynamic Connector & DataStore Auto-Mapping (`_#####` Instance Matching)** with **Human-in-the-Loop (HITL) Validation** in Step 2 (`Config & Parity Audit`) and at migration runtime. This resolves the Discovery Engine `v1alpha` issue where a No-Code Agent (`lowCodeAgentDefinition`) with 1 Connector source in the source project could split into 3 (or $N$) ungrouped DataStore sources in the restored target project when the parent `collections/{id}/dataConnector` and child `{id}_{entity}` DataStores had different `_#####` numeric instance suffixes. v1.6.0 also includes **Shared Admin Notebook HITL Validation** (`--prompt-admin-hitl`) and **323 passing automated tests across 26 test suites at 100%**.

---

### 🌟 Key Highlights & New Features

#### 1. 🔌 Dynamic Connector & Child Entity DataStore Auto-Mapping (`_#####` Matching)
* **Synchronized Connector & Entity Rewriting (`connectorMatcher.ts` & `agentMigrator.ts`)**: In Discovery Engine `v1alpha`, attaching 1 Connector (e.g., GitHub, Jira, ServiceNow) to a No-Code Agent writes both a relative parent connector reference (`"collections/github_1773757636775/dataConnector"`) and $N$ child entity DataStores (`github_1773757636775_issue`, `_pull_request`, `_repository`). `buildConnectorAndDataStoreMappings()` and `buildAgentPayload()` now use Regex Pattern Matching (`parseTimestampedResourceId`) to automatically map both the parent Connector Collection and all child entity DataStores together when Source and Destination share the same base name / `displayName` with different `_#####` identifiers, preserving a single unified Connector source in the target UI.
* **Clean Connector Stripping (`__STRIP__`)**: Operators can select `Strip / Remove Connector (__STRIP__)` for deprecated or unprovisioned source connectors, cleanly removing both `dataConnectors` and their child `dataStoreSpecs.specs` from `llmAgentNode` and `llmAgentNode.selectedTools`.

#### 2. 🛑 Step 2 Interactive Connector Mapping Table & Runtime HITL Fallback
* **Step 2 Dynamic Mapping Panel (`#audit`)**: Running **Run Pre-Check** in Step 2 inspects `listCollections` and `listDataStores` across Source and Target environments, automatically pairs `_#####` matches (`AUTO_MATCHED` / `EXACT_MATCH`), and highlights ambiguous (multiple target candidates with the same base name) or missing connectors as `NEEDS_HITL`. Operators can resolve any mapping via live target dropdowns, custom target IDs, or `__STRIP__`.
* **Runtime Migration HITL Modal (`connector_mapping_hitl`)**: If a migration is started while selected agents still reference unmapped connectors, `AgentMigrator` emits a `connector_mapping_hitl` SSE event and pauses for operator confirmation via `#connectorHitlModal` before building agent payloads (configurable via `promptForConnectorHitl` / `--no-connector-hitl`).

#### 3. 📓 Shared Admin Notebook HITL Validation (`promptForAdminNotebookHitl`)
* **End-of-Run Admin Notebook Verification**: When `promptForAdminNotebookHitl` (`--prompt-admin-hitl`) is enabled, shared notebooks discovered under project-level Admin accounts are queued for explicit operator review (`admin_notebook_hitl` SSE event & modal) before migration so colleague-created shared notebooks are only migrated when explicitly approved.

#### 4. 🧪 Automated Test Suite Stability (323/323 Tests Passing)
* Full 323 automated unit, integration, and adversarial input validation tests passing across 26 test suites with zero failures or skipped assertions.

---

## Release Notes — Version 1.5.8

**Release Date:** September 25, 2026  
**License:** Apache-2.0  
**Build Target:** Node.js >= 20.0.0 / TypeScript 5.x  

---

### Executive Summary

Gemini Enterprise Admin Migration Platform (`gemini-migrate`) **v1.5.8** introduces **Dry Run Permission Elevation Detection for NotebookLM**, identifying when an impersonated user's token holds project-level `discoveryengine.notebooks.delete` (Admin permissions) which causes Google's Discovery Engine API to classify the user as `PROJECT_ROLE_OWNER` on ALL shared notebooks across the project (causing colleague-owned shared notebooks to be migrated under their account). v1.5.8 hardens the **Workforce Identity Federation (WiF) Role Architecture** by standardizing on `roles/discoveryengine.user` for the Workforce Pool, excludes admin roles from WiF group injection, and provides 313 passing automated tests at 100%.

---

### 🌟 Key Highlights & New Features

#### 1. 🔍 Dry Run Permission Elevation Detection for NotebookLM
* **Detection of Project-Level Admin Permissions**: When migrating notebooks for federated users, the tool checks whether the impersonated token holds `discoveryengine.notebooks.delete` at the GCP project level (typically inherited from `roles/discoveryengine.admin` or `roles/owner` on the Workforce Pool or an admin group).
* **Blast Radius Explanation**: Google Cloud's Discovery Engine / NotebookLM API checks IAM `TestPermissions` on each notebook for `discoveryengine.notebooks.delete`. If granted (even via project inheritance), the backend classifies the user as `PROJECT_ROLE_OWNER` (`get.isShared = false`), causing the tool to treat colleague-created shared notebooks as if they were owned by the current user.
* **Actionable Remediation Warnings**: Emits high-visibility `[DRY RUN AUDIT: PERMISSION ELEVATION]` warnings during pre-flight checks and per-user notebook discovery with exact `gcloud` remediation commands to replace `roles/discoveryengine.admin` with `roles/discoveryengine.user`.

#### 2. 🛡️ Workforce Identity Federation (WiF) Least-Privilege Role Hardening
* **Setup Wizard Role Realignment**: The Setup Wizard (`Step 1: Auth & Prerequisites`) now generates `gcloud projects add-iam-policy-binding` with `roles/discoveryengine.user` (instead of `roles/discoveryengine.admin`) for `principalSet://iam.googleapis.com/locations/global/workforcePools/${poolId}/*`.
* **Admin Group Filtering in Group Scraper**: `wifPreflight.ts` explicitly filters out admin roles (`roles/discoveryengine.admin`, `roles/discoveryengine.agentspaceAdmin`, `roles/discoveryengine.notebookLmOwner`, `roles/owner`, `roles/editor`) during pool group discovery so that impersonated end-user tokens never inherit unintended project-wide delete privileges.

#### 3. 🧪 Automated Test Suite Stability (313/313 Tests Passing)
* Full 313 automated tests passing across 26 test suites with zero failures.

---

## Release Notes — Version 1.5.7

**Release Date:** September 22, 2026  
**License:** Apache-2.0  
**Build Target:** Node.js >= 20.0.0 / TypeScript 5.x  

---

### Executive Summary

Gemini Enterprise Admin Migration Platform (`gemini-migrate`) **v1.5.7** introduces **Resilient Multi-User Chat History Migration** with full session hydration (`getSession` with `includeAnswerDetails=true`) eliminating 404 errors on unroutable `assistAnswers` endpoints, **Authentic Companion-Turn Deduplication** preserving real Gemini responses and citations, **Target Duplicate Collision Prevention** via `source-session-id` tracking labels, **Strict Targeted User Filtering** on chat sessions, **Notebook Studio Source Deduplication**, and **307 automated tests passing at 100%**.

---

### 🌟 Key Highlights & New Features

#### 1. 💬 Resilient Multi-User Chat History Migration & Full Session Hydration
* **404 Elimination on Discovery Engine Assist Answers**: The Google Discovery Engine API Spanner model does not expose `assistAnswers` as publicly routable sub-resources. v1.5.7 implements single-flight session hydration (`getSession(sessionName, userEmail)`) querying `GET /v1alpha/{session}?includeAnswerDetails=true` with in-memory caching, eliminating all 404 errors during migration and artifact discovery.
* **Full Turn Discovery View**: `SessionMigrator.listSourceSessions` now fetches sessions using `view=SESSION_VIEW_FULL` and per-user filtering (`filter=user_pseudo_id="..."`), providing complete conversational turns, citations, and interactive artifacts directly in-turn.
* **Inline Artifact Discovery**: `ArtifactExtractor` scans inline `detailedAssistAnswer` and `detailedAnswer` before falling back to cached answers, dramatically speeding up artifact scans across large engines.

#### 2. 🤖 Authentic Companion-Turn Deduplication
* **Gemini Response Preservation**: In Discovery Engine, multi-turn conversations are recorded in split turns (query-only followed by query + `detailedAssistAnswer`). Turn consolidation now properly pairs companion turns so the authentic Gemini answer and reasoning are preserved, and fallback archived stubs are only applied when all turns in a session lack an answer.
* **Thought & Citation Grounding**: Reasoning thoughts (`💭 *Reasoning:* ...`) and document citations (`[[section:...]]`) remain preserved and cleanly rendered in restored sessions.

#### 3. 🎯 Targeted User Session Filtering & Duplicate Collision Prevention
* **Strict User Filtering**: Step 5 of `MigrationRunner` enforces strict filtering against `config.options.userFilter`, ensuring only sessions belonging to selected users are migrated rather than background engine sessions.
* **Source Session Tracking Labels**: Restored sessions are stamped with `source-session-id:${srcSessionId}` labels and query fingerprints to guarantee idempotency and avoid duplicate session creation collisions in target engines.

#### 4. 📓 Notebook Studio Source Deduplication
* **Duplicate Source Prevention**: Fixed source file restoration in `NotebookMigrator` to prevent duplicate source attachments during notebook re-creation in target workspaces.

#### 5. 🧪 Automated Test Suite Stability (307/307 Tests Passing)
* Full 307-test automated suite across 26 test suites running at 100% pass rate with zero skipped or fake assertions.

---

### 📦 Upgrade Guide (v1.6.3 &rarr; v1.7.0)

1. **Pull Latest Changes & Install Dependencies**:
   ```bash
   git pull origin main
   npm install
   ```
2. **Verify Environment & Run Tests**:
   ```bash
   npm run typecheck
   npm test
   ```
3. **Launch Platform**:
   ```bash
   # Web Console
   npm run ui

   # Headless CLI
   npx tsx src/cli.ts --config migration-config.json
   ```

---

### 📜 Version History

* **v1.7.0** *(Current)*: Added Step 3 Worker Concurrency selector (`#optConcurrency`) with adaptive per-notebook source read throttling, added Ignore Draft Agents sub-option (`excludeDraftAgents` / `--exclude-draft-agents`) to migrate Private (created) and Published/Shared agents while skipping unsaved UI drafts, removed the fake `[Restored Source: ...]` metadata stub in `NotebookMigrator` in favor of honest `FAILED` / `MANUAL_REUPLOAD_REQUIRED` reporting in both Dry Run and Live Run modes, and expanded to 375 passing tests across 31 test suites.
* **v1.6.3**: Fixed multi-page agent pagination (`nextPageToken`) in Step 3 User Discovery (`GET /api/users/discover`) and IdP Auto-Mapping (`POST /api/idp/auto-map`), batched `:getIamPolicy` lookups in auto-map, sanitized `package-lock.json` resolved URLs to `https://registry.npmjs.org/`, and expanded to 369 passing tests across 31 test suites.
* **v1.6.2**: Added comprehensive Step 2 Config & Parity Audit HITL and action items filtering (Dynamic Connector Mapping filters, Parity Checklist status filters, 1-click global audit filter button with unified remaining count badge), targeted user discovery "Delete All" action, and single quote / apostrophe email resilience, with 366 passing tests across 30 test suites.
* **v1.6.1**: Fixed `retryWithBackoff` infinite retry loop (`attempt++`), added per-request `AbortSignal.timeout` (30s) to `DiscoveryEngineClient` and `AgentRegistryClient`, added 15s SSE keep-alive heartbeats on `/api/migrate/stream`, promoted notebook fetch errors to `WARN`, added large-notebook source progress logging, and expanded to 327 passing tests.
* **v1.6.0**: Dynamic Connector & DataStore Auto-Mapping (`_#####` instance suffix matching), synchronized parent Connector + child entity DataStore rewriting (`collections/{id}/dataConnector` + `{id}_{entity}`), Step 2 interactive HITL mapping table, runtime Connector & Admin Notebook HITL modals, and 323 passing tests.
* **v1.5.8**: Dry Run Permission Elevation Detection for NotebookLM, Workforce Identity Federation (WiF) role hardening (`roles/discoveryengine.user`), admin group filtering in group scraper, and 313 passing tests.
* **v1.5.7**: Resilient Chat History Migration with full session hydration (`includeAnswerDetails=true`), companion-turn deduplication, target duplicate collision prevention, strict user session filtering, notebook source deduplication, and 307 passing tests.
* **v1.5.5**: CSV User ID Mapping (`first.last@XXXX.com ➔ #####@YYYY.com`), interactive Mapping Report panel & CSV/JSON export, Okta 2FA compatibility, case-insensitive identity resolution across all engines, and 285 passing tests.
* **v1.5.3**: Least-privilege DWD impersonation scopes with multi-tier fallback, token cache partitioning by auth mode, documentation and console version parity.
* **v1.5.1**: Multi-project IAM wizard and setup generator, hardened WiF impersonation live testing, iframe sandbox security fix.
* **v1.5.0**: Interactive Step 2 environment selector and bi-directional sync, streamlined Step 3 action bar, forensic SWE pagination and fail-closed auth hardening.
* **v1.4.1**: Organization Policy pre-flight matrix, 1-click project-level key creation override, WiF keyless architecture assessment, permission auditor org policy integration, and test suite maintenance.
* **v1.4.0**: Standalone zero-dependency interactive Quiz & Flashcards applications, Explainer Video compression (`ffmpeg`), single-ZIP handover archive (`NotebookLM_Artifacts.zip`), clean notes migration policy, and interactive action checklists.
* **v1.3.0**: User-created skills migration (`SkillMigrator`), Configuration Pre-Check & Gap Audit engine (`ConfigAuditEngine`), 1-click engine feature sync, attached DataStore filtering, and clipboard resilience.
* **v1.2.0**: Granular notebook source migration & audit trail, batch-with-fallback ingestion, multi-user target cleanup, quota diagnostics, and enhanced user checklists.
* **v1.1.0**: Memory and personalization facts migration, multi-turn chat rehydration, native Office `.pptx`/`.docx` document generation, and permissions least-privilege auditor.
* **v1.0.0**: Initial release with Low-Code / Workflow agent migration, research notebooks sync, cross-IdP transformation matrix, DWD/WiF auto-detection, and headless CLI runner.
