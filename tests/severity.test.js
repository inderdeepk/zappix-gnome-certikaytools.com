// severity.test.js — thresholds, problem severities and the "worst of" fold.
//
// The rules pinned here are the ones that make a monitoring tool trustworthy:
// a missing value is never green, and the critical colour is always reachable no
// matter how the preference values were hand-edited.
import { assertEqual, assertDeepEqual, runTests } from './testUtils.js';
import {
    classifyPercent,
    classifyProblemSeverity,
    isAlarming,
    sanitiseThresholds,
    SEVERITY,
    severityClass,
    urgency,
    worstSeverity,
} from '../src/model/severity.js';

await runTests([
    [
        'sanitiseThresholds keeps a valid pair',
        () => {
            assertDeepEqual(sanitiseThresholds(70, 90), { warn: 70, crit: 90 });
        },
    ],
    [
        'sanitiseThresholds clamps out-of-range values',
        () => {
            assertDeepEqual(sanitiseThresholds(-5, 400), { warn: 0, crit: 100 });
        },
    ],
    [
        'sanitiseThresholds makes the critical threshold reachable',
        () => {
            const thresholds = sanitiseThresholds(90, 90);
            assertEqual(thresholds.crit > thresholds.warn, true);
        },
    ],
    [
        'sanitiseThresholds survives a warn of 100',
        () => {
            const thresholds = sanitiseThresholds(100, 100);
            assertEqual(thresholds.crit, 100);
            assertEqual(thresholds.warn < thresholds.crit || thresholds.warn === 99, true);
        },
    ],
    [
        'sanitiseThresholds falls back for non-numeric input',
        () => {
            assertDeepEqual(sanitiseThresholds('nonsense', undefined), { warn: 75, crit: 90 });
        },
    ],
    [
        'classifyPercent reports ok below the warning threshold',
        () => {
            assertEqual(classifyPercent(10, { warn: 75, crit: 90 }), SEVERITY.OK);
        },
    ],
    [
        'classifyPercent reports warn at the warning threshold',
        () => {
            assertEqual(classifyPercent(75, { warn: 75, crit: 90 }), SEVERITY.WARN);
        },
    ],
    [
        'classifyPercent reports crit at the critical threshold',
        () => {
            assertEqual(classifyPercent(90, { warn: 75, crit: 90 }), SEVERITY.CRIT);
        },
    ],
    [
        'classifyPercent treats a missing value as unknown, never ok',
        () => {
            assertEqual(classifyPercent(null, { warn: 75, crit: 90 }), SEVERITY.UNKNOWN);
            assertEqual(classifyPercent(undefined, { warn: 75, crit: 90 }), SEVERITY.UNKNOWN);
            assertEqual(classifyPercent('', { warn: 75, crit: 90 }), SEVERITY.UNKNOWN);
            assertEqual(classifyPercent(Number.NaN, { warn: 75, crit: 90 }), SEVERITY.UNKNOWN);
        },
    ],
    [
        'classifyPercent defers to maintenance',
        () => {
            assertEqual(
                classifyPercent(99, { warn: 75, crit: 90 }, SEVERITY.MAINTENANCE),
                SEVERITY.MAINTENANCE,
            );
        },
    ],
    [
        'classifyProblemSeverity maps the Zabbix 0..5 scale',
        () => {
            assertEqual(classifyProblemSeverity(0), SEVERITY.OK);
            assertEqual(classifyProblemSeverity(1), SEVERITY.OK);
            assertEqual(classifyProblemSeverity(2), SEVERITY.WARN);
            assertEqual(classifyProblemSeverity(3), SEVERITY.WARN);
            assertEqual(classifyProblemSeverity(4), SEVERITY.CRIT);
            assertEqual(classifyProblemSeverity(5), SEVERITY.CRIT);
        },
    ],
    [
        'classifyProblemSeverity accepts stringified values',
        () => {
            assertEqual(classifyProblemSeverity('5'), SEVERITY.CRIT);
        },
    ],
    [
        'classifyProblemSeverity reports unknown for garbage',
        () => {
            assertEqual(classifyProblemSeverity('n/a'), SEVERITY.UNKNOWN);
        },
    ],
    [
        'worstSeverity picks the most alarming entry',
        () => {
            assertEqual(worstSeverity([SEVERITY.OK, SEVERITY.WARN, SEVERITY.CRIT]), SEVERITY.CRIT);
            assertEqual(worstSeverity([SEVERITY.OK, SEVERITY.WARN]), SEVERITY.WARN);
        },
    ],
    [
        'worstSeverity ranks unknown above ok but below warn',
        () => {
            assertEqual(worstSeverity([SEVERITY.OK, SEVERITY.UNKNOWN]), SEVERITY.UNKNOWN);
            assertEqual(worstSeverity([SEVERITY.UNKNOWN, SEVERITY.WARN]), SEVERITY.WARN);
        },
    ],
    [
        'worstSeverity treats maintenance as calm',
        () => {
            assertEqual(worstSeverity([SEVERITY.MAINTENANCE, SEVERITY.OK]), SEVERITY.OK);
        },
    ],
    [
        'worstSeverity returns ok for an empty list',
        () => {
            assertEqual(worstSeverity([]), SEVERITY.OK);
            assertEqual(worstSeverity(undefined), SEVERITY.OK);
        },
    ],
    [
        'isAlarming covers warn and crit only',
        () => {
            assertEqual(isAlarming(SEVERITY.WARN), true);
            assertEqual(isAlarming(SEVERITY.CRIT), true);
            assertEqual(isAlarming(SEVERITY.OK), false);
            assertEqual(isAlarming(SEVERITY.UNKNOWN), false);
            assertEqual(isAlarming(SEVERITY.MAINTENANCE), false);
        },
    ],
    [
        'urgency sorts critical first',
        () => {
            assertEqual(urgency(SEVERITY.CRIT) < urgency(SEVERITY.WARN), true);
            assertEqual(urgency(SEVERITY.WARN) < urgency(SEVERITY.OK), true);
        },
    ],
    [
        'severityClass produces the CSS class name',
        () => {
            assertEqual(severityClass(SEVERITY.CRIT), 'zappix-sev-crit');
        },
    ],
]);
