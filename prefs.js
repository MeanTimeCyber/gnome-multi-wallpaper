// Preferences window for Multi Wallpaper. Runs in the GNOME Settings process, not in the Shell.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    resolveFolder,
    validateFolder,
    startScan,
    summarizeEntries,
    getLogicalScreens,
    summarizeScreens,
    startRotation,
    logError,
} from './lib/wallpaperLogic.js';

// Read connected monitors from GDK; the Shell's layout manager is not available in this process.
function readMonitors() {
    const display = Gdk.Display.get_default();
    if (!display)
        return [];

    const list = display.get_monitors();
    const monitors = [];
    for (let i = 0; i < list.get_n_items(); i++) {
        const monitor = list.get_item(i);
        if (!monitor)
            continue;
        const geometry = monitor.get_geometry();
        monitors.push({x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height});
    }
    return monitors;
}

function formatTimestamp(seconds) {
    if (!seconds)
        return 'Never';
    const dateTime = GLib.DateTime.new_from_unix_local(seconds);
    return dateTime ? dateTime.format('%Y-%m-%d %H:%M') : 'Unknown';
}

export default class MultiWallpaperPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        // Folder selection. The chosen path is validated before it is saved.
        const folderGroup = new Adw.PreferencesGroup({
            title: 'Wallpaper folder',
            description: 'Images are searched recursively. Only PNG and JPG files are used.',
        });
        const folderRow = new Adw.ActionRow({title: 'Folder', useMarkup: false});
        const chooseButton = new Gtk.Button({label: 'Choose…', valign: Gtk.Align.CENTER});
        folderRow.add_suffix(chooseButton);
        folderRow.set_activatable_widget(chooseButton);

        const noticeRow = new Adw.ActionRow({title: '', useMarkup: false, visible: false});
        folderGroup.add(folderRow);
        folderGroup.add(noticeRow);
        page.add(folderGroup);

        // Library and display statistics, refreshed whenever the folder changes.
        const statsGroup = new Adw.PreferencesGroup({title: 'Library'});
        const imagesRow = new Adw.ActionRow({title: 'Images', useMarkup: false});
        const screensRow = new Adw.ActionRow({title: 'Displays', useMarkup: false});
        const lastRow = new Adw.ActionRow({title: 'Last change', useMarkup: false});
        statsGroup.add(imagesRow);
        statsGroup.add(screensRow);
        statsGroup.add(lastRow);
        page.add(statsGroup);

        // Manual rotation.
        const actionGroup = new Adw.PreferencesGroup({title: 'Actions'});
        const changeRow = new Adw.ActionRow({
            title: 'Change wallpaper now',
            subtitle: 'Picks new images immediately. The 24-hour timer restarts after a successful change.',
            useMarkup: false,
        });
        const changeButton = new Gtk.Button({label: 'Change now', valign: Gtk.Align.CENTER});
        changeRow.add_suffix(changeButton);
        changeRow.set_activatable_widget(changeButton);
        actionGroup.add(changeRow);
        page.add(actionGroup);

        window.add(page);

        // Cancel handles for work in flight; both are called when the window closes.
        let cancelScan = () => {};
        let cancelRotation = () => {};

        const updateRows = () => {
            const resolved = resolveFolder(settings.get_string('wallpaper-folder'));
            folderRow.set_subtitle(resolved.path ?? 'No usable folder');

            noticeRow.set_visible(Boolean(resolved.notice));
            if (resolved.notice)
                noticeRow.set_title(resolved.notice);

            cancelScan();
            if (resolved.path) {
                imagesRow.set_subtitle('Scanning…');
                cancelScan = startScan(resolved.path, ({entries, stats, error}) => {
                    cancelScan = () => {};
                    if (error) {
                        imagesRow.set_subtitle('Scan failed');
                        return;
                    }

                    const counts = summarizeEntries(entries);
                    let text = `${counts.total} total: ${counts.landscape} landscape, ${counts.portrait} portrait`;
                    if (stats.skipped > 0)
                        text += `, ${stats.skipped} skipped`;
                    if (stats.truncated)
                        text += ' (scan limit reached)';
                    imagesRow.set_subtitle(text);
                });
            } else {
                imagesRow.set_subtitle('No folder');
            }

            const screens = summarizeScreens(getLogicalScreens(readMonitors()));
            screensRow.set_subtitle(
                `${screens.total} display(s): ${screens.landscape} landscape, ${screens.portrait} portrait`);
            lastRow.set_subtitle(formatTimestamp(settings.get_int64('last-change-timestamp')));
        };

        // A failed refresh is logged rather than thrown into the GTK signal handler.
        const refresh = () => {
            try {
                updateRows();
            } catch (error) {
                logError('Could not refresh preferences', error.message);
            }
        };

        chooseButton.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Choose wallpaper folder', modal: true});
            const current = resolveFolder(settings.get_string('wallpaper-folder')).path;
            if (current)
                dialog.set_initial_folder(Gio.File.new_for_path(current));

            dialog.select_folder(window, null, (source, asyncResult) => {
                let file = null;
                try {
                    file = source.select_folder_finish(asyncResult);
                } catch (error) {
                    // Cancelling the dialog is normal; any other failure is reported to the user.
                    const dismissed = typeof error.matches === 'function' &&
                        error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED);
                    if (!dismissed) {
                        logError('Folder dialog failed', error.message);
                        window.add_toast(new Adw.Toast({title: 'Could not open the folder chooser.'}));
                    }
                    return;
                }
                if (!file)
                    return;

                const path = file.get_path();
                if (!path) {
                    window.add_toast(new Adw.Toast({title: 'Only local folders can be used.'}));
                    return;
                }

                const check = validateFolder(path);
                if (!check.ok) {
                    window.add_toast(new Adw.Toast({title: check.reason}));
                    return;
                }

                if (!settings.set_string('wallpaper-folder', check.path)) {
                    logError('Could not save folder setting', check.path);
                    window.add_toast(new Adw.Toast({title: 'Could not save the folder.'}));
                    return;
                }
                refresh();
            });
        });

        changeButton.connect('clicked', () => {
            // Disabled while running so a second click cannot start an overlapping rotation.
            changeButton.set_sensitive(false);
            cancelRotation = startRotation(settings, readMonitors, outcome => {
                cancelRotation = () => {};
                changeButton.set_sensitive(true);
                const title = outcome.status === 'applied' ? 'Wallpaper changed.' : outcome.message;
                window.add_toast(new Adw.Toast({title}));
                refresh();
            });
        });

        // Disconnect the settings handler and stop background work when the window closes.
        const changedId = settings.connect('changed::wallpaper-folder', () => refresh());
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            cancelScan();
            cancelRotation();
            return false;
        });

        refresh();
    }
}
