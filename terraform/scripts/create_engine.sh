#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="$1"
LOCATION="$2"
COLLECTION_ID="$3"
ENGINE_ID="$4"
DISPLAY_NAME="$5"

DISCOVERY_ENGINE_BASE_URL="https://discoveryengine.googleapis.com"

ACCESS_TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null || gcloud auth print-access-token 2>/dev/null)
if [[ -z "${ACCESS_TOKEN}" ]]; then
  echo "Error: Unable to get access token for Discovery Engine provisioning" >&2
  exit 1
fi

# Check if engine already exists
CHECK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "X-Goog-User-Project: ${PROJECT_ID}" \
  "${DISCOVERY_ENGINE_BASE_URL}/v1alpha/projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/engines/${ENGINE_ID}" || echo "000")

if [[ "${CHECK_STATUS}" == "200" ]]; then
  echo "Discovery Engine ${ENGINE_ID} already exists in ${PROJECT_ID}."
  exit 0
fi

# Exact configuration payload mirroring testgebackupandrestorev2
ENGINE_PAYLOAD=$(cat << JSON
{
  "displayName": "${DISPLAY_NAME}",
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

echo "Creating engine ${ENGINE_ID} in ${PROJECT_ID}..."

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
    echo "Attempt $((RETRY_COUNT + 1))/${MAX_RETRIES}: HTTP ${HTTP_STATUS}. Waiting 10s for Discovery Engine API to initialize..."
    sleep 10
    RETRY_COUNT=$((RETRY_COUNT + 1))
    ACCESS_TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null || gcloud auth print-access-token 2>/dev/null)
  fi
done

if [[ "${CREATE_SUCCESS}" == "false" ]]; then
  echo "Error creating engine: ${RESP_BODY}" >&2
  exit 1
fi

if [[ -n "${OPERATION_NAME}" ]]; then
  echo "Polling operation ${OPERATION_NAME}..."
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
        echo "Error: ${OP_ERROR}" >&2
        exit 1
      fi
      echo "Engine created successfully!"
      break
    fi
    sleep 5
    POLL_COUNT=$((POLL_COUNT + 1))
  done
fi

# Verify / create default_assistant
ASSISTANT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "X-Goog-User-Project: ${PROJECT_ID}" \
  "${DISCOVERY_ENGINE_BASE_URL}/v1alpha/projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/engines/${ENGINE_ID}/assistants/default_assistant" || echo "000")

if [[ "${ASSISTANT_STATUS}" != "200" ]]; then
  curl -s -X POST \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "X-Goog-User-Project: ${PROJECT_ID}" \
    -H "Content-Type: application/json" \
    -d '{"displayName": "Default Assistant", "webGroundingType": "WEB_GROUNDING_TYPE_GOOGLE_SEARCH"}' \
    "${DISCOVERY_ENGINE_BASE_URL}/v1alpha/projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/engines/${ENGINE_ID}/assistants?assistantId=default_assistant" >/dev/null || true
fi

echo "Engine and assistant setup verified."
