// snapshotStore.test.js — the state the panel and the dropdown share.
//
// The property that matters most here: a failed poll must not erase the last
// good numbers. An operator watching an incident needs to see what the server
// looked like immediately before it went unreachable.
import { assertEqual, assertDeepEqual, runTests } from './testUtils.js';
import {
    credentialWaitSnapshot,
    describeServer,
    failureSnapshot,
    initialSnapshot,
    isStale,
    metricHeadline,
    orderSnapshots,
    panelSummary,
    SERVER_STATUS,
    successSnapshot,
} from '../src/monitor/snapshotStore.js';
import { SEVERITY } from '../src/model/severity.js';

/** A minimal server definition. */
const SERVER = {
    id: 'srv0001',
    label: 'Production',
    colour: '#7aa2f7',
    baseUrl: 'https://monitor.example.com',
    authMode: 'token',
};

/** A host snapshot with one CPU metric. */
function host({ hostId = 'h1', value = 42, severity = SEVERITY.OK } = {}) {
    return {
        hostId,
        name: `host-${hostId}`,
        endpoint: '10.0.0.1:10050',
        availability: 'available',
        maintenance: false,
        worstSeverity: severity,
        metrics: [
            {
                id: 'cpu',
                label: 'CPU',
                kind: 'percent',
                value,
                severity,
                available: value !== null,
                series: [],
            },
        ],
    };
}

/** A problem summary with the given severity. */
function problems({ total = 0, unacknowledged = 0, worstSeverity = SEVERITY.OK } = {}) {
    return { total, unacknowledged, worstSeverity, oldestClock: 0, items: [] };
}

await runTests([
    [
        'initialSnapshot starts in the loading state',
        () => {
            const snapshot = initialSnapshot(SERVER);
            assertEqual(snapshot.status, SERVER_STATUS.LOADING);
            assertEqual(snapshot.serverId, 'srv0001');
            assertDeepEqual(snapshot.hosts, []);
            assertEqual(snapshot.fetchedAt, 0);
        },
    ],
    [
        'successSnapshot records hosts, problems and the worst severity',
        () => {
            const snapshot = successSnapshot({
                server: SERVER,
                hosts: [host({ severity: SEVERITY.WARN })],
                problems: problems({ total: 2, unacknowledged: 1, worstSeverity: SEVERITY.CRIT }),
                version: '7.0.3',
                fetchedAt: 1000,
            });

            assertEqual(snapshot.status, SERVER_STATUS.OK);
            assertEqual(snapshot.hostCount, 1);
            assertEqual(snapshot.version, '7.0.3');
            assertEqual(snapshot.worstSeverity, SEVERITY.CRIT);
            assertEqual(snapshot.consecutiveFailures, 0);
        },
    ],
    [
        'successSnapshot tolerates an empty server',
        () => {
            const snapshot = successSnapshot({ server: SERVER, hosts: [], fetchedAt: 1000 });
            assertEqual(snapshot.hostCount, 0);
            assertEqual(snapshot.worstSeverity, SEVERITY.OK);
        },
    ],
    [
        'failureSnapshot keeps the last good data',
        () => {
            const ok = successSnapshot({
                server: SERVER,
                hosts: [host({ value: 77 })],
                fetchedAt: 1000,
            });

            const failed = failureSnapshot(ok, {
                message: 'Connection refused',
                kind: 'network',
                fetchedAt: 1100,
            });

            assertEqual(failed.status, SERVER_STATUS.ERROR);
            assertEqual(failed.error, 'Connection refused');
            assertEqual(failed.errorKind, 'network');
            assertEqual(failed.hosts.length, 1, 'host data survives the failure');
            assertEqual(failed.hosts[0].metrics[0].value, 77);
            assertEqual(failed.fetchedAt, 1000, 'last successful fetch time is unchanged');
            assertEqual(failed.lastAttemptAt, 1100);
            assertEqual(failed.consecutiveFailures, 1);
        },
    ],
    [
        'failureSnapshot increments the failure count',
        () => {
            let snapshot = initialSnapshot(SERVER);
            snapshot = failureSnapshot(snapshot, { message: 'a', fetchedAt: 1 });
            snapshot = failureSnapshot(snapshot, { message: 'b', fetchedAt: 2 });
            assertEqual(snapshot.consecutiveFailures, 2);
        },
    ],
    [
        'isStale reports true for a snapshot that was never fetched',
        () => {
            assertEqual(isStale(initialSnapshot(SERVER), 1000), true);
        },
    ],
    [
        'isStale compares against the staleness window',
        () => {
            const snapshot = successSnapshot({ server: SERVER, hosts: [], fetchedAt: 1000 });
            assertEqual(isStale(snapshot, 1100, 180), false);
            assertEqual(isStale(snapshot, 1400, 180), true);
        },
    ],
    [
        'orderSnapshots floats critical servers to the top',
        () => {
            const ordered = orderSnapshots([
                { serverId: 'a', status: SERVER_STATUS.OK, worstSeverity: SEVERITY.OK },
                { serverId: 'b', status: SERVER_STATUS.OK, worstSeverity: SEVERITY.CRIT },
                { serverId: 'c', status: SERVER_STATUS.OK, worstSeverity: SEVERITY.WARN },
            ]);
            assertDeepEqual(
                ordered.map((snapshot) => snapshot.serverId),
                ['b', 'c', 'a'],
            );
        },
    ],
    [
        'orderSnapshots keeps configured order within a severity band',
        () => {
            const ordered = orderSnapshots([
                { serverId: 'a', status: SERVER_STATUS.OK, worstSeverity: SEVERITY.OK },
                { serverId: 'b', status: SERVER_STATUS.OK, worstSeverity: SEVERITY.OK },
            ]);
            assertDeepEqual(
                ordered.map((snapshot) => snapshot.serverId),
                ['a', 'b'],
            );
        },
    ],
    [
        'orderSnapshots sinks unreachable servers',
        () => {
            const ordered = orderSnapshots([
                { serverId: 'down', status: SERVER_STATUS.ERROR, worstSeverity: SEVERITY.CRIT },
                { serverId: 'up', status: SERVER_STATUS.OK, worstSeverity: SEVERITY.OK },
            ]);
            assertDeepEqual(
                ordered.map((snapshot) => snapshot.serverId),
                ['up', 'down'],
            );
        },
    ],
    [
        'panelSummary shows the active metric value',
        () => {
            const snapshot = successSnapshot({
                server: SERVER,
                hosts: [host({ value: 42 })],
                fetchedAt: 1000,
            });
            const summary = panelSummary({ activeSnapshot: snapshot, metric: 'cpu' });
            assertEqual(summary.text, '42%');
            assertEqual(summary.available, true);
            assertEqual(summary.label, 'CPU');
        },
    ],
    [
        'panelSummary fills the gauge to the percentage',
        () => {
            const snapshot = successSnapshot({
                server: SERVER,
                hosts: [host({ value: 42 })],
                fetchedAt: 1000,
            });
            const summary = panelSummary({ activeSnapshot: snapshot, metric: 'cpu' });
            assertEqual(summary.fraction, 0.42);
            assertEqual(summary.badge, null);
            assertEqual(summary.offline, false);
        },
    ],
    [
        'panelSummary clamps the gauge to 0..1',
        () => {
            const over = successSnapshot({
                server: SERVER,
                hosts: [host({ value: 140 })],
                fetchedAt: 1000,
            });
            const under = successSnapshot({
                server: SERVER,
                hosts: [host({ value: -3 })],
                fetchedAt: 1000,
            });
            assertEqual(panelSummary({ activeSnapshot: over, metric: 'cpu' }).fraction, 1);
            assertEqual(panelSummary({ activeSnapshot: under, metric: 'cpu' }).fraction, 0);
        },
    ],
    [
        'panelSummary closes the ring for a metric that is not a percentage',
        () => {
            const loadHost = host();
            loadHost.metrics[0] = { ...loadHost.metrics[0], kind: 'load', value: 1.5 };
            const snapshot = successSnapshot({ server: SERVER, hosts: [loadHost], fetchedAt: 1 });
            assertEqual(panelSummary({ activeSnapshot: snapshot, metric: 'cpu' }).fraction, 1);
        },
    ],
    [
        'panelSummary shows nothing before the first poll',
        () => {
            const summary = panelSummary({
                activeSnapshot: initialSnapshot(SERVER),
                metric: 'cpu',
            });
            assertEqual(summary.text, '');
            assertEqual(summary.available, false);
            assertEqual(summary.fraction, null);
            assertEqual(summary.offline, false);
        },
    ],
    [
        'panelSummary does not call an unpolled server all-clear in problems mode',
        () => {
            const summary = panelSummary({
                activeSnapshot: initialSnapshot(SERVER),
                metric: 'problems',
            });
            assertEqual(summary.available, false);
            assertEqual(summary.fraction, null);
            assertEqual(summary.severity, SEVERITY.UNKNOWN);
        },
    ],
    [
        'panelSummary draws a closed green ring when no problems are open',
        () => {
            const snapshot = successSnapshot({ server: SERVER, hosts: [host()], fetchedAt: 1000 });
            const summary = panelSummary({ activeSnapshot: snapshot, metric: 'problems' });
            assertEqual(summary.text, '');
            assertEqual(summary.severity, SEVERITY.OK);
            assertEqual(summary.fraction, 1);
            assertEqual(summary.available, true);
        },
    ],
    [
        'panelSummary shows the problem count when asked',
        () => {
            const snapshot = successSnapshot({
                server: SERVER,
                hosts: [host()],
                problems: problems({ total: 3, unacknowledged: 2, worstSeverity: SEVERITY.WARN }),
                fetchedAt: 1000,
            });
            const summary = panelSummary({ activeSnapshot: snapshot, metric: 'problems' });
            assertEqual(summary.text, '2');
            assertEqual(summary.severity, SEVERITY.WARN);
            assertEqual(summary.problemCount, 2);
            assertEqual(summary.fraction, 1);
            // The count is already the headline; a badge would repeat it.
            assertEqual(summary.badge, null);
        },
    ],
    [
        'panelSummary badges a critical problem without recolouring the metric',
        () => {
            const snapshot = successSnapshot({
                server: SERVER,
                hosts: [host({ severity: SEVERITY.OK })],
                problems: problems({ total: 1, unacknowledged: 1, worstSeverity: SEVERITY.CRIT }),
                fetchedAt: 1000,
            });
            const summary = panelSummary({
                activeSnapshot: snapshot,
                metric: 'cpu',
                alertOnProblems: true,
            });
            assertEqual(summary.severity, SEVERITY.OK);
            assertEqual(summary.badge, SEVERITY.CRIT);
            assertEqual(summary.problemCount, 1);
        },
    ],
    [
        'panelSummary badges low-severity problems amber',
        () => {
            const snapshot = successSnapshot({
                server: SERVER,
                hosts: [host()],
                problems: problems({ total: 1, unacknowledged: 1, worstSeverity: SEVERITY.OK }),
                fetchedAt: 1000,
            });
            const summary = panelSummary({ activeSnapshot: snapshot, metric: 'cpu' });
            assertEqual(summary.badge, SEVERITY.WARN);
        },
    ],
    [
        'panelSummary does not badge acknowledged problems',
        () => {
            const snapshot = successSnapshot({
                server: SERVER,
                hosts: [host()],
                problems: problems({ total: 2, unacknowledged: 0, worstSeverity: SEVERITY.CRIT }),
                fetchedAt: 1000,
            });
            assertEqual(panelSummary({ activeSnapshot: snapshot, metric: 'cpu' }).badge, null);
        },
    ],
    [
        'panelSummary ignores problems when the preference is off',
        () => {
            const snapshot = successSnapshot({
                server: SERVER,
                hosts: [host({ severity: SEVERITY.OK })],
                problems: problems({ total: 1, unacknowledged: 1, worstSeverity: SEVERITY.CRIT }),
                fetchedAt: 1000,
            });
            const summary = panelSummary({
                activeSnapshot: snapshot,
                metric: 'cpu',
                alertOnProblems: false,
            });
            assertEqual(summary.severity, SEVERITY.OK);
            assertEqual(summary.badge, null);
        },
    ],
    [
        'panelSummary keeps the last good value while the server is unreachable',
        () => {
            const good = successSnapshot({
                server: SERVER,
                hosts: [host({ value: 31 })],
                fetchedAt: 1000,
            });
            const failed = failureSnapshot(good, {
                message: 'Connection refused',
                fetchedAt: 1060,
            });
            const summary = panelSummary({ activeSnapshot: failed, metric: 'cpu' });
            assertEqual(summary.offline, true);
            assertEqual(summary.text, '31%');
            assertEqual(summary.fraction, 0.31);
        },
    ],
    [
        'panelSummary marks a never-reached server offline with an empty gauge',
        () => {
            const failed = failureSnapshot(initialSnapshot(SERVER), {
                message: 'Connection refused',
                fetchedAt: 1,
            });
            const summary = panelSummary({ activeSnapshot: failed, metric: 'cpu' });
            assertEqual(summary.offline, true);
            assertEqual(summary.available, false);
            assertEqual(summary.fraction, null);
        },
    ],
    [
        'panelSummary handles a missing server',
        () => {
            const summary = panelSummary({ activeSnapshot: null, metric: 'cpu' });
            assertEqual(summary.text, '');
            assertEqual(summary.severity, SEVERITY.UNKNOWN);
            assertEqual(summary.fraction, null);
            assertEqual(summary.badge, null);
        },
    ],
    [
        'describeServer summarises hosts and problems',
        () => {
            const snapshot = successSnapshot({
                server: SERVER,
                hosts: [host(), host({ hostId: 'h2' })],
                problems: problems({ total: 1, unacknowledged: 0, worstSeverity: SEVERITY.WARN }),
                fetchedAt: 1000,
            });
            assertEqual(describeServer(snapshot), '2 hosts · 1 problem');
        },
    ],
    [
        'describeServer uses the singular for one host and no problems',
        () => {
            const snapshot = successSnapshot({ server: SERVER, hosts: [host()], fetchedAt: 1000 });
            assertEqual(describeServer(snapshot), '1 host');
        },
    ],
    [
        'describeServer explains an unreachable server',
        () => {
            const failed = failureSnapshot(initialSnapshot(SERVER), {
                message: 'Connection refused',
                fetchedAt: 1,
            });
            assertEqual(describeServer(failed), 'Connection refused');
        },
    ],
    [
        'describeServer says why a server is waiting for its credential',
        () => {
            const waiting = credentialWaitSnapshot(
                initialSnapshot(SERVER),
                'Waiting for the login keyring…',
            );
            assertEqual(waiting.status, SERVER_STATUS.LOADING);
            assertEqual(waiting.errorKind, 'credentials');
            assertEqual(describeServer(waiting), 'Waiting for the login keyring…');
        },
    ],
    [
        'credentialWaitSnapshot keeps the last good data',
        () => {
            const previous = successSnapshot({
                server: SERVER,
                hosts: [host({ value: 31 })],
                fetchedAt: 1000,
            });
            const waiting = credentialWaitSnapshot(previous, 'Waiting for the login keyring…');
            assertEqual(waiting.status, SERVER_STATUS.LOADING);
            assertEqual(waiting.hostCount, 1);
            assertEqual(waiting.fetchedAt, 1000);
        },
    ],
    [
        'describeServer still says Connecting for a first-time load',
        () => {
            assertEqual(describeServer(initialSnapshot(SERVER)), 'Connecting…');
        },
    ],
    [
        'metricHeadline matches the tile text',
        () => {
            assertEqual(metricHeadline({ kind: 'percent', value: 12 }), '12%');
            assertEqual(metricHeadline({ kind: 'count', value: 1500 }), '1,500');
        },
    ],
]);
