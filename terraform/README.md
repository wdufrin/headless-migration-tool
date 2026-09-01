# 🌍 Gemini Enterprise Test Environment — Terraform Module

This Terraform module spins up a fresh, fully configured Google Cloud test environment mirroring the architecture of **`testgebackupandrestorev2`**.

---

## 📋 What is Provisioned

1. **Google Cloud Project**:
   - Organization: `942977750288`
   - Billing Account: `0124EE-048763-814962`
2. **Enabled APIs**:
   - `discoveryengine.googleapis.com`
   - `dialogflow.googleapis.com`
   - `iam.googleapis.com`, `iamcredentials.googleapis.com`
   - `serviceusage.googleapis.com`, `cloudresourcemanager.googleapis.com`
   - `aiplatform.googleapis.com`, `storage.googleapis.com`, `cloudkms.googleapis.com`, `cloudtrace.googleapis.com`, `logging.googleapis.com`, `monitoring.googleapis.com`
3. **IAM Bindings**:
   - DWD Migration Service Account (`gemini-dwd-migrator@ancient-sandbox-322523.iam.gserviceaccount.com`): `roles/discoveryengine.admin`
   - Project Owner (`admin@wdufrin.altostrat.com`): `roles/owner`
   - Discovery Engine Editor (`bryankelly@wdufrin.altostrat.com`): `roles/discoveryengine.editor`
   - Workforce Identity Federation (`wdufrin-entra`): `roles/discoveryengine.agentUser`, `roles/serviceusage.serviceUsageConsumer`
   - Specific Entra User (`wdufrin@wdufrin.onmicrosoft.com`): `roles/discoveryengine.user`
4. **Gemini Enterprise Discovery Engine Intranet App**:
   - Solution Type: `SOLUTION_TYPE_SEARCH`
   - App Type: `APP_TYPE_INTRANET`
   - Search Tier: `SEARCH_TIER_ENTERPRISE` with `SEARCH_ADD_ON_LLM`
   - Feature flags enabled: NotebookLM, No-Code Agent Builder, Workflow Agents, Agent Gallery, Skills, Bi-directional Audio, Personalization Memory, etc.
   - Model configs: Gemini 3.7 Flash, Gemini 3.6 Flash, Gemini 3.1 Pro Preview enabled.
   - Assistant: `default_assistant` initialized with Google Search grounding.

---

## 🚀 Quickstart

### 1. Initialize Variables
```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars to set your desired project_id
```

### 2. Run Terraform
```bash
terraform init
terraform plan
terraform apply
```

### 3. Apply Target Configuration to Migration Tool
When `terraform apply` finishes, the module outputs the exact JSON configuration:
```bash
terraform output -json migration_config_target
```
Paste this into your `migration-config.json` under `"target"`.

### 4. Teardown
When you are done testing, destroy all resources to avoid ongoing costs:
```bash
terraform destroy
```
