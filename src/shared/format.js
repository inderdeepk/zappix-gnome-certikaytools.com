// format.js — number, duration and time formatting (pure).
//
// Zappix renders values in three very different places — a 20px tile headline,
// a 9px caption, and the panel bar — so every formatter comes in a full and a
// compact variant. Both are pure, which is what lets the tests pin the output
// strings that appear in screenshots and documentation.
//
// Deliberate choice: values are formatted manually rather than through
// `Intl.NumberFormat`. GJS ships Intl, but the dashboard mixes SI (bits/s) and
// IEC (bytes) units in the same card, and a locale-aware formatter would make
// the two disagree on decimal separators.

import { VALUE_KIND } from '../model/metricCatalog.js';

/** Decimal places used for percentage headlines. */
const PERCENT_DECIMALS = 0;

/**
 * Percent value, e.g. `42%`.
 *
 * @param {number|null|undefined} value
 * @param {object} [options]
 * @param {number} [options.decimals=0]
 * @returns {string} an em dash when the value is not a number
 */
export function formatPercent(value, { decimals = PERCENT_DECIMALS } = {}) {
    const numeric = Number(value);
    if (value === null || value === undefined || !Number.isFinite(numeric)) return '—';
    const clamped = Math.min(100, Math.max(0, numeric));
    const text = clamped.toFixed(decimals);
    // Only strip a trailing ".0" — "10.0%" reads as false precision.
    const trimmed = decimals > 0 && text.endsWith('.0') ? text.slice(0, -2) : text;
    return `${trimmed}%`;
}

/**
 * IEC byte sizes, e.g. `1.4 GB`.
 *
 * @param {number|null|undefined} value bytes
 * @param {object} [options]
 * @param {number} [options.decimals=1]
 * @returns {string}
 */
export function formatBytes(value, { decimals = 1 } = {}) {
    const numeric = Number(value);
    if (value === null || value === undefined || !Number.isFinite(numeric)) return '—';

    const negative = numeric < 0;
    let magnitude = Math.abs(numeric);
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let unitIndex = 0;

    while (magnitude >= 1024 && unitIndex < units.length - 1) {
        magnitude /= 1024;
        unitIndex += 1;
    }

    const text =
        magnitude >= 100 || unitIndex === 0
            ? magnitude.toFixed(0)
            : magnitude.toFixed(decimals).replace(/\.0$/, '');

    return `${negative ? '−' : ''}${text} ${units[unitIndex]}`;
}

/**
 * Network throughput from bits per second, e.g. `18.2 Mb/s`.
 *
 * Zabbix's stock template pre-processes interface counters into bits/s with
 * SI (1000-based) multipliers, so this follows SI rather than IEC — matching
 * what the Zabbix frontend shows for the same item.
 *
 * @param {number|null|undefined} value bits per second
 * @returns {string}
 */
export function formatBitRate(value) {
    const numeric = Number(value);
    if (value === null || value === undefined || !Number.isFinite(numeric)) return '—';

    const magnitude = Math.abs(numeric);
    const units = [
        { limit: 1e9, divisor: 1e9, label: 'Gb/s' },
        { limit: 1e6, divisor: 1e6, label: 'Mb/s' },
        { limit: 1e3, divisor: 1e3, label: 'kb/s' },
    ];

    for (const unit of units) {
        if (magnitude >= unit.limit) {
            const scaled = magnitude / unit.divisor;
            const text = scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1);
            return `${text} ${unit.label}`;
        }
    }

    return `${magnitude.toFixed(0)} b/s`;
}

/**
 * Compact bit rate for the panel bar: `18M`, `640k`.
 *
 * @param {number|null|undefined} value bits per second
 * @returns {string}
 */
export function formatBitRateCompact(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '—';
    const magnitude = Math.abs(numeric);
    if (magnitude >= 1e9) return `${(magnitude / 1e9).toFixed(1)}G`;
    if (magnitude >= 1e6) return `${(magnitude / 1e6).toFixed(0)}M`;
    if (magnitude >= 1e3) return `${(magnitude / 1e3).toFixed(0)}k`;
    return `${magnitude.toFixed(0)}`;
}

/**
 * Seconds as a two-unit duration, e.g. `12d 4h`, `3h 12m`, `48s`.
 *
 * @param {number|null|undefined} value seconds
 * @returns {string}
 */
export function formatDuration(value) {
    const numeric = Number(value);
    if (value === null || value === undefined || !Number.isFinite(numeric) || numeric < 0) {
        return '—';
    }

    const seconds = Math.floor(numeric);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

/**
 * Load average with two decimals — the conventional presentation.
 *
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function formatLoad(value) {
    const numeric = Number(value);
    if (value === null || value === undefined || !Number.isFinite(numeric)) return '—';
    return numeric.toFixed(2);
}

/**
 * Whole count with a thousands separator (`1,284`).
 *
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function formatCount(value) {
    const numeric = Number(value);
    if (value === null || value === undefined || !Number.isFinite(numeric)) return '—';
    const rounded = Math.round(numeric);
    const text = String(Math.abs(rounded));
    const grouped = text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return rounded < 0 ? `−${grouped}` : grouped;
}

/**
 * Headline text for a metric value, dispatching on its kind.
 *
 * @param {string} kind one of VALUE_KIND
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function formatMetricValue(kind, value) {
    switch (kind) {
        case VALUE_KIND.PERCENT:
            return formatPercent(value);
        case VALUE_KIND.RATE:
            return formatBitRate(value);
        case VALUE_KIND.LOAD:
            return formatLoad(value);
        case VALUE_KIND.DURATION:
            return formatDuration(value);
        case VALUE_KIND.COUNT:
            return formatCount(value);
        default:
            return value === null || value === undefined ? '—' : String(value);
    }
}

/**
 * Split a headline into number and unit so the unit can be typeset smaller:
 * `46.9 kb/s` → `46.9` + ` kb/s`, `63%` → `63` + `%`. The unit keeps its
 * leading space, so `number + unit` is always the original text. Anything that
 * is not one number followed by one unit (`12d 4h`, `1,284`, `—`) comes back
 * whole.
 *
 * @param {string} text
 * @returns {{number: string, unit: string}}
 */
export function splitValueUnit(text) {
    const source = String(text ?? '');
    const match = /^(−?[\d.,]+)(\s?[^\d\s]+)$/.exec(source);
    return match ? { number: match[1], unit: match[2] } : { number: source, unit: '' };
}

/**
 * Compact headline for the panel bar.
 *
 * @param {string} kind
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function formatMetricValueCompact(kind, value) {
    switch (kind) {
        case VALUE_KIND.PERCENT:
            return formatPercent(value);
        case VALUE_KIND.RATE:
            return formatBitRateCompact(value);
        case VALUE_KIND.LOAD:
            return formatLoad(value);
        case VALUE_KIND.DURATION:
            return formatDuration(value);
        case VALUE_KIND.COUNT:
            return formatCount(value);
        default:
            return value === null || value === undefined ? '—' : String(value);
    }
}

/**
 * Clock time for a timestamp, in 24-hour form.
 *
 * St.Label has no locale-aware date formatting, and a monitoring tool is read
 * in passing, so a stable `HH:MM` beats a localized sentence.
 *
 * @param {number} unixSeconds
 * @returns {string}
 */
export function formatClockTime(unixSeconds) {
    const numeric = Number(unixSeconds);
    if (!Number.isFinite(numeric) || numeric <= 0) return '—';
    const date = new Date(numeric * 1000);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

/**
 * Human relative time, e.g. `just now`, `4 min ago`.
 *
 * @param {number} unixSeconds
 * @param {number} [nowSeconds] injectable clock for tests
 * @returns {string}
 */
export function formatRelativeTime(unixSeconds, nowSeconds = Date.now() / 1000) {
    const numeric = Number(unixSeconds);
    if (!Number.isFinite(numeric) || numeric <= 0) return 'never';

    const delta = Math.max(0, Math.floor(nowSeconds - numeric));
    if (delta < 10) return 'just now';
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
}

/**
 * Compact byte size for captions: `1.4G`.
 *
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function formatBytesCompact(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '—';
    const units = ['B', 'K', 'M', 'G', 'T'];
    let magnitude = Math.abs(numeric);
    let index = 0;
    while (magnitude >= 1024 && index < units.length - 1) {
        magnitude /= 1024;
        index += 1;
    }
    const text =
        magnitude >= 10 || index === 0
            ? magnitude.toFixed(0)
            : magnitude.toFixed(1).replace(/\.0$/, '');
    return `${text}${units[index]}`;
}

/**
 * Percentage as a 0..1 fraction for progress-bar widths.
 *
 * @param {number|null|undefined} value
 * @returns {number}
 */
export function percentToFraction(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(1, Math.max(0, numeric / 100));
}
