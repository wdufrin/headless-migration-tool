# 🚀 Gemini Enterprise Admin Migration Platform (`gemini-migrate`)

[![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE)

An enterprise admin-driven headless platform and web console for migrating **Gemini Enterprise (Google Cloud Discovery Engine)** custom agents, research notebooks, studio artifacts, grounding sources, chat conversation history, and associated IAM permissions across Google Cloud environments and Identity Providers.

---

## 🚀 What's New in v1.2.0

* **📑 Granular Notebook Source Migration & Integrity Auditing**:
  * **Document-Level Tracking**: Tracks every individual grounding source (PDFs, Web URLs, Google Drive docs, text snippets, and Studio artifacts) with explicit status (`SUCCESS`, `FAILED`, `SKIPPED`, `DRY_RUN`).
  * **Batch Creation with Automatic Individual Fallback**: Uses a resilient ingestion strategy—attempts high-speed batch creation; if a batch call encounters an issue, it automatically falls back to item-by-item creation so valid sources succeed and only faulty ones fail.
  * **Studio Artifact Preservation**: Automatically converts NotebookLM Studio briefing docs, study guides, and outlines into structured text sources within the restored target notebook.
  * **Section 5 Sources Audit Trail**: Migration reports (Markdown and JSON) now include **Section 5: Notebook Sources Breakdown & Integrity Audit**, listing parent notebook, source title, content type, migration status (`✅ SUCCESS` / `❌ FAILED`), and exact error diagnostics.
* **📬 Enhanced User Handover Packages**:
  * HTML verification checklists display visual pill badges (`📄 X Sources Ready`, `⚠️ Y Failed`) with expandable `<details>` accordions listing all source documents.
  * User Markdown handover bundles provide itemized source breakdowns and status under each notebook.
  * Email engine supports custom recipient overrides for staging verification prior to user dispatch.
* **🧹 Multi-User Target Environment Maintenance**:
  * Destination cleanup utility identifies and cleans notebooks and agents across all target users, preventing orphaned assets across testing iterations.
* **⚡ Quota & Rate Limit Resilience**:
  * Full jitter exponential backoff handling for HTTP 429 (`RESOURCE_EXHAUSTED`).
  * Quota error diagnostics reporting specific metric and limit metadata (e.g. `AgentCreateRequestsPerDayPerUser`).

---

## 📋 Table of Contents

- [What's New in v1.2.0](#-whats-new-in-v120)
- [Key Features](#-key-features)
- [Supported Migration Matrix & Identity Providers](#-supported-migration-matrix--identity-providers)
- [Pre-Requisites for Customer Environments](#-pre-requisites-for-customer-environments)
  - [1. Google Cloud APIs](#1-google-cloud-apis)
  - [2. IAM Roles & Permissions](#2-iam-roles--permissions)
  - [3. Service Account & Domain-Wide Delegation (DWD)](#3-service-account--domain-wide-delegation-dwd-setup)
  - [4. Workforce Identity Federation (WiF for Entra ID / Okta)](#4-workforce-identity-federation-wif-setup)
- [How to Run Locally on Administrator Workstation](#-how-to-run-locally-on-administrator-workstation)
  - [Step 1: Installation](#step-1-installation)
  - [Step 2: Authentication Setup](#step-2-authentication-setup)
  - [Step 3: Launch Local Web Console](#step-3-launch-local-web-console)
  - [Step 4: Headless CLI Execution](#step-4-headless-cli-execution)
  - [Step 5: Automated E2E Permutations Test Suite](#step-5-automated-e2e-permutations-test-suite)
- [Web Console Feature Tour (`http://localhost:8080`)](#-web-console-feature-tour)
- [Local Workstation Security & Isolation](#-local-workstation-security--isolation)
- [Configuration Reference (`migration-config.json`)](#-configuration-reference-migration-configjson)
- [User Handover, SSO Gateway & Email Notification Engine](#-user-handover-sso-gateway--email-notification-engine)
- [Architecture & InfoSec Compliance](#-architecture--infosec-compliance)
- [Google Cloud Quotas & Rate Limiting](#-google-cloud-quotas--rate-limiting)
- [Automated Testing](#-automated-testing)

---

## 🌟 Key Features

* **🤖 Custom Agent Migration & Auto-Publishing**: Deep-copies Low-Code and Workflow agents with tool attachments, system prompts, grounding data stores, and original author tags. Automatically assigns `scope: ALL_USERS` and publishes them so they immediately appear in the user's left sidebar and Agent Gallery.
* **📔 Research Notebooks & Granular Source Auditing**: Syncs notebooks, grounding sources (PDFs, Web URLs, YouTube videos, Google Drive docs), studio notes, and outputs directly into the target environment. Tracks every source individually with fault-isolated batching and dedicated integrity reporting.
* **🧠 User Memories & Personalization Facts**: Discovers, migrates, and restores learned user preferences, personal context facts, and Reasoning Engine memories across Discovery Engine instances.
* **📊 Office Document & Artifact Generation**: Automatically exports NotebookLM slide decks as native **`.pptx` (Microsoft PowerPoint)** and briefing docs/study guides as native **`.docx` (Microsoft Word)** files into `./exports/artifacts`.
* **💬 Multi-turn Chat Conversation History**: Rehydrates full turn-by-turn question/answer dialogues, thoughts, and citations in chronological order (oldest $\rightarrow$ newest) directly into users' left-hand History sidebar.
* **👤 Multi-Tenant Identity Resolution & Auto-Auth Detection**:
  * **Google Workspace / Cloud Identity**: Uses Domain-Wide Delegation (DWD) with `sa-dwd-key.json` to mint user-scoped OAuth2 tokens.
  * **Microsoft Entra ID / Okta / Ping**: Uses Google Cloud Security Token Service (STS) with RSA-signed OIDC assertions via `workforce-identity-config.json`.
  * **Auto-Resolution**: Authentication mode is automatically determined from selected Identity Providers and user email domains.
* **🔄 Context-Aware Cross-IdP Transformation Matrix**: Supports domain transformation rules (e.g. `user@onmicrosoft.com` $\rightarrow$ `user@company.com`). The mapping interface is hidden when IdPs match and automatically reveals preset suggestions when switching between different IdPs.
* **🛡️ Built-in Permissions & Least-Privilege Auditor**: Evaluates live IAM permissions, flags over-provisioned OAuth scopes, assigns security letter grades (A/B/C/F), verifies Google SAIF compliance, and provides 1-click `gcloud` IAM policy auto-fixes.
* **🧹 Selective Multi-User Target Maintenance**: Granular controls to clean Chats, Agents, Notebooks, Exported Artifacts, or Reports across all target users prior to fresh migration runs.
* **📬 End-User Handover Bundle & Authenticated SSO Links**: Generates personalized Markdown and HTML handover checklists with direct Google Cloud Workforce Sign-In gateway URLs (`auth.cloud.google/signin/...`), source readiness status, and Step 1 connector authorization walkthroughs.

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
                       gmail.googleapis.com \
                       iam.googleapis.com \
                       sts.googleapis.com \
                       secretmanager.googleapis.com \
                       --project=<SOURCE_PROJECT_ID>

gcloud services enable discoveryengine.googleapis.com \
                       gmail.googleapis.com \
                       iam.googleapis.com \
                       sts.googleapis.com \
                       secretmanager.googleapis.com \
                       --project=<TARGET_PROJECT_ID>
```

---

### 2. IAM Roles & Permissions

The migration administrator or execution service account requires the following roles:

| Project | Required IAM Role | Purpose |
| :--- | :--- | :--- |
| **Source Project** | `roles/discoveryengine.viewer` | Read-only discovery of source custom agents, notebooks, datastores, and chat sessions. |
| **Target Project** | `roles/discoveryengine.admin` | Create and restore target engines, datastores, custom agents, notebooks, and chat sessions. |
| **Target Project** | `roles/iam.serviceAccountTokenCreator` | Create user-impersonated OAuth2 tokens via Domain-Wide Delegation (DWD). |

---

### 3. Service Account & Domain-Wide Delegation (DWD) Setup

To restore assets and send handover emails on behalf of Google Workspace users:

#### A. Create the Service Account in GCP:
```bash
# Create Service Account
gcloud iam service-accounts create gemini-dwd-migrator \
    --display-name="Gemini Enterprise Migration Service Account" \
    --project=<TARGET_PROJECT_ID>

# Grant Discovery Engine Admin role
gcloud projects add-iam-policy-binding <TARGET_PROJECT_ID> \
    --member="serviceAccount:gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/discoveryengine.admin"

# Generate Service Account Key
gcloud iam service-accounts keys create sa-dwd-key.json \
    --iam-account="gemini-dwd-migrator@<TARGET_PROJECT_ID>.iam.gserviceaccount.com"
```

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
| `--export-memories` | Export backup snapshot of user memories to disk (`./exports/memories`) | `true` |
| `--agent-types <types...>` | Filter agent types (`LOW_CODE`, `WORKFLOW`, `ADK`, `A2A`, `ALL`) | `ALL` |
| `--publish-agents` | Automatically publish migrated agents for immediate organization visibility | `true` |
| `--export-artifacts` | Extract presentations, Canva-style docs, and HTML artifacts to `./exports` | `true` |
| `--no-preserve-sharing` | Do not replicate sharing configurations (`ALL_USERS` / `RESTRICTED`) | Preserves sharing |
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

## 🖥️ Web Console Feature Tour

The local Web Console provides 5 dedicated modules:

1. **🚀 Migration Studio**:
   - Interactive engine picker for Source and Target GCP environments.
   - Dynamic asset discovery with user selection table.
   - Context-aware Cross-IdP transformation matrix with preset domain rules.
   - Real-time Server-Sent Events (SSE) live migration stream with color-coded logs and live progress across Notebooks, Sources, Agents, Chat Sessions, and Memories.
2. **📊 Latest Report & Historical Runs**:
   - View and search comprehensive migration certificates and audit tables.
   - Executive KPIs tracking discovered, migrated, and failed counts for both notebooks and individual sources.
   - Dedicated **Section 5: Notebook Sources Breakdown & Integrity Audit** detailing every source document, parent notebook, type, status, and error logs.
   - Export reports in both human-readable Markdown (`.md`) and structured JSON (`.json`).
3. **📬 User Handover & Email Dispatch**:
   - Individual user checklists with deep links to target Gemini Enterprise apps.
   - Visual status badges (`📄 X Sources Ready`, `⚠️ Y Failed`) with expandable `<details>` accordions listing all source documents.
   - Step 1 First-Time Login and Connector Authorization (Google Workspace, M365, Jira, etc.) walkthroughs.
   - One-click handover dispatch via Gmail API or SMTP with optional staging recipient overrides.
4. **🔐 Auth & Identity Provider Wizard**:
   - **🔑 DWD Wizard**: Step-by-step setup, scope clipboard, and live impersonation test.
   - **🌐 WiF Wizard**: IdP presets (Entra ID, Okta, Ping), pool parameter generator, and live token test.
   - **🛡️ Permissions & Least-Privilege Auditor**: Evaluates required vs over-provisioned permissions, outputs letter grade (A/B/C/F), checks Google SAIF compliance, and provides 1-click IAM policy auto-fix buttons.
5. **🗑️ Target Destination Maintenance & Multi-User Cleanup**:
   - Automatically identifies all users in the target environment to clean user-scoped notebooks and agents.
   - Selective checkboxes to clean Chats, Custom Agents, Notebooks, Exported Artifacts, or Migration Reports prior to test runs.

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
        "sourceDomain": "onmicrosoft.com",
        "targetDomain": "company.com"
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

Following a migration, end-users receive an individual handover bundle:

1. **Checklist Email with Interactive Checkboxes & SSO Links**:
   * Generates location-aware Google Cloud Workforce Sign-In gateway URLs:
     `https://auth.cloud.google/signin/locations/global/workforcePools/<poolId>/providers/<providerId>?continueUrl=<encodedAppUrl>`
   * Step 1: Login & Authorize Connected Workplace Tools via the prompt bar Connectors menu (⊶ / Sliders icon for Outlook, OneDrive, Google Workspace, Jira, etc.).
   * Step 2: Access Transferred Custom Agents in the left sidebar and Agent Gallery.
   * Step 3: Access Research Notebooks & Sources.
2. **Native Office Document Attachments**:
   * Slide Decks &rarr; Attached as real **`.pptx` (Microsoft PowerPoint)** presentations.
   * Reports & Study Guides &rarr; Attached as real **`.docx` (Microsoft Word)** documents.
3. **Dispatch Options**:
   * **Google Gmail REST API**: Native OAuth2 dispatch using Domain-Wide Delegation.
   * **Corporate SMTP**: Integration with corporate relays (Office 365, Postfix, SendGrid).

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

```bash
# Run complete unit and integration test suite
npm test

# Type-check TypeScript codebase
npm run typecheck

# Build TypeScript to dist/
npm run build
```

---

## 📄 License
Copyright 2026 Google LLC. Licensed under the [Apache-2.0 License](LICENSE).

