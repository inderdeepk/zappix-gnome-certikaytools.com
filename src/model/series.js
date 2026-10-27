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

/** Trend field plotted on the curve: the hour's highest sample. */
export const TREND_PEAK_FIELD = 'value_max';

/** Seconds one trend row covers. Zabbix aggregates trends into whole hours. */
export const TREND_INTERVAL_SECONDS = 3600;

/**
 * Convert `trend.get` rows into an ordered numeric series of hourly peaks.
 *
 * The peak rather than the average is what makes a 24-hour curve answer "how
 * hard did this box work today": an hour of idle with one 90 % minute is a 90 %
 * hour for the operator looking for the spike. The series' maximum is therefore
 * also the window's true high-water mark, which is what the chart's top edge is
 * scaled to.
 *
 * @param {Array<{clock: string|number, value_max?: string|number}>} rows
 * @param {object} [options]
 * @param {string} [options.field=TREND_PEAK_FIELD] which aggregate to plot
 * @returns {Array<{t: number, v: number}>}
 */
export function toTrendSeries(rows, { field = TREND_PEAK_FIELD } = {}) {
    const points = [];
    for (const row of rows ?? []) {
        const t = Number.parseInt(String(row?.clock ?? ''), 10);
        const v = Number.parseFloat(String(row?.[field] ?? ''));
        if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
        points.push({ t, v });
    }
    points.sort((a, b) => a.t - b.t);
    return points;
}

/**
 * Bytes carried by a set of bits-per-second trend rows.
 *
 * Network items are stored as a rate, so the period total is the area under
 * the curve: each hour contributes its average rate for the whole hour. An
 * hour with no row contributes nothing, which is the honest reading — Zabbix
 * only writes a row when the item reported during that hour.
 *
 * @param {Array<{value_avg?: string|number}>} rows
 * @param {object} [options]
 * @param {number} [options.secondsPerRow=TREND_INTERVAL_SECONDS]
 * @returns {number|null} null when no row carried a usable average
 */
export function sumTrendBytes(rows, { secondsPerRow = TREND_INTERVAL_SECONDS } = {}) {
    let bits = 0;
    let counted = 0;

    for (const row of rows ?? []) {
        const average = Number.parseFloat(String(row?.value_avg ?? ''));
        if (!Number.isFinite(average) || average < 0) continue;
        bits += average * secondsPerRow;
        counted += 1;
    }

    return counted > 0 ? bits / 8 : null;
}

/**
 * Unix seconds at the start of the calendar month containing `nowSeconds`,
 * in local time — a bandwidth allowance resets on the operator's month, not
 * on the server's UTC month.
 *
 * @param {number} [nowSeconds=Date.now()/1000]
 * @returns {number}
 */
export function monthStartSeconds(nowSeconds = Date.now() / 1000) {
    const date = new Date(Number(nowSeconds) * 1000);
    return Math.floor(new Date(date.getFullYear(), date.getMonth(), 1).getTime() / 1000);
}

/**
 * Unix seconds at the top of the hour containing `nowSeconds`.
 *
 * Trend rows are hourly, so asking for the partial current hour only produces
 * a new query every poll; rounding down keeps the request (and its cache key)
 * stable until the next row can exist.
 *
 * @param {number} [nowSeconds=Date.now()/1000]
 * @returns {number}
 */
export function hourStartSeconds(nowSeconds = Date.now() / 1000) {
    return Math.floor(Number(nowSeconds) / TREND_INTERVAL_SECONDS) * TREND_INTERVAL_SECONDS;
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
 * Samples are placed by their timestamp, not by their index: a 24-hour curve
 * comes from hourly trend rows while the newest reading arrives minutes ago, so
 * evenly-spaced indices would draw the last minute as a whole hour. Series
 * without usable timestamps fall back to even spacing.
 *
 * A flat series is centred vertically instead of sitting on the floor: an idle
 * server at a constant 4% should draw a flat line in the middle of its strip,
 * which reads as "steady", not "zero".
 *
 * `floor`/`ceiling` pin the value axis so that CPU at 3% does not fill the
 * tile with an alarming-looking curve.
 *
 * @param {Array<{t?:number, v:number}>} points
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
    const first = points[0];
    const last = points[points.length - 1];
    const timeSpan = Number.isFinite(first?.t) && Number.isFinite(last?.t) ? last.t - first.t : 0;

    const mapped = points.map((point, index) => {
        const ratio = (point.v - min) / span;
        const clamped = Math.min(1, Math.max(0, ratio));
        const along =
            timeSpan > 0 && Number.isFinite(point.t)
                ? Math.min(1, Math.max(0, (point.t - first.t) / timeSpan))
                : points.length > 1
                  ? index / (points.length - 1)
                  : 0;
        return {
            x: paddingX + drawWidth * along,
            y: paddingY + (1 - clamped) * drawHeight,
        };
    });

    return { points: mapped, min, max, baselineY, width, height, step };
}

/**
 * Index of the drawn sample closest to a pointer position.
 *
 * Used by the hover readout: the curve is smoothed, so the honest answer to
 * "what am I pointing at" is the nearest real sample, never an interpolated
 * value the server never reported.
 *
 * @param {Array<{x:number}>} points mapped points, sorted by x
 * @param {number} x pointer position in the same coordinate space
 * @returns {number} -1 when there is nothing to hit
 */
export function nearestPointIndex(points, x) {
    if (!Array.isArray(points) || points.length === 0) return -1;
    if (!Number.isFinite(x)) return points.length - 1;

    let low = 0;
    let high = points.length - 1;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (points[middle].x < x) low = middle + 1;
        else high = middle;
    }

    const after = points[low];
    const before = points[low - 1];
    if (!before) return low;
    return Math.abs(before.x - x) <= Math.abs(after.x - x) ? low - 1 : low;
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
 * Percentages are scaled from zero to the highest reading in the window, so the
 * curve's top edge *is* the period peak: a day that touched 87 % fills the
 * strip at 87 %, whatever the current value happens to be. A genuinely flat
 * series has no peak to scale to, so it keeps a centred band rather than
 * drawing a line pinned to the top edge.
 *
 * Rates, counts and load are fitted to their own window, with a minimum span so
 * rounding noise stays a flat line, and rates keep a zero floor because zero
 * traffic is itself the signal.
 *
 * @param {string} kind metric VALUE_KIND
 * @param {Array<{v:number}>} points
 * @returns {{floor: number|null, ceiling: number|null}}
 */
export function axisForKind(kind, points) {
    if (kind === 'percent') return percentAxis(points);
    if (kind === 'count') return fittedAxis(points, { minSpan: 4, lower: 0 });
    if (kind === 'load') return fittedAxis(points, { minSpan: 1, lower: 0 });
    if (kind === 'duration') return { floor: 0, ceiling: null };
    const stats = computeStats(points);
    const ceiling = stats ? Math.max(1, stats.max * 1.15) : null;
    return { floor: 0, ceiling };
}

/**
 * 0 → window peak for utilization percentages.
 *
 * @param {Array<{v:number}>} points
 * @returns {{floor: number, ceiling: number}}
 */
function percentAxis(points) {
    const stats = computeStats(points);
    if (!stats) return { floor: 0, ceiling: 100 };
    if (stats.max === stats.min) {
        return fittedAxis(points, { minSpan: 20, lower: 0, upper: 100 });
    }
    return { floor: 0, ceiling: Math.max(stats.max, 1) };
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
