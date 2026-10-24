// metricCatalog.test.js — catalog integrity.
//
// The catalog is the single source of truth for what the dashboard shows, so
// these tests guard the invariants the rest of the code assumes: unique ids,
// every metric has at least one candidate, thresholds only apply to percentage
// metrics where higher is worse, and a bad preference array degrades to the
// defaults rather than an empty dashboard.
import { assert, assertDeepEqual, assertEqual, runTests } from './testUtils.js';
import {
    AGGREGATE,
    collectSearchTerms,
    DEFAULT_METRIC_IDS,
    getMetric,
    METRIC_IDS,
    METRICS,
    resolveEnabledMetrics,
    usesThresholds,
    VALUE_KIND,
} from '../src/model/metricCatalog.js';

await runTests([
    [
        'every metric id is unique',
        () => {
            assertEqual(new Set(METRIC_IDS).size, METRIC_IDS.length);
        },
    ],
    [
        'every metric has at least one candidate with a search term',
        () => {
            for (const metric of METRICS) {
                assert(metric.candidates.length > 0, `${metric.id} has no candidates`);
                for (const candidate of metric.candidates) {
                    assert(
                        typeof candidate.search === 'string' && candidate.search.length > 0,
                        `${metric.id} has an empty search term`,
                    );
                }
            }
        },
    ],
    [
        'every metric declares a known value kind',
        () => {
            const kinds = new Set(Object.values(VALUE_KIND));
            for (const metric of METRICS) {
                assert(kinds.has(metric.kind), `${metric.id} has kind ${metric.kind}`);
            }
        },
    ],
    [
        'every metric declares a known aggregate strategy',
        () => {
            const aggregates = new Set(Object.values(AGGREGATE));
            for (const metric of METRICS) {
                assert(aggregates.has(metric.aggregate), `${metric.id} aggregate invalid`);
            }
        },
    ],
    [
        'only percentages where higher is worse use thresholds',
        () => {
            assertEqual(usesThresholds(getMetric('cpu')), true);
            assertEqual(usesThresholds(getMetric('disk')), true);
            assertEqual(usesThresholds(getMetric('network')), false);
            assertEqual(usesThresholds(getMetric('uptime')), false);
            assertEqual(usesThresholds(undefined), false);
        },
    ],
    [
        'the network metric combines inbound and outbound',
        () => {
            const network = getMetric('network');
            assertEqual(network.combineAllCandidates, true);
            assertEqual(network.candidates.length, 2);
        },
    ],
    [
        'the cpu metric excludes per-mode breakdowns from its primary candidate',
        () => {
            const primary = getMetric('cpu').candidates[0];
            assertEqual(primary.preferredKey, 'system.cpu.util');
            assertDeepEqual(primary.excludeKeys, [',']);
        },
    ],
    [
        'the disk metric prefers the host root that containerised agents expose',
        () => {
            // DeliverEdge mounts the VPS root at /hostfs and creates this item
            // by hand; stock filesystem discovery inside the agent container
            // does not describe the machine. Verified against Zabbix 7.4.
            assertEqual(getMetric('disk').candidates[0].preferredKey, 'vfs.fs.size[/hostfs,pused]');
            assertEqual(
                getMetric('disk').candidates[1].preferredKey,
                'vfs.fs.dependent.size[/,pused]',
            );
            assertEqual(getMetric('disk').candidates[2].preferredKey, 'vfs.fs.size[/,pused]');
        },
    ],
    [
        'the disk metric filters discovered mounts by mode and excludes bind mounts',
        () => {
            const anyPused = getMetric('disk').candidates.find(
                (candidate) => candidate.includeKeys?.[0] === ',pused]',
            );
            assert(anyPused, 'a catch-all percentage candidate must exist');
            assert(anyPused.excludeKeys.includes('/etc/'), 'single-file bind mounts excluded');
        },
    ],
    [
        'the container count metric exists and is not a percentage',
        () => {
            const containers = getMetric('containers');
            assert(containers, 'containers metric missing');
            assertEqual(containers.kind, VALUE_KIND.COUNT);
            assertEqual(containers.candidates[0].preferredKey, 'docker.containers.running');
            assertEqual(usesThresholds(containers), false);
        },
    ],
    [
        'default metric ids are a subset of the catalog',
        () => {
            for (const id of DEFAULT_METRIC_IDS) {
                assert(METRIC_IDS.includes(id), `${id} is not in the catalog`);
            }
            assertEqual(DEFAULT_METRIC_IDS.length >= 3, true);
        },
    ],
    [
        'resolveEnabledMetrics preserves catalog order regardless of input order',
        () => {
            const resolved = resolveEnabledMetrics(['disk', 'cpu']);
            assertDeepEqual(
                resolved.map((metric) => metric.id),
                ['cpu', 'disk'],
            );
        },
    ],
    [
        'resolveEnabledMetrics drops unknown ids',
        () => {
            const resolved = resolveEnabledMetrics(['cpu', 'nonsense']);
            assertDeepEqual(
                resolved.map((metric) => metric.id),
                ['cpu'],
            );
        },
    ],
    [
        'resolveEnabledMetrics falls back to defaults for an empty list',
        () => {
            const resolved = resolveEnabledMetrics([]);
            assertDeepEqual(
                resolved.map((metric) => metric.id),
                [...DEFAULT_METRIC_IDS],
            );
        },
    ],
    [
        'resolveEnabledMetrics tolerates a non-array',
        () => {
            const resolved = resolveEnabledMetrics(undefined);
            assert(resolved.length > 0, 'must never return an empty dashboard');
        },
    ],
    [
        'collectSearchTerms deduplicates shared prefixes',
        () => {
            const terms = collectSearchTerms([getMetric('cpu'), getMetric('cpu')]);
            assertEqual(new Set(terms).size, terms.length);
        },
    ],
]);
