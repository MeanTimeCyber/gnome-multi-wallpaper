// GNOME Shell extension entry point. Checks once a minute whether a rotation is due.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ROTATION_SECONDS, log, runRotation} from './lib/wallpaperLogic.js';

const CHECK_INTERVAL_SECONDS = 60;
const RETRY_SECONDS = 60 * 60;

export default class MultiWallpaperExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._retryAfter = 0;

        // Changing the folder in preferences rotates immediately, bypassing the 24-hour timer.
        this._folderChangedId = this._settings.connect('changed::wallpaper-folder', () => this._rotate());

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_INTERVAL_SECONDS, () => {
            this._checkDue();
            return GLib.SOURCE_CONTINUE;
        });
        log('Extension enabled');
    }

    disable() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        if (this._settings && this._folderChangedId)
            this._settings.disconnect(this._folderChangedId);
        this._folderChangedId = 0;
        this._settings = null;
        this._retryAfter = 0;
        log('Extension disabled');
    }

    _checkDue() {
        if (!this._settings)
            return;

        const now = Math.floor(Date.now() / 1000);
        if (now < this._retryAfter)
            return;

        const last = this._settings.get_int64('last-change-timestamp');
        // A timestamp in the future (clock change) is treated as due rather than blocking rotation.
        const withinPeriod = last > 0 && last <= now && now - last < ROTATION_SECONDS;
        if (!withinPeriod)
            this._rotate();
    }

    _rotate() {
        if (!this._settings)
            return;

        try {
            const outcome = runRotation(this._settings, Main.layoutManager.monitors);
            if (outcome.status !== 'applied')
                this._retryAfter = Math.floor(Date.now() / 1000) + RETRY_SECONDS;
        } catch (error) {
            this._retryAfter = Math.floor(Date.now() / 1000) + RETRY_SECONDS;
            log('Rotation failed', error && error.message ? error.message : String(error));
        }
    }
}
