# 🚀 Gemini Enterprise Admin Migration Platform (`gemini-migrate`)
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

### 📦 Upgrade Guide (v1.5.5 &rarr; v1.5.7)

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

* **v1.5.8** *(Current)*: Dry Run Permission Elevation Detection for NotebookLM, Workforce Identity Federation (WiF) role hardening (`roles/discoveryengine.user`), admin group filtering in group scraper, and 313 passing tests.
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
