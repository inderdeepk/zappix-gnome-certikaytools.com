// series.test.js — sparkline geometry and statistics.
//
// The downsampler and the axis mapper decide what the operator actually sees,
// so both are pinned here. The important property is that a spike survives
// reduction: an evenly-spaced sample of a CPU trace usually throws away the very
// peak that explains an alert.
import { assert, assertClose, assertDeepEqual, assertEqual, runTests } from './testUtils.js';
import {
    axisForKind,
    buildBezierSegments,
    buildSparklineGeometry,
    computeStats,
    downsample,
    toNumericSeries,
    trendDirection,
} from '../src/model/series.js';

/** Build a series from plain values, one second apart. */
function series(values) {
    return values.map((v, index) => ({ t: 1000 + index, v }));
}

await runTests([
    [
        'toNumericSeries converts strings and sorts by time',
        () => {
            const points = toNumericSeries([
                { clock: '102', value: '2.5' },
                { clock: '101', value: '1.5' },
            ]);
            assertDeepEqual(points, [
                { t: 101, v: 1.5 },
                { t: 102, v: 2.5 },
            ]);
        },
    ],
    [
        'toNumericSeries drops non-numeric rows',
        () => {
            const points = toNumericSeries([
                { clock: '100', value: 'n/a' },
                { clock: '101', value: '3' },
                { clock: '', value: '4' },
            ]);
            assertDeepEqual(points, [{ t: 101, v: 3 }]);
        },
    ],
    [
        'toNumericSeries tolerates null',
        () => {
            assertDeepEqual(toNumericSeries(null), []);
        },
    ],
    [
        'downsample returns the input unchanged when it already fits',
        () => {
            const input = series([1, 2, 3]);
            assertEqual(downsample(input, 10), input);
        },
    ],
    [
        'downsample preserves the global maximum',
        () => {
            const values = Array.from({ length: 200 }, (_, index) =>
                index === 77 ? 99 : index % 7,
            );
            const reduced = downsample(series(values), 40);
            assert(reduced.length <= 40, `expected <= 40 points, got ${reduced.length}`);
            assertEqual(Math.max(...reduced.map((point) => point.v)), 99);
        },
    ],
    [
        'downsample preserves the global minimum',
        () => {
            const values = Array.from({ length: 200 }, (_, index) =>
                index === 33 ? -5 : index % 7,
            );
            const reduced = downsample(series(values), 40);
            assertEqual(Math.min(...reduced.map((point) => point.v)), -5);
        },
    ],
    [
        'downsample enforces a floor of two points',
        () => {
            const reduced = downsample(series([1, 2, 3, 4]), 1);
            assert(reduced.length >= 2, 'at least two points survive');
        },
    ],
    [
        'computeStats reports min, max, average and last',
        () => {
            const stats = computeStats(series([4, 2, 6]));
            assertEqual(stats.min, 2);
            assertEqual(stats.max, 6);
            assertEqual(stats.last, 6);
            assertClose(stats.avg, 4);
            assertEqual(stats.count, 3);
        },
    ],
    [
        'computeStats returns null for no data',
        () => {
            assertEqual(computeStats([]), null);
        },
    ],
    [
        'buildSparklineGeometry maps a percentage series onto a 0..100 axis',
        () => {
            const geometry = buildSparklineGeometry(series([0, 50, 100]), {
                width: 100,
                height: 40,
                paddingX: 0,
                paddingY: 0,
                floor: 0,
                ceiling: 100,
            });
            assertClose(geometry.points[0].y, 40, 1e-6);
            assertClose(geometry.points[1].y, 20, 1e-6);
            assertClose(geometry.points[2].y, 0, 1e-6);
            assertClose(geometry.points[2].x, 100, 1e-6);
        },
    ],
    [
        'buildSparklineGeometry centres a flat series',
        () => {
            const geometry = buildSparklineGeometry(series([5, 5, 5]), {
                width: 100,
                height: 40,
                paddingX: 0,
                paddingY: 0,
            });
            // With no pinned axis a flat series widens to ±1 and sits in the middle.
            assertClose(geometry.points[1].y, 20, 1e-6);
        },
    ],
    [
        'buildSparklineGeometry clamps values outside the pinned axis',
        () => {
            const geometry = buildSparklineGeometry(series([-20, 130]), {
                width: 10,
                height: 10,
                paddingX: 0,
                paddingY: 0,
                floor: 0,
                ceiling: 100,
            });
            assert(geometry.points[0].y <= 10, 'below-floor value stays on canvas');
            assert(geometry.points[1].y >= 0, 'above-ceiling value stays on canvas');
        },
    ],
    [
        'buildSparklineGeometry handles an empty series',
        () => {
            const geometry = buildSparklineGeometry([], { width: 50, height: 20 });
            assertDeepEqual(geometry.points, []);
        },
    ],
    [
        'buildBezierSegments produces one segment per gap',
        () => {
            const segments = buildBezierSegments([
                { x: 0, y: 0 },
                { x: 10, y: 5 },
                { x: 20, y: 0 },
            ]);
            assertEqual(segments.length, 2);
            assertEqual(segments[0].x0, 0);
            assertEqual(segments[1].x3, 20);
        },
    ],
    [
        'buildBezierSegments needs at least two points',
        () => {
            assertDeepEqual(buildBezierSegments([{ x: 0, y: 0 }]), []);
            assertDeepEqual(buildBezierSegments(null), []);
        },
    ],
    [
        'axisForKind pins percentages and auto-scales rates',
        () => {
            assertDeepEqual(axisForKind('percent', series([1])), { floor: 0, ceiling: 100 });
            const rate = axisForKind('rate', series([10, 20]));
            assertEqual(rate.floor, 0);
            assert(rate.ceiling > 20, 'ceiling has headroom');
        },
    ],
    [
        'axisForKind gives a sane ceiling for an empty rate series',
        () => {
            const rate = axisForKind('rate', []);
            assert(rate.ceiling === null || rate.ceiling >= 1, 'never a zero-height axis');
        },
    ],
    [
        'trendDirection detects a rise',
        () => {
            assertEqual(trendDirection(series([1, 2, 3, 40, 50, 60])), 'up');
        },
    ],
    [
        'trendDirection detects a fall',
        () => {
            assertEqual(trendDirection(series([60, 50, 40, 3, 2, 1])), 'down');
        },
    ],
    [
        'trendDirection reports flat for noise',
        () => {
            assertEqual(trendDirection(series([10, 10.1, 9.9, 10, 10.05, 9.95])), 'flat');
        },
    ],
    [
        'trendDirection reports flat for short series',
        () => {
            assertEqual(trendDirection(series([1, 9])), 'flat');
        },
    ],
]);
