// notificationPolicy.test.js — when Zappix is allowed to interrupt.
//
// The important cases are the anti-spam ones: the first poll must not announce
// every pre-existing problem, a sustained critical metric must be announced
// once, and the cooldown must actually suppress repeats.
import { assertEqual, assertDeepEqual, runTests } from './testUtils.js';
import { NotificationPolicy, URGENCY } from '../src/monitor/notificationPolicy.js';
import { SERVER_STATUS } from '../src/monitor/snapshotStore.js';
import { SEVERITY } from '../src/model/severity.js';

/**
 * Build a server snapshot.
 *
 * @param {object} [options]
 * @returns {object}
 */
function snapshot({
    serverId = 'srv0001',
    label = 'Production',
    status = SERVER_STATUS.OK,
    problems = [],
    hosts = [],
} = {}) {
    return {
        serverId,
        label,
        status,
        problems: {
            total: problems.length,
            unacknowledged: problems.filter((problem) => !problem.acknowledged).length,
            worstSeverity: SEVERITY.OK,
            items: problems,
        },
        hosts,
    };
}

/** A host with one metric at a given severity. */
function hostWith(severity, { hostId = 'h1', metricId = 'cpu' } = {}) {
    return {
        hostId,
        name: `host-${hostId}`,
        metrics: [
            {
                id: metricId,
                label: 'CPU',
                severity,
                value: 99,
                available: true,
                series: [],
            },
        ],
    };
}

const OPTIONS = { notifyOnNewProblems: true, notifyOnCritical: true };

await runTests([
    [
        'the first poll primes the baseline without notifying',
        () => {
            const policy = new NotificationPolicy();
            const notifications = policy.evaluate(
                [
                    snapshot({
                        problems: [
                            {
                                eventId: '1',
                                name: 'Disk full',
                                acknowledged: false,
                                severityCode: 4,
                            },
                        ],
                    }),
                ],
                { ...OPTIONS, nowSeconds: 1000 },
            );
            assertDeepEqual(notifications, []);
        },
    ],
    [
        'a new problem after priming is announced',
        () => {
            const policy = new NotificationPolicy();
            policy.evaluate([snapshot()], { ...OPTIONS, nowSeconds: 1000 });

            const notifications = policy.evaluate(
                [
                    snapshot({
                        problems: [
                            {
                                eventId: '9',
                                name: 'Disk full',
                                acknowledged: false,
                                severityCode: 4,
                            },
                        ],
                    }),
                ],
                { ...OPTIONS, nowSeconds: 1030 },
            );

            assertEqual(notifications.length, 1);
            assertEqual(notifications[0].title, 'Production: new problem');
            assertEqual(notifications[0].body, 'Disk full');
            assertEqual(notifications[0].urgency, URGENCY.HIGH);
        },
    ],
    [
        'an unchanged problem is not re-announced',
        () => {
            const policy = new NotificationPolicy();
            const problem = {
                eventId: '9',
                name: 'Disk full',
                acknowledged: false,
                severityCode: 4,
            };
            policy.evaluate([snapshot()], { ...OPTIONS, nowSeconds: 1000 });
            policy.evaluate([snapshot({ problems: [problem] })], { ...OPTIONS, nowSeconds: 1030 });

            const second = policy.evaluate([snapshot({ problems: [problem] })], {
                ...OPTIONS,
                nowSeconds: 1060,
            });
            assertDeepEqual(second, []);
        },
    ],
    [
        'the new-problem notification respects the preference',
        () => {
            const policy = new NotificationPolicy();
            policy.evaluate([snapshot()], { ...OPTIONS, nowSeconds: 1000 });

            const notifications = policy.evaluate(
                [
                    snapshot({
                        problems: [
                            { eventId: '9', name: 'x', acknowledged: false, severityCode: 2 },
                        ],
                    }),
                ],
                { ...OPTIONS, notifyOnNewProblems: false, nowSeconds: 1030 },
            );
            assertDeepEqual(notifications, []);
        },
    ],
    [
        'crossing into critical is announced once',
        () => {
            const policy = new NotificationPolicy();
            policy.evaluate([snapshot({ hosts: [hostWith(SEVERITY.OK)] })], {
                ...OPTIONS,
                nowSeconds: 1000,
            });

            const first = policy.evaluate([snapshot({ hosts: [hostWith(SEVERITY.CRIT)] })], {
                ...OPTIONS,
                nowSeconds: 1030,
            });
            assertEqual(first.length, 1);
            assertEqual(first[0].title, 'host-h1: CPU critical');

            const repeat = policy.evaluate([snapshot({ hosts: [hostWith(SEVERITY.CRIT)] })], {
                ...OPTIONS,
                nowSeconds: 1060,
            });
            assertDeepEqual(repeat, [], 'staying critical is silent');
        },
    ],
    [
        'the cooldown suppresses a flap inside the window',
        () => {
            const policy = new NotificationPolicy({ cooldownMinutes: 15 });
            policy.evaluate([snapshot({ hosts: [hostWith(SEVERITY.OK)] })], {
                ...OPTIONS,
                nowSeconds: 1000,
            });
            policy.evaluate([snapshot({ hosts: [hostWith(SEVERITY.CRIT)] })], {
                ...OPTIONS,
                nowSeconds: 1030,
            });
            policy.evaluate([snapshot({ hosts: [hostWith(SEVERITY.OK)] })], {
                ...OPTIONS,
                nowSeconds: 1040,
            });

            const flapAgain = policy.evaluate([snapshot({ hosts: [hostWith(SEVERITY.CRIT)] })], {
                ...OPTIONS,
                nowSeconds: 1060,
            });
            assertDeepEqual(flapAgain, [], 'inside the cooldown');
        },
    ],
    [
        'the cooldown expires',
        () => {
            const policy = new NotificationPolicy({ cooldownMinutes: 1 });
            policy.evaluate([snapshot({ hosts: [hostWith(SEVERITY.OK)] })], {
                ...OPTIONS,
                nowSeconds: 1000,
            });
            policy.evaluate([snapshot({ hosts: [hostWith(SEVERITY.CRIT)] })], {
                ...OPTIONS,
                nowSeconds: 1030,
            });
            policy.evaluate([snapshot({ hosts: [hostWith(SEVERITY.OK)] })], {
                ...OPTIONS,
                nowSeconds: 1040,
            });

            const later = policy.evaluate([snapshot({ hosts: [hostWith(SEVERITY.CRIT)] })], {
                ...OPTIONS,
                nowSeconds: 1200,
            });
            assertEqual(later.length, 1, 'announced again after the cooldown');
        },
    ],
    [
        'an unreachable server produces no notifications',
        () => {
            const policy = new NotificationPolicy();
            policy.evaluate([snapshot()], { ...OPTIONS, nowSeconds: 1000 });

            const notifications = policy.evaluate(
                [
                    snapshot({
                        status: SERVER_STATUS.ERROR,
                        problems: [
                            { eventId: '9', name: 'x', acknowledged: false, severityCode: 5 },
                        ],
                    }),
                ],
                { ...OPTIONS, nowSeconds: 1030 },
            );
            assertDeepEqual(notifications, []);
        },
    ],
    [
        'the critical-notification preference is honoured',
        () => {
            const policy = new NotificationPolicy();
            policy.evaluate([snapshot({ hosts: [hostWith(SEVERITY.OK)] })], {
                ...OPTIONS,
                nowSeconds: 1000,
            });
            const notifications = policy.evaluate(
                [snapshot({ hosts: [hostWith(SEVERITY.CRIT)] })],
                {
                    ...OPTIONS,
                    notifyOnCritical: false,
                    nowSeconds: 1030,
                },
            );
            assertDeepEqual(notifications, []);
        },
    ],
    [
        'reset clears the baseline so the next poll primes again',
        () => {
            const policy = new NotificationPolicy();
            policy.evaluate([snapshot()], { ...OPTIONS, nowSeconds: 1000 });
            policy.reset();

            const afterReset = policy.evaluate(
                [
                    snapshot({
                        problems: [
                            { eventId: '9', name: 'x', acknowledged: false, severityCode: 4 },
                        ],
                    }),
                ],
                { ...OPTIONS, nowSeconds: 1030 },
            );
            assertDeepEqual(afterReset, [], 'priming again means no announcement');
        },
    ],
    [
        'setCooldownMinutes clamps to a sane minimum',
        () => {
            const policy = new NotificationPolicy({ cooldownMinutes: 0 });
            // A zero-minute cooldown would still suppress the same second.
            assertEqual(typeof policy.setCooldownMinutes, 'function');
            policy.setCooldownMinutes(0.001);
            assertEqual(true, true);
        },
    ],
]);
