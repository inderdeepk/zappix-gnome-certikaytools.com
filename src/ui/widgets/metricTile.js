// metricTile.js — one utilization tile (CPU, Memory, Disk, …).
//
// Layout, top to bottom:
//
//   ┌─────────────────────────────┐
//   │ CPU                    ▲    │  label + trend caret
//   │ 42%                         │  headline, severity-coloured
//   │ 5/7.5 GB · /hostfs          │  second line: absolute context
//   │ ▁▂▃▅▇▆▅▃▂▁▂▃               │  trend curve (24 h, hovering reads out a sample)
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
import { severityColour } from '../../shared/appearance.js';
import { axisForKind, trendDirection } from '../../model/series.js';
import { formatClockTime, formatMetricValue, splitValueUnit } from '../../shared/format.js';
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

            // "5/7.5 GB" or "↓ 2.1 · ↑ 0.4 Mb/s" — the absolute context behind
            // the headline. Hidden for metrics whose supporting items the host
            // does not publish, so the tile keeps its compact height.
            this._detail = new St.Label({
                style_class: 'zappix-tile-detail',
                text: '',
                visible: false,
                x_align: Clutter.ActorAlign.START,
            });
            this.add_child(this._detail);

            // A period total that does not belong on the same line as the
            // live split (`1.4 TB this month` under `↓ 2.1 · ↑ 0.4 Mb/s`).
            this._detailSecondary = new St.Label({
                style_class: 'zappix-tile-detail zappix-tile-detail-secondary',
                text: '',
                visible: false,
                x_align: Clutter.ActorAlign.START,
            });
            this.add_child(this._detailSecondary);

            this._sparklineHeight = sparklineHeight ?? 32;
            // Expands into whatever height the row has left, so every tile in
            // a row ends on the same line.
            this._chart = new St.Widget({
                style_class: 'zappix-tile-chart',
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                y_expand: true,
            });
            this.add_child(this._chart);

            this._sparkline = new Sparkline({
                height: this._sparklineHeight,
                x_expand: true,
                y_expand: true,
            });
            this._chart.add_child(this._sparkline);

            // The hover readout floats above the curve: positioned with
            // translations because it is a normal St actor, not part of the
            // Cairo surface.
            this._readout = new St.Label({
                style_class: 'zappix-tile-readout',
                text: '',
                visible: false,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.START,
            });
            this._chart.add_child(this._readout);
            this._sparkline.setHoverHandler((sample) => this._showReadout(sample));

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

            const detailSecondary =
                typeof metricView.detailSecondary === 'string' ? metricView.detailSecondary : '';
            this._detailSecondary.text = detailSecondary;
            this._detailSecondary.visible = detailSecondary !== '';

            if (height && height !== this._sparklineHeight) {
                this._sparklineHeight = height;
                this._sparkline.set_height(height);
            }

            const series = Array.isArray(metricView.series) ? metricView.series : [];
            const axis = axisForKind(kind, series);

            this._sparkline.setPalette({
                stroke: severityColour(metricView.severity, 0.95),
                // The axis is 0-based, so a high-utilization metric fills almost
                // the whole strip; a light veil keeps that from reading as the
                // utilization bar this tile no longer has.
                fillTop: severityColour(metricView.severity, 0.2),
                fillBottom: severityColour(metricView.severity, 0.0),
            });
            this._sparkline.setSeries(series, axis);

            this._updateTrend(series, kind);
            this.tooltip_text = this._buildTooltip(metricView);
        }

        /**
         * `15:30 · 66%` floating over the curve while the pointer is on it.
         *
         * `sample` is the real reading nearest the pointer, in the tile's
         * logical coordinates; `null` means the pointer left.
         *
         * @param {{t:number, v:number, x:number, y:number}|null} sample
         */
        _showReadout(sample) {
            if (!sample) {
                this._readout.visible = false;
                return;
            }

            const time = formatClockTime(sample.t);
            const value = formatMetricValue(this._kind, sample.v);
            this._readout.text = `${time} · ${value}`;
            this._readout.visible = true;
            this._positionReadout(sample.x, sample.y);
        }

        /**
         * Keep the readout inside the chart: centred over the sample, flipped
         * below it when there is no room above.
         *
         * @param {number} x logical x of the sample
         * @param {number} y logical y of the sample
         */
        _positionReadout(x, y) {
            const [minWidth, naturalWidth] = this._readout.get_preferred_width(-1);
            const [, naturalHeight] = this._readout.get_preferred_height(naturalWidth);

            const width = Math.max(minWidth, naturalWidth);
            const chartWidth = this._chart.get_width();
            const chartHeight = this._chart.get_height();
            const margin = 1;

            const maxLeft = Math.max(margin, chartWidth - width - margin);
            const left = Math.min(Math.max(margin, x - width / 2), maxLeft);

            const above = y - naturalHeight - 5;
            const below = y + 5;
            const top =
                above >= margin
                    ? above
                    : Math.min(Math.max(margin, chartHeight - naturalHeight - margin), below);

            this._readout.translation_x = Math.round(left);
            this._readout.translation_y = Math.round(Math.max(margin, top));
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
