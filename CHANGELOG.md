# Changelog

All notable changes to the Gemini Enterprise Admin Migration Platform (`gemini-migrate`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.1] - 2026-09-14

### Added
- **Multi-Project Setup Instructions & Cross-Project IAM Generator**:
  - Enhanced Step 1 (DWD & WiF Setup Wizard) to explicitly accept both Source GCP Project ID (`wizDwdSrcProject`) and Target GCP Project ID (`wizDwdProject`), automatically synced with Step 2 and Step 3.
  - Added dedicated Cross-Project IAM Architecture Explainer banner clarifying DWD user impersonation vs pipeline admin permissions.
  - Updated `gcloud` script generator to output complete setup commands granting `roles/discoveryengine.admin` and `roles/serviceusage.serviceUsageConsumer` across both Source and Target projects.
  - Added new comprehensive guide: `docs/JSON_SETUP_AND_CONFIGURATION_GUIDE.md` covering all configuration properties and cross-project IAM topologies.

### Changed
- **Hardened WiF Impersonation Verification**:
  - Updated `/api/wizard/test-wif` to perform live token exchanges with the Google Cloud IAM Credentials API (`serviceAccounts.generateAccessToken`).
  - Removed simulated success paths; requests now strictly verify that the workforce pool principal or caller has `roles/iam.serviceAccountTokenCreator` on the target service account.
- **Fixed Iframe Extension Security Errors**:
  - Added `allow-same-origin` to `artifactIframe` and `checklistIframe` sandbox attributes in `public/index.html`, eliminating `Uncaught SecurityError: Blocked a frame with origin "null"` triggered by browser extensions inspecting iframes.

---

## [1.5.0] - 2026-09-14

### Added
- **Step 2 Config & Parity Audit Interactive Environment Selector**:
  - Replaced static read-only cards in Step 2 with interactive Source and Target environment controls (`auditSrcProjectId`, `auditSrcLocation`, `auditSrcAppId`, `auditTgtProjectId`, `auditTgtLocation`, `auditTgtAppId`).
  - Added real-time bi-directional synchronization between Step 2 audit inputs and Step 3 studio inputs (`syncAuditEnv` and `populateAuditEnvFromStudio`).
  - Added safe empty state (`showAuditUnconfiguredState`) to prevent executing configuration audits with empty strings.
  - Added prominent **"Next: Proceed to Step 3: Migration Studio ➔"** wizard progression button at the bottom of the audit tab.
- **Forensic SWE Hardening & Security Audit Remediation**:
  - Implemented `listAllPages` helper across Discovery Engine client methods to prevent silent page truncation.
  - Enforced fail-closed authentication and explicit authorization headers.
  - Added service account email verification matching against runtime caller tokens.
  - Added OAuth2 token audience validation.
  - Added explicit opt-in confirmation required for decommission operations.
  - Enforced strict Zod schema validation on `/api/audit/config` payloads.
  - Added warning indicators to user handover reports when asset migrations are skipped.

### Changed
- **Streamlined Step 3 (Migration Studio) UI**:
  - Removed duplicate `Pre-Check Configurations & Gaps` button in Step 3 action bar to avoid redundant pre-checks, replacing it with a clean `← Step 2: Config & Parity Audit` back-link.

---

## [1.4.1] - 2026-09-09

### Added
- **Organization Policy Pre-Flight Scanner & Matrix**:
  - Added `POST /api/wizard/check-org-policies` endpoint in `src/routes/wizard.ts` to inspect target project organization policies using the Cloud Resource Manager / Org Policy REST API.
  - Automatically assesses four critical enterprise constraints: `iam.disableServiceAccountKeyCreation`, `iam.disableCrossProjectServiceAccountUsage`, `iam.allowedPolicyMemberDomains`, and `discoveryengine.managed.allowedDataSources`.
  - Added live `🛡️ Check Org Policies` button, dynamic debounced project ID listener, and color-coded alert banners in Step 1 (DWD) of the Auth Wizard in `public/index.html`.
- **1-Click Project-Level Organization Policy Override**:
  - Added `POST /api/wizard/override-key-creation-policy` in `src/routes/wizard.ts` to programmatically apply a project-level override (`enforce: false`) on `iam.disableServiceAccountKeyCreation` for administrators with `roles/orgpolicy.policyAdmin`.
  - Added `⚡ 1-Click Project Override` button and copyable `gcloud org-policies set-policy` command generator in `public/index.html`.
- **Workforce Identity Federation (WiF) Keyless Policy & Architecture Assessment**:
  - Added comprehensive architectural guidance in Step 2 of the Auth Wizard explaining that WiF token exchanges (`sts.googleapis.com`) mint ephemeral, short-lived tokens and are **100% immune** to `iam.disableServiceAccountKeyCreation` and `iam.disableServiceAccountKeyUpload`.
  - Audits `iam.allowedPolicyMemberDomains` to ensure workforce pool principal sets (`principalSet://iam.googleapis.com/...`) are authorized.
- **Permissions & Least-Privilege Auditor Integration**:
  - Extended `PermissionAuditor.ts` (`auditOrgPolicies`) to evaluate organization policy compliance alongside IAM role bindings and OAuth2 scopes.
- **Documentation Overhaul**:
  - Updated `docs/INSTALLATION_GUIDE.md` with Section 4.1 (Organization Policy Pre-Flight Matrix & Constraints), Step 3 key creation failure callouts, and troubleshooting guidance.
  - Updated `docs/USER_GUIDE.md` with Section 9 (Auth & Identity Provider Configuration Wizard) detailing DWD setup, 1-click overrides, and WiF keyless architecture.

### Fixed
- **TypeScript Test Typing**:
  - Resolved missing `appId` property errors in `tests/skillMigrator.test.ts` for `sourceEnv` and `targetEnv`.

---

## [1.4.0] - 2026-09-03

### Added
- **Standalone Zero-Dependency Interactive Quiz & Flashcards Applications**:
  - Engineered dedicated interactive HTML5 players (`NotebookLmArtifactFormatter.renderInteractiveQuizHtml` and `renderInteractiveFlashcardsHtml`) that run 100% offline in any modern browser without external runtime dependencies or runtime errors.
  - **Interactive Quiz Player**: Instant green/red feedback per selection, detailed answer rationales, hint reveal toggle, live score tracker, and quiz retake functionality.
  - **Interactive 3D Flashcards Player**: Smooth CSS 3D card flip animations, next/prev navigation, randomized card shuffle, full study table sheet, and keyboard shortcuts (`Space`/`Enter` to flip, `Left`/`Right` arrows to navigate).
  - **Dual-Format Learning Export**: Automatically exports each quiz and flashcard set into both an interactive browser application (`.html`) and a formatted printable Microsoft Word document (`.docx`) with Markdown question banks (`.md`).
  - **NotebookLM App API Polyfill**: Added `NotebookLmArtifactFormatter.injectNotebookAppApiPolyfill` to inject `window.notebookAppApi` and strip CSP restrictions, resolving the `NotebookLMThemeProvider should not be used without a NotebookLM API` blank-screen crash on raw Google Angular bundles (`*_AngularApp.html`).
- **Explainer Video Media Compression & Email Delivery (`ffmpeg`)**:
  - Integrated `UserReportGenerator.isFfmpegAvailable` and updated `optimizeMediaArtifact` to automatically compress high-bitrate Explainer Videos (`.mp4`) > 12 MB via `ffmpeg`.
  - Transcodes to 720p H.264 CRF 28 with 64k AAC audio, reducing file size by 70–75% (e.g. 24.2 MB &rarr; 6.7 MB) with zero perceptible quality degradation.
  - Automatically promotes compressed videos into active email attachments, fitting under Gmail's 14.5 MB unencoded attachment threshold.
- **NotebookLM Studio Artifacts Single-ZIP Archive (`NotebookLM_Artifacts.zip`)**:
  - Bundles all user presentations (`.pptx`), infographics (`.jpg`), explainer videos (`.mp4`), interactive learning apps (`.html`), and study guides (`.docx`) into a single compressed `NotebookLM_Artifacts.zip` archive.
  - Intelligent companion-file deduplication: static HTML document companions are excluded when Word documents are present, but interactive `.html` applications (`quiz`, `flashcard`, `app`) are explicitly retained alongside Word study guides.
  - Automatic multi-part zip partitioning fallback (`NotebookLM_Artifacts_Part1.zip`, `Part2.zip`) if uncompressible files exceed 14.5 MB.
- **Interactive Checklists & Action-Oriented User Onboarding**:
  - Overhauled user handover checklist with actionable checkboxes `[ ]` showing exact steps for end users: First-time login, opening Connectors, authorizing enterprise workplace tools (Outlook, OneDrive, Google Drive, Jira, ServiceNow, Entra ID), publishing transferred agents, and extracting the artifacts archive.
  - Collapsed raw technical source documents audit into an expandable `<details>` accordion to prevent cluttering user action items.
- **Test Suite Expansion**:
  - Expanded automated test suite to 71 tests across 10 test suites covering `isFfmpegAvailable`, `extractAppData`, interactive Quiz and Flashcards rendering, Angular API polyfilling, and interactive app attachment retention in email dispatching with 100% pass rate.

### Changed
- **Clean Notes Migration Policy (Removed Workaround)**:
  - Completely removed fallback ingestion of studio notes into notebook grounding sources in `NotebookMigrator`.
  - Notes are now strictly preserved and delivered as authentic user artifacts: formatted Microsoft Word documents (`Note - <Title>.docx`), clean styled HTML (`Note - <Title>.html`), and Markdown (`Note - <Title>.md`).

---

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
  - Added `--generate-user-reports` and `--notify-users [overrideEmail]` CLI flags for automated post-migration handover dispatch.
  - Added 60 comprehensive automated tests across 10 test suites covering `SkillMigrator`, `ConfigAuditEngine`, `NotebookLmArtifactFormatter`, and E2E migration pipelines with 100% pass rate.
- **Bulk Organization Handover Email Dispatcher**:
  - Added automated bulk email dispatching capabilities to `UserReportGenerator` (`sendBulkUserEmails`) and `POST /api/user-reports/send-bulk-email`.
  - Built-in pacing delay (250ms default) between successive calls to avoid Google Workspace / Gmail REST API rate limits and SMTP burst throttling.
  - **Safe Staging Mode**: Supports an override recipient email (e.g. `staging-auditor@company.com`) allowing admins to redirect all bulk user checklists and attachments to a staging inbox to audit formatting, links, and Office files before employee delivery.
  - Enhanced User Handover UI: Table "Select All" checkbox and per-user row checkboxes, segmented toggle between `[ 👤 Single User Test ]` and `[ 👥 Bulk Organization Dispatch ]`, audience selector (All Discovered Users vs. Selected Users from Table), live animated progress bar, and itemized user dispatch logs.
- **NotebookLM Direct Export Parity (`NotebookLmArtifactFormatter`)**:
  - High-fidelity artifact formatting matching authentic direct-from-NotebookLM downloads.
  - **Clean Human-Readable Filenames**: Automatically eliminates `(Restored)` tags, `(Copy)` suffixes, double underscores, and redundant title stuttering (e.g., `Trane Technologies - Q2 2026 Strategic Blueprint.pptx`).
  - **Native Microsoft Word (`.docx`)**: Generates documents with standard 1-inch margins, Arial font hierarchy, native markdown table formatting with shading (`#F1F5F9`) and borders, bullet/numbered lists, inline bold/italics/code, citations (`[1]`, `[Source]`), and page numbers (`PageNumber.CURRENT` of `PageNumber.TOTAL_PAGES`).
  - **Native Microsoft PowerPoint (`.pptx`)**: Generates 16:9 widescreen presentations (`LAYOUT_16x9`) with executive light theme, automatic slide splitting, multi-column card layouts, bold lead-in bullet points, presenter speaker notes extraction (`slide.addNotes`), and slide number footers (`Slide X of Y`).
  - **Authentic Clean Markdown & HTML**: Strips internal debug markers (`**Artifact Type:** ...`) and generates Google Docs-styled printable HTML documents and interactive 16:9 presentation deck carousels.
  - **Artifact Exporter Integration**: Updated `ArtifactExtractor.exportAllToDirectory` to output rich `.docx` and `.pptx` files into `./exports/artifacts/` alongside clean companion Markdown and HTML files.

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
