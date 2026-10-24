// serverPoller.js — one complete poll of one Zabbix server.
//
// This is the "backend" of the dashboard expressed as a single function: probe,
// fetch, normalise, return. It is deliberately separate from the timer that
// drives it so the same code path serves the scheduled poll, the refresh button
// and the preferences window's live preview.
//
// Two modes:
//   panel — hosts + items + problems. One round trip per category, no history.
//           This is what runs on the interval while the dropdown is closed.
//   full  — the above plus a batched history query for the sparklines. Only
//           runs when a human can see the curves.
//
// Failures are not caught here: the caller folds them into the previous
// snapshot so last-good values survive a transient outage.

import {
    normaliseHost,
    normaliseSeriesRows,
    buildHostSnapshot,
    orderHosts,
    summariseProblems,
} from '../model/normalize.js';

/** What a poll should fetch. */
export const POLL_MODE = Object.freeze({
    /** Cheap: headline values and problem count. */
    PANEL: 'panel',
    /** Full: adds history for the sparklines. */
    FULL: 'full',
});

/**
 * Poll one server and build its snapshot payload.
 *
 * @param {object} options
 * @param {import('../api/zabbixClient.js').ZabbixClient} options.client
 * @param {object} options.server sanitised server definition
 * @param {object[]} options.metrics catalog entries to resolve
 * @param {{warn: number, crit: number}} options.thresholds
 * @param {number} [options.maxHosts=20]
 * @param {number} [options.historyWindowMinutes=60]
 * @param {string} [options.mode=POLL_MODE.PANEL]
 * @param {number} [options.nowSeconds]
 * @param {number} [options.staleAfterSeconds=300] silence that counts as stale
 * @returns {Promise<{hosts: object[], problems: object, version: string}>}
 */
export async function pollServer({
    client,
    server,
    metrics,
    thresholds,
    maxHosts = 20,
    historyWindowMinutes = 60,
    mode = POLL_MODE.PANEL,
    nowSeconds = Date.now() / 1000,
    staleAfterSeconds = 300,
}) {
    // `probe()` is cached after the first call; asking every poll would double
    // the request count for a value that changes once per server upgrade.
    const version = client.version || (await client.probe());

    const rawHosts = await client.getHosts({
        limit: maxHosts,
        hostFilter: server.hostFilter ?? '',
    });

    const hosts = rawHosts.map(normaliseHost).filter(Boolean);

    if (hosts.length === 0) {
        return { hosts: [], problems: summariseProblems([]), version };
    }

    const hostIds = hosts.map((host) => host.hostId);

    // Items and problems are independent; fetching them together halves the
    // latency of an open-the-dropdown refresh.
    const [items, rawProblems] = await Promise.all([
        client.getItems({ hostIds, metrics }),
        client.getProblems({ hostIds, limit: 50 }).catch(() => []),
    ]);

    let seriesByItemId = null;
    if (mode === POLL_MODE.FULL) {
        try {
            const rows = await client.getHistory({
                items,
                windowMinutes: historyWindowMinutes,
                nowSeconds,
            });
            seriesByItemId = normaliseSeriesRows(rows);
        } catch {
            // Sparklines are decorative; the tiles are not. A history failure
            // degrades to "no curve" and never fails the poll.
            seriesByItemId = new Map();
        }
    }

    // A host whose newest reading is older than a few poll cycles has stopped
    // reporting, whatever its interface availability claims.
    const staleAfter = Math.max(120, staleAfterSeconds);

    const snapshots = hosts.map((host) => {
        const snapshot = buildHostSnapshot({ host, items, metrics, thresholds, seriesByItemId });
        return {
            ...snapshot,
            stale: snapshot.collectedAt > 0 && nowSeconds - snapshot.collectedAt > staleAfter,
        };
    });

    return {
        hosts: orderHosts(snapshots),
        problems: summariseProblems(rawProblems),
        version,
    };
}
