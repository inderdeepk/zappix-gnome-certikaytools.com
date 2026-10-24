// series.js — pure geometry and statistics for the sparklines.
//
// The sparkline is a Cairo drawing, but every decision it makes is arithmetic:
// how many samples to keep, where a sample lands in a 96-pixel-wide strip, how
// the area under the curve closes. Keeping that here means the widgets contain
// no maths worth testing and the tests need no drawing context.
//
// The downsampler is a bucket-extrema pass rather than a naive stride: an
// evenly-spaced sample of a one-hour CPU trace usually misses the very spike
// the operator is looking for, while min/max per bucket cannot.

/**
 * Convert `history.get` rows into an ordered numeric series.
 *
 * Rows arrive oldest-first (the query sorts by clock) but Zabbix may return
 * several records with the same second, so the result is normalised rather
 * than trusted. Non-numeric payloads are dropped: an item switching from
 * numeric to text would otherwise poison the whole sparkline.
 *
 * @param {Array<{clock: string|number, value: string|number}>} rows
 * @returns {Array<{t: number, v: number}>}
 */
export function toNumericSeries(rows) {
    const points = [];
    for (const row of rows ?? []) {
        const t = Number.parseInt(String(row?.clock ?? ''), 10);
        const v = Number.parseFloat(String(row?.value ?? ''));
        if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
        points.push({ t, v });
    }
    points.sort((a, b) => a.t - b.t);
    return points;
}

/**
 * Reduce a series to at most `maxPoints` while preserving its extremes.
 *
 * Each output bucket contributes its lowest and highest sample, in the order
 * they occurred, so peaks survive the reduction. When the series is already
 * short enough it is returned unchanged (same array, no copy).
 *
 * @param {Array<{t:number, v:number}>} points
 * @param {number} maxPoints
 * @returns {Array<{t:number, v:number}>}
 */
export function downsample(points, maxPoints) {
    const source = points ?? [];
    const target = Math.max(2, Math.floor(maxPoints));

    if (source.length <= target) return source;

    const buckets = Math.floor(target / 2);
    const size = source.length / buckets;
    const output = [];

    for (let bucket = 0; bucket < buckets; bucket++) {
        const start = Math.floor(bucket * size);
        const end = Math.min(source.length, Math.floor((bucket + 1) * size));
        if (end <= start) continue;

        let lowIndex = start;
        let highIndex = start;
        for (let index = start + 1; index < end; index++) {
            if (source[index].v < source[lowIndex].v) lowIndex = index;
            if (source[index].v > source[highIndex].v) highIndex = index;
        }

        const first = Math.min(lowIndex, highIndex);
        const second = Math.max(lowIndex, highIndex);
        output.push(source[first]);
        if (second !== first) output.push(source[second]);
    }

    return output;
}

/**
 * Statistics for a tile's caption and accessibility label.
 *
 * @param {Array<{v:number}>} points
 * @returns {{min:number, max:number, avg:number, last:number, count:number}|null}
 */
export function computeStats(points) {
    if (!points || points.length === 0) return null;

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;

    for (const point of points) {
        if (point.v < min) min = point.v;
        if (point.v > max) max = point.v;
        sum += point.v;
    }

    return {
        min,
        max,
        avg: sum / points.length,
        last: points[points.length - 1].v,
        count: points.length,
    };
}

/**
 * Map a series into a pixel box.
 *
 * A flat series is centred vertically instead of sitting on the floor: an idle
 * server at a constant 4% should draw a flat line in the middle of its strip,
 * which reads as "steady", not "zero".
 *
 * `floor`/`ceiling` pin the value axis so that CPU at 3% does not fill the
 * tile with an alarming-looking curve. Pass them from the caller when the
 * metric has a natural domain (percentages: 0..100).
 *
 * @param {Array<{v:number}>} points
 * @param {object} options
 * @param {number} options.width
 * @param {number} options.height
 * @param {number} [options.paddingX=0]
 * @param {number} [options.paddingY=2]
 * @param {number|null} [options.floor=null]
 * @param {number|null} [options.ceiling=null]
 * @returns {{points: Array<{x:number,y:number}>, min:number, max:number,
 *            baselineY:number, width:number, height:number}}
 */
export function buildSparklineGeometry(points, options) {
    const { width, height, paddingX = 0, paddingY = 2 } = options;
    const floor = options.floor ?? null;
    const ceiling = options.ceiling ?? null;

    const drawWidth = Math.max(1, width - paddingX * 2);
    const drawHeight = Math.max(1, height - paddingY * 2);
    const baselineY = height;

    if (!points || points.length === 0) {
        return { points: [], min: 0, max: 0, baselineY, width, height };
    }

    let min = floor ?? Infinity;
    let max = ceiling ?? -Infinity;

    for (const point of points) {
        if (floor === null && point.v < min) min = point.v;
        if (ceiling === null && point.v > max) max = point.v;
    }

    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 0;
    if (max === min) {
        // Flat series: give the renderer a band so it can centre the line.
        min -= 1;
        max += 1;
    }

    const span = max - min;
    const step = points.length > 1 ? drawWidth / (points.length - 1) : 0;

    const mapped = points.map((point, index) => {
        const ratio = (point.v - min) / span;
        const clamped = Math.min(1, Math.max(0, ratio));
        return {
            x: paddingX + step * index,
            y: paddingY + (1 - clamped) * drawHeight,
        };
    });

    return { points: mapped, min, max, baselineY, width, height };
}

/**
 * Cubic segments through a polyline using midpoint control points.
 *
 * Catmull-Rom would overshoot on spiky data and draw values the server never
 * reported; the midpoint variant stays inside the sampled envelope while still
 * removing the polygonal look.
 *
 * @param {Array<{x:number, y:number}>} points
 * @returns {Array<{x0:number,y0:number,x1:number,y1:number,x2:number,y2:number,x3:number,y3:number}>}
 */
export function buildBezierSegments(points) {
    if (!points || points.length < 2) return [];

    const segments = [];
    for (let index = 0; index < points.length - 1; index++) {
        const current = points[index];
        const next = points[index + 1];
        const previous = points[index - 1] ?? current;
        const after = points[index + 2] ?? next;

        // Control points pull 1/6 of the way toward the neighbouring samples,
        // the standard Catmull-Rom → Bézier conversion, damped to 1/8 so the
        // curve hugs the data.
        const control1x = current.x + (next.x - previous.x) / 8;
        const control1y = current.y + (next.y - previous.y) / 8;
        const control2x = next.x - (after.x - current.x) / 8;
        const control2y = next.y - (after.y - current.y) / 8;

        segments.push({
            x0: current.x,
            y0: current.y,
            x1: control1x,
            y1: control1y,
            x2: control2x,
            y2: control2y,
            x3: next.x,
            y3: next.y,
        });
    }
    return segments;
}

/**
 * Value range worth drawing for a metric.
 *
 * The tile's meter already shows where a percentage sits on 0..100, so the
 * sparkline shows *movement*: percentages, counts and load are fitted to their
 * own window, with a minimum span so rounding noise stays a flat line. On a
 * pinned 0..100 axis a 28-pixel strip moves a quarter pixel per point, and
 * every curve rendered as a straight line. Rates keep a zero floor because
 * zero traffic is itself the signal.
 *
 * @param {string} kind metric VALUE_KIND
 * @param {Array<{v:number}>} points
 * @returns {{floor: number|null, ceiling: number|null}}
 */
export function axisForKind(kind, points) {
    if (kind === 'percent') return fittedAxis(points, { minSpan: 20, lower: 0, upper: 100 });
    if (kind === 'count') return fittedAxis(points, { minSpan: 4, lower: 0 });
    if (kind === 'load') return fittedAxis(points, { minSpan: 1, lower: 0 });
    if (kind === 'duration') return { floor: 0, ceiling: null };
    const stats = computeStats(points);
    const ceiling = stats ? Math.max(1, stats.max * 1.15) : null;
    return { floor: 0, ceiling };
}

/**
 * Window around the data: at least `minSpan` tall, 25 % headroom on wide
 * swings, slid (not squashed) to stay inside the metric's natural domain.
 *
 * @param {Array<{v:number}>} points
 * @param {object} options
 * @param {number} options.minSpan
 * @param {number} [options.lower=-Infinity]
 * @param {number} [options.upper=Infinity]
 * @returns {{floor: number|null, ceiling: number|null}}
 */
function fittedAxis(points, { minSpan, lower = -Infinity, upper = Infinity }) {
    const stats = computeStats(points);
    if (!stats) {
        return {
            floor: Number.isFinite(lower) ? lower : null,
            ceiling: Number.isFinite(upper) ? upper : null,
        };
    }

    const span = Math.min(upper - lower, Math.max(minSpan, (stats.max - stats.min) * 1.25));
    const centre = (stats.max + stats.min) / 2;
    let floor = centre - span / 2;
    let ceiling = centre + span / 2;

    if (floor < lower) {
        ceiling += lower - floor;
        floor = lower;
    }
    if (ceiling > upper) {
        floor = Math.max(lower, floor - (ceiling - upper));
        ceiling = upper;
    }

    return { floor, ceiling };
}

/**
 * Is the series trending up over its own window?
 *
 * Used for the small direction caret; it compares the first and last thirds so
 * a single noisy sample cannot flip the arrow.
 *
 * @param {Array<{v:number}>} points
 * @returns {'up'|'down'|'flat'}
 */
export function trendDirection(points) {
    if (!points || points.length < 4) return 'flat';

    const third = Math.floor(points.length / 3);
    const head = points.slice(0, third);
    const tail = points.slice(-third);
    const headAvg = head.reduce((sum, point) => sum + point.v, 0) / head.length;
    const tailAvg = tail.reduce((sum, point) => sum + point.v, 0) / tail.length;

    const delta = tailAvg - headAvg;
    const scale = Math.max(Math.abs(headAvg), Math.abs(tailAvg), 1);

    // 5% of scale keeps normal jitter from being reported as a trend.
    if (delta > scale * 0.05) return 'up';
    if (delta < -scale * 0.05) return 'down';
    return 'flat';
}
