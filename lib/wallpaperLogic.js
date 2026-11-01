// Shared wallpaper logic used by both the Shell extension and the preferences window.

import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

export const ROTATION_SECONDS = 24 * 60 * 60;
const BACKGROUND_SCHEMA = 'org.gnome.desktop.background';
const SETTINGS_KEY_FOLDER = 'wallpaper-folder';
const SETTINGS_KEY_TIMESTAMP = 'last-change-timestamp';
const SUPPORTED_SUFFIXES = ['.png', '.jpg', '.jpeg'];
const MAX_SCAN_DEPTH = 8;
const MAX_WALLPAPERS = 5000;
const LOG_PREFIX = '[MultiWallpaper]';

export function log(message, detail = '') {
    console.log(`${LOG_PREFIX} ${message}${detail ? `: ${detail}` : ''}`);
}

function fail(reason) {
    return {ok: false, path: null, reason};
}

// Collapse '.' and empty segments; reject '..' so paths cannot escape the home check.
function normalizePath(path) {
    const parts = [];
    for (const part of path.split('/')) {
        if (part === '' || part === '.')
            continue;
        if (part === '..')
            return null;
        parts.push(part);
    }
    return `/${parts.join('/')}`;
}

export function getDefaultFolder() {
    return GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Pictures']);
}

// Returns {ok, path, reason}. The folder must be a real (non-symlink) directory inside the user's home.
export function validateFolder(path) {
    if (typeof path !== 'string' || path.trim() === '')
        return fail('No folder is set.');

    const trimmed = path.trim();
    if (!trimmed.startsWith('/'))
        return fail('The folder path must be absolute.');

    const normalized = normalizePath(trimmed);
    if (normalized === null)
        return fail('Paths containing ".." are not allowed.');

    const home = normalizePath(GLib.get_home_dir());
    if (normalized !== home && !normalized.startsWith(`${home}/`))
        return fail('The folder must be inside your home directory.');

    const type = Gio.File.new_for_path(normalized)
        .query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (type === Gio.FileType.SYMBOLIC_LINK)
        return fail('The folder is a symbolic link; choose the real directory.');
    if (type !== Gio.FileType.DIRECTORY)
        return fail('The folder does not exist or cannot be read.');

    return {ok: true, path: normalized, reason: null};
}

// Use the configured folder if valid, otherwise the default Pictures folder with a notice.
export function resolveFolder(configured) {
    const check = validateFolder(configured);
    if (check.ok)
        return {path: check.path, usingDefault: false, notice: null};

    const fallback = validateFolder(getDefaultFolder());
    const notice = `${check.reason} Using the Pictures folder instead.` +
        (fallback.ok ? '' : ` ${fallback.reason}`);
    return {path: fallback.ok ? fallback.path : null, usingDefault: true, notice};
}

function isSupportedName(name) {
    const lower = name.toLowerCase();
    return SUPPORTED_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

// Reads only the image header (not the full pixel data) and checks the real format, not just the extension.
function readImageEntry(path) {
    let info = null;
    try {
        info = GdkPixbuf.Pixbuf.get_file_info(path);
    } catch (error) {
        return null;
    }
    if (!info)
        return null;

    const [format, width, height] = info;
    if (!format || !(width > 0) || !(height > 0))
        return null;

    return {
        path,
        width,
        height,
        orientation: height > width ? 'portrait' : 'landscape',
        area: width * height,
    };
}

// Breadth-first scan with depth and count caps. Hidden entries and symlinks are skipped.
export function scanFolder(root) {
    const entries = [];
    const stats = {skipped: 0, truncated: false};
    const queue = [{dir: Gio.File.new_for_path(root), depth: 0}];

    while (queue.length > 0) {
        const {dir, depth} = queue.shift();

        let enumerator = null;
        try {
            enumerator = dir.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null);
        } catch (error) {
            log('Could not read folder', `${dir.get_path()} (${error.message})`);
            continue;
        }

        try {
            let info = null;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.startsWith('.'))
                    continue;

                const type = info.get_file_type();
                if (type === Gio.FileType.DIRECTORY) {
                    if (depth < MAX_SCAN_DEPTH)
                        queue.push({dir: dir.get_child(name), depth: depth + 1});
                    continue;
                }

                if (type !== Gio.FileType.REGULAR || !isSupportedName(name))
                    continue;

                if (entries.length >= MAX_WALLPAPERS) {
                    stats.truncated = true;
                    queue.length = 0;
                    break;
                }

                const entry = readImageEntry(dir.get_child(name).get_path());
                if (entry)
                    entries.push(entry);
                else
                    stats.skipped += 1;
            }
        } catch (error) {
            log('Folder scan interrupted', `${dir.get_path()} (${error.message})`);
        } finally {
            enumerator.close(null);
        }
    }

    if (stats.truncated)
        log('Scan stopped at limit', `${MAX_WALLPAPERS} images`);

    return {entries, stats};
}

export function summarizeEntries(entries) {
    const landscape = entries.filter(entry => entry.orientation === 'landscape').length;
    return {total: entries.length, landscape, portrait: entries.length - landscape};
}

// Input is an array of {x, y, width, height}. Identical geometry (mirrored displays) counts once.
export function getLogicalScreens(monitors) {
    const screens = [];
    for (const monitor of monitors ?? []) {
        if (!monitor)
            continue;

        const x = Math.round(Number(monitor.x) || 0);
        const y = Math.round(Number(monitor.y) || 0);
        const width = Math.round(Number(monitor.width) || 0);
        const height = Math.round(Number(monitor.height) || 0);
        if (width <= 0 || height <= 0)
            continue;

        const mirrored = screens.some(screen =>
            screen.x === x && screen.y === y && screen.width === width && screen.height === height);
        if (mirrored)
            continue;

        screens.push({x, y, width, height, orientation: height > width ? 'portrait' : 'landscape'});
    }
    return screens;
}

export function summarizeScreens(screens) {
    const landscape = screens.filter(screen => screen.orientation === 'landscape').length;
    return {total: screens.length, landscape, portrait: screens.length - landscape};
}

// Higher is better: orientation match first, then aspect-ratio fit, then larger image size.
function scoreWallpaperForScreen(screen, candidate) {
    const orientationScore = screen.orientation === candidate.orientation ? 1000000 : 0;
    const screenAspect = screen.width / screen.height;
    const candidateAspect = candidate.width / candidate.height;
    const ratioPenalty = Math.abs(candidateAspect - screenAspect) * 1000;
    return orientationScore + candidate.area - ratioPenalty;
}

// Picks one wallpaper per screen: matching orientation first, other orientation as fallback,
// and never reuses a file while an unused one is still available.
export function chooseAssignments(screens, entries) {
    const assignments = [];
    const usedPaths = new Set();

    for (const screen of screens) {
        let pool = entries.filter(entry => entry.orientation === screen.orientation);
        if (pool.length === 0)
            pool = entries;

        const unused = pool.filter(entry => !usedPaths.has(entry.path));
        const candidates = unused.length > 0 ? unused : pool;
        candidates.sort((a, b) => scoreWallpaperForScreen(screen, b) - scoreWallpaperForScreen(screen, a));

        const selected = candidates[0];
        if (!selected)
            continue;

        assignments.push({screen, path: selected.path});
        usedPaths.add(selected.path);
    }
    return assignments;
}

// Writes the public org.gnome.desktop.background keys. GNOME has one background
// setting shared by all displays, so only one path is applied.
export function applyWallpaper(path) {
    const schemaSource = Gio.SettingsSchemaSource.get_default();
    if (!schemaSource || !schemaSource.lookup(BACKGROUND_SCHEMA, true))
        return fail('GNOME background settings are unavailable.');

    const uri = Gio.File.new_for_path(path).get_uri();
    const background = Gio.Settings.new(BACKGROUND_SCHEMA);
    if (background.get_string('picture-uri') !== uri)
        background.set_string('picture-uri', uri);
    if (background.get_string('picture-uri-dark') !== uri)
        background.set_string('picture-uri-dark', uri);
    background.set_boolean('draw-background', true);

    return {ok: true, path: uri, reason: null};
}

function result(status, message, extra = {}) {
    if (status === 'applied')
        log('Wallpaper applied', message);
    else
        log('Rotation not applied', `${status}: ${message}`);
    return {status, message, ...extra};
}

// Full rotation: resolve folder, scan, map screens, apply, and record the timestamp only on success.
export function runRotation(settings, monitors) {
    const folder = resolveFolder(settings.get_string(SETTINGS_KEY_FOLDER));
    if (!folder.path)
        return result('no-folder', folder.notice);

    const {entries, stats} = scanFolder(folder.path);
    if (entries.length === 0)
        return result('no-images', `No PNG or JPG images found in ${folder.path}.`);

    const screens = getLogicalScreens(monitors);
    if (screens.length === 0)
        return result('no-screens', 'No displays were detected.');

    const assignments = chooseAssignments(screens, entries);
    const applied = applyWallpaper(assignments[0].path);
    if (!applied.ok)
        return result('error', applied.reason);

    settings.set_int64(SETTINGS_KEY_TIMESTAMP, Math.floor(Date.now() / 1000));
    const message = `${assignments[0].path} (${entries.length} images, ${stats.skipped} skipped)`;
    return result('applied', message, {folder: folder.path, entries, screens, assignments});
}
