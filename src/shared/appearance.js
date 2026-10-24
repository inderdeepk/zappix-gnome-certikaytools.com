// appearance.js — palette and layout tokens shared by CSS classes and Cairo.
//
// Two rendering paths need the same colours: the stylesheet (tiles, pills,
// borders) and the sparkline drawing (fill gradients, baseline). If they drift,
// a tile's border and its curve disagree about what "critical" looks like. So
// the hex values live here once, the stylesheet mirrors the class names, and
// the drawing code reads the same table.
//
// Severity colours are intentionally theme-independent: green/amber/red are
// the signal, and a monitoring tool that re-tints them with the desktop accent
// stops being readable at a glance.

/** Layout density options, in menu order. */
export const DENSITIES = Object.freeze(['compact', 'comfortable', 'spacious']);

/**
 * Tile metrics available to the panel indicator.
 *
 * `problems` is not a metric catalog entry — it summarizes `problem.get`
 * instead — so it is listed separately here.
 */
export const PANEL_METRICS = Object.freeze(['cpu', 'memory', 'disk', 'problems']);

/**
 * Accent palettes. Each provides the neutral tint for chrome plus a two-stop
 * gradient used to fill the area under a sparkline.
 */
export const ACCENTS = Object.freeze({
    aurora: Object.freeze({
        label: 'Aurora',
        accent: '#7aa2f7',
        accentSoft: 'rgba(122, 162, 247, 0.18)',
        fillTop: 'rgba(122, 162, 247, 0.42)',
        fillBottom: 'rgba(122, 162, 247, 0.02)',
    }),
    ocean: Object.freeze({
        label: 'Ocean',
        accent: '#7dcfff',
        accentSoft: 'rgba(125, 207, 255, 0.18)',
        fillTop: 'rgba(125, 207, 255, 0.42)',
        fillBottom: 'rgba(125, 207, 255, 0.02)',
    }),
    ember: Object.freeze({
        label: 'Ember',
        accent: '#e0af68',
        accentSoft: 'rgba(224, 175, 104, 0.18)',
        fillTop: 'rgba(224, 175, 104, 0.42)',
        fillBottom: 'rgba(224, 175, 104, 0.02)',
    }),
    graphite: Object.freeze({
        label: 'Graphite',
        accent: '#9aa5b1',
        accentSoft: 'rgba(154, 165, 177, 0.18)',
        fillTop: 'rgba(154, 165, 177, 0.38)',
        fillBottom: 'rgba(154, 165, 177, 0.02)',
    }),
});

/** Accent ids in menu order. */
export const ACCENT_IDS = Object.freeze(Object.keys(ACCENTS));

/**
 * Resolve an accent id to its palette, falling back to the first entry.
 *
 * @param {string} id
 * @returns {object}
 */
export function accentFor(id) {
    return ACCENTS[id] ?? ACCENTS[ACCENT_IDS[0]];
}

/**
 * Severity colours as RGB triples (0..1) for Cairo, plus the CSS class suffix
 * each maps to. `unknown` is a neutral mid-grey so missing data reads as
 * "nothing measured" rather than as an alarm.
 */
export const SEVERITY_COLOURS = Object.freeze({
    ok: Object.freeze({ r: 0.49, g: 0.83, b: 0.53, css: '#7ee787' }),
    warn: Object.freeze({ r: 0.95, g: 0.74, b: 0.36, css: '#f2bc5c' }),
    crit: Object.freeze({ r: 0.97, g: 0.45, b: 0.49, css: '#f7737d' }),
    unknown: Object.freeze({ r: 0.55, g: 0.58, b: 0.63, css: '#8c94a1' }),
    maintenance: Object.freeze({ r: 0.58, g: 0.62, b: 0.72, css: '#949eb8' }),
});

/**
 * Cairo colour for a severity, with an alpha override.
 *
 * @param {string} severity
 * @param {number} [alpha=1]
 * @returns {{r:number,g:number,b:number,a:number}}
 */
export function severityColour(severity, alpha = 1) {
    const entry = SEVERITY_COLOURS[severity] ?? SEVERITY_COLOURS.unknown;
    return { r: entry.r, g: entry.g, b: entry.b, a: alpha };
}

/**
 * Deeper severity tones for a light top bar.
 *
 * The panel's background belongs to the shell theme, not to Zappix. The
 * standard palette is tuned for dark surfaces; on a light bar its amber drops
 * to ~1.6:1. These keep every hue at or above 4:1 on a near-white bar while
 * still reading as the same green/amber/red.
 */
export const PANEL_SEVERITY_COLOURS_ON_LIGHT = Object.freeze({
    ok: Object.freeze({ r: 0.17, g: 0.54, b: 0.24, css: '#2b8a3e' }),
    warn: Object.freeze({ r: 0.6, g: 0.36, b: 0.0, css: '#9a5b00' }),
    crit: Object.freeze({ r: 0.79, g: 0.16, b: 0.23, css: '#c92a3a' }),
    unknown: Object.freeze({ r: 0.42, g: 0.45, b: 0.5, css: '#6b7280' }),
    maintenance: Object.freeze({ r: 0.36, g: 0.4, b: 0.53, css: '#5c6788' }),
});

/**
 * Is a panel text colour dark, i.e. is the top bar light?
 *
 * The bar's text colour is the one thing an extension can read reliably from
 * any shell theme, and its polarity is the inverse of the background's.
 *
 * @param {{red:number, green:number, blue:number}} colour 0..255 channels
 * @returns {boolean}
 */
export function isDarkForeground(colour) {
    if (!colour) return false;
    const luminance =
        (0.2126 * Number(colour.red) +
            0.7152 * Number(colour.green) +
            0.0722 * Number(colour.blue)) /
        255;
    return Number.isFinite(luminance) && luminance < 0.5;
}

/**
 * Severity colour for the top panel, picked for the bar's polarity.
 *
 * @param {string} severity
 * @param {boolean} onLightPanel
 * @returns {{r:number, g:number, b:number, css:string}}
 */
export function panelSeverityColour(severity, onLightPanel) {
    const table = onLightPanel ? PANEL_SEVERITY_COLOURS_ON_LIGHT : SEVERITY_COLOURS;
    return table[severity] ?? table.unknown;
}

/** Tile sizing per density: [minWidth, sparklineHeight, padding]. */
export const DENSITY_TOKENS = Object.freeze({
    compact: Object.freeze({ tileMinWidth: 96, sparklineHeight: 22, padding: 8 }),
    comfortable: Object.freeze({ tileMinWidth: 112, sparklineHeight: 28, padding: 12 }),
    spacious: Object.freeze({ tileMinWidth: 128, sparklineHeight: 42, padding: 16 }),
});

/**
 * Resolve a density id.
 *
 * @param {string} id
 * @returns {object}
 */
export function densityFor(id) {
    return DENSITY_TOKENS[id] ?? DENSITY_TOKENS.comfortable;
}
