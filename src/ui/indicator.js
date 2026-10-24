// indicator.js — the panel icon and everything that happens around it.
//
// This is the only module that owns *shell state*: the PanelMenu.Button, the
// hover timers, the open/close lifecycle and the keyboard shortcut. It reads
// snapshots from the monitor, renders them through the Dashboard, and reports
// user intent back through the callbacks it was constructed with.
//
// Interaction model, in order of precedence:
//   1. Click — toggles, exactly like a stock panel indicator.
//   2. Hover — opens after `hover-open-delay-ms`, closes after
//      `hover-close-delay-ms` once the pointer is outside both the icon and the
//      popup (see `hover.js` for the decision rules).
//   3. Keyboard — the menu keeps its normal focus handling; a global shortcut
//      opens it for pointer-free use.
//
// Opening the menu is also what switches the monitor into full-depth polling,
// so sparkline history is only ever fetched while a human can see it.
//
// Shell-side module (St/Clutter/GLib).

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Dashboard } from './dashboard.js';
import { PanelGauge } from './widgets/panelGauge.js';
import {
    evaluateHoverClose,
    HOVER_TICK_MS,
    pointInRect,
    shouldScheduleHoverOpen,
} from './hover.js';
import { panelSummary, SERVER_STATUS } from '../monitor/snapshotStore.js';
import { gettext as _ } from '../shared/i18n.js';
import { debug, error } from '../shared/log.js';

/** Poll interval for the relative-time label while the menu is open. */
const CLOCK_TICK_SECONDS = 1;

export const ZappixIndicator = GObject.registerClass(
    {
        GTypeName: 'ZappixIndicator',
    },
    class ZappixIndicator extends PanelMenu.Button {
        /**
         * @param {object} options
         * @param {import('../shared/settings.js').ZappixSettings} options.settings
         * @param {import('../monitor/poller.js').MonitorService} options.monitor
         * @param {object} options.callbacks
         */
        constructor({ settings, monitor, callbacks }) {
            super(0.5, 'Zappix', false);

            this._settings = settings;
            this._monitor = monitor;
            this._callbacks = callbacks ?? {};

            this._openTimer = 0;
            this._reaperTimer = 0;
            this._clockTimer = 0;
            this._outsideSinceMs = 0;
            this._destroyed = false;

            this.add_style_class_name('zappix-panel-button');
            this.accessible_name = _('Zappix server monitor');

            this._buildPanelContent();
            this._buildMenu();
            this._connectHover();

            this._openStateId = this.menu.connect('open-state-changed', (menu, isOpen) =>
                this._onMenuOpenChanged(isOpen),
            );

            this.update();
        }

        // ── construction ────────────────────────────────────────────────────

        /**
         * One mark instead of dot + icon + label: see `widgets/panelGauge.js`.
         */
        _buildPanelContent() {
            this._panelGauge = new PanelGauge();
            this.add_child(this._panelGauge);
        }

        _buildMenu() {
            this.menu.box.add_style_class_name('zappix-menu-content');
            this._watchTheme();
            this._applyThemeClass();

            this._dashboard = new Dashboard({
                callbacks: {
                    onSelectServer: (serverId) => this._selectServer(serverId),
                    onRefresh: (serverId) => this._refresh(serverId),
                    onRefreshAll: () => this._refresh(''),
                    onOpenPreferences: () => this._callbacks.onOpenPreferences?.(),
                    onOpenFrontend: (serverId) => this._callbacks.onOpenFrontend?.(serverId),
                },
            });
            this.menu.box.add_child(this._dashboard);
        }

        /**
         * Mirror the desktop colour scheme onto the popup surface.
         *
         * The stylesheet ships both polarities; the class decides which one
         * applies. Reading `org.gnome.desktop.interface` is more reliable than
         * inspecting St theme colours, which are not exposed as CSS variables.
         */
        _applyThemeClass() {
            const dark = this._isDarkTheme();
            this.menu.box.remove_style_class_name(dark ? 'zappix-light' : 'zappix-dark');
            this.menu.box.add_style_class_name(dark ? 'zappix-dark' : 'zappix-light');
        }

        /** @returns {boolean} */
        _isDarkTheme() {
            if (!this._interfaceSettings) return true;
            try {
                // 'default' resolves to the shell's own dark popup theme.
                return this._interfaceSettings.get_string('color-scheme') !== 'prefer-light';
            } catch {
                return true;
            }
        }

        _watchTheme() {
            try {
                this._interfaceSettings = new Gio.Settings({
                    schema_id: 'org.gnome.desktop.interface',
                });
                this._themeHandlerId = this._interfaceSettings.connect(
                    'changed::color-scheme',
                    () => this._applyThemeClass(),
                );
            } catch {
                this._interfaceSettings = null;
                this._themeHandlerId = 0;
            }
        }

        _connectHover() {
            this.connect('enter-event', () => {
                this._cancelCloseMonitor();
                this._scheduleHoverOpen();
                return Clutter.EVENT_PROPAGATE;
            });

            this.connect('leave-event', () => {
                this._cancelHoverOpen();
                // The reaper only starts once the menu is open; starting it here
                // would spin a timer for every pointer pass over the panel.
                return Clutter.EVENT_PROPAGATE;
            });
        }

        // ── public API ──────────────────────────────────────────────────────

        /**
         * Re-render from the monitor's current state.
         */
        update() {
            if (this._destroyed) return;

            const snapshots = this._monitor.getSnapshots();
            const activeServerId = this._settings.activeServerId;
            const reduceMotion = this._settings.reduceMotion;

            this._dashboard.update({
                snapshots,
                activeServerId,
                density: this._settings.density,
                reduceMotion,
                nowSeconds: Date.now() / 1000,
            });

            this._updatePanel();
        }

        /**
         * Toggle from a keyboard shortcut or another entry point.
         */
        toggleMenu() {
            if (this.menu.isOpen) this.menu.close();
            else this.openMenu();
        }

        /**
         * Open and focus the dropdown.
         */
        openMenu() {
            if (this.menu.isOpen) return;
            this.menu.open();
        }

        /**
         * Release timers and disconnect signal handlers.
         */
        destroy() {
            this._destroyed = true;
            this._cancelHoverOpen();
            this._cancelCloseMonitor();
            this._stopClock();

            if (this._themeHandlerId) {
                try {
                    this._interfaceSettings?.disconnect(this._themeHandlerId);
                } catch {
                    // Settings object already gone.
                }
                this._themeHandlerId = 0;
            }

            if (this._openStateId) {
                try {
                    this.menu.disconnect(this._openStateId);
                } catch {
                    // Already gone.
                }
                this._openStateId = 0;
            }

            super.destroy();
        }

        // ── hover ───────────────────────────────────────────────────────────

        _scheduleHoverOpen() {
            if (this._openTimer) return;

            const shouldOpen = shouldScheduleHoverOpen({
                openOnHover: this._settings.openOnHover,
                menuOpen: this.menu.isOpen,
                pointerInButton: this._pointerInButton(),
            });
            if (!shouldOpen) return;

            const delay = Math.max(0, this._settings.hoverOpenDelayMs);
            this._openTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._openTimer = 0;
                if (!this._destroyed && this._pointerInButton() && !this.menu.isOpen) {
                    this.menu.open();
                }
                return GLib.SOURCE_REMOVE;
            });
        }

        _cancelHoverOpen() {
            if (!this._openTimer) return;
            GLib.source_remove(this._openTimer);
            this._openTimer = 0;
        }

        /**
         * Start the close monitor. Runs only while the dropdown is open.
         */
        _startCloseMonitor() {
            if (this._reaperTimer) return;
            this._outsideSinceMs = 0;

            this._reaperTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_TICK_MS, () => {
                if (this._destroyed || !this.menu.isOpen) {
                    this._reaperTimer = 0;
                    return GLib.SOURCE_REMOVE;
                }

                const decision = evaluateHoverClose({
                    menuOpen: true,
                    pinned: this._settings.pinOnOpen,
                    pointerInButton: this._pointerInButton(),
                    pointerInMenu: this._pointerInMenu(),
                    outsideSinceMs: this._outsideSinceMs,
                    nowMs: GLib.get_monotonic_time() / 1000,
                    closeDelayMs: this._settings.hoverCloseDelayMs,
                });

                this._outsideSinceMs = decision.outsideSinceMs;

                if (decision.close) {
                    this._reaperTimer = 0;
                    this.menu.close();
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            });
        }

        _cancelCloseMonitor() {
            if (!this._reaperTimer) return;
            GLib.source_remove(this._reaperTimer);
            this._reaperTimer = 0;
            this._outsideSinceMs = 0;
        }

        // ── menu lifecycle ──────────────────────────────────────────────────

        /**
         * @param {boolean} isOpen
         */
        _onMenuOpenChanged(isOpen) {
            this._cancelHoverOpen();

            if (isOpen) {
                // Sparklines are only worth fetching when visible.
                this._monitor.setFullDepth(true);
                this.update();

                // The close monitor only makes sense when the menu was opened
                // by the pointer resting on the indicator. Opening it another
                // way (keyboard, a future command) must not instantly close it.
                if (this._pointerInButton() || this._pointerInMenu()) {
                    this._startCloseMonitor();
                }

                this._startClock();
                debug('menu opened');
            } else {
                this._cancelCloseMonitor();
                this._stopClock();
                this._monitor.setFullDepth(false);
                debug('menu closed');
            }
        }

        _startClock() {
            if (this._clockTimer) return;
            this._clockTimer = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                CLOCK_TICK_SECONDS,
                () => {
                    if (this._destroyed || !this.menu.isOpen) {
                        this._clockTimer = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                    this._dashboard.tickClock(Date.now() / 1000);
                    return GLib.SOURCE_CONTINUE;
                },
            );
        }

        _stopClock() {
            if (!this._clockTimer) return;
            GLib.source_remove(this._clockTimer);
            this._clockTimer = 0;
        }

        // ── panel ───────────────────────────────────────────────────────────

        _updatePanel() {
            const snapshots = this._monitor.getSnapshots();
            const active =
                snapshots.find((snapshot) => snapshot.serverId === this._settings.activeServerId) ??
                snapshots[0] ??
                null;

            const summary = panelSummary({
                activeSnapshot: active,
                metric: this._settings.panelMetric,
                alertOnProblems: this._settings.panelAlertOnProblems,
            });

            const showValue = this._settings.showPanelValue && summary.text !== '';
            this._panelGauge.setState({
                fraction: summary.fraction,
                severity: summary.severity,
                badge: summary.badge,
                offline: summary.offline,
                text: showValue ? summary.text : '',
            });
            this._panelGauge.setPulsing(
                active?.status === SERVER_STATUS.LOADING,
                this._settings.reduceMotion,
            );

            // St has no tooltips, so the description goes where it is actually
            // read: the screen reader's name for the button.
            this.accessible_name = `${_('Zappix server monitor')}: ${this._describe(active, summary)}`;
        }

        /**
         * @param {object|null} active
         * @param {object} summary
         * @returns {string}
         */
        _describe(active, summary) {
            if (!active) return _('no servers configured');

            const parts = [active.label];
            if (active.status === SERVER_STATUS.ERROR) parts.push(active.error);
            if (summary.available) {
                // Problems mode leaves the label empty when clear; say so.
                const value = summary.text || '0';
                parts.push(summary.label ? `${_(summary.label)} ${value}` : value);
            }

            const problems = summary.problemCount;
            if (problems > 0 && this._settings.panelMetric !== 'problems') {
                parts.push(`${problems} problem(s)`);
            }

            return parts.filter((part) => part && part.trim()).join(' · ');
        }

        // ── actions ─────────────────────────────────────────────────────────

        /**
         * @param {string} serverId
         */
        _selectServer(serverId) {
            this._settings.activeServerId = serverId;
            this.update();
        }

        /**
         * @param {string} serverId empty for all servers
         */
        _refresh(serverId) {
            this._monitor.refresh({ serverId }).catch((refreshError) => {
                error('manual refresh failed', refreshError);
            });
        }

        // ── geometry ────────────────────────────────────────────────────────

        /** @returns {boolean} */
        _pointerInButton() {
            return pointInRect(...this._pointer(), this._rectOf(this));
        }

        /** @returns {boolean} */
        _pointerInMenu() {
            return pointInRect(...this._pointer(), this._rectOf(this.menu.box));
        }

        /** @returns {[number, number]} */
        _pointer() {
            const [x, y] = global.get_pointer();
            return [x, y];
        }

        /**
         * Screen-space rect of an actor.
         *
         * @param {Clutter.Actor} actor
         * @returns {{x:number, y:number, width:number, height:number}}
         */
        _rectOf(actor) {
            if (!actor || !actor.visible) return { x: 0, y: 0, width: 0, height: 0 };
            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            return { x, y, width, height };
        }
    },
);

/**
 * Add the indicator to the top panel.
 *
 * @param {ZappixIndicator} indicator
 * @returns {ZappixIndicator}
 */
export function addIndicatorToPanel(indicator) {
    Main.panel.addToStatusArea('zappix', indicator);
    return indicator;
}
