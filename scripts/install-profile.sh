#!/usr/bin/env bash

set -euo pipefail

SOURCE_ENV="${1:-}"
DEFAULTS_FILE="${2:-}"
TARGET_ENV="${3:-}"

if [[ -z "${SOURCE_ENV}" || -z "${DEFAULTS_FILE}" || -z "${TARGET_ENV}" ]]; then
  echo "Usage: $0 <source-env> <profile-defaults> <target-env>" >&2
  exit 1
fi

if [[ ! -f "${SOURCE_ENV}" ]]; then
  echo "Source environment file not found: ${SOURCE_ENV}" >&2
  exit 1
fi

if [[ ! -f "${DEFAULTS_FILE}" ]]; then
  echo "Profile defaults file not found: ${DEFAULTS_FILE}" >&2
  exit 1
fi

mkdir -p "$(dirname "${TARGET_ENV}")"
working_file="$(mktemp "${TARGET_ENV}.tmp.XXXXXX")"
next_file="${working_file}.next"
trap 'rm -f "${working_file}" "${next_file}"' EXIT
cp "${SOURCE_ENV}" "${working_file}"

while IFS= read -r line || [[ -n "${line}" ]]; do
  [[ -z "${line}" || "${line}" == \#* ]] && continue

  key="${line%%=*}"
  if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Invalid environment key in ${DEFAULTS_FILE}: ${key}" >&2
    exit 1
  fi

  awk -v key="${key}" -v replacement="${line}" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 {
      if (!found) print replacement
      found = 1
      next
    }
    { print }
    END { if (!found) print replacement }
  ' "${working_file}" > "${next_file}"
  mv "${next_file}" "${working_file}"
done < "${DEFAULTS_FILE}"

chmod 600 "${working_file}"
mv "${working_file}" "${TARGET_ENV}"
trap - EXIT

echo "Installed profile: ${TARGET_ENV}"
