// backoff.test.js — retry pacing.
//
// The rules: back off exponentially on failure, reset on success, and jitter a
// healthy poll so a fleet of desktops does not synchronise. Getting this wrong is
// invisible in development and expensive in production, so the ladder is pinned.
import { assert, assertEqual, runTests } from './testUtils.js';
import {
    BACKOFF_CEILING_SECONDS,
    describeDelay,
    nextDelaySeconds,
    shouldAbandon,
} from '../src/monitor/backoff.js';

/** Jitter-free random for deterministic assertions. */
const noJitter = () => 0.5;

await runTests([
    [
        'a healthy poll uses the base interval',
        () => {
            assertEqual(
                nextDelaySeconds({ baseSeconds: 30, consecutiveFailures: 0, random: noJitter }),
                30,
            );
        },
    ],
    [
        'the first failure waits one base interval',
        () => {
            assertEqual(
                nextDelaySeconds({ baseSeconds: 30, consecutiveFailures: 1, random: noJitter }),
                30,
            );
        },
    ],
    [
        'each further failure doubles the wait',
        () => {
            const two = nextDelaySeconds({
                baseSeconds: 30,
                consecutiveFailures: 2,
                random: noJitter,
            });
            const three = nextDelaySeconds({
                baseSeconds: 30,
                consecutiveFailures: 3,
                random: noJitter,
            });
            const four = nextDelaySeconds({
                baseSeconds: 30,
                consecutiveFailures: 4,
                random: noJitter,
            });
            assertEqual(two, 60);
            assertEqual(three, 120);
            assertEqual(four, 240);
        },
    ],
    [
        'the wait is capped',
        () => {
            const delay = nextDelaySeconds({
                baseSeconds: 30,
                consecutiveFailures: 40,
                random: noJitter,
            });
            assertEqual(delay, BACKOFF_CEILING_SECONDS);
        },
    ],
    [
        'a custom ceiling is honoured',
        () => {
            assertEqual(
                nextDelaySeconds({
                    baseSeconds: 30,
                    consecutiveFailures: 10,
                    ceilingSeconds: 100,
                    random: noJitter,
                }),
                100,
            );
        },
    ],
    [
        'jitter only moves a healthy poll and stays inside the band',
        () => {
            const low = nextDelaySeconds({
                baseSeconds: 100,
                consecutiveFailures: 0,
                random: () => 0,
            });
            const high = nextDelaySeconds({
                baseSeconds: 100,
                consecutiveFailures: 0,
                random: () => 1,
            });
            assert(low >= 85 && low <= 100, `low jitter out of band: ${low}`);
            assert(high >= 100 && high <= 115, `high jitter out of band: ${high}`);
        },
    ],
    [
        'jitter can be disabled',
        () => {
            const delay = nextDelaySeconds({
                baseSeconds: 100,
                consecutiveFailures: 0,
                jitterRatio: 0,
                random: () => 0,
            });
            assertEqual(delay, 100);
        },
    ],
    [
        'a failing server does not jitter, so its recovery is predictable',
        () => {
            const a = nextDelaySeconds({
                baseSeconds: 30,
                consecutiveFailures: 3,
                random: () => 0,
            });
            const b = nextDelaySeconds({
                baseSeconds: 30,
                consecutiveFailures: 3,
                random: () => 1,
            });
            assertEqual(a, b);
        },
    ],
    [
        'the delay never drops below one second',
        () => {
            assertEqual(
                nextDelaySeconds({ baseSeconds: 0, consecutiveFailures: 0, random: noJitter }) >= 1,
                true,
            );
        },
    ],
    [
        'negative failure counts are treated as healthy',
        () => {
            assertEqual(
                nextDelaySeconds({ baseSeconds: 20, consecutiveFailures: -5, random: noJitter }),
                20,
            );
        },
    ],
    [
        'describeDelay renders seconds, minutes and hours',
        () => {
            assertEqual(describeDelay(30), '30s');
            assertEqual(describeDelay(120), '2m');
            assertEqual(describeDelay(7200), '2h');
        },
    ],
    [
        'shouldAbandon never trips for realistic failure counts',
        () => {
            assertEqual(shouldAbandon(0), false);
            assertEqual(shouldAbandon(50), false);
        },
    ],
]);
