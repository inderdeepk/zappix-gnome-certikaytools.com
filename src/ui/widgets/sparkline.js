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
// Hovering reports the sample nearest the pointer through a callback; the tile
// owns the readout text, because only it knows the metric's kind and unit.
//
// Shell-side module (St + cairo), excluded from the import smoke test.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import cairo from 'gi://cairo';

import {
    buildBezierSegments,
    buildSparklineGeometry,
    nearestPointIndex,
} from '../../model/series.js';

/** Vertical breathing room so a peak never touches the tile border. */
const PADDING_Y = 3;

/** Radius of the latest-sample marker; also the horizontal inset it needs. */
const HEAD_RADIUS = 2.25;

/** Radius of the marker that follows the pointer. */
const HOVER_RADIUS = 3;

export const Sparkline = GObject.registerClass(
    {
        GTypeName: 'ZappixSparkline',
    },
    class Sparkline extends St.DrawingArea {
        constructor(params = {}) {
            super({
                style_class: 'zappix-sparkline',
                x_expand: true,
                reactive: true,
                track_hover: true,
                ...params,
            });

            /** @type {Array<{t:number, v:number}>} */
            this._points = [];
            this._floor = null;
            this._ceiling = null;

            /** Mapped points from the last paint, with their source sample. */
            this._mapped = [];
            /**
             * Surface size of the last paint, in device pixels.
             *
             * `St.DrawingArea.get_surface_size()` asserts unless it is called
             * from inside the repaint handler, and hit-testing runs on pointer
             * events, which are not paints. Caching the size here is the only
             * way to map a pointer position without tripping that assertion.
             */
            this._surfaceWidth = 0;
            this._surfaceHeight = 0;
            /** Pointer position inside the actor, or null when not hovering. */
            this._hoverX = null;
            this._hoverIndex = -1;
            /** @type {((sample: {t:number,v:number,x:number,y:number}|null) => void)|null} */
            this._hoverHandler = null;

            this._stroke = { r: 1, g: 1, b: 1, a: 1 };
            this._fillTop = { r: 1, g: 1, b: 1, a: 0.3 };
            this._fillBottom = { r: 1, g: 1, b: 1, a: 0 };

            this._repaintId = this.connect('repaint', this._onRepaint.bind(this));
            this.connect('motion-event', this._onMotion.bind(this));
            this.connect('leave-event', this._onLeave.bind(this));
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

            // A poll replaces the samples under a stationary pointer; re-resolve
            // the readout so it keeps naming the sample at that position.
            this._mapped = [];
            this._refreshHover({ notify: true });
            this.queue_repaint();
        }

        /**
         * Called with the sample nearest the pointer while hovering, and with
         * `null` when the pointer leaves.
         *
         * @param {((sample: {t:number,v:number,x:number,y:number}|null) => void)|null} handler
         */
        setHoverHandler(handler) {
            this._hoverHandler = typeof handler === 'function' ? handler : null;
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

            this._surfaceWidth = width;
            this._surfaceHeight = height;

            const hasData = this._points.length > 0;

            if (!hasData) {
                this._mapped = [];
                this._paintEmptyState(cr, width, height);
                return;
            }

            const geometry = this._layout();
            if (!geometry) return;

            const points = geometry.points;
            if (points.length === 0) return;

            const segments = buildBezierSegments(points);

            if (points.length === 1) {
                // A single sample has no curve; a dot still communicates "one
                // reading arrived", which is different from "no data".
                cr.setSourceRGBA(this._stroke.r, this._stroke.g, this._stroke.b, this._stroke.a);
                cr.arc(points[0].x, points[0].y, 1.6, 0, Math.PI * 2);
                cr.fill();
                this._paintHover(cr, height);
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

            // The newest sample is the number in the headline; marking it ties
            // the curve to the value above it.
            const head = points[points.length - 1];
            cr.arc(head.x, head.y, HEAD_RADIUS, 0, Math.PI * 2);
            cr.fill();

            this._paintHover(cr, height);
        }

        /**
         * Map the series into the current surface and keep the pointer's
         * sample in step with it.
         *
         * @returns {object|null} geometry from `buildSparklineGeometry`
         */
        _layout() {
            const width = this._surfaceWidth;
            const height = this._surfaceHeight;
            if (width <= 0 || height <= 0 || this._points.length === 0) {
                this._mapped = [];
                return null;
            }

            const geometry = buildSparklineGeometry(this._points, {
                width,
                height,
                paddingX: HEAD_RADIUS,
                paddingY: PADDING_Y,
                floor: this._floor,
                ceiling: this._ceiling,
            });

            this._mapped = geometry.points.map((point, index) => ({
                x: point.x,
                y: point.y,
                t: this._points[index].t,
                v: this._points[index].v,
            }));

            if (this._hoverX !== null) {
                this._hoverIndex = nearestPointIndex(this._mapped, this._hoverX);
            }

            return geometry;
        }

        /**
         * Crosshair and marker for the sample under the pointer.
         *
         * @param {cairo.Context} cr
         * @param {number} height
         */
        _paintHover(cr, height) {
            const point = this._mapped[this._hoverIndex];
            if (!point) return;

            cr.setLineWidth(1);
            cr.setDash([2, 3], 0);
            cr.setSourceRGBA(1, 1, 1, 0.3);
            cr.moveTo(point.x, 0);
            cr.lineTo(point.x, height);
            cr.stroke();
            cr.setDash([], 0);

            cr.arc(point.x, point.y, HOVER_RADIUS, 0, Math.PI * 2);
            cr.setSourceRGBA(1, 1, 1, 0.92);
            cr.fill();

            cr.arc(point.x, point.y, HOVER_RADIUS - 1.2, 0, Math.PI * 2);
            cr.setSourceRGBA(this._stroke.r, this._stroke.g, this._stroke.b, 1);
            cr.fill();
        }

        /**
         * @param {St.Widget} actor
         * @param {Clutter.Event} event
         */
        _onMotion(actor, event) {
            const [stageX, stageY] = event.get_coords();
            const transformed = this.transform_stage_point(stageX, stageY);
            // GJS returns `[ok, x, y]`; older bindings omitted the boolean.
            const localX = transformed.length >= 3 ? transformed[1] : transformed[0];
            if (!Number.isFinite(localX)) return Clutter.EVENT_PROPAGATE;

            // The Cairo surface is in device pixels and the actor in logical
            // ones, so a 2× display would halve the pointer position without
            // this correction. The surface size is the one the last paint
            // actually drew into.
            const scale =
                this.width > 0 && this._surfaceWidth > 0 ? this._surfaceWidth / this.width : 1;

            this._hoverX = localX * (Number.isFinite(scale) && scale > 0 ? scale : 1);
            this._refreshHover();
            return Clutter.EVENT_PROPAGATE;
        }

        _onLeave() {
            this._hoverX = null;
            this._setHoverIndex(-1);
            return Clutter.EVENT_PROPAGATE;
        }

        /**
         * Re-resolve the hovered sample from `_hoverX`, notifying on change.
         *
         * @param {object} [options]
         * @param {boolean} [options.notify=false] report even when the index is unchanged
         */
        _refreshHover({ notify = false } = {}) {
            if (this._hoverX === null) return;

            // `_mapped` is only rebuilt on paint; if the surface has not been
            // laid out yet there is nothing to hit.
            if (this._mapped.length === 0) {
                this._layout();
            }

            const index = nearestPointIndex(this._mapped, this._hoverX);
            if (index === this._hoverIndex && !notify) return;

            this._hoverIndex = index;
            this._notifyHover();
            this.queue_repaint();
        }

        /**
         * @param {number} index
         */
        _setHoverIndex(index) {
            if (index === this._hoverIndex && index < 0) return;
            this._hoverIndex = index;
            this._notifyHover();
            this.queue_repaint();
        }

        _notifyHover() {
            if (!this._hoverHandler) return;

            const point = this._mapped[this._hoverIndex] ?? null;
            if (!point) {
                this._hoverHandler(null);
                return;
            }

            // Report logical pixels: the readout is a normal St actor laid out
            // over the drawing, not part of the Cairo surface.
            const scale =
                this.width > 0 && this._surfaceWidth > 0 ? this._surfaceWidth / this.width : 1;
            const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

            this._hoverHandler({
                t: point.t,
                v: point.v,
                x: point.x / safeScale,
                y: point.y / safeScale,
            });
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
