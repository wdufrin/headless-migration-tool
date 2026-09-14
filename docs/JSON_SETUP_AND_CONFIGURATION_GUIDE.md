# Gemini Enterprise Migration Tool: JSON Configuration & Credentials Architecture

This guide explains how configuration and credential JSON files are discovered, structured, loaded, and updated in the **Gemini Enterprise Headless Migration Tool**.

---

## 1. Overview of JSON Files

| File Name | Purpose | Required When | Default Location |
| :--- | :--- | :--- | :--- |
| **`sa-dwd-key.json`** | Service Account private key for Admin actions & Google Workspace Domain-Wide Delegation (DWD) | Migrating Google Workspace users or running headless admin API operations | Root directory: `./sa-dwd-key.json` |
| **`workforce-identity-config.json`** | GCP STS client config for Workforce Identity Federation (WiF) | Migrating non-Google external identities (Okta, Microsoft Entra ID) | Root directory: `./workforce-identity-config.json` |
| **`migration-config.json`** | Source/Target project topology, engine IDs, datastore mappings, options | Running automated migrations via CLI or preset batch jobs | Root directory: `./migration-config.json` |
| **`wif-migration-jwks.json`** | Local public JWKS keyset for validating local OIDC tokens in GCP STS | Local test harness or automated workforce token minting | Root directory: `./wif-migration-jwks.json` |

---

## 2. File 1: `sa-dwd-key.json` (Service Account Key)

### How It Is Loaded
The authentication service ([gcpAuth.ts](file:///usr/local/google/home/wdufrin/Documents/Code/headless%20migration%20tool/src/services/gcpAuth.ts)) resolves service account credentials in this order of precedence:
1. `options.serviceAccountKeyJson`: Inline JSON passed in API parameters.
2. `options.serviceAccountKeyPath`: File path specified via `--service-account-key` or config.
3. `process.env.SERVICE_ACCOUNT_KEY_PATH`: Environment variable.
4. **`./sa-dwd-key.json`**: Automatic default fallback if the file exists in the root directory.

### Structure & Key Fields
Standard GCP Service Account Key format:
```json
{
  "type": "service_account",
  "project_id": "testgebackupandrestorev3",
  "private_key_id": "fbcb8ab71246f847cee1e107ed3da64d9841f0be",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "gemini-dwd-migrator@testgebackupandrestorev3.iam.gserviceaccount.com",
  "client_id": "101686217778481627941",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/gemini-dwd-migrator%40testgebackupandrestorev3.iam.gserviceaccount.com"
}
```

### Critical Fields to Understand:
- **`client_email`**: The service account identity. Must have `roles/discoveryengine.admin` and `roles/serviceusage.serviceUsageConsumer` on **BOTH** the Source and Target projects.
- **`client_id`**: The OAuth2 Client ID. **This is the exact number that must be authorized in Google Workspace Admin Console** (`admin.google.com/ac/owl/domainwidedelegation`) if user impersonation is needed.
- **`project_id`**: The GCP project hosting this service account.

### Mandatory Cross-Project IAM Setup Instructions
The migration service account is created in one project (typically the Target project), but it **must be granted permissions across both environments**:
1. **Target Project (Restore & Provisioning):** Requires `roles/discoveryengine.admin`, `roles/iam.serviceAccountTokenCreator`, and `roles/serviceusage.serviceUsageConsumer`.
2. **Source Project (Discovery & Read):** Requires `roles/discoveryengine.admin` (or `roles/discoveryengine.viewer`) and `roles/serviceusage.serviceUsageConsumer`. Without this, API requests to list engines, datastores, or schemas will fail with HTTP 403 `Caller does not have required permission`.

```bash
# 1. Create the Service Account in Target Project
gcloud iam service-accounts create "gemini-dwd-migrator" \
  --display-name="Gemini Enterprise Migration Service Account" \
  --project="YOUR_TARGET_PROJECT"

# 2. Grant roles on TARGET Project
gcloud projects add-iam-policy-binding "YOUR_TARGET_PROJECT" \
  --member="serviceAccount:gemini-dwd-migrator@YOUR_TARGET_PROJECT.iam.gserviceaccount.com" \
  --role="roles/discoveryengine.admin"

gcloud projects add-iam-policy-binding "YOUR_TARGET_PROJECT" \
  --member="serviceAccount:gemini-dwd-migrator@YOUR_TARGET_PROJECT.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"

gcloud projects add-iam-policy-binding "YOUR_TARGET_PROJECT" \
  --member="serviceAccount:gemini-dwd-migrator@YOUR_TARGET_PROJECT.iam.gserviceaccount.com" \
  --role="roles/serviceusage.serviceUsageConsumer"

# 3. Grant roles on SOURCE Project (MANDATORY for Discovery & Pre-Check)
gcloud projects add-iam-policy-binding "YOUR_SOURCE_PROJECT" \
  --member="serviceAccount:gemini-dwd-migrator@YOUR_TARGET_PROJECT.iam.gserviceaccount.com" \
  --role="roles/discoveryengine.admin"

gcloud projects add-iam-policy-binding "YOUR_SOURCE_PROJECT" \
  --member="serviceAccount:gemini-dwd-migrator@YOUR_TARGET_PROJECT.iam.gserviceaccount.com" \
  --role="roles/serviceusage.serviceUsageConsumer"

# 4. Generate and download sa-dwd-key.json
gcloud iam service-accounts keys create sa-dwd-key.json \
  --iam-account="gemini-dwd-migrator@YOUR_TARGET_PROJECT.iam.gserviceaccount.com" \
  --project="YOUR_TARGET_PROJECT"
```
*Note: Overwriting `sa-dwd-key.json` immediately takes effect upon restarting the application.*

---

## 3. File 2: `workforce-identity-config.json` (WiF / STS Configuration)

### How It Is Loaded
[gcpAuth.ts](file:///usr/local/google/home/wdufrin/Documents/Code/headless%20migration%20tool/src/services/gcpAuth.ts) resolves Workforce Identity Federation configs in this order:
1. `options.wifConfigJson`: Inline config.
2. `options.wifConfigPath`: File path specified via `--wif-config` or config.
3. `process.env.WIF_CONFIG_PATH`: Environment variable.
4. **`./workforce-identity-config.json`**: Automatic default fallback if present in the root directory.

### Structure & Key Fields
```json
{
  "type": "external_account",
  "audience": "//iam.googleapis.com/locations/global/workforcePools/wdufrin-test-entra/providers/migration-dwd-provider",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "token_url": "https://sts.googleapis.com/v1/token",
  "credential_source": {
    "file": "./idp-subject-token.jwt",
    "format": {
      "type": "text"
    }
  }
}
```

### Critical Fields to Understand:
- **`audience`**: The fully qualified resource URI of your Workforce Identity Pool & Provider in GCP IAM:
  `//iam.googleapis.com/locations/global/workforcePools/<POOL_NAME>/providers/<PROVIDER_NAME>`
- **`token_url`**: Always `https://sts.googleapis.com/v1/token`.
- **`credential_source.file`**: The file path where the incoming IDP OIDC token (JWT) is stored for STS exchange.

### How to Change or Update:
If you set up a new workforce pool in a new project or change IDPs (e.g. from Entra to Okta):
1. Update `audience` to point to the new pool name:
   `//iam.googleapis.com/locations/global/workforcePools/<NEW_POOL>/providers/<NEW_PROVIDER>`
2. Or let the Setup Wizard generate it: Tab **"Setup Wizard"** -> **"Step 2b: Workforce Identity Federation"** -> Click **"Generate & Save WiF Config"**.

---

## 4. File 3: `migration-config.json` (Pipeline Configuration)

### How It Is Loaded
The configuration loader ([loader.ts](file:///usr/local/google/home/wdufrin/Documents/Code/headless%20migration%20tool/src/config/loader.ts)) reads:
1. Path passed via `--config <path>` in CLI.
2. Default `./migration-config.json` when running `npm start` or headless worker.

### Structure & Key Fields
```json
{
  "source": {
    "projectId": "ancient-sandbox-322523",
    "appLocation": "us",
    "collectionId": "default_collection",
    "appId": "ge-assistant-app",
    "assistantId": "default_assistant"
  },
  "target": {
    "projectId": "testgebackupandrestorev3",
    "appLocation": "global",
    "collectionId": "default_collection",
    "appId": "test1_1788362852716",
    "assistantId": "default_assistant"
  },
  "options": {
    "migrateNotebooks": true,
    "migrateAgents": true,
    "migrateSessions": true,
    "migrateMemories": true,
    "dryRun": false,
    "concurrency": 10,
    "userFilter": ["*@wdufrin.altostrat.com"]
  },
  "datastoreMapping": {
    "old-datastore-id": "new-datastore-id"
  },
  "identityMapping": {
    "will@wdufrin.altostrat.com": "admin@wdufrin.altostrat.com"
  }
}
```

### How to Change:
You can duplicate `config.example.json` to create `migration-config.json`:
```bash
cp config.example.json migration-config.json
```
And adjust `projectId`, `appId`, and `identityMapping` to match your target landscape.

---

## 5. Summary Flowchart of How Auth Resolves JSONs

```mermaid
graph TD
    Start["API Request / Migration Step"] --> CheckCleanEmail{"Targeting Specific User Email?"}
    
    CheckCleanEmail -- "Yes (cleanEmail)" --> CheckCaller{"Is cleanEmail == Active gcloud caller?"}
    CheckCaller -- "Yes" --> UseCallerADC["Use Active gcloud Token (ADC)\n(Bypasses DWD/WiF directly)"]
    
    CheckCaller -- "No" --> CheckWif{"Is External IDP (Entra/Okta) or WIF Mode?"}
    CheckWif -- "Yes" --> LoadWiFConfig["Load workforce-identity-config.json\nExchange token with GCP STS"]
    CheckWif -- "No" --> LoadSaKey["Load sa-dwd-key.json\nMint DWD Impersonated JWT"]
    
    CheckCleanEmail -- "No (Admin / System Call)" --> CheckSaPresent{"sa-dwd-key.json exists?"}
    CheckSaPresent -- "Yes" --> UseSA["Use Service Account Admin Token"]
    CheckSaPresent -- "No" --> UseADC["Use Ambient gcloud ADC Token"]
```

---

## 6. Verification Checklist

Whenever you update or replace any `.json` file:

- [ ] **Verify SA Key Syntax & Identity:**
  ```bash
  node -e "const k = JSON.parse(require('fs').readFileSync('sa-dwd-key.json')); console.log('Loaded SA:', k.client_email, 'Client ID:', k.client_id, 'Project:', k.project_id);"
  ```
- [ ] **Verify WiF Config Syntax & Pool:**
  ```bash
  node -e "const w = JSON.parse(require('fs').readFileSync('workforce-identity-config.json')); console.log('WiF Audience:', w.audience);"
  ```
- [ ] **Run Pre-Flight Self-Test:**
  ```bash
  npm test tests/maintenance.test.ts
  ```
