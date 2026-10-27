// settings.js — the only module that touches GSettings directly.
//
// Everything above this layer asks for a *typed, already-clamped* value
// (`settings.pollIntervalSeconds`, `settings.thresholds`), never a raw key.
// That separation matters for three reasons:
//   • A schema key renamed between releases degrades to its default instead of
//     throwing inside the shell process.
//   • Ranges are enforced once, so no caller can accidentally schedule a
//     1-second poll against a production Zabbix server.
//   • The pure model code stays testable: tests construct a plain options
//     object with the same shape, no GSettings backend required.
//
// This module is shell-side (imports Gio) and is excluded from the plain-gjs
// import smoke test.

import { ACCENT_IDS, DENSITIES, PANEL_METRICS } from './appearance.js';
import { METRIC_IDS, resolveEnabledMetrics } from '../model/metricCatalog.js';
import { sanitiseThresholds } from '../model/severity.js';
import { AUTH_MODE, MAX_SERVERS, parseServers, serialiseServers } from './serverStore.js';

/** Poll interval bounds, in seconds. The floor protects the Zabbix server. */
export const POLL_INTERVAL_MIN = 10;
export const POLL_INTERVAL_MAX = 3600;

/** Sparkline window bounds, in minutes (5 minutes → 7 days). */
export const HISTORY_WINDOW_MIN = 5;
export const HISTORY_WINDOW_MAX = 10080;

/** Request timeout bounds, in seconds. */
export const TIMEOUT_MIN = 3;
export const TIMEOUT_MAX = 120;

/** Hosts per server bounds. */
export const MAX_HOSTS_MIN = 1;
export const MAX_HOSTS_MAX = 200;

/** Hover delay bounds, in milliseconds. */
export const HOVER_DELAY_MIN = 0;
export const HOVER_DELAY_MAX = 2000;

/** Notification cooldown bounds, in minutes. */
export const COOLDOWN_MIN = 1;
export const COOLDOWN_MAX = 1440;

/**
 * Clamp an integer into a range, falling back when unset.
 *
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
    const numeric = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isInteger(numeric)) return fallback;
    return Math.min(max, Math.max(min, numeric));
}

/**
 * Typed façade over the extension's Gio.Settings.
 *
 * Construct with the result of `Extension.getSettings()`. Every getter is
 * side-effect free; `set*` methods write only when the value actually changes,
 * which keeps change signals meaningful.
 */
export class ZappixSettings {
    /**
     * @param {Gio.Settings} gioSettings
     */
    constructor(gioSettings) {
        this._settings = gioSettings;
    }

    /**
     * Escape hatch for the preferences pages, which bind widgets directly to
     * keys. Never exposed to the shell-side UI.
     *
     * @returns {Gio.Settings}
     */
    get raw() {
        return this._settings;
    }

    /** @returns {any} raw value, or undefined when the key is absent */
    _get(key) {
        try {
            return this._settings.get_value(key).deepUnpack();
        } catch (error) {
            // A missing key (older schema, hand-edited XML) must not kill the
            // extension; callers always have a default.
            logError(error, `Zappix: settings key "${key}" unavailable`);
            return undefined;
        }
    }
    /** @returns {boolean} */
    get openOnHover() {
        return this._bool('open-on-hover', true);
    }

    /** @returns {number} */
    get hoverOpenDelayMs() {
        return clampInt(this._get('hover-open-delay-ms'), HOVER_DELAY_MIN, HOVER_DELAY_MAX, 220);
    }

    /** @returns {number} */
    get hoverCloseDelayMs() {
        return clampInt(this._get('hover-close-delay-ms'), HOVER_DELAY_MIN, HOVER_DELAY_MAX, 360);
    }

    /** @returns {boolean} */
    get pinOnOpen() {
        return this._bool('pin-on-open', false);
    }

    /** @returns {number} seconds */
    get pollIntervalSeconds() {
        return clampInt(
            this._get('poll-interval-seconds'),
            POLL_INTERVAL_MIN,
            POLL_INTERVAL_MAX,
            30,
        );
    }

    /** @returns {number} minutes */
    get historyWindowMinutes() {
        return clampInt(
            this._get('history-window-minutes'),
            HISTORY_WINDOW_MIN,
            HISTORY_WINDOW_MAX,
            1440,
        );
    }

    /** @returns {number} seconds */
    get timeoutSeconds() {
        return clampInt(this._get('timeout-seconds'), TIMEOUT_MIN, TIMEOUT_MAX, 10);
    }

    /** @returns {number} */
    get maxHostsPerServer() {
        return clampInt(this._get('max-hosts-per-server'), MAX_HOSTS_MIN, MAX_HOSTS_MAX, 20);
    }

    /** @returns {boolean} */
    get insecureTls() {
        return this._bool('insecure-tls', false);
    }

    /** @returns {object[]} metric catalog entries in catalog order */
    get enabledMetrics() {
        return resolveEnabledMetrics(this._get('metrics-enabled'));
    }

    /** @returns {string[]} */
    get enabledMetricIds() {
        return this.enabledMetrics.map((metric) => metric.id);
    }

    /** @returns {{warn:number, crit:number}} */
    get thresholds() {
        return sanitiseThresholds(this._get('warn-threshold'), this._get('critical-threshold'));
    }

    /** @returns {boolean} */
    get showPanelValue() {
        return this._bool('show-panel-value', true);
    }

    /** @returns {string} one of PANEL_METRICS */
    get panelMetric() {
        const value = String(this._get('panel-metric') ?? 'cpu');
        return PANEL_METRICS.includes(value) ? value : PANEL_METRICS[0];
    }

    /** @returns {boolean} */
    get panelAlertOnProblems() {
        return this._bool('panel-alert-on-problems', true);
    }

    /** @returns {string} one of DENSITIES */
    get density() {
        const value = String(this._get('density') ?? 'comfortable');
        return DENSITIES.includes(value) ? value : 'comfortable';
    }

    /** @returns {string} one of ACCENT_IDS */
    get accentColour() {
        const value = String(this._get('accent-colour') ?? 'aurora');
        return ACCENT_IDS.includes(value) ? value : ACCENT_IDS[0];
    }

    /** @returns {boolean} */
    get reduceMotion() {
        return this._bool('reduce-motion', false);
    }

    /** @returns {boolean} */
    get notifyOnCritical() {
        return this._bool('notify-on-critical', false);
    }

    /** @returns {boolean} */
    get notifyOnNewProblems() {
        return this._bool('notify-on-new-problems', true);
    }

    /** @returns {number} minutes */
    get notificationCooldownMinutes() {
        return clampInt(this._get('notification-cooldown-minutes'), COOLDOWN_MIN, COOLDOWN_MAX, 15);
    }

    /** @returns {boolean} */
    get debugLogging() {
        return this._bool('debug-logging', false);
    }

    /** @returns {string} */
    get activeServerId() {
        return String(this._get('active-server-id') ?? '');
    }

    /**
     * @param {string} id
     */
    set activeServerId(id) {
        this._setString('active-server-id', String(id ?? ''));
    }

    /**
     * Parsed server list.
     *
     * @returns {{servers: object[], recovered: boolean, error: string}}
     */
    get serverDocument() {
        return parseServers(String(this._get('servers') ?? '[]'));
    }

    /** @returns {object[]} */
    get servers() {
        return this.serverDocument.servers;
    }

    /**
     * Counter bumped by the preferences window after a credential write.
     *
     * A token-only save does not change the *servers* JSON, so without a
     * second signal a running extension would keep the credential it read at
     * startup until the next login.
     *
     * @returns {number}
     */
    get credentialsRevision() {
        const value = Number(this._get('credentials-revision'));
        return Number.isInteger(value) && value >= 0 ? value : 0;
    }

    /**
     * Tell the shell process that a stored credential changed.
     */
    bumpCredentialsRevision() {
        try {
            this._settings.set_uint('credentials-revision', this.credentialsRevision + 1);
        } catch (error) {
            logError(error, 'Zappix: cannot bump "credentials-revision"');
        }
    }

    /**
     * Persist a server list after validating it.
     *
     * @param {object[]} servers
     */
    set servers(servers) {
        const trimmed = (servers ?? []).slice(0, MAX_SERVERS);
        const serialised = serialiseServers(trimmed);
        if (serialised === String(this._get('servers') ?? '')) return;
        this._setString('servers', serialised);
    }

    /**
     * Connect to one key's change signal.
     *
     * @param {string} key
     * @param {() => void} callback
     * @returns {number} handler id to pass to `disconnect`
     */
    connectChanged(key, callback) {
        try {
            return this._settings.connect(`changed::${key}`, callback);
        } catch {
            return 0;
        }
    }

    /**
     * @param {number} handlerId
     */
    disconnect(handlerId) {
        if (!handlerId) return;
        try {
            this._settings.disconnect(handlerId);
        } catch {
            // Already disconnected — harmless.
        }
    }

    /**
     * Read a boolean key without throwing.
     *
     * @param {string} key
     * @param {boolean} fallback
     * @returns {boolean}
     */
    _bool(key, fallback) {
        const value = this._get(key);
        return typeof value === 'boolean' ? value : fallback;
    }

    /**
     * Write a string key only when it differs.
     *
     * @param {string} key
     * @param {string} value
     */
    _setString(key, value) {
        try {
            if (this._settings.get_string(key) === value) return;
            this._settings.set_string(key, value);
        } catch (error) {
            logError(error, `Zappix: cannot write settings key "${key}"`);
        }
    }
}

/**
 * Auth-mode values accepted by the preferences UI.
 *
 * Re-exported so prefs modules do not have to reach into serverStore.
 */
export { AUTH_MODE, METRIC_IDS };
