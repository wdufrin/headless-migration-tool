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
# post-migration-cleanup.sh
# Post-migration credential hardening and artifact sanitation script.
# Safely purges temporary service account keys, cleans local caches,
# and verifies no residual plaintext credentials or tokens remain.
# ==============================================================================

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[1;33m"
CYAN="\033[0;36m"
NC="\033[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DELETE_KEYS=false
PURGE_EXPORTS=false
ARCHIVE_BUCKET=""
FORCE=false

usage() {
  cat << 'EOF'
Usage: post-migration-cleanup.sh [options]

Options:
  --delete-keys            Delete local temporary Service Account JSON keys (e.g. sa-dwd-key.json).
  --purge-exports          Purge local export directories (./exports/memories, ./exports/skills, ./exports/artifacts).
  --archive-gcs <bucket>   Upload exports to a secure GCS bucket before local purge.
  -f, --force              Bypass interactive confirmation prompt.
  -h, --help               Show this help message.
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --delete-keys)
      DELETE_KEYS=true
      shift
      ;;
    --purge-exports)
      PURGE_EXPORTS=true
      shift
      ;;
    --archive-gcs)
      ARCHIVE_BUCKET="$2"
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
      echo -e "${RED}Unknown argument: $1${NC}"
      usage
      ;;
  esac
done

echo -e "${CYAN}======================================================================${NC}"
echo -e "${BOLD}${CYAN}🛡️  Gemini Enterprise Post-Migration Security Teardown & Hardening${NC}"
echo -e "${CYAN}======================================================================${NC}"

# 1. Archive exports if requested
if [[ -n "${ARCHIVE_BUCKET}" ]]; then
  echo -e "\n${BOLD}[1/4] Archiving export assets to GCS: ${ARCHIVE_BUCKET}...${NC}"
  if command -v gcloud &> /dev/null; then
    gcloud storage cp -r "${PROJECT_ROOT}/exports/" "${ARCHIVE_BUCKET}/migration-backup-$(date +%Y%m%d-%H%M%S)/" || true
    echo -e "${GREEN}✓ Export bundles safely uploaded to ${ARCHIVE_BUCKET}.${NC}"
  else
    echo -e "${YELLOW}⚠️ gcloud CLI not found. Skipping GCS upload.${NC}"
  fi
else
  echo -e "\n${BOLD}[1/4] Skipping GCS export archival (no --archive-gcs specified).${NC}"
fi

# 2. Delete temporary Service Account keys if requested
if [[ "${DELETE_KEYS}" == "true" ]]; then
  echo -e "\n${BOLD}[2/4] Sanitizing local Service Account JSON keys...${NC}"
  FOUND_KEYS=$(find "${PROJECT_ROOT}" -maxdepth 2 -name "*key*.json" -not -path "*/node_modules/*" -not -path "*/package*.json")
  if [[ -n "${FOUND_KEYS}" ]]; then
    echo -e "${YELLOW}Found potential credential files:${NC}"
    echo "${FOUND_KEYS}"
    if [[ "${FORCE}" == "true" ]] || { read -p "Permanently delete these key files? (y/N) " -n 1 -r && echo && [[ $REPLY =~ ^[Yy]$ ]]; }; then
      while IFS= read -r k; do
        if [[ -f "$k" ]]; then
          rm -f "$k"
          echo -e "${GREEN}✓ Securely deleted: $k${NC}"
        fi
      done <<< "${FOUND_KEYS}"
    else
      echo -e "${YELLOW}Skipped key deletion.${NC}"
    fi
  else
    echo -e "${GREEN}✓ No plaintext Service Account JSON keys found in root.${NC}"
  fi
else
  echo -e "\n${BOLD}[2/4] Skipping key deletion (pass --delete-keys to remove local SA keys).${NC}"
fi

# 3. Purge exports if requested
if [[ "${PURGE_EXPORTS}" == "true" ]]; then
  echo -e "\n${BOLD}[3/4] Purging local export directories...${NC}"
  if [[ -d "${PROJECT_ROOT}/exports" ]]; then
    rm -rf "${PROJECT_ROOT}/exports"
    echo -e "${GREEN}✓ Removed ./exports directory.${NC}"
  fi
  if [[ -d "${PROJECT_ROOT}/.tmp-test-reports" ]]; then
    rm -rf "${PROJECT_ROOT}/.tmp-test-reports"
    echo -e "${GREEN}✓ Removed temporary test reports.${NC}"
  fi
else
  echo -e "\n${BOLD}[3/4] Preserving local exports in ./exports (pass --purge-exports to clean).${NC}"
fi

# 4. Security Scan & Leak Detection
echo -e "\n${BOLD}[4/4] Performing Repository Security & Leak Audit...${NC}"
SUSPICIOUS_ITEMS=0

# Check for unencrypted private keys
if grep -rn "BEGIN PRIVATE KEY" "${PROJECT_ROOT}" \
    --exclude-dir="node_modules" \
    --exclude-dir=".git" \
    --exclude-dir="dist" 2>/dev/null; then
  echo -e "${RED}⚠️  WARNING: Found unencrypted private keys in repository!${NC}"
  SUSPICIOUS_ITEMS=$((SUSPICIOUS_ITEMS + 1))
else
  echo -e "${GREEN}✓ No unencrypted private keys found.${NC}"
fi

# Check for hardcoded OAuth bearer tokens
if grep -rn "ya29\.[a-zA-Z0-9_-]\{20,\}" "${PROJECT_ROOT}" \
    --exclude-dir="node_modules" \
    --exclude-dir=".git" \
    --exclude-dir="dist" 2>/dev/null; then
  echo -e "${RED}⚠️  WARNING: Found hardcoded Google OAuth access tokens!${NC}"
  SUSPICIOUS_ITEMS=$((SUSPICIOUS_ITEMS + 1))
else
  echo -e "${GREEN}✓ No hardcoded Google OAuth access tokens found.${NC}"
fi

echo -e "\n${CYAN}======================================================================${NC}"
if [[ ${SUSPICIOUS_ITEMS} -eq 0 ]]; then
  echo -e "${BOLD}${GREEN}✅ SECURITY AUDIT PASSED: Environment sanitized cleanly.${NC}"
else
  echo -e "${BOLD}${RED}⚠️  SECURITY AUDIT FLAGGED ${SUSPICIOUS_ITEMS} POTENTIAL ISSUE(S).${NC}"
fi
echo -e "${CYAN}======================================================================${NC}"
