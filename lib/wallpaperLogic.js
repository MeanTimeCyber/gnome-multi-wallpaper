// Shared wallpaper logic used by both the Shell extension and the preferences window.

import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

export const ROTATION_SECONDS = 24 * 60 * 60;
const BACKGROUND_SCHEMA = 'org.gnome.desktop.background';
const SETTINGS_KEY_FOLDER = 'wallpaper-folder';
const SETTINGS_KEY_TIMESTAMP = 'last-change-timestamp';
const SUPPORTED_SUFFIXES = ['.png', '.jpg', '.jpeg'];
const COMPOSITE_DIR = 'multiwallpaper';
const COMPOSITE_PREFIX = 'spanned-';
const MAX_SCAN_DEPTH = 8;
const MAX_WALLPAPERS = 5000;
const SCAN_CHUNK_SIZE = 25;
const LOG_PREFIX = '[MultiWallpaper]';

export function log(message, detail = '') {
    console.log(`${LOG_PREFIX} ${message}${detail ? `: ${detail}` : ''}`);
}

// Same as log() but written to the error stream for failures.
export function logError(message, detail = '') {
    console.error(`${LOG_PREFIX} ${message}${detail ? `: ${detail}` : ''}`);
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
// A generator so the driver can yield to the main loop; return() on it closes any open enumerator.
function* scanSteps(root) {
    const entries = [];
    const stats = {skipped: 0, truncated: false};
    const queue = [{dir: Gio.File.new_for_path(root), depth: 0}];
    let visited = 0;

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
                visited += 1;
                if (visited % SCAN_CHUNK_SIZE === 0)
                    yield;

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
    if (stats.skipped > 0)
        log('Skipped unreadable images', `${stats.skipped} in ${root}`);

    return {entries, stats};
}

// Runs the scan one chunk per idle callback so the main loop stays responsive.
// onDone receives {entries, stats, error?} exactly once, unless the returned cancel function is called first.
export function startScan(root, onDone) {
    const steps = scanSteps(root);
    let sourceId = 0;

    sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        let outcome = null;
        try {
            const step = steps.next();
            if (!step.done)
                return GLib.SOURCE_CONTINUE;
            outcome = step.value;
        } catch (error) {
            logError('Scan failed', error.message);
            outcome = {entries: [], stats: {skipped: 0, truncated: false}, error: error.message};
        }

        sourceId = 0;
        try {
            onDone(outcome);
        } catch (error) {
            logError('Scan callback failed', error.message);
        }
        return GLib.SOURCE_REMOVE;
    });

    return () => {
        if (!sourceId)
            return;
        GLib.Source.remove(sourceId);
        sourceId = 0;
        steps.return();
    };
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

// Zoom-crops one image to a screen's size and copies it onto the shared canvas at the screen's offset.
function renderTile(canvas, screen, path, minX, minY) {
    const info = GdkPixbuf.Pixbuf.get_file_info(path);
    if (!info || !(info[1] > 0) || !(info[2] > 0))
        throw new Error('unreadable image header');

    // Decode directly at the cover size so large photos are never held at full resolution.
    const scale = Math.max(screen.width / info[1], screen.height / info[2]);
    const scaledWidth = Math.max(screen.width, Math.round(info[1] * scale));
    const scaledHeight = Math.max(screen.height, Math.round(info[2] * scale));
    const scaled = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, scaledWidth, scaledHeight, false);
    if (!scaled)
        throw new Error('decoding failed');

    const cropX = Math.max(0, Math.floor((scaled.get_width() - screen.width) / 2));
    const cropY = Math.max(0, Math.floor((scaled.get_height() - screen.height) / 2));
    const width = Math.min(screen.width, scaled.get_width());
    const height = Math.min(screen.height, scaled.get_height());
    const tile = scaled.new_subpixbuf(cropX, cropY, width, height);
    tile.copy_area(0, 0, width, height, canvas, screen.x - minX, screen.y - minY);
}

// Renders every screen onto one canvas. A screen whose image fails is left black and logged, not fatal.
function composeCanvas(screens, assignments) {
    const minX = Math.min(...screens.map(screen => screen.x));
    const minY = Math.min(...screens.map(screen => screen.y));
    const maxX = Math.max(...screens.map(screen => screen.x + screen.width));
    const maxY = Math.max(...screens.map(screen => screen.y + screen.height));

    const canvas = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, maxX - minX, maxY - minY);
    if (!canvas)
        throw new Error('canvas allocation failed');
    canvas.fill(0x000000ff);

    let rendered = 0;
    for (const {screen, path} of assignments) {
        try {
            renderTile(canvas, screen, path, minX, minY);
            rendered += 1;
        } catch (error) {
            logError('Skipped image', `${path} (${error.message})`);
        }
    }

    if (rendered === 0)
        throw new Error('no image could be rendered');
    if (rendered < screens.length)
        log('Screens left without an image', `${screens.length - rendered} of ${screens.length}`);
    return canvas;
}

// Deletes a file and logs instead of throwing; used for cleanup paths.
function deleteQuietly(path) {
    try {
        Gio.File.new_for_path(path).delete(null);
    } catch (error) {
        logError('Could not delete file', `${path} (${error.message})`);
    }
}

// Removes earlier composites so the cache holds only the current wallpaper.
function removeOldComposites(dir, keepName) {
    try {
        const enumerator = Gio.File.new_for_path(dir)
            .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        try {
            let info = null;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.startsWith(COMPOSITE_PREFIX) && name !== keepName)
                    deleteQuietly(GLib.build_filenamev([dir, name]));
            }
        } finally {
            enumerator.close(null);
        }
    } catch (error) {
        logError('Could not list old composites', error.message);
    }
}

// GNOME has one background for all displays, so the screens are composited into a single
// image and applied with the public 'spanned' picture option.
export function applySpanned(screens, assignments) {
    const schemaSource = Gio.SettingsSchemaSource.get_default();
    if (!schemaSource || !schemaSource.lookup(BACKGROUND_SCHEMA, true)) {
        logError('Background schema missing', BACKGROUND_SCHEMA);
        return fail('GNOME background settings are unavailable.');
    }

    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), COMPOSITE_DIR]);
    let path = null;
    let settingsTouched = false;
    try {
        GLib.mkdir_with_parents(dir, 0o755);

        const name = `${COMPOSITE_PREFIX}${Date.now()}.jpg`;
        path = GLib.build_filenamev([dir, name]);
        composeCanvas(screens, assignments).savev(path, 'jpeg', ['quality'], ['95']);

        // Once the keys are touched the new file is referenced, so it must not be deleted on failure.
        settingsTouched = true;
        const uri = Gio.File.new_for_path(path).get_uri();
        const background = Gio.Settings.new(BACKGROUND_SCHEMA);
        const written = background.set_string('picture-options', 'spanned') &&
            background.set_string('picture-uri', uri) &&
            background.set_string('picture-uri-dark', uri) &&
            background.set_boolean('draw-background', true);
        if (!written)
            throw new Error('GSettings rejected a background key');

        removeOldComposites(dir, name);
        return {ok: true, path: uri, reason: null};
    } catch (error) {
        if (path && !settingsTouched)
            deleteQuietly(path);
        logError('Spanned wallpaper failed', error.message);
        return fail(`Could not build the spanned wallpaper: ${error.message}`);
    }
}

// True only when the current wallpaper is one of our composites and its file is gone (e.g. cache cleaned).
export function isCompositeMissing() {
    try {
        const source = Gio.SettingsSchemaSource.get_default();
        if (!source || !source.lookup(BACKGROUND_SCHEMA, true))
            return false;

        const uri = Gio.Settings.new(BACKGROUND_SCHEMA).get_string('picture-uri');
        if (!uri.startsWith('file://'))
            return false;

        const file = Gio.File.new_for_uri(uri);
        const path = file.get_path();
        if (!path || !path.includes(`/${COMPOSITE_DIR}/${COMPOSITE_PREFIX}`))
            return false;
        return !file.query_exists(null);
    } catch (error) {
        logError('Could not check current wallpaper', error.message);
        return false;
    }
}

function result(status, message, extra = {}) {
    if (status === 'applied')
        log('Wallpaper applied', message);
    else if (status === 'error')
        logError('Rotation failed', message);
    else
        log('Rotation skipped', `${status}: ${message}`);
    return {status, message, ...extra};
}

// Everything after the scan: map screens, apply, and record the timestamp only on success.
// Never throws: every failure is returned as a result with a status the caller can act on.
function finishRotation(settings, getMonitors, folder, scan) {
    try {
        if (scan.error)
            return result('error', `Scan failed: ${scan.error}`);

        const {entries, stats} = scan;
        if (entries.length === 0)
            return result('no-images', `No PNG or JPG images found in ${folder.path}.`);

        // Read monitors now, not at start, so a layout change during the scan is respected.
        const screens = getLogicalScreens(getMonitors());
        if (screens.length === 0)
            return result('no-screens', 'No displays were detected.');

        const assignments = chooseAssignments(screens, entries);
        const applied = applySpanned(screens, assignments);
        if (!applied.ok)
            return result('error', applied.reason);

        // Failing to save the timestamp is reported as an error so the caller retries later instead of rotating every minute.
        if (!settings.set_int64(SETTINGS_KEY_TIMESTAMP, Math.floor(Date.now() / 1000)))
            return result('error', 'Could not record the change time.');

        const message = `${entries.length} images across ${screens.length} display(s), ${stats.skipped} skipped`;
        return result('applied', message, {folder: folder.path, entries, screens, assignments});
    } catch (error) {
        return result('error', error && error.message ? error.message : String(error));
    }
}

// Full rotation: resolve folder, scan in chunks, then apply. onDone gets one result object,
// unless the returned cancel function is called first. getMonitors returns [{x, y, width, height}].
export function startRotation(settings, getMonitors, onDone) {
    const deliver = outcome => {
        try {
            onDone(outcome);
        } catch (error) {
            logError('Rotation callback failed', error.message);
        }
    };

    let folder = null;
    try {
        folder = resolveFolder(settings.get_string(SETTINGS_KEY_FOLDER));
    } catch (error) {
        deliver(result('error', error && error.message ? error.message : String(error)));
        return () => {};
    }

    if (!folder.path) {
        deliver(result('no-folder', folder.notice));
        return () => {};
    }
    if (folder.usingDefault)
        log('Using default folder', folder.notice);

    return startScan(folder.path, scan => deliver(finishRotation(settings, getMonitors, folder, scan)));
}
