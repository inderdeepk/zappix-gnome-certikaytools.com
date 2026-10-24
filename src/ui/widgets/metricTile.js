// metricTile.js — one utilization tile (CPU, Memory, Disk, …).
//
// Layout, top to bottom:
//
//   ┌─────────────────────────────┐
//   │ CPU                    ▲    │  label + trend caret
//   │ 42%                         │  headline, severity-coloured
//   │ ▁▂▃▅▇▆▅▃▂▁▂▃               │  sparkline
//   │ ▬▬▬▬▬▬▬▬▬▬░░░░░░░░          │  meter (percent metrics only)
//   └─────────────────────────────┘
//
// The tile owns no data: `update(metricView)` is the entire contract, which is
// what lets the dashboard re-render on every poll without rebuilding widgets
// (and therefore without losing hover/focus state).
//
// Shell-side module (St/Clutter).

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { Sparkline } from './sparkline.js';
import { Meter } from './meter.js';
import { severityColour } from '../../shared/appearance.js';
import { axisForKind, trendDirection } from '../../model/series.js';
import { formatMetricValue, splitValueUnit } from '../../shared/format.js';
import { VALUE_KIND } from '../../model/metricCatalog.js';
import { gettext as _ } from '../../shared/i18n.js';

/** Trend caret glyphs; kept as text so no icon files are needed. */
const TREND_GLYPHS = Object.freeze({
    up: '▲',
    down: '▼',
    flat: '·',
});

export const MetricTile = GObject.registerClass(
    {
        GTypeName: 'ZappixMetricTile',
    },
    class MetricTile extends St.BoxLayout {
        /**
         * @param {object} params
         * @param {number} [params.sparklineHeight]
         * @param {number} [params.minWidth]
         */
        constructor(params = {}) {
            const { sparklineHeight, ...stParams } = params;

            super({
                style_class: 'zappix-tile',
                vertical: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                ...stParams,
            });

            const head = new St.BoxLayout({
                style_class: 'zappix-tile-head',
                vertical: false,
                x_expand: true,
            });
            this.add_child(head);

            this._label = new St.Label({
                style_class: 'zappix-tile-label',
                text: '',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            head.add_child(this._label);

            this._trend = new St.Label({
                style_class: 'zappix-tile-trend',
                text: '',
                y_align: Clutter.ActorAlign.CENTER,
                visible: false,
            });
            head.add_child(this._trend);

            this._value = new St.Label({
                style_class: 'zappix-tile-value',
                text: '—',
                x_align: Clutter.ActorAlign.START,
            });
            this.add_child(this._value);

            // "5.0 GB of 7.8 GB" — the absolute figure behind a percentage.
            // Hidden for metrics that have no meaningful total (network,
            // containers) so the tile keeps its compact height.
            this._detail = new St.Label({
                style_class: 'zappix-tile-detail',
                text: '',
                visible: false,
                x_align: Clutter.ActorAlign.START,
            });
            this.add_child(this._detail);

            this._sparklineHeight = sparklineHeight ?? 32;
            // Expands into the meter's slot on tiles without one, so every tile
            // in a row ends on the same line.
            this._sparkline = new Sparkline({
                height: this._sparklineHeight,
                y_expand: true,
            });
            this.add_child(this._sparkline);

            this._meter = new Meter({ visible: false });
            this.add_child(this._meter);

            this._severity = '';
            this._valueText = '—';
            this._kind = VALUE_KIND.PERCENT;
            this._reduceMotion = false;
        }

        /**
         * Render a metric view model.
         *
         * @param {object} metricView result of `resolveMetric`
         * @param {object} [options]
         * @param {boolean} [options.reduceMotion=false]
         * @param {number|null} [options.height] sparkline height override
         */
        update(metricView, { reduceMotion = false, height = null } = {}) {
            const kind = metricView.kind ?? VALUE_KIND.PERCENT;
            this._kind = kind;
            this._reduceMotion = reduceMotion;

            this._label.text = _(metricView.label);

            const hasValue = metricView.available && metricView.value !== null;
            this._setValueText(hasValue ? formatMetricValue(kind, metricView.value) : '—');
            this._applySeverity(metricView.severity, hasValue);

            const detail =
                hasValue && typeof metricView.detail === 'string' ? metricView.detail : '';
            this._detail.text = detail;
            this._detail.visible = detail !== '';

            if (height && height !== this._sparklineHeight) {
                this._sparklineHeight = height;
                this._sparkline.set_height(height);
            }

            const series = Array.isArray(metricView.series) ? metricView.series : [];
            const axis = axisForKind(kind, series);

            this._sparkline.setPalette({
                stroke: severityColour(metricView.severity, 0.95),
                fillTop: severityColour(metricView.severity, 0.34),
                fillBottom: severityColour(metricView.severity, 0.02),
            });
            this._sparkline.setSeries(series, axis);

            const isPercent = kind === VALUE_KIND.PERCENT;
            this._meter.visible = isPercent && hasValue;
            if (this._meter.visible) {
                this._meter.setValue(metricView.value, metricView.severity);
            }

            this._updateTrend(series, kind);
            this.tooltip_text = this._buildTooltip(metricView);
        }

        /**
         * Headline with the unit set smaller and quieter than the number, so
         * `46.9 kb/s` reads as a figure first.
         *
         * @param {string} text
         */
        _setValueText(text) {
            this._valueText = text;
            const { number, unit } = splitValueUnit(text);
            const escape = (part) => GLib.markup_escape_text(part, -1);
            this._value.clutter_text.set_markup(
                unit
                    ? `${escape(number)}<span size="smaller" alpha="62%">${escape(unit)}</span>`
                    : escape(number),
            );
        }

        /**
         * Healthy values stay neutral, as on the panel: colour is reserved for
         * amber and red, so it only ever means "look here".
         *
         * @param {string} severity
         * @param {boolean} hasValue
         */
        _applySeverity(severity, hasValue) {
            if (this._severity) {
                this._value.remove_style_class_name(`zappix-text-${this._severity}`);
            }
            const next = hasValue ? severity : 'unknown';
            this._severity = next === 'ok' ? '' : next;
            if (this._severity) {
                this._value.add_style_class_name(`zappix-text-${this._severity}`);
            }
        }

        /**
         * @param {Array<{v:number}>} series
         * @param {string} kind
         */
        _updateTrend(series, kind) {
            // A trend caret on a rate would double-count the sparkline's own
            // message, and on a duration "up" is meaningless.
            const meaningful = kind === VALUE_KIND.PERCENT || kind === VALUE_KIND.LOAD;
            if (!meaningful || this._reduceMotion || series.length < 4) {
                this._trend.visible = false;
                return;
            }

            const direction = trendDirection(series);
            this._trend.visible = direction !== 'flat';
            this._trend.text = TREND_GLYPHS[direction];
        }

        /**
         * Spoken/tooltip description. Includes the source item key so an
         * operator can jump straight to the right item in the Zabbix frontend.
         *
         * @param {object} metricView
         * @returns {string}
         */
        _buildTooltip(metricView) {
            const parts = [`${metricView.label}: ${this._valueText}`];

            if (metricView.sourceItemName) {
                parts.push(metricView.sourceItemName);
            }
            if (metricView.sourceItemKey) {
                parts.push(metricView.sourceItemKey);
            }
            if (!metricView.available) {
                parts.push(_('No data for this item'));
            }

            return parts.join('\n');
        }
    },
);
