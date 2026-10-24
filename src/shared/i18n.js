// i18n.js — shared gettext bridge.
//
// GNOME 45+ extensions receive gettext/ngettext from the shell's module
// resources, but those imports only resolve inside the running shell processes
// and would break the plain-gjs import smoke test. Every module therefore
// translates through this small shim; the two entry points (extension.js
// `enable()`, prefs.js `fillPreferencesWindow()`) inject the real functions
// once via `initI18n()`.
//
// Until initialization happens — unit tests, import smoke, or any context
// without gettext — the shim passes strings through untranslated, so callers
// are safe to use `gettext()` unconditionally. Translations are loaded by the
// shell from `locale/<lang>/LC_MESSAGES/<uuid>.mo` (see `make pot` /
// `make langs`).
//
// Rule of thumb for this codebase: metric names, host names, API method names
// and Zabbix-supplied text are NOT translated (they are data, not UI copy).
let gettextFn = (str) => str;
let ngettextFn = (singular, plural, count) => (count === 1 ? singular : plural);

/**
 * Inject the real gettext functions from the shell resources.
 * Missing/invalid arguments leave the previous implementation in place.
 *
 * @param {{gettext?: Function, ngettext?: Function}} [functions]
 */
export function initI18n({ gettext, ngettext } = {}) {
    if (typeof gettext === 'function') gettextFn = gettext;
    if (typeof ngettext === 'function') ngettextFn = ngettext;
}

/**
 * Translate a string (identity until initI18n() runs).
 *
 * @param {string} str
 * @returns {string}
 */
export function gettext(str) {
    return gettextFn(str);
}

/**
 * Translate a plural form (identity until initI18n() runs).
 *
 * @param {string} singular
 * @param {string} plural
 * @param {number} count
 * @returns {string}
 */
export function ngettext(singular, plural, count) {
    return ngettextFn(singular, plural, count);
}

/**
 * Substitute `{name}`-style placeholders in a translated string.
 *
 *   format(_('{count} problems'), { count: 3 })
 *
 * Unknown placeholders are left verbatim (a half-applied call stays visible
 * instead of silently losing text). Omitting `params` is a no-op, so callers
 * can pass it through unconditionally.
 *
 * @param {string} str
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function format(str, params) {
    if (typeof str !== 'string' || !params) return str;
    return str.replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
    );
}
