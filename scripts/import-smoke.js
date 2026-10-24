// GJS import smoke test — loads every src/ module that does not depend on a
// shell-only typelib, so module-resolution errors surface at build time.
//
// `node --check` only proves a file parses. It cannot catch the failure modes
// that actually break a GNOME extension at load: a named import that does not
// exist on the target module ("requested module does not provide an export"),
// a circular import that resolves to undefined, or a gi:// typelib that is not
// installed. Importing each module inside real GJS catches all three.
//
// Shell-only modules (St, Clutter, Shell, the resource:// shell modules) are
// excluded because their typelibs are only loadable inside the gnome-shell
// process. GTK4/libadwaita modules are imported when available and skipped
// otherwise, so the same script works on a headless CI box.
//
// Run from the repository root:  gjs -m scripts/import-smoke.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

/**
 * Modules that require the GNOME Shell process (St, Clutter, Shell or
 * resource:///org/gnome/shell/*). Listed explicitly rather than pattern-matched
 * so adding a shell-only module is a visible decision.
 */
const SHELL_ONLY = new Set([
    'src/ui/dashboard.js',
    'src/ui/indicator.js',
    'src/ui/serverCard.js',
    'src/ui/widgets/meter.js',
    'src/ui/widgets/metricTile.js',
    'src/ui/widgets/panelGauge.js',
    'src/ui/widgets/sparkline.js',
    'src/ui/widgets/statusDot.js',
    'src/monitor/poller.js',
    'src/api/zabbixClient.js',
    'src/api/zabbixTransport.js',
    'src/shared/secrets.js',
    'src/shared/settings.js',
]);

/** Preferences-side modules: importable when GTK4 + libadwaita are installed. */
const GTK_PREFIX = 'src/ui/prefs/';

let gtkAvailable = false;
try {
    await import('gi://Gtk?version=4.0');
    await import('gi://Adw');
    gtkAvailable = true;
} catch {
    gtkAvailable = false;
}

/**
 * Recursively list `.js` files under a directory.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listJsFiles(dir) {
    const files = [];
    let enumerator;
    try {
        enumerator = Gio.File.new_for_path(dir).enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null,
        );
    } catch {
        return files;
    }

    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        const path = `${dir}/${name}`;
        if (info.get_file_type() === Gio.FileType.DIRECTORY) files.push(...listJsFiles(path));
        else if (name.endsWith('.js')) files.push(path);
    }
    return files;
}

const cwd = GLib.get_current_dir();
if (!GLib.file_test(`${cwd}/src`, GLib.FileTest.IS_DIR)) {
    printerr('[FAIL] Run this script from the repository root (src/ not found).');
    System.exit(1);
}

const modules = listJsFiles(`${cwd}/src`)
    .map((path) => path.slice(cwd.length + 1))
    .sort();

const failures = [];
let imported = 0;
let skipped = 0;

for (const relativePath of modules) {
    if (SHELL_ONLY.has(relativePath)) {
        skipped++;
        continue;
    }
    if (relativePath.startsWith(GTK_PREFIX) && !gtkAvailable) {
        skipped++;
        continue;
    }

    try {
        await import(GLib.filename_to_uri(`${cwd}/${relativePath}`, null));
        imported++;
    } catch (error) {
        failures.push(`${relativePath}: ${error.message}`);
    }
}

if (failures.length > 0) {
    printerr(`[FAIL] ${failures.length} module(s) failed to import:`);
    for (const failure of failures) printerr(`  ${failure}`);
    System.exit(1);
}

const note = gtkAvailable ? '' : ' — GTK4/libadwaita unavailable, prefs modules skipped';
print(`[OK] Import smoke: ${imported} modules imported, ${skipped} excluded${note}.`);
