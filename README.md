# 🚀 Gemini Enterprise Admin Migration Platform (`gemini-migrate`)

[![Version](https://img.shields.io/badge/version-1.5.8-blue.svg)](package.json)
[![Installation Guide](https://img.shields.io/badge/install%20guide-DOCX%20%7C%20MD-blue.svg)](docs/INSTALLATION_GUIDE.md)
[![User Guide](https://img.shields.io/badge/user%20guide-DOCX%20%7C%20MD-green.svg)](docs/USER_GUIDE.md)
[![Release Notes](https://img.shields.io/badge/release%20notes-v1.5.8-orange.svg)](RELEASE_NOTES.md)
[![Changelog](https://img.shields.io/badge/changelog-Keep%20a%20Changelog-blue.svg)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE)

An enterprise admin-driven headless platform and web console for migrating **Gemini Enterprise (Google Cloud Discovery Engine)** custom agents, user-created skills, research notebooks, studio artifacts, grounding sources, chat conversation history, user personalized memories, and associated IAM permissions across Google Cloud environments and Identity Providers.

> [!TIP]
> **📖 Official Enterprise Documentation & Operator Guides (with Illustrations & Diagrams)**:
> * **[Installation & Pre-Requisites Guide (DOCX)](INSTALLATION_GUIDE.docx)** &bull; *[Markdown Version](docs/INSTALLATION_GUIDE.md)*: Google Cloud APIs, IAM role matrices, Organization Policy pre-flight checks, DWD/WiF credentials provisioning, and local build walkthroughs.
> * **[Administrator & User Guide (DOCX)](USER_GUIDE.docx)** &bull; *[Markdown Version](docs/USER_GUIDE.md)*: End-to-end web console operations, Auth Wizard & Org Policy overrides, parity gap remediation, cross-IdP domain translation, studio export parity, and user handover delivery.
> * **[JSON Setup & Auth Architecture Guide](docs/JSON_SETUP_AND_CONFIGURATION_GUIDE.md)**: Detailed technical reference covering `sa-dwd-key.json`, `workforce-identity-config.json`, `migration-config.json`, cross-project IAM topologies, and token resolution order.

---

## 🚀 What's New in v1.5.8

* **🔍 Dry Run Permission Elevation Detection for NotebookLM**:
  * Highlights when an impersonated user token holds project-level `discoveryengine.notebooks.delete` (Admin permissions, e.g. from `roles/discoveryengine.admin` on the Workforce Pool or an admin group).
  * Explains the exact blast radius: project-level Admin permissions cause Google Discovery Engine / NotebookLM's backend API to classify the user as `PROJECT_ROLE_OWNER` on ALL shared notebooks across the project, causing colleague-authored shared notebooks to appear as owned notebooks.
  * Emits high-visibility `[DRY RUN AUDIT: PERMISSION ELEVATION]` warnings during pre-flight checks and per-user notebook discovery with exact `gcloud` remediation commands to replace `roles/discoveryengine.admin` with `roles/discoveryengine.user`.
* **🛡️ Workforce Identity Federation (WiF) Least-Privilege Role Hardening**:
  * Setup Wizard now binds `roles/discoveryengine.user` (instead of `roles/discoveryengine.admin`) to `principalSet://iam.googleapis.com/locations/global/workforcePools/${poolId}/*`.
  * WiF group scraper in `wifPreflight.ts` explicitly filters out admin roles (`roles/discoveryengine.admin`, `roles/discoveryengine.agentspaceAdmin`, `roles/discoveryengine.notebookLmOwner`, `roles/owner`, `roles/editor`), preventing impersonated end-user tokens from inheriting unintended project-wide delete privileges.
* **🧪 100% Passing Automated Tests (313/313 Tests)**:
  * Full 313 automated tests passing across 26 test suites with zero failures or skipped assertions.

---

## 🚀 What's New in v1.5.7

* **💬 Resilient Chat History Migration & Full Session Hydration**:
  * Resolved Discovery Engine 404 errors on unroutable `assistAnswers` endpoints by implementing single-flight session hydration (`getSession` with `includeAnswerDetails=true` and in-memory cache).
  * In `listSourceSessions`, automatically requests `view=SESSION_VIEW_FULL` and per-user filtering (`filter=user_pseudo_id="..."`).
  * Intelligent companion-turn deduplication preserves real Gemini responses and citations, eliminating premature archived placeholder stubs.
  * Migrated sessions receive `source-session-id:${srcSessionId}` labels and query fingerprinting to prevent duplicate creation collisions in target engines.
* **🎯 Targeted User Session Filtering & Notebook Source Deduplication**:
  * Chat sessions are strictly filtered to configured users in `userFilter`, preventing background engine sessions from being loaded.
  * Notebook studio migration deduplicates source files to prevent duplicate source entries during target re-creation.
* **🧪 100% Passing Automated Tests (307/307 Tests)**:
  * Full 307 automated tests passing across 26 test suites with zero skipped or stubbed tests.

---

## 🚀 What's New in v1.5.5

* **📊 CSV User ID Mapping (`first.last@XXXX.com ➔ #####@YYYY.com`) & Interactive Mapping Report**:
  * Added 1-click **CSV Upload (`📂 Upload Mapping CSV`)** and **2-Column Paste (`📋 Paste CSV / Users`)** inside the User Selection & Identity Mapping Table to support customers changing both username/local-part (`first.last` to employee number `#####`) and domain (`@XXXX.com` to `@YYYY.com`).
  * Added an interactive **Source-to-Destination User Identity Mapping Report (`📊 Mapping Report`)** with 5 KPI cards (Total Users, CSV/1:1 Mapped, Domain Rule, Unmapped Warnings, Target ID Collisions), search/filter controls, and `.CSV` / `.JSON` exports.
  * Added Section `2b. User Identity Mapping Report (Source ID ➔ Destination ID)` to the Markdown migration report and ensured case-insensitive, prefix-tolerant identity resolution (`IdentityMappingService.lookupTargetIdentity`) across all 5 migration engines.
* **🔐 Okta 2FA / MFA Compatibility & Browser Session Extractor**:
  * Added explicit Okta/Entra 2FA guidance and interactive OIDC/SAML Token Helper alongside OAuth 2.0 Client Credentials M2M flow.
* **🧪 Verified Test Suite (285/285 Tests Passing)**:
  * Full 285 automated unit and adversarial tests passing across 26 test suites with 100% success rate.

---

## 🚀 What's New in v1.5.3

* **🔒 Least-Privilege DWD User Impersonation Scopes**:
  * Upgraded Google Workspace Domain-Wide Delegation (DWD) impersonation flow to default strictly to Discovery Engine least-privilege scopes (`discoveryengine.readwrite`, `discoveryengine.assist.readwrite`).
  * Prevents `unauthorized_client` errors for customer Google Workspace environments where super-admins have whitelisted Discovery Engine OAuth scopes in `admin.google.com` without granting broad `cloud-platform` scope.
  * Added resilient multi-tier scope step-down fallback on `unauthorized_client`.
* **🔑 Resilient Token Cache Partitioning**:
  * User impersonation token cache now partitions by execution mode (`DWD`, `WIF`, `ADMIN`) and requested scope sets, guaranteeing zero token collision across authentication modes or cross-project boundaries.
* **📚 Enterprise Documentation & Console Parity**:
  * Synchronized all installation, user guides, setup schemas, and web console badges to v1.5.5 (Enterprise Release).
* **🧪 Test Suite Stability**:
  * Full automated test suite passing with 100% success rate.

---

## 🚀 What's New in v1.5.1
* **🛡️ Web Console Iframe Sandbox Security Fix**:
  * Resolved null-origin `SecurityError` exceptions caused by browser extensions inspecting embedded artifact and handover checklist iframes by adding `allow-same-origin` to iframe sandbox policies.
* **🧪 Test Suite Expansion (106/106 Tests Passing)**:
  * 100% automated test pass rate across 14 test suites covering authentication, cross-project parity pre-checks, and decommissioning verification.

---

## 🚀 What's New in v1.5.0

* **🎯 Interactive Step 2 Config & Parity Environment Selector**:
  * Direct configuration and selection of Source and Target GCP Project IDs, Regions, Collections, and Discovery Engine / App IDs directly within **Step 2 (Config & Parity Audit)**.
  * Real-time bi-directional synchronization between Step 2 audit environment cards and Step 3 (Migration Studio) form controls.
  * Guided empty-state prompt preventing premature, blank pre-check invocations.
  * Seamless wizard transition button (`Next: Proceed to Step 3: Migration Studio ➔`) carrying configured environments forward.
* **⚡ Streamlined Step 3 Action Controls**:
  * Removed redundant pre-check button in Step 3 in favor of unified execution controls (`⚡ Execute Pre-Flight Dry Run` / `⚡ Execute Live Migration`) and direct back-navigation to Step 2.
* **🛡️ Hardened Enterprise Security & Forensics**:
  * P0/P1 audit remediations across Discovery Engine pagination (`listAllPages`), truthful error propagation, fail-closed auth, service account identity verification, audience validation, explicit decommissioning opt-in, and Zod audit payload schemas.
* **🧪 Test Suite Expansion (105/105 Tests Passing)**:
  * 100% automated test pass rate across 14 test suites covering authentication, parity pre-checks, decommissioning verification, and artifact generation.

---

## 🚀 What's New in v1.4.1

* **🛡️ Organization Policy Pre-Flight Scanner & Matrix**:
  * **Automated Target Project Policy Verification**: Live pre-flight scan (`POST /api/wizard/check-org-policies`) inspecting critical Google Cloud Organization Policies:
    * `iam.disableServiceAccountKeyCreation`: Checks whether on-disk service account key creation (`gcloud iam service-accounts keys create`) is blocked by organization constraint.
    * `iam.disableCrossProjectServiceAccountUsage`: Checks whether service accounts from external projects are restricted from accessing target Discovery Engine resources.
    * `iam.allowedPolicyMemberDomains`: Audits domain-sharing restrictions to ensure workforce pool principal sets (`principalSet://iam.googleapis.com/...`) and external user identities are permitted in IAM bindings.
    * `discoveryengine.managed.allowedDataSources`: Checks whether custom or third-party MCP and connector datastores are restricted by enterprise policy.
  * **Real-Time Visual Alerts**: Color-coded banners in Step 1 (DWD) of the Auth Wizard immediately display enforcement status, policy inheritance levels, and operational recommendations.
* **⚡ 1-Click Project-Level Organization Policy Override**:
  * **Instant Project Exception**: Dedicated 1-click override button (`POST /api/wizard/override-key-creation-policy`) allowing authorized administrators (`roles/orgpolicy.policyAdmin`) to set `enforce: false` on `iam.disableServiceAccountKeyCreation` directly on the target project without leaving the web console.
  * **Copyable CLI Remediation Command**: Generates ready-to-paste `gcloud org-policies set-policy` command with JSON policy definition for terminal administrators.
* **🌐 Workforce Identity Federation (WiF) Keyless Architecture Assessment**:
  * **Keyless Architecture Immunity**: Explains and validates that WiF token exchanges (`sts.googleapis.com`) mint ephemeral, short-lived tokens via Google Cloud STS and are **100% immune** to `iam.disableServiceAccountKeyCreation` or `iam.disableServiceAccountKeyUpload` constraints.
  * **Zero Stored Secrets**: Eliminates high-risk on-disk `.json` private keys entirely for customers adopting federated identity (Entra ID, Okta, Ping).
* **🧹 Dual-Action Cleanup & Application Decommissioning Engine**:
  * **Button 1 (Reset Target Project Assets)**: Resets migrated Discovery Engine notebooks, custom agents, chat history, user memories, and local artifacts for test iterations.
  * **Button 2 (Clean Up Install & Decommission Migration App)**: Full teardown and uninstaller. Resets any overwritten organization policies (`iam.disableServiceAccountKeyCreation`) back to inherited defaults, strips IAM roles, deletes the migration service account (permanently neutralizing Google Workspace DWD token authority, with guided manual console deletion instructions), deletes local credential and config files (`*.json`, `*.pem`, `*.jwt`), purges output directories, and restores the workstation and cloud environment to their baseline state prior to app setup.
  * **Automated Rollback Verification Engine**: Validates across 7 cloud and local security dimensions (project-level organization policy inheritance, permanent service account deletion, project IAM policy bindings revocation, Google Workspace DWD token invalidation, local private keys and config wipe, empty output directories, and cleared application state). Available via Web Console button ("Verify Rollback State"), headless CLI (`gemini-migrate verify-rollback --project <ID>`), and REST API (`GET`/`POST /api/maintenance/verify-rollback`). Automatically audits the environment after every decommission operation.
  * **Headless CLI Decommissioning**: Supports `gemini-migrate decommission --project <ID> --confirm <ID> [--wipe-target-assets]`.
* **🧪 Test Suite Expansion & Typing Fixes (88/88 Tests Passing)**:
  * Full 88-test automated suite across 11 test suites passing with 100% success rate, including new dedicated unit tests for `AppStateTracker`, `validateRollbackCompleteness`, and the maintenance router in `tests/maintenance.test.ts`.

---

## 📋 Table of Contents

- [What's New in v1.5.3](#-whats-new-in-v153)
- [What's New in v1.5.1](#-whats-new-in-v151)
- [What's New in v1.5.0](#-whats-new-in-v150)
- [What's New in v1.4.1](#-whats-new-in-v141)
- [Key Features](#-key-features)
- [Supported Migration Matrix & Identity Providers](#-supported-migration-matrix--identity-providers)
- [Pre-Requisites for Customer Environments](#-pre-requisites-for-customer-environments)
  - [1. Google Cloud APIs](#1-google-cloud-apis)
  - [2. IAM Roles & Permissions](#2-iam-roles--permissions)
  - [3. Service Account & Domain-Wide Delegation (DWD)](#3-service-account--domain-wide-delegation-dwd-setup)
  - [4. Workforce Identity Federation (WiF for Entra ID / Okta)](#4-workforce-identity-federation-wif-setup)
- [How to Run Locally on Administrator Workstation](#-how-to-run-locally)
  - [Step 1: Installation](#step-1-installation)
  - [Step 2: Authentication Setup](#step-2-authentication-setup)
  - [Step 3: Launch Local Web Console](#step-3-launch-local-web-console)
  - [Step 4: Headless CLI Execution](#step-4-headless-cli-execution)
  - [Step 5: Automated E2E Permutations Test Suite](#step-5-automated-e2e-permutations-test-suite)
- [Web Console Feature Tour (`http://127.0.0.1:8080`)](#-web-console-feature-tour)
- [Local Workstation Security & Isolation](#-local-workstation-security--isolation)
- [Configuration Reference (`migration-config.json`)](#-configuration-reference-migration-configjson)
- [User Handover, SSO Gateway & Email Notification Engine](#-user-handover-sso-gateway--email-notification-engine)
- [Google Cloud Quotas & Rate Limiting](#-google-cloud-quotas--rate-limiting)
- [Automated Testing](#-automated-testing)

---

## 🌟 Key Features

* **🤖 Custom Agent Migration & Auto-Publishing**: Deep-copies Low-Code and Workflow agents with tool attachments, system prompts, grounding data stores, and original author tags. Automatically assigns `scope: ALL_USERS` and publishes them so they immediately appear in the user's left sidebar and Agent Gallery.
* **🛠️ User-Created Skills Migration**: Discovers, exports, and restores custom user skills in Google Agent Registry (`agentregistry.googleapis.com`) and Discovery Engine Skill Agents, while intelligently excluding public Google 1P catalog templates (`cloud.google.com-*`, `discoveryengine.googleapis.com-*`, `google-*`).
* **🔍 Configuration Pre-Check & Gap Audit**: Computes an end-to-end Parity Readiness Score (0–100%) and deep feature comparison (Memory, Agent Gallery, Low-Code Builder, Skills, Sharing, Audio, Canvas, Observability, TTL). Scopes DataStore audits strictly to attached DataStores, provides 1-click target settings synchronization, and renders copy-ready CLI remediation commands with zero UI flicker.
* **📔 Research Notebooks & Granular Source Auditing**: Syncs notebooks, grounding sources (PDFs, Web URLs, YouTube videos, Google Drive docs), and studio outputs directly into the target environment. Tracks every source individually with fault-isolated batching and dedicated integrity reporting. Notes are strictly preserved as distinct artifacts, eliminating artificial source pollution.
* **🧠 Standalone Interactive Quizzes & 3D Flashcards Apps**: Converts raw compiled Angular applications into 100% offline, zero-dependency HTML5 interactive apps that run in any browser without blank screens or host dependencies. Generates interactive quiz players (with instant feedback, hints, rationales, and retake scoring), 3D flashcard flippers (with flip animations, shuffle, keyboard shortcuts, and table views), and matching printable Microsoft Word (`.docx`) study guides and Markdown banks (`.md`).
* **🎬 Explainer Video Media Compression (`ffmpeg`)**: Automatically detects `ffmpeg` and compresses high-bitrate Explainer Videos (`.mp4`) > 12 MB to 720p H.264 CRF 28 with 64k AAC audio, reducing file size by 70–75% (e.g. 24.2 MB &rarr; 6.7 MB) with zero visual loss so they fit securely inside email archives.
* **📊 NotebookLM Direct Export Parity & Office Generation**: Automatically exports NotebookLM slide decks as native **`.pptx` (Microsoft PowerPoint)** presentations and briefing docs/study guides as native **`.docx` (Microsoft Word)** files matching authentic direct NotebookLM exports (clean human-readable filenames without `(Restored)` tags or duplicate title stuttering, native markdown tables with shading and borders, 1-inch margins, bullet/numbered lists, inline citations, 16:9 widescreen slides, card container layouts, and presenter speaker notes).
* **💬 Multi-turn Chat Conversation History**: Rehydrates full turn-by-turn question/answer dialogues, thoughts, and citations in chronological order (oldest $\rightarrow$ newest) directly into users' left-hand History sidebar.
* **👤 Multi-Tenant Identity Resolution & Auto-Auth Detection**:
  * **Google Workspace / Cloud Identity**: Uses Domain-Wide Delegation (DWD) with `sa-dwd-key.json` to mint user-scoped OAuth2 tokens.
  * **Microsoft Entra ID / Okta / Ping**: Uses Google Cloud Security Token Service (STS) with RSA-signed OIDC assertions via `workforce-identity-config.json`.
  * **Auto-Resolution**: Authentication mode is automatically determined from selected Identity Providers and user email domains.
* **🔄 Context-Aware Cross-IdP Transformation Matrix**: Supports domain transformation rules (e.g. `user@onmicrosoft.com` $\rightarrow$ `user@company.com`). The mapping interface is hidden when IdPs match and automatically reveals preset suggestions when switching between different IdPs.
* **🛡️ Built-in Permissions & Least-Privilege Auditor**: Evaluates live IAM permissions, flags over-provisioned OAuth scopes, assigns security letter grades (A/B/C/F), verifies Google SAIF compliance, and provides 1-click `gcloud` IAM policy auto-fixes.
* **🧹 Selective Multi-User Target Maintenance**: Granular controls to clean Chats, Agents, Notebooks, Exported Artifacts, or Reports across all target users prior to fresh migration runs.
* **📬 Action-Oriented Handover Checklists & Single-ZIP Archive**: Generates personalized Markdown and HTML handover checklists with interactive checkboxes `[ ]` showing exact user onboarding steps (First-time sign-in, Connectors enablement, tool authorization, agent publishing). Packages all user presentations, videos, infographics, and interactive apps into a single `NotebookLM_Artifacts.zip` archive delivered via Gmail API or corporate SMTP with **Safe Staging Mode** and burst rate-limiting protection.

---

## 🔄 Supported Migration Matrix & Identity Providers

The platform supports seamless migrations across all identity combinations:

| Source IdP / Auth | Target IdP / Auth | Typical Scenario | Auth Mechanism |
| :--- | :--- | :--- | :--- |
| **Google Workspace (DWD)** | **Google Workspace (DWD)** | Tenant-to-Tenant or Dev-to-Prod GCP Migration | Service Account DWD Impersonation |
| **Google Workspace (DWD)** | **Microsoft Entra ID (WiF)** | M365 / Azure AD Consolidation to CMEK Engine | DWD Source Discovery &rarr; WiF STS Target Restore |
| **Microsoft Entra ID (WiF)** | **Microsoft Entra ID (WiF)** | Multi-Region / CMEK Entra ID Migration | WiF STS Token Minting |
| **Microsoft Entra ID (WiF)** | **Google Workspace (DWD)** | Entra ID to Google Cloud Identity Transition | WiF STS Discovery &rarr; DWD Target Restore |

---

## 🔑 Pre-Requisites for Customer Environments

### 1. Google Cloud APIs
Enable the following APIs in both the **Source** and **Target** GCP projects:

```bash
gcloud services enable discoveryengine.googleapis.com \
                       agentregistry.googleapis.com \
                       gmail.googleapis.com \
                       iam.googleapis.com \
                       sts.googleapis.com \
                       secretmanager.googleapis.com \
                       --project=<SOURCE_PROJECT_ID>

gcloud services enable discoveryengine.googleapis.com \
                       agentregistry.googleapis.com \
                       gmail.googleapis.com \
                       iam.googleapis.com \
                       sts.googleapis.com \
                       secretmanager.googleapis.com \
                       --project=<TARGET_PROJECT_ID>
```

---

### 2. IAM Roles & Permissions

The migration administrator or execution service account requires roles across **both** the Source and Target environments:

| Project | Required IAM Role | Purpose |
| :--- | :--- | :--- |
| **Source Project** | `roles/discoveryengine.admin` *(or `viewer`)* | Read-only discovery of source engines, schemas, custom agents, notebooks, datastores, and chat sessions. |
| **Source Project** | `roles/serviceusage.serviceUsageConsumer` | Authorizes Discovery Engine API consumption and pre-flight parity checks on the source project. |
| **Source Project** | `roles/iam.securityReviewer` | Allows enumerating project-level IAM bindings (`resourcemanager.projects.getIamPolicy`) during User Discovery. |
| **Target Project** | `roles/discoveryengine.admin` | Create and restore target engines, datastores, custom agents, notebooks, and chat sessions. |
| **Target Project** | `roles/iam.serviceAccountTokenCreator` | Create user-impersonated OAuth2 tokens via Domain-Wide Delegation (DWD) or WiF SA impersonation. |
| **Target Project** | `roles/serviceusage.serviceUsageConsumer` | Authorizes Discovery Engine API consumption checks on the target project. |

---

### 3. Service Account & Domain-Wide Delegation (DWD) Setup

To discover source assets, restore target assets, and send handover emails on behalf of users:

#### A. Create the Service Account & Bind Cross-Project IAM Roles in GCP:
```bash
# 1. Create Service Account in Target Project
gcloud iam service-accounts create gemini-dwd-migrator \
    --display-name="Gemini Enterprise Migration Service Account" \
    --project=<TARGET_PROJECT_ID>

# 2. Grant roles on TARGET Project (Restore & Token Minting)
gcloud projects add-iam-policy-binding <TARGET_PROJECT_ID> \
    --member="serviceAccount:gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/discoveryengine.admin"

gcloud projects add-iam-policy-binding <TARGET_PROJECT_ID> \
    --member="serviceAccount:gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/iam.serviceAccountTokenCreator"

gcloud projects add-iam-policy-binding <TARGET_PROJECT_ID> \
    --member="serviceAccount:gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/serviceusage.serviceUsageConsumer"

# 3. Grant roles on SOURCE Project (MANDATORY for Cross-Project Discovery & Parity Audit)
gcloud projects add-iam-policy-binding <SOURCE_PROJECT_ID> \
    --member="serviceAccount:gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/discoveryengine.admin"

gcloud projects add-iam-policy-binding <SOURCE_PROJECT_ID> \
    --member="serviceAccount:gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/serviceusage.serviceUsageConsumer"

gcloud projects add-iam-policy-binding <SOURCE_PROJECT_ID> \
    --member="serviceAccount:gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/iam.securityReviewer"

# 4. Generate Service Account Key
gcloud iam service-accounts keys create sa-dwd-key.json \
    --iam-account="gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com"
```

> [!IMPORTANT]
> **Organization Policy Notice (`iam.disableServiceAccountKeyCreation`)**:
> If key creation returns `FAILED_PRECONDITION: Precondition check failed` or `Constraint iam.disableServiceAccountKeyCreation violated`, your GCP organization restricts service account key downloads.
> * **Automatic Verification**: Open the **Auth Wizard &rarr; Step 1** in the web console (`http://localhost:8080`) and click **🛡️ Check Org Policies** for an automated pre-flight scan.
> * **1-Click Project Override**: If your GCP user account holds `roles/orgpolicy.policyAdmin`, click **⚡ 1-Click Project Override** in the web console, or apply the exemption via `gcloud`:
>   ```bash
>   cat << 'EOF' > /tmp/override-key-creation.json
>   {
>     "name": "projects/<TARGET_PROJECT_ID>/policies/iam.disableServiceAccountKeyCreation",
>     "spec": {
>       "rules": [{ "enforce": false }]
>     }
>   }
>   EOF
>   gcloud org-policies set-policy /tmp/override-key-creation.json --project=<TARGET_PROJECT_ID>
>   ```
> * **Recommended Keyless Alternative**: Switch to **Workforce Identity Federation (WiF)** in Step 2. WiF is **100% immune** to key creation restrictions because tokens are minted in-memory directly via Google Cloud STS (`sts.googleapis.com`) with zero on-disk private keys.

#### B. Authorize DWD in Google Workspace Admin Console:
1. Open the [Google Workspace Admin Console](https://admin.google.com/).
2. Navigate to **Security** &rarr; **Access and data control** &rarr; **API controls** &rarr; **Manage Domain Wide Delegation**.
3. Click **Add new** and enter:
   * **Client ID**: The numeric `client_id` from your `sa-dwd-key.json` file.
   * **OAuth Scopes (comma-separated)**:
     ```text
     https://www.googleapis.com/auth/discoveryengine.readwrite, https://www.googleapis.com/auth/discoveryengine.assist.readwrite, https://www.googleapis.com/auth/gmail.send
     ```
4. Click **Authorize**.

---

### 4. Workforce Identity Federation (WiF Setup for Entra ID / Okta)

For organizations using Microsoft Entra ID or Okta:
1. Open the local web console at `http://localhost:8080` and navigate to **"🔐 Auth & WiF Wizard" &rarr; "🌐 Workforce Identity Federation (WiF)"**.
2. Select your IdP (Microsoft Entra ID, Okta, or Ping).
3. The wizard will generate the exact `gcloud iam workforce-pools` commands for your organization and create the `workforce-identity-config.json` client configuration.

> [!TIP]
> **Keyless Architecture & Organization Policy Immunity**:
> Workforce Identity Federation does NOT require Service Account keys (`sa-dwd-key.json`). STS exchanges are entirely immune to `iam.disableServiceAccountKeyCreation` and `iam.disableServiceAccountKeyUpload` organization policies. The only policy to ensure is `iam.allowedPolicyMemberDomains` if workforce pool principal sets (`principalSet://iam.googleapis.com/...`) are restricted.

---

## 💻 How to Run Locally

### Step 1: Installation
Ensure **Node.js >= 20.0.0** is installed on your workstation:

```bash
git clone <REPO_URL>
cd "headless migration tool"

# Install all dependencies
npm install

# Build TypeScript
npm run build
```

---

### Step 2: Authentication Setup
Place your authorized `sa-dwd-key.json` (and/or `workforce-identity-config.json`) in the project root directory:

```bash
# Option A: Place sa-dwd-key.json in root (Auto-detected)
cp /path/to/sa-dwd-key.json ./sa-dwd-key.json

# Option B: Authenticate via gcloud Application Default Credentials (ADC)
gcloud auth application-default login
```

---

### Step 3: Launch Local Web Console
Start the interactive migration console:

```bash
npm run ui
```

Open your browser to: **`http://127.0.0.1:8080`**

---

### Step 4: Headless CLI Execution

The platform is designed to be executed **headlessly via the command line** (for CI/CD pipelines, automated cron jobs, or bastion scripts) without launching the web server.

#### A. Run Headless with a JSON Configuration File
```bash
# 1. Run Dry-Run Simulation (no changes applied to target)
npx tsx src/cli.ts --config migration-config.json --dry-run

# 2. Execute Live Batch Migration for specific users
npx tsx src/cli.ts --config migration-config.json --users "alice@company.com" "bob@company.com"

# 3. Execute Organization-Wide Migration with high concurrency
npx tsx src/cli.ts --config migration-config.json --concurrency 15

# 4. Skip specific asset types or enable artifact extraction
npx tsx src/cli.ts --config migration-config.json --no-sessions --export-artifacts
```

#### B. Run Headless with Environment Variables (Zero Configuration File)
You can supply migration parameters directly via standard environment variables:
```bash
export SOURCE_PROJECT_ID="source-gcp-project-id"
export SOURCE_APP_ID="source-engine-id"
export SOURCE_LOCATION="global"
export TARGET_PROJECT_ID="target-gcp-project-id"
export TARGET_APP_ID="target-engine-id"
export TARGET_LOCATION="global"
export SERVICE_ACCOUNT_KEY_PATH="./sa-dwd-key.json"

# Execute headless migration directly
npx tsx src/cli.ts --dry-run --users "*@company.com"
```

#### C. Full CLI Flags Reference

| CLI Flag | Description | Default Value |
| :--- | :--- | :--- |
| `-c, --config <path>` | Path to JSON migration configuration file | Auto-detected from ENV |
| `--dry-run` | Simulate discovery and restoration without modifying target environment | `false` |
| `--users <users...>` | Filter migration to specific emails or domain patterns (e.g. `*@company.com`) | All discovered users |
| `--concurrency <number>` | Maximum parallel worker threads | `10` |
| `--no-notebooks` | Skip Gemini / NotebookLM notebooks migration | Migrates notebooks |
| `--no-agents` | Skip Custom Agents migration | Migrates agents |
| `--no-sessions` | Skip Chat conversation histories and turns migration | Migrates chat history |
| `--no-memories` | Skip user personalized memories and facts migration | Migrates memories |
| `--no-skills` | Skip Agent Registry custom skills migration | Migrates skills |
| `--export-memories` | Export backup snapshot of user memories to disk (`./exports/memories`) | `true` |
| `--agent-types <types...>` | Filter agent types (`LOW_CODE`, `WORKFLOW`, `ADK`, `A2A`, `ALL`) | `ALL` |
| `--publish-agents` | Automatically publish migrated agents for immediate organization visibility | `true` |
| `--export-artifacts` | Extract presentations, Canva-style docs, and HTML artifacts to `./exports` | `true` |
| `--no-preserve-sharing` | Do not replicate sharing configurations (`ALL_USERS` / `RESTRICTED`) | Preserves sharing |
| `--resume <reportPath>` | Resume migration by skipping already-successful assets from a previous JSON report | None |
| `--service-account-key <path>` | Path to Google Cloud Service Account JSON key (for DWD) | Auto-detects `./sa-dwd-key.json` |
| `--token <token>` | Explicit Google OAuth Access Token (overrides ADC/DWD) | Optional |
| `--output-dir <dir>` | Directory where Markdown and JSON audit reports are saved | `./reports` |

#### D. Headless Outputs & CI/CD Integration
When executed headlessly:
* **Stdout Stream**: Outputs color-coded progress, discovery summaries, and pre-flight validation.
* **Audit Certificates**: Generates both a human-readable Markdown report (`reports/migration-report-<id>.md`) and a structured JSON certificate (`reports/migration-report-<id>.json`).
* **Artifact Extraction**: Exports `.pptx` slide decks, `.docx` study guides, and HTML dashboards to `./exports/artifacts/`.
* **POSIX Exit Codes**: Exits with code `0` on success and code `1` on failure, allowing seamless integration into automation workflows.

---

### Step 5: Automated E2E Permutations Test Suite
Run the automated end-to-end matrix test pipeline covering all auth permutations (DWD-WiF, DWD-DWD, WiF-DWD, WiF-WiF):

```bash
npm run test:e2e-matrix
```

---

## 🖥️ Web Console Feature Tour (`http://127.0.0.1:8080`)

The local Web Console is structured as a sequential 6-step administrative wizard:

1. **Step 1: 🔐 Auth & Identity Provider Wizard (`#wizard`)**:
   - **🔑 DWD Wizard**: Multi-project setup accepting Source and Target GCP Project IDs, automated `gcloud` IAM command generator for both environments, OAuth scope clipboard, live impersonation test, automated **🛡️ Org Policy Pre-Flight**, and **⚡ 1-Click Project-Level Policy Override** for `iam.disableServiceAccountKeyCreation`.
   - **🌐 WiF Wizard**: IdP presets (Entra ID, Okta, Ping), pool parameter generator, live IAM Credentials API (`generateAccessToken`) verification, and **Keyless Architecture Assessment** highlighting 100% immunity to key creation blocks.
   - **🛡️ Permissions & Least-Privilege Auditor**: Evaluates required vs over-provisioned permissions, audits target organization policies, outputs letter grade (A/B/C/F), checks Google SAIF compliance, and provides 1-click IAM policy auto-fix buttons.
2. **Step 2: 🔍 Configuration Pre-Check & Gap Audit (`#audit`)**:
   - Interactive Source and Target environment selector cards (Project ID, Region, Collection, Engine/App ID) with real-time bi-directional synchronization to Migration Studio.
   - Guided empty-state guardrail preventing premature blank audits.
   - Pre-flight gap audit dashboard with 0–100% Parity Readiness Score gauge and status badges (`Ready`, `Action Recommended`, `Critical Gaps`).
   - Side-by-side engine feature flag comparison matrix (Memory, Agent Gallery, Skills, Audio, Canvas, Observability, TTL).
   - 1-Click "Sync Target Engine Settings" button to automatically align target feature flags via Discovery Engine PATCH API.
   - Attached DataStore Parity audit with automated remediation and copy-ready CLI snippets.
   - Prominent `Next: Proceed to Step 3: Migration Studio ➔` wizard transition.
3. **Step 3: 🚀 Migration Studio (`#studio`)**:
   - Synchronized Source and Target GCP environment pickers and asset scope selectors (Notebooks, Custom Agents, User Skills, Chat Sessions, Memories, Studio Artifacts).
   - Dynamic asset discovery with user selection table.
   - Context-aware Cross-IdP transformation matrix with preset domain rules.
   - Streamlined execution bar (`⚡ Execute Pre-Flight Dry Run` / `⚡ Execute Live Migration` and `← Step 2: Config & Parity Audit` back-link).
   - Real-time Server-Sent Events (SSE) live migration stream with color-coded logs and progress bars.
4. **Step 4: 📊 Latest Report & Historical Runs (`#reports`)**:
   - View and search comprehensive migration certificates and audit tables.
   - Executive KPIs tracking discovered, migrated, and failed counts for both notebooks and individual sources.
   - Dedicated **Section 5: Notebook Sources Breakdown & Integrity Audit** detailing every source document, parent notebook, type, status, and error logs.
   - Export reports in both human-readable Markdown (`.md`) and structured JSON (`.json`).
5. **Step 5: 📬 User Handover & Email Dispatch (`#handover`)**:
   - Individual user checklists with deep links to target Gemini Enterprise apps and skipped-asset warning indicators.
   - Visual status badges (`📄 X Sources Ready`, `⚠️ Y Failed`) with expandable `<details>` accordions listing all source documents.
   - Step 1 First-Time Login and Connector Authorization (Google Workspace, M365, Jira, etc.) walkthroughs.
   - One-click handover dispatch via Gmail API or SMTP with optional staging recipient overrides.
6. **Step 6: 🧹 Target Maintenance & Platform Decommissioning (`#maintenance`)**:
   - **Button 1: Reset Target Project Assets**: Purges migrated target project assets (notebooks, custom agents, chat history, user memories, reports, artifacts) for test iteration resets.
   - **Button 2: Clean Up Install & Decommission Migration App**: Complete uninstaller that deletes the migration service account, removes GCP IAM roles, resets any overridden organization policies (`iam.disableServiceAccountKeyCreation`) back to inherited parent defaults, automatically invalidates Google Workspace DWD, wipes all local credential/JSON files, and purges output folders to restore the workstation and GCP project to their pre-setup baseline.
   - **Automated Rollback Verification Engine**: Live 7-dimension audit (`🔍 Verify Rollback State`) proving cloud and local baseline cleanliness.

---

## 🔒 Local Workstation Security & Isolation

Designed to run **strictly on the administrator's local machine**:

* **🔒 Localhost Loopback Binding (`127.0.0.1`)**: The web console listens strictly on loopback (`http://127.0.0.1:8080`), blocking inbound access from the external network.
* **🛡️ Direct Google Cloud REST Calling**: All API calls originate directly from the administrator's authenticated workstation over TLS/HTTPS.
* **📁 Local Key & File Isolation**: Keys (`sa-dwd-key.json`), exported research docs, and audit reports stay entirely on the local disk.
* **🛡️ SSRF & Header-Only Token Protection**: Strict URL allowlisting for Discovery Engine endpoints and header-only Bearer token injection.
* **🚫 Hardened `.gitignore`**: Blocks all private keys, JWTs, certificates, PII reports, and exported artifacts from Git tracking.

---

## ⚙️ Configuration Reference (`migration-config.json`)

```json
{
  "source": {
    "projectId": "source-gcp-project-id",
    "appLocation": "global",
    "collectionId": "default_collection",
    "appId": "ge-source-engine",
    "assistantId": "default_assistant"
  },
  "target": {
    "projectId": "target-gcp-project-id",
    "appLocation": "global",
    "collectionId": "default_collection",
    "appId": "ge-target-engine",
    "assistantId": "default_assistant"
  },
  "auth": {
    "authType": "SERVICE_ACCOUNT_KEY",
    "serviceAccountKeyPath": "./sa-dwd-key.json"
  },
  "options": {
    "migrateNotebooks": true,
    "migrateAgents": true,
    "migrateSessions": true,
    "migrateMemories": true,
    "migrateSkills": true,
    "exportMemories": true,
    "exportArtifacts": true,
    "dryRun": false,
    "concurrency": 10,
    "userFilter": ["*@company.com"],
    "preserveOwnership": true
  },
  "idpMapping": {
    "sourceIdp": "ENTRA_ID",
    "targetIdp": "GOOGLE_CLOUD_IDENTITY",
    "domainRules": [
      {
        "fromDomain": "onmicrosoft.com",
        "toDomain": "company.com"
      }
    ]
  },
  "identityMapping": {
    "external-user@onmicrosoft.com": "internal-user@company.com"
  },
  "datastoreMapping": {
    "source-policy-datastore": "target-policy-datastore"
  }
}
```

---

## 📬 User Handover, SSO Gateway & Email Notification Engine

Following a migration, administrators can generate and dispatch individual handover bundles:

1. **Checklist Email with Interactive Checkboxes & SSO Links**:
   * Generates location-aware Google Cloud Workforce Sign-In gateway URLs:
     `https://auth.cloud.google/signin/locations/global/workforcePools/<poolId>/providers/<providerId>?continueUrl=<encodedAppUrl>`
   * Step 1: Login & Authorize Connected Workplace Tools via the prompt bar Connectors menu (⊶ / Sliders icon for Outlook, OneDrive, Google Workspace, Jira, etc.).
   * Step 2: Access Transferred Custom Agents in the left sidebar and Agent Gallery.
   * Step 3: Access Research Notebooks & Sources.
2. **Authentic NotebookLM Direct Export Office Attachments**:
   * Slide Decks &rarr; Attached as authentic **`.pptx` (Microsoft PowerPoint)** presentations (16:9 widescreen, executive theme, speaker notes, and clean filenames like `Notebook - Title.pptx`).
   * Reports & Study Guides &rarr; Attached as authentic **`.docx` (Microsoft Word)** documents (1-inch margins, Arial hierarchy, native tables with borders and shading, bullet/numbered lists, inline citations).
   * Local Backup & EML &rarr; All files and MIME packages are saved offline in `./user_handover_reports/<user>/`.
3. **Dispatch Modes**:
   * **Single User Test**: Validates email rendering, formatting, and Office attachments for a single recipient.
   * **Bulk Organization Dispatch**: Dispatches personalized checklists across all migrated users or selected users from the UI table, with automated pacing delays (default: 250ms) to prevent API burst throttling.
   * **Safe Staging Mode**: Supports an override recipient address so all bulk bundles are redirected to an administrative staging inbox for validation before staff delivery.
   * **Headless CLI Trigger**: Use `--generate-user-reports` and `--notify-users [overrideEmail]` to automate handover directly from CI/CD pipelines.

---

## 📈 Google Cloud Quotas & Rate Limiting

The migration tool is engineered for enterprise-scale execution and incorporates resilient handling for Discovery Engine API quotas and rate limits:

* **Exponential Backoff with Full Jitter**:
  When encountering HTTP 429 (`RESOURCE_EXHAUSTED`) or transient 5xx errors, the engine automatically retries operations up to 5 times with randomized exponential backoff (capping at 15s delays) to safely handle burst throttling.
* **Per-User Daily Agent Creation Quotas (`AgentCreateRequestsPerDayPerUser`)**:
  Google Cloud Discovery Engine enforces a daily per-user ceiling on custom agent creations. In new test projects or standard sandbox environments, this limit can be reached after extensive creation cycles within a single day.
  * **Automatic Reset Window**: Resets automatically at **00:00 PST (08:00 UTC)**.
  * **Quota Adjustments**: In the GCP Console, navigate to **IAM & Admin &rarr; Quotas & System Limits** for the target project and filter for `discoveryengine.googleapis.com/agent_create_requests` to view limits or request an increase.
  * **Phased Migration Fault-Tolerance**: If agent creation limits are encountered, other asset migrations (Notebooks, Grounding Sources, Chat Sessions, and User Memories) continue executing unaffected without aborting the pipeline.

---

## 🧪 Automated Testing

The platform includes an extensive automated test suite with **106 automated tests across 14 test suites** covering authentication, cross-project parity audits, Agent Registry skills discovery/filtering, memory migration, session rehydration, reporters, NotebookLM artifact formatting, bulk email dispatching, security guardrails, and E2E execution flows:

```bash
# Run complete unit and integration test suite (106 tests across 14 suites)
npm test

# Run End-to-End matrix permutations test (DWD/WiF permutations)
npm run test:e2e-matrix

# Type-check TypeScript codebase
npm run typecheck

# Build TypeScript to dist/
npm run build
```

---

## 📄 License
Copyright 2026 Google LLC. Licensed under the [Apache-2.0 License](LICENSE).

