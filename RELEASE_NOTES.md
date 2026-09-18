# 🚀 Gemini Enterprise Admin Migration Platform (`gemini-migrate`)
## Release Notes — Version 1.5.5

**Release Date:** September 18, 2026  
**License:** Apache-2.0  
**Build Target:** Node.js >= 20.0.0 / TypeScript 5.x  

---

### Executive Summary

Gemini Enterprise Admin Migration Platform (`gemini-migrate`) **v1.5.5** introduces **CSV User ID Mapping (`first.last@XXXX.com ➔ #####@YYYY.com`)**, an interactive **Source-to-Destination User Identity Mapping Report (`📊 Mapping Report`)** with collision and unmapped-user auditing, **Okta 2FA / MFA Compatibility & Browser Session Extractor**, case-insensitive identity lookup across all migration engines, and **285 automated tests passing at 100%**.

---

### 🌟 Key Highlights & New Features

#### 1. 📊 CSV User ID Mapping (`first.last@XXXX.com ➔ #####@YYYY.com`) & Mapping Report
* **1-Click CSV Upload & 2-Column Paste**: Upload `.csv`/`.tsv`/`.txt` files or paste 2-column mappings (`first.last@XXXX.com,849201@YYYY.com`) directly in the User Selection & Identity Mapping Table. Supports comma, tab, semicolon, pipe, and arrow (`->`, `=>`) delimiters plus automatic domain appending for bare IDs.
* **Interactive Mapping Report (`📊 Mapping Report`)**: Displays 5 real-time KPI cards (**Total Users**, **CSV / 1:1 Mapped**, **Domain Rule Mapped**, **Unmapped Warning**, **Target ID Collisions**), filter/search controls, and `.CSV` / `.JSON` audit report exports.
* **Case-Insensitive Engine Lookup & Final Report Section 2b**: Added `IdentityMappingService.lookupTargetIdentity` across all 5 migration engines (`NotebookMigrator`, `AgentMigrator`, `SessionMigrator`, `MemoryMigrator`, `SkillMigrator`) and Section `2b. User Identity Mapping Report` in the final Markdown report.

#### 2. 🔐 Okta 2FA / MFA Compatibility & Browser Session Extractor
* **Okta 2FA Guidance & OIDC/SAML Token Helper**: Added built-in support and guidance for Okta/Entra 2FA environments via OAuth 2.0 Client Credentials M2M or interactive browser session token extraction.

#### 3. 🔒 Least-Privilege DWD Impersonation Scopes & Token Cache Partitioning
* **Restricted Scope Whitelisting Compatibility**: Defaults Google Workspace DWD impersonation to least-privilege Discovery Engine scopes with automatic step-down fallback and auth-mode token cache partitioning (`DWD`, `WIF`, `ADMIN`).

#### 4. 🧪 Automated Test Suite Stability (285/285 Tests Passing)
* Full 285-test automated suite across 26 test suites running at 100% pass rate.

---

### 📦 Upgrade Guide (v1.5.3 &rarr; v1.5.5)

1. **Pull Latest Changes & Install Dependencies**:
   ```bash
   git pull origin main
   npm install
   ```
2. **Recompile TypeScript**:
   ```bash
   npm run build
   ```
3. **Run Test Suite (All 285 Tests Passing)**:
   ```bash
   npm test
   ```
4. **Launch Web Console or Run Headless**:
   ```bash
   # Web Console
   npm run ui

   # Headless CLI
   npx tsx src/cli.ts --config migration-config.json
   ```

---

### 📜 Version History

* **v1.5.5** *(Current)*: CSV User ID Mapping (`first.last@XXXX.com ➔ #####@YYYY.com`), interactive Mapping Report panel & CSV/JSON export, Okta 2FA compatibility, case-insensitive identity resolution across all engines, and 285 passing tests.
* **v1.5.3**: Least-privilege DWD impersonation scopes with multi-tier fallback, token cache partitioning by auth mode, documentation and console version parity.
* **v1.5.1**: Multi-project IAM wizard and setup generator, hardened WiF impersonation live testing, iframe sandbox security fix.
* **v1.5.0**: Interactive Step 2 environment selector and bi-directional sync, streamlined Step 3 action bar, forensic SWE pagination and fail-closed auth hardening.
* **v1.4.1**: Organization Policy pre-flight matrix, 1-click project-level key creation override, WiF keyless architecture assessment, permission auditor org policy integration, and test suite maintenance.
* **v1.4.0**: Standalone zero-dependency interactive Quiz & Flashcards applications, Explainer Video compression (`ffmpeg`), single-ZIP handover archive (`NotebookLM_Artifacts.zip`), clean notes migration policy, and interactive action checklists.
* **v1.3.0**: User-created skills migration (`SkillMigrator`), Configuration Pre-Check & Gap Audit engine (`ConfigAuditEngine`), 1-click engine feature sync, attached DataStore filtering, and clipboard resilience.
* **v1.2.0**: Granular notebook source migration & audit trail, batch-with-fallback ingestion, multi-user target cleanup, quota diagnostics, and enhanced user checklists.
* **v1.1.0**: Memory and personalization facts migration, multi-turn chat rehydration, native Office `.pptx`/`.docx` document generation, and permissions least-privilege auditor.
* **v1.0.0**: Initial release with Low-Code / Workflow agent migration, research notebooks sync, cross-IdP transformation matrix, DWD/WiF auto-detection, and headless CLI runner.
