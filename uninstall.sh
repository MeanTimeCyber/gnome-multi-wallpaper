#!/usr/bin/env bash
set -Eeuo pipefail

# Remove the installed extension and disable it in GNOME before deleting the extension directory.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
METADATA_PATH="${SCRIPT_DIR}/metadata.json"

if [[ ! -f "${METADATA_PATH}" ]]; then
    echo "[MultiWallpaper] metadata.json not found at ${METADATA_PATH}" >&2
    exit 1
fi

# Derive the extension UUID from metadata.json so the uninstall path matches the live install location.
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

# Disable first so GNOME unloads the extension before its files are removed.
if command -v gnome-extensions >/dev/null 2>&1; then
    if ! gnome-extensions disable "${UUID}" 2>/dev/null; then
        echo "[MultiWallpaper] Note: could not disable ${UUID}; it may not have been enabled." >&2
    fi
fi

if [[ -d "${TARGET_DIR}" ]]; then
    rm -rf "${TARGET_DIR}"
    echo "[MultiWallpaper] Removed extension directory: ${TARGET_DIR}"
else
    echo "[MultiWallpaper] Extension directory not found: ${TARGET_DIR}"
fi

echo "[MultiWallpaper] Uninstall complete."
echo "[MultiWallpaper] Unchanged: extension settings, the current desktop background, and composites in ~/.cache/multiwallpaper."
echo "[MultiWallpaper] Deleting the cached composite will blank the desktop background until a new wallpaper is set."
echo "[MultiWallpaper] To clear saved settings: gsettings reset-recursively org.gnome.shell.extensions.multiwallpaper"
