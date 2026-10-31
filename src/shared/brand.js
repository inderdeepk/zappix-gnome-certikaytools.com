// brand.js — the bundled Zabbix mark, as a GIcon for the shell and prefs.
//
// Both processes import this module from the extension itself, so the icon is
// resolved from `import.meta.url` instead of being threaded through every
// constructor. Resolution is lazy and cached: a missing icon degrades to an
// unrendered widget, never to a module that fails to load.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** `icons/zabbix_logo.svg`, relative to the extension root. */
const LOGO_PATH = ['icons', 'zabbix_logo.svg'];

/** Depth of `src/shared/brand.js` below the extension root. */
const ROOT_DEPTH = 3;

/** @type {Gio.Icon|null} */
let cachedIcon = null;

/**
 * Absolute path of the bundled Zabbix mark.
 *
 * @returns {string}
 */
export function zabbixLogoPath() {
    const [modulePath = ''] = GLib.filename_from_uri(import.meta.url);

    let root = modulePath;
    for (let depth = 0; depth < ROOT_DEPTH; depth++) root = GLib.path_get_dirname(root);

    return GLib.build_filenamev([root, ...LOGO_PATH]);
}

/**
 * The Zabbix mark for `St.Icon`, `Gtk.Image` and `MessageTray.Source`.
 *
 * @returns {Gio.Icon}
 */
export function zabbixLogoIcon() {
    cachedIcon ??= Gio.icon_new_for_string(zabbixLogoPath());
    return cachedIcon;
}
