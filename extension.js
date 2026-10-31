/* extension.js — Zappix entry point.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Lifecycle only: build the three collaborators (settings, monitor, indicator),
// wire them together, and tear them down in the reverse order. Every behaviour
// lives in a module under src/ so this file stays readable, and so `disable()`
// can be audited in one screen — a GNOME extension that leaks a timer or a
// Soup session degrades the whole desktop, not just itself.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { Extension, gettext, ngettext } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { ZappixIndicator } from './src/ui/indicator.js';
import { MonitorService } from './src/monitor/poller.js';
import { NotificationPolicy, URGENCY } from './src/monitor/notificationPolicy.js';
import { ZappixSettings } from './src/shared/settings.js';
import { zabbixLogoIcon } from './src/shared/brand.js';
import { SecretStore } from './src/shared/secrets.js';
import { initI18n } from './src/shared/i18n.js';
import { error, info, setDebugEnabled } from './src/shared/log.js';
import { buildFrontendUrl } from './src/api/zabbixEndpoints.js';

/**
 * Settings keys that require a full rebuild of the polling layer, because they
 * change how servers are contacted rather than how results are displayed.
 */
const RECONFIGURE_KEYS = [
    'servers',
    'active-server-id',
    'credentials-revision',
    'insecure-tls',
    'timeout-seconds',
    'poll-interval-seconds',
    'max-hosts-per-server',
    'metrics-enabled',
    'warn-threshold',
    'critical-threshold',
    'history-window-minutes',
];

/** Keys that only change rendering. */
const RENDER_KEYS = [
    'density',
    'accent-colour',
    'reduce-motion',
    'show-panel-value',
    'panel-metric',
    'panel-alert-on-problems',
    'open-on-hover',
    'hover-open-delay-ms',
    'hover-close-delay-ms',
    'pin-on-open',
    'notify-on-critical',
    'notify-on-new-problems',
    'notification-cooldown-minutes',
    'debug-logging',
];

export default class ZappixExtension extends Extension {
    enable() {
        initI18n({ gettext, ngettext });

        try {
            this._settings = new ZappixSettings(this.getSettings());
            setDebugEnabled(this._settings.debugLogging);

            this._secrets = new SecretStore();
            this._policy = new NotificationPolicy({
                cooldownMinutes: this._settings.notificationCooldownMinutes,
            });

            this._monitor = new MonitorService({
                settings: this._settings,
                secrets: this._secrets,
                onChange: (reason) => this._onMonitorChange(reason),
            });

            this._indicator = new ZappixIndicator({
                settings: this._settings,
                monitor: this._monitor,
                callbacks: {
                    onOpenPreferences: () => this.openPreferences(),
                    onOpenFrontend: (serverId) => this._openFrontend(serverId),
                },
            });

            Main.panel.addToStatusArea(this.uuid, this._indicator);

            this._settingsHandlers = this._connectSettingsSignals();

            // Deliberately not awaited: `enable()` must return promptly or the
            // shell shows the extension as failed while it is still probing.
            this._monitor.start().catch((startError) => {
                error('monitor failed to start', startError);
            });

            info(`enabled (${this._settings.servers.length} server(s) configured)`);
        } catch (enableError) {
            error('failed to enable', enableError);
            this.disable();
        }
    }

    disable() {
        if (this._reconfigureSource) {
            GLib.source_remove(this._reconfigureSource);
            this._reconfigureSource = 0;
        }

        for (const handlerId of this._settingsHandlers ?? []) {
            this._settings?.disconnect(handlerId);
        }
        this._settingsHandlers = [];

        // Order matters: stop the producer before destroying the consumer, or a
        // poll landing mid-teardown calls into a destroyed actor.
        this._monitor?.stop();
        this._policy?.reset();
        this._destroyTraySource();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._monitor = null;
        this._secrets = null;
        this._policy = null;
        this._settings = null;

        info('disabled');
    }

    // ── settings ────────────────────────────────────────────────────────────

    /**
     * @returns {number[]} handler ids for teardown
     */
    _connectSettingsSignals() {
        const handlers = [];

        for (const key of RECONFIGURE_KEYS) {
            handlers.push(
                this._settings.connectChanged(key, () => {
                    // Debounce: the preferences window writes several keys in a
                    // row when a server is saved, and each write would otherwise
                    // rebuild every Soup session.
                    this._scheduleReconfigure();
                }),
            );
        }

        for (const key of RENDER_KEYS) {
            handlers.push(
                this._settings.connectChanged(key, () => this._onRenderSettingChanged(key)),
            );
        }

        return handlers;
    }

    _scheduleReconfigure() {
        if (this._reconfigureSource) return;

        this._reconfigureSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._reconfigureSource = 0;
            if (!this._monitor) return GLib.SOURCE_REMOVE;

            this._policy?.setCooldownMinutes(this._settings.notificationCooldownMinutes);
            this._monitor
                .reconfigure()
                .then(() => this._monitor.refresh())
                .catch((reconfigureError) => error('reconfigure failed', reconfigureError));

            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * @param {string} key
     */
    _onRenderSettingChanged(key) {
        if (key === 'debug-logging') {
            setDebugEnabled(this._settings.debugLogging);
        }
        if (key === 'notification-cooldown-minutes') {
            this._policy?.setCooldownMinutes(this._settings.notificationCooldownMinutes);
        }
        this._indicator?.update();
    }

    // ── monitor results ─────────────────────────────────────────────────────

    /**
     * @param {string} reason
     */
    _onMonitorChange(reason) {
        this._indicator?.update();
        if (reason !== 'poll-ok') return;

        try {
            this._showNotifications();
        } catch (notificationError) {
            // A notification failure must never break the dashboard.
            error('notification failed', notificationError);
        }
    }

    _showNotifications() {
        const snapshots = this._monitor?.getSnapshots() ?? [];
        if (snapshots.length === 0) return;

        const notifications = this._policy.evaluate(snapshots, {
            notifyOnNewProblems: this._settings.notifyOnNewProblems,
            notifyOnCritical: this._settings.notifyOnCritical,
            nowSeconds: Date.now() / 1000,
        });

        for (const notification of notifications) {
            this._sendNotification(notification);
        }
    }

    /**
     * Deliver one notification through the shell's message tray.
     *
     * @param {{title: string, body: string, urgency: string}} notification
     */
    _sendNotification(notification) {
        const source = this._ensureTraySource();
        if (!source) return;

        source.addNotification(
            new MessageTray.Notification({
                source,
                title: notification.title,
                body: notification.body,
                urgency:
                    notification.urgency === URGENCY.HIGH
                        ? MessageTray.Urgency.HIGH
                        : MessageTray.Urgency.NORMAL,
                // Monitoring alerts are informational; they should not steal
                // focus or persist after being read.
                'is-transient': false,
                resident: false,
            }),
        );
    }

    /**
     * One shared tray source for the whole extension.
     *
     * Reusing a single source means repeated alerts collapse into the
     * notification list instead of spawning a new "Zappix" entry per poll.
     *
     * @returns {object|null}
     */
    _ensureTraySource() {
        if (this._traySource) return this._traySource;

        try {
            this._traySource = new MessageTray.Source({
                title: 'Zappix',
                icon: zabbixLogoIcon(),
            });

            this._traySource.connect('destroy', () => {
                this._traySource = null;
            });

            Main.messageTray.add(this._traySource);
        } catch (sourceError) {
            error('cannot create notification source', sourceError);
            this._traySource = null;
        }

        return this._traySource;
    }

    /**
     * Release the tray source so the shell does not keep a dead extension's
     * notification history.
     */
    _destroyTraySource() {
        if (!this._traySource) return;
        try {
            this._traySource.destroy();
        } catch {
            // Already destroyed by the shell.
        }
        this._traySource = null;
    }

    // ── actions ─────────────────────────────────────────────────────────────

    /**
     * Open the server's Zabbix frontend in the default browser.
     *
     * @param {string} serverId
     */
    _openFrontend(serverId) {
        const server = this._settings.servers.find((entry) => entry.id === serverId);
        if (!server) return;

        let url;
        try {
            url = buildFrontendUrl(server.baseUrl);
        } catch (urlError) {
            error('cannot build frontend URL', urlError);
            return;
        }

        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (launchError) {
            error(`cannot open ${url}`, launchError);
        }
    }
}
