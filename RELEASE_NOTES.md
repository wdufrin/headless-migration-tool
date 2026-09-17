# 🚀 Gemini Enterprise Admin Migration Platform (`gemini-migrate`)
## Release Notes — Version 1.5.3

**Release Date:** September 17, 2026  
**License:** Apache-2.0  
**Build Target:** Node.js >= 20.0.0 / TypeScript 5.x  

---

### Executive Summary

Gemini Enterprise Admin Migration Platform (`gemini-migrate`) **v1.5.3** introduces **Least-Privilege Google Workspace DWD Impersonation Scopes with Multi-Tier Fallback**, resilient token cache partitioning across authentication modes, full platform-wide documentation and console version parity, and a verified test suite with **106 automated tests passing at 100%**.

---

### 🌟 Key Highlights & New Features

#### 1. 🔒 Least-Privilege DWD Impersonation Scopes
* **Restricted Scope Whitelisting Compatibility**: Upgraded Google Workspace Domain-Wide Delegation (DWD) impersonation to default strictly to Discovery Engine least-privilege OAuth scopes (`discoveryengine.readwrite`, `discoveryengine.assist.readwrite`).
* **Elimination of `unauthorized_client`**: Prevents token exchange rejections for enterprise Google Workspace domains where super-administrators have authorized Discovery Engine API scopes in the Google Workspace Admin console (`admin.google.com`) without granting the overly broad `cloud-platform` scope.
* **Resilient Scope Step-Down Fallback**: Added automatic multi-tier fallback that transparently attempts focused scope configurations if the broader permission set returns `unauthorized_client`.

#### 2. 🔑 Token Cache Partitioning by Execution Mode
* **Multi-Mode Cache Isolation**: Extended the internal OAuth token cache keys to explicitly factor in the active impersonation mode (`DWD`, `WIF`, or `ADMIN`) alongside the sanitized principal email and scope array.
* **Cross-Project & Cross-Mode Collision Prevention**: Guarantees that tokens minted under service account admin credentials or WiF STS exchanges are never erroneously reused during human user DWD impersonation operations.

#### 3. 📚 Enterprise Documentation & Web Console Parity
* **Synchronized Operator Guides**: Updated the official DOCX and Markdown [Installation Guide](docs/INSTALLATION_GUIDE.md) and [User Guide](docs/USER_GUIDE.md) to `v1.5.3 (Enterprise Release)`.
* **Console Badging**: Updated the local administrative web console header to reflect `v1.5.3`.

#### 4. 🧪 Automated Test Suite Stability (106/106 Tests Passing)
* Full 106-test automated suite across 14 test suites running at 100% pass rate.

---

### 📦 Upgrade Guide (v1.5.1 &rarr; v1.5.3)

1. **Pull Latest Changes & Install Dependencies**:
   ```bash
   git pull origin main
   npm install
   ```
2. **Recompile TypeScript**:
   ```bash
   npm run build
   ```
3. **Run Test Suite (All 106 Tests Passing)**:
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

* **v1.5.3** *(Current)*: Least-privilege DWD impersonation scopes with multi-tier fallback, token cache partitioning by auth mode, documentation and console version parity, and 106 passing tests.
* **v1.5.1**: Multi-project IAM wizard and setup generator, hardened WiF impersonation live testing, iframe sandbox security fix, and 106 passing tests.
* **v1.5.0**: Interactive Step 2 environment selector and bi-directional sync, streamlined Step 3 action bar, forensic SWE pagination and fail-closed auth hardening, and 105 passing tests.
* **v1.4.1**: Organization Policy pre-flight matrix, 1-click project-level key creation override, WiF keyless architecture assessment, permission auditor org policy integration, and test suite maintenance.
* **v1.4.0**: Standalone zero-dependency interactive Quiz & Flashcards applications, Explainer Video compression (`ffmpeg`), single-ZIP handover archive (`NotebookLM_Artifacts.zip`), clean notes migration policy, and interactive action checklists.
* **v1.3.0**: User-created skills migration (`SkillMigrator`), Configuration Pre-Check & Gap Audit engine (`ConfigAuditEngine`), 1-click engine feature sync, attached DataStore filtering, and clipboard resilience.
* **v1.2.0**: Granular notebook source migration & audit trail, batch-with-fallback ingestion, multi-user target cleanup, quota diagnostics, and enhanced user checklists.
* **v1.1.0**: Memory and personalization facts migration, multi-turn chat rehydration, native Office `.pptx`/`.docx` document generation, and permissions least-privilege auditor.
* **v1.0.0**: Initial release with Low-Code / Workflow agent migration, research notebooks sync, cross-IdP transformation matrix, DWD/WiF auto-detection, and headless CLI runner.
