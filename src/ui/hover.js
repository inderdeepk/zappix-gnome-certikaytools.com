// hover.js — the arithmetic behind open-on-hover (pure).
//
// GNOME Shell's `PanelMenu.Button` opens on click; hover-to-open is entirely an
// extension concern, and it is easy to get subtly wrong: close too eagerly and
// the menu vanishes while the pointer crosses the gap between the icon and the
// popup, close too lazily and it stays open over unrelated apps.
//
// The policy is expressed here as data-in/decision-out so the timing rules can
// be tested without a compositor, a pointer, or a running shell. The indicator
// owns the timers and feeds this module rects and timestamps.

/**
 * Is a point inside an axis-aligned rect?
 *
 * Rect edges are half-open (`x <= px < x + width`) to match Clutter's hit
 * testing, so a point exactly on a shared border belongs to one rect only.
 *
 * @param {number} px
 * @param {number} py
 * @param {{x:number, y:number, width:number, height:number}} rect
 * @returns {boolean}
 */
export function pointInRect(px, py, rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    return px >= rect.x && px < rect.x + rect.width && py >= rect.y && py < rect.y + rect.height;
}

/**
 * Should the dropdown close on this tick?
 *
 * @param {object} options
 * @param {boolean} options.menuOpen
 * @param {boolean} options.pinned "keep open until dismissed" preference
 * @param {boolean} options.pointerInButton
 * @param {boolean} options.pointerInMenu
 * @param {number} options.outsideSinceMs monotonic ms when the pointer left, 0 if inside
 * @param {number} options.nowMs monotonic ms
 * @param {number} options.closeDelayMs
 * @returns {{close: boolean, outsideSinceMs: number}}
 *   `outsideSinceMs` is the value the caller should persist for the next tick:
 *   it is set on the first tick outside, cleared as soon as the pointer returns.
 */
export function evaluateHoverClose({
    menuOpen,
    pinned,
    pointerInButton,
    pointerInMenu,
    outsideSinceMs,
    nowMs,
    closeDelayMs,
}) {
    if (!menuOpen || pinned) {
        return { close: false, outsideSinceMs: 0 };
    }

    if (pointerInButton || pointerInMenu) {
        return { close: false, outsideSinceMs: 0 };
    }

    if (!outsideSinceMs) {
        return { close: false, outsideSinceMs: nowMs };
    }

    return {
        close: nowMs - outsideSinceMs >= Math.max(0, closeDelayMs),
        outsideSinceMs,
    };
}

/**
 * Should a hover open be scheduled?
 *
 * Clicking must always win: if the menu is already open, or the user disabled
 * hover, nothing is scheduled and the click handler keeps its behaviour.
 *
 * @param {object} options
 * @param {boolean} options.openOnHover
 * @param {boolean} options.menuOpen
 * @param {boolean} options.pointerInButton
 * @returns {boolean}
 */
export function shouldScheduleHoverOpen({ openOnHover, menuOpen, pointerInButton }) {
    return Boolean(openOnHover) && !menuOpen && Boolean(pointerInButton);
}

/**
 * Interval for the close-monitor timer.
 *
 * 120ms is imperceptible as a delay at a 360ms grace period, and the timer only
 * exists while the dropdown is open — so the cost is a handful of wakeups per
 * interaction rather than a permanent poll.
 */
export const HOVER_TICK_MS = 120;
