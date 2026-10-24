// prefs-smoke.js — construct the whole preferences UI without launching it.
//
// The prefs process is a GTK4/libadwaita application, and a mistake there is
// invisible to every other check: the shell-side tests cannot import Adw, and
// `make check` only proves the modules parse. This script builds all three
// pages against a real GSettings instance and then quits, which catches the
// failures that would otherwise appear as a blank preferences window:
//
//   • an unknown property on an Adw widget (hard error in GObject);
//   • a settings key that is missing from the compiled schema;
//   • a crash inside a row builder that only runs once a page is added.
//
// Run from the repository root:
//   GSETTINGS_SCHEMA_DIR=schemas gjs -m scripts/prefs-smoke.js
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import { buildAppearancePage } from '../src/ui/prefs/appearancePage.js';
import { buildMonitoringPage } from '../src/ui/prefs/monitoringPage.js';
import { ServersPage } from '../src/ui/prefs/serversPage.js';
import { ZappixSettings } from '../src/shared/settings.js';
import { SecretStore } from '../src/shared/secrets.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.zappix';

let settings;
try {
    // `new_full` wants a GSettingsSchema object, not an id: resolve it through
    // the source first so a missing schema produces a readable error.
    const source = Gio.SettingsSchemaSource.get_default();
    const schema = source?.lookup(SCHEMA_ID, true);
    if (!schema) throw new Error('schema is not installed in GSETTINGS_SCHEMA_DIR');
    settings = new Gio.Settings({ settings_schema: schema });
} catch (error) {
    printerr(`[FAIL] schema "${SCHEMA_ID}" not found: ${error.message}`);
    printerr('       Run: GSETTINGS_SCHEMA_DIR=schemas gjs -m scripts/prefs-smoke.js');
    System.exit(2);
}

const application = new Adw.Application({ application_id: 'com.certikaytools.zappix.Smoke' });
let exitCode = 0;

application.connect('activate', () => {
    try {
        const window = new Adw.PreferencesWindow();
        const zappixSettings = new ZappixSettings(settings);
        const secrets = new SecretStore();

        const pages = [
            new ServersPage({ settings: zappixSettings, secrets, window }).page,
            buildMonitoringPage({ settings: zappixSettings }),
            buildAppearancePage({ settings: zappixSettings, extensionVersion: 'dev' }),
        ];

        for (const page of pages) {
            if (!page.get_title()) throw new Error('a page has no title');
            window.add(page);
        }

        print(
            `[OK] Preferences built: ${pages.length} pages (${pages.map((p) => p.get_title()).join(', ')})`,
        );
        window.destroy();
    } catch (error) {
        printerr(`[FAIL] ${error.message}`);
        exitCode = 1;
    } finally {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            application.quit();
            return GLib.SOURCE_REMOVE;
        });
    }
});

application.run([]);
System.exit(exitCode);
