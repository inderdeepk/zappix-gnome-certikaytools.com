// notificationPolicy.js — decides *whether* a desktop notification is owed.
//
// Notifications are the one place this extension can interrupt the user, so the
// decision is deliberately separated from the delivery mechanism:
//
//   • only genuinely new information is announced (a problem id that was not
//     present on the previous poll, or a metric that just crossed the critical
//     threshold);
//   • a sustained alert is announced once, then muted for the cooldown period;
//   • recovery is summarised rather than announced per item.
//
// Pure module: it holds state, but only plain JS state — no GLib, no MessageTray
// — so every rule below is unit-tested, and a bug here cannot spam the desktop
// during a debugging session.

/** Notification urgency levels, mapped by the caller onto MessageTray. */
export const URGENCY = Object.freeze({
    LOW: 'low',
    NORMAL: 'normal',
    HIGH: 'high',
});

/**
 * Stateful policy object. One per extension instance.
 */
export class NotificationPolicy {
    /**
     * @param {object} [options]
     * @param {number} [options.cooldownMinutes=15]
     */
    constructor({ cooldownMinutes = 15 } = {}) {
        this._cooldownSeconds = Math.max(60, Math.round(cooldownMinutes * 60));

        /** @type {Map<string, Set<string>>} serverId → problem event ids */
        this._knownProblems = new Map();
        /** @type {Map<string, number>} notification key → last sent (unix seconds) */
        this._lastSent = new Map();
        /** @type {Map<string, string>} serverId:hostId:metricId → last severity */
        this._lastSeverity = new Map();
        /** Servers seen at least once; the first poll is never an "escalation". */
        this._primed = new Set();
    }

    /**
     * Update the cooldown after a settings change.
     *
     * @param {number} cooldownMinutes
     */
    setCooldownMinutes(cooldownMinutes) {
        this._cooldownSeconds = Math.max(60, Math.round(cooldownMinutes * 60));
    }

    /**
     * Drop all memory. Called when monitoring stops so a re-enable does not
     * replay stale comparisons.
     */
    reset() {
        this._knownProblems.clear();
        this._lastSent.clear();
        this._lastSeverity.clear();
        this._primed.clear();
    }

    /**
     * Evaluate the current snapshots and return what to announce.
     *
     * @param {object[]} snapshots server snapshots
     * @param {object} options
     * @param {boolean} options.notifyOnNewProblems
     * @param {boolean} options.notifyOnCritical
     * @param {number} options.nowSeconds
     * @returns {Array<{key:string, title:string, body:string, urgency:string}>}
     */
    evaluate(snapshots, { notifyOnNewProblems, notifyOnCritical, nowSeconds }) {
        const notifications = [];

        for (const snapshot of snapshots ?? []) {
            // A server we have never polled successfully has no baseline; its
            // first dataset is not "new".
            const wasPrimed = this._primed.has(snapshot.serverId);
            if (snapshot.status !== 'ok') continue;

            if (notifyOnNewProblems) {
                notifications.push(...this._collectNewProblems(snapshot, wasPrimed, nowSeconds));
            }
            if (notifyOnCritical) {
                notifications.push(...this._collectEscalations(snapshot, nowSeconds));
            }

            this._primed.add(snapshot.serverId);
        }

        return notifications;
    }

    /**
     * @param {object} snapshot
     * @param {boolean} wasPrimed
     * @param {number} nowSeconds
     * @returns {Array<object>}
     */
    _collectNewProblems(snapshot, wasPrimed, nowSeconds) {
        const seen = this._knownProblems.get(snapshot.serverId) ?? new Set();
        const current = new Set((snapshot.problems?.items ?? []).map((problem) => problem.eventId));

        // The snapshot only carries the top few problems, so a shrinking set
        // means "no longer listed", not "resolved" — only additions are safe
        // to announce.
        const added = [...current].filter((eventId) => !seen.has(eventId));

        this._knownProblems.set(snapshot.serverId, current);

        // Prime the baseline without announcing: on the first poll every
        // pre-existing problem would otherwise look brand new.
        if (!wasPrimed) {
            // Still record ids so a *changed* problem set is detected next time.
            return [];
        }

        const key = `problems:${snapshot.serverId}`;
        if (!this._maySend(key, nowSeconds)) return [];
        if (added.length === 0) return [];

        const severityCode = Math.max(
            ...(snapshot.problems?.items ?? [])
                .filter((problem) => added.includes(problem.eventId))
                .map((problem) => problem.severityCode),
            0,
        );

        const first = (snapshot.problems?.items ?? []).find((problem) =>
            added.includes(problem.eventId),
        );

        this._markSent(key, nowSeconds);

        return [
            {
                key,
                title:
                    added.length === 1
                        ? `${snapshot.label}: new problem`
                        : `${snapshot.label}: ${added.length} new problems`,
                body:
                    added.length === 1
                        ? (first?.name ?? '')
                        : first?.name
                          ? `${first.name} (+${added.length - 1} more)`
                          : '',
                urgency: severityCode >= 4 ? URGENCY.HIGH : URGENCY.NORMAL,
            },
        ];
    }

    /**
     * @param {object} snapshot
     * @param {number} nowSeconds
     * @returns {Array<object>}
     */
    _collectEscalations(snapshot, nowSeconds) {
        const notifications = [];

        for (const host of snapshot.hosts ?? []) {
            for (const metric of host.metrics ?? []) {
                const key = `${snapshot.serverId}:${host.hostId}:${metric.id}`;
                const previous = this._lastSeverity.get(key);
                this._lastSeverity.set(key, metric.severity);

                // Only the transition *into* critical is announced; staying
                // critical is silent until the cooldown lapses.
                if (metric.severity !== 'crit') continue;
                if (previous === 'crit') continue;
                if (!this._maySend(key, nowSeconds)) continue;

                this._markSent(key, nowSeconds);
                notifications.push({
                    key,
                    title: `${host.name}: ${metric.label} critical`,
                    body: `${metric.label} is above the critical threshold.`,
                    urgency: URGENCY.HIGH,
                });
            }
        }

        return notifications;
    }

    /**
     * @param {string} key
     * @param {number} nowSeconds
     * @returns {boolean}
     */
    _maySend(key, nowSeconds) {
        const last = this._lastSent.get(key);
        if (last === undefined) return true;
        return nowSeconds - last >= this._cooldownSeconds;
    }

    /**
     * @param {string} key
     * @param {number} nowSeconds
     */
    _markSent(key, nowSeconds) {
        this._lastSent.set(key, nowSeconds);
    }
}
