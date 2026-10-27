// panelGauge.js — the whole panel indicator as one mark: a ring gauge with the
// Zappix pulse at its centre, and the value beside it.
//
// It replaces three loose actors (status dot, monitor icon, bold value) with a
// single 16px glyph that carries all of their meaning:
//
//   • the arc is the panel metric's level, coloured by its severity;
//   • the pulse inside is the brand mark — it flatlines while the server is
//     unreachable, and the arc and value dim to show they are last-good data;
//   • a dot notched into the rim flags unacknowledged problems, so an alert
//     never has to repaint an unrelated number red.
//
// The value inherits the panel's own font and weight, like the clock and the
// battery percentage, and is only tinted when the metric is alarming: calm is
// quiet, trouble is loud.
//
// Cairo for the same reason as the sparkline: arcs with round caps and a
// knock-out are one paint pass here and half a dozen actors in St.
//
// Shell-side module (St + cairo).

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import cairo from 'gi://cairo';

import { SEVERITY, isAlarming } from '../../model/severity.js';
import { isDarkForeground, panelSeverityColour } from '../../shared/appearance.js';

/** Proportions of the 16px design, so the mark scales with the widget. */
const RING_WIDTH = 0.12;
const RING_INSET = 0.022;
const TRACK_ALPHA = 0.28;
const PULSE_WIDTH = 0.46;
const PULSE_HEIGHT = 0.29;
const PULSE_STROKE = 0.08;
/** The pulse's flat runs sit a hair low, the flatline's ends a hair in. */
const PULSE_BASELINE = 0.025;
const BADGE_RADIUS = 0.16;
const BADGE_GAP = 0.1;

/** Shortest arc drawn for a non-zero value, so 2 % is not mistaken for 0 %. */
const MIN_VISIBLE_FRACTION = 0.05;

/** Opacity of last-good data while the server is unreachable. */
const OFFLINE_OPACITY = 150;

/** Connecting pulse: same rhythm as the card dots. */
const PULSE_MS = 1400;
const PULSE_MIN_OPACITY = 90;

export const PanelGauge = GObject.registerClass(
    {
        GTypeName: 'ZappixPanelGauge',
    },
    class PanelGauge extends St.BoxLayout {
        constructor(params = {}) {
            super({
                style_class: 'zappix-panel-box',
                y_align: Clutter.ActorAlign.CENTER,
                ...params,
            });

            this._state = {
                fraction: null,
                severity: SEVERITY.UNKNOWN,
                badge: null,
                offline: false,
                text: '',
            };
            this._pulse = null;

            this._ring = new St.DrawingArea({
                style_class: 'zappix-panel-gauge',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._ring.connect('repaint', () => this._onRepaint());
            // The panel's text colour is the track colour and decides which
            // severity palette is legible; both change with the shell theme.
            this._ring.connect('style-changed', () => {
                this._ring.queue_repaint();
                this._applyLabelColour();
            });
            this.add_child(this._ring);

            this._label = new St.Label({
                style_class: 'zappix-panel-value',
                y_align: Clutter.ActorAlign.CENTER,
                visible: false,
            });
            this.add_child(this._label);
        }

        /**
         * @param {object} state
         * @param {number|null} state.fraction arc fill 0..1; null for an empty track
         * @param {string} state.severity colour of the arc and of an alarming value
         * @param {string|null} [state.badge] problem severity to notch into the rim
         * @param {boolean} [state.offline] flatline, and dim the last-good data
         * @param {string} [state.text] value beside the ring; empty hides it
         */
        setState({ fraction, severity, badge = null, offline = false, text = '' }) {
            const next = { fraction, severity, badge, offline, text };
            const previous = this._state;
            this._state = next;

            if (
                previous.fraction !== next.fraction ||
                previous.severity !== next.severity ||
                previous.badge !== next.badge ||
                previous.offline !== next.offline
            ) {
                this._ring.queue_repaint();
            }

            this._label.text = text;
            this._label.visible = text !== '';
            this._label.opacity = offline ? OFFLINE_OPACITY : 255;
            this._applyLabelColour();
        }

        /**
         * Breathe the ring while the first poll is in flight.
         *
         * @param {boolean} pulsing
         * @param {boolean} [reduceMotion=false]
         */
        setPulsing(pulsing, reduceMotion = false) {
            if (!pulsing || reduceMotion) {
                this._stopPulse();
                return;
            }
            if (this._pulse) return;

            this._pulse = true;
            this._ring.ease({
                opacity: PULSE_MIN_OPACITY,
                duration: PULSE_MS / 2,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                autoReverse: true,
                repeatCount: -1,
            });
        }

        _stopPulse() {
            if (!this._pulse) return;
            this._pulse = null;
            this._ring.remove_transition('opacity');
            this._ring.opacity = 255;
        }

        /** @returns {boolean} */
        _onLightPanel() {
            const node = this._ring.peek_theme_node();
            return node ? isDarkForeground(node.get_foreground_color()) : false;
        }

        /** @returns {{r:number, g:number, b:number}} */
        _foreground() {
            const node = this._ring.peek_theme_node();
            if (!node) return { r: 1, g: 1, b: 1 };
            const colour = node.get_foreground_color();
            return { r: colour.red / 255, g: colour.green / 255, b: colour.blue / 255 };
        }

        _applyLabelColour() {
            const { severity, offline } = this._state;
            const alarming = !offline && isAlarming(severity);
            const css = alarming ? panelSeverityColour(severity, this._onLightPanel()).css : '';
            this._label.set_style(css ? `color: ${css};` : null);
        }

        _onRepaint() {
            const cr = this._ring.get_context();
            if (!cr) return;
            try {
                this._paint(cr);
            } finally {
                cr.$dispose();
            }
        }

        /**
         * @param {cairo.Context} cr
         */
        _paint(cr) {
            const [width, height] = this._ring.get_surface_size();
            const size = Math.min(width, height);
            if (size <= 0) return;

            const { fraction, severity, badge, offline } = this._state;
            const fg = this._foreground();
            const onLight = this._onLightPanel();
            const centre = size / 2;
            const ringWidth = size * RING_WIDTH;
            const radius = centre - ringWidth / 2 - size * RING_INSET;

            cr.save();
            cr.translate((width - size) / 2, (height - size) / 2);
            cr.setLineCap(cairo.LineCap.ROUND);
            cr.setLineJoin(cairo.LineJoin.ROUND);

            // Track.
            cr.setLineWidth(ringWidth);
            cr.setSourceRGBA(fg.r, fg.g, fg.b, TRACK_ALPHA);
            cr.newPath();
            cr.arc(centre, centre, radius, 0, Math.PI * 2);
            cr.stroke();

            // Level, clockwise from twelve o'clock.
            if (fraction !== null && fraction > 0) {
                const fill = Math.min(1, Math.max(MIN_VISIBLE_FRACTION, fraction));
                const colour = panelSeverityColour(severity, onLight);
                cr.setSourceRGBA(colour.r, colour.g, colour.b, offline ? 0.5 : 1);
                cr.newPath();
                if (fill >= 1) {
                    cr.arc(centre, centre, radius, 0, Math.PI * 2);
                } else {
                    const start = -Math.PI / 2;
                    cr.arc(centre, centre, radius, start, start + fill * Math.PI * 2);
                }
                cr.stroke();
            }

            // Pulse, or a flatline when the server cannot be reached.
            const glyphWidth = size * PULSE_WIDTH;
            const left = centre - glyphWidth / 2;
            const nudge = size * PULSE_BASELINE;
            cr.setLineWidth(size * PULSE_STROKE);
            cr.setSourceRGBA(fg.r, fg.g, fg.b, offline ? 0.6 : 0.95);
            cr.newPath();
            if (offline) {
                cr.moveTo(left + nudge, centre);
                cr.lineTo(left + glyphWidth - nudge, centre);
            } else {
                const amplitude = (size * PULSE_HEIGHT) / 2;
                const baseline = centre + nudge;
                cr.moveTo(left, baseline);
                cr.lineTo(left + glyphWidth * 0.26, baseline);
                cr.lineTo(left + glyphWidth * 0.42, centre - amplitude);
                cr.lineTo(left + glyphWidth * 0.6, centre + amplitude);
                cr.lineTo(left + glyphWidth * 0.74, baseline);
                cr.lineTo(left + glyphWidth, baseline);
            }
            cr.stroke();

            // Problem badge, cut into the rim so it reads on any panel colour.
            if (badge) {
                const badgeRadius = size * BADGE_RADIUS;
                const bx = size - badgeRadius;
                const by = badgeRadius;
                cr.save();
                cr.setOperator(cairo.Operator.CLEAR);
                cr.newPath();
                cr.arc(bx, by, badgeRadius + size * BADGE_GAP, 0, Math.PI * 2);
                cr.fill();
                cr.restore();

                const colour = panelSeverityColour(badge, onLight);
                cr.setSourceRGBA(colour.r, colour.g, colour.b, 1);
                cr.newPath();
                cr.arc(bx, by, badgeRadius, 0, Math.PI * 2);
                cr.fill();
            }

            cr.restore();
        }

        destroy() {
            this._stopPulse();
            super.destroy();
        }
    },
);
