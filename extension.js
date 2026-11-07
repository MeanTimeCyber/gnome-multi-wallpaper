// GNOME Shell extension entry point. Checks once a minute whether a rotation is due.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {EXTENSION_SCHEMA, ROTATION_SECONDS, getLogicalScreens, isCompositeMissing, layoutSignature, log, logError, startRotation} from './lib/wallpaperLogic.js';

const CHECK_INTERVAL_SECONDS = 60;
const RETRY_SECONDS = 60 * 60;
const MONITOR_SETTLE_MS = 2000;

export default class MultiWallpaperExtension extends Extension {
    enable() {
        try {
            this._settings = this.getSettings(EXTENSION_SCHEMA);
        } catch (error) {
            logError('Settings schema unavailable; extension inactive', error.message);
            return;
        }
        this._retryAfter = 0;

        // Changing the folder in preferences rotates immediately, bypassing the 24-hour timer.
        this._folderChangedId = this._settings.connect('changed::wallpaper-folder', () => this._rotate());

        // The composite is sized to the current layout, so rebuild it after displays are added or removed.
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._scheduleRotate());

        // Unlocking can reset the displays without a monitors-changed signal, which leaves the composite misaligned.
        try {
            this._screenShieldId = Main.screenShield?.connect('active-changed', () => {
                if (!Main.screenShield.active)
                    this._scheduleRotate();
            }) ?? 0;
        } catch (error) {
            logError('Lock screen signal unavailable', error.message);
        }

        // Login is the first enable; rebuild if the screens differ from the layout the saved wallpaper was built for.
        this._checkLayoutOnLogin();

        // Keep the timer alive even if one check throws, so a single failure cannot stop future rotations.
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_INTERVAL_SECONDS, () => {
            try {
                this._checkDue();
            } catch (error) {
                logError('Schedule check failed', error.message);
            }
            return GLib.SOURCE_CONTINUE;
        });
        log('Extension enabled');
    }

    disable() {
        this._stopRotation();
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        if (this._monitorTimerId) {
            GLib.Source.remove(this._monitorTimerId);
            this._monitorTimerId = 0;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._screenShieldId) {
            Main.screenShield?.disconnect(this._screenShieldId);
            this._screenShieldId = 0;
        }
        if (this._settings && this._folderChangedId)
            this._settings.disconnect(this._folderChangedId);
        this._folderChangedId = 0;
        this._settings = null;
        this._retryAfter = 0;
        log('Extension disabled');
    }

    // Debounced because monitors-changed can fire several times while a layout settles, and unlock can follow a display reset.
    _scheduleRotate() {
        if (this._monitorTimerId)
            GLib.Source.remove(this._monitorTimerId);

        this._monitorTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MONITOR_SETTLE_MS, () => {
            this._monitorTimerId = 0;
            this._rotate();
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkLayoutOnLogin() {
        const screens = getLogicalScreens(Main.layoutManager.monitors ?? []);
        if (screens.length === 0)
            return;

        if (this._settings.get_string('last-layout') !== layoutSignature(screens))
            this._scheduleRotate();
    }

    _checkDue() {
        if (!this._settings || this._rotating)
            return;

        const now = Math.floor(Date.now() / 1000);
        if (now < this._retryAfter)
            return;

        if (isCompositeMissing()) {
            log('Current wallpaper file is missing; rebuilding');
            this._rotate();
            return;
        }

        const last = this._settings.get_int64('last-change-timestamp');
        // A timestamp in the future (clock change) is treated as due rather than blocking rotation.
        const withinPeriod = last > 0 && last <= now && now - last < ROTATION_SECONDS;
        if (!withinPeriod)
            this._rotate();
    }

    _stopRotation() {
        if (this._cancelRotation)
            this._cancelRotation();
        this._cancelRotation = null;
        this._rotating = false;
    }

    // Starts a rotation, replacing one still in flight (e.g. the folder changed mid-scan).
    _rotate() {
        if (!this._settings)
            return;

        this._stopRotation();
        this._rotating = true;
        this._cancelRotation = startRotation(this._settings, () => Main.layoutManager.monitors ?? [], outcome => {
            this._rotating = false;
            this._cancelRotation = null;
            // Success clears any earlier retry gate; any other outcome waits an hour before retrying.
            this._retryAfter = outcome.status === 'applied' ? 0 : Math.floor(Date.now() / 1000) + RETRY_SECONDS;
        });
    }
}
