// format.test.js — the exact strings the dashboard renders.
//
// Formatters are the most obvious thing to break silently: a byte size that
// reads "1024 KB" instead of "1 MB" is not an error anywhere, it is just wrong
// on screen. These cases pin the rounding boundaries and the em-dash fallbacks.
import { assertEqual, runTests } from './testUtils.js';
import {
    formatBitRate,
    formatBitRateCompact,
    formatBytes,
    formatBytesCompact,
    formatClockTime,
    formatCount,
    formatDuration,
    formatLoad,
    formatMetricValue,
    formatMetricValueCompact,
    formatPercent,
    formatRelativeTime,
    percentToFraction,
} from '../src/shared/format.js';
import { VALUE_KIND } from '../src/model/metricCatalog.js';

/** Build a unix timestamp `seconds` before a fixed "now". */
const NOW = 1_700_000_000;
const ago = (seconds) => NOW - seconds;

await runTests([
    [
        'formatPercent rounds to whole percent',
        () => {
            assertEqual(formatPercent(42.4), '42%');
            assertEqual(formatPercent(42.6), '43%');
        },
    ],
    [
        'formatPercent clamps outside 0..100',
        () => {
            assertEqual(formatPercent(-3), '0%');
            assertEqual(formatPercent(151), '100%');
        },
    ],
    [
        'formatPercent emits an em dash for no data',
        () => {
            assertEqual(formatPercent(null), '—');
            assertEqual(formatPercent(undefined), '—');
            assertEqual(formatPercent('n/a'), '—');
        },
    ],
    [
        'formatPercent honours a decimal count and trims ".0"',
        () => {
            assertEqual(formatPercent(10, { decimals: 1 }), '10%');
            assertEqual(formatPercent(10.25, { decimals: 2 }), '10.25%');
        },
    ],
    [
        'formatBytes scales to IEC units',
        () => {
            assertEqual(formatBytes(512), '512 B');
            assertEqual(formatBytes(2048), '2 KB');
            assertEqual(formatBytes(1536 * 1024), '1.5 MB');
            assertEqual(formatBytes(3 * 1024 ** 3), '3 GB');
        },
    ],
    [
        'formatBytes emits an em dash for no data',
        () => {
            assertEqual(formatBytes(null), '—');
        },
    ],
    [
        'formatBitRate uses SI units, matching the Zabbix frontend',
        () => {
            assertEqual(formatBitRate(18_200_000), '18.2 Mb/s');
            assertEqual(formatBitRate(640_000), '640 kb/s');
            assertEqual(formatBitRate(2_500_000_000), '2.5 Gb/s');
            assertEqual(formatBitRate(120), '120 b/s');
        },
    ],
    [
        'formatBitRateCompact is panel sized',
        () => {
            assertEqual(formatBitRateCompact(18_200_000), '18M');
            assertEqual(formatBitRateCompact(640_000), '640k');
            assertEqual(formatBitRateCompact(2_500_000_000), '2.5G');
            assertEqual(formatBitRateCompact(120), '120');
        },
    ],
    [
        'formatDuration keeps two units at most',
        () => {
            assertEqual(formatDuration(48), '48s');
            assertEqual(formatDuration(60 * 45), '45m');
            assertEqual(formatDuration(3600 * 3 + 60 * 12), '3h 12m');
            assertEqual(formatDuration(86400 * 12 + 3600 * 4), '12d 4h');
        },
    ],
    [
        'formatDuration rejects negatives and gaps',
        () => {
            assertEqual(formatDuration(-1), '—');
            assertEqual(formatDuration(null), '—');
        },
    ],
    [
        'formatLoad always shows two decimals',
        () => {
            assertEqual(formatLoad(0.4), '0.40');
            assertEqual(formatLoad(3), '3.00');
            assertEqual(formatLoad(null), '—');
        },
    ],
    [
        'formatCount groups thousands',
        () => {
            assertEqual(formatCount(1284), '1,284');
            assertEqual(formatCount(999), '999');
            assertEqual(formatCount(1234567), '1,234,567');
            assertEqual(formatCount(-1234), '−1,234');
        },
    ],
    [
        'formatMetricValue dispatches on kind',
        () => {
            assertEqual(formatMetricValue(VALUE_KIND.PERCENT, 12), '12%');
            assertEqual(formatMetricValue(VALUE_KIND.DURATION, 90), '1m');
            assertEqual(formatMetricValue(VALUE_KIND.COUNT, 1500), '1,500');
            assertEqual(formatMetricValue(VALUE_KIND.LOAD, 1.234), '1.23');
        },
    ],
    [
        'formatMetricValue falls back for an unknown kind',
        () => {
            assertEqual(formatMetricValue('mystery', 5), '5');
            assertEqual(formatMetricValue('mystery', null), '—');
        },
    ],
    [
        'formatMetricValueCompact shortens rates',
        () => {
            assertEqual(formatMetricValueCompact(VALUE_KIND.RATE, 18_200_000), '18M');
        },
    ],
    [
        'formatClockTime renders 24-hour time',
        () => {
            // Constructed from a real Date so the assertion is timezone-safe:
            // we compare against the same local formatting the function uses.
            const date = new Date(NOW * 1000);
            const expected = `${String(date.getHours()).padStart(2, '0')}:${String(
                date.getMinutes(),
            ).padStart(2, '0')}`;
            assertEqual(formatClockTime(NOW), expected);
        },
    ],
    [
        'formatClockTime rejects a zero timestamp',
        () => {
            assertEqual(formatClockTime(0), '—');
            assertEqual(formatClockTime(null), '—');
        },
    ],
    [
        'formatRelativeTime walks the scale',
        () => {
            assertEqual(formatRelativeTime(ago(2), NOW), 'just now');
            assertEqual(formatRelativeTime(ago(30), NOW), '30s ago');
            assertEqual(formatRelativeTime(ago(180), NOW), '3m ago');
            assertEqual(formatRelativeTime(ago(7200), NOW), '2h ago');
            assertEqual(formatRelativeTime(ago(86400 * 2), NOW), '2d ago');
        },
    ],
    [
        'formatRelativeTime reports never for a missing timestamp',
        () => {
            assertEqual(formatRelativeTime(0, NOW), 'never');
            assertEqual(formatRelativeTime(null, NOW), 'never');
        },
    ],
    [
        'formatBytesCompact is caption sized',
        () => {
            assertEqual(formatBytesCompact(1024), '1K');
            assertEqual(formatBytesCompact(1536), '1.5K');
            assertEqual(formatBytesCompact(512), '512B');
        },
    ],
    [
        'percentToFraction clamps to 0..1',
        () => {
            assertEqual(percentToFraction(50), 0.5);
            assertEqual(percentToFraction(-10), 0);
            assertEqual(percentToFraction(150), 1);
            assertEqual(percentToFraction(null), 0);
        },
    ],
]);
