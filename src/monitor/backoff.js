// backoff.js — retry pacing for a monitoring poll (pure).
//
// A dashboard polls forever. Two failure modes matter and they pull in opposite
// directions:
//
//   • A dead server must not be hammered. Every consecutive failure doubles the
//     wait, up to a ceiling, so a VPN outage costs the Zabbix server a couple of
//     requests instead of a request every 30 seconds for an hour.
//   • A recovered server must start reporting again quickly. The first success
//     resets the ladder to the configured interval, and jitter spreads clients
//     out so a fleet of desktops does not synchronise into a thundering herd.
//
// Pure arithmetic, so the pacing is verified in tests rather than by watching a
// journal for an hour.

/** Upper bound on the backoff, in seconds. */
export const BACKOFF_CEILING_SECONDS = 900;

/** Growth factor per consecutive failure. */
const BACKOFF_FACTOR = 2;

/**
 * Delay before the next attempt.
 *
 * @param {object} options
 * @param {number} options.baseSeconds the configured poll interval
 * @param {number} options.consecutiveFailures 0 after a success
 * @param {number} [options.ceilingSeconds=BACKOFF_CEILING_SECONDS]
 * @param {number} [options.jitterRatio=0.15] ± fraction applied to the result
 * @param {() => number} [options.random=Math.random] injectable for tests
 * @returns {number} seconds, never below the base interval
 */
export function nextDelaySeconds({
    baseSeconds,
    consecutiveFailures,
    ceilingSeconds = BACKOFF_CEILING_SECONDS,
    jitterRatio = 0.15,
    random = Math.random,
}) {
    const base = Math.max(1, Number(baseSeconds) || 30);
    const failures = Math.max(0, Math.floor(Number(consecutiveFailures) || 0));

    const raw =
        failures === 0 ? base : Math.min(ceilingSeconds, base * BACKOFF_FACTOR ** (failures - 1));

    // Jitter only applies while healthy or lightly failing; once the ladder is
    // climbing, predictability matters less than staying off the server.
    if (failures === 0 && jitterRatio > 0) {
        const spread = raw * jitterRatio;
        const offset = (random() * 2 - 1) * spread;
        return Math.max(1, Math.round(raw + offset));
    }

    return Math.round(raw);
}

/**
 * Convert a backoff delay into a human sentence for the card footer.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function describeDelay(seconds) {
    const value = Math.max(1, Math.round(seconds));
    if (value < 60) return `${value}s`;
    if (value < 3600) return `${Math.round(value / 60)}m`;
    return `${Math.round(value / 3600)}h`;
}

/**
 * Should the poller give up entirely?
 *
 * It never does automatically — a monitoring tool that silently stops checking
 * is worse than one showing a red error — but this is where such a policy would
 * live, and tests pin the answer so a future change is deliberate.
 *
 * @param {number} consecutiveFailures
 * @returns {boolean}
 */
export function shouldAbandon(consecutiveFailures) {
    return Number(consecutiveFailures) > 500;
}
