// severity.js — one vocabulary for "how bad is this", shared by tiles, the
// panel icon and notifications.
//
// Everything user-visible that can turn amber or red resolves through this
// module, so a threshold change can never make the panel disagree with the
// tile it summarizes. Pure functions only.

/** Display severity, ordered from calm to alarming. */
export const SEVERITY = Object.freeze({
    UNKNOWN: 'unknown',
    OK: 'ok',
    WARN: 'warn',
    CRIT: 'crit',
    /** Host is in a Zabbix maintenance window: suppress alarming, keep data. */
    MAINTENANCE: 'maintenance',
});

/** Rank used for `worstSeverity`; higher wins. */
const RANK = Object.freeze({
    [SEVERITY.OK]: 0,
    [SEVERITY.MAINTENANCE]: 0,
    [SEVERITY.UNKNOWN]: 1,
    [SEVERITY.WARN]: 2,
    [SEVERITY.CRIT]: 3,
});

/** CSS style class suffix for each severity, e.g. `zappix-sev-crit`. */
export function severityClass(severity) {
    return `zappix-sev-${severity}`;
}

/**
 * Sanitise a threshold pair from preferences.
 *
 * Guards against the two ways a hand-edited GSettings value breaks the model:
 * numbers outside 0..100 and a critical threshold at or below the warning one
 * (which would make "critical" unreachable). The invariant enforced is
 * `0 <= warn < crit <= 100`.
 *
 * @param {number} warn
 * @param {number} crit
 * @returns {{warn: number, crit: number}}
 */
export function sanitiseThresholds(warn, crit) {
    const clamp = (value, fallback) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return fallback;
        return Math.min(100, Math.max(0, numeric));
    };

    const safeWarn = clamp(warn, 75);
    let safeCrit = clamp(crit, 90);

    if (safeCrit <= safeWarn) {
        // Nudge critical above warning while staying inside the range; if
        // warning is already 100 there is no room, so critical becomes 100 and
        // warning drops — still a usable pair.
        safeCrit = Math.min(100, safeWarn + 1);
        if (safeCrit <= safeWarn) {
            return { warn: Math.max(0, safeCrit - 1), crit: safeCrit };
        }
    }

    return { warn: safeWarn, crit: safeCrit };
}

/**
 * Classify a percentage against the configured thresholds.
 *
 * Anything that is not a finite number is UNKNOWN rather than OK: a missing
 * measurement is not good news, and rendering it green is how a broken agent
 * goes unnoticed.
 *
 * @param {number|null|undefined} value
 * @param {{warn: number, crit: number}} thresholds
 * @param {string} [context] SEVERITY.MAINTENANCE to suppress alarm
 * @returns {string} one of SEVERITY
 */
export function classifyPercent(value, thresholds, context = '') {
    if (context === SEVERITY.MAINTENANCE) return SEVERITY.MAINTENANCE;

    // `Number('')` is 0, which would report a blank measurement as perfectly
    // healthy — the exact failure this guard exists to prevent.
    if (value === null || value === undefined || value === '') return SEVERITY.UNKNOWN;

    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return SEVERITY.UNKNOWN;

    const { warn, crit } = thresholds;
    if (numeric >= crit) return SEVERITY.CRIT;
    if (numeric >= warn) return SEVERITY.WARN;
    return SEVERITY.OK;
}

/**
 * Classify a Zabbix problem severity (0..5).
 *
 * Zabbix's own scale maps cleanly onto the dashboard's three levels:
 * information is not an alarm, warning/average are amber, high/disaster are
 * red. "Not classified" is treated as amber because an operator still opened
 * it deliberately.
 *
 * @param {number|string} zabbixSeverity
 * @returns {string} one of SEVERITY
 */
export function classifyProblemSeverity(zabbixSeverity) {
    const severity = Number.parseInt(String(zabbixSeverity ?? ''), 10);
    if (!Number.isInteger(severity)) return SEVERITY.UNKNOWN;
    if (severity <= 1) return SEVERITY.OK;
    if (severity <= 3) return SEVERITY.WARN;
    return SEVERITY.CRIT;
}

/**
 * Worst of several severities.
 *
 * @param {Array<string|undefined|null>} severities
 * @returns {string} SEVERITY.OK when the list is empty
 */
export function worstSeverity(severities) {
    let worst = SEVERITY.OK;
    for (const severity of severities ?? []) {
        if (!severity) continue;
        const rank = RANK[severity] ?? 0;
        if (rank > (RANK[worst] ?? 0)) worst = severity;
    }
    return worst;
}

/**
 * Is this severity worth interrupting the user for?
 *
 * @param {string} severity
 * @returns {boolean}
 */
export function isAlarming(severity) {
    return severity === SEVERITY.CRIT || severity === SEVERITY.WARN;
}

/**
 * Sort key for a server or host row: the most alarming thing floats up.
 *
 * @param {string} severity
 * @returns {number} lower is more urgent
 */
export function urgency(severity) {
    return 3 - (RANK[severity] ?? 0);
}
