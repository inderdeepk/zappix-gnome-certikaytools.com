// normalize.js — turn raw Zabbix payloads into the view models the UI renders.
//
// This is the layer where Zabbix's quirks are absorbed so that nothing above it
// has to know about value types, stringified numbers, per-template key drift,
// or the difference between "0%" and "no data".
//
// Pure JavaScript. Every function here takes already-parsed API payloads and
// returns plain objects, which is what makes the dashboard's behaviour
// testable without a shell, a server, or a network.
//
// Three conventions worth stating up front:
//   • A missing measurement is `null`, never 0. The UI renders null as an em
//     dash and the severity model calls it UNKNOWN — an agent that stopped
//     reporting must not look like an idle machine.
//   • `lastvalue` from `item.get` is the headline number. It is one round trip
//     cheaper than `history.get` and is exactly what the Zabbix frontend shows
//     in "Latest data".
//   • History is a separate, optional input: the panel-only poll never pays
//     for it.

import { AGGREGATE, TRANSFORM, VALUE_KIND, usesThresholds } from './metricCatalog.js';
import { SEVERITY, classifyPercent, classifyProblemSeverity, worstSeverity } from './severity.js';
import { toNumericSeries } from './series.js';
import { formatBytes } from '../shared/format.js';

/** Zabbix `value_type` codes that carry a number we can plot. */
const NUMERIC_VALUE_TYPES = new Set([0, 3]);

/**
 * Is this item's value plottable?
 *
 * @param {number|string} valueType
 * @returns {boolean}
 */
export function isNumericValueType(valueType) {
    return NUMERIC_VALUE_TYPES.has(Number.parseInt(String(valueType ?? ''), 10));
}

/**
 * Apply a catalog transform to one raw item value.
 *
 * @param {string|number|null|undefined} raw `lastvalue` as returned by Zabbix
 * @param {string} units the item's `units` field (used by autoPercent)
 * @param {string} transform one of TRANSFORM
 * @returns {number|null} null when the value is absent or not a number
 */
export function applyTransform(raw, units, transform) {
    if (raw === null || raw === undefined || raw === '') return null;

    const numeric = Number.parseFloat(String(raw));
    if (!Number.isFinite(numeric)) return null;

    switch (transform) {
        case TRANSFORM.FRACTION:
            return numeric * 100;
        case TRANSFORM.INVERT:
            return 100 - numeric;
        case TRANSFORM.AUTO_PERCENT: {
            const unit = String(units ?? '').trim();
            if (unit === '%') return numeric;
            // No unit and a value inside 0..1 is Zabbix's convention for a
            // fraction (system.cpu.utilization, for example). Anything above 1
            // is already a percentage.
            if (unit === '' && numeric >= 0 && numeric <= 1) return numeric * 100;
            return numeric;
        }
        default:
            return numeric;
    }
}

/**
 * Items that satisfy one catalog candidate, best match first.
 *
 * Ranking: exact `preferredKey` → key starts with the search term → key merely
 * contains it. The last tier exists because templates append parameters we
 * cannot predict (interface names, mount points), but an unrelated item whose
 * key happens to contain the search string must never outrank a real one.
 *
 * @param {object} candidate catalog candidate
 * @param {object[]} items `item.get` results
 * @returns {Array<{item: object, rank: number}>}
 */
export function matchCandidate(candidate, items) {
    const matches = [];
    const includes = candidate.includeKeys ?? [];
    const excludes = candidate.excludeKeys ?? [];

    for (const item of items ?? []) {
        const key = String(item?.key_ ?? '');
        if (!key.includes(candidate.search)) continue;
        if (includes.length > 0 && !includes.some((fragment) => key.includes(fragment))) continue;
        if (excludes.some((fragment) => key.includes(fragment))) continue;
        if (!isNumericValueType(item.value_type)) continue;
        // state 1 = "not supported": the item exists but never produces a
        // value, so it must not shadow a working item.
        if (Number.parseInt(String(item.state ?? '0'), 10) === 1) continue;

        const rank =
            candidate.preferredKey && key === candidate.preferredKey
                ? 0
                : key.startsWith(candidate.search)
                  ? 1
                  : 2;

        matches.push({ item, rank });
    }

    matches.sort((left, right) => {
        if (left.rank !== right.rank) return left.rank - right.rank;
        return String(left.item.key_).localeCompare(String(right.item.key_));
    });

    return matches;
}

/**
 * All items that feed one metric, across candidates.
 *
 * `combineAllCandidates` metrics (network) union every candidate so inbound and
 * outbound traffic are counted together. Everything else stops at the first
 * candidate that produces a match, which is how the newest template wins over
 * its legacy fallback.
 *
 * @param {object} metric catalog entry
 * @param {object[]} items
 * @returns {Array<{item: object, transform: string, kind: string}>}
 */
export function selectItemsForMetric(metric, items) {
    const selected = [];
    const seen = new Set();

    const absorb = (candidate) => {
        let added = 0;
        for (const { item } of matchCandidate(candidate, items)) {
            if (seen.has(item.itemid)) continue;
            seen.add(item.itemid);
            selected.push({
                item,
                transform: candidate.transform,
                kind: candidate.fallbackKind ?? metric.kind,
            });
            added += 1;
        }
        return added;
    };

    if (metric.combineAllCandidates) {
        for (const candidate of metric.candidates) absorb(candidate);
        return selected;
    }

    for (const candidate of metric.candidates) {
        if (absorb(candidate) > 0) break;
    }

    return selected;
}

/**
 * Reduce several readings to one displayed number.
 *
 * @param {number[]} values finite readings in priority order
 * @param {string} aggregate one of AGGREGATE
 * @returns {number|null}
 */
export function aggregateValues(values, aggregate) {
    const finite = (values ?? []).filter((value) => Number.isFinite(value));
    if (finite.length === 0) return null;

    switch (aggregate) {
        case AGGREGATE.SUM:
            return finite.reduce((total, value) => total + value, 0);
        case AGGREGATE.MAX:
            return finite.reduce(
                (highest, value) => (value > highest ? value : highest),
                finite[0],
            );
        default:
            return finite[0];
    }
}

/**
 * Resolve one metric for one host.
 *
 * @param {object} metric catalog entry
 * @param {object[]} items the host's `item.get` results
 * @param {object} options
 * @param {{warn:number, crit:number}} options.thresholds
 * @param {boolean} [options.maintenance=false]
 * @returns {object} metric view model
 */
export function resolveMetric(metric, items, { thresholds, maintenance = false } = {}) {
    const sources = selectItemsForMetric(metric, items);

    let kind = metric.kind;
    const readings = sources.map((source) => {
        const clock = Number.parseInt(String(source.item.lastclock ?? '0'), 10) || 0;
        // An item that has never collected still answers `lastvalue: "0"` with
        // `lastclock: "0"` — verified on 7.0 and 7.4. Reading that as a value
        // paints a freshly added (or broken) host green at 0 %, so the clock,
        // not the value, decides whether there is a reading at all.
        const value =
            clock > 0
                ? applyTransform(source.item.lastvalue, source.item.units, source.transform)
                : null;
        if (source.kind && source.kind !== metric.kind) kind = source.kind;
        return {
            item: source.item,
            value,
            units: source.item.units ?? '',
            clock,
        };
    });

    const value = aggregateValues(
        readings.map((reading) => reading.value),
        metric.aggregate,
    );

    // For MAX-style metrics the caption should name the item that produced the
    // number ("/var is 94% full"), not an arbitrary sibling.
    const dominant = pickDominantReading(readings, metric.aggregate);

    const severity = usesThresholds(metric)
        ? classifyPercent(value, thresholds, maintenance ? SEVERITY.MAINTENANCE : '')
        : value === null
          ? SEVERITY.UNKNOWN
          : SEVERITY.OK;

    return {
        id: metric.id,
        label: metric.label,
        unitLabel: metric.unitLabel,
        kind,
        aggregate: metric.aggregate,
        value,
        // Absolute context for a percentage ("5.0 GB of 7.8 GB"). Empty when
        // the host does not report a total, which is normal for a hand-made
        // /hostfs item with no sibling.
        detail: buildDetail(metric, items, value, dominant?.item?.key_ ?? ''),
        severity,
        available: value !== null,
        sourceItemKey: dominant?.item?.key_ ?? '',
        sourceItemName: dominant?.item?.name ?? '',
        sourceItemId: dominant?.item?.itemid ?? '',
        sourceItemIds: readings
            .filter((reading) => reading.value !== null)
            .map((reading) => reading.item.itemid),
        units: dominant?.units ?? '',
        updatedAt: readings.reduce((latest, reading) => Math.max(latest, reading.clock), 0),
    };
}

/** The reading that best represents the aggregate. */
function pickDominantReading(readings, aggregate) {
    let best = null;
    for (const reading of readings) {
        if (!Number.isFinite(reading.value)) continue;
        if (best === null) {
            best = reading;
            continue;
        }
        if (aggregate === AGGREGATE.MAX && reading.value > best.value) best = reading;
        if (aggregate === AGGREGATE.SUM && reading.value > best.value) best = reading;
    }
    return best;
}

/**
 * Merge history rows into per-item series.
 *
 * @param {Array<{itemid: string, clock: string|number, value: string|number}>} rows
 * @returns {Map<string, Array<{t:number, v:number}>>}
 */
export function normaliseSeriesRows(rows) {
    const grouped = new Map();

    for (const row of rows ?? []) {
        const itemId = String(row?.itemid ?? '');
        if (!itemId) continue;
        const list = grouped.get(itemId) ?? [];
        list.push(row);
        grouped.set(itemId, list);
    }

    const result = new Map();
    for (const [itemId, list] of grouped) {
        result.set(itemId, toNumericSeries(list));
    }
    return result;
}

/**
 * Compose the small secondary line under a tile value.
 *
 * Only metrics that declare a `detail` spec get one: memory knows its total
 * from a fixed item, disk derives it from the mount that produced the
 * percentage. Everything else returns '', so the tile renders without the line
 * rather than with a placeholder.
 *
 * @param {object} metric catalog entry
 * @param {object[]} items the host's `item.get` rows
 * @param {number|null} value the resolved percentage
 * @param {string} sourceKey the item key the percentage came from
 * @returns {string}
 */
export function buildDetail(metric, items, value, sourceKey) {
    const spec = metric?.detail;
    if (!spec || value === null) return '';

    const totalItem = findTotalItem(spec, items, sourceKey);
    if (!totalItem) return '';

    const total = Number.parseFloat(String(totalItem.lastvalue ?? ''));
    if (!Number.isFinite(total) || total <= 0) return '';

    return `${formatBytes((total * value) / 100)} of ${formatBytes(total)}`;
}

/**
 * @param {object} spec `detail` block from the catalog
 * @param {object[]} items
 * @param {string} sourceKey
 * @returns {object|null}
 */
function findTotalItem(spec, items, sourceKey) {
    const rows = Array.isArray(items) ? items : [];

    if (Array.isArray(spec.totalKeys)) {
        return rows.find((item) => spec.totalKeys.includes(item.key_)) ?? null;
    }

    if (spec.totalKeyFromSource) {
        const { from, to } = spec.totalKeyFromSource;
        if (!sourceKey.endsWith(from)) return null;
        const wanted = `${sourceKey.slice(0, -from.length)}${to}`;
        return rows.find((item) => item.key_ === wanted) ?? null;
    }

    return null;
}

/**
 * Build the sparkline series for a resolved metric.
 *
 * SUM metrics add their sources sample-by-sample on the union of timestamps;
 * everything else plots the dominant item, which is the one the headline
 * number came from.
 *
 * @param {object} metricView result of `resolveMetric`
 * @param {Map<string, Array<{t:number, v:number}>>} seriesByItemId
 * @returns {Array<{t:number, v:number}>}
 */
export function buildMetricSeries(metricView, seriesByItemId) {
    if (!seriesByItemId || metricView.sourceItemIds.length === 0) return [];

    if (metricView.aggregate !== AGGREGATE.SUM) {
        return seriesByItemId.get(metricView.sourceItemId) ?? [];
    }

    // Network in and out are two items sampled in the same cycle but stamped
    // as each value arrives, so their clocks differ by seconds. Summing on
    // exact equality produced a curve that alternated between the two
    // interfaces instead of adding them.
    //
    // The densest source defines the cycle times; every other source
    // contributes its nearest sample when it is within half a sampling
    // interval. Reference-based rather than greedy so the result has exactly
    // one point per cycle and a stagger cannot produce phantom extra samples.
    const series = metricView.sourceItemIds
        .map((itemId) => ({
            itemId,
            points: (seriesByItemId.get(itemId) ?? [])
                .filter((point) => Number.isFinite(point?.t) && Number.isFinite(point?.v))
                .sort((left, right) => left.t - right.t),
        }))
        .filter((entry) => entry.points.length > 0);

    if (series.length === 0) return [];
    if (series.length === 1) return series[0].points.map(({ t, v }) => ({ t, v }));

    const reference = series.reduce((best, entry) =>
        entry.points.length > best.points.length ? entry : best,
    );
    const tolerance = seriesTolerance(series);
    const others = series.filter((entry) => entry !== reference);

    return reference.points.map((point) => {
        let total = point.v;
        for (const other of others) {
            const value = valueNearest(other.points, point.t, tolerance);
            if (value !== null) total += value;
        }
        return { t: point.t, v: total };
    });
}

/**
 * Value of the sample nearest `when`, or null when none is within `tolerance`.
 *
 * Binary search, so a 2 000-point series stays cheap on every render.
 *
 * @param {Array<{t:number,v:number}>} points sorted by `t`
 * @param {number} when
 * @param {number} tolerance
 * @returns {number|null}
 */
function valueNearest(points, when, tolerance) {
    if (points.length === 0) return null;

    let low = 0;
    let high = points.length - 1;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (points[middle].t < when) low = middle + 1;
        else high = middle;
    }

    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const index of [low - 1, low]) {
        const candidate = points[index];
        if (!candidate) continue;
        const distance = Math.abs(candidate.t - when);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate.v;
        }
    }

    return bestDistance <= tolerance ? best : null;
}

/**
 * Half the shortest sampling interval across the summed sources.
 *
 * Held to the *shortest* interval so a fast source can never contribute the
 * same sample to two neighbouring cycles. Returns 0 when no source has two
 * points, which degrades to exact timestamp matching.
 *
 * @param {Array<{itemId: string, points: Array<{t:number,v:number}>}>} series sorted by `t`
 * @returns {number}
 */
function seriesTolerance(series) {
    let shortest = Number.POSITIVE_INFINITY;

    for (const { points } of series) {
        const gaps = [];
        for (let index = 1; index < points.length; index++) {
            const gap = points[index].t - points[index - 1].t;
            if (gap > 0) gaps.push(gap);
        }
        if (gaps.length === 0) continue;

        gaps.sort((left, right) => left - right);
        shortest = Math.min(shortest, gaps[Math.floor(gaps.length / 2)]);
    }

    return Number.isFinite(shortest) ? Math.floor(shortest / 2) : 0;
}

/**
 * Normalise one `host.get` result.
 *
 * @param {object} raw
 * @returns {object|null} null when the host has no id (a malformed row)
 */
export function normaliseHost(raw) {
    const hostId = String(raw?.hostid ?? '');
    if (!hostId) return null;

    const interfaces = Array.isArray(raw?.interfaces) ? raw.interfaces : [];
    const primary =
        interfaces.find((iface) => String(iface?.main) === '1') ?? interfaces[0] ?? null;

    const availabilityCode = Number.parseInt(String(primary?.available ?? '0'), 10);
    const availability =
        availabilityCode === 1 ? 'available' : availabilityCode === 2 ? 'unavailable' : 'unknown';

    const groups = raw?.hostgroups ?? raw?.groups ?? [];

    return {
        hostId,
        name: String(raw?.name ?? raw?.host ?? hostId),
        technicalName: String(raw?.host ?? ''),
        availability,
        interfaceError: String(primary?.error ?? ''),
        endpoint: primary ? formatInterfaceEndpoint(primary) : '',
        maintenance: String(raw?.maintenance_status ?? '0') === '1',
        maintenanceSince: Number.parseInt(String(raw?.maintenance_from ?? '0'), 10) || 0,
        groups: Array.isArray(groups)
            ? groups.map((group) => String(group?.name ?? '')).filter(Boolean)
            : [],
    };
}

/** `10.0.0.4:10050`, or the DNS name when no IP is set. */
function formatInterfaceEndpoint(iface) {
    const host = String(iface?.ip || iface?.dns || '').trim();
    const port = String(iface?.port ?? '').trim();
    if (!host) return '';
    return port ? `${host}:${port}` : host;
}

/**
 * Summarise `problem.get` results.
 *
 * @param {object[]} problems
 * @param {object} [options]
 * @param {number} [options.maxItems=5] how many to keep for the list view
 * @returns {{total:number, unacknowledged:number, worstSeverity:string,
 *            oldestClock:number, items:object[]}}
 */
export function summariseProblems(problems, { maxItems = 5 } = {}) {
    const list = (problems ?? []).filter((problem) => problem && problem.eventid);
    const items = list.map((problem) => ({
        eventId: String(problem.eventid),
        name: String(problem.name ?? ''),
        severity: classifyProblemSeverity(problem.severity),
        severityCode: Number.parseInt(String(problem.severity ?? '0'), 10) || 0,
        acknowledged: String(problem.acknowledged ?? '0') === '1',
        clock: Number.parseInt(String(problem.clock ?? '0'), 10) || 0,
    }));

    const sorted = [...items].sort((left, right) => {
        if (right.severityCode !== left.severityCode) return right.severityCode - left.severityCode;
        return right.clock - left.clock;
    });

    return {
        total: items.length,
        unacknowledged: items.filter((item) => !item.acknowledged).length,
        worstSeverity: worstSeverity(items.map((item) => item.severity)),
        oldestClock: items.reduce(
            (oldest, item) => (oldest === 0 ? item.clock : Math.min(oldest, item.clock)),
            0,
        ),
        items: sorted.slice(0, maxItems),
    };
}

/**
 * Assemble the per-host snapshot the dashboard renders.
 *
 * @param {object} options
 * @param {object} options.host normalised host
 * @param {object[]} options.items `item.get` results for this host
 * @param {object[]} options.metrics catalog entries to resolve
 * @param {{warn:number, crit:number}} options.thresholds
 * @param {Map<string, Array<{t:number,v:number}>>} [options.seriesByItemId]
 * @returns {object}
 */
export function buildHostSnapshot({ host, items, metrics, thresholds, seriesByItemId = null }) {
    const hostItems = (items ?? []).filter((item) => String(item?.hostid ?? '') === host.hostId);

    const resolved = metrics.map((metric) => {
        const view = resolveMetric(metric, hostItems, {
            thresholds,
            maintenance: host.maintenance,
        });
        if (seriesByItemId) {
            view.series = buildMetricSeries(view, seriesByItemId);
        } else {
            view.series = [];
        }
        return view;
    });

    // `collectedAt` is the newest item clock across the metrics that actually
    // produced a value. It is the honest answer to "is this host still
    // reporting?", which interface availability cannot answer for an
    // active-only agent (the passive availability icon stays Unknown).
    const collectedAt = resolved.reduce(
        (latest, metric) => (metric.available ? Math.max(latest, metric.updatedAt) : latest),
        0,
    );

    return {
        ...host,
        metrics: resolved,
        worstSeverity: worstSeverity(resolved.map((metric) => metric.severity)),
        metricCount: resolved.filter((metric) => metric.available).length,
        collectedAt,
        itemCount: hostItems.length,
    };
}

/**
 * Order hosts for display: the ones this dashboard can actually say something
 * about come first.
 *
 * This is not cosmetic. A stock Zabbix install ships a `Zabbix server` host
 * whose items have nothing to do with the catalog (and whose name sorts before
 * every lowercase host), so without this the panel's headline value would be
 * read from a host that renders nothing but dashes.
 *
 * @param {object[]} hosts host snapshots
 * @returns {object[]} a new array
 */
export function orderHosts(hosts) {
    return [...(hosts ?? [])].sort((left, right) => {
        const delta = (right.metricCount ?? 0) - (left.metricCount ?? 0);
        if (delta !== 0) return delta;
        return String(left.name ?? '').localeCompare(String(right.name ?? ''));
    });
}

/**
 * Recompute severities for an existing snapshot without refetching.
 *
 * Thresholds and maintenance windows are user/server state, not measurements,
 * so a settings change must not trigger a poll.
 *
 * @param {object} snapshot
 * @param {{warn:number, crit:number}} thresholds
 * @param {boolean} maintenance
 * @returns {object} a new snapshot; the input is not mutated
 */
export function rescoreSnapshot(snapshot, thresholds, maintenance = snapshot.maintenance) {
    const metrics = snapshot.metrics.map((metric) => {
        const isPercent = metric.kind === VALUE_KIND.PERCENT;
        const severity =
            isPercent && metric.value !== null
                ? classifyPercent(metric.value, thresholds, maintenance ? SEVERITY.MAINTENANCE : '')
                : metric.value === null
                  ? SEVERITY.UNKNOWN
                  : SEVERITY.OK;
        return { ...metric, severity };
    });

    return {
        ...snapshot,
        maintenance,
        metrics,
        worstSeverity: worstSeverity(metrics.map((metric) => metric.severity)),
    };
}
