const { GdkPixbuf, Gio, GLib } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.multiwallpaper';
const DEFAULT_ROTATION_SECONDS = 24 * 60 * 60;
const DEFAULT_PICTURES_DIR = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || `${GLib.get_home_dir()}/Pictures`;

function logInfo(message) {
    log(`[MultiWallpaper] ${message}`);
}

function getSettings() {
    return ExtensionUtils.getSettings(SETTINGS_SCHEMA);
}

function getDefaultWallpaperFolder() {
    return DEFAULT_PICTURES_DIR;
}

function getFolderPathForSettings() {
    const settings = getSettings();
    const configured = settings.get_string('wallpaper-folder');
    return configured && configured.trim() ? configured : getDefaultWallpaperFolder();
}

function isSupportedImageName(name) {
    if (!name)
        return false;

    const lower = name.toLowerCase();
    return lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
}

function readWallpaperEntry(file) {
    const path = file.get_path();
    if (!path)
        return null;

    try {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
        const width = pixbuf.get_width();
        const height = pixbuf.get_height();
        const orientation = height > width ? 'portrait' : 'landscape';

        return {
            path,
            width,
            height,
            orientation,
            aspectRatio: width / height,
            area: width * height,
        };
    } catch (error) {
        logInfo(`Skipping unreadable image: ${path} (${error.message})`);
        return null;
    }
}

function collectWallpaperEntries(folderPath) {
    const wallpaperEntries = [];
    const folder = Gio.File.new_for_path(folderPath);

    if (!folder.query_exists(null))
        return wallpaperEntries;

    const stack = [folder];

    while (stack.length > 0) {
        const current = stack.pop();
        let enumerator = null;

        try {
            enumerator = current.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        } catch (error) {
            logInfo(`Could not read folder: ${current.get_path()} (${error.message})`);
            continue;
        }

        let info = null;
        while ((info = enumerator.next_file(null)) !== null) {
            const fileType = info.get_file_type();
            const name = info.get_name();

            if (fileType === Gio.FileType.DIRECTORY) {
                stack.push(current.get_child(name));
                continue;
            }

            if (fileType !== Gio.FileType.REGULAR || !isSupportedImageName(name))
                continue;

            const child = current.get_child(name);
            const entry = readWallpaperEntry(child);
            if (entry)
                wallpaperEntries.push(entry);
        }
    }

    return wallpaperEntries;
}

function getLogicalScreens() {
    const monitors = Main.layoutManager && Main.layoutManager.monitors ? Main.layoutManager.monitors : [];
    const groups = [];

    for (const monitor of monitors) {
        const width = monitor.width || 0;
        const height = monitor.height || 0;
        const x = monitor.x || 0;
        const y = monitor.y || 0;
        const geometryKey = `${x}:${y}:${width}:${height}`;

        if (groups.some(group => group.geometryKey === geometryKey))
            continue;

        groups.push({
            id: groups.length,
            x,
            y,
            width,
            height,
            orientation: height > width ? 'portrait' : 'landscape',
            geometryKey,
        });
    }

    return groups;
}

function scoreWallpaperForScreen(screen, candidate) {
    const orientationScore = screen.orientation === candidate.orientation ? 1000000 : 0;
    const ratioDifference = Math.abs((candidate.width / candidate.height) - (screen.width / screen.height));
    const sizeScore = candidate.area;

    return orientationScore + sizeScore - (ratioDifference * 1000);
}

function chooseWallpaperAssignments(screenList, wallpaperEntries) {
    const assignments = [];
    const allCards = [...wallpaperEntries];
    const used = new Set();

    for (const screen of screenList) {
        let pool = allCards.filter(entry => entry.orientation === screen.orientation);

        if (pool.length === 0)
            pool = allCards.filter(entry => entry.orientation !== screen.orientation);

        if (pool.length === 0)
            pool = allCards;

        const usablePool = pool.filter(entry => !used.has(entry.path));
        const orderedPool = usablePool.length > 0 ? usablePool : pool;

        orderedPool.sort((a, b) => scoreWallpaperForScreen(screen, b) - scoreWallpaperForScreen(screen, a));

        const selected = orderedPool[0];
        if (selected) {
            assignments.push({
                screen,
                path: selected.path,
                orientation: selected.orientation,
            });
            used.add(selected.path);
        }
    }

    return assignments;
}

function applyWallpaperAssignments(assignments) {
    if (!assignments || assignments.length === 0)
        return;

    const settings = new Gio.Settings({ schema: 'org.gnome.desktop.background' });
    const primaryAssignment = assignments[0];
    const fileUri = `file://${primaryAssignment.path}`;

    settings.set_string('picture-uri', fileUri);
    settings.set_string('picture-uri-dark', fileUri);
    settings.set_boolean('draw-background', true);

    const backgroundManager = Main.backgroundManager;
    if (backgroundManager && backgroundManager._backgrounds) { 
        const monitors = Main.layoutManager && Main.layoutManager.monitors ? Main.layoutManager.monitors : [];
        for (let i = 0; i < monitors.length; i++) {
            const match = assignments.find(entry => entry.screen.id === i);
            if (!match)
                continue;

            const background = backgroundManager._backgrounds[i];
            if (background && typeof background.set_file === 'function') {
                background.set_file(Gio.File.new_for_path(match.path));
            }
        }
    }
}

function refreshWallpaperState() {
    const folderPath = getFolderPathForSettings();
    const wallpapers = collectWallpaperEntries(folderPath);
    const screens = getLogicalScreens();
    const assignments = chooseWallpaperAssignments(screens, wallpapers);
    applyWallpaperAssignments(assignments);

    return {
        folderPath,
        totalWallpapers: wallpapers.length,
        landscapeCount: wallpapers.filter(entry => entry.orientation === 'landscape').length,
        portraitCount: wallpapers.filter(entry => entry.orientation === 'portrait').length,
        screenCount: screens.length,
        landscapeScreens: screens.filter(screen => screen.orientation === 'landscape').length,
        portraitScreens: screens.filter(screen => screen.orientation === 'portrait').length,
        assignments,
    };
}

class MultiWallpaperExtension {
    constructor() {
        this._settings = null;
        this._timerId = 0;
    }

    enable() {
        this._settings = getSettings();
        this._settings.connect('changed::wallpaper-folder', () => {
            this._scheduleNextCheck();
            refreshWallpaperState();
        });

        this._scheduleNextCheck();
        refreshWallpaperState();
    }

    disable() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }

        this._settings = null;
    }

    _scheduleNextCheck() {
        if (this._timerId)
            GLib.Source.remove(this._timerId);

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._checkRotation();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _checkRotation() {
        const lastTimestamp = this._settings.get_int64('last-change-timestamp');
        const nowSeconds = Math.floor(Date.now() / 1000);

        if (lastTimestamp === 0 || nowSeconds - lastTimestamp >= DEFAULT_ROTATION_SECONDS) {
            refreshWallpaperState();
            this._settings.set_int64('last-change-timestamp', nowSeconds);
        }

        return GLib.SOURCE_CONTINUE;
    }
}

function init() {
    return new MultiWallpaperExtension();
}
