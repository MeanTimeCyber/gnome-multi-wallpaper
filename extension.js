const { GdkPixbuf, Gio, GLib } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;

// MultiWallpaper is intentionally conservative: we only touch the user-owned wallpaper
// folder and use the public desktop background settings schema rather than private Shell internals.
const LOG_PREFIX = '[MultiWallpaper]';
const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.multiwallpaper';
const DEFAULT_ROTATION_SECONDS = 24 * 60 * 60;
const DEFAULT_PICTURES_DIR = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || `${GLib.get_home_dir()}/Pictures`;

// Centralized logging keeps shell output readable and helps diagnose folder, image, and screen issues.
function logInfo(message, detail = null) {
    const suffix = detail ? `: ${detail}` : '';
    log(`${LOG_PREFIX} ${message}${suffix}`);
}

// Access the extension schema through the supported GNOME Shell settings entry point.
function getSettings() {
    try {
        return ExtensionUtils.getSettings(SETTINGS_SCHEMA);
    } catch (error) {
        logInfo('Failed to access extension settings', error && error.message ? error.message : String(error));
        return null;
    }
}

// Ensure the first run has a sane starting point. This keeps the UX stable for users who have not configured a folder yet.
function setDefaultWallpaperFolderIfNeeded() {
    const settings = getSettings();
    if (!settings)
        return;

    try {
        const current = settings.get_string('wallpaper-folder');
        if (!current || !current.trim()) {
            settings.set_string('wallpaper-folder', getDefaultWallpaperFolder());
            logInfo('Initialised wallpaper-folder setting to default Pictures directory');
        }
    } catch (error) {
        logInfo('Could not initialise wallpaper-folder setting', error && error.message ? error.message : String(error));
    }
}

function getDefaultWallpaperFolder() {
    return DEFAULT_PICTURES_DIR;
}

// Restrict scanning to the user-controlled home directory. This prevents the extension from exploring
// arbitrary system paths or user-selected locations outside the intended trust boundary.
function isPathInsideUserHome(path) {
    if (!path || typeof path !== 'string')
        return false;

    const homeDir = GLib.get_home_dir();
    if (!homeDir)
        return false;

    const trimmed = path.trim();
    if (!trimmed)
        return false;

    return trimmed === homeDir || trimmed.startsWith(`${homeDir}/`);
}

// Validate folder configuration and fall back to the default Pictures directory when the configured path
// is missing, invalid, or outside the safe user-home boundary.
function normalizeConfiguredFolder(folderPath) {
    if (!folderPath || typeof folderPath !== 'string')
        return getDefaultWallpaperFolder();

    const candidate = folderPath.trim();
    if (!candidate)
        return getDefaultWallpaperFolder();

    try {
        const file = Gio.File.new_for_path(candidate);
        if (!file.query_exists(null)) {
            logInfo('Configured wallpaper folder is missing; falling back to Pictures', candidate);
            return getDefaultWallpaperFolder();
        }

        if (!isPathInsideUserHome(candidate)) {
            logInfo('Refusing wallpaper scan outside the user home directory', candidate);
            return getDefaultWallpaperFolder();
        }

        return candidate;
    } catch (error) {
        logInfo('Invalid wallpaper folder path', candidate);
    }

    logInfo('Configured wallpaper folder is missing; falling back to Pictures', candidate);
    return getDefaultWallpaperFolder();
}

// Read and normalize the configured folder each time; this keeps the runtime logic resilient if the user
// chooses a removed directory or a path that no longer exists.
function getFolderPathForSettings() {
    const settings = getSettings();
    if (!settings)
        return getDefaultWallpaperFolder();

    try {
        const configured = settings.get_string('wallpaper-folder');
        const normalized = normalizeConfiguredFolder(configured);
        if (normalized !== configured) {
            settings.set_string('wallpaper-folder', normalized);
        }
        return normalized;
    } catch (error) {
        logInfo('Unable to read wallpaper-folder setting; using Pictures fallback', error && error.message ? error.message : String(error));
        return getDefaultWallpaperFolder();
    }
}

// Persist rotation state so the extension rotates every 24 hours from the last successful change.
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

// Accept only the image types the feature intentionally supports.
function isSupportedImageName(name) {
    if (!name || typeof name !== 'string')
        return false;

    const lower = name.toLowerCase();
    return lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
}

// Inspect a candidate image and classify it by dimensions. The metadata is used to prioritize matching
// wallpaper orientation against the logical screen layout.
function readWallpaperEntry(file) {
    if (!file)
        return null;

    const path = file.get_path();
    if (!path)
        return null;

    try {
        const info = file.query_info('standard::type,standard::is-symlink', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (info.get_is_symlink()) {
            logInfo('Skipping symlinked wallpaper', path);
            return null;
        }

        if (info.get_file_type() !== Gio.FileType.REGULAR) {
            return null;
        }
    } catch (error) {
        logInfo('Could not inspect wallpaper entry type', `${path} (${error && error.message ? error.message : String(error)})`);
        return null;
    }

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

// Recursively enumerate the folder tree, skipping unsupported entries and invalid files to build the
// pool of wallpapers that can be selected for rotation.
function collectWallpaperEntries(folderPath) {
    const wallpaperEntries = [];
    const finalFolderPath = normalizeConfiguredFolder(folderPath);
    if (!isPathInsideUserHome(finalFolderPath)) {
        logInfo('Wallpaper scan rejected: path is outside the user home directory', finalFolderPath);
        return wallpaperEntries;
    }

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

// Reduce the current display layout to a logical screen list by collapsing duplicate/mirrored geometry.
// This gives us one wallpaper target per effective screen rather than per physical output entry.
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

        const mirrored = groups.some(group =>
            Math.abs(group.width - width) < 2 &&
            Math.abs(group.height - height) < 2 &&
            Math.abs(group.x - x) < 2 &&
            Math.abs(group.y - y) < 2
        );

        if (mirrored)
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

    const summary = groups.map(screen => `${screen.width}x${screen.height}:${screen.orientation}`).join(', ');
    logInfo('Monitor layout summary', summary);
    return groups;
}

// Rank candidates by orientation match first, then by aspect-ratio fit and image size. This keeps the
// wallpaper selection deterministic while still preferring bigger, better-fitting images.
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

// Assign wallpapers to each logical screen by preferring a matching orientation and then falling back to the
// other orientation only when necessary. Paths are de-duped so we do not reuse the same wallpaper more than
// once when a better choice is available.
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

// Apply the selected wallpaper via the public desktop background settings schema. We intentionally do not
// rely on private Shell members because they are not stable across GNOME versions.
function applyWallpaperAssignments(assignments) {
    if (!Array.isArray(assignments) || assignments.length === 0) {
        logInfo('No wallpaper assignments to apply');
        return false;
    }

    try {
        const backgroundSettings = new Gio.Settings({ schema: 'org.gnome.desktop.background' });
        const primaryAssignment = assignments[0];
        const fileUri = `file://${primaryAssignment.path}`;

        // GNOME exposes background configuration via the public GSettings schema.
        // There is no stable public GSettings key for assigning unique wallpapers to each
        // monitor in GNOME 50/51, so we intentionally avoid any private Shell members.
        backgroundSettings.set_string('picture-uri', fileUri);
        backgroundSettings.set_string('picture-uri-dark', fileUri);
        backgroundSettings.set_boolean('draw-background', true);

        logInfo('Applied desktop background via public GSettings configuration', fileUri);
        return true;
    } catch (error) {
        logInfo('Unable to update desktop background settings', error && error.message ? error.message : String(error));
        return false;
    }
}

// The main refresh routine: gather the folder, classify the images, map them to logical screens, and then
// push the current assignment through the safe settings API.
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

// Extension lifecycle object. The timer keeps rotation scheduled in the background while the settings schema
// provides the stable persistence layer for state and folder selection.
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

        setDefaultWallpaperFolderIfNeeded();
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

    // Polling is intentionally lightweight and conservative; this is a daily rotation feature rather than a
    // high-frequency background task.
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

    // Rotate once every 24 hours from the last successful change, while keeping the operation idempotent and
    // safe when the folder is empty or invalid.
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
