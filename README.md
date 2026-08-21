# Gemini Enterprise Admin Migration Tool (`gemini-migrate`)

Enterprise admin-driven headless tool and web service for migrating **Gemini Enterprise (Discovery Engine)** custom agents, research notebooks, notes, grounding sources, chat conversation history, and associated IAM permissions across Google Cloud environments on behalf of users.

---

## 📋 Table of Contents

- [Key Features](#-key-features)
- [Pre-Requisites for Customer Environment](#-pre-requisites-for-customer-environment)
  - [1. Google Cloud APIs](#1-google-cloud-apis)
  - [2. IAM Roles & Permissions](#2-iam-roles--permissions)
  - [3. Service Account & Domain-Wide Delegation (DWD)](#3-service-account--domain-wide-delegation-dwd-setup)
- [How to Run Locally on Administrator Workstation](#-how-to-run-locally-on-administrator-workstation)
  - [Step 1: Installation](#step-1-installation)
  - [Step 2: Local Authentication & DWD Keys](#step-2-local-authentication--dwd-keys)
  - [Step 3: Launch Local Web Console](#step-3-launch-local-web-console)
  - [Step 4: Run Headless via Terminal CLI](#step-4-run-headless-via-terminal-cli)
- [Local Workstation Security & Isolation](#-local-workstation-security--isolation)
- [Configuration Reference (`migration-config.json`)](#-configuration-reference-migration-configjson)
- [User Handover & Email Notification Engine](#-user-handover--email-notification-engine)
- [Architecture & InfoSec Compliance](#-architecture--infosec-compliance)

---

## 🚀 Key Features

* **🤖 Custom Agent Migration**: Restores Low-Code and Workflow agents with tool attachments, system prompts, grounding data stores, and original author tags.
* **📓 NotebookLM Research Migration**: Deep-syncs all notebooks, grounding sources (PDFs, Web URLs, YouTube videos, Google Drive docs), studio notes, and outputs.
* **📊 Real Office Document Generation**: Automatically exports NotebookLM slide decks as native **`.pptx` (PowerPoint)** and briefing docs/study guides as native **`.docx` (Word)** files.
* **💬 Complete Chat Session History**: Rehydrates full turn-by-turn question/answer dialogues, thoughts, and citations directly into users' left-hand History sidebar.
* **👤 True User Ownership Preservation**: Uses Google Workspace **Domain-Wide Delegation (DWD)** to mint user-scoped tokens, ensuring migrated assets belong directly to the end users rather than a generic service account.
* **📬 Automated End-User Handover Emails**: Dispatches friendly, card-based email checklists with interactive clickable task checkboxes and curated `.pptx`/`.docx` attachments via the **Gmail API**.
* **🛡️ Enterprise InfoSec Hardened**: Zero hardcoded secrets, strict SSRF regex validation, non-root container (`UID 1000`), and domain allowlisting.

---

## 🔑 Pre-Requisites for Customer Environment

Before deploying or running migrations in a customer environment, ensure the following Google Cloud and Google Workspace requirements are met.

### 1. Google Cloud APIs
Enable the following APIs in both the **Source** and **Target** GCP projects:

```bash
gcloud services enable discoveryengine.googleapis.com \
                       gmail.googleapis.com \
                       iam.googleapis.com \
                       secretmanager.googleapis.com \
                       --project=<SOURCE_PROJECT_ID>

gcloud services enable discoveryengine.googleapis.com \
                       gmail.googleapis.com \
                       iam.googleapis.com \
                       secretmanager.googleapis.com \
                       --project=<TARGET_PROJECT_ID>
```

---

### 2. IAM Roles & Permissions

The administrator or deployment service account executing the migration needs the following roles:

| Project | Required IAM Role | Purpose |
| :--- | :--- | :--- |
| **Source Project** | `roles/discoveryengine.viewer` | Read-only discovery of source agents, notebooks, grounding sources, and chat sessions (Least Privilege). |
| **Target Project** | `roles/discoveryengine.admin` | Create and restore target engines, datastores, agents, notebooks, and chat sessions. |
| **Target Project** | `roles/iam.serviceAccountTokenCreator` | Create user-impersonated OAuth2 tokens via Domain-Wide Delegation (DWD). |

---

### 3. Service Account & Domain-Wide Delegation (DWD) Setup

To create target notebooks, custom agents, and send handover emails on behalf of actual domain users (e.g. `user@company.com`), configure a Service Account with Domain-Wide Delegation:

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
   * **Client ID**: The numeric `client_id` from your `sa-dwd-key.json` file (or GCP IAM console).
   * **OAuth Scopes (comma-separated)**:
     ```text
     https://www.googleapis.com/auth/discoveryengine.readwrite, https://www.googleapis.com/auth/discoveryengine.assist.readwrite, https://www.googleapis.com/auth/gmail.send
     ```
4. Click **Authorize**.

---

## 💻 How to Run Locally

### Step 1: Installation
Ensure **Node.js >= 20.0.0** is installed on your machine:

```bash
git clone <REPO_URL>
cd "headless migration tool"

# Install all dependencies
npm install

# Build TypeScript
npm run build
```

---

### Step 2: Authentication
Place your authorized `sa-dwd-key.json` file in the project root directory, or authenticate via Google Cloud Application Default Credentials (ADC):

```bash
# Option A: Place sa-dwd-key.json in root (Auto-detected)
cp /path/to/sa-dwd-key.json ./sa-dwd-key.json

# Option B: Authenticate via gcloud CLI
gcloud auth login
gcloud auth application-default login
```

---

### Step 3: Launch Admin Web Console
Start the local interactive Web Studio & Admin Dashboard:

```bash
npm run ui
```

Open your browser to: **`http://localhost:8080`**

#### What you can do in the Web Console:
1. **🚀 Migration Studio**: Select Source & Target GCP projects, configure agent/notebook filters, and run simulated **Dry Runs**.
2. **⚡ Live Migration Stream**: Watch real-time multi-threaded execution with live color-coded logs.
3. **📊 Audit Reports**: Search and inspect migrated items, verify identity mappings, and download Markdown/JSON certificates.
4. **📬 User Handover & Email**: Preview user-specific checklist reports, view exported `.pptx`/`.docx` attachments, and send handover emails via Gmail.
5. **🧹 Target Reset Utility**: Reset destination sandbox assets prior to fresh test runs.

---

### Step 4: (Optional) Run via CLI
You can also run headless batch migrations directly from the terminal or CI/CD pipelines:

```bash
# 1. Run Dry-Run Simulation
npx tsx src/cli.ts --config config.example.json --dry-run

# 2. Execute Live Migration for specific users
npx tsx src/cli.ts --config config.example.json --users "john.doe@company.com" "jane.doe@company.com"

# 3. Execute Organization-Wide Batch Migration with Concurrency 15
npx tsx src/cli.ts --config config.example.json --concurrency 15
```

---

## 🔒 Local Workstation Security & Isolation

This migration tool is designed to run **strictly on the administrator's local machine** or secure bastion terminal, rather than being hosted on public web services or cloud run containers.

* **🔒 Localhost Loopback Binding (`127.0.0.1`)**:
  * The web console listens strictly on loopback (`http://127.0.0.1:8080`), ensuring no inbound access is permitted from other network devices or the public internet.
* **🛡️ Direct Google Cloud REST Calling**:
  * All API calls (Discovery Engine, IAM, Gmail) originate directly from the administrator's authenticated workstation over TLS/HTTPS.
* **📁 Local Key & File Isolation**:
  * DWD Service Account keys (`sa-dwd-key.json`), exported research files, and audit reports stay entirely within the local directory on the administrator's disk.
* **🛡️ SSRF & Header-Only Token Protection**:
  * Strict URL allowlisting for Discovery Engine endpoints and header-only Bearer token injection to prevent credentials from appearing in URLs or browser history.

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
  "options": {
    "migrateNotebooks": true,
    "migrateAgents": true,
    "migrateSessions": true,
    "dryRun": false,
    "concurrency": 10,
    "userFilter": ["*@company.com"],
    "preserveOwnership": true
  },
  "datastoreMapping": {
    "source-policy-datastore": "target-policy-datastore"
  },
  "identityMapping": {
    "user:external-user@onmicrosoft.com": "user:internal-user@company.com"
  }
}
```

---

## 📬 User Handover & Email Notification Engine

Following a migration, each end-user receives an individual handover bundle:

1. **Checklist Email with Interactive Checkboxes**:
   * Lists each transferred Custom Agent with step-by-step instructions:
     * `☑ Step 1: Click into agent and press Publish to activate.`
     * `☑ Step 2: Click Share and re-add collaborators.`
   * Lists each Research Notebook with verification links.
   * Clarifies that past chat histories and citations are restored automatically.
2. **Native Office Document Attachments**:
   * Slide Decks &rarr; Attached as real **`.pptx` (Microsoft PowerPoint)** presentations.
   * Reports & Study Guides &rarr; Attached as real **`.docx` (Microsoft Word)** documents.
3. **Dispatch Options**:
   * **Google Gmail REST API**: Native OAuth2 dispatch using Domain-Wide Delegation.
   * **Corporate SMTP**: Direct integration with corporate relays (Office 365, Postfix, SendGrid).

---

## 🛡️ Architecture & InfoSec Compliance

Built specifically to satisfy enterprise security reviews, this tool implements the following controls:

* **Mitigation #1: SSRF Prevention** — Strict GCP region allowlisting (`global`, `us`, `eu`, `us-central1`, etc.) and regex validation on all project/engine IDs.
* **Mitigation #2: Server-Side Token Authentication** — Verifies Google OAuth Bearer tokens via `tokeninfo` and validates authorized corporate domains.
* **Mitigation #3: CORS Lockdown** — Restricted to authorized internal origin.
* **Mitigation #4: Header-Only Token Transport** — Tokens are passed strictly via HTTP `Authorization: Bearer` headers; zero tokens in JSON request bodies.
* **Mitigation #5: Hardened Container Runtime** — Runs as non-root (`UID 1000:1000`) with read-only root filesystems and explicit CPU/memory limits.
* **Mitigation #6: Zero Hardcoded Secrets** — All credentials resolved dynamically via Google Auth Library, DWD Service Account Keys, or GCP Secret Manager.

---

## 🧪 Testing

```bash
# Run unit & integration test suite
npm test

# Type-check TypeScript
npm run typecheck
```

---

## 📄 License
Copyright 2026 Google LLC. Licensed under the [Apache-2.0 License](LICENSE).
