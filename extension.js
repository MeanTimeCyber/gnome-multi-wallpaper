const { GdkPixbuf, Gio, GLib } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;

const LOG_PREFIX = '[MultiWallpaper]';
const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.multiwallpaper';
const DEFAULT_ROTATION_SECONDS = 24 * 60 * 60;
const DEFAULT_PICTURES_DIR = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || `${GLib.get_home_dir()}/Pictures`;

function logInfo(message, detail = null) {
    const suffix = detail ? `: ${detail}` : '';
    log(`${LOG_PREFIX} ${message}${suffix}`);
}

function getSettings() {
    try {
        return ExtensionUtils.getSettings(SETTINGS_SCHEMA);
    } catch (error) {
        logInfo('Failed to access extension settings', error && error.message ? error.message : String(error));
        return null;
    }
}

function getDefaultWallpaperFolder() {
    return DEFAULT_PICTURES_DIR;
}

function normalizeConfiguredFolder(folderPath) {
    if (!folderPath || typeof folderPath !== 'string')
        return getDefaultWallpaperFolder();

    const candidate = folderPath.trim();
    if (!candidate)
        return getDefaultWallpaperFolder();

    try {
        const file = Gio.File.new_for_path(candidate);
        if (file.query_exists(null))
            return candidate;
    } catch (error) {
        logInfo('Invalid wallpaper folder path', candidate);
    }

    logInfo('Configured wallpaper folder is missing; falling back to Pictures', candidate);
    return getDefaultWallpaperFolder();
}

function getFolderPathForSettings() {
    const settings = getSettings();
    if (!settings)
        return getDefaultWallpaperFolder();

    try {
        const configured = settings.get_string('wallpaper-folder');
        return normalizeConfiguredFolder(configured);
    } catch (error) {
        logInfo('Unable to read wallpaper-folder setting; using Pictures fallback', error && error.message ? error.message : String(error));
        return getDefaultWallpaperFolder();
    }
}

function setLastChangeTimestamp(timestampSeconds) {
    const settings = getSettings();
    if (!settings)
        return;

    try {
        settings.set_int64('last-change-timestamp', timestampSeconds);
    } catch (error) {
        logInfo('Failed to persist last-change-timestamp', error && error.message ? error.message : String(error));
    }
}

function isSupportedImageName(name) {
    if (!name || typeof name !== 'string')
        return false;

    const lower = name.toLowerCase();
    return lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
}

function readWallpaperEntry(file) {
    if (!file)
        return null;

    const path = file.get_path();
    if (!path)
        return null;

    try {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
        const width = pixbuf.get_width();
        const height = pixbuf.get_height();

        if (!width || !height || width <= 0 || height <= 0) {
            logInfo('Skipping image with invalid dimensions', path);
            return null;
        }

        return {
            path,
            width,
            height,
            orientation: height > width ? 'portrait' : 'landscape',
            aspectRatio: width / height,
            area: width * height,
        };
    } catch (error) {
        logInfo('Skipping unreadable image', `${path} (${error && error.message ? error.message : String(error)})`);
        return null;
    }
}

function collectWallpaperEntries(folderPath) {
    const wallpaperEntries = [];
    const finalFolderPath = normalizeConfiguredFolder(folderPath);
    const folder = Gio.File.new_for_path(finalFolderPath);

    if (!folder || !folder.query_exists(null)) {
        logInfo('Wallpaper directory not found', finalFolderPath);
        return wallpaperEntries;
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
            logInfo('Could not enumerate folder', `${current.get_path()} (${error && error.message ? error.message : String(error)})`);
            continue;
        }

        let info = null;
        while ((info = enumerator.next_file(null)) !== null) {
            const fileType = info.get_file_type();
            const name = info.get_name();

            if (fileType === Gio.FileType.DIRECTORY) {
                const child = current.get_child(name);
                if (child)
                    stack.push(child);
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

    logInfo('Wallpaper scan complete', `found ${wallpaperEntries.length} valid image(s) in ${finalFolderPath}`);
    return wallpaperEntries;
}

function getLogicalScreens() {
    const layoutManager = Main && Main.layoutManager ? Main.layoutManager : null;
    const monitors = layoutManager && layoutManager.monitors ? layoutManager.monitors : [];

    if (!Array.isArray(monitors) || monitors.length === 0) {
        logInfo('No monitor data found; using fallback single-screen layout');
        return [{ id: 0, x: 0, y: 0, width: 1920, height: 1080, orientation: 'landscape' }];
    }

    const groups = [];
    for (let i = 0; i < monitors.length; i++) {
        const monitor = monitors[i];
        if (!monitor)
            continue;

        const width = Number(monitor.width) || 0;
        const height = Number(monitor.height) || 0;
        const x = Number(monitor.x) || 0;
        const y = Number(monitor.y) || 0;

        if (width <= 0 || height <= 0) {
            logInfo('Ignoring monitor with invalid dimensions', `${width}x${height}`);
            continue;
        }

        const duplicate = groups.some(group =>
            Math.abs(group.width - width) < 2 &&
            Math.abs(group.height - height) < 2 &&
            Math.abs(group.x - x) < 2 &&
            Math.abs(group.y - y) < 2
        );

        if (duplicate)
            continue;

        groups.push({
            id: groups.length,
            x,
            y,
            width,
            height,
            orientation: height > width ? 'portrait' : 'landscape',
        });
    }

    if (groups.length === 0) {
        logInfo('Monitor list was empty after filtering; using fallback single-screen layout');
        return [{ id: 0, x: 0, y: 0, width: 1920, height: 1080, orientation: 'landscape' }];
    }

    return groups;
}

function scoreWallpaperForScreen(screen, candidate) {
    if (!screen || !candidate)
        return 0;

    const orientationScore = screen.orientation === candidate.orientation ? 1000000 : 0;
    const screenAspect = screen.width > 0 && screen.height > 0 ? screen.width / screen.height : 1;
    const candidateAspect = candidate.width > 0 && candidate.height > 0 ? candidate.width / candidate.height : 1;
    const ratioDifference = Math.abs(candidateAspect - screenAspect);
    const sizeScore = candidate.area || 0;

    return orientationScore + sizeScore - (ratioDifference * 1000);
}

function chooseWallpaperAssignments(screenList, wallpaperEntries) {
    if (!Array.isArray(screenList) || screenList.length === 0)
        return [];

    const validEntries = (wallpaperEntries || []).filter(entry => entry && typeof entry.path === 'string');
    const assignments = [];
    const usedPaths = new Set();

    for (let i = 0; i < screenList.length; i++) {
        const screen = screenList[i];
        if (!screen)
            continue;

        let pool = validEntries.filter(entry => entry.orientation === screen.orientation);
        if (pool.length === 0)
            pool = validEntries.filter(entry => entry.orientation !== screen.orientation);
        if (pool.length === 0)
            pool = validEntries;

        const usablePool = pool.filter(entry => !usedPaths.has(entry.path));
        const orderedPool = usablePool.length > 0 ? usablePool : pool;

        if (orderedPool.length === 0)
            continue;

        orderedPool.sort((a, b) => scoreWallpaperForScreen(screen, b) - scoreWallpaperForScreen(screen, a));

        const selected = orderedPool[0];
        if (!selected)
            continue;

        assignments.push({
            screen,
            path: selected.path,
            orientation: selected.orientation,
        });
        usedPaths.add(selected.path);
    }

    return assignments;
}

function applyWallpaperAssignments(assignments) {
    if (!Array.isArray(assignments) || assignments.length === 0) {
        logInfo('No wallpaper assignments to apply');
        return false;
    }

    try {
        const backgroundSettings = new Gio.Settings({ schema: 'org.gnome.desktop.background' });
        const primaryAssignment = assignments[0];
        const fileUri = `file://${primaryAssignment.path}`;

        backgroundSettings.set_string('picture-uri', fileUri);
        backgroundSettings.set_string('picture-uri-dark', fileUri);
        backgroundSettings.set_boolean('draw-background', true);
    } catch (error) {
        logInfo('Unable to update desktop background settings', error && error.message ? error.message : String(error));
    }

    const backgroundManager = Main && Main.backgroundManager ? Main.backgroundManager : null;
    if (backgroundManager && backgroundManager._backgrounds) {
        const backgrounds = backgroundManager._backgrounds;
        const monitors = Main.layoutManager && Main.layoutManager.monitors ? Main.layoutManager.monitors : [];

        for (let i = 0; i < monitors.length; i++) {
            const match = assignments.find(entry => entry.screen && entry.screen.id === i);
            if (!match)
                continue;

            const background = backgrounds[i];
            if (background && typeof background.set_file === 'function') {
                try {
                    background.set_file(Gio.File.new_for_path(match.path));
                } catch (error) {
                    logInfo('Failed to set per-monitor wallpaper', `${match.path} (${error && error.message ? error.message : String(error)})`);
                }
            }
        }
    }

    return true;
}

function refreshWallpaperState() {
    try {
        const folderPath = getFolderPathForSettings();
        const wallpapers = collectWallpaperEntries(folderPath);
        const screens = getLogicalScreens();
        const assignments = chooseWallpaperAssignments(screens, wallpapers);

        if (assignments.length === 0) {
            logInfo('No assignments could be produced; wallpaper set unchanged', folderPath);
            return {
                folderPath,
                totalWallpapers: wallpapers.length,
                landscapeCount: wallpapers.filter(entry => entry.orientation === 'landscape').length,
                portraitCount: wallpapers.filter(entry => entry.orientation === 'portrait').length,
                screenCount: screens.length,
                landscapeScreens: screens.filter(screen => screen.orientation === 'landscape').length,
                portraitScreens: screens.filter(screen => screen.orientation === 'portrait').length,
                assignments: [],
            };
        }

        applyWallpaperAssignments(assignments);
        const result = {
            folderPath,
            totalWallpapers: wallpapers.length,
            landscapeCount: wallpapers.filter(entry => entry.orientation === 'landscape').length,
            portraitCount: wallpapers.filter(entry => entry.orientation === 'portrait').length,
            screenCount: screens.length,
            landscapeScreens: screens.filter(screen => screen.orientation === 'landscape').length,
            portraitScreens: screens.filter(screen => screen.orientation === 'portrait').length,
            assignments,
        };

        logInfo('Wallpaper refresh summary', `screens=${result.screenCount}, wallpapers=${result.totalWallpapers}, landscape=${result.landscapeCount}, portrait=${result.portraitCount}`);
        return result;
    } catch (error) {
        logInfo('Wallpaper refresh failed', error && error.message ? error.message : String(error));
        return null;
    }
}

class MultiWallpaperExtension {
    constructor() {
        this._settings = null;
        this._timerId = 0;
    }

    enable() {
        this._settings = getSettings();
        if (!this._settings) {
            logInfo('Extension started without a valid settings backend; wallpaper logic remains disabled.');
            return;
        }

        this._settings.connect('changed::wallpaper-folder', () => {
            logInfo('Wallpaper folder changed; refreshing state');
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
            try {
                this._checkRotation();
            } catch (error) {
                logInfo('Rotation timer callback failed', error && error.message ? error.message : String(error));
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _checkRotation() {
        if (!this._settings)
            return GLib.SOURCE_CONTINUE;

        const lastTimestamp = this._settings.get_int64('last-change-timestamp');
        const nowSeconds = Math.floor(Date.now() / 1000);

        if (lastTimestamp === 0 || nowSeconds - lastTimestamp >= DEFAULT_ROTATION_SECONDS) {
            const result = refreshWallpaperState();
            if (result) {
                setLastChangeTimestamp(nowSeconds);
                logInfo('Wallpaper rotation applied', `screens=${result.screenCount}, wallpapers=${result.totalWallpapers}`);
            }
        }

        return GLib.SOURCE_CONTINUE;
    }
}

function init() {
    return new MultiWallpaperExtension();
}
