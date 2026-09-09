# 🚀 Gemini Enterprise Admin Migration Platform (`gemini-migrate`)
## Release Notes — Version 1.4.1

**Release Date:** September 9, 2026  
**License:** Apache-2.0  
**Build Target:** Node.js >= 20.0.0 / TypeScript 5.x  

---

### Executive Summary

Gemini Enterprise Admin Migration Platform (`gemini-migrate`) **v1.4.1** introduces an **Automated Organization Policy Pre-Flight Matrix & Live Scanner** (identifying blocking constraints such as `iam.disableServiceAccountKeyCreation` and `iam.disableCrossProjectServiceAccountUsage`), **1-Click Project-Level Policy Overrides** with ready-to-paste CLI remediation commands, an architectural deep dive and automated verification for **Keyless Workforce Identity Federation (WiF)**, and integrated target project organization policy auditing in the **Permissions & Least-Privilege Auditor**.

---

### 🌟 Key Highlights & New Features

#### 1. 🛡️ Organization Policy Pre-Flight Matrix & API (`POST /api/wizard/check-org-policies`)
* **Proactive Constraint Detection**: Automated pre-flight scanning endpoint and UI component in the **Auth & WiF Wizard** inspecting critical enterprise GCP Organization Policies on the target environment:
  * `iam.disableServiceAccountKeyCreation`: Verifies whether service account key generation (`gcloud iam service-accounts keys create`) is blocked by organization-level policy.
  * `iam.disableCrossProjectServiceAccountUsage`: Checks whether service accounts created in external projects can be bound or utilized against target Discovery Engine resources.
  * `iam.allowedPolicyMemberDomains`: Evaluates domain-sharing restrictions to ensure workforce pool principal sets (`principalSet://iam.googleapis.com/...`) and external user identities are allowed in IAM bindings.
  * `discoveryengine.managed.allowedDataSources`: Checks whether custom or third-party MCP and connector datastores are restricted by enterprise policy.
* **Granular Inheritance Auditing**: Reports whether policies are enforced, inherited from parent organization folders, or overridden at the project level, with specific remediation instructions.
* **Dynamic Visual Alert Banners**: Color-coded banners (`WARNING` amber alert or `READY` green badge) in Step 1 (DWD) of the Auth Wizard immediately display enforcement status and actionable guidance before attempting key creation.

#### 2. ⚡ 1-Click Project-Level Organization Policy Override (`POST /api/wizard/override-key-creation-policy`)
* **Instant Project Exemption**: Added a 1-click override button and dedicated backend endpoint that sets `enforce: false` on `iam.disableServiceAccountKeyCreation` directly on the target project via the Google Cloud Org Policy REST API (for administrators with `roles/orgpolicy.policyAdmin`).
* **Copyable CLI Remediation**: Generates an exact, copy-ready `gcloud org-policies set-policy` command complete with inline JSON policy definition for terminal administrators who prefer running commands manually.

#### 3. 🌐 Workforce Identity Federation (WiF) Keyless Policy & Architecture Assessment
* **Keyless Architecture Immunity**: Clarifies and validates that WiF token exchanges (`sts.googleapis.com`) mint ephemeral, short-lived tokens via Google Cloud STS and are **100% immune** to `iam.disableServiceAccountKeyCreation` or `iam.disableServiceAccountKeyUpload` constraints.
* **Zero Stored Secrets**: Eliminates high-risk on-disk `.json` private keys entirely for customers adopting federated identity (Entra ID, Okta, Ping).
* **Principal Set Verification**: Validates that `iam.allowedPolicyMemberDomains` permits workforce pool principal sets (`principalSet://iam.googleapis.com/organizations/<ORG_ID>/*`).

#### 4. 🛡️ Permissions & Least-Privilege Auditor Integration (`PermissionAuditor`)
* **Target Policy Verification**: Expanded `PermissionAuditor.ts` (`auditOrgPolicies`) to evaluate organization policy compliance alongside IAM role bindings and OAuth2 scopes.
* **Automated Remediation Guidance**: Suggests exact IAM role additions (`roles/orgpolicy.policyAdmin`) and policy reset commands when constraints block migration operations.

#### 5. 🧪 Automated Test Suite Expansion & Typing Fixes (74/74 Tests Passing)
* Expanded automated test coverage to 74 tests across 10 test suites covering skills migration, configuration pre-checks, memory extraction, session rehydration, reporters, artifact formatting, and bulk email dispatching.
* Fixed TypeScript test typing in `tests/skillMigrator.test.ts` (added missing `appId` properties in `sourceEnv` and `targetEnv`).

---

### 📦 Upgrade Guide (v1.4.0 &rarr; v1.4.1)

1. **Pull Latest Changes & Install Dependencies**:
   ```bash
   git pull origin main
   npm install
   ```
2. **Recompile TypeScript**:
   ```bash
   npm run build
   ```
3. **Run Test Suite (All 74 Tests Passing)**:
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

* **v1.4.1** *(Current)*: Organization Policy pre-flight matrix, 1-click project-level key creation override, WiF keyless architecture assessment, permission auditor org policy integration, and test suite maintenance.
* **v1.4.0**: Standalone zero-dependency interactive Quiz & Flashcards applications, Explainer Video compression (`ffmpeg`), single-ZIP handover archive (`NotebookLM_Artifacts.zip`), clean notes migration policy, and interactive action checklists.
* **v1.3.0**: User-created skills migration (`SkillMigrator`), Configuration Pre-Check & Gap Audit engine (`ConfigAuditEngine`), 1-click engine feature sync, attached DataStore filtering, and clipboard resilience.
* **v1.2.0**: Granular notebook source migration & audit trail, batch-with-fallback ingestion, multi-user target cleanup, quota diagnostics, and enhanced user checklists.
* **v1.1.0**: Memory and personalization facts migration, multi-turn chat rehydration, native Office `.pptx`/`.docx` document generation, and permissions least-privilege auditor.
* **v1.0.0**: Initial release with Low-Code / Workflow agent migration, research notebooks sync, cross-IdP transformation matrix, DWD/WiF auto-detection, and headless CLI runner.
