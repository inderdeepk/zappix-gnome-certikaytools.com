// statusDot.js — the small severity dot used in card headers and host rows.
//
// One widget for every place a dot appears in the dropdown (popup header, card
// header, host row) so the colour language is literally the same object.
// The panel draws its own mark — see `panelGauge.js`. The pulse used while
// connecting honours the reduce-motion preference.
//
// Shell-side module (St/Clutter).

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { severityClass } from '../../model/severity.js';

/** Repeating opacity animation used for the "connecting" state. */
const PULSE_MS = 1400;
const PULSE_MIN_OPACITY = 90;

export const StatusDot = GObject.registerClass(
    {
        GTypeName: 'ZappixStatusDot',
    },
    class StatusDot extends St.Widget {
        constructor(params = {}) {
            super({
                style_class: 'zappix-dot',
                y_align: Clutter.ActorAlign.CENTER,
                ...params,
            });

            this._severity = '';
            this._pulse = null;
            this._reduceMotion = false;

            this.setSeverity('ok');
        }

        /**
         * @param {string} severity one of the SEVERITY values
         */
        setSeverity(severity) {
            if (severity === this._severity) return;
            if (this._severity) this.remove_style_class_name(severityClass(this._severity));
            this._severity = severity;
            this.add_style_class_name(severityClass(severity));
        }

        /**
         * Enable or disable the connecting pulse.
         *
         * @param {boolean} pulsing
         * @param {boolean} [reduceMotion=false]
         */
        setPulsing(pulsing, reduceMotion = false) {
            this._reduceMotion = reduceMotion;

            if (!pulsing || reduceMotion) {
                this._stopPulse();
                return;
            }

            if (this._pulse) return;

            // The shell's `ease()` returns nothing, so the flag is ours: storing
            // its result left `_pulse` undefined and the pulse impossible to stop.
            this._pulse = true;
            this.ease({
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
            // Removing the transition also releases the shell's begin_work /
            // unredirect hold that an endless ease keeps alive.
            this.remove_transition('opacity');
            this.opacity = 255;
        }

        /**
         * @param {string} text tooltip text
         */
        setTooltip(text) {
            this.tooltip_text = text || null;
        }
    },
);
