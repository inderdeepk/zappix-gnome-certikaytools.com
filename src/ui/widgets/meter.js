// meter.js — the thin utilization bar under a percentage tile.
//
// Cairo rather than two nested St widgets because the bar needs rounded caps
// and a soft gradient; building that out of St boxes would cost four actors per
// tile and still look boxy. The actor is only 4px tall, so the surface cost is
// negligible and it never hits the large-surface offscreen path that Clutter
// struggles with.
//
// Shell-side module (St + cairo).

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { severityColour } from '../../shared/appearance.js';

/** Track height in CSS pixels; mirrored in the stylesheet's min-height. */
const TRACK_HEIGHT = 4;

export const Meter = GObject.registerClass(
    {
        GTypeName: 'ZappixMeter',
    },
    class Meter extends St.DrawingArea {
        constructor(params = {}) {
            super({
                style_class: 'zappix-meter',
                y_align: Clutter.ActorAlign.END,
                ...params,
            });

            this._fraction = 0;
            this._severity = 'ok';

            this._repaintId = this.connect('repaint', this._onRepaint.bind(this));
        }

        /**
         * @param {number} value utilization percentage (0..100)
         * @param {string} severity one of the SEVERITY values
         */
        setValue(value, severity) {
            const numeric = Number(value);
            const next = Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric / 100)) : 0;

            if (next === this._fraction && severity === this._severity) return;

            this._fraction = next;
            this._severity = severity;
            // `repaint()` was removed from St years ago; the method is
            // `queue_repaint()`. Calling the old name threw on every update.
            this.queue_repaint();
        }

        /**
         * @param {cairo.Context} cr
         */
        _paint(cr) {
            const [width, height] = this.get_surface_size();
            if (width <= 0 || height <= 0) return;

            const radius = height / 2;

            // Track.
            roundedRect(cr, 0, 0, width, height, radius);
            cr.setSourceRGBA(1, 1, 1, 0.1);
            cr.fill();

            if (this._fraction <= 0) return;

            // Fill. A minimum visible width keeps a 0.4% reading from looking
            // like a hard zero.
            const fillWidth = Math.max(height, width * this._fraction);
            const colour = severityColour(this._severity, 0.95);
            roundedRect(cr, 0, 0, Math.min(width, fillWidth), height, radius);
            cr.setSourceRGBA(colour.r, colour.g, colour.b, colour.a);
            cr.fill();
        }

        /**
         * @param {cairo.Context} cr
         */
        _onRepaint() {
            const cr = this.get_context();
            if (!cr) return;
            try {
                this._paint(cr);
            } finally {
                cr.$dispose();
            }
        }
    },
);

/**
 * Rounded rectangle path, clamped so the radius never collapses the shape.
 *
 * @param {cairo.Context} cr
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 */
function roundedRect(cr, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
    cr.newSubPath();
    cr.moveTo(x + r, y);
    cr.lineTo(x + width - r, y);
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.lineTo(x + width, y + height - r);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.lineTo(x + r, y + height);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.lineTo(x, y + r);
    cr.arc(x + r, y + r, r, Math.PI, (Math.PI * 3) / 2);
    cr.closePath();
}

export { TRACK_HEIGHT };
