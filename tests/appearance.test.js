// appearance.test.js — the panel's severity palette and polarity detection.
//
// The top bar's background belongs to the shell theme, so the panel gauge picks
// its colours from the bar's text colour. These tests pin the two things that
// can silently go wrong: reading the polarity backwards, and a palette entry
// that is illegible on the bar it was chosen for.
import { assert, assertEqual, runTests } from './testUtils.js';
import {
    isDarkForeground,
    PANEL_SEVERITY_COLOURS_ON_LIGHT,
    panelSeverityColour,
    SEVERITY_COLOURS,
} from '../src/shared/appearance.js';

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex) {
    const channel = (offset) => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

const SEVERITIES = ['ok', 'warn', 'crit', 'unknown', 'maintenance'];

await runTests([
    [
        'isDarkForeground reads a white panel label as a dark bar',
        () => {
            assertEqual(isDarkForeground({ red: 255, green: 255, blue: 255 }), false);
            assertEqual(isDarkForeground({ red: 222, green: 221, blue: 218 }), false);
        },
    ],
    [
        'isDarkForeground reads a dark panel label as a light bar',
        () => {
            assertEqual(isDarkForeground({ red: 46, green: 52, blue: 54 }), true);
            assertEqual(isDarkForeground({ red: 0, green: 0, blue: 0 }), true);
        },
    ],
    [
        'isDarkForeground falls back to a dark bar without a colour',
        () => {
            assertEqual(isDarkForeground(null), false);
            assertEqual(isDarkForeground({}), false);
        },
    ],
    [
        'panelSeverityColour uses the standard palette on a dark bar',
        () => {
            for (const severity of SEVERITIES) {
                assertEqual(
                    panelSeverityColour(severity, false).css,
                    SEVERITY_COLOURS[severity].css,
                );
            }
        },
    ],
    [
        'panelSeverityColour uses the deeper palette on a light bar',
        () => {
            for (const severity of SEVERITIES) {
                assertEqual(
                    panelSeverityColour(severity, true).css,
                    PANEL_SEVERITY_COLOURS_ON_LIGHT[severity].css,
                );
            }
        },
    ],
    [
        'panelSeverityColour falls back to unknown for an unexpected severity',
        () => {
            assertEqual(panelSeverityColour('bogus', false).css, SEVERITY_COLOURS.unknown.css);
            assertEqual(
                panelSeverityColour('bogus', true).css,
                PANEL_SEVERITY_COLOURS_ON_LIGHT.unknown.css,
            );
        },
    ],
    [
        'light-bar palette stays legible on a near-white bar',
        () => {
            for (const severity of SEVERITIES) {
                const ratio = contrast(PANEL_SEVERITY_COLOURS_ON_LIGHT[severity].css, '#f6f5f4');
                assert(ratio >= 4, `${severity} is ${ratio.toFixed(2)}:1 on a light bar`);
            }
        },
    ],
    [
        'dark-bar palette stays legible on a black bar',
        () => {
            for (const severity of SEVERITIES) {
                const ratio = contrast(SEVERITY_COLOURS[severity].css, '#000000');
                assert(ratio >= 4.5, `${severity} is ${ratio.toFixed(2)}:1 on a dark bar`);
            }
        },
    ],
    [
        'light-bar Cairo channels match their CSS colour',
        () => {
            for (const severity of SEVERITIES) {
                const entry = PANEL_SEVERITY_COLOURS_ON_LIGHT[severity];
                const hex = (offset) =>
                    Number.parseInt(entry.css.slice(offset, offset + 2), 16) / 255;
                assert(Math.abs(entry.r - hex(1)) < 0.01, `${severity} red`);
                assert(Math.abs(entry.g - hex(3)) < 0.01, `${severity} green`);
                assert(Math.abs(entry.b - hex(5)) < 0.01, `${severity} blue`);
            }
        },
    ],
]);
