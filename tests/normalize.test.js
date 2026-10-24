// normalize.test.js — the layer where Zabbix payloads become dashboard values.
//
// This is the highest-risk module in the extension: every real-world template
// variation lands here. The cases below are taken from the actual item keys the
// stock Linux template creates, including the ones that look similar enough to
// be confused (a per-mode CPU breakdown, a loopback interface, a free-percentage
// item that must be inverted, a byte-count sibling of a percentage).
import { assert, assertClose, assertDeepEqual, assertEqual, runTests } from './testUtils.js';
import {
    aggregateValues,
    applyTransform,
    buildHostSnapshot,
    buildMetricSeries,
    isNumericValueType,
    matchCandidate,
    normaliseHost,
    normaliseSeriesRows,
    orderHosts,
    rescoreSnapshot,
    resolveMetric,
    selectItemsForMetric,
    summariseProblems,
} from '../src/model/normalize.js';
import { AGGREGATE, getMetric, TRANSFORM, VALUE_KIND } from '../src/model/metricCatalog.js';
import { SEVERITY } from '../src/model/severity.js';

const THRESHOLDS = { warn: 75, crit: 90 };

/**
 * Build an `item.get` row with sensible defaults.
 *
 * @param {object} overrides
 * @returns {object}
 */
function item(overrides) {
    return {
        itemid: '1',
        hostid: 'h1',
        name: 'Item',
        key_: 'key',
        value_type: '0',
        units: '',
        lastvalue: '0',
        lastclock: '1700000000',
        prevvalue: '',
        prevclock: '',
        state: '0',
        error: '',
        ...overrides,
    };
}

await runTests([
    // ── transforms ──────────────────────────────────────────────────────
    [
        'applyTransform passes identity values through',
        () => {
            assertEqual(applyTransform('12.5', '%', TRANSFORM.IDENTITY), 12.5);
        },
    ],
    [
        'applyTransform converts a fraction to a percentage',
        () => {
            assertEqual(applyTransform('0.42', '', TRANSFORM.FRACTION), 42);
        },
    ],
    [
        'applyTransform inverts a free-percentage item',
        () => {
            assertEqual(applyTransform('63', '%', TRANSFORM.INVERT), 37);
        },
    ],
    [
        'applyTransform trusts an explicit percent unit',
        () => {
            assertEqual(applyTransform('42.5', '%', TRANSFORM.AUTO_PERCENT), 42.5);
        },
    ],
    [
        'applyTransform treats a unitless 0..1 value as a fraction',
        () => {
            assertEqual(applyTransform('0.5', '', TRANSFORM.AUTO_PERCENT), 50);
        },
    ],
    [
        'applyTransform leaves a unitless value above 1 alone',
        () => {
            assertEqual(applyTransform('42', '', TRANSFORM.AUTO_PERCENT), 42);
        },
    ],
    [
        'applyTransform returns null for an empty or non-numeric value',
        () => {
            assertEqual(applyTransform('', '%', TRANSFORM.IDENTITY), null);
            assertEqual(applyTransform(null, '%', TRANSFORM.IDENTITY), null);
            assertEqual(applyTransform('n/a', '%', TRANSFORM.IDENTITY), null);
        },
    ],
    [
        'isNumericValueType accepts float and unsigned only',
        () => {
            assertEqual(isNumericValueType('0'), true);
            assertEqual(isNumericValueType('3'), true);
            assertEqual(isNumericValueType('1'), false);
            assertEqual(isNumericValueType('4'), false);
        },
    ],

    // ── candidate matching ──────────────────────────────────────────────
    [
        'matchCandidate ranks the exact preferred key first',
        () => {
            const candidate = { search: 'system.cpu.util', preferredKey: 'system.cpu.util' };
            const matches = matchCandidate(candidate, [
                item({ itemid: 'b', key_: 'system.cpu.util[,user]' }),
                item({ itemid: 'a', key_: 'system.cpu.util' }),
            ]);
            assertEqual(matches[0].item.itemid, 'a');
            assertEqual(matches[0].rank, 0);
        },
    ],
    [
        'matchCandidate ranks a prefix match above a substring match',
        () => {
            const candidate = { search: 'net.if.in[' };
            const matches = matchCandidate(candidate, [
                item({ itemid: 'contains', key_: 'xnet.if.in[y]' }),
                item({ itemid: 'prefix', key_: 'net.if.in[eth0]' }),
            ]);
            assertEqual(matches[0].item.itemid, 'prefix');
        },
    ],
    [
        'matchCandidate honours excludeKeys',
        () => {
            const candidate = { search: 'net.if.in[', excludeKeys: ['"lo"'] };
            const matches = matchCandidate(candidate, [
                item({ itemid: 'lo', key_: 'net.if.in["lo"]' }),
                item({ itemid: 'eth', key_: 'net.if.in["eth0"]' }),
            ]);
            assertDeepEqual(
                matches.map((match) => match.item.itemid),
                ['eth'],
            );
        },
    ],
    [
        'matchCandidate honours includeKeys',
        () => {
            const candidate = { search: 'vfs.fs.dependent.size[', includeKeys: [',pused]'] };
            const matches = matchCandidate(candidate, [
                item({ itemid: 'bytes', key_: 'vfs.fs.dependent.size[/,used]' }),
                item({ itemid: 'pct', key_: 'vfs.fs.dependent.size[/,pused]' }),
            ]);
            assertDeepEqual(
                matches.map((match) => match.item.itemid),
                ['pct'],
            );
        },
    ],
    [
        'matchCandidate skips unsupported items',
        () => {
            const candidate = { search: 'system.cpu.util' };
            const matches = matchCandidate(candidate, [
                item({ itemid: 'broken', key_: 'system.cpu.util', state: '1' }),
                item({ itemid: 'ok', key_: 'system.cpu.util[,user]' }),
            ]);
            assertDeepEqual(
                matches.map((match) => match.item.itemid),
                ['ok'],
            );
        },
    ],
    [
        'matchCandidate skips non-numeric value types',
        () => {
            const candidate = { search: 'x' };
            const matches = matchCandidate(candidate, [
                item({ itemid: 'text', key_: 'x', value_type: '4' }),
            ]);
            assertEqual(matches.length, 0);
        },
    ],

    // ── metric resolution ───────────────────────────────────────────────
    [
        'selectItemsForMetric stops at the first candidate that matches',
        () => {
            const sources = selectItemsForMetric(getMetric('cpu'), [
                item({ itemid: 'cpu', key_: 'system.cpu.util', units: '%', lastvalue: '12' }),
                item({ itemid: 'load', key_: 'system.cpu.load[all,avg1]', lastvalue: '9' }),
            ]);
            assertDeepEqual(
                sources.map((source) => source.item.itemid),
                ['cpu'],
            );
        },
    ],
    [
        'selectItemsForMetric unions every candidate for network',
        () => {
            const sources = selectItemsForMetric(getMetric('network'), [
                item({ itemid: 'in', key_: 'net.if.in["eth0"]', lastvalue: '100' }),
                item({ itemid: 'out', key_: 'net.if.out["eth0"]', lastvalue: '50' }),
            ]);
            assertDeepEqual(
                sources.map((source) => source.item.itemid),
                ['in', 'out'],
            );
        },
    ],
    [
        'aggregateValues sums, maxes and picks first',
        () => {
            assertEqual(aggregateValues([1, 2, 3], AGGREGATE.SUM), 6);
            assertEqual(aggregateValues([1, 2, 3], AGGREGATE.MAX), 3);
            assertEqual(aggregateValues([1, 2, 3], AGGREGATE.FIRST), 1);
        },
    ],
    [
        'aggregateValues ignores non-finite readings',
        () => {
            assertEqual(aggregateValues([null, 5, Number.NaN], AGGREGATE.MAX), 5);
            assertEqual(aggregateValues([], AGGREGATE.MAX), null);
        },
    ],
    [
        'resolveMetric reads the stock CPU dependent item',
        () => {
            const view = resolveMetric(
                getMetric('cpu'),
                [
                    item({ itemid: 'cpu', key_: 'system.cpu.util', units: '%', lastvalue: '42.5' }),
                    item({
                        itemid: 'idle',
                        key_: 'system.cpu.util[,idle]',
                        units: '%',
                        lastvalue: '57.5',
                    }),
                    item({
                        itemid: 'user',
                        key_: 'system.cpu.util[,user]',
                        units: '%',
                        lastvalue: '20',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 42.5);
            assertEqual(view.sourceItemId, 'cpu');
            assertEqual(view.available, true);
            assertEqual(view.severity, SEVERITY.OK);
        },
    ],
    [
        'resolveMetric inverts the idle item when the dependent item is absent',
        () => {
            const view = resolveMetric(
                getMetric('cpu'),
                [
                    item({
                        itemid: 'idle',
                        key_: 'system.cpu.util[,idle]',
                        units: '%',
                        lastvalue: '57.5',
                    }),
                    item({
                        itemid: 'user',
                        key_: 'system.cpu.util[,user]',
                        units: '%',
                        lastvalue: '20',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertClose(view.value, 42.5, 1e-9);
            assertEqual(view.sourceItemId, 'idle');
        },
    ],
    [
        'resolveMetric falls back to load average with the load kind',
        () => {
            const view = resolveMetric(
                getMetric('cpu'),
                [item({ itemid: 'load', key_: 'system.cpu.load[all,avg1]', lastvalue: '1.75' })],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 1.75);
            assertEqual(view.kind, 'load');
        },
    ],
    [
        'resolveMetric prefers the host-root filesystem over a fuller mount',
        () => {
            // Root, not "whichever mount is fullest": the tile answers "how
            // full is this machine", which is what the operator's runbook and
            // the Zabbix trigger are written against.
            const view = resolveMetric(
                getMetric('disk'),
                [
                    item({
                        itemid: 'root',
                        key_: 'vfs.fs.dependent.size[/,pused]',
                        units: '%',
                        lastvalue: '31',
                    }),
                    item({
                        itemid: 'var',
                        key_: 'vfs.fs.dependent.size[/var,pused]',
                        units: '%',
                        lastvalue: '94',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 31);
            assertEqual(view.sourceItemId, 'root');
        },
    ],
    [
        'resolveMetric uses the containerised agent host root when present',
        () => {
            const view = resolveMetric(
                getMetric('disk'),
                [
                    item({
                        itemid: 'hostfs',
                        key_: 'vfs.fs.size[/hostfs,pused]',
                        units: '%',
                        lastvalue: '55.1',
                    }),
                    item({
                        itemid: 'root',
                        key_: 'vfs.fs.dependent.size[/,pused]',
                        units: '%',
                        lastvalue: '12',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertClose(view.value, 55.1, 1e-9);
            assertEqual(view.sourceItemId, 'hostfs');
        },
    ],
    [
        'resolveMetric falls back to the fullest discovered mount',
        () => {
            const view = resolveMetric(
                getMetric('disk'),
                [
                    item({
                        itemid: 'var',
                        key_: 'vfs.fs.dependent.size[/var,pused]',
                        units: '%',
                        lastvalue: '94',
                    }),
                    item({
                        itemid: 'home',
                        key_: 'vfs.fs.dependent.size[/home,pused]',
                        units: '%',
                        lastvalue: '41',
                    }),
                    item({
                        itemid: 'etc',
                        key_: 'vfs.fs.dependent.size[/etc/hostname,pused]',
                        units: '%',
                        lastvalue: '99',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 94, 'bind-mount noise must not win');
            assertEqual(view.severity, SEVERITY.CRIT);
        },
    ],
    [
        'resolveMetric falls back to free percentage and inverts it',
        () => {
            const view = resolveMetric(
                getMetric('disk'),
                [
                    item({
                        itemid: 'free',
                        key_: 'vfs.fs.size[/,pfree]',
                        units: '%',
                        lastvalue: '20',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 80);
        },
    ],
    [
        'resolveMetric sums inbound and outbound network traffic',
        () => {
            const view = resolveMetric(
                getMetric('network'),
                [
                    item({
                        itemid: 'in',
                        key_: 'net.if.in["eth0"]',
                        units: 'bps',
                        lastvalue: '1000',
                    }),
                    item({
                        itemid: 'out',
                        key_: 'net.if.out["eth0"]',
                        units: 'bps',
                        lastvalue: '500',
                    }),
                    item({
                        itemid: 'lo',
                        key_: 'net.if.in["lo"]',
                        units: 'bps',
                        lastvalue: '999999',
                    }),
                    item({ itemid: 'err', key_: 'net.if.in["eth0",errors]', lastvalue: '7' }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 1500);
            assertEqual(view.severity, SEVERITY.OK);
            assertDeepEqual(view.sourceItemIds, ['in', 'out']);
        },
    ],
    [
        'resolveMetric reports no data instead of zero when nothing matches',
        () => {
            const view = resolveMetric(getMetric('memory'), [], { thresholds: THRESHOLDS });
            assertEqual(view.value, null);
            assertEqual(view.available, false);
            assertEqual(view.severity, SEVERITY.UNKNOWN);
        },
    ],
    [
        'resolveMetric suppresses alarming colours during maintenance',
        () => {
            const view = resolveMetric(
                getMetric('cpu'),
                [item({ key_: 'system.cpu.util', units: '%', lastvalue: '99' })],
                { thresholds: THRESHOLDS, maintenance: true },
            );
            assertEqual(view.severity, SEVERITY.MAINTENANCE);
        },
    ],

    // ── hosts ───────────────────────────────────────────────────────────
    [
        'normaliseHost picks the primary interface',
        () => {
            const host = normaliseHost({
                hostid: '42',
                host: 'web-01',
                name: 'web-01 (prod)',
                status: '0',
                maintenance_status: '0',
                interfaces: [
                    { ip: '10.0.0.9', dns: '', port: '10050', main: '0', available: '2' },
                    { ip: '10.0.0.4', dns: '', port: '10050', main: '1', available: '1' },
                ],
            });

            assertEqual(host.hostId, '42');
            assertEqual(host.name, 'web-01 (prod)');
            assertEqual(host.technicalName, 'web-01');
            assertEqual(host.availability, 'available');
            assertEqual(host.endpoint, '10.0.0.4:10050');
        },
    ],
    [
        'normaliseHost maps interface availability codes',
        () => {
            assertEqual(
                normaliseHost({ hostid: '1', interfaces: [{ main: '1', available: '0' }] })
                    .availability,
                'unknown',
            );
            assertEqual(
                normaliseHost({ hostid: '1', interfaces: [{ main: '1', available: '2' }] })
                    .availability,
                'unavailable',
            );
        },
    ],
    [
        'normaliseHost flags maintenance',
        () => {
            const host = normaliseHost({
                hostid: '1',
                maintenance_status: '1',
                maintenance_from: '99',
            });
            assertEqual(host.maintenance, true);
            assertEqual(host.maintenanceSince, 99);
        },
    ],
    [
        'normaliseHost returns null without a host id',
        () => {
            assertEqual(normaliseHost({ name: 'x' }), null);
        },
    ],
    [
        'normaliseHost reads host groups from either property name',
        () => {
            assertDeepEqual(
                normaliseHost({ hostid: '1', hostgroups: [{ name: 'Linux' }] }).groups,
                ['Linux'],
            );
            assertDeepEqual(normaliseHost({ hostid: '1', groups: [{ name: 'Web' }] }).groups, [
                'Web',
            ]);
        },
    ],

    // ── problems ────────────────────────────────────────────────────────
    [
        'summariseProblems counts and ranks by severity',
        () => {
            const summary = summariseProblems([
                { eventid: '1', name: 'Disk full', severity: '4', acknowledged: '0', clock: '100' },
                { eventid: '2', name: 'Load high', severity: '2', acknowledged: '1', clock: '200' },
                { eventid: '3', name: 'CPU spike', severity: '5', acknowledged: '0', clock: '150' },
            ]);

            assertEqual(summary.total, 3);
            assertEqual(summary.unacknowledged, 2);
            assertEqual(summary.worstSeverity, SEVERITY.CRIT);
            assertEqual(summary.oldestClock, 100);
            assertDeepEqual(
                summary.items.map((problem) => problem.eventId),
                ['3', '1', '2'],
            );
        },
    ],
    [
        'summariseProblems bounds the listed items',
        () => {
            const problems = Array.from({ length: 12 }, (_, index) => ({
                eventid: String(index),
                name: `p${index}`,
                severity: '2',
                acknowledged: '0',
                clock: String(index),
            }));
            assertEqual(summariseProblems(problems, { maxItems: 3 }).items.length, 3);
        },
    ],
    [
        'summariseProblems returns a calm summary for no problems',
        () => {
            const summary = summariseProblems([]);
            assertEqual(summary.total, 0);
            assertEqual(summary.worstSeverity, SEVERITY.OK);
            assertEqual(summary.oldestClock, 0);
        },
    ],

    // ── series ──────────────────────────────────────────────────────────
    [
        'normaliseSeriesRows groups rows by item',
        () => {
            const map = normaliseSeriesRows([
                { itemid: '1', clock: '100', value: '5' },
                { itemid: '2', clock: '100', value: '7' },
                { itemid: '1', clock: '101', value: '6' },
            ]);
            assertEqual(map.get('1').length, 2);
            assertEqual(map.get('2').length, 1);
        },
    ],
    [
        'buildMetricSeries sums sources for a SUM metric',
        () => {
            const view = {
                aggregate: AGGREGATE.SUM,
                sourceItemId: 'in',
                sourceItemIds: ['in', 'out'],
            };
            const map = new Map([
                [
                    'in',
                    [
                        { t: 100, v: 10 },
                        { t: 101, v: 20 },
                    ],
                ],
                [
                    'out',
                    [
                        { t: 100, v: 1 },
                        { t: 101, v: 2 },
                    ],
                ],
            ]);
            assertDeepEqual(buildMetricSeries(view, map), [
                { t: 100, v: 11 },
                { t: 101, v: 22 },
            ]);
        },
    ],
    [
        'buildMetricSeries plots the dominant item for a MAX metric',
        () => {
            const view = {
                aggregate: AGGREGATE.MAX,
                sourceItemId: 'var',
                sourceItemIds: ['root', 'var'],
            };
            const map = new Map([['var', [{ t: 100, v: 94 }]]]);
            assertDeepEqual(buildMetricSeries(view, map), [{ t: 100, v: 94 }]);
        },
    ],
    [
        'buildMetricSeries tolerates missing history',
        () => {
            const view = { aggregate: AGGREGATE.MAX, sourceItemId: 'a', sourceItemIds: [] };
            assertDeepEqual(buildMetricSeries(view, new Map()), []);
            assertDeepEqual(buildMetricSeries(view, null), []);
        },
    ],

    // ── snapshots ───────────────────────────────────────────────────────
    [
        'buildHostSnapshot only uses items belonging to the host',
        () => {
            const snapshot = buildHostSnapshot({
                host: { hostId: 'h1', name: 'web', endpoint: '', maintenance: false },
                items: [
                    item({ hostid: 'h1', key_: 'system.cpu.util', units: '%', lastvalue: '10' }),
                    item({ hostid: 'h2', key_: 'system.cpu.util', units: '%', lastvalue: '99' }),
                ],
                metrics: [getMetric('cpu')],
                thresholds: THRESHOLDS,
            });

            assertEqual(snapshot.metrics[0].value, 10);
            assertEqual(snapshot.worstSeverity, SEVERITY.OK);
        },
    ],
    [
        'buildHostSnapshot attaches sparkline series when history is available',
        () => {
            const snapshot = buildHostSnapshot({
                host: { hostId: 'h1', name: 'web', maintenance: false },
                items: [
                    item({
                        itemid: 'cpu',
                        hostid: 'h1',
                        key_: 'system.cpu.util',
                        units: '%',
                        lastvalue: '10',
                    }),
                ],
                metrics: [getMetric('cpu')],
                thresholds: THRESHOLDS,
                seriesByItemId: new Map([
                    [
                        'cpu',
                        [
                            { t: 1, v: 9 },
                            { t: 2, v: 10 },
                        ],
                    ],
                ]),
            });

            assertEqual(snapshot.metrics[0].series.length, 2);
        },
    ],
    [
        'rescoreSnapshot recomputes severity without new data',
        () => {
            const snapshot = buildHostSnapshot({
                host: { hostId: 'h1', name: 'web', maintenance: false },
                items: [
                    item({ hostid: 'h1', key_: 'system.cpu.util', units: '%', lastvalue: '85' }),
                ],
                metrics: [getMetric('cpu')],
                thresholds: { warn: 95, crit: 99 },
            });
            assertEqual(snapshot.metrics[0].severity, SEVERITY.OK);

            const rescored = rescoreSnapshot(snapshot, { warn: 75, crit: 90 });
            assertEqual(rescored.metrics[0].severity, SEVERITY.WARN);
            assertEqual(snapshot.metrics[0].severity, SEVERITY.OK, 'input not mutated');
        },
    ],
    [
        'rescoreSnapshot marks a maintenance window',
        () => {
            const snapshot = buildHostSnapshot({
                host: { hostId: 'h1', name: 'web', maintenance: false },
                items: [
                    item({ hostid: 'h1', key_: 'system.cpu.util', units: '%', lastvalue: '99' }),
                ],
                metrics: [getMetric('cpu')],
                thresholds: THRESHOLDS,
            });
            const rescored = rescoreSnapshot(snapshot, THRESHOLDS, true);
            assertEqual(rescored.maintenance, true);
            assertEqual(rescored.metrics[0].severity, SEVERITY.MAINTENANCE);
        },
    ],
    [
        'a missing item never produces a green tile',
        () => {
            const snapshot = buildHostSnapshot({
                host: { hostId: 'h1', name: 'web', maintenance: false },
                items: [],
                metrics: [getMetric('cpu'), getMetric('disk')],
                thresholds: THRESHOLDS,
            });
            for (const metric of snapshot.metrics) {
                assert(metric.severity === SEVERITY.UNKNOWN, `${metric.id} must be unknown`);
            }
        },
    ],
    [
        'buildHostSnapshot counts only metrics that produced a value',
        () => {
            const snapshot = buildHostSnapshot({
                host: { hostId: 'h1', name: 'web', maintenance: false },
                items: [
                    item({
                        itemid: 'cpu',
                        hostid: 'h1',
                        key_: 'system.cpu.util',
                        units: '%',
                        lastvalue: '12',
                    }),
                ],
                metrics: [getMetric('cpu'), getMetric('disk'), getMetric('swap')],
                thresholds: THRESHOLDS,
            });

            assertEqual(snapshot.metricCount, 1);
            assertEqual(snapshot.metrics.length, 3, 'every tile is still rendered');
        },
    ],
    [
        'buildHostSnapshot reports the newest reading as collectedAt',
        () => {
            const snapshot = buildHostSnapshot({
                host: { hostId: 'h1', name: 'web', maintenance: false },
                items: [
                    item({
                        itemid: 'cpu',
                        hostid: 'h1',
                        key_: 'system.cpu.util',
                        units: '%',
                        lastvalue: '12',
                        lastclock: '1700000100',
                    }),
                    item({
                        itemid: 'mem',
                        hostid: 'h1',
                        key_: 'vm.memory.utilization',
                        units: '%',
                        lastvalue: '44',
                        lastclock: '1700000900',
                    }),
                ],
                metrics: [getMetric('cpu'), getMetric('memory')],
                thresholds: THRESHOLDS,
            });

            assertEqual(snapshot.collectedAt, 1700000900);
        },
    ],
    [
        'buildHostSnapshot reports no collectedAt without usable readings',
        () => {
            const snapshot = buildHostSnapshot({
                host: { hostId: 'h1', name: 'web', maintenance: false },
                items: [],
                metrics: [getMetric('cpu')],
                thresholds: THRESHOLDS,
            });

            assertEqual(snapshot.collectedAt, 0);
            assertEqual(snapshot.metricCount, 0);
        },
    ],
    [
        'orderHosts puts hosts with readings first regardless of name order',
        () => {
            // Observed on a stock 7.4 install: the built-in "Zabbix server"
            // host sorts before a lowercase hostname and matches nothing in the
            // catalog, so picking hosts[0] rendered a panel full of dashes.
            const ordered = orderHosts([
                { name: 'Zabbix server', metricCount: 0 },
                { name: 'deliveredge-prod', metricCount: 5 },
            ]);

            assertEqual(ordered[0].name, 'deliveredge-prod');
        },
    ],
    [
        'orderHosts breaks ties by name and does not mutate its input',
        () => {
            const input = [
                { name: 'web-b', metricCount: 3 },
                { name: 'web-a', metricCount: 3 },
                { name: 'db', metricCount: 9 },
            ];
            const ordered = orderHosts(input);

            assertDeepEqual(
                ordered.map((host) => host.name),
                ['db', 'web-a', 'web-b'],
            );
            assertEqual(input[0].name, 'web-b', 'input array must be untouched');
        },
    ],
    [
        'orderHosts tolerates an empty or missing list',
        () => {
            assertDeepEqual(orderHosts([]), []);
            assertDeepEqual(orderHosts(null), []);
        },
    ],
    [
        'resolveMetric treats a never-collected item as missing, not as zero',
        () => {
            // A stock Zabbix install answers item.get for an item that has never
            // collected with lastvalue "0" AND lastclock "0". Verified against
            // 7.0.32 and 7.4.16 — reading the value alone paints a dead agent
            // green at 0 %, the single most misleading thing this panel could do.
            const view = resolveMetric(
                getMetric('cpu'),
                [
                    item({
                        itemid: 'never',
                        key_: 'system.cpu.util',
                        units: '%',
                        lastvalue: '0',
                        lastclock: '0',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, null);
            assertEqual(view.severity, SEVERITY.UNKNOWN);
            assertEqual(view.available, false);
        },
    ],
    [
        'resolveMetric still reports a genuine zero reading',
        () => {
            const view = resolveMetric(
                getMetric('containers'),
                [
                    item({
                        itemid: 'c',
                        key_: 'docker.containers.running',
                        value_type: '3',
                        units: '',
                        lastvalue: '0',
                        lastclock: '1700000000',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 0);
            assertEqual(view.available, true);
            assertEqual(view.severity, SEVERITY.OK);
        },
    ],
    [
        'resolveMetric sums only the network interfaces that have reported',
        () => {
            const view = resolveMetric(
                getMetric('network'),
                [
                    item({
                        itemid: 'in',
                        key_: 'net.if.in["eth0"]',
                        value_type: '3',
                        units: 'bps',
                        lastvalue: '1000',
                        lastclock: '1700000000',
                    }),
                    item({
                        itemid: 'out',
                        key_: 'net.if.out["eth0"]',
                        value_type: '3',
                        units: 'bps',
                        lastvalue: '0',
                        lastclock: '0',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 1000);
        },
    ],
    [
        'buildMetricSeries merges sources whose clocks differ by a few seconds',
        () => {
            // net.if.in and net.if.out are stamped as each value arrives, not
            // as one cycle. Exact-timestamp summing showed a curve that
            // alternated between the interfaces instead of adding them.
            const view = {
                aggregate: AGGREGATE.SUM,
                sourceItemId: 'in',
                sourceItemIds: ['in', 'out'],
            };
            const map = new Map([
                [
                    'in',
                    [
                        { t: 1000, v: 10 },
                        { t: 1060, v: 20 },
                        { t: 1120, v: 30 },
                    ],
                ],
                [
                    'out',
                    [
                        { t: 1004, v: 1 },
                        { t: 1063, v: 2 },
                        { t: 1119, v: 3 },
                    ],
                ],
            ]);

            // The densest source owns the timestamps; the sibling's sample is
            // folded in, not substituted for its own clock.
            assertDeepEqual(buildMetricSeries(view, map), [
                { t: 1000, v: 11 },
                { t: 1060, v: 22 },
                { t: 1120, v: 33 },
            ]);
        },
    ],
    [
        'buildMetricSeries never double counts one item in a merged cycle',
        () => {
            const view = {
                aggregate: AGGREGATE.SUM,
                sourceItemId: 'in',
                sourceItemIds: ['in', 'out'],
            };
            const map = new Map([
                [
                    'in',
                    [
                        { t: 1000, v: 10 },
                        { t: 1005, v: 99 },
                    ],
                ],
                ['out', [{ t: 1002, v: 1 }]],
            ]);

            // Two points of one item are two samples, never one sum. Only
            // `out` (2 s away) joins the first cycle; the 1005 sample keeps its
            // own value.
            assertDeepEqual(buildMetricSeries(view, map), [
                { t: 1000, v: 11 },
                { t: 1005, v: 99 },
            ]);
        },
    ],
    [
        'buildMetricSeries keeps a cycle when one source is missing a point',
        () => {
            const view = {
                aggregate: AGGREGATE.SUM,
                sourceItemId: 'in',
                sourceItemIds: ['in', 'out'],
            };
            const map = new Map([
                [
                    'in',
                    [
                        { t: 1000, v: 10 },
                        { t: 1060, v: 20 },
                    ],
                ],
                ['out', [{ t: 1003, v: 1 }]],
            ]);

            assertDeepEqual(buildMetricSeries(view, map), [
                { t: 1000, v: 11 },
                { t: 1060, v: 20 },
            ]);
        },
    ],
    [
        'buildMetricSeries does not merge samples from different cycles',
        () => {
            // A 10 s cadence with a 7 s offset is ambiguous by nature; what
            // must hold is that a sample outside half an interval is not
            // folded in, and no phantom cycle is invented.
            const view = {
                aggregate: AGGREGATE.SUM,
                sourceItemId: 'in',
                sourceItemIds: ['in', 'out'],
            };
            const map = new Map([
                [
                    'in',
                    [
                        { t: 0, v: 1 },
                        { t: 10, v: 2 },
                    ],
                ],
                [
                    'out',
                    [
                        { t: 7, v: 10 },
                        { t: 17, v: 20 },
                    ],
                ],
            ]);

            assertDeepEqual(buildMetricSeries(view, map), [
                { t: 0, v: 1 },
                { t: 10, v: 12 },
            ]);
        },
    ],
    [
        'resolveMetric adds the absolute amount behind the memory percentage',
        () => {
            // 8 GiB total, 63 % used → the small line reads "5/8 GB".
            const view = resolveMetric(
                getMetric('memory'),
                [
                    item({
                        itemid: 'mem',
                        key_: 'vm.memory.util',
                        units: '%',
                        lastvalue: '63',
                        lastclock: '1700000000',
                    }),
                    item({
                        itemid: 'memtot',
                        key_: 'vm.memory.size[total]',
                        value_type: '3',
                        units: 'B',
                        lastvalue: String(8 * 1024 ** 3),
                        lastclock: '1700000000',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 63);
            assertEqual(view.detail, '5/8 GB');
        },
    ],
    [
        'resolveMetric derives a missing memory total from available bytes',
        () => {
            // Some templates publish free bytes and a free percentage but no
            // total. 3 GiB available at 37.5 % free describes an 8 GiB host.
            const view = resolveMetric(
                getMetric('memory'),
                [
                    item({
                        itemid: 'mem',
                        key_: 'vm.memory.util',
                        units: '%',
                        lastvalue: '63',
                    }),
                    item({
                        itemid: 'available',
                        key_: 'vm.memory.size[available]',
                        value_type: '3',
                        units: 'B',
                        lastvalue: String(3 * 1024 ** 3),
                    }),
                    item({
                        itemid: 'pavailable',
                        key_: 'vm.memory.size[pavailable]',
                        units: '%',
                        lastvalue: '37.5',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.detail, '5/8 GB');
        },
    ],
    [
        'resolveMetric derives the disk total from the mount that matched',
        () => {
            // The total belongs to the same mount as the percentage:
            // vfs.fs.size[/hostfs,pused] → vfs.fs.size[/hostfs,total].
            const view = resolveMetric(
                getMetric('disk'),
                [
                    item({
                        itemid: 'used',
                        key_: 'vfs.fs.size[/hostfs,pused]',
                        units: '%',
                        lastvalue: '67',
                        lastclock: '1700000000',
                    }),
                    item({
                        itemid: 'total',
                        key_: 'vfs.fs.size[/hostfs,total]',
                        value_type: '3',
                        units: 'B',
                        lastvalue: String(64 * 1024 ** 3),
                        lastclock: '1700000000',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.sourceItemKey, 'vfs.fs.size[/hostfs,pused]');
            assertEqual(view.detail, '42.9/64 GB · /hostfs');
        },
    ],
    [
        'resolveMetric still names the mount when the host reports no total',
        () => {
            // The production /hostfs item is created by hand with no sibling;
            // the mount is still worth a second line.
            const view = resolveMetric(
                getMetric('disk'),
                [
                    item({
                        itemid: 'used',
                        key_: 'vfs.fs.size[/hostfs,pused]',
                        units: '%',
                        lastvalue: '55',
                        lastclock: '1700000000',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 55);
            assertEqual(view.detail, '/hostfs');
        },
    ],
    [
        'resolveMetric derives the disk total from a free-percentage fallback',
        () => {
            const view = resolveMetric(
                getMetric('disk'),
                [
                    item({
                        itemid: 'free',
                        key_: 'vfs.fs.size[/hostfs,pfree]',
                        units: '%',
                        lastvalue: '31',
                    }),
                    item({
                        itemid: 'total',
                        key_: 'vfs.fs.size[/hostfs,total]',
                        value_type: '3',
                        units: 'B',
                        lastvalue: String(64 * 1024 ** 3),
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 69);
            assertEqual(view.detail, '44.2/64 GB · /hostfs');
        },
    ],
    [
        'resolveMetric adds core count and load to the CPU tile',
        () => {
            const view = resolveMetric(
                getMetric('cpu'),
                [
                    item({
                        itemid: 'cpu',
                        key_: 'system.cpu.util',
                        units: '%',
                        lastvalue: '42',
                    }),
                    item({
                        itemid: 'cores',
                        key_: 'system.cpu.num',
                        value_type: '3',
                        lastvalue: '8',
                    }),
                    item({
                        itemid: 'load',
                        key_: 'system.cpu.load[all,avg1]',
                        lastvalue: '0.42',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 42);
            assertEqual(view.detail, '8 cores · load 0.42');
        },
    ],
    [
        'resolveMetric does not repeat load when load is the CPU headline',
        () => {
            const view = resolveMetric(
                getMetric('cpu'),
                [
                    item({
                        itemid: 'load',
                        key_: 'system.cpu.load[all,avg1]',
                        lastvalue: '1.5',
                    }),
                    item({
                        itemid: 'cores',
                        key_: 'system.cpu.num',
                        value_type: '3',
                        lastvalue: '4',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.kind, VALUE_KIND.LOAD);
            assertEqual(view.value, 1.5);
            assertEqual(view.detail, '4 cores');
        },
    ],
    [
        'resolveMetric splits network throughput into inbound and outbound',
        () => {
            const view = resolveMetric(
                getMetric('network'),
                [
                    item({
                        itemid: 'in',
                        key_: 'net.if.in["eth0"]',
                        value_type: '3',
                        units: 'bps',
                        lastvalue: '2100000',
                    }),
                    item({
                        itemid: 'out',
                        key_: 'net.if.out["eth0"]',
                        value_type: '3',
                        units: 'bps',
                        lastvalue: '400000',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 2500000);
            assertEqual(view.detail, '↓ 2.1 · ↑ 0.4 Mb/s');
        },
    ],
    [
        'resolveMetric shows the stopped container count beside the running one',
        () => {
            const view = resolveMetric(
                getMetric('containers'),
                [
                    item({
                        itemid: 'running',
                        key_: 'docker.containers.running',
                        value_type: '3',
                        lastvalue: '21',
                    }),
                    item({
                        itemid: 'stopped',
                        key_: 'docker.containers.stopped',
                        value_type: '3',
                        lastvalue: '2',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 21);
            assertEqual(view.detail, '2 stopped');
        },
    ],
    [
        'resolveMetric adds the total process count to the running headline',
        () => {
            const view = resolveMetric(
                getMetric('processes'),
                [
                    item({
                        itemid: 'running',
                        key_: 'proc.num[,,run]',
                        value_type: '3',
                        lastvalue: '250',
                    }),
                    item({
                        itemid: 'total',
                        key_: 'proc.num',
                        value_type: '3',
                        lastvalue: '312',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 250);
            assertEqual(view.detail, '312 total');
        },
    ],
    [
        'resolveMetric adds the swap usage ratio',
        () => {
            const view = resolveMetric(
                getMetric('swap'),
                [
                    item({
                        itemid: 'used',
                        key_: 'system.swap.size[,pused]',
                        units: '%',
                        lastvalue: '25',
                    }),
                    item({
                        itemid: 'total',
                        key_: 'system.swap.size[,total]',
                        value_type: '3',
                        units: 'B',
                        lastvalue: String(4 * 1024 ** 3),
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.detail, '1/4 GB');
        },
    ],
    [
        'resolveMetric adds the core count to the Load tile',
        () => {
            const view = resolveMetric(
                getMetric('load'),
                [
                    item({
                        itemid: 'load',
                        key_: 'system.cpu.load[all,avg1]',
                        lastvalue: '1.5',
                    }),
                    item({
                        itemid: 'cores',
                        key_: 'system.cpu.num',
                        value_type: '3',
                        lastvalue: '4',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.detail, '4 cores');
        },
    ],
    [
        'resolveMetric never invents a detail for metrics without a spec',
        () => {
            const view = resolveMetric(
                getMetric('uptime'),
                [
                    item({
                        itemid: 'uptime',
                        key_: 'system.uptime',
                        value_type: '3',
                        units: 's',
                        lastvalue: '3600',
                    }),
                ],
                { thresholds: THRESHOLDS },
            );

            assertEqual(view.value, 3600);
            assertEqual(view.detail, '');
        },
    ],
]);
