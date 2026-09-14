# 🚀 Gemini Enterprise Admin Migration Platform (`gemini-migrate`)
## Release Notes — Version 1.5.1

**Release Date:** September 14, 2026  
**License:** Apache-2.0  
**Build Target:** Node.js >= 20.0.0 / TypeScript 5.x  

---

### Executive Summary

Gemini Enterprise Admin Migration Platform (`gemini-migrate`) **v1.5.1** introduces **Multi-Project Setup Instructions & Cross-Project IAM Automation**, truthful live verification for Workforce Identity Federation (WiF) service account impersonation via the GCP IAM Credentials API, security fixes for web console embedded iframe sandboxes, and an expanded test suite with **106 automated tests passing at 100%**.

---

### 🌟 Key Highlights & New Features

#### 1. 🌐 Multi-Project Architecture & Cross-Project IAM Setup Instructions
* **Dual Project Setup in Auth Wizard**: Step 1 (DWD & WiF Setup Wizard) now prompts for both **Source GCP Project ID** and **Target GCP Project ID**, with real-time bi-directional synchronization to Step 2 (Audit) and Step 3 (Studio).
* **Automated Cross-Project Command Generation**: The Setup Wizard's copy-paste `gcloud` command generator now automatically produces required IAM role bindings for both Source and Target environments:
  * `roles/discoveryengine.admin` on both Source and Target projects.
  * `roles/serviceusage.serviceUsageConsumer` on both Source and Target projects.
* **Architecture Clarification & Dedicated Guide**: Added a prominent Cross-Project IAM Architecture Explainer banner in the console and authored the dedicated [JSON Setup & Auth Architecture Guide](docs/JSON_SETUP_AND_CONFIGURATION_GUIDE.md).

#### 2. 🔒 Hardened WiF Impersonation Live Verification (Anti-Lying Guardrail)
* **Real GCP IAM Token Exchange**: Upgraded `/api/wizard/test-wif` to perform a live call to the GCP IAM Credentials API (`serviceAccounts.generateAccessToken`).
* **Zero Simulated Passes**: Eliminates simulated or false positive test passes when testing service account impersonation. If the calling identity lacks `roles/iam.serviceAccountTokenCreator`, the test fails truthfully with actionable diagnostic messages.

#### 3. 🛡️ Web Console Iframe Extension Security Fix
* **Sandbox Policy Hardening**: Added `allow-same-origin` to `artifactIframe` and `checklistIframe` sandbox attributes in `public/index.html`. This eliminates `Uncaught SecurityError: Blocked a frame with origin "null"` exceptions caused by Chrome extensions inspecting embedded frames while preserving strict execution sandboxing.

#### 4. 🧪 Automated Test Suite Expansion (106/106 Tests Passing)
* Full 106-test automated suite across 14 test suites running at 100% pass rate.

---

### 📦 Upgrade Guide (v1.5.0 &rarr; v1.5.1)

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

* **v1.5.1** *(Current)*: Multi-project IAM wizard and setup generator, hardened WiF impersonation live testing, iframe sandbox security fix, and 106 passing tests.
* **v1.5.0**: Interactive Step 2 environment selector and bi-directional sync, streamlined Step 3 action bar, forensic SWE pagination and fail-closed auth hardening, and 105 passing tests.
* **v1.4.1**: Organization Policy pre-flight matrix, 1-click project-level key creation override, WiF keyless architecture assessment, permission auditor org policy integration, and test suite maintenance.
* **v1.4.0**: Standalone zero-dependency interactive Quiz & Flashcards applications, Explainer Video compression (`ffmpeg`), single-ZIP handover archive (`NotebookLM_Artifacts.zip`), clean notes migration policy, and interactive action checklists.
* **v1.3.0**: User-created skills migration (`SkillMigrator`), Configuration Pre-Check & Gap Audit engine (`ConfigAuditEngine`), 1-click engine feature sync, attached DataStore filtering, and clipboard resilience.
* **v1.2.0**: Granular notebook source migration & audit trail, batch-with-fallback ingestion, multi-user target cleanup, quota diagnostics, and enhanced user checklists.
* **v1.1.0**: Memory and personalization facts migration, multi-turn chat rehydration, native Office `.pptx`/`.docx` document generation, and permissions least-privilege auditor.
* **v1.0.0**: Initial release with Low-Code / Workflow agent migration, research notebooks sync, cross-IdP transformation matrix, DWD/WiF auto-detection, and headless CLI runner.
