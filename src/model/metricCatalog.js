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
 * Recipes for the small secondary line under a tile value.
 *
 * A detail spec lives beside the metric in this catalog and names the extra
 * items it needs. `normalize.js` resolves those items into text; a host that
 * does not publish them simply renders without the line instead of with a
 * placeholder.
 */
export const DETAIL_KIND = Object.freeze({
    /** Percentage + total bytes → `5/7.5 GB` (+ disk mount when available). */
    USAGE: 'usage',
    /** CPU: core count plus the 1-minute load → `8 cores · load 0.42`. */
    CPU: 'cpu',
    /** Core count alone, for the Load tile → `8 cores`. */
    CORES: 'cores',
    /** Network: inbound/outbound split → `↓ 2.1 · ↑ 0.4 Mb/s`. */
    DIRECTIONS: 'directions',
    /** Stopped containers, beside the running headline → `2 stopped`. */
    STOPPED: 'stopped',
    /** Total count behind a running count → `312 total`. */
    TOTAL: 'total',
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
 *
 * `detail` describes the smaller second line under the tile value. Its `search`
 * terms are added to `item.get` even when no headline candidate needs them.
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
        // A percentage without context is hard to read: 42 % of what? The
        // core count says how many CPUs are being averaged, and the 1-minute
        // load is the absolute figure an operator would ask for next.
        detail: Object.freeze({
            kind: DETAIL_KIND.CPU,
            search: Object.freeze([
                'system.cpu.num',
                'system.cpu.load[all,avg1]',
                'system.cpu.load[percpu,avg1]',
            ]),
            coreKeys: Object.freeze(['system.cpu.num']),
            loadKeys: Object.freeze(['system.cpu.load[all,avg1]', 'system.cpu.load[percpu,avg1]']),
        }),
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
        // "63 %" answers *how bad*, not *how much*. The tile's second line
        // reads `5/7.5 GB`, derived from the total the Linux template reports.
        // `available` + `pavailable` are the fallback for a template that has
        // the percentage but not the total item: total = available / pavailable.
        detail: Object.freeze({
            kind: DETAIL_KIND.USAGE,
            search: Object.freeze(['vm.memory.size[total]', 'vm.memory.size[available]']),
            totalKeys: Object.freeze(['vm.memory.size[total]']),
            availableKeys: Object.freeze(['vm.memory.size[available]']),
            availablePercentKeys: Object.freeze(['vm.memory.size[pavailable]']),
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
        // asks for `vfs.fs.size[/hostfs,total]`. The mount is shown beside the
        // figures because "Disk" alone does not say which filesystem is meant.
        // A hand-made /hostfs item with no sibling still gets the mount line.
        detail: Object.freeze({
            kind: DETAIL_KIND.USAGE,
            // The catch-all candidates already search these prefixes; listing
            // them here keeps the total items coming if those candidates ever
            // change.
            search: Object.freeze(['vfs.fs.size[', 'vfs.fs.dependent.size[']),
            totalKeyFromSource: Object.freeze([
                Object.freeze({ from: ',pused]', to: ',total]' }),
                // Free-percentage fallbacks name the same mount.
                Object.freeze({ from: ',pfree]', to: ',total]' }),
            ]),
            showMount: true,
        }),
    }),
    Object.freeze({
        id: 'swap',
        label: 'Swap',
        unitLabel: 'used',
        kind: VALUE_KIND.PERCENT,
        aggregate: AGGREGATE.MAX,
        higherIsWorse: true,
        sparkline: true,
        // Swap exhaustion is the step before the OOM killer, and the stock
        // Linux template always publishes the percentage, so the tile earns a
        // slot on the default dashboard rather than being opt-in.
        defaultEnabled: true,
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
        detail: Object.freeze({
            kind: DETAIL_KIND.USAGE,
            search: Object.freeze(['system.swap.size[,total]']),
            totalKeys: Object.freeze(['system.swap.size[,total]']),
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
                direction: 'in',
            }),
            Object.freeze({
                search: 'net.if.out[',
                excludeKeys: Object.freeze(['"lo"', '[lo]', 'errors', 'dropped']),
                transform: TRANSFORM.IDENTITY,
                direction: 'out',
            }),
        ]),
        // The headline sums both directions; the second line puts them back
        // apart, because "47 kb/s" does not say whether the server is serving
        // or downloading. The third line adds the calendar-month traffic total,
        // integrated from trend rows: on a metered VPS that number is the one
        // that runs out.
        detail: Object.freeze({
            kind: DETAIL_KIND.DIRECTIONS,
            monthlyTotal: true,
        }),
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
        // the stopped count beside it says how far it dropped.
        candidates: Object.freeze([
            Object.freeze({
                search: 'docker.containers.running',
                preferredKey: 'docker.containers.running',
                transform: TRANSFORM.IDENTITY,
            }),
        ]),
        detail: Object.freeze({
            kind: DETAIL_KIND.STOPPED,
            search: Object.freeze(['docker.containers.stopped']),
            stoppedKeys: Object.freeze(['docker.containers.stopped']),
        }),
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
        // Load is only meaningful against the number of CPUs: 4.0 is idle on
        // a 16-core box and overloaded on a dual-core one.
        detail: Object.freeze({
            kind: DETAIL_KIND.CORES,
            search: Object.freeze(['system.cpu.num']),
            coreKeys: Object.freeze(['system.cpu.num']),
        }),
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
            // "Running" is the headline because that is what the unit label
            // promises. The bare key is the total process count and becomes
            // the second line once the running item has answered.
            Object.freeze({
                search: 'proc.num[,,run]',
                preferredKey: 'proc.num[,,run]',
                transform: TRANSFORM.IDENTITY,
            }),
            Object.freeze({
                search: 'proc.num',
                preferredKey: 'proc.num',
                excludeKeys: Object.freeze(['[']),
                transform: TRANSFORM.IDENTITY,
            }),
        ]),
        // "250 running" is only half the answer; the total says whether that
        // is a quiet host or a process table that is mostly sleeping.
        detail: Object.freeze({
            kind: DETAIL_KIND.TOTAL,
            search: Object.freeze(['proc.num', 'proc.num[]']),
            totalKeys: Object.freeze(['proc.num', 'proc.num[]']),
        }),
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
 * `system.cpu.util` also matches `system.cpu.utilization`). Detail items are
 * included explicitly: `vm.memory.size[total]` shares no prefix with any
 * headline candidate, so without it the memory tile would have a percentage
 * and no absolute figure.
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
        for (const term of metric.detail?.search ?? []) {
            terms.add(term);
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
