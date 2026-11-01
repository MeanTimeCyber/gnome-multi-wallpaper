#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
METADATA_PATH="${SCRIPT_DIR}/metadata.json"

if [[ ! -f "${METADATA_PATH}" ]]; then
    echo "[MultiWallpaper] metadata.json not found at ${METADATA_PATH}" >&2
    exit 1
fi

UUID="$(python3 - "${METADATA_PATH}" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    data = json.load(f)
print(data.get('uuid', ''))
PY
)"

if [[ -z "${UUID}" ]]; then
    echo "[MultiWallpaper] Could not determine extension UUID from metadata.json" >&2
    exit 1
fi

TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "${UUID}" 2>/dev/null || true
fi

if [[ -d "${TARGET_DIR}" ]]; then
    rm -rf "${TARGET_DIR}"
    echo "[MultiWallpaper] Removed extension directory: ${TARGET_DIR}"
else
    echo "[MultiWallpaper] Extension directory not found: ${TARGET_DIR}"
fi

echo "[MultiWallpaper] Uninstall complete."
