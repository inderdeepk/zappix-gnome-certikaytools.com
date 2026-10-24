// sparkline.js — the trend curve behind each metric tile.
//
// A Cairo-drawn `St.DrawingArea` rather than a series of boxes: a 40-point curve
// as St actors would mean 40 layout passes per redraw, and the shell's layout
// loop is the one thing an extension must not waste.
//
// Everything drawn here comes from `model/series.js`, which is unit-tested; this
// file only translates coordinates into Cairo calls. That split is why the
// curve can be verified without a compositor.
//
// Shell-side module (St + cairo), excluded from the import smoke test.

import GObject from 'gi://GObject';
import St from 'gi://St';
import cairo from 'gi://cairo';

import { buildBezierSegments, buildSparklineGeometry } from '../../model/series.js';

/** Vertical breathing room so a peak never touches the tile border. */
const PADDING_Y = 3;

export const Sparkline = GObject.registerClass(
    {
        GTypeName: 'ZappixSparkline',
    },
    class Sparkline extends St.DrawingArea {
        constructor(params = {}) {
            super({
                style_class: 'zappix-sparkline',
                x_expand: true,
                ...params,
            });

            /** @type {Array<{v:number}>} */
            this._points = [];
            this._floor = null;
            this._ceiling = null;

            this._stroke = { r: 1, g: 1, b: 1, a: 1 };
            this._fillTop = { r: 1, g: 1, b: 1, a: 0.3 };
            this._fillBottom = { r: 1, g: 1, b: 1, a: 0 };

            this._repaintId = this.connect('repaint', this._onRepaint.bind(this));
        }

        /**
         * Replace the drawn series.
         *
         * @param {Array<{t:number, v:number}>} points
         * @param {object} [options]
         * @param {number|null} [options.floor] pinned value-axis minimum
         * @param {number|null} [options.ceiling] pinned value-axis maximum
         */
        setSeries(points, { floor = null, ceiling = null } = {}) {
            this._points = Array.isArray(points) ? points : [];
            this._floor = floor;
            this._ceiling = ceiling;
            this.queue_repaint();
        }

        /**
         * Set the curve colours.
         *
         * @param {object} palette
         * @param {{r:number,g:number,b:number,a:number}} palette.stroke
         * @param {{r:number,g:number,b:number,a:number}} palette.fillTop
         * @param {{r:number,g:number,b:number,a:number}} palette.fillBottom
         */
        setPalette({ stroke, fillTop, fillBottom }) {
            if (stroke) this._stroke = stroke;
            if (fillTop) this._fillTop = fillTop;
            if (fillBottom) this._fillBottom = fillBottom;
            this.queue_repaint();
        }

        /**
         * Force a redraw (used when the theme or accent changes).
         *
         * This is `St.Widget.queue_repaint()` itself. Redefining it here and
         * calling the long-removed `repaint()` inside was a guaranteed
         * TypeError on every poll: the whole card failed to render and the
         * error surfaced as "poll failed".
         */

        /**
         * Cairo paint callback.
         */
        _onRepaint() {
            const cr = this.get_context();
            if (!cr) return;

            try {
                this._paint(cr);
            } finally {
                // Not calling this leaks the context for the lifetime of the
                // Shell — the single most common extension memory leak.
                cr.$dispose();
            }
        }

        /**
         * @param {cairo.Context} cr
         */
        _paint(cr) {
            const [width, height] = this.get_surface_size();
            if (width <= 0 || height <= 0) return;

            const hasData = this._points.length > 0;

            if (!hasData) {
                this._paintEmptyState(cr, width, height);
                return;
            }

            const geometry = buildSparklineGeometry(this._points, {
                width,
                height,
                paddingX: 1,
                paddingY: PADDING_Y,
                floor: this._floor,
                ceiling: this._ceiling,
            });

            const points = geometry.points;
            if (points.length === 0) return;

            const segments = buildBezierSegments(points);

            if (points.length === 1) {
                // A single sample has no curve; a dot still communicates "one
                // reading arrived", which is different from "no data".
                cr.setSourceRGBA(this._stroke.r, this._stroke.g, this._stroke.b, this._stroke.a);
                cr.arc(points[0].x, points[0].y, 1.6, 0, Math.PI * 2);
                cr.fill();
                return;
            }

            // Area fill: the curve, dropped to the baseline and closed.
            cr.moveTo(points[0].x, geometry.baselineY);
            cr.lineTo(points[0].x, points[0].y);
            for (const segment of segments) {
                cr.curveTo(segment.x1, segment.y1, segment.x2, segment.y2, segment.x3, segment.y3);
            }
            cr.lineTo(points[points.length - 1].x, geometry.baselineY);
            cr.closePath();
            cr.setSource(gradientFor(cr, height, this._fillTop, this._fillBottom));
            cr.fill();

            // Stroke on top, so the fill never eats the line's antialiasing.
            cr.moveTo(points[0].x, points[0].y);
            for (const segment of segments) {
                cr.curveTo(segment.x1, segment.y1, segment.x2, segment.y2, segment.x3, segment.y3);
            }
            cr.setLineWidth(1.5);
            cr.setLineCap(cairo.LineCap.ROUND);
            cr.setLineJoin(cairo.LineJoin.ROUND);
            cr.setSourceRGBA(this._stroke.r, this._stroke.g, this._stroke.b, this._stroke.a);
            cr.stroke();
        }

        /**
         * Placeholder while there is no history: a dotted baseline reads as
         * "measuring", where an empty box reads as a bug.
         *
         * @param {cairo.Context} cr
         * @param {number} width
         * @param {number} height
         */
        _paintEmptyState(cr, width, height) {
            const y = height - PADDING_Y;
            cr.setLineWidth(1);
            cr.setDash([2, 4], 0);
            cr.setSourceRGBA(this._stroke.r, this._stroke.g, this._stroke.b, 0.22);
            cr.moveTo(1, y);
            cr.lineTo(width - 1, y);
            cr.stroke();
        }
    },
);

/**
 * Vertical two-stop gradient, with a solid fallback.
 *
 * Gradient construction is the one Cairo API that has moved between GJS
 * versions; a flat translucent fill looks intentional if it ever fails.
 *
 * @param {cairo.Context} cr
 * @param {number} height
 * @param {{r:number,g:number,b:number,a:number}} top
 * @param {{r:number,g:number,b:number,a:number}} bottom
 * @returns {cairo.Pattern}
 */
function gradientFor(cr, height, top, bottom) {
    try {
        const gradient = new cairo.LinearGradient(0, 0, 0, height);
        gradient.addColorStopRGBA(0, top.r, top.g, top.b, top.a);
        gradient.addColorStopRGBA(1, bottom.r, bottom.g, bottom.b, bottom.a);
        return gradient;
    } catch {
        return new cairo.SolidPattern(top.r, top.g, top.b, top.a * 0.5);
    }
}
