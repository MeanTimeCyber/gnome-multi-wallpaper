# Multi Wallpaper

A GNOME Shell extension for GNOME 50 and 51 that scans a selected folder recursively, inspects JPG/PNG images for dimensions and orientation, and assigns wallpapers to logical monitors.

## Features

- Folder picker in the preferences dialog
- Recursive wallpaper scan of JPG, JPEG, and PNG files
- Landscape and portrait statistics
- Logical monitor count with mirrored displays treated as one screen
- Preferred orientation matching per screen
- Fallback to opposite orientation when needed
- Bigger, better-fitting images are preferred
- Automatic wallpaper rotation once every 24 hours from the last change
- Manual "Change now" action from the preferences UI

## Install

1. Copy this folder to `~/.local/share/gnome-shell/extensions/multi-wallpaper@scott.local`
2. Compile the schema:
   `glib-compile-schemas ~/.local/share/gnome-shell/extensions/multi-wallpaper@scott.local/schemas`
3. Restart GNOME Shell or log out and back in
4. Enable the extension in GNOME Extensions

## Notes

The extension intentionally uses stable GNOME Shell APIs for settings, folder scans, and image metadata. The per-monitor wallpaper application path is isolated in a helper so it can be adjusted to the exact Shell background API used by the target GNOME release while keeping the selection logic consistent.
