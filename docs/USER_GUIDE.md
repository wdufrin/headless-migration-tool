# 📘 Gemini Enterprise Admin Migration Platform
## Administrator & Operator User Guide

**Document Version:** `v1.4.0 (Enterprise Release)`  
**Target Audience:** Cloud Architects, Migration Operators & IT Administrators  
**Supported Assets:** Research Notebooks, Grounding Sources, Custom Agents, Chat Sessions, Personalized Memories & Studio Artifacts  
**Handover Formats:** Interactive Checklists, Single-ZIP Archives, Office PPTX/DOCX, Offline HTML5 Apps  
**Primary DOCX Document:** [USER_GUIDE.docx](file:///usr/local/google/home/wdufrin/Documents/Code/headless%20migration%20tool/docs/USER_GUIDE.docx)

---

## 1. Overview & Key Capabilities

The **Gemini Enterprise Admin Migration Platform** empowers Google Cloud administrators to execute frictionless, zero-data-loss migrations of Gemini Enterprise and Google Cloud Discovery Engine assets between Google Cloud projects, geographic regions, and Identity Providers.

* **Research Notebooks & Granular Grounding Sources**: Deep-clones notebooks and re-indexes all grounding sources (PDFs, URLs, YouTube videos, Google Drive docs, and text files) with individual integrity auditing.
* **Custom Agents & Tool Attachments**: Migrates Low-Code and Workflow agents, preserving system prompts, descriptions, author tags, and grounding DataStore connections as native editable drafts.
* **User-Created Skills in Agent Registry**: Migrates custom skills from `agentregistry.googleapis.com` while intelligently ignoring built-in 1P Google templates.
* **Multi-Turn Chat History**: Rehydrates conversational histories turn-by-turn into each user's left-hand Gemini Enterprise History sidebar.
* **Personalized AI Memories & Facts**: Discovers and exports user preferences, role profiles, and learned memory facts.
* **Studio Artifacts Export (PPTX, DOCX, Video, Interactive Apps)**: Converts generated presentations into native widescreen PowerPoint (`.pptx`) decks, briefing docs into formatted Microsoft Word (`.docx`) files, explainer videos with automated `ffmpeg` compression, and quizzes/flashcards into 100% offline interactive HTML5 applications.
* **Automated User Handover Delivery Engine**: Dispatches personalized email notifications with interactive onboarding checklists (`/checklist`) and a consolidated `NotebookLM_Artifacts.zip` archive.

---

## 2. Pre-Migration Parity Audit & Gap Remediation

Before executing a migration run, administrators should execute a Configuration Pre-Check to ensure that the target environment has all required feature toggles, security settings, and DataStores configured to support the migrated assets.

> [!WARNING]
> **Why Configuration Parity Matters**: Migrating custom agents or notebooks that reference missing DataStores or disabled platform features (such as user memories or skill sharing) can cause silent runtime errors for end users. The Parity Audit catches these gaps beforehand.

Navigate to the **Config Pre-Check & Gaps** tab on the left navigation bar and click **Run Pre-Check**. The system analyzes more than 100 configuration points and computes a **Parity Readiness Score** (0–100%).

![Figure 2.1: Configuration Pre-Check & Gap Audit Screen](images/03_config_precheck_gaps.png)
*Figure 2.1: Configuration Pre-Check & Gap Audit Screen with Parity Readiness Score*

### Actionable Gap Remediation Plan
For any detected discrepancies, the console generates ready-to-run Google Cloud CLI commands. Administrators can copy these commands with a single click and execute them in Cloud Shell or a terminal.

![Figure 2.2: Actionable Gap Remediation Plan](images/04_gap_remediation_cli.png)
*Figure 2.2: Actionable Gap Remediation Plan with 1-Click Copyable CLI Commands*

---

## 3. Migration Pipeline Configuration

On the **Migration Studio** tab, specify the Source and Target environment parameters:

* **Source Project ID**: The GCP project hosting current Gemini Enterprise assets (e.g. `ancient-sandbox-322523`).
* **Source Region**: Geographic location (`global`, `eu`, `us-central1`).
* **Source Engine / App ID**: Dropdown auto-populated with discovered engines.
* **Source Identity Provider**: Select between `Google Workspace / Cloud Identity (DWD)` or `Microsoft Entra ID (Workforce Identity Federation)`.
* **Target Project ID & Region**: The destination environment (e.g. `ancient-sandbox-test-1`).
* **Target Identity Provider**: Destination authentication provider.

![Figure 2.3: Migration Pipeline Configuration](images/01_pipeline_configuration.png)
*Figure 2.3: Migration Pipeline Configuration in Web Console*

---

## 4. Scoping & Asset Selection

Administrators can selectively include or exclude specific asset categories to tailor the migration scope:

| Scope Checkbox | Asset Category | Default State | Operational Effect |
| :--- | :--- | :--- | :--- |
| **Migrate Notebooks & Sources** | Research Notebooks & Grounding Docs | Enabled (Checked) | Restores notebooks and re-indexes all attached PDFs, URLs, and YouTube videos |
| **Migrate Custom Agents** | Low-Code & Workflow Agents | Enabled (Checked) | Deep-copies agent instructions, tools, and datastores as native editable drafts |
| **Migrate Multi-User Chat History** | Chat Conversation History | Enabled (Checked) | Rehydrates chronological chat sessions into the target Gemini sidebar |
| **Migrate User Memories & Facts** | Personalized Facts & Profiles | Enabled (Checked) | Discovers and exports memory facts to local JSON backup and target library |
| **Export & Archive User Artifacts** | Studio Outputs & Presentations | Enabled (Checked) | Generates `.pptx` decks, `.docx` study guides, `.html` apps, and `.mp4` videos |
| **Dry Run (Simulate Only)** | Safety Simulation Mode | Disabled (Unchecked) | When checked, performs full discovery and logging without writing to target |

---

## 5. Targeted User Selection & Cross-IdP Transformation Rules

In enterprise migrations, you may want to migrate a pilot group of VIP users before rolling out to the entire organization. The platform provides granular user discovery and selection controls.

1. **Click Discover App Users**: The tool scans source DataStores and agents to discover all active user emails.
2. **Select Specific Users**: Check or uncheck individual users in the table.
3. **Configure Cross-IdP Domain Mapping**: When migrating between different IdPs (e.g. Microsoft Entra ID to Google Cloud Identity), configure the transformation rules.

> [!TIP]
> **Cross-IdP Domain Translation Rules**: When moving from Entra ID (`user@tenant.onmicrosoft.com`) to Google Cloud Identity (`user@company.com`), the tool automatically strips the source suffix and appends the target domain, completely preventing duplicate domain concatenation bugs.

![Figure 2.4: Targeted User Discovery and Cross-IdP Transformation Matrix](images/02_user_discovery_and_cross_idp.png)
*Figure 2.4: Targeted User Discovery and Cross-IdP Transformation Matrix*

---

## 6. Executing the Migration Pipeline

Once configured, click **🚀 Run Live Migration** (or **Simulate Dry Run**). The migration pipeline executes across 7 discrete stages:

1. **Stage 1: Pre-Flight Infrastructure Checks** — Verifies target engine existence, accessibility, and service usage quotas.
2. **Stage 2: Notebooks & Granular Sources Restoration** — Syncs research notebooks and restores individual grounding documents.
3. **Stage 3: User Skills Discovery & Restoration** — Migrates custom skills in `agentregistry.googleapis.com`.
4. **Stage 4: Custom Agents Restoration** — Creates target agents as editable drafts with preserved system instructions.
5. **Stage 5: Multi-Turn Chat Conversation Rehydration** — Recreates conversational turns chronologically for each user.
6. **Stage 6: Personalized AI Memories & Facts Export** — Backs up and migrates discovered user facts.
7. **Stage 7: Studio Artifacts Discovery, Office Generation & Compression** — Synthesizes PPTX presentations, Word study guides, interactive HTML5 quiz/flashcard apps, and compresses Explainer Videos.

---

## 7. Migration Reports & Reconciliation Auditing

Upon pipeline completion, the platform generates comprehensive executive and machine-readable audit reports saved in `reports/`:
* **Markdown Report** (`reports/migration-report-<ID>-<TIMESTAMP>.md`): Human-readable executive summary with detailed asset breakdown.
* **JSON Report** (`reports/migration-report-<ID>-<TIMESTAMP>.json`): Full telemetry schema for SIEM or enterprise database logging.
* **User Reconciliation Matrix**: Comprehensive table matching each source user identity with their target Google identity, listing restored vs. failed counts across all asset categories.

![Figure 2.9: Migration Report and User Reconciliation Matrix](images/05_migration_report_reconciliation.png)
*Figure 2.9: Migration Report and User Reconciliation Matrix in Web Console*

---

## 8. User Handover Delivery & Notification Engine

To deliver a seamless day-one onboarding experience, the platform packages each user's assets into a single consolidated `NotebookLM_Artifacts.zip` archive and dispatches an onboarding email.

* **Action-Oriented Checklists**: The email features interactive checkboxes `[ ]` guiding users through initial sign-in, connector authorizations (Outlook, OneDrive, Google Drive, Jira), and agent publishing.
* **Smart Deduplication**: Static HTML document viewers are excluded when authentic Word documents are attached, but interactive quiz and flashcard apps are explicitly preserved alongside Word study guides.
* **Multi-Part Email Threading**: If user assets exceed Gmail's 14.5 MB unencoded per-message threshold, attachments are automatically bin-packed into sequential parts and delivered within a single threaded conversation (`In-Reply-To`).

![Figure 2.10: Migration Handover Notification Received in Gmail](images/09_gmail_user_handover_delivery.png)
*Figure 2.10: Migration Handover Notification Received in Gmail with Attachments*

![Figure 2.11: Multi-Part Handover Thread with Partitioned Attachments](images/10_gmail_multipart_thread.png)
*Figure 2.11: Multi-Part Handover Thread with Partitioned Attachments in Gmail*

![Figure 2.12: Handover Follow-Up Message with High-Resolution Deck](images/11_gmail_handover_followup_deck.png)
*Figure 2.12: Handover Follow-Up Message with High-Resolution Deck*

![Figure 2.13: User Handover & Email Delivery Console Tab](images/14_user_handover_console.png)
*Figure 2.13: User Handover & Email Delivery Console Tab*

---

## 9. Auth & Identity Provider Configuration Wizard (DWD & WiF)

The **Auth & WiF Wizard** provides an interactive, guided interface to configure and test authentication protocols across Google Workspace and external Identity Providers (Microsoft Entra ID, Okta, Ping).

### 9.1 Domain-Wide Delegation (DWD) & Org Policy Inspection
When configuring Google Workspace Domain-Wide Delegation in Step 1:
* **`🛡️ Check Org Policies`**: Performs live inspection of target project organization policies (`iam.disableServiceAccountKeyCreation`, `iam.disableCrossProjectServiceAccountUsage`, and `iam.allowedPolicyMemberDomains`).
* **Conflict Detection**: If `iam.disableServiceAccountKeyCreation` is active, an alert banner warns the operator before executing CLI commands that creating `sa-dwd-key.json` will fail.
* **⚡ 1-Click Project Override**: Operators holding `roles/orgpolicy.policyAdmin` can click the 1-Click Project Override button to automatically apply a project-scoped exemption (`enforce: false`) without modifying parent organizational policies.
* **Live DWD Impersonation Test**: Validates that minted user-scoped OAuth2 tokens function against Discovery Engine APIs.

### 9.2 Workforce Identity Federation (WiF) — Keyless Enterprise Path
For organizations operating under strict Zero-Trust or keyless security baselines:
* **Keyless Architecture**: WiF exchanges external OIDC/SAML tokens with Google Cloud Security Token Service (`sts.googleapis.com`) to mint short-lived tokens and is **100% exempt from `iam.disableServiceAccountKeyCreation`** and key upload policies.
* **Domain Sharing Validation**: Verifies that `iam.allowedPolicyMemberDomains` permits workforce pool principals (`is:principalSet://iam.googleapis.com/organizations/<org-id>`).
* **Live GCP Verification**: The `🔍 Verify Live in GCP` button tests workforce pools and OIDC providers directly in Google Cloud.

### 9.3 Permissions & Least-Privilege Auditor
The Auditor evaluates target environments against Google SAIF and least-privilege standards:
* Evaluates Discovery Engine read/write scopes, NotebookLM source access, and Gmail API dispatch scopes.
* Flags over-provisioned permissions or destructive deletion privileges.
* Runs automated organization policy compliance audits on the target project.
* Offers 1-click IAM policy bindings auto-fixes for missing roles.

---

## 10. Target Maintenance & Selective Rollback

During testing or staged rollouts, administrators can use the **Target Maintenance** tab to selectively clean migrated assets in the target environment prior to fresh migration runs.

| Maintenance Option | Scope of Action | Risk Level | Recommendation |
| :--- | :--- | :--- | :--- |
| **Clean Target Chats** | Deletes migrated chat sessions for selected users | Low | Safe to run between test iterations to avoid duplicate session history |
| **Clean Target Agents** | Removes custom agents created by migration pipeline | Medium | Use when iterating on system prompt translations or tool bindings |
| **Clean Target Notebooks** | Deletes migrated research notebooks in target | Medium | Use when re-testing source ingestion or PDF uploads |
| **Clean Exported Artifacts** | Clears `exports/artifacts/` folder on local disk | Low | Frees local disk space without modifying cloud environments |
| **Clean Migration Reports** | Clears `reports/` folder on local disk | Low | Archives old run logs |

![Figure 2.14: Target Maintenance Console](images/15_target_maintenance.png)
*Figure 2.14: Target Maintenance Console & Selective Rollback Controls*

---

## 11. Enterprise Migration Playbook & Best Practices

Follow this recommended four-phase migration playbook for enterprise rollouts:

### Phase 1: Pre-Flight Discovery & Parity Alignment
1. Open the **Auth & WiF Wizard** and run **`🛡️ Check Org Policies`** to verify that target project policies (`iam.disableServiceAccountKeyCreation`, `iam.disableCrossProjectServiceAccountUsage`) permit credential provisioning or apply 1-click project overrides.
2. Run Configuration Pre-Check & Gap Audit against Source and Target engines.
3. Execute generated CLI commands to align DataStores and feature flags.
4. Confirm that caller identity has `roles/serviceusage.serviceUsageConsumer` on both projects.

### Phase 2: Pilot Wave Execution (5–10 VIP Users)
1. Select 5–10 active power users with notebooks and agents.
2. Run a Dry Run simulation to verify identity mapping and asset discovery.
3. Execute Live Migration and review the resulting Markdown audit report.
4. Dispatch pilot handover emails and verify user receipt in Gmail.

### Phase 3: Production Bulk Migration Wave
1. Execute migration for remaining organizational users.
2. Monitor streaming event logs for any network throttling or quota pauses.
3. Verify that 100% of discovered notebooks, sources, and agents migrated successfully.

### Phase 4: Post-Migration Handover & Support
1. Dispatch bulk handover email packages with `NotebookLM_Artifacts.zip`.
2. Direct users to `/checklist` for guided day-one onboarding steps.
3. Archive final migration reports for compliance records.

