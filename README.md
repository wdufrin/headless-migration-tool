# 🚀 Gemini Enterprise Admin Migration Platform (`gemini-migrate`)

[![Version](https://img.shields.io/badge/version-1.8.3-blue.svg)](package.json)
[![Installation Guide](https://img.shields.io/badge/install%20guide-DOCX%20%7C%20MD-blue.svg)](docs/INSTALLATION_GUIDE.md)
[![User Guide](https://img.shields.io/badge/user%20guide-DOCX%20%7C%20MD-green.svg)](docs/USER_GUIDE.md)
[![Release Notes](https://img.shields.io/badge/release%20notes-v1.8.3-orange.svg)](RELEASE_NOTES.md)
[![Changelog](https://img.shields.io/badge/changelog-Keep%20a%20Changelog-blue.svg)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE)

An admin-driven CLI and local web console for migrating **supported** **Gemini Enterprise (Google Cloud Discovery Engine)** assets across Google Cloud projects and Identity Providers — within the strict boundaries of Google's public REST APIs.

> [!WARNING]
> **Read Before Planning a Customer Migration — Every Asset Type Has API Caveats**  
> Google Cloud Discovery Engine does **not** expose a native cross-project snapshot, database export, or lossless clone API. Because this tool operates strictly through external public REST endpoints, **none of these migrations are a 1:1 raw clone** — chat histories are **not** restored as native back-and-forth User/Gemini bubbles, locally uploaded NotebookLM files (`.pdf`, `.docx`, `.txt`, audio) **cannot** be extracted on customer projects, **admins must identify replacement DataStores/Connectors on the target Gemini Enterprise (GE) app instance**, and **end users must authorize their connectors inside the target GE app before migrated agents can use them**. Review the exact caveats below before setting expectations with stakeholders or end users.

> [!TIP]
> **📖 Operator & Setup Guides**:
> * **[Installation & Pre-Requisites Guide (DOCX)](INSTALLATION_GUIDE.docx)** &bull; *[Markdown Version](docs/INSTALLATION_GUIDE.md)*: Google Cloud APIs, IAM role matrices, Organization Policy pre-flight checks, DWD/WiF credentials provisioning, and local build walkthroughs.
> * **[Administrator & User Guide (DOCX)](USER_GUIDE.docx)** &bull; *[Markdown Version](docs/USER_GUIDE.md)*: End-to-end web console operations, Auth Wizard & Org Policy overrides, dynamic `_#####` Connector Auto-Mapping & HITL validation, parity gap remediation, cross-IdP domain translation, and user handover delivery.
> * **[JSON Setup & Auth Architecture Guide](docs/JSON_SETUP_AND_CONFIGURATION_GUIDE.md)**: Detailed technical reference covering `sa-dwd-key.json`, `workforce-identity-config.json`, `migration-config.json`, `collectionMapping`, `datastoreMapping`, cross-project IAM topologies, and token resolution order.

---

## ⚠️ Honest Migration Capabilities, Caveats & Hard Limitations

### 1. 💬 Chat History (`Sessions` & `Turns`)
* **What we CAN migrate**: The text of historical user prompts and Gemini responses, reasoning thoughts, code blocks/outputs, static citation links, `@`-mention chips, pinned status (`isPinned`), session title (`displayName`), and binary session file attachments (`:listFiles` &rarr; `:addContextFile` / `:uploadFile`).
* **Caveats & What we CANNOT do**:
  * **NO turn-by-turn User / Gemini bubbles**: Google's public `session.proto` marks `Turn.assist_answer` and `Turn.detailed_assist_answer` as `OUTPUT_ONLY`, rejects cross-engine answer IDs, and provides no API to inject historical model replies. We **cannot** recreate native alternating prompt/response bubbles.
  * **Standard Archive Mode *(Default — `continuableSessions: false`)* CANNOT continue conversations**: Each past Q&A pair is written inside a User prompt bubble for visual reference only. Because there is no backend `AssistAnswer` record in Spanner, Gemini ignores those turns completely if a user asks a follow-up question.
  * **Continuable Mode *(Opt-In — `--continuable-sessions` / `🔄 Enable Continuable Chats`)* collapses the entire chat into ONE single input prompt**: To make a migrated chat continuable, the tool concatenates the **entire multi-turn historical conversation into a single User input prompt** and sends 1 live `:streamAssist` request (`toolsSpec: {}`) so Gemini replies with a 1-line confirmation (`"✅ Restored conversation context..."`). Users can then ask follow-up questions with full context, **but the historical chat will appear inside one consolidated prompt block rather than separate turns**.
  * **Quota, length & Model Armor caveats on Continuable Mode**: Consumes 1 live Gemini generation per migrated session; transcripts over `200,000` characters are truncated inline (with the full text attached as `migrated_conversation_transcript.md`); and if target Model Armor / safety filters block the historical text (`SKIPPED`), the session falls back to read-only Archive Mode.
  * **Timestamps reset**: `Turn.create_time` is `OUTPUT_ONLY` — all migrated chats receive the migration timestamp, not their original creation dates.

### 2. 📔 Research Notebooks (`NotebookLM Enterprise`)
* **What we CAN migrate**: Notebook containers (`title`, `emoji`), notebook sharing ACLs (`:share`), and **external reference links only** — specifically **Google Drive links**, **public Web URLs**, **YouTube URLs**, and **Agentspace DataStore document references** (rewritten via `datastoreMapping` / `collectionMapping`).
* **Caveats & What we CANNOT do**:
  * **Locally uploaded files (`.pdf`, `.docx`, `.pptx`, `.txt`, audio) and pasted text CANNOT be migrated on customer projects**: Google's external API gateway strips `tailwindDoc` (`NOTEBOOKLM_SOURCE_CONTENT` visibility) on `NotebookService.GetSource` and provides no raw file download endpoint. **Users will receive notebooks missing all uploaded/pasted sources** and must manually re-upload those files (tracked as `MANUAL_REUPLOAD_REQUIRED` in reports and handover checklists).
  * **Google Drive sources still depend on Drive ACLs**: Drive sources are re-linked by `documentId`. If migrating across isolated Google Workspace domains or to Microsoft Entra ID where the target user identity cannot read the original Google Drive file, the link will fail access checks.
  * **In-App Notes, Notebook Chat History & Studio Outputs (Audio/Video Overviews, Mind Maps, Slide Decks, Study Guides, Quizzes, Flashcards) do NOT migrate into the target NotebookLM UI**:
    * On standard external customer projects, `NoteService` (`/notes`) and `ArtifactService` (`/artifacts`) are unexposed and return **`404 Method not found`** — neither notes nor Studio artifacts can be read or recreated inside NotebookLM.
    * Even on internal/allowlisted projects where `ArtifactService` is readable on the source, there is **no API to upload Studio artifacts back into NotebookLM** — they can only be exported one-way as offline files (`.pptx`, `.docx`, `.html`, `.mp3`, `.mp4`) in the user's handover ZIP.
  * **New Notebook IDs & URLs**: Target notebooks get newly generated resource IDs; old links/bookmarks will not redirect.

### 3. 🤖 Custom Agents (`Low-Code / No-Code`, `Workflow`, `Managed`, `ADK`, `A2A`)
* **What we CAN migrate**: Agent definitions, system instructions, starter prompts, schemas, Low-Code local knowledge files, source lifecycle state (`Draft` stays `Draft`; `Published` is deployed via `:deployLowCode`, `:publish`, `:deploy`, or `:enableAgent`), sharing scopes (`PRIVATE`, `ALL_USERS`, `RESTRICTED`), per-agent IAM policies, and rewritten `datastoreMapping` / `collectionMapping` resource paths.
* **Required Admin & End-User Actions + What we CANNOT do**:
  * **🧑‍💼 Admin Action Required — Provision & Identify Replacement DataStores/Connectors on the Target GE App**: This tool does **not** migrate, create, or index DataStores or SaaS Connectors. Admins must first attach the replacement Vertex AI Search DataStores and Connectors to the **target Gemini Enterprise (GE) app instance**, then **identify and confirm which target DataStore/Connector replaces each source DataStore/Connector** (via the **Step 2 HITL Mapping Table** or `datastoreMapping` / `collectionMapping` in config). While the tool auto-suggests matches for standard `<connector>_<timestamp>` IDs, custom DataStores with new names require explicit admin selection — and any source DataStore/Connector with no replacement on the target GE app must be stripped (`__STRIP__`) or agent creation/publishing will fail.
  * **👤 End-User Action Required — Users Must Authorize Connectors in the Target GE App Before Agents Can Use Them**: Per-user OAuth tokens for workplace connectors (Google Drive/Workspace, Microsoft 365, Jira, Confluence, GitHub, ServiceNow, Slack, etc.) are encrypted per-engine and **cannot** be copied across GE instances. Even after an agent or workflow is migrated and published, **each user must log into the target Gemini Enterprise app and authorize their connectors in the UI before their agents will be able to query or act through those connectors**.
  * **ADK & A2A backend services are NOT migrated**: For `ADK` and `A2A` agents, only the Gemini Enterprise catalog entry is recreated. The underlying Vertex AI Reasoning Engine or Cloud Run service is not redeployed, and admins must grant IAM / VPC Service Controls access so the target GE app's service agent can invoke that backend.
  * **Agent URLs & Workflow run history reset**: Agents get new resource IDs in the target GE app, and historical workflow execution logs are not carried over.
  * **Strict daily creation quotas**: Discovery Engine enforces `AgentCreateRequestsPerDayPerUser` ceilings (resetting at `00:00 PST`), which can throttle large single-day migrations unless a quota increase is approved beforehand.

### 4. 🧠 User Personalized Memories (`Experimental` — Often Unavailable)
* **What we CAN migrate**: User personalization consent and memory facts via `EngineUserData` *(only when enabled and exposed on both engines)*, plus local JSON backups (`./exports/memories`).
* **Caveats & What we CANNOT do**: Frequently returns `404` or `403` on external customer projects where the `EngineUserData` memory API is not enabled/exposed, or where the backend requires an interactive 3P browser OAuth session rather than service-account impersonation. Treat as best-effort/experimental.

### 5. 🛠️ User-Created Skills (`Experimental` — Preview Only)
* **What we CAN migrate**: Custom user skill metadata in Cloud Agent Registry (`agentregistry.googleapis.com`) and Discovery Engine Skill Agents (excluding Google 1P system templates).
* **Caveats & What we CANNOT do**: `agentregistry.googleapis.com` (`v1alpha`) requires preview allowlisting (`403`/`404` otherwise), and **only metadata is copied** — remote MCP servers, credentials, secrets, and network bindings are not migrated.

### 6. 📁 Gemini Enterprise Projects & Platform Infrastructure (`NOT Supported`)
* **Gemini Enterprise Projects (`WIP`)**: Project workspaces **cannot** be migrated.
* **Platform & Infrastructure**: This tool does **not** provision Gemini Enterprise Engines/Apps, Vertex AI Search DataStore corpora, Workforce Identity Pools, Cloud Identity users/groups, KMS/CMEK keys, Model Armor templates, or Vanity URLs. (Step 2 only audits feature-flag differences and patches basic engine toggles.)
* **End-User Impersonation Requirement**: Reading and restoring private user chats, notebooks, and private agents requires high-privilege delegation — either **Google Workspace Domain-Wide Delegation (DWD)** (Super Admin setup) or **Workforce Identity Federation (WiF) STS token minting**. Without user impersonation, private per-user assets cannot be accessed or assigned to end users.

### Summary Matrix

| Asset / Scope | Migrates? | Reality & Major Caveats |
| :--- | :---: | :--- |
| **🤖 Custom Agents** | **🟡 Yes, with admin + user steps** | Agent configs, prompts, local Low-Code files, `Draft`/`Published` state, and sharing migrate — **but admins must identify replacement DataStores/Connectors on the target GE app instance**, **users must authorize their connectors in the target GE app before agents can use them**, and ADK/Cloud Run backends are not redeployed. |
| **💬 Chat History** | **🟡 Partial / Caveated** | **Never turn-by-turn bubbles** (`Turn.assist_answer` is `OUTPUT_ONLY`). **Archive mode** (default) is static text and **cannot** be continued. **Continuable mode** (`--continuable-sessions`) shoves the **entire past chat into 1 single input prompt** to seed live follow-up context. |
| **📔 Notebooks (Container & Links)** | **🟡 Partial / Caveated** | Notebook shells, sharing ACLs, and external links (Drive, Web, YouTube, DataStore refs) migrate, **but** Drive links still require target user Drive ACLs and notebook URLs change. |
| **📄 Notebook Uploaded Files & Pasted Text** | **❌ No** | Locally uploaded `.pdf`, `.docx`, `.pptx`, `.txt`, audio, and pasted text **cannot** be read on customer projects (`NOTEBOOKLM_SOURCE_CONTENT` restriction). Flagged as `MANUAL_REUPLOAD_REQUIRED`. |
| **🎨 Notebook Notes & Studio Artifacts** | **❌ No (In-App)** | `/notes` and `/artifacts` return `404` on standard customer projects. Even on allowlisted projects where source exports work (`.pptx`/`.docx`/`.html`/`.mp4`), artifacts **cannot** be re-uploaded into NotebookLM Studio. |
| **🧠 User Memories** | **🧪 Experimental** | Works only on engines exposing `EngineUserData` to impersonated tokens; often `404`/`403` on customer projects. |
| **🛠️ User-Created Skills** | **🧪 Experimental** | Requires `agentregistry.googleapis.com` preview access; copies registration metadata only (not remote MCP servers or secrets). |
| **📁 Gemini Enterprise Projects** | **❌ No (`WIP`)** | Not implemented. |
| **🏗️ Engines, DataStores, Connectors & OAuth** | **❌ No** | Target GE App, replacement DataStores/Connectors, and per-user in-app connector OAuth authorizations are **not** migrated. |

---

## 📋 Table of Contents

- [Honest Migration Capabilities, Caveats & Hard Limitations](#️-honest-migration-capabilities-caveats--hard-limitations)
- [What's New in v1.8.3](#-whats-new-in-v183)
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

## 🚀 What's New in v1.8.3

* **💬 Opt-In Continuable Chat Migration (`--continuable-sessions` / `🔄 Enable Continuable Chats`) (`src/engines/sessionMigrator.ts`, `public/index.html`, `src/cli.ts`)**:
  * Because Discovery Engine's `CreatePlannerStepsFromSessionTurns` ignores prior `Session.Turn` entries without a Spanner `AssistAnswer` row (and `Turn.assist_answer` is `OUTPUT_ONLY`), standard archive chat migrations are static and cannot be continued.
  * When **Enable Continuable Chats (`:streamAssist` Context Handshake)** is enabled, `SessionMigrator` creates the target session container (`turns: []`), uploads binary session files, and consolidates the verbatim historical Q&A transcript into **1 single input prompt via `AssistantService.StreamAssist` (`toolsSpec: {}`)**, followed by `PATCH ?updateMask=displayName[,isPinned]` to preserve the original title (falling back to read-only archive turns if `:streamAssist` is skipped or rate-limited).
* **👥 Multi-User Web-UI Chat Discovery & Non-Human Principal Filtering (`src/engines/sessionMigrator.ts`, `src/engines/memoryMigrator.ts`, `src/utils/impersonationFailure.ts`)**:
  * Omits `filter=user_pseudo_id` on EUC-impersonated (`DWD` / `WiF`) `ListSessions` calls so native Web-UI chats (whose `userPseudoId` is a numeric `session_id`) are discovered cleanly, and filters out `group:`, `domain:`, and `serviceAccount:` entries before DWD JWT minting.
* **🔑 Keyless DWD Admin Token Resolution & Same-Project Engine-Isolated Cleanup (`src/services/gcpAuth.ts`, `src/services/discoveryEngine.ts`, `src/routes/maintenance.ts`)**:
  * Uses the active caller's ADC/gcloud token first for Admin API calls in Keyless DWD mode (with 1-shot `401`/`403` fallback to IAM `generateAccessToken`), and allows **Target Maintenance** (`POST /api/cleanup`) to clean engine-scoped assets (**Chats**, **Agents**, **Memories**) when `targetProject === sourceProject` and `targetEngine !== sourceEngine`.
* **📋 Up-Front Honest Capabilities & Limitations Documentation (`README.md`)**:
  * Documented exact public API boundaries, caveats, and non-migrated items at the top of `README.md`.
* **🧪 100% Passing Automated Tests (425/425 Tests across 33 suites)**.

<details>
<summary><strong>📜 Previous Release Highlights (v1.4.1 – v1.8.2)</strong> — click to expand</summary>

### What's New in v1.8.2
* **Honest NotebookLM Source Handling & Per-Project 404 Caching**: Re-links external reference sources (Google Drive, Web URLs, YouTube, Agentspace DataStore docs), flags uploaded/pasted sources as `MANUAL_REUPLOAD_REQUIRED` without dead fallback RPCs, and caches per-project `404` responses for `/notes` and `/artifacts` (395 passing tests).

### What's New in v1.8.1
* **DataStore-Grounded NotebookLM Source Mapping & JSON Backup**: Rewrites `agentspaceMetadata.documentName` across projects via `datastoreMapping` / `collectionMapping` and saves `<Notebook>_sources_backup.json` in handover bundles (389 passing tests).

### What's New in v1.8.0
* **Source-Faithful Agent Deployment & Draft Preservation**: Preserves source `Draft` vs `Published` state and dispatches `:deployLowCode`, `:publish`, `:deploy`, or `:enableAgent` plus `:requestAgentReview` before `:setIamPolicy` (383 passing tests).

### What's New in v1.7.0
* **Worker Concurrency Control, Ignore Draft Agents & Honest Source Reporting**: Added `#optConcurrency`, `--exclude-draft-agents`, and removed fake `[Restored Source: ...]` placeholders (375 passing tests).

### Earlier Releases (`v1.4.1` – `v1.6.3`)
* See [`CHANGELOG.md`](CHANGELOG.md) and [`RELEASE_NOTES.md`](RELEASE_NOTES.md) for the complete version-by-version history (`v1.0.0` – `v1.8.3`).

</details>

---

## 🌟 Key Features

* **🤖 Custom Agent Configuration & Sharing Migration**: Recreates Low-Code, Workflow, Managed, ADK, and A2A agent definitions with system prompts, schemas, local Low-Code files, rewritten `datastoreMapping`/`collectionMapping` bindings, source `Draft` vs `Published` lifecycle parity, and `PRIVATE` / `ALL_USERS` / `RESTRICTED` sharing *(admins must identify replacement DataStores/Connectors on the target GE app instance, and users must authorize their connectors in the target GE app before their agents can use them)*.
* **🔍 Configuration Pre-Check, Gap Audit & Connector HITL Mapping**: Compares source vs. target engine feature flags, auto-matches `<connector>_<timestamp>` Collections and child entity DataStores (`_issue`, `_pull_request`, `_repository`) via Regex Pattern Matching to prevent 1-to-3 source multiplication, and provides interactive HITL dropdowns or `__STRIP__` pruning.
* **📔 Research Notebook Shells & External Link Migration**: Recreates user notebooks, sharing ACLs, and external reference sources (Google Drive links, Web URLs, YouTube videos, Agentspace DataStore references), while auditing every source individually and flagging non-migratable local uploads/pasted text as `MANUAL_REUPLOAD_REQUIRED`.
* **📦 Offline Studio Artifact Exports *(Allowlisted Source Projects Only)***: On projects where `ArtifactService` is exposed, exports slide decks to `.pptx`, study guides/briefings to `.docx`, Quizzes/Flashcards to offline HTML5 apps, and Explainer Videos to `ffmpeg`-compressed `.mp4` files for email handover *(not available on customer projects where `/artifacts` returns `404`, and cannot be re-imported into NotebookLM Studio)*.
* **💬 Chat History Migration (Read-Only Archive or Single-Prompt Continuable Seed)**: Restores historical prompt/response text and session file attachments either as read-only archive turns or — via opt-in `--continuable-sessions` — as a single consolidated `:streamAssist` context prompt so users can continue the conversation *(never native multi-turn bubbles due to `OUTPUT_ONLY` API constraints)*.
* **🛠️ Experimental Skills & Personalized Memories**: Best-effort migration of custom skills (`agentregistry.googleapis.com`) and user memories (`EngineUserData`) on enrolled/supported engines.
* **👤 Multi-Tenant Identity Resolution (DWD & WiF)**: Supports Google Workspace Domain-Wide Delegation (JSON key or Keyless IAM `signJwt`), Workforce Identity Federation STS assertions (Entra ID, Okta, Ping), domain transformation rules, and 2-column CSV user ID mapping (`first.last@XXXX.com ➔ #####@YYYY.com`).
* **🛡️ Permissions Auditor, Selective Maintenance & User Handover**: Includes live IAM least-privilege & Org Policy checks, selective target engine cleanup, and personalized user onboarding checklists (`/checklist`) with optional Gmail/SMTP delivery.

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
| `--continuable-sessions` | Seed a live `:streamAssist` context handshake turn (`toolsSpec: {}`) with the verbatim historical Q&A so follow-up questions in migrated chats remember prior context | `false` (Standard archive) |
| `--no-session-files` | Skip migrating context attachments and AI-generated files attached to chat sessions | Migrates session files |
| `--no-agent-files` | Skip migrating local knowledge files attached to No-Code / Low-Code agents | Migrates agent files |
| `--no-memories` | Skip user personalized memories and facts migration *(Experimental — may not work for everyone)* | Migrates memories *(Experimental)* |
| `--no-skills` | Skip Agent Registry custom skills migration *(Experimental — may not work for everyone)* | Migrates skills *(Experimental)* |
| `--export-memories` | Export backup snapshot of user memories to disk (`./exports/memories`) *(Experimental)* | `true` |
| `--agent-types <types...>` | Filter agent types (`LOW_CODE`, `WORKFLOW`, `ADK`, `A2A`, `ALL`) | `ALL` |
| `--exclude-draft-agents` | Ignore unsaved draft agents (`"My Agent"`, `"My Workflow"`, etc.) and migrate only Private (created/deployed) and Published/Shared agents | `false` |
| `--publish-agents` | Automatically publish migrated agents for immediate organization visibility | `true` |
| `--export-artifacts` | Extract presentations, Canva-style docs, and HTML artifacts to `./exports` | `true` |
| `--no-preserve-sharing` | Do not replicate sharing configurations (`ALL_USERS` / `RESTRICTED`) | Preserves sharing |
| `--prompt-admin-hitl` | Pause migration for Human-in-the-Loop confirmation when shared Admin notebooks are detected | `false` |
| `--no-connector-hitl` | Disable Human-in-the-Loop validation prompts when unmapped agent connectors/datastores are detected | Prompts enabled (`true`) |
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
   - **Dynamic Connector & DataStore Auto-Mapping + HITL Validation Table (`#connectorMappingSection`)**: Automatically matches `<connector>_<timestamp>` Collections and `<connector>_<timestamp>_<entity>` child DataStores (`_issue`, `_pull_request`, `_repository`) across projects using Regex Pattern Matching (`_#####` instance matching) to prevent 1-to-3 agent source multiplication. Includes live target dropdowns, custom ID inputs, and `🗑️ Strip / Remove Connector` (`__STRIP__`).
   - Attached DataStore Parity audit with automated remediation and copy-ready CLI snippets.
   - Prominent `Next: Proceed to Step 3: Migration Studio ➔` wizard transition that automatically syncs confirmed connector and datastore mappings into Step 3.
3. **Step 3: 🚀 Migration Studio (`#studio`)**:
   - Synchronized Source and Target GCP environment pickers and asset scope selectors (Notebooks, Custom Agents, User Skills `[Experimental]`, Chat Sessions, Memories `[Experimental]`, Studio Artifacts, and Projects `[WIP]`).
   - **Continuable Chats (`#optContinuableSessions`)**: Sub-option under Chat History Sessions (`🔄 Enable Continuable Chats (:streamAssist Context Handshake)`) to seed a live `AssistAnswer` turn with the verbatim historical Q&A so follow-up questions remember the migrated conversation.
   - **Ignore Draft Agents (`#optExcludeDraftAgents`)**: Sub-option under Custom Agents to skip unsaved UI draft placeholders (`"My Agent"`, `"My Workflow"`, etc.) and migrate only **Private (created/deployed)** and **Published/Shared** agents.
   - **Worker Concurrency Control (`#optConcurrency`)**: Configurable parallel worker threads (`1`–`50`, default `3`, recommended `3`–`5` for large PDF/PPTX notebooks) paired with adaptive source read concurrency (`min(concurrency, 3)`) to prevent HTTP 504 `DEADLINE_EXCEEDED` timeouts.
   - Dynamic asset discovery with user selection table and CSV identity mapping (`first.last@XXXX.com ➔ #####@YYYY.com`).
   - Context-aware Cross-IdP transformation matrix with preset domain rules and synchronized `collectionMapping` / `datastoreMapping` controls.
   - Interactive **Runtime HITL Modals**:
     - **Connector & DataStore Mapping Review (`#connectorHitlModal`)**: Pauses agent migration if an agent references an unmapped connector or DataStore, allowing the operator to map it to a target resource or strip (`__STRIP__`) it before creation.
     - **Shared Admin Notebook Review (`#adminHitlModal`)**: Optional HITL prompt (`promptForAdminNotebookHitl`) allowing administrators to review and uncheck colleague-owned shared notebooks detected via project-level Admin permissions.
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
   - **Button 1: Reset Target Project Assets**: Purges migrated target project assets (notebooks, custom agents, chat history, user memories, reports, artifacts) for test iteration resets. Supports same-project engine-isolated cleanup for Chat History, Custom Agents, and User Memories when `targetEngine !== sourceEngine`.
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
    "continuableSessions": false,
    "migrateSessionFiles": true,
    "migrateAgentFiles": true,
    "migrateMemories": true,
    "migrateSkills": true,
    "exportMemories": true,
    "exportArtifacts": true,
    "excludeDraftAgents": false,
    "dryRun": false,
    "concurrency": 3,
    "userFilter": ["*@company.com"],
    "preserveOwnership": true,
    "promptForAdminNotebookHitl": false,
    "promptForConnectorHitl": true
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
  },
  "collectionMapping": {
    "github_1773757636775": "github_1780931139999"
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

The platform includes an extensive automated test suite with **425 automated tests across 33 test suites** covering authentication (Keyless DWD, JSON DWD, WiF), cross-project parity audits, dynamic `_#####` connector & child entity DataStore Regex Pattern Matching, HITL connector validation, draft vs private/published agent filtering (`excludeDraftAgents`), honest notebook source failure reporting & adaptive read concurrency, Agent Registry skills discovery/filtering, memory migration, chat session rehydration & opt-in `:streamAssist` continuable context handshakes, same-project engine-isolated maintenance cleanup, reporters, NotebookLM artifact formatting, bulk email dispatching, security guardrails, and E2E execution flows:

```bash
# Run complete unit and integration test suite (425 tests across 33 suites)
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

