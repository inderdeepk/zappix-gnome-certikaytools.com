// prefs.js — preferences entry point.
//
// The prefs process is a separate GTK4 application from the shell, so it gets
// its own copy of the i18n bridge and constructs its own settings and secret
// store. Nothing here is shared with the running extension; a change becomes
// visible when GSettings notifies the shell process.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import {
    ExtensionPreferences,
    gettext,
    ngettext,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { buildAppearancePage } from './src/ui/prefs/appearancePage.js';
import { buildMonitoringPage } from './src/ui/prefs/monitoringPage.js';
import { ServersPage } from './src/ui/prefs/serversPage.js';
import { ZappixSettings } from './src/shared/settings.js';
import { SecretStore } from './src/shared/secrets.js';
import { initI18n } from './src/shared/i18n.js';

export default class ZappixPreferences extends ExtensionPreferences {
    /**
     * @param {Adw.PreferencesWindow} window
     */
    fillPreferencesWindow(window) {
        initI18n({ gettext, ngettext });

        const settings = new ZappixSettings(this.getSettings());
        const secrets = new SecretStore();

        // Match the shell: a self-hosted Zabbix behind a VPN can be slow.
        window.set_default_size(720, 720);
        window.set_search_enabled(true);

        const serversPage = new ServersPage({ settings, secrets, window });

        window.add(serversPage.page);
        window.add(buildMonitoringPage({ settings }));
        window.add(
            buildAppearancePage({
                settings,
                extensionVersion: this.metadata?.version?.toString() ?? '',
            }),
        );

        // Re-render the server list when the shell (or a second prefs window)
        // changes it, so the page never shows a stale definition.
        const changedId = settings.connectChanged('servers', () => serversPage.refresh());

        window.connect('close-request', () => {
            settings.disconnect(changedId);
            return false;
        });
    }
}
