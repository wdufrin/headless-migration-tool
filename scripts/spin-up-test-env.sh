#!/usr/bin/env bash
#
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# ==============================================================================
# spin-up-test-env.sh
# Automated Test Environment Provisioner for Gemini Enterprise Migration Tool
# Replicates the exact environment architecture of testgebackupandrestorev2
# ==============================================================================

set -euo pipefail

# Text formatting
BOLD="\033[1m"
GREEN="\033[0;32m"
BLUE="\033[0;34m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
NC="\033[0m"

# Configuration defaults
DEFAULT_ORG_ID="${GCP_ORG_ID:-}"
DEFAULT_BILLING_ACCOUNT="${GCP_BILLING_ACCOUNT:-}"
DEFAULT_LOCATION="global"
DEFAULT_COLLECTION="default_collection"
DEFAULT_ENGINE_ID="testnotebooks_$(date +%s)"
DEFAULT_ENGINE_DISPLAY_NAME="testnotebooks"
DEFAULT_DWD_SA="${MIGRATION_DWD_SA:-}"
DEFAULT_ADMIN_USER="${GCP_ADMIN_USER:-}"
DEFAULT_EDITOR_USER="${GCP_EDITOR_USER:-}"
DEFAULT_WORKFORCE_POOL="${WORKFORCE_POOL_ID:-}"
DEFAULT_ENTRA_USER="${ENTRA_USER_EMAIL:-}"

# Variables with defaults
PROJECT_ID=""
ORG_ID="${DEFAULT_ORG_ID}"
BILLING_ACCOUNT="${DEFAULT_BILLING_ACCOUNT}"
LOCATION="${DEFAULT_LOCATION}"
COLLECTION_ID="${DEFAULT_COLLECTION}"
ENGINE_ID="${DEFAULT_ENGINE_ID}"
ENGINE_DISPLAY_NAME="${DEFAULT_ENGINE_DISPLAY_NAME}"
DWD_SA="${DEFAULT_DWD_SA}"
ADMIN_USER="${DEFAULT_ADMIN_USER}"
EDITOR_USER="${DEFAULT_EDITOR_USER}"
WORKFORCE_POOL="${DEFAULT_WORKFORCE_POOL}"
ENTRA_USER="${DEFAULT_ENTRA_USER}"

UPDATE_CONFIG=false
CONFIG_ROLE="target" # "target" or "source"
SEED_AGENTS=false
DRY_RUN=false
SKIP_EXISTING_PROJECT=false

usage() {
  cat << 'EOF'
Usage: spin-up-test-env.sh [options]

Options:
  -p, --project-id <ID>         New GCP Project ID to create (e.g. ge-test-target-01).
                                Defaults to: ge-test-<timestamp>
  -e, --engine-id <ID>          Discovery Engine / App ID. Defaults to: testnotebooks_<timestamp>
  -n, --display-name <NAME>     Engine display name. Defaults to: testnotebooks
  -o, --org-id <ORG_ID>         GCP Organization ID (or set $GCP_ORG_ID)
  -b, --billing <ACCOUNT_ID>    Cloud Billing Account ID (or set $GCP_BILLING_ACCOUNT)
  -l, --location <LOCATION>     App location (global/us/eu). Defaults to: global
  --dwd-sa <EMAIL>              Domain-Wide Delegation Service Account Email
  --admin-user <EMAIL>          Project Owner user email (defaults to active gcloud account)
  --editor-user <EMAIL>         Discovery Engine Editor user email
  --workforce-pool <NAME>       Workforce Identity Pool ID
  --update-config               Automatically update migration-config.json with the new project & engine.
  --as-source                   When updating config, set this project as "source" instead of "target".
  --seed-agents                 Clone sample test agents from testgebackupandrestorev2 into the new project.
  --reuse-project               If the GCP project already exists, configure it rather than failing.
  --dry-run                     Print actions that would be executed without running them.
  -h, --help                    Show this help message.

Examples:
  # Quick spin-up with auto-generated project ID:
  ./scripts/spin-up-test-env.sh --update-config

  # Spin up with specific project ID and seed test agents:
  ./scripts/spin-up-test-env.sh -p my-ge-test-env-01 --seed-agents --update-config

  # Spin up and configure as source project:
  ./scripts/spin-up-test-env.sh -p my-ge-source-env --as-source --update-config
EOF
  exit 0
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -p|--project-id)
      PROJECT_ID="$2"
      shift 2
      ;;
    -e|--engine-id)
      ENGINE_ID="$2"
      shift 2
      ;;
    -n|--display-name)
      ENGINE_DISPLAY_NAME="$2"
      shift 2
      ;;
    -o|--org-id)
      ORG_ID="$2"
      shift 2
      ;;
    -b|--billing)
      BILLING_ACCOUNT="$2"
      shift 2
      ;;
    -l|--location)
      LOCATION="$2"
      shift 2
      ;;
    --dwd-sa)
      DWD_SA="$2"
      shift 2
      ;;
    --admin-user)
      ADMIN_USER="$2"
      shift 2
      ;;
    --editor-user)
      EDITOR_USER="$2"
      shift 2
      ;;
    --workforce-pool)
      WORKFORCE_POOL="$2"
      shift 2
      ;;
    --update-config)
      UPDATE_CONFIG=true
      shift
      ;;
    --as-source)
      CONFIG_ROLE="source"
      shift
      ;;
    --seed-agents)
      SEED_AGENTS=true
      shift
      ;;
    --reuse-project)
      SKIP_EXISTING_PROJECT=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo -e "${RED}Error: Unknown argument: $1${NC}"
      usage
      ;;
  esac
done

# Generate project ID if not supplied
if [[ -z "${PROJECT_ID}" ]]; then
  PROJECT_ID="ge-test-$(date +%s)"
fi

echo -e "${CYAN}======================================================================${NC}"
echo -e "${BOLD}${BLUE}🚀 Gemini Enterprise Test Environment Provisioner${NC}"
echo -e "${CYAN}======================================================================${NC}"
echo -e "Mirroring Architecture from: ${BOLD}testgebackupandrestorev2${NC}"
echo -e "Target Project ID:           ${BOLD}${GREEN}${PROJECT_ID}${NC}"
echo -e "Organization ID:             ${BOLD}${ORG_ID}${NC}"
echo -e "Billing Account:             ${BOLD}${BILLING_ACCOUNT}${NC}"
echo -e "App Engine ID:               ${BOLD}${ENGINE_ID}${NC}"
echo -e "Engine Display Name:         ${BOLD}${ENGINE_DISPLAY_NAME}${NC}"
echo -e "Location:                    ${BOLD}${LOCATION}${NC}"
echo -e "DWD Service Account:         ${BOLD}${DWD_SA}${NC}"
echo -e "Workforce Pool:              ${BOLD}locations/global/workforcePools/${WORKFORCE_POOL}${NC}"
echo -e "Update migration-config:     ${BOLD}${UPDATE_CONFIG}${NC} (Role: ${CONFIG_ROLE})"
echo -e "Seed Sample Agents:          ${BOLD}${SEED_AGENTS}${NC}"
echo -e "${CYAN}----------------------------------------------------------------------${NC}"

if [[ "${DRY_RUN}" == "true" ]]; then
  echo -e "${YELLOW}[DRY RUN MODE] Actions will be simulated without making cloud modifications.${NC}"
fi

# Step 1: Preflight checks
echo -e "\n${BOLD}[1/7] 🔍 Checking local tooling & credentials...${NC}"
command -v gcloud >/dev/null 2>&1 || { echo -e "${RED}Error: gcloud CLI is required.${NC}"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo -e "${RED}Error: curl is required.${NC}"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo -e "${RED}Error: jq is required.${NC}"; exit 1; }

ACTIVE_ACCOUNT=$(gcloud config get-value account 2>/dev/null || echo "")
if [[ -z "${ACTIVE_ACCOUNT}" ]]; then
  echo -e "${RED}Error: No active gcloud account. Run 'gcloud auth login' or 'gcloud auth application-default login'.${NC}"
  exit 1
fi
echo -e "Authenticated gcloud user: ${GREEN}${ACTIVE_ACCOUNT}${NC}"

ACCESS_TOKEN=""
if [[ "${DRY_RUN}" == "false" ]]; then
  ACCESS_TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null || gcloud auth print-access-token 2>/dev/null)
  if [[ -z "${ACCESS_TOKEN}" ]]; then
    echo -e "${RED}Error: Failed to obtain access token. Run 'gcloud auth application-default login'.${NC}"
    exit 1
  fi
fi

# Step 2: Create Project
echo -e "\n${BOLD}[2/7] 🏗️  Creating or verifying GCP project: ${PROJECT_ID}...${NC}"
PROJECT_EXISTS=false
if gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  PROJECT_EXISTS=true
fi

if [[ "${PROJECT_EXISTS}" == "true" ]]; then
  if [[ "${SKIP_EXISTING_PROJECT}" == "true" ]]; then
    echo -e "${YELLOW}Project ${PROJECT_ID} already exists. Proceeding with configuration (--reuse-project).${NC}"
  else
    echo -e "${YELLOW}Project ${PROJECT_ID} already exists.${NC}"
    if [[ "${DRY_RUN}" == "false" ]]; then
      echo -n "Do you want to re-configure this project? (y/N): "
      read -r CONFIRM
      if [[ "${CONFIRM}" != "y" && "${CONFIRM}" != "Y" ]]; then
        echo -e "${RED}Aborted by user.${NC}"
        exit 1
      fi
    fi
  fi
else
  if [[ -n "${ORG_ID}" ]]; then
    echo -e "Creating project ${BOLD}${PROJECT_ID}${NC} in organization ${BOLD}${ORG_ID}${NC}..."
    if [[ "${DRY_RUN}" == "false" ]]; then
      gcloud projects create "${PROJECT_ID}" \
        --organization="${ORG_ID}" \
        --name="${PROJECT_ID}" \
        --quiet
      echo -e "${GREEN}✓ Project created successfully.${NC}"
    fi
  else
    echo -e "Creating project ${BOLD}${PROJECT_ID}${NC}..."
    if [[ "${DRY_RUN}" == "false" ]]; then
      gcloud projects create "${PROJECT_ID}" \
        --name="${PROJECT_ID}" \
        --quiet
      echo -e "${GREEN}✓ Project created successfully.${NC}"
    fi
  fi
fi

# Step 3: Link Billing Account
if [[ -n "${BILLING_ACCOUNT}" ]]; then
  echo -e "\n${BOLD}[3/7] 💳 Linking Cloud Billing Account (${BILLING_ACCOUNT})...${NC}"
  if [[ "${DRY_RUN}" == "false" ]]; then
    CURRENT_BILLING=$(gcloud billing projects describe "${PROJECT_ID}" --format="value(billingAccountName)" 2>/dev/null || echo "")
    TARGET_BILLING_NAME="billingAccounts/${BILLING_ACCOUNT}"
    if [[ "${CURRENT_BILLING}" == "${TARGET_BILLING_NAME}" ]]; then
      echo -e "${GREEN}✓ Billing account already linked.${NC}"
    else
      gcloud billing projects link "${PROJECT_ID}" --billing-account="${BILLING_ACCOUNT}" --quiet
      echo -e "${GREEN}✓ Billing linked successfully.${NC}"
    fi
  fi
else
  echo -e "\n${BOLD}[3/7] ℹ️ Skipping billing account linking (No billing account specified)...${NC}"
fi

# Step 4: Enable Required APIs
echo -e "\n${BOLD}[4/7] ⚡ Enabling required Google Cloud APIs...${NC}"
REQUIRED_SERVICES=(
  "discoveryengine.googleapis.com"
  "dialogflow.googleapis.com"
  "iam.googleapis.com"
  "iamcredentials.googleapis.com"
  "cloudresourcemanager.googleapis.com"
  "serviceusage.googleapis.com"
  "aiplatform.googleapis.com"
  "storage.googleapis.com"
  "cloudkms.googleapis.com"
  "cloudtrace.googleapis.com"
  "logging.googleapis.com"
  "monitoring.googleapis.com"
)

echo -e "Enabling: ${REQUIRED_SERVICES[*]}..."
if [[ "${DRY_RUN}" == "false" ]]; then
  gcloud services enable "${REQUIRED_SERVICES[@]}" --project="${PROJECT_ID}" --quiet
  echo -e "${GREEN}✓ All APIs enabled.${NC}"
fi

# Step 5: Configure IAM Policy Bindings (mirroring testgebackupandrestorev2)
echo -e "\n${BOLD}[5/7] 🔐 Configuring IAM roles & permissions...${NC}"
if [[ "${DRY_RUN}" == "false" ]]; then
  echo -e "Binding ${BOLD}roles/discoveryengine.admin${NC} -> serviceAccount:${DWD_SA}..."
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${DWD_SA}" \
    --role="roles/discoveryengine.admin" \
    --condition=None --quiet >/dev/null

  echo -e "Binding ${BOLD}roles/owner${NC} -> user:${ADMIN_USER}..."
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="user:${ADMIN_USER}" \
    --role="roles/owner" \
    --condition=None --quiet >/dev/null

  echo -e "Binding ${BOLD}roles/discoveryengine.editor${NC} -> user:${EDITOR_USER}..."
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="user:${EDITOR_USER}" \
    --role="roles/discoveryengine.editor" \
    --condition=None --quiet >/dev/null

  WIF_PRINCIPAL_SET="principalSet://iam.googleapis.com/locations/global/workforcePools/${WORKFORCE_POOL}/*"
  echo -e "Binding ${BOLD}roles/discoveryengine.agentUser${NC} -> ${WIF_PRINCIPAL_SET}..."
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="${WIF_PRINCIPAL_SET}" \
    --role="roles/discoveryengine.agentUser" \
    --condition=None --quiet >/dev/null

  echo -e "Binding ${BOLD}roles/serviceusage.serviceUsageConsumer${NC} -> ${WIF_PRINCIPAL_SET}..."
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="${WIF_PRINCIPAL_SET}" \
    --role="roles/serviceusage.serviceUsageConsumer" \
    --condition=None --quiet >/dev/null

  if [[ -n "${ENTRA_USER}" ]]; then
    WIF_SINGLE_USER="principal://iam.googleapis.com/locations/global/workforcePools/${WORKFORCE_POOL}/subject/${ENTRA_USER}"
    echo -e "Binding ${BOLD}roles/discoveryengine.user${NC} -> ${WIF_SINGLE_USER}..."
    gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member="${WIF_SINGLE_USER}" \
      --role="roles/discoveryengine.user" \
      --condition=None --quiet >/dev/null
  fi

  echo -e "${GREEN}✓ IAM bindings configured successfully.${NC}"
fi

# Step 6: Provision Gemini Enterprise Discovery Engine App (Intranet Search Engine)
echo -e "\n${BOLD}[6/7] 🧠 Provisioning Gemini Enterprise Intranet App & Assistant...${NC}"
DISCOVERY_ENGINE_BASE_URL="https://discoveryengine.googleapis.com"

ENGINE_EXISTS=false
if [[ "${DRY_RUN}" == "false" ]]; then
  CHECK_ENGINE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "X-Goog-User-Project: ${PROJECT_ID}" \
    "${DISCOVERY_ENGINE_BASE_URL}/v1alpha/projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/engines/${ENGINE_ID}" || echo "000")

  if [[ "${CHECK_ENGINE_STATUS}" == "200" ]]; then
    ENGINE_EXISTS=true
    echo -e "${YELLOW}Discovery Engine ${ENGINE_ID} already exists in ${PROJECT_ID}.${NC}"
  fi
fi

if [[ "${ENGINE_EXISTS}" == "false" && "${DRY_RUN}" == "false" ]]; then
  ENGINE_PAYLOAD=$(cat << JSON
{
  "displayName": "${ENGINE_DISPLAY_NAME}",
  "solutionType": "SOLUTION_TYPE_SEARCH",
  "searchEngineConfig": {
    "searchTier": "SEARCH_TIER_ENTERPRISE",
    "searchAddOns": [
      "SEARCH_ADD_ON_LLM"
    ],
    "requiredSubscriptionTier": "SUBSCRIPTION_TIER_SEARCH_AND_ASSISTANT"
  },
  "industryVertical": "GENERIC",
  "knowledgeGraphConfig": {
    "enablePrivateKnowledgeGraph": true,
    "featureConfig": {}
  },
  "appType": "APP_TYPE_INTRANET",
  "features": {
    "enable-qr-code-widget": "FEATURE_STATE_OFF",
    "session-sharing": "FEATURE_STATE_OFF",
    "disable-skills": "FEATURE_STATE_OFF",
    "feedback": "FEATURE_STATE_ON",
    "skill-sharing-without-admin-approval": "FEATURE_STATE_OFF",
    "skills": "FEATURE_STATE_ON",
    "agent-sharing-without-admin-approval": "FEATURE_STATE_ON",
    "cross-product-intelligence": "FEATURE_STATE_OFF",
    "enable-end-user-sharing-with-groups": "FEATURE_STATE_OFF",
    "prompt-gallery": "FEATURE_STATE_ON",
    "notebook-lm": "FEATURE_STATE_ON",
    "disable-google-drive-upload": "FEATURE_STATE_OFF",
    "bi-directional-audio": "FEATURE_STATE_ON",
    "disable-canvas": "FEATURE_STATE_OFF",
    "disable-onedrive-upload": "FEATURE_STATE_OFF",
    "mobile-app-access": "FEATURE_STATE_OFF",
    "in-app-notifications": "FEATURE_STATE_ON",
    "model-selector": "FEATURE_STATE_ON",
    "disable-canvas-workspace": "FEATURE_STATE_OFF",
    "cross-domain-documents": "FEATURE_STATE_OFF",
    "disable-multi-agent-orchestration": "FEATURE_STATE_ON",
    "disable-agent-sharing": "FEATURE_STATE_OFF",
    "disable-projects": "FEATURE_STATE_ON",
    "no-code-agent-builder": "FEATURE_STATE_ON",
    "workflow-agents": "FEATURE_STATE_ON",
    "people-search": "FEATURE_STATE_OFF",
    "disable-single-agent-orchestration": "FEATURE_STATE_ON",
    "skill-sharing": "FEATURE_STATE_ON",
    "people-search-org-chart": "FEATURE_STATE_ON",
    "disable-mobile-app-access": "FEATURE_STATE_ON",
    "agent-gallery": "FEATURE_STATE_ON",
    "disable-image-generation": "FEATURE_STATE_OFF",
    "disable-welcome-emails": "FEATURE_STATE_OFF",
    "personalization-suggested-highlights": "FEATURE_STATE_ON",
    "disable-talk-to-content": "FEATURE_STATE_OFF",
    "personalization-memory": "FEATURE_STATE_ON",
    "disable-video-generation": "FEATURE_STATE_OFF"
  },
  "modelConfigs": {
    "gemini-3.1-pro-preview": "MODEL_ENABLED",
    "gemini-3.6-flash": "MODEL_ENABLED",
    "gemini-3.7-flash": "MODEL_ENABLED"
  },
  "observabilityConfig": {
    "observabilityEnabled": true
  },
  "marketplaceAgentVisibility": "SHOW_ALL_AGENTS"
}
JSON
)

  echo -e "Creating Discovery Engine ${BOLD}${ENGINE_ID}${NC} (App Type: INTRANET, Search Tier: ENTERPRISE, LLM Add-on)..."
  
  CREATE_SUCCESS=false
  MAX_RETRIES=6
  RETRY_COUNT=0
  OPERATION_NAME=""

  while [[ ${RETRY_COUNT} -lt ${MAX_RETRIES} ]]; do
    RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
      -X POST \
      -H "Authorization: Bearer ${ACCESS_TOKEN}" \
      -H "X-Goog-User-Project: ${PROJECT_ID}" \
      -H "Content-Type: application/json" \
      -d "${ENGINE_PAYLOAD}" \
      "${DISCOVERY_ENGINE_BASE_URL}/v1alpha/projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/engines?engineId=${ENGINE_ID}")

    HTTP_STATUS=$(echo "${RESPONSE}" | grep "HTTP_STATUS:" | cut -d':' -f2)
    RESP_BODY=$(echo "${RESPONSE}" | grep -v "HTTP_STATUS:")

    if [[ "${HTTP_STATUS}" == "200" || "${HTTP_STATUS}" == "201" ]]; then
      OPERATION_NAME=$(echo "${RESP_BODY}" | jq -r '.name // empty')
      CREATE_SUCCESS=true
      break
    else
      echo -e "${YELLOW}Attempt $((RETRY_COUNT + 1))/${MAX_RETRIES}: API returned HTTP ${HTTP_STATUS}. Waiting 10s for API warm-up...${NC}"
      sleep 10
      RETRY_COUNT=$((RETRY_COUNT + 1))
      ACCESS_TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null || gcloud auth print-access-token 2>/dev/null)
    fi
  done

  if [[ "${CREATE_SUCCESS}" == "false" ]]; then
    echo -e "${RED}Error: Failed to initiate engine creation. Last response:${NC}"
    echo "${RESP_BODY}"
    exit 1
  fi

  if [[ -n "${OPERATION_NAME}" ]]; then
    echo -e "Operation started: ${CYAN}${OPERATION_NAME}${NC}"
    echo -n "Waiting for Discovery Engine provisioning to complete"
    POLL_COUNT=0
    while [[ ${POLL_COUNT} -lt 60 ]]; do
      OP_RES=$(curl -s \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "X-Goog-User-Project: ${PROJECT_ID}" \
        "${DISCOVERY_ENGINE_BASE_URL}/v1alpha/${OPERATION_NAME}")

      IS_DONE=$(echo "${OP_RES}" | jq -r '.done // false')
      if [[ "${IS_DONE}" == "true" ]]; then
        OP_ERROR=$(echo "${OP_RES}" | jq -r '.error.message // empty')
        if [[ -n "${OP_ERROR}" ]]; then
          echo -e "\n${RED}Error during engine creation: ${OP_ERROR}${NC}"
          exit 1
        fi
        echo -e "\n${GREEN}✓ Engine created and ready!${NC}"
        break
      fi
      echo -n "."
      sleep 5
      POLL_COUNT=$((POLL_COUNT + 1))
    done
  fi

  echo -e "Verifying ${BOLD}default_assistant${NC} under engine ${ENGINE_ID}..."
  ASSISTANT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "X-Goog-User-Project: ${PROJECT_ID}" \
    "${DISCOVERY_ENGINE_BASE_URL}/v1alpha/projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/engines/${ENGINE_ID}/assistants/default_assistant" || echo "000")

  if [[ "${ASSISTANT_STATUS}" != "200" ]]; then
    echo -e "Creating default_assistant..."
    curl -s -X POST \
      -H "Authorization: Bearer ${ACCESS_TOKEN}" \
      -H "X-Goog-User-Project: ${PROJECT_ID}" \
      -H "Content-Type: application/json" \
      -d '{"displayName": "Default Assistant", "webGroundingType": "WEB_GROUNDING_TYPE_GOOGLE_SEARCH"}' \
      "${DISCOVERY_ENGINE_BASE_URL}/v1alpha/projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/engines/${ENGINE_ID}/assistants?assistantId=default_assistant" >/dev/null || true
  fi
  echo -e "${GREEN}✓ Assistant active.${NC}"
fi

# Step 7: (Optional) Seed Sample Agents from testgebackupandrestorev2
if [[ "${SEED_AGENTS}" == "true" && "${DRY_RUN}" == "false" ]]; then
  echo -e "\n${BOLD}[7/7] 📦 Seeding test agents from testgebackupandrestorev2...${NC}"
  SOURCE_PROJECT="testgebackupandrestorev2"
  SOURCE_APP="testnotebooks_1784725785748"

  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

  echo -e "Executing migration tool to copy agents from ${SOURCE_PROJECT} -> ${PROJECT_ID}..."
  (
    cd "${PROJECT_ROOT}"
    SOURCE_PROJECT_ID="${SOURCE_PROJECT}" \
    SOURCE_LOCATION="global" \
    SOURCE_COLLECTION_ID="default_collection" \
    SOURCE_APP_ID="${SOURCE_APP}" \
    SOURCE_ASSISTANT_ID="default_assistant" \
    TARGET_PROJECT_ID="${PROJECT_ID}" \
    TARGET_LOCATION="${LOCATION}" \
    TARGET_COLLECTION_ID="${COLLECTION_ID}" \
    TARGET_APP_ID="${ENGINE_ID}" \
    TARGET_ASSISTANT_ID="default_assistant" \
    npx tsx src/cli.ts --no-notebooks --no-sessions --no-memories --publish-agents || true
  )
  echo -e "${GREEN}✓ Sample agents seeded successfully.${NC}"
else
  echo -e "\n${BOLD}[7/7] Clean environment (no sample agents seeded).${NC}"
fi

# Update migration-config.json if requested
if [[ "${UPDATE_CONFIG}" == "true" && "${DRY_RUN}" == "false" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
  CONFIG_PATH="${PROJECT_ROOT}/migration-config.json"

  if [[ -f "${CONFIG_PATH}" ]]; then
    echo -e "\nUpdating ${BOLD}${CONFIG_PATH}${NC} (${CONFIG_ROLE})..."
    TEMP_FILE=$(mktemp)
    if [[ "${CONFIG_ROLE}" == "target" ]]; then
      jq --arg proj "${PROJECT_ID}" --arg app "${ENGINE_ID}" --arg loc "${LOCATION}" --arg col "${COLLECTION_ID}" \
        '.target.projectId = $proj | .target.appId = $app | .target.appLocation = $loc | .target.collectionId = $col' \
        "${CONFIG_PATH}" > "${TEMP_FILE}" && mv "${TEMP_FILE}" "${CONFIG_PATH}"
      echo -e "${GREEN}✓ Updated target configuration in migration-config.json.${NC}"
    else
      jq --arg proj "${PROJECT_ID}" --arg app "${ENGINE_ID}" --arg loc "${LOCATION}" --arg col "${COLLECTION_ID}" \
        '.source.projectId = $proj | .source.appId = $app | .source.appLocation = $loc | .source.collectionId = $col' \
        "${CONFIG_PATH}" > "${TEMP_FILE}" && mv "${TEMP_FILE}" "${CONFIG_PATH}"
      echo -e "${GREEN}✓ Updated source configuration in migration-config.json.${NC}"
    fi
  fi
fi

# Print Success Summary
echo -e "\n${GREEN}======================================================================${NC}"
echo -e "${BOLD}${GREEN}🎉 New Test Environment Successfully Provisioned!${NC}"
echo -e "${GREEN}======================================================================${NC}"
echo -e "Project ID:            ${BOLD}${CYAN}${PROJECT_ID}${NC}"
echo -e "Discovery Engine ID:   ${BOLD}${CYAN}${ENGINE_ID}${NC}"
echo -e "Assistant ID:          ${BOLD}default_assistant${NC}"
echo -e "Location:              ${BOLD}${LOCATION}${NC}"
echo -e "Collection:            ${BOLD}${COLLECTION_ID}${NC}"
echo -e ""
echo -e "${BOLD}Ready-to-use migration-config.json snippet:${NC}"
echo -e "{"
echo -e "  \"${CONFIG_ROLE}\": {"
echo -e "    \"projectId\": \"${PROJECT_ID}\","
echo -e "    \"appLocation\": \"${LOCATION}\","
echo -e "    \"collectionId\": \"${COLLECTION_ID}\","
echo -e "    \"appId\": \"${ENGINE_ID}\","
echo -e "    \"assistantId\": \"default_assistant\""
echo -e "  }"
echo -e "}"
echo -e "${CYAN}----------------------------------------------------------------------${NC}"
echo -e "${BOLD}Next Steps:${NC}"
echo -e "  1. Verify with Migration Tool Wizard:  ${CYAN}npm run ui${NC}"
echo -e "  2. Run a Dry Run Migration:             ${CYAN}npm run migrate -- --dry-run${NC}"
echo -e "  3. When finished, teardown project:    ${CYAN}bash scripts/teardown-test-env.sh -p ${PROJECT_ID}${NC}"
echo -e "${CYAN}======================================================================${NC}"
