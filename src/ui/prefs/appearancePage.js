// prefs/appearancePage.js — panel behaviour, visual density and diagnostics.
//
// Two groups that look unrelated but share a property: neither changes what is
// measured, only how it is presented (and how loudly). Keeping them on one page
// means a user tuning the panel never has to visit the Monitoring page, where
// every control has a server-side cost.
//
// Preferences-process module (Adw/Gtk).

import Adw from 'gi://Adw';

import { comboRow, infoRow, spinRow, switchRow } from './widgets.js';
import { ACCENT_IDS, ACCENTS, DENSITIES, PANEL_METRICS } from '../../shared/appearance.js';
import { HOVER_DELAY_MAX, HOVER_DELAY_MIN, POLL_INTERVAL_MAX } from '../../shared/settings.js';
import { gettext as _ } from '../../shared/i18n.js';

/**
 * Build the appearance page.
 *
 * @param {object} options
 * @param {import('../../shared/settings.js').ZappixSettings} options.settings
 * @param {string} [options.extensionVersion]
 * @returns {Adw.PreferencesPage}
 */
export function buildAppearancePage({ settings, extensionVersion = '' }) {
    const gioSettings = settings.raw;
    const page = new Adw.PreferencesPage({
        title: _('Appearance'),
        icon_name: 'applications-graphics-symbolic',
    });

    // ── panel ────────────────────────────────────────────────────────────
    const panel = new Adw.PreferencesGroup({ title: _('Panel icon') });
    page.add(panel);

    panel.add(
        switchRow({
            settings: gioSettings,
            key: 'show-panel-value',
            title: _('Show a value next to the icon'),
            subtitle: _('The ring always shows the level; this adds the exact number.'),
        }),
    );

    panel.add(
        comboRow({
            settings: gioSettings,
            key: 'panel-metric',
            title: _('Panel value'),
            options: PANEL_METRICS.map((id) => ({
                id,
                label: id === 'problems' ? _('Open problems') : _(labelForMetric(id)),
            })),
        }),
    );

    panel.add(
        switchRow({
            settings: gioSettings,
            key: 'panel-alert-on-problems',
            title: _('Flag open problems on the icon'),
            subtitle: _('A dot on the ring, in the colour of the worst unacknowledged problem.'),
        }),
    );

    // ── dropdown behaviour ───────────────────────────────────────────────
    const dropdown = new Adw.PreferencesGroup({ title: _('Dropdown') });
    page.add(dropdown);

    dropdown.add(
        switchRow({
            settings: gioSettings,
            key: 'open-on-hover',
            title: _('Open on hover'),
            subtitle: _('Hover the panel icon instead of clicking it.'),
        }),
    );

    dropdown.add(
        spinRow({
            settings: gioSettings,
            key: 'hover-open-delay-ms',
            title: _('Hover delay'),
            subtitle: _('Milliseconds the pointer must rest before opening.'),
            min: HOVER_DELAY_MIN,
            max: HOVER_DELAY_MAX,
            step: 20,
            suffix: 'ms',
        }),
    );

    dropdown.add(
        spinRow({
            settings: gioSettings,
            key: 'hover-close-delay-ms',
            title: _('Close delay'),
            subtitle: _('Grace period before closing after the pointer leaves.'),
            min: HOVER_DELAY_MIN,
            max: HOVER_DELAY_MAX,
            step: 20,
            suffix: 'ms',
        }),
    );

    dropdown.add(
        switchRow({
            settings: gioSettings,
            key: 'pin-on-open',
            title: _('Keep open until dismissed'),
            subtitle: _('Ignore the hover close timer; close with Escape or a click elsewhere.'),
        }),
    );

    // ── visuals ──────────────────────────────────────────────────────────
    const visuals = new Adw.PreferencesGroup({ title: _('Visuals') });
    page.add(visuals);

    visuals.add(
        comboRow({
            settings: gioSettings,
            key: 'density',
            title: _('Density'),
            subtitle: _('How much of a host fits on screen at once.'),
            options: DENSITIES.map((id) => ({ id, label: titleCase(id) })),
        }),
    );

    visuals.add(
        comboRow({
            settings: gioSettings,
            key: 'accent-colour',
            title: _('Accent'),
            subtitle: _('Applies to highlights and trend fills; severity colours stay fixed.'),
            options: ACCENT_IDS.map((id) => ({ id, label: ACCENTS[id].label })),
        }),
    );

    visuals.add(
        switchRow({
            settings: gioSettings,
            key: 'reduce-motion',
            title: _('Reduce motion'),
            subtitle: _('Disables the connecting pulse and the trend caret.'),
        }),
    );

    // ── diagnostics ──────────────────────────────────────────────────────
    const diagnostics = new Adw.PreferencesGroup({
        title: _('Diagnostics'),
        description: _('Use these when reporting a problem. No credential is ever logged.'),
    });
    page.add(diagnostics);

    diagnostics.add(
        switchRow({
            settings: gioSettings,
            key: 'debug-logging',
            title: _('Verbose logging'),
            subtitle: _(
                'Log every request to the journal: journalctl -f -o cat /usr/bin/gnome-shell',
            ),
        }),
    );

    diagnostics.add(
        infoRow({
            title: _('Extension version'),
            value: extensionVersion || '—',
        }),
    );

    diagnostics.add(
        infoRow({
            title: _('Poll interval'),
            subtitle: _('Configured on the Monitoring page.'),
            value: `${settings.pollIntervalSeconds}s`,
        }),
    );

    diagnostics.add(
        infoRow({
            title: _('Maximum interval'),
            subtitle: _('Background polling backs off up to this value after repeated failures.'),
            value: `${POLL_INTERVAL_MAX}s`,
        }),
    );

    return page;
}

/**
 * Metric id → label, for the panel metric picker.
 *
 * Duplicated from the catalog rather than imported so the panel list can stay
 * stable if a metric is later hidden from the widget grid.
 *
 * @param {string} id
 * @returns {string}
 */
function labelForMetric(id) {
    switch (id) {
        case 'cpu':
            return 'CPU';
        case 'memory':
            return 'Memory';
        case 'disk':
            return 'Disk';
        default:
            return id;
    }
}

/**
 * @param {string} value
 * @returns {string}
 */
function titleCase(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
