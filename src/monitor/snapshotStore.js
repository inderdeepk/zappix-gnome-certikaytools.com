// snapshotStore.js — the in-memory state the dashboard renders (pure).
//
// One snapshot per server, replaced wholesale on every successful poll. Keeping
// this as plain data rather than letting widgets hold their own copies buys two
// things the UI depends on:
//
//   • The panel indicator and the open dropdown read the *same* object, so the
//     number next to the icon can never disagree with the card it summarizes.
//   • A failed poll keeps the previous values and merely marks them stale. A
//     dashboard that blanks out on one dropped packet is useless during exactly
//     the incident it exists for.
//
// Pure module: no timers, no I/O, no GI imports.

import { SEVERITY, worstSeverity } from '../model/severity.js';
import { VALUE_KIND } from '../model/metricCatalog.js';
import { formatMetricValue, formatMetricValueCompact } from '../shared/format.js';

/** Server-level connection state, distinct from metric severity. */
export const SERVER_STATUS = Object.freeze({
    /** No credential or URL yet — the card explains what to configure. */
    UNCONFIGURED: 'unconfigured',
    /** Never polled successfully in this session. */
    LOADING: 'loading',
    /** Last poll succeeded. */
    OK: 'ok',
    /** Last poll failed; `hosts` still holds the previous values. */
    ERROR: 'error',
});

/** How long an untouched snapshot may keep counting as "current". */
export const STALE_AFTER_SECONDS = 180;

/**
 * Empty state for a newly configured server.
 *
 * @param {object} server sanitised server definition
 * @returns {object}
 */
export function initialSnapshot(server) {
    return {
        serverId: server.id,
        label: server.label,
        colour: server.colour,
        baseUrl: server.baseUrl,
        authMode: server.authMode,
        status: SERVER_STATUS.LOADING,
        error: '',
        errorKind: '',
        version: '',
        fetchedAt: 0,
        consecutiveFailures: 0,
        hosts: [],
        problems: emptyProblems(),
        hostCount: 0,
    };
}

/** @returns {object} */
function emptyProblems() {
    return {
        total: 0,
        unacknowledged: 0,
        worstSeverity: SEVERITY.OK,
        oldestClock: 0,
        items: [],
    };
}

/**
 * Build a snapshot from a successful poll.
 *
 * @param {object} options
 * @param {object} options.server
 * @param {object[]} options.hosts host snapshots
 * @param {object} [options.problems] summarised problems
 * @param {string} [options.version]
 * @param {number} options.fetchedAt unix seconds
 * @returns {object}
 */
export function successSnapshot({ server, hosts, problems, version = '', fetchedAt }) {
    const problemSummary = problems ?? emptyProblems();
    const list = Array.isArray(hosts) ? hosts : [];

    return {
        ...initialSnapshot(server),
        status: SERVER_STATUS.OK,
        version,
        fetchedAt,
        consecutiveFailures: 0,
        hosts: list,
        hostCount: list.length,
        problems: problemSummary,
        // A server-level status that combines infrastructure health with the
        // worst metric it reported, so the switcher can rank servers by urgency.
        worstSeverity: worstSeverity([
            problemSummary.worstSeverity,
            ...list.map((host) => host.worstSeverity),
        ]),
    };
}

/**
 * Fold a failure into an existing snapshot, preserving the last good data.
 *
 * @param {object} previous snapshot returned by `initialSnapshot`/`successSnapshot`
 * @param {object} options
 * @param {string} options.message
 * @param {string} [options.kind]
 * @param {number} options.fetchedAt
 * @returns {object}
 */
export function failureSnapshot(previous, { message, kind = '', fetchedAt }) {
    return {
        ...previous,
        status: SERVER_STATUS.ERROR,
        error: String(message ?? 'Unknown error'),
        errorKind: String(kind ?? ''),
        // `fetchedAt` intentionally stays at the last *successful* fetch: the
        // card's "updated 4 min ago" must not reset just because a poll failed.
        lastAttemptAt: fetchedAt,
        consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
    };
}

/**
 * Is the snapshot too old to be presented as current?
 *
 * @param {object} snapshot
 * @param {number} nowSeconds
 * @param {number} [staleAfter=STALE_AFTER_SECONDS]
 * @returns {boolean}
 */
export function isStale(snapshot, nowSeconds, staleAfter = STALE_AFTER_SECONDS) {
    if (!snapshot?.fetchedAt) return true;
    return nowSeconds - snapshot.fetchedAt > staleAfter;
}

/**
 * Snapshot for "the credential store is not answering yet".
 *
 * Distinct from UNCONFIGURED: the user's setup is fine, the keyring merely
 * could not be read (locked at login, unlock prompt timed out, daemon still
 * starting). The previous data is kept and the status stays LOADING so the
 * poller can retry without accusing the user of not having configured a
 * token.
 *
 * @param {object} previous snapshot from `initialSnapshot`/`failureSnapshot`
 * @param {string} message short explanation for the card
 * @returns {object}
 */
export function credentialWaitSnapshot(previous, message) {
    return {
        ...previous,
        status: SERVER_STATUS.LOADING,
        error: String(message ?? ''),
        errorKind: 'credentials',
    };
}

/**
 * Order servers for display: alarms first, then healthy, then unreachable.
 *
 * Within a group the configured order is preserved, because an operator's own
 * ordering is a signal ("prod first") that alphabetical sorting destroys.
 *
 * @param {object[]} snapshots
 * @returns {object[]}
 */
export function orderSnapshots(snapshots) {
    // Alarm first, healthy next, unreachable last. Within a band the caller's
    // ordering is preserved, because "prod first" is information.
    const weight = (snapshot) => {
        if (snapshot.status === SERVER_STATUS.ERROR) return 3;
        if (snapshot.worstSeverity === SEVERITY.CRIT) return 0;
        if (snapshot.worstSeverity === SEVERITY.WARN) return 1;
        return 2;
    };

    return (snapshots ?? [])
        .map((snapshot, index) => ({ snapshot, index, weight: weight(snapshot) }))
        .sort((left, right) => left.weight - right.weight || left.index - right.index)
        .map((entry) => entry.snapshot);
}

/**
 * Everything the panel gauge draws, derived from one snapshot.
 *
 * The panel is a single ring: its arc is the chosen metric (`fraction`,
 * coloured by `severity`), the number beside it is `text`, and open problems
 * are a separate `badge` notched into the rim. Keeping problems out of the
 * metric's colour is deliberate — a red "6%" reads as "CPU is critical", which
 * is exactly wrong when the CPU is idle and a disk trigger fired.
 *
 * @param {object} options
 * @param {object|null} options.activeSnapshot the server shown in the dropdown
 * @param {string} options.metric `cpu` | `memory` | `disk` | `problems`
 * @param {boolean} [options.alertOnProblems=true] badge unacknowledged problems
 * @returns {{
 *   text: string,
 *   severity: string,
 *   available: boolean,
 *   problemCount: number,
 *   fraction: number|null,
 *   badge: string|null,
 *   offline: boolean,
 *   label: string,
 * }}
 *   `fraction` is the arc fill in 0..1, or null for an empty track;
 *   `badge` is the problem severity to mark, or null; `offline` means the
 *   last poll failed and the values are the last good ones.
 */
export function panelSummary({ activeSnapshot, metric, alertOnProblems = true }) {
    const label = metric === 'problems' ? 'Open problems' : '';
    const nothing = {
        text: '',
        severity: SEVERITY.UNKNOWN,
        available: false,
        problemCount: 0,
        fraction: null,
        badge: null,
        offline: activeSnapshot?.status === SERVER_STATUS.ERROR,
        label,
    };

    // Never measured: an empty problem list here is "not asked yet", not "all
    // clear", and must not draw a full green ring.
    if (
        !activeSnapshot ||
        activeSnapshot.status === SERVER_STATUS.UNCONFIGURED ||
        !activeSnapshot.fetchedAt
    ) {
        return nothing;
    }

    const offline = activeSnapshot.status === SERVER_STATUS.ERROR;
    const problemCount = activeSnapshot.problems?.unacknowledged ?? 0;
    const rawProblemSeverity = activeSnapshot.problems?.worstSeverity ?? SEVERITY.OK;
    // An operator-visible problem is never "fine", whatever Zabbix classed it.
    const problemSeverity =
        problemCount > 0 && rawProblemSeverity === SEVERITY.OK ? SEVERITY.WARN : rawProblemSeverity;

    if (metric === 'problems') {
        return {
            text: problemCount > 0 ? String(problemCount) : '',
            severity: problemCount > 0 ? problemSeverity : SEVERITY.OK,
            available: true,
            problemCount,
            // A closed ring: green when clear, amber/red when not.
            fraction: 1,
            badge: null,
            offline,
            label,
        };
    }

    const host = activeSnapshot.hosts?.[0];
    const metricView = host?.metrics?.find((entry) => entry.id === metric);
    const badge = alertOnProblems && problemCount > 0 ? problemSeverity : null;

    if (!metricView || metricView.value === null || metricView.value === undefined) {
        return { ...nothing, problemCount, badge, offline, label: metricView?.label ?? '' };
    }

    return {
        text: formatMetricValueCompact(metricView.kind, metricView.value),
        severity: metricView.severity,
        available: true,
        problemCount,
        fraction: gaugeFraction(metricView),
        badge,
        offline,
        label: metricView.label ?? '',
    };
}

/**
 * Arc fill for a metric: its percentage, or a closed ring for non-percentage
 * metrics, whose colour still carries the severity.
 *
 * @param {{kind: string, value: number}} metricView
 * @returns {number|null}
 */
function gaugeFraction(metricView) {
    if (metricView.kind !== VALUE_KIND.PERCENT) return 1;
    const numeric = Number(metricView.value);
    if (!Number.isFinite(numeric)) return null;
    return Math.min(1, Math.max(0, numeric / 100));
}

/**
 * One-line description of a server card's header, e.g. `4 hosts · 2 problems`.
 *
 * @param {object} snapshot
 * @param {(singular: string, plural: string, count: number) => string} [pluralise]
 * @returns {string}
 */
export function describeServer(
    snapshot,
    pluralise = (singular, plural, count) => (count === 1 ? singular : plural),
) {
    if (snapshot.status === SERVER_STATUS.UNCONFIGURED) return 'Not configured';
    if (snapshot.status === SERVER_STATUS.LOADING) {
        // A locked keyring is not a connection attempt; saying "Connecting…"
        // hides the actual reason the panel is empty.
        if (snapshot.errorKind === 'credentials' && snapshot.error) return snapshot.error;
        return 'Connecting…';
    }
    if (snapshot.status === SERVER_STATUS.ERROR && snapshot.hosts.length === 0) {
        return snapshot.error || 'Unreachable';
    }

    const parts = [`${snapshot.hostCount} ${pluralise('host', 'hosts', snapshot.hostCount)}`];
    const problems = snapshot.problems?.total ?? 0;
    if (problems > 0) {
        parts.push(`${problems} ${pluralise('problem', 'problems', problems)}`);
    }
    return parts.join(' · ');
}

/**
 * Human headline for a metric tile.
 *
 * Trivial wrapper that exists so widgets depend on one function instead of
 * importing the formatter table directly — the same call the accessibility
 * label uses, which keeps the visible text and the spoken text identical.
 *
 * @param {object} metricView
 * @returns {string}
 */
export function metricHeadline(metricView) {
    return formatMetricValue(metricView.kind, metricView.value);
}
