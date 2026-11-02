# Multi Wallpaper

A GNOME Shell extension for GNOME 50 and 51 that scans a selected folder recursively, reads JPG/PNG/WebP image dimensions, and assigns wallpapers to logical monitors based on screen orientation.

> **Warning: vibecoded and lightly tested.** This extension was largely generated with AI assistance. It has only been tested on a single system (one GNOME setup and one hardware configuration). Expect bugs, review the code before use, and do not rely on it for anything critical. Use at your own risk.

## Why
Whilst there are some good wallpaper managers for GNOME, none I could find deal with a monitor in portrait mode. So I had LLMs build me one. For details on how, see [the process notes](./process.md).

## Features

- Folder picker in the preferences dialog, limited to folders inside your home directory
- Falls back to a default wallpaper folder if the chosen folder is invalid
- Recursive scan of JPG, JPEG, PNG, and WebP files
- Cached image index so rescans of large folders are faster
- Very large PNG and WebP files are skipped to avoid slow decoding on the Shell main loop
- Landscape and portrait statistics in preferences
- Logical monitor count, with mirrored displays treated as one screen
- Preferred orientation matching per screen, with fallback to the opposite orientation
- Larger, better-fitting images are preferred
- Automatic wallpaper rotation once every 24 hours from the last change
- Manual "Change now" action in preferences; changing the folder also rotates immediately
- Rebuilds the composite after monitor changes and after unlocking the lock screen, so the layout matches the displays again

## Requirements

- GNOME Shell 50 or 51
- `glib-compile-schemas` (usually provided by `glib2` / `libglib2.0-dev-bin`)
- `python3` (used by the install scripts to read `metadata.json`)

## Install

1. Run the installer from this folder:
   `./install.sh`
   It copies the extension to `~/.local/share/gnome-shell/extensions/multi-wallpaper@meantimecyber`, compiles the GSettings schema, and tries to enable it.
2. If the extension does not appear, restart GNOME Shell (log out and back in on Wayland, or press Alt+F2, type `r`, and press Enter on X11).
3. Open preferences with `gnome-extensions prefs multi-wallpaper@meantimecyber`.

## Uninstall

Run `./uninstall.sh` from this folder.

## Troubleshooting

View logs with:
`journalctl --user -f | grep MultiWallpaper`

## Notes

The extension uses stable GNOME Shell APIs for settings, folder scans, and image metadata. The per-monitor wallpaper application path is isolated in a helper so it can be adjusted to the exact Shell background API used by the target GNOME release while keeping the selection logic consistent.
