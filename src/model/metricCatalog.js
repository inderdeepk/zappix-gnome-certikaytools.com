// metricCatalog.js — the single source of truth for *what* Zappix shows.
//
// Every dashboard tile is described here once: how to find it on a Zabbix
// server, how to aggregate it across interfaces/filesystems, how to format it,
// and whether a utilization threshold applies. The API layer turns a catalog
// entry into `item.get` search terms, the model layer turns matched items into
// a value, and the UI layer turns that value into a tile — all three read the
// same definition, so adding a metric is a one-file change.
//
// The item keys below are the ones shipped by Zabbix's stock "Linux by Zabbix
// agent" template across 5.0 → 7.x. Where the template changed over time, the
// candidates array is ordered newest-first and carries a `transform` that
// normalises the older shape into the same unit. Anything the server does not
// have simply resolves to "no data" instead of erroring.

/**
 * How a raw value becomes a display value.
 *
 *   identity    — use as-is
 *   fraction    — 0..1 becomes 0..100
 *   invert      — 100 - value (for "free %" items)
 *   autoPercent — honour the item's own `units` field: '%' passes through,
 *                 an empty unit with a value in 0..1 is treated as a fraction
 */
export const TRANSFORM = Object.freeze({
    IDENTITY: 'identity',
    FRACTION: 'fraction',
    INVERT: 'invert',
    AUTO_PERCENT: 'autoPercent',
});

/** Value kinds drive formatting and which thresholds are meaningful. */
export const VALUE_KIND = Object.freeze({
    PERCENT: 'percent',
    RATE: 'rate',
    LOAD: 'load',
    DURATION: 'duration',
    COUNT: 'count',
});

/**
 * Aggregate strategies when several items match one metric (one per network
 * interface, one per filesystem, one per CPU mode…).
 */
export const AGGREGATE = Object.freeze({
    /** Highest value wins — "the fullest filesystem is the one that matters". */
    MAX: 'max',
    /** Sum every match — network throughput across interfaces. */
    SUM: 'sum',
    /** First match in catalog candidate order. */
    FIRST: 'first',
});

/**
 * Metric definitions, in display order.
 *
 * `candidates[].search` is a substring handed to `item.get`'s `search`/`key_`
 * parameter; `candidates[].preferredKey` breaks ties when several items match
 * the same search term (Zabbix returns them alphabetically, which is not a
 * useful priority).
 */
export const METRICS = Object.freeze([
    Object.freeze({
        id: 'cpu',
        label: 'CPU',
        unitLabel: 'utilization',
        kind: VALUE_KIND.PERCENT,
        aggregate: AGGREGATE.MAX,
        higherIsWorse: true,
        sparkline: true,
        defaultEnabled: true,
        // The stock Linux template's headline item is the *dependent* key
        // `system.cpu.util` (computed as 100 - idle). The same prefix also
        // matches the nine per-mode breakdowns (`system.cpu.util[,user]`, …),
        // so every candidate below that is not the dependent item excludes
        // keys containing a comma.
        candidates: Object.freeze([
            Object.freeze({
                search: 'system.cpu.util',
                preferredKey: 'system.cpu.util',
                excludeKeys: Object.freeze([',']),
                transform: TRANSFORM.AUTO_PERCENT,
            }),
            // Older/custom templates only ship the master idle item, and a few
            // third-party templates use the `-ization` spelling.
            Object.freeze({
                search: 'system.cpu.util[,idle]',
                preferredKey: 'system.cpu.util[,idle]',
                transform: TRANSFORM.INVERT,
            }),
            Object.freeze({
                search: 'system.cpu.utilization',
                transform: TRANSFORM.AUTO_PERCENT,
            }),
            // Last resort on a host with no utilization item: load average is
            // not a percentage, but it is the closest honest signal.
            Object.freeze({
                search: 'system.cpu.load[',
                includeKeys: Object.freeze(['avg1']),
                transform: TRANSFORM.IDENTITY,
                fallbackKind: VALUE_KIND.LOAD,
            }),
        ]),
    }),
    Object.freeze({
        id: 'memory',
        label: 'Memory',
        unitLabel: 'in use',
        kind: VALUE_KIND.PERCENT,
        aggregate: AGGREGATE.MAX,
        higherIsWorse: true,
        sparkline: true,
        defaultEnabled: true,
        candidates: Object.freeze([
            // `vm.memory.util` (no "-ization") is the shipped dependent item.
            Object.freeze({
                search: 'vm.memory.util',
                preferredKey: 'vm.memory.util',
                excludeKeys: Object.freeze([',']),
                transform: TRANSFORM.AUTO_PERCENT,
            }),
            Object.freeze({
                search: 'vm.memory.utilization',
                excludeKeys: Object.freeze(['[swap]']),
                transform: TRANSFORM.AUTO_PERCENT,
            }),
            Object.freeze({
                search: 'vm.memory.size[pavailable]',
                preferredKey: 'vm.memory.size[pavailable]',
                transform: TRANSFORM.INVERT,
            }),
            Object.freeze({
                search: 'vm.memory.size[pused]',
                transform: TRANSFORM.AUTO_PERCENT,
            }),
        ]),
        // "63 %" answers *how bad*, not *how much*. The tile's second line shows
        // "5.0 GB of 7.8 GB", derived from the total the Linux template reports.
        detail: Object.freeze({
            totalKeys: Object.freeze(['vm.memory.size[total]']),
        }),
    }),
    Object.freeze({
        id: 'disk',
        label: 'Disk',
        unitLabel: 'used',
        kind: VALUE_KIND.PERCENT,
        // A server with many mounts should surface the fullest one, not an
        // average that hides a nearly-full volume.
        aggregate: AGGREGATE.MAX,
        higherIsWorse: true,
        sparkline: true,
        defaultEnabled: true,
        candidates: Object.freeze([
            // The host root, as measured by an agent that can only see its own
            // mount namespace. DeliverEdge mounts the VPS root at /hostfs for
            // exactly this reason and adds the item by hand; when it exists it
            // is the only disk number that describes the actual machine.
            Object.freeze({
                search: 'vfs.fs.size[/hostfs,pused]',
                preferredKey: 'vfs.fs.size[/hostfs,pused]',
                transform: TRANSFORM.AUTO_PERCENT,
            }),
            // Stock template: a dependent item per discovered mount, with the
            // root filesystem the meaningful one.
            Object.freeze({
                search: 'vfs.fs.dependent.size[/,pused]',
                preferredKey: 'vfs.fs.dependent.size[/,pused]',
                transform: TRANSFORM.AUTO_PERCENT,
            }),
            Object.freeze({
                search: 'vfs.fs.size[/,pused]',
                preferredKey: 'vfs.fs.size[/,pused]',
                transform: TRANSFORM.AUTO_PERCENT,
            }),
            // Any mount, newest template first. Bind mounts of single files
            // are excluded: in a containerised agent they appear as
            // `/etc/hostname`, `/etc/hosts` and `/etc/localtime`, and their
            // labels say nothing about capacity even though their numbers are
            // technically valid.
            Object.freeze({
                search: 'vfs.fs.dependent.size[',
                includeKeys: Object.freeze([',pused]']),
                excludeKeys: Object.freeze(['/etc/', '/run/', '/var/run', '/dev/', '/sys/']),
                transform: TRANSFORM.AUTO_PERCENT,
            }),
            Object.freeze({
                search: 'vfs.fs.size[',
                includeKeys: Object.freeze([',pused]']),
                excludeKeys: Object.freeze(['/etc/', '/run/', '/var/run', '/dev/', '/sys/']),
                transform: TRANSFORM.AUTO_PERCENT,
            }),
            // Free-percentage variants, inverted, in the same preference order.
            Object.freeze({
                search: 'vfs.fs.size[/hostfs,pfree]',
                preferredKey: 'vfs.fs.size[/hostfs,pfree]',
                transform: TRANSFORM.INVERT,
            }),
            Object.freeze({
                search: 'vfs.fs.dependent.size[/,pfree]',
                preferredKey: 'vfs.fs.dependent.size[/,pfree]',
                transform: TRANSFORM.INVERT,
            }),
            Object.freeze({
                search: 'vfs.fs.size[/,pfree]',
                preferredKey: 'vfs.fs.size[/,pfree]',
                transform: TRANSFORM.INVERT,
            }),
        ]),
        // The total belongs to whichever mount supplied the percentage, so the
        // key is derived from the matched item: `vfs.fs.size[/hostfs,pused]`
        // asks for `vfs.fs.size[/hostfs,total]`. Missing → the tile simply has
        // no second line, which is why the manually created /hostfs item still
        // works without a sibling.
        detail: Object.freeze({
            totalKeyFromSource: Object.freeze({ from: ',pused]', to: ',total]' }),
        }),
    }),
    Object.freeze({
        id: 'network',
        label: 'Network',
        unitLabel: 'throughput',
        kind: VALUE_KIND.RATE,
        aggregate: AGGREGATE.SUM,
        higherIsWorse: false,
        sparkline: true,
        defaultEnabled: true,
        // Inbound and outbound are separate items; the tile reports the sum of
        // both directions, which is what "throughput" means on a dashboard.
        combineAllCandidates: true,
        // The template applies CHANGE_PER_SECOND + MULTIPLIER(8) to these
        // items, so the stored value is already bits per second and needs no
        // client-side delta — and it arrives as an UNSIGNED value_type, not a
        // float, which is why `history.get` has to group by value type.
        // Interface names are discovered, hence the prefix match; loopback and
        // the error/dropped siblings are filtered out.
        candidates: Object.freeze([
            Object.freeze({
                search: 'net.if.in[',
                excludeKeys: Object.freeze(['"lo"', '[lo]', 'errors', 'dropped']),
                transform: TRANSFORM.IDENTITY,
            }),
            Object.freeze({
                search: 'net.if.out[',
                excludeKeys: Object.freeze(['"lo"', '[lo]', 'errors', 'dropped']),
                transform: TRANSFORM.IDENTITY,
            }),
        ]),
    }),
    Object.freeze({
        id: 'containers',
        label: 'Containers',
        unitLabel: 'running',
        kind: VALUE_KIND.COUNT,
        aggregate: AGGREGATE.FIRST,
        higherIsWorse: false,
        sparkline: true,
        defaultEnabled: true,
        // Only a host with the "Docker by Zabbix agent 2" template answers
        // this. It is on by default because a containerised deployment has no
        // better one-glance signal: "running" dropping is the incident, and
        // the stopped count comes along in the tooltip via the item name.
        candidates: Object.freeze([
            Object.freeze({
                search: 'docker.containers.running',
                preferredKey: 'docker.containers.running',
                transform: TRANSFORM.IDENTITY,
            }),
        ]),
    }),
    Object.freeze({
        id: 'swap',
        label: 'Swap',
        unitLabel: 'used',
        kind: VALUE_KIND.PERCENT,
        aggregate: AGGREGATE.MAX,
        higherIsWorse: true,
        sparkline: true,
        defaultEnabled: false,
        candidates: Object.freeze([
            Object.freeze({
                search: 'system.swap.size[,pused]',
                preferredKey: 'system.swap.size[,pused]',
                transform: TRANSFORM.AUTO_PERCENT,
            }),
            // The shipped template always provides the *free* percentage.
            Object.freeze({
                search: 'system.swap.size[,pfree]',
                preferredKey: 'system.swap.size[,pfree]',
                transform: TRANSFORM.INVERT,
            }),
            Object.freeze({
                search: 'vm.memory.utilization[swap]',
                transform: TRANSFORM.AUTO_PERCENT,
            }),
        ]),
    }),
    Object.freeze({
        id: 'load',
        label: 'Load',
        unitLabel: '1 min avg',
        kind: VALUE_KIND.LOAD,
        aggregate: AGGREGATE.FIRST,
        higherIsWorse: false,
        sparkline: true,
        defaultEnabled: false,
        candidates: Object.freeze([
            // The template ships `all`; `percpu` exists on hand-made items and
            // on some older template revisions.
            Object.freeze({
                search: 'system.cpu.load[all,avg1]',
                preferredKey: 'system.cpu.load[all,avg1]',
                transform: TRANSFORM.IDENTITY,
            }),
            Object.freeze({
                search: 'system.cpu.load[percpu,avg1]',
                preferredKey: 'system.cpu.load[percpu,avg1]',
                transform: TRANSFORM.IDENTITY,
            }),
        ]),
    }),
    Object.freeze({
        id: 'uptime',
        label: 'Uptime',
        unitLabel: 'since last boot',
        kind: VALUE_KIND.DURATION,
        aggregate: AGGREGATE.MAX,
        higherIsWorse: false,
        // The template disables trend storage for uptime, and a monotonic ramp
        // is not informative as a 32-pixel curve.
        sparkline: false,
        defaultEnabled: false,
        candidates: Object.freeze([
            Object.freeze({
                search: 'system.uptime',
                preferredKey: 'system.uptime',
                excludeKeys: Object.freeze(['[']),
                transform: TRANSFORM.IDENTITY,
            }),
        ]),
    }),
    Object.freeze({
        id: 'processes',
        label: 'Processes',
        unitLabel: 'running',
        kind: VALUE_KIND.COUNT,
        aggregate: AGGREGATE.SUM,
        higherIsWorse: false,
        sparkline: true,
        defaultEnabled: false,
        candidates: Object.freeze([
            Object.freeze({
                search: 'proc.num',
                preferredKey: 'proc.num',
                excludeKeys: Object.freeze(['[']),
                transform: TRANSFORM.IDENTITY,
            }),
            Object.freeze({
                search: 'proc.num[,,run]',
                preferredKey: 'proc.num[,,run]',
                transform: TRANSFORM.IDENTITY,
            }),
        ]),
    }),
]);

/** Metric ids in display order. */
export const METRIC_IDS = Object.freeze(METRICS.map((metric) => metric.id));

/** Metrics enabled by default when no preference has been stored. */
export const DEFAULT_METRIC_IDS = Object.freeze(
    METRICS.filter((metric) => metric.defaultEnabled).map((metric) => metric.id),
);

/**
 * Look up a metric definition.
 *
 * @param {string} id
 * @returns {object|undefined}
 */
export function getMetric(id) {
    return METRICS.find((metric) => metric.id === id);
}

/**
 * Resolve a user preference array into metric definitions, preserving catalog
 * order and dropping unknown ids (so a downgrade cannot leave a dangling id).
 *
 * An empty result is never returned: the default set is used instead, because
 * a dashboard with zero tiles is indistinguishable from a bug.
 *
 * @param {string[]} ids
 * @returns {object[]}
 */
export function resolveEnabledMetrics(ids) {
    const requested = Array.isArray(ids) ? ids : [];
    const resolved = METRICS.filter((metric) => requested.includes(metric.id));
    if (resolved.length > 0) return resolved;
    return METRICS.filter((metric) => metric.defaultEnabled);
}

/**
 * Every `item.get` search term needed to resolve the requested metrics.
 *
 * Deduplicated because two metrics can share a candidate prefix (cpu's
 * `system.cpu.util` also matches `system.cpu.utilization`).
 *
 * @param {object[]} metrics
 * @returns {string[]}
 */
export function collectSearchTerms(metrics) {
    const terms = new Set();
    for (const metric of metrics) {
        for (const candidate of metric.candidates) {
            terms.add(candidate.search);
        }
    }
    return [...terms];
}

/**
 * Does this metric accept utilization thresholds?
 *
 * Only percentages where "higher is worse": a high network rate is not an
 * incident, and a high uptime is definitely not one.
 *
 * @param {object} metric
 * @returns {boolean}
 */
export function usesThresholds(metric) {
    return Boolean(metric && metric.kind === VALUE_KIND.PERCENT && metric.higherIsWorse);
}
