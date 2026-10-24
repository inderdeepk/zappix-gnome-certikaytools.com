// prefs/widgets.js — small builders that keep the preference pages declarative.
//
// libadwaita gives every row the same shape (title, subtitle, trailing control),
// so the repetitive part is the two-way binding between a GSettings key and a
// widget property. These helpers own that binding once, which is what lets each
// page read as a list of settings rather than a list of signal handlers.
//
// Two binding styles are used deliberately:
//   • `settings.bind()` for exact type matches (bool ↔ SwitchRow.active). It is
//     direction-agnostic, handles defaults and never drifts.
//   • manual read/write for anything that needs mapping (int ↔ SpinRow.value,
//     string ↔ ComboRow.selected), wrapped so a corrupt value cannot throw.
//
// Preferences-process module (Adw/Gtk), excluded from the shell import smoke.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

/** Default margin used by every page. */
const PAGE_MARGIN = 12;

/**
 * A switch row two-way bound to a boolean key.
 *
 * @param {object} options
 * @param {Gio.Settings} options.settings
 * @param {string} options.key
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @returns {Adw.SwitchRow}
 */
export function switchRow({ settings, key, title, subtitle = '' }) {
    const row = new Adw.SwitchRow({ title, subtitle });
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/**
 * A spin row bound to an integer key, clamped to the key's own range.
 *
 * @param {object} options
 * @param {Gio.Settings} options.settings
 * @param {string} options.key
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {number} options.min
 * @param {number} options.max
 * @param {number} [options.step=1]
 * @param {string} [options.suffix='']
 * @returns {Adw.SpinRow}
 */
export function spinRow({ settings, key, title, subtitle = '', min, max, step = 1, suffix = '' }) {
    const adjustment = new Gtk.Adjustment({
        lower: min,
        upper: max,
        step_increment: step,
        page_increment: Math.max(step, (max - min) / 10),
    });

    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment,
        digits: 0,
        climb_rate: 0,
    });

    const current = readInt(settings, key, min);
    adjustment.set_value(Math.min(max, Math.max(min, current)));

    adjustment.connect('value-changed', () => {
        const next = Math.round(adjustment.get_value());
        if (readInt(settings, key, min) === next) return;
        settings.set_int(key, next);
    });

    settings.connect(`changed::${key}`, () => {
        const value = readInt(settings, key, min);
        const clamped = Math.min(max, Math.max(min, value));
        if (Math.round(adjustment.get_value()) !== clamped) adjustment.set_value(clamped);
    });

    if (suffix) row.suffix = suffix;
    return row;
}

/**
 * A combo row bound to a string key.
 *
 * @param {object} options
 * @param {Gio.Settings} options.settings
 * @param {string} options.key
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {Array<{id: string, label: string}>} options.options
 * @returns {Adw.ComboRow}
 */
export function comboRow({ settings, key, title, subtitle = '', options }) {
    const model = Gtk.StringList.new(options.map((option) => option.label));
    const row = new Adw.ComboRow({ title, subtitle, model });

    const syncFromSettings = () => {
        const value = readString(settings, key);
        const index = options.findIndex((option) => option.id === value);
        row.selected = index === -1 ? 0 : index;
    };

    syncFromSettings();

    row.connect('notify::selected', () => {
        const option = options[row.selected];
        if (!option || readString(settings, key) === option.id) return;
        settings.set_string(key, option.id);
    });

    settings.connect(`changed::${key}`, syncFromSettings);
    return row;
}

/**
 * A multi-select of strings (used for the visible metric set).
 *
 * Implemented as a group of switches rather than a multi-select list because
 * libadwaita has no native multi-select widget and eight switches read faster
 * than a modal picker.
 *
 * @param {object} options
 * @param {Gio.Settings} options.settings
 * @param {string} options.key
 * @param {string} options.title
 * @param {Array<{id: string, label: string, subtitle?: string}>} options.items
 * @returns {Adw.PreferencesGroup}
 */
export function multiSwitchGroup({ settings, key, title, items }) {
    const group = new Adw.PreferencesGroup({ title });

    for (const item of items) {
        const row = new Adw.SwitchRow({
            title: item.label,
            subtitle: item.subtitle ?? '',
        });

        const sync = () => {
            row.active = readStringArray(settings, key).includes(item.id);
        };

        sync();

        row.connect('notify::active', () => {
            const current = readStringArray(settings, key);
            const has = current.includes(item.id);
            if (row.active === has) return;

            const next = row.active
                ? [...current, item.id]
                : current.filter((id) => id !== item.id);

            // An empty set would render an empty dashboard; the extension falls
            // back to defaults, but keeping at least one here avoids the
            // surprising jump.
            if (next.length === 0) {
                row.active = true;
                return;
            }

            settings.set_strv(key, next);
        });

        settings.connect(`changed::${key}`, sync);
        group.add(row);
    }

    return group;
}

/**
 * Replace a group on a preferences page.
 *
 * Rebuilding the group and swapping it in is the only reliable way to clear a
 * libadwaita `PreferencesGroup`: its rows live inside an internal box, so
 * `get_first_child()` returns that box rather than the rows, and `remove()`
 * on it is a critical warning. `Adw.PreferencesPage.add/remove` is public and
 * stable, so the swap happens one level up.
 *
 * @param {Adw.PreferencesPage} page
 * @param {Adw.PreferencesGroup} previous group to remove (may be null)
 * @param {Adw.PreferencesGroup} next group to add
 */
export function swapGroup(page, previous, next) {
    if (previous) page.remove(previous);
    page.add(next);
}

/**
 * A read-only information row.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {string} [options.value]
 * @returns {Adw.ActionRow}
 */
export function infoRow({ title, subtitle = '', value = '' }) {
    const row = new Adw.ActionRow({ title, subtitle });
    if (value) {
        row.add_suffix(
            new Gtk.Label({
                label: value,
                css_classes: ['dim-label'],
                valign: Gtk.Align.CENTER,
            }),
        );
    }
    return row;
}

/**
 * A preferences page with a single content box.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.iconName
 * @returns {{page: Adw.PreferencesPage, content: Gtk.Box}}
 */
export function pageScaffold({ title, iconName }) {
    const page = new Adw.PreferencesPage({
        title,
        icon_name: iconName,
    });

    return { page, content: page };
}

/**
 * A labelled entry row for free-text values.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.text]
 * @param {string} [options.tooltip]
 * @param {(value: string) => void} [options.onChanged]
 * @returns {Adw.EntryRow}
 */
export function entryRow({ title, text = '', tooltip = '', onChanged }) {
    const row = new Adw.EntryRow({ title, text });
    if (tooltip) row.tooltip_text = tooltip;
    if (onChanged) {
        row.connect('changed', () => onChanged(row.text));
    }
    return row;
}

/**
 * Read an integer setting, falling back rather than throwing.
 *
 * @param {Gio.Settings} settings
 * @param {string} key
 * @param {number} [fallback=0]
 * @returns {number}
 */
export function readInt(settings, key, fallback = 0) {
    try {
        return settings.get_int(key);
    } catch {
        return fallback;
    }
}

/**
 * Read a string setting.
 *
 * @param {Gio.Settings} settings
 * @param {string} key
 * @param {string} [fallback='']
 * @returns {string}
 */
export function readString(settings, key, fallback = '') {
    try {
        return settings.get_string(key);
    } catch {
        return fallback;
    }
}

/**
 * Read a string-array setting.
 *
 * @param {Gio.Settings} settings
 * @param {string} key
 * @returns {string[]}
 */
export function readStringArray(settings, key) {
    try {
        return settings.get_strv(key);
    } catch {
        return [];
    }
}

export { PAGE_MARGIN };
