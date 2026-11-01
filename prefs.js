const { Adw, Gio, GLib, Gtk } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.multiwallpaper';
const DEFAULT_PICTURES_DIR = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || `${GLib.get_home_dir()}/Pictures`;

function getSettings() {
    return ExtensionUtils.getSettings(SETTINGS_SCHEMA);
}

function isSupportedImageName(name) {
    if (!name)
        return false;

    const lower = name.toLowerCase();
    return lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
}

function readImageStats(path) {
    try {
        const pixbuf = imports.gi.GdkPixbuf.Pixbuf.new_from_file(path);
        const width = pixbuf.get_width();
        const height = pixbuf.get_height();
        return {
            width,
            height,
            orientation: height > width ? 'portrait' : 'landscape',
        };
    } catch (error) {
        return null;
    }
}

function collectWallpaperStats(folderPath) {
    const results = {
        total: 0,
        landscape: 0,
        portrait: 0,
    };

    if (!folderPath)
        return results;

    const folder = Gio.File.new_for_path(folderPath);
    if (!folder.query_exists(null))
        return results;

    const stack = [folder];
    while (stack.length > 0) {
        const current = stack.pop();
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
                stack.push(current.get_child(name));
                continue;
            }

            if (type !== Gio.FileType.REGULAR || !isSupportedImageName(name))
                continue;

            const file = current.get_child(name);
            const fullPath = file.get_path();
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

        const current = settings.get_string('wallpaper-folder') || DEFAULT_PICTURES_DIR;
        dialog.set_current_folder(Gio.File.new_for_path(current));

        dialog.connect('response', (widget, response) => {
            if (response === Gtk.ResponseType.ACCEPT) {
                const folder = widget.get_file();
                if (folder) {
                    settings.set_string('wallpaper-folder', folder.get_path());
                    refreshStats();
                }
            }
            widget.destroy();
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

    const changeNowButton = new Gtk.Button({ label: 'Change now', halign: Gtk.Align.END, valign: Gtk.Align.CENTER });
    changeNowButton.connect('clicked', () => {
        const folder = settings.get_string('wallpaper-folder') || DEFAULT_PICTURES_DIR;
        const stats = collectWallpaperStats(folder);
        const now = Math.floor(Date.now() / 1000);
        settings.set_int64('last-change-timestamp', now - 24 * 60 * 60 - 1);
        refreshStats();
        log(`[MultiWallpaper] Manual refresh requested (${stats.total} images found)`);
    });
    statsRow.add_suffix(changeNowButton);

    function refreshStats() {
        const folder = settings.get_string('wallpaper-folder') || DEFAULT_PICTURES_DIR;
        const stats = collectWallpaperStats(folder);
        statsLabel.set_text(
            `Found: ${stats.total} images\n` +
            `Landscape: ${stats.landscape}\n` +
            `Portrait: ${stats.portrait}\n` +
            `Folder: ${folder}`
        );
    }

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
