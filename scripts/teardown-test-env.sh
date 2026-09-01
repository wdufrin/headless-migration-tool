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
# teardown-test-env.sh
# Safely tears down and deletes ephemeral test GCP environments.
# Contains built-in protections for golden test environments.
# ==============================================================================

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[1;33m"
CYAN="\033[0;36m"
NC="\033[0m"

PROTECTED_PROJECTS=(
  "testgebackupandrestorev2"
  "ancient-sandbox-322523"
)

PROJECT_ID=""
FORCE=false

usage() {
  cat << 'EOF'
Usage: teardown-test-env.sh -p <PROJECT_ID> [options]

Options:
  -p, --project-id <ID>    GCP Project ID to delete.
  -f, --force              Skip interactive confirmation prompt.
  -h, --help               Show this help message.

Protected Projects (CAN NEVER BE DELETED BY THIS SCRIPT):
  - testgebackupandrestorev2
  - ancient-sandbox-322523
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case $1 in
    -p|--project-id)
      PROJECT_ID="$2"
      shift 2
      ;;
    -f|--force)
      FORCE=true
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

if [[ -z "${PROJECT_ID}" ]]; then
  echo -e "${RED}Error: Missing required --project-id argument.${NC}"
  usage
fi

# Check protection list
for prot in "${PROTECTED_PROJECTS[@]}"; do
  if [[ "${PROJECT_ID}" == "${prot}" ]]; then
    echo -e "${RED}${BOLD}CRITICAL SAFETY VIOLATION:${NC} Project '${PROJECT_ID}' is protected and CANNOT be deleted."
    exit 1
  fi
done

echo -e "${CYAN}======================================================================${NC}"
echo -e "${BOLD}${RED}⚠️  Gemini Enterprise Test Environment Teardown${NC}"
echo -e "${CYAN}======================================================================${NC}"
echo -e "Target Project for Deletion: ${BOLD}${RED}${PROJECT_ID}${NC}"
echo -e "${CYAN}----------------------------------------------------------------------${NC}"

if [[ "${FORCE}" == "false" ]]; then
  echo -e "${YELLOW}WARNING: Deleting a project permanently destroys all resources, engines, and data inside it.${NC}"
  echo -n "Type the project ID to confirm deletion: "
  read -r CONFIRMATION
  if [[ "${CONFIRMATION}" != "${PROJECT_ID}" ]]; then
    echo -e "${RED}Confirmation mismatch. Teardown aborted.${NC}"
    exit 1
  fi
fi

echo -e "Deleting project ${BOLD}${PROJECT_ID}${NC}..."
gcloud projects delete "${PROJECT_ID}" --quiet
echo -e "${GREEN}✓ Project ${PROJECT_ID} scheduled for deletion.${NC}"

# Check if project is in migration-config.json and reset
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_PATH="${PROJECT_ROOT}/migration-config.json"

if [[ -f "${CONFIG_PATH}" ]]; then
  if grep -q "${PROJECT_ID}" "${CONFIG_PATH}"; then
    echo -e "Resetting reference to ${PROJECT_ID} in migration-config.json..."
    sed -i "s/${PROJECT_ID}/target-project-id/g" "${CONFIG_PATH}" || true
    echo -e "${GREEN}✓ migration-config.json updated.${NC}"
  fi
fi

echo -e "${GREEN}Teardown complete.${NC}"
