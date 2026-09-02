# Changelog

All notable changes to the Gemini Enterprise Admin Migration Platform (`gemini-migrate`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-09-02

### Added
- **User-Created Skills Migration Engine (`SkillMigrator`)**:
  - Automatically discovers, exports, and restores custom user-created Skills in Google Agent Registry (`apigee.googleapis.com` / `agentregistry.googleapis.com`) and Discovery Engine Skill Agents.
  - Filters out public 1P Google catalog skills and pre-packaged templates (`cloud.google.com-*`, `discoveryengine.googleapis.com-*`, `google-*`), migrating strictly user-created custom skills.
  - Integrated into the migration pipeline, live UI progress tracker, executive summary tables, and Markdown/JSON migration reports.
- **Configuration Pre-Check & Gap Audit Engine (`ConfigAuditEngine`)**:
  - Pre-flight gap analysis validating target environment parity before initiating data migrations.
  - Deep engine feature comparison: User Memory & Personalization (`personalization-memory`), Agent Catalog & Gallery (`agent-gallery`), No-Code Agent Builder (`no-code-agent-builder`), Create & Execute Skills (`skills`), Skill Sharing (`skill-sharing`), Session Sharing (`session-sharing`), Bi-directional Audio, Canvas Studio, Observability / Audit logging, and Chat Session TTL.
  - Generates an actionable Parity Readiness Score (0–100%) with weighted criteria.
- **1-Click Engine Feature & Settings Synchronization**:
  - Added 1-click `/api/audit/sync-engine-settings` endpoint and UI button to automatically align target engine flags to mirror source configuration via Discovery Engine PATCH API.
  - Generates deterministic CLI remediation commands with alphabetically sorted JSON feature flags to eliminate UI flicker across audit runs.
- **Attached DataStore Parity & Connector Audit**:
  - Dynamically inspects only DataStores attached to the source Engine (`engine.dataStoreIds` / `dataStores`), ignoring orphaned or unattached project DataStores.
  - Validates target DataStore states: `MATCH` (provisioned and attached), `WARNING` (provisioned in target project but unattached to engine), and `MISSING_IN_TARGET`.
  - Added clean automated remediation to attach provisioned DataStores to target engines via `PATCH /engines/${appId}?updateMask=dataStoreIds`.
  - Replaced raw DataStore creation CLI commands with clear informational guidance directing administrators to the Google Cloud Console / Gemini Enterprise Console for connector setup.
- **CLI & Config Schema Enhancements**:
  - Added `--no-skills` flag to headless CLI (`gemini-migrate`) and `migrateSkills: boolean` configuration parameter in `migration-config.json` schema.
  - Added 47 comprehensive automated tests across 9 test suites covering `SkillMigrator`, `ConfigAuditEngine`, `AgentRegistryClient`, and E2E migration pipelines with 100% pass rate.

### Fixed
- **Pre-Check Audit UI Responsiveness & Timer**:
  - Resolved infinite recursive loop in `public/index.html` between `runConfigPreCheck()` and `switchTab('audit')`.
  - Added `isAuditRunning` re-entrancy guard preventing concurrent background scan executions.
  - Restored proper elapsed timer behavior for the "Last Pre-Check Run" badge.
  - Added stable animated "Building..." loading card with spinner in remediation container while scans are running.
- **Remediation CLI Clipboard Copy ("Copy CLI")**:
  - Decoupled command execution from inline HTML string attributes to prevent quote escaping and syntax errors on complex curl commands.
  - Implemented `copyTextValue()` with automatic fallback to `document.execCommand('copy')` if modern `navigator.clipboard` is restricted or rejected.
  - Replaced browser alert modals with clean inline `✓ Copied!` visual feedback.
- **TypeScript Test Suite Typing**:
  - Resolved type mismatches in `tests/configAuditEngine.test.ts`, `tests/memoryMigrator.test.ts`, and `tests/migrationRunner.test.ts` for `ValidatedMigrationConfig` (`toolMapping` and full `options` properties).
  - Aligned `importMemoriesFromFile()` return type signature in `MemoryMigrator` to include `total: number`.

---

## [1.2.0] - 2026-09-01

### Added
- **Granular Notebook Source Migration & Integrity Auditing**:
  - Document-level tracking for Google Drive files, web URLs, PDFs, uploaded text files, YouTube references, and Studio artifacts.
  - Explicit lifecycle status tracking: `SUCCESS`, `FAILED`, `SKIPPED`, or `DRY_RUN`.
  - Resilient batch ingestion with automatic per-document fallback.
  - Section 5 Sources Audit Trail in Markdown and JSON reports.
- **Enhanced End-User Handover Packages**:
  - HTML verification checklist with visual pill badges (`📄 X Sources Ready`, `⚠️ Y Failed`) and expandable `<details>` source accordions.
  - Markdown handover package with itemized document lists.
  - Gmail REST API email dispatch with Domain-Wide Delegation and recipient override support.
- **Multi-User Target Environment Maintenance**:
  - Discovers and cleans orphaned notebooks and agents across all target identities prior to fresh runs.
  - Selective cleanup controls for Chats, Agents, Notebooks, Exported Artifacts, and Reports.
- **Quota & Rate Limit Diagnostics**:
  - Full jitter exponential backoff handling for HTTP 429 (`RESOURCE_EXHAUSTED`).
  - RPC ErrorInfo quota telemetry extraction (`quota_metric`, `quota_limit`).

---

## [1.1.0] - 2026-08-25

### Added
- **User Memories & Personalization Migration (`MemoryMigrator`)**:
  - Discovers, exports, and restores learned user preferences and personal context facts.
  - Per-user and full JSON backup snapshot exports.
- **Multi-Turn Chat History Rehydration**:
  - Reconstructs multi-turn conversational history with turn-by-turn question/answer dialogues, thoughts, and citations in chronological order.
- **Office Document & Presentation Generation**:
  - Generates native `.pptx` (Microsoft PowerPoint) slides and `.docx` (Microsoft Word) documents from NotebookLM artifacts into `./exports/artifacts`.
- **Permissions & Least-Privilege Auditor**:
  - Live IAM permission evaluation, over-provisioned scope detection, and security grading (A/B/C/F) with 1-click `gcloud` policy fixes.

---

## [1.0.0] - 2026-08-15

### Added
- Initial release of Gemini Enterprise Admin Migration Platform (`gemini-migrate`).
- Custom Agent Migration (Low-Code, Workflow, and Pro-Code agents) with auto-publishing to user sidebar.
- Gemini Research Notebooks migration with source links and notes.
- Cross-IdP Transformation Matrix supporting Google Workspace (DWD) and Microsoft Entra ID / Okta (WiF STS).
- Interactive Web Console UI (`http://localhost:8080`) and Headless CLI runner (`gemini-migrate`).
- Comprehensive end-to-end integration test runner.
