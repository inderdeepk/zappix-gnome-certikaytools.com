// log.js — namespaced logging behind one switch.
//
// A GNOME extension's only debugging surface is the journal, and a polling
// extension that logs on every tick makes that surface useless. Everything
// verbose therefore routes through `debugEnabled`, and errors always go
// through `logError` so a failure is never swallowed regardless of the
// preference.
//
// The token-redaction helper is not optional politeness: Zabbix API tokens are
// long-lived and are often the only credential protecting a monitoring server,
// so they must never reach the journal even at debug level.

let debugEnabled = false;

/** Namespace applied to every line this extension emits. */
const PREFIX = '[Zappix]';

/**
 * Toggle verbose logging. Called once on enable and again whenever the
 * `debug-logging` key changes.
 *
 * @param {boolean} enabled
 */
export function setDebugEnabled(enabled) {
    debugEnabled = Boolean(enabled);
}

/**
 * @returns {boolean} current verbose state
 */
export function isDebugEnabled() {
    return debugEnabled;
}

/**
 * Informational line, suppressed unless verbose logging is on.
 *
 * @param {string} message
 * @param {...unknown} rest
 */
export function debug(message, ...rest) {
    if (!debugEnabled) return;
    log(`${PREFIX} ${message}`, ...rest.map(redact));
}

/**
 * Unconditional informational line. Use sparingly — lifecycle events only.
 *
 * @param {string} message
 * @param {...unknown} rest
 */
export function info(message, ...rest) {
    log(`${PREFIX} ${message}`, ...rest.map(redact));
}

/**
 * Warning line. Always emitted; a degraded-but-working state deserves a trace.
 *
 * @param {string} message
 * @param {...unknown} rest
 */
export function warn(message, ...rest) {
    log(`${PREFIX} WARNING ${message}`, ...rest.map(redact));
}

/**
 * Error line. Always emitted.
 *
 * @param {string} message
 * @param {unknown} [error]
 */
export function error(message, error) {
    const detail = error instanceof Error ? `${error.message}` : error ? String(error) : '';
    logError(new Error(`${PREFIX} ${message}${detail ? `: ${detail}` : ''}`));
}

/**
 * Remove credential-shaped substrings from a value bound for the journal.
 *
 * Handles the three places a token can leak: a Bearer header, an `auth` body
 * field, and a query string. Objects are serialised so nested request options
 * are covered too.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redact(value) {
    if (value === null || value === undefined) return String(value);

    let text;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        text = String(value);
    }

    return text
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
        .replace(/("auth"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2')
        .replace(/([?&](?:auth|token|password)=)[^&\s"]*/gi, '$1<redacted>');
}
