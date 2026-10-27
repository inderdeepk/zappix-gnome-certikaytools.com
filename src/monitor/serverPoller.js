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
//   full  — the above plus the curves behind the tiles: raw history for short
//           windows, hourly trends for a day or more, and the calendar-month
//           network total. Only runs when a human can see the tiles.
//
// Failures are not caught here: the caller folds them into the previous
// snapshot so last-good values survive a transient outage.

import {
    normaliseHost,
    normaliseSeriesRows,
    normaliseTrendBytes,
    normaliseTrendRows,
    buildHostSnapshot,
    orderHosts,
    selectItemsForMetric,
    summariseProblems,
} from '../model/normalize.js';
import { hourStartSeconds, monthStartSeconds } from '../model/series.js';

/** What a poll should fetch. */
export const POLL_MODE = Object.freeze({
    /** Cheap: headline values and problem count. */
    PANEL: 'panel',
    /** Full: adds history for the sparklines. */
    FULL: 'full',
});

/**
 * Windows longer than this come from hourly trends instead of raw history.
 *
 * The stock templates keep an hour of raw history per item, so a 24-hour
 * `history.get` returns one hour of curve — or truncates at the row cap and
 * shows the wrong hours. Trends cover the full window at 24 rows per item.
 */
export const TREND_MIN_WINDOW_MINUTES = 180;

/** How long a month's worth of network trends is reused, in milliseconds. */
const MONTHLY_TREND_TTL_MS = 30 * 60 * 1000;

/**
 * Row budget for the month query. One item is ~744 hours, and a host can have
 * a handful of interfaces in each direction.
 */
const MONTHLY_TREND_MAX_ROWS = 30000;

/**
 * Poll one server and build its snapshot payload.
 *
 * @param {object} options
 * @param {import('../api/zabbixClient.js').ZabbixClient} options.client
 * @param {object} options.server sanitised server definition
 * @param {object[]} options.metrics catalog entries to resolve
 * @param {{warn: number, crit: number}} options.thresholds
 * @param {number} [options.maxHosts=20]
 * @param {number} [options.historyWindowMinutes=1440]
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
    historyWindowMinutes = 1440,
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
    let monthlyBytesByItemId = null;
    if (mode === POLL_MODE.FULL) {
        try {
            seriesByItemId = await fetchSeries({ client, items, historyWindowMinutes, nowSeconds });
        } catch {
            // Sparklines are decorative; the tiles are not. A history failure
            // degrades to "no curve" and never fails the poll.
            seriesByItemId = new Map();
        }

        const monthlyItems = collectMonthlyItems(metrics, items);
        if (monthlyItems.length > 0) {
            try {
                monthlyBytesByItemId = await fetchMonthlyBytes({
                    client,
                    items: monthlyItems,
                    nowSeconds,
                });
            } catch {
                // The month total is a bonus line on one tile; losing it must
                // not cost the card its poll.
                monthlyBytesByItemId = null;
            }
        }
    }

    // A host whose newest reading is older than a few poll cycles has stopped
    // reporting, whatever its interface availability claims.
    const staleAfter = Math.max(120, staleAfterSeconds);

    const snapshots = hosts.map((host) => {
        const snapshot = buildHostSnapshot({
            host,
            items,
            metrics,
            thresholds,
            seriesByItemId,
            monthlyBytesByItemId,
        });
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

/**
 * Per-item series for the tile curves, from history or trends.
 *
 * @param {object} options
 * @param {import('../api/zabbixClient.js').ZabbixClient} options.client
 * @param {object[]} options.items
 * @param {number} options.historyWindowMinutes
 * @param {number} options.nowSeconds
 * @returns {Promise<Map<string, Array<{t:number, v:number}>>>}
 */
async function fetchSeries({ client, items, historyWindowMinutes, nowSeconds }) {
    if (historyWindowMinutes < TREND_MIN_WINDOW_MINUTES) {
        const rows = await client.getHistory({
            items,
            windowMinutes: historyWindowMinutes,
            nowSeconds,
        });
        return normaliseSeriesRows(rows);
    }

    const trendRows = await client.getTrends({
        items,
        fromSeconds: nowSeconds - historyWindowMinutes * 60,
        toSeconds: nowSeconds,
    });

    // Items with trend storage switched off (the stock templates set
    // `trends: 0` on a few) would otherwise lose their curve entirely; raw
    // history is the only source left for them.
    const covered = new Set(trendRows.map((row) => String(row?.itemid ?? '')));
    const uncovered = items.filter((item) => !covered.has(String(item.itemid)));
    const historyRows =
        uncovered.length > 0
            ? await client.getHistory({
                  items: uncovered,
                  windowMinutes: historyWindowMinutes,
                  nowSeconds,
              })
            : [];

    return new Map([...normaliseTrendRows(trendRows), ...normaliseSeriesRows(historyRows)]);
}

/**
 * Items behind metrics that report a calendar-month total.
 *
 * @param {object[]} metrics catalog entries
 * @param {object[]} items
 * @returns {object[]}
 */
function collectMonthlyItems(metrics, items) {
    const selected = [];
    const seen = new Set();

    for (const metric of metrics) {
        if (!metric.detail?.monthlyTotal) continue;
        for (const source of selectItemsForMetric(metric, items)) {
            const itemId = String(source.item.itemid);
            if (seen.has(itemId)) continue;
            seen.add(itemId);
            selected.push(source.item);
        }
    }

    return selected;
}

/**
 * Bytes transferred per item since the start of the calendar month.
 *
 * The window is rounded down to the hour so the request (and its cache key)
 * stays stable until a new trend row can exist.
 *
 * @param {object} options
 * @param {import('../api/zabbixClient.js').ZabbixClient} options.client
 * @param {object[]} options.items
 * @param {number} options.nowSeconds
 * @returns {Promise<Map<string, number>>}
 */
async function fetchMonthlyBytes({ client, items, nowSeconds }) {
    const rows = await client.getTrends({
        items,
        fromSeconds: monthStartSeconds(nowSeconds),
        toSeconds: hourStartSeconds(nowSeconds),
        maxRows: MONTHLY_TREND_MAX_ROWS,
        cacheTtlMs: MONTHLY_TREND_TTL_MS,
    });
    return normaliseTrendBytes(rows);
}
