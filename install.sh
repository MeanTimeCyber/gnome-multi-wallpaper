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

# Check prerequisites before touching any existing install.
for required in extension.js prefs.js lib/wallpaperLogic.js schemas/org.gnome.shell.extensions.multiwallpaper.gschema.xml; do
    if [[ ! -f "${SCRIPT_DIR}/${required}" ]]; then
        echo "[MultiWallpaper] Missing project file: ${required}" >&2
        exit 1
    fi
done

if ! command -v glib-compile-schemas >/dev/null 2>&1; then
    echo "[MultiWallpaper] glib-compile-schemas is required to compile the GSettings schema." >&2
    exit 1
fi

TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
STAGE_DIR="${TARGET_DIR}.staging"
trap 'rm -rf "${STAGE_DIR}"' EXIT

echo "[MultiWallpaper] Installing extension ${UUID} into ${TARGET_DIR}"

# Stage the copy so a failed copy never replaces a working install.
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}"

# Copy the project, skipping installer scripts, tests, and VCS metadata.
find "${SCRIPT_DIR}" -mindepth 1 -maxdepth 1 \
    ! -name 'install.sh' \
    ! -name 'uninstall.sh' \
    ! -name 'tests' \
    ! -name '.git' \
    -exec cp -a {} "${STAGE_DIR}/" \;

# Compile the schema in the staged copy; GNOME cannot load settings without it.
glib-compile-schemas "${STAGE_DIR}/schemas"

# Replace the old install only after the staged copy is complete.
rm -rf "${TARGET_DIR}"
mv "${STAGE_DIR}" "${TARGET_DIR}"

if command -v gnome-extensions >/dev/null 2>&1; then
    if ! gnome-extensions enable "${UUID}" 2>/dev/null; then
        echo "[MultiWallpaper] Warning: could not enable ${UUID} yet. Restart GNOME Shell (see below), then enable it." >&2
    fi
else
    echo "[MultiWallpaper] Warning: gnome-extensions not found; enable the extension manually in Extensions." >&2
fi

echo "[MultiWallpaper] Install complete."
echo "[MultiWallpaper] If the extension is not listed, restart GNOME Shell: log out and back in on Wayland, or press Alt+F2, type r, and press Enter on X11."
echo "[MultiWallpaper] Preferences: gnome-extensions prefs ${UUID}"
echo "[MultiWallpaper] Logs: journalctl --user -f | grep MultiWallpaper"
