#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_NAME="antigravity-vital"
PLUGINS_DIR="${HOME}/.gemini/config/plugins"
TARGET="${PLUGINS_DIR}/${PLUGIN_NAME}"

mkdir -p "${PLUGINS_DIR}"

if [ -L "${TARGET}" ]; then
  rm "${TARGET}"
elif [ -e "${TARGET}" ]; then
  echo "Error: ${TARGET} already exists and is not a symlink. Remove or move it first." >&2
  exit 1
fi

ln -s "${REPO_DIR}" "${TARGET}"
echo "Linked ${TARGET} -> ${REPO_DIR}"
echo "Antigravity will automatically discover the plugin under Customizations -> Plugins."
