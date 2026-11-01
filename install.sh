#!/usr/bin/env bash
set -Eeuo pipefail

# Install the extension into the GNOME user extension directory and compile the schema so GNOME can load it.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
METADATA_PATH="${SCRIPT_DIR}/metadata.json"

if [[ ! -f "${METADATA_PATH}" ]]; then
    echo "[MultiWallpaper] metadata.json not found at ${METADATA_PATH}" >&2
    exit 1
fi

# Read the extension UUID from metadata.json so the install path matches the extension identity exactly.
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
mkdir -p "${TARGET_DIR}"

echo "[MultiWallpaper] Installing extension ${UUID} into ${TARGET_DIR}"

# Copy the project into GNOME’s extension directory, skipping installer scripts and local test assets.
find "${SCRIPT_DIR}" -mindepth 1 -maxdepth 1 \
    ! -name 'install.sh' \
    ! -name 'uninstall.sh' \
    ! -name 'tests' \
    -exec cp -a {} "${TARGET_DIR}/" \;

if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "${TARGET_DIR}/schemas"
else
    echo "[MultiWallpaper] Warning: glib-compile-schemas not found; schema may not be compiled." >&2
fi

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "${UUID}" 2>/dev/null || true
else
    echo "[MultiWallpaper] Warning: gnome-extensions command not found; enable the extension manually in GNOME Extensions." >&2
fi

echo "[MultiWallpaper] Install complete."
echo "[MultiWallpaper] To open preferences: gnome-extensions prefs ${UUID}"
echo "[MultiWallpaper] To verify: gnome-extensions list | grep ${UUID}"
