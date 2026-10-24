// prefs/monitoringPage.js — polling, thresholds, metrics and notifications.
//
// Grouped the way an operator thinks about it: *how often does it check*, *what
// does it check*, *when does it shout*. Every control is exported from
// `settings.js` as a clamped accessor, so this page can present raw ranges
// without repeating the guards.
//
// Preferences-process module (Adw/Gtk).

import Adw from 'gi://Adw';

import { multiSwitchGroup, spinRow, switchRow } from './widgets.js';
import { METRICS } from '../../model/metricCatalog.js';
import {
    COOLDOWN_MAX,
    COOLDOWN_MIN,
    HISTORY_WINDOW_MAX,
    HISTORY_WINDOW_MIN,
    MAX_HOSTS_MAX,
    MAX_HOSTS_MIN,
    POLL_INTERVAL_MAX,
    POLL_INTERVAL_MIN,
    TIMEOUT_MAX,
    TIMEOUT_MIN,
} from '../../shared/settings.js';
import { gettext as _ } from '../../shared/i18n.js';

/**
 * Build the monitoring page.
 *
 * @param {object} options
 * @param {import('../../shared/settings.js').ZappixSettings} options.settings
 * @returns {Adw.PreferencesPage}
 */
export function buildMonitoringPage({ settings }) {
    const gioSettings = settings.raw;
    const page = new Adw.PreferencesPage({
        title: _('Monitoring'),
        icon_name: 'utilities-system-monitor-symbolic',
    });

    // ── polling ──────────────────────────────────────────────────────────
    const polling = new Adw.PreferencesGroup({
        title: _('Refresh'),
        description: _(
            'Opening the dropdown always refreshes immediately; these values control background polling.',
        ),
    });
    page.add(polling);
    polling.add(
        spinRow({
            settings: gioSettings,
            key: 'poll-interval-seconds',
            title: _('Refresh interval'),
            subtitle: _('Seconds between background polls.'),
            min: POLL_INTERVAL_MIN,
            max: POLL_INTERVAL_MAX,
            step: 5,
        }),
    );
    polling.add(
        spinRow({
            settings: gioSettings,
            key: 'timeout-seconds',
            title: _('Request timeout'),
            subtitle: _('Seconds before a request is abandoned.'),
            min: TIMEOUT_MIN,
            max: TIMEOUT_MAX,
        }),
    );
    polling.add(
        spinRow({
            settings: gioSettings,
            key: 'history-window-minutes',
            title: _('Trend window'),
            subtitle: _('Minutes of history drawn behind each tile.'),
            min: HISTORY_WINDOW_MIN,
            max: HISTORY_WINDOW_MAX,
            step: 15,
        }),
    );
    polling.add(
        spinRow({
            settings: gioSettings,
            key: 'max-hosts-per-server',
            title: _('Hosts per server'),
            subtitle: _('Upper limit on hosts fetched from each server.'),
            min: MAX_HOSTS_MIN,
            max: MAX_HOSTS_MAX,
            step: 1,
        }),
    );

    // ── metrics ──────────────────────────────────────────────────────────
    page.add(
        multiSwitchGroup({
            settings: gioSettings,
            key: 'metrics-enabled',
            title: _('Visible metrics'),
            items: METRICS.map((metric) => ({
                id: metric.id,
                label: _(metric.label),
                subtitle: metric.sparkline ? '' : _('Shown without a trend line.'),
            })),
        }),
    );

    // ── thresholds ───────────────────────────────────────────────────────
    const thresholds = new Adw.PreferencesGroup({
        title: _('Thresholds'),
        description: _('Utilization above these percentages changes the tile colour.'),
    });
    page.add(thresholds);
    thresholds.add(
        spinRow({
            settings: gioSettings,
            key: 'warn-threshold',
            title: _('Warning at'),
            min: 1,
            max: 99,
            suffix: '%',
        }),
    );
    thresholds.add(
        spinRow({
            settings: gioSettings,
            key: 'critical-threshold',
            title: _('Critical at'),
            min: 2,
            max: 100,
            suffix: '%',
        }),
    );

    // ── notifications ────────────────────────────────────────────────────
    const notifications = new Adw.PreferencesGroup({
        title: _('Notifications'),
        description: _('Desktop notifications are only sent while the dropdown is closed.'),
    });
    page.add(notifications);
    notifications.add(
        switchRow({
            settings: gioSettings,
            key: 'notify-on-new-problems',
            title: _('New problems'),
            subtitle: _('Notify when a server reports a problem that was not there before.'),
        }),
    );
    notifications.add(
        switchRow({
            settings: gioSettings,
            key: 'notify-on-critical',
            title: _('Critical utilization'),
            subtitle: _('Notify when a host crosses the critical threshold.'),
        }),
    );
    notifications.add(
        spinRow({
            settings: gioSettings,
            key: 'notification-cooldown-minutes',
            title: _('Cooldown'),
            subtitle: _('Minimum minutes between repeated alerts for the same item.'),
            min: COOLDOWN_MIN,
            max: COOLDOWN_MAX,
            step: 5,
        }),
    );

    // ── network trust ────────────────────────────────────────────────────
    const trust = new Adw.PreferencesGroup({
        title: _('TLS'),
        description: _(
            'Certificate checks protect the API token in transit. Only relax them knowingly.',
        ),
    });
    page.add(trust);
    trust.add(
        switchRow({
            settings: gioSettings,
            key: 'insecure-tls',
            title: _('Allow untrusted certificates for all servers'),
            subtitle: _('Prefer per-server opt-in on the Servers page.'),
        }),
    );

    return page;
}

/**
 * Describe the metric catalog for the About page.
 *
 * @returns {string}
 */
export function describeMetricCoverage() {
    return METRICS.map((metric) => `${metric.label}: ${metric.candidates[0].search}`).join('\n');
}
