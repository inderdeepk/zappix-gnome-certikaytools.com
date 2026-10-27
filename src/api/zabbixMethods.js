// zabbixMethods.js — parameter builders for the handful of Zabbix API methods
// Zappix actually calls.
//
// Keeping the parameter objects here (rather than inline at call sites) buys
// three things:
//   • the tests can assert on the exact wire payload without a network stack;
//   • version-specific property renames live in one place;
//   • every query is explicitly field-limited, which is what keeps a poll cheap
//     on a Zabbix server that may monitor thousands of hosts.
//
// Deliberately never requested: `output: 'extend'` on `item.get`. A real host
// carries 100+ items and the extended object is large; listing fields cuts the
// response by an order of magnitude.

import { collectSearchTerms } from '../model/metricCatalog.js';
import { usesHostGroupsProperty } from './zabbixEndpoints.js';

/**
 * Values accepted by `history.get`'s `history` parameter.
 *
 * A history query may only reference items that share one value type, which is
 * why the client groups item ids before calling.
 */
export const HISTORY_VALUE_TYPE = Object.freeze({
    FLOAT: 0,
    CHARACTER: 1,
    LOG: 2,
    UNSIGNED: 3,
    TEXT: 4,
});

/** Severity labels returned by `problem.get` (`severity` 0..5). */
export const PROBLEM_SEVERITY = Object.freeze({
    0: 'not-classified',
    1: 'information',
    2: 'warning',
    3: 'average',
    4: 'high',
    5: 'disaster',
});

/** Interface availability returned by `host.get`'s `selectInterfaces`. */
export const INTERFACE_AVAILABILITY = Object.freeze({
    0: 'unknown',
    1: 'available',
    2: 'unavailable',
});

/** Fields the dashboard needs from a host object. */
export const HOST_OUTPUT_FIELDS = Object.freeze([
    'hostid',
    'host',
    'name',
    'status',
    'maintenance_status',
    'maintenance_from',
]);

/** Interface fields used for the availability dot and the endpoint caption. */
export const INTERFACE_OUTPUT_FIELDS = Object.freeze([
    'interfaceid',
    'ip',
    'dns',
    'port',
    'type',
    'main',
    'available',
    'error',
]);

/** Fields the dashboard needs from an item object. */
export const ITEM_OUTPUT_FIELDS = Object.freeze([
    'itemid',
    'hostid',
    'name',
    'key_',
    'value_type',
    'units',
    'lastvalue',
    'lastclock',
    'prevvalue',
    'prevclock',
    'state',
    'error',
]);

/** Fields the dashboard needs from a problem object. */
export const PROBLEM_OUTPUT_FIELDS = Object.freeze([
    'eventid',
    'objectid',
    'clock',
    'name',
    'severity',
    'acknowledged',
    'r_eventid',
]);

/**
 * `apiinfo.version` — the unauthenticated capability probe.
 *
 * Used before anything else so the client can pick the right auth style and
 * property names. Cheap, cacheable for the lifetime of an extension session.
 *
 * @returns {{method: string, params: object}}
 */
export function apiInfoVersion() {
    return { method: 'apiinfo.version', params: {} };
}

/**
 * `user.login` — exchange credentials for a session token.
 *
 * Only used for the "username and password" auth mode; API-token servers skip
 * this entirely, which is the recommended setup. Zabbix 6.4 renamed the login
 * field from `user` to `username` and rejects the old name, so the caller
 * passes `legacy` after probing the server version.
 *
 * @param {{username: string, password: string, legacy?: boolean}} credentials
 * @returns {{method: string, params: object}}
 */
export function userLogin({ username, password, legacy = false }) {
    const params = {
        password: String(password ?? ''),
    };

    if (legacy) {
        params.user = String(username ?? '');
    } else {
        params.username = String(username ?? '');
    }

    return { method: 'user.login', params };
}

/**
 * `user.logout` — release a session token.
 *
 * Best-effort: a Zabbix session dies on its own after the configured timeout,
 * so a failure here must never surface to the user.
 *
 * @returns {{method: string, params: object}}
 */
export function userLogout() {
    return { method: 'user.logout', params: {} };
}

/**
 * `host.get` — monitored hosts with their main interface.
 *
 * @param {object} [options]
 * @param {number} [options.limit=20]
 * @param {string} [options.hostFilter=''] substring matched against host name
 * @param {string} [options.version=''] `apiinfo.version` result
 * @returns {{method: string, params: object}}
 */
export function hostGet({ limit = 20, hostFilter = '', version = '' } = {}) {
    const params = {
        output: [...HOST_OUTPUT_FIELDS],
        selectInterfaces: [...INTERFACE_OUTPUT_FIELDS],
        // status 0 = monitored. Unmonitored hosts have no live data, and
        // showing them would fill the dashboard with dead tiles.
        filter: { status: 0 },
        sortfield: 'name',
        limit,
    };

    if (usesHostGroupsProperty(version)) {
        params.selectHostGroups = ['groupid', 'name'];
    } else {
        params.selectGroups = ['groupid', 'name'];
    }

    const trimmed = String(hostFilter ?? '').trim();
    if (trimmed) {
        params.search = { name: trimmed };
        params.searchByAny = true;
    }

    return { method: 'host.get', params };
}

/**
 * `item.get` — resolve catalog metrics to concrete items for the given hosts.
 *
 * The `search` terms come from the metric catalog, so this query is only as
 * broad as the tiles that actually exist in the UI. `searchByAny` turns the
 * list into an OR; without it Zabbix would require every term to match.
 *
 * @param {object} options
 * @param {string[]} options.hostIds
 * @param {object[]} options.metrics
 * @returns {{method: string, params: object}}
 */
export function itemGet({ hostIds, metrics }) {
    const searchTerms = collectSearchTerms(metrics);
    const params = {
        output: [...ITEM_OUTPUT_FIELDS],
        hostids: [...hostIds],
        // Disabled items never update; including them would add noise without
        // ever producing a value.
        filter: { status: 0 },
        sortfield: 'key_',
    };

    if (searchTerms.length > 0) {
        params.search = { key_: searchTerms };
        params.searchByAny = true;
    }

    return { method: 'item.get', params };
}

/**
 * `history.get` — time series for the sparklines.
 *
 * `limit` is a hard cap on rows, not per item, so callers must size it from
 * (items × points) and accept truncation for very wide windows.
 *
 * @param {object} options
 * @param {string[]} options.itemIds
 * @param {number} options.valueType one of HISTORY_VALUE_TYPE
 * @param {number} options.timeFrom unix seconds
 * @param {number} options.timeTill unix seconds
 * @param {number} [options.limit=2000]
 * @returns {{method: string, params: object}}
 */
export function historyGet({ itemIds, valueType, timeFrom, timeTill, limit = 2000 }) {
    return {
        method: 'history.get',
        params: {
            output: ['itemid', 'clock', 'value'],
            history: valueType,
            itemids: [...itemIds],
            time_from: Math.floor(timeFrom),
            time_till: Math.floor(timeTill),
            sortfield: 'clock',
            sortorder: 'ASC',
            limit,
        },
    };
}

/** Fields a sparkline and a period total need from one hourly trend row. */
export const TREND_OUTPUT_FIELDS = Object.freeze([
    'itemid',
    'clock',
    'num',
    'value_min',
    'value_avg',
    'value_max',
]);

/**
 * Value types `trend.get` accepts.
 *
 * Trends are numeric aggregates, so the character/log/text types a history
 * query tolerates would be rejected here.
 */
export const TREND_VALUE_TYPES = Object.freeze([
    HISTORY_VALUE_TYPE.FLOAT,
    HISTORY_VALUE_TYPE.UNSIGNED,
]);

/**
 * `trend.get` — hourly aggregates, for windows raw history cannot cover.
 *
 * Zabbix keeps raw history for an hour or so on the stock templates and rolls
 * everything else into one row per item per hour. A 24-hour curve and a
 * calendar-month total therefore both come from here.
 *
 * `limit` is a hard cap on rows for the whole request, exactly as in
 * `history.get`, so callers must size it from (items × hours).
 *
 * @param {object} options
 * @param {string[]} options.itemIds
 * @param {number} options.valueType one of TREND_VALUE_TYPES
 * @param {number} options.timeFrom unix seconds
 * @param {number} options.timeTill unix seconds
 * @param {number} [options.limit=2000]
 * @returns {{method: string, params: object}}
 */
export function trendGet({ itemIds, valueType, timeFrom, timeTill, limit = 2000 }) {
    return {
        method: 'trend.get',
        params: {
            output: [...TREND_OUTPUT_FIELDS],
            history: valueType,
            itemids: [...itemIds],
            time_from: Math.floor(timeFrom),
            time_till: Math.floor(timeTill),
            sortfield: 'clock',
            sortorder: 'ASC',
            limit,
        },
    };
}

/**
 * `problem.get` — unresolved problems for a set of hosts.
 *
 * `recent` is deliberately *not* sent: it widens the result to recently
 * resolved problems, which would make a recovered incident look ongoing.
 *
 * @param {object} options
 * @param {string[]} options.hostIds
 * @param {number} [options.limit=50]
 * @param {boolean} [options.unacknowledgedOnly=false]
 * @returns {{method: string, params: object}}
 */
export function problemGet({ hostIds, limit = 50, unacknowledgedOnly = false }) {
    const params = {
        output: [...PROBLEM_OUTPUT_FIELDS],
        hostids: [...hostIds],
        sortfield: ['eventid'],
        sortorder: 'DESC',
        limit,
    };

    if (unacknowledgedOnly) {
        params.acknowledged = false;
    }

    return { method: 'problem.get', params };
}

/**
 * Group history item ids by value type.
 *
 * Zabbix rejects a `history.get` whose `history` parameter does not match the
 * items' `value_type`, so the client must issue one request per type. CPU and
 * memory are floats; uptime and process counts are unsigned; a template that
 * stores a metric as text lands in its own group.
 *
 * @param {Array<{itemid: string, value_type: string|number}>} items
 * @param {object} [options]
 * @param {number[]|null} [options.only=null] keep just these value types
 * @returns {Map<number, string[]>}
 */
export function groupItemsByValueType(items, { only = null } = {}) {
    const allowed = only ? new Set(only.map(Number)) : null;
    const groups = new Map();
    for (const item of items) {
        const valueType = Number.parseInt(String(item.value_type ?? ''), 10);
        if (!Number.isInteger(valueType)) continue;
        if (allowed && !allowed.has(valueType)) continue;
        const list = groups.get(valueType) ?? [];
        list.push(String(item.itemid));
        groups.set(valueType, list);
    }
    return groups;
}
