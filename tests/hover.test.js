// hover.test.js — the open-on-hover policy.
//
// Hover menus fail in two annoying ways: they close while the pointer crosses
// the gap to the popup, or they stay open over whatever the user moved on to.
// Both are timing bugs, so they are tested as arithmetic rather than by moving a
// mouse.
import { assertEqual, runTests } from './testUtils.js';
import {
    evaluateHoverClose,
    HOVER_TICK_MS,
    pointInRect,
    shouldScheduleHoverOpen,
} from '../src/ui/hover.js';

const RECT = { x: 100, y: 0, width: 50, height: 20 };

await runTests([
    [
        'pointInRect accepts an interior point',
        () => {
            assertEqual(pointInRect(110, 10, RECT), true);
        },
    ],
    [
        'pointInRect uses half-open edges',
        () => {
            assertEqual(pointInRect(100, 0, RECT), true, 'top-left edge is inside');
            assertEqual(pointInRect(150, 10, RECT), false, 'right edge is outside');
            assertEqual(pointInRect(100, 20, RECT), false, 'bottom edge is outside');
        },
    ],
    [
        'pointInRect rejects a degenerate rect',
        () => {
            assertEqual(pointInRect(110, 10, { x: 100, y: 0, width: 0, height: 0 }), false);
            assertEqual(pointInRect(110, 10, null), false);
        },
    ],
    [
        'shouldScheduleHoverOpen requires the preference, a closed menu and the pointer',
        () => {
            const base = { openOnHover: true, menuOpen: false, pointerInButton: true };
            assertEqual(shouldScheduleHoverOpen(base), true);
            assertEqual(shouldScheduleHoverOpen({ ...base, openOnHover: false }), false);
            assertEqual(shouldScheduleHoverOpen({ ...base, menuOpen: true }), false);
            assertEqual(shouldScheduleHoverOpen({ ...base, pointerInButton: false }), false);
        },
    ],
    [
        'evaluateHoverClose keeps the menu open while the pointer is on the icon',
        () => {
            const result = evaluateHoverClose({
                menuOpen: true,
                pinned: false,
                pointerInButton: true,
                pointerInMenu: false,
                outsideSinceMs: 0,
                nowMs: 1000,
                closeDelayMs: 300,
            });
            assertEqual(result.close, false);
            assertEqual(result.outsideSinceMs, 0);
        },
    ],
    [
        'evaluateHoverClose keeps the menu open while the pointer is in the popup',
        () => {
            const result = evaluateHoverClose({
                menuOpen: true,
                pinned: false,
                pointerInButton: false,
                pointerInMenu: true,
                outsideSinceMs: 0,
                nowMs: 1000,
                closeDelayMs: 300,
            });
            assertEqual(result.close, false);
        },
    ],
    [
        'evaluateHoverClose records the moment the pointer leaves',
        () => {
            const result = evaluateHoverClose({
                menuOpen: true,
                pinned: false,
                pointerInButton: false,
                pointerInMenu: false,
                outsideSinceMs: 0,
                nowMs: 1000,
                closeDelayMs: 300,
            });
            assertEqual(result.close, false);
            assertEqual(result.outsideSinceMs, 1000);
        },
    ],
    [
        'evaluateHoverClose waits out the grace period',
        () => {
            const stillOpen = evaluateHoverClose({
                menuOpen: true,
                pinned: false,
                pointerInButton: false,
                pointerInMenu: false,
                outsideSinceMs: 1000,
                nowMs: 1200,
                closeDelayMs: 300,
            });
            assertEqual(stillOpen.close, false);

            const closes = evaluateHoverClose({
                menuOpen: true,
                pinned: false,
                pointerInButton: false,
                pointerInMenu: false,
                outsideSinceMs: 1000,
                nowMs: 1300,
                closeDelayMs: 300,
            });
            assertEqual(closes.close, true);
        },
    ],
    [
        'evaluateHoverClose cancels a pending close when the pointer returns',
        () => {
            const result = evaluateHoverClose({
                menuOpen: true,
                pinned: false,
                pointerInButton: false,
                pointerInMenu: true,
                outsideSinceMs: 1000,
                nowMs: 1100,
                closeDelayMs: 300,
            });
            assertEqual(result.close, false);
            assertEqual(result.outsideSinceMs, 0, 'timer state is reset');
        },
    ],
    [
        'evaluateHoverClose never closes a pinned menu',
        () => {
            const result = evaluateHoverClose({
                menuOpen: true,
                pinned: true,
                pointerInButton: false,
                pointerInMenu: false,
                outsideSinceMs: 1000,
                nowMs: 99999,
                closeDelayMs: 300,
            });
            assertEqual(result.close, false);
        },
    ],
    [
        'evaluateHoverClose does nothing when the menu is closed',
        () => {
            const result = evaluateHoverClose({
                menuOpen: false,
                pinned: false,
                pointerInButton: false,
                pointerInMenu: false,
                outsideSinceMs: 1000,
                nowMs: 99999,
                closeDelayMs: 300,
            });
            assertEqual(result.close, false);
        },
    ],
    [
        'the hover tick is fast enough to feel immediate',
        () => {
            assertEqual(HOVER_TICK_MS <= 200, true);
        },
    ],
]);
