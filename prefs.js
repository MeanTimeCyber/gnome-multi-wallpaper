const { Adw, Gio, GLib, Gtk } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;
const Me = ExtensionUtils.getCurrentExtension();

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.multiwallpaper';
const DEFAULT_PICTURES_DIR = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || `${GLib.get_home_dir()}/Pictures`;

function logInfo(message, detail = null) {
    const suffix = detail ? `: ${detail}` : '';
    log(`[MultiWallpaper] ${message}${suffix}`);
}

function getSettings() {
    try {
        return ExtensionUtils.getSettings(SETTINGS_SCHEMA);
    } catch (error) {
        logInfo('Failed to read preferences settings', error && error.message ? error.message : String(error));
        return null;
    }
}

function isPathInsideUserHome(path) {
    if (!path || typeof path !== 'string')
        return false;

    const homeDir = GLib.get_home_dir();
    if (!homeDir)
        return false;

    const trimmed = path.trim();
    return trimmed === homeDir || trimmed.startsWith(`${homeDir}/`);
}

function getConfiguredFolder(settings) {
    if (!settings)
        return DEFAULT_PICTURES_DIR;

    try {
        const folder = settings.get_string('wallpaper-folder');
        if (folder && folder.trim())
            return folder;
    } catch (error) {
        logInfo('Unable to read wallpaper-folder setting', error && error.message ? error.message : String(error));
    }

    return DEFAULT_PICTURES_DIR;
}

function getLogicalScreenSummary() {
    const layoutManager = Main && Main.layoutManager ? Main.layoutManager : null;
    const monitors = layoutManager && layoutManager.monitors ? layoutManager.monitors : [];

    if (!Array.isArray(monitors) || monitors.length === 0)
        return { total: 1, landscape: 1, portrait: 0 };

    const groups = [];
    for (let i = 0; i < monitors.length; i++) {
        const monitor = monitors[i];
        if (!monitor)
            continue;

        const width = Number(monitor.width) || 0;
        const height = Number(monitor.height) || 0;
        if (width <= 0 || height <= 0)
            continue;

        const duplicate = groups.some(group =>
            Math.abs(group.width - width) < 2 &&
            Math.abs(group.height - height) < 2 &&
            Math.abs(group.x - Number(monitor.x || 0)) < 2 &&
            Math.abs(group.y - Number(monitor.y || 0)) < 2
        );

        if (!duplicate)
            groups.push({ width, height, x: Number(monitor.x || 0), y: Number(monitor.y || 0) });
    }

    if (groups.length === 0)
        return { total: 1, landscape: 1, portrait: 0 };

    const landscape = groups.filter(group => group.height <= group.width).length;
    const portrait = groups.length - landscape;
    return { total: groups.length, landscape, portrait };
}

function isSupportedImageName(name) {
    if (!name || typeof name !== 'string')
        return false;

    const lower = name.toLowerCase();
    return lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
}

function readImageStats(path) {
    try {
        const pixbuf = imports.gi.GdkPixbuf.Pixbuf.new_from_file(path);
        const width = pixbuf.get_width();
        const height = pixbuf.get_height();

        if (width <= 0 || height <= 0)
            return null;

        return {
            width,
            height,
            orientation: height > width ? 'portrait' : 'landscape',
        };
    } catch (error) {
        logInfo('Unable to read image stats', `${path} (${error && error.message ? error.message : String(error)})`);
        return null;
    }
}

function collectWallpaperStats(folderPath) {
    const results = {
        total: 0,
        landscape: 0,
        portrait: 0,
    };

    const folder = folderPath ? Gio.File.new_for_path(folderPath) : null;
    if (!folder || !folder.query_exists(null)) {
        return results;
    }

    const stack = [folder];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current)
            continue;

        let enumerator = null;
        try {
            enumerator = current.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        } catch (error) {
            continue;
        }

        let info = null;
        while ((info = enumerator.next_file(null)) !== null) {
            const type = info.get_file_type();
            const name = info.get_name();

            if (type === Gio.FileType.DIRECTORY) {
                const child = current.get_child(name);
                if (child)
                    stack.push(child);
                continue;
            }

            if (type !== Gio.FileType.REGULAR || !isSupportedImageName(name))
                continue;

            const file = current.get_child(name);
            const fullPath = file ? file.get_path() : null;
            if (!fullPath)
                continue;

            const imageStats = readImageStats(fullPath);
            if (!imageStats)
                continue;

            results.total += 1;
            if (imageStats.orientation === 'landscape')
                results.landscape += 1;
            else
                results.portrait += 1;
        }
    }

    return results;
}

function getFolderHealth(folderPath) {
    if (!folderPath || !folderPath.trim())
        return { valid: false, message: 'No folder selected yet; using your Pictures directory.' };

    const folder = Gio.File.new_for_path(folderPath);
    if (!folder.query_exists(null))
        return { valid: false, message: 'Selected folder does not exist. Please choose a valid directory.' };

    const stats = collectWallpaperStats(folderPath);
    if (stats.total === 0)
        return { valid: true, message: 'No valid PNG/JPG wallpapers were found in this folder.' };

    return { valid: true, message: 'Folder is valid and contains usable wallpapers.' };
}

function buildPrefsWidget() {
    const settings = getSettings();
    const prefs = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({ title: 'Wallpaper settings' });
    prefs.add(group);

    const folderRow = new Adw.ActionRow({ title: 'Wallpaper folder' });
    const folderButton = new Gtk.Button({ label: 'Choose folder', halign: Gtk.Align.END, valign: Gtk.Align.CENTER });

    folderButton.connect('clicked', () => {
        const dialog = new Gtk.FileChooserNative({
            title: 'Select wallpaper folder',
            action: Gtk.FileChooserAction.SELECT_FOLDER,
            modal: true,
        });

        const baseFolder = getConfiguredFolder(settings) || DEFAULT_PICTURES_DIR;
        const currentFolder = Gio.File.new_for_path(baseFolder);
        if (currentFolder.query_exists(null))
            dialog.set_current_folder(currentFolder);

        dialog.connect('response', (widget, response) => {
            if (response === Gtk.ResponseType.ACCEPT) {
                const folder = widget.get_file();
                if (folder) {
                    const chosenPath = folder.get_path();
                    if (chosenPath && chosenPath.trim()) {
                        settings.set_string('wallpaper-folder', chosenPath);
                    }
                }
            }
            widget.destroy();
            refreshStats();
        });

        dialog.show();
    });

    folderRow.add_suffix(folderButton);
    group.add(folderRow);

    const statsRow = new Adw.ActionRow({ title: 'Wallpaper stats' });
    const statsLabel = new Gtk.Label({
        xalign: 0,
        justify: Gtk.Justification.LEFT,
        selectable: true,
        wrap: true,
        hexpand: true,
        margin_top: 10,
        margin_bottom: 10,
    });
    statsRow.add_suffix(statsLabel);
    group.add(statsRow);

    const screenSummaryRow = new Adw.ActionRow({ title: 'Screen layout' });
    const screenSummaryLabel = new Gtk.Label({
        xalign: 0,
        justify: Gtk.Justification.LEFT,
        selectable: true,
        wrap: true,
        hexpand: true,
        margin_top: 10,
        margin_bottom: 10,
    });
    screenSummaryRow.add_suffix(screenSummaryLabel);
    group.add(screenSummaryRow);

    const statusRow = new Adw.ActionRow({ title: 'Status' });
    const statusLabel = new Gtk.Label({
        xalign: 0,
        justify: Gtk.Justification.LEFT,
        selectable: true,
        wrap: true,
        hexpand: true,
        margin_top: 10,
        margin_bottom: 10,
    });
    statusRow.add_suffix(statusLabel);
    group.add(statusRow);

    const changeNowButton = new Gtk.Button({ label: 'Change now', halign: Gtk.Align.END, valign: Gtk.Align.CENTER });
    changeNowButton.connect('clicked', () => {
        if (!settings)
            return;

        const folder = getConfiguredFolder(settings);
        const stats = collectWallpaperStats(folder);
        if (stats.total === 0) {
            statusLabel.set_text('No valid wallpapers are available to change. Please choose a folder containing PNG or JPG files.');
            return;
        }

        const nowSeconds = Math.floor(Date.now() / 1000);
        settings.set_int64('last-change-timestamp', nowSeconds - 24 * 60 * 60 - 1);
        refreshStats();
        logInfo('Manual refresh requested', `${stats.total} valid image(s) found`);
    });
    statsRow.add_suffix(changeNowButton);

    function refreshStats() {
        if (!settings) {
            statsLabel.set_text('Settings unavailable');
            screenSummaryLabel.set_text('Monitor state unavailable');
            statusLabel.set_text('The extension could not access GNOME settings.');
            changeNowButton.set_sensitive(false);
            return;
        }

        const folder = getConfiguredFolder(settings);
        const safeFolder = folder && folder.trim() ? folder : DEFAULT_PICTURES_DIR;

        if (!isPathInsideUserHome(safeFolder)) {
            statusLabel.set_text('Selected folder is outside your home directory. Only home-directory wallpaper scans are allowed for safety.');
            changeNowButton.set_sensitive(false);
            statsLabel.set_text(`Folder: ${safeFolder}\nFound: 0 images\nLandscape: 0\nPortrait: 0`);
            screenSummaryLabel.set_text('Monitor state unavailable');
            return;
        }

        const stats = collectWallpaperStats(safeFolder);
        const summary = getLogicalScreenSummary();
        const health = getFolderHealth(safeFolder);
        const hasWallpaper = stats.total > 0;

        statsLabel.set_text(
            `Folder: ${safeFolder}\n` +
            `Found: ${stats.total} images\n` +
            `Landscape: ${stats.landscape}\n` +
            `Portrait: ${stats.portrait}`
        );

        screenSummaryLabel.set_text(
            `Logical screens: ${summary.total}\n` +
            `Landscape screens: ${summary.landscape}\n` +
            `Portrait screens: ${summary.portrait}`
        );

        if (!health.valid) {
            statusLabel.set_text(`${health.message} Using the default Pictures folder instead.`);
        } else if (!hasWallpaper) {
            statusLabel.set_text('No valid PNG/JPG wallpapers were found. Add image files or pick another folder.');
        } else {
            statusLabel.set_text(`Ready: ${health.message}`);
        }

        changeNowButton.set_sensitive(hasWallpaper);
    }

    if (settings)
        settings.connect('changed::wallpaper-folder', refreshStats);

    refreshStats();
    return prefs;
}

function init() {
    ExtensionUtils.initTranslations(Me.uuid);
}

function fillPreferencesWindow(window) {
    window.add(buildPrefsWidget());
}
