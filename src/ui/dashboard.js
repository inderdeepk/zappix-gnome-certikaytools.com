// dashboard.js — the complete content of the dropdown.
//
// Composition, top to bottom:
//
//   Zappix            ●   ⟳   ⚙      title row + global actions
//   ( Prod ) ( Staging )             server switcher, only when >1
//   ● Production         4 hosts · 2 problems
//   …host sections…
//   ▲ disaster  Disk /var is 94% full   14:02
//   Updated 12s ago              Open Zabbix
//
// The dashboard is a plain St container added to a PopupMenu's box rather than
// a series of PopupMenuItems. That is a deliberate choice: menu items bring
// arrow-key navigation and a theme-provided hover highlight, neither of which
// suit a dense grid of tiles, and the grid is where the value is.
//
// Shell-side module (St/Clutter).

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { ServerCard } from './serverCard.js';
import { StatusDot } from './widgets/statusDot.js';
import { SEVERITY } from '../model/severity.js';
import { SERVER_STATUS } from '../monitor/snapshotStore.js';
import { zabbixLogoIcon } from '../shared/brand.js';
import { gettext as _ } from '../shared/i18n.js';

export const Dashboard = GObject.registerClass(
    {
        GTypeName: 'ZappixDashboard',
    },
    class Dashboard extends St.BoxLayout {
        /**
         * @param {object} params
         * @param {object} [params.callbacks] handler bag
         */
        constructor(params = {}) {
            // Split our own options out before calling super: passing an unknown
            // property to an St constructor is a hard error in GObject.
            const { callbacks, ...stParams } = params;

            super({
                style_class: 'zappix-dashboard',
                vertical: true,
                x_expand: true,
                ...stParams,
            });

            this._callbacks = callbacks ?? {};
            this._activeServerId = '';
            this._snapshots = [];

            this._buildHeader();
            this._buildSwitcher();
            this._buildCard();
            this._buildEmptyState();

            this.update({ snapshots: [] });
        }

        // ── construction ────────────────────────────────────────────────────

        _buildHeader() {
            const header = new St.BoxLayout({
                style_class: 'zappix-header',
                vertical: false,
                x_expand: true,
            });
            this.add_child(header);

            this._headerDot = new StatusDot({ style_class: 'zappix-dot zappix-dot-large' });
            header.add_child(this._headerDot);

            header.add_child(
                new St.Icon({
                    gicon: zabbixLogoIcon(),
                    style_class: 'zappix-brand-icon',
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            );

            const title = new St.Label({
                style_class: 'zappix-title',
                text: 'Zappix',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            header.add_child(title);

            this._refreshAllButton = this._iconButton(
                'view-refresh-symbolic',
                _('Refresh all servers'),
                () => this._invoke('onRefreshAll'),
            );
            header.add_child(this._refreshAllButton);

            this._settingsButton = this._iconButton(
                'emblem-system-symbolic',
                _('Zappix preferences'),
                () => this._invoke('onOpenPreferences'),
            );
            header.add_child(this._settingsButton);
        }

        _buildSwitcher() {
            this._switcher = new St.BoxLayout({
                style_class: 'zappix-switcher',
                vertical: false,
                x_expand: true,
                visible: false,
            });
            this.add_child(this._switcher);
        }

        _buildCard() {
            this._card = new ServerCard({
                onRefresh: () => this._invoke('onRefresh', this._activeServerId),
                onOpenFrontend: () => this._invoke('onOpenFrontend', this._activeServerId),
                visible: false,
            });
            this.add_child(this._card);
        }

        _buildEmptyState() {
            this._emptyState = new St.BoxLayout({
                style_class: 'zappix-empty',
                vertical: true,
                x_expand: true,
                visible: false,
            });
            this.add_child(this._emptyState);

            this._emptyState.add_child(
                new St.Icon({
                    gicon: zabbixLogoIcon(),
                    style_class: 'zappix-empty-icon',
                    x_align: Clutter.ActorAlign.CENTER,
                }),
            );

            this._emptyState.add_child(
                new St.Label({
                    style_class: 'zappix-empty-title',
                    text: _('No servers yet'),
                    x_align: Clutter.ActorAlign.CENTER,
                }),
            );

            this._emptyState.add_child(
                new St.Label({
                    style_class: 'zappix-empty-body',
                    text: _('Add a Zabbix server and its API token to start monitoring.'),
                    x_align: Clutter.ActorAlign.CENTER,
                }),
            );

            const addButton = new St.Button({
                style_class: 'zappix-primary-button',
                child: new St.Label({
                    style_class: 'zappix-primary-button-label',
                    text: _('Add a server'),
                }),
                x_align: Clutter.ActorAlign.CENTER,
                can_focus: true,
                reactive: true,
            });
            addButton.connect('clicked', () => this._invoke('onOpenPreferences'));
            this._emptyState.add_child(addButton);
        }

        // ── update ──────────────────────────────────────────────────────────

        /**
         * Render a full refresh.
         *
         * @param {object} options
         * @param {object[]} [options.snapshots]
         * @param {string} [options.activeServerId]
         * @param {string} [options.density]
         * @param {boolean} [options.reduceMotion]
         * @param {number} [options.nowSeconds]
         */
        update({
            snapshots = [],
            activeServerId = '',
            density = 'comfortable',
            reduceMotion = false,
            nowSeconds = Date.now() / 1000,
        } = {}) {
            this._snapshots = snapshots;
            this._activeServerId = activeServerId;
            this._density = density;
            this._reduceMotion = reduceMotion;

            const hasServers = snapshots.length > 0;
            const multiServer = snapshots.length > 1;
            this._emptyState.visible = !hasServers;
            this._card.visible = hasServers;
            this._switcher.visible = multiServer;
            // With one server the card's own dot and refresh say the same thing;
            // repeating them in the header only adds a third green dot.
            this._headerDot.visible = multiServer;
            this._refreshAllButton.visible = multiServer;

            this._renderHeaderDot();

            if (!hasServers) return;

            const active = this._resolveActive(snapshots, activeServerId);
            this._renderSwitcher(snapshots);

            if (active) {
                this._card.update(active, { density, reduceMotion, nowSeconds });
            }
        }

        /**
         * Cheap path for the per-second relative-time tick: only the footer
         * text changes, so the card is not rebuilt.
         *
         * @param {number} nowSeconds
         */
        tickClock(nowSeconds) {
            const snapshot = this._activeSnapshot();
            if (!snapshot || !snapshot.fetchedAt) return;

            this._card.update(snapshot, {
                density: this._density,
                reduceMotion: this._reduceMotion,
                nowSeconds,
            });
        }

        // ── internals ───────────────────────────────────────────────────────

        /** @returns {object|null} */
        _activeSnapshot() {
            if (this._snapshots.length === 0) return null;
            return (
                this._snapshots.find((snapshot) => snapshot.serverId === this._activeServerId) ??
                this._snapshots[0]
            );
        }

        /**
         * Pick the snapshot to display, honouring a stale active id.
         *
         * @param {object[]} snapshots
         * @param {string} activeServerId
         * @returns {object|null}
         */
        _resolveActive(snapshots, activeServerId) {
            return (
                snapshots.find((snapshot) => snapshot.serverId === activeServerId) ?? snapshots[0]
            );
        }

        _renderHeaderDot() {
            const worst = this._snapshots.reduce((current, snapshot) => {
                if (snapshot.status === SERVER_STATUS.ERROR) return SEVERITY.CRIT;
                return rank(snapshot.worstSeverity) > rank(current)
                    ? snapshot.worstSeverity
                    : current;
            }, SEVERITY.OK);

            this._headerDot.setSeverity(this._snapshots.length === 0 ? SEVERITY.UNKNOWN : worst);
            this._headerDot.setPulsing(
                this._snapshots.some((snapshot) => snapshot.status === SERVER_STATUS.LOADING),
                this._reduceMotion,
            );
        }

        /**
         * @param {object[]} snapshots
         */
        _renderSwitcher(snapshots) {
            this._switcher.destroy_all_children();

            for (const snapshot of snapshots) {
                const button = new St.Button({
                    style_class: 'zappix-switcher-pill',
                    can_focus: true,
                    reactive: true,
                    x_expand: false,
                    child: buildPillContent(snapshot),
                });

                if (snapshot.serverId === this._activeServerId) {
                    button.add_style_class_name('zappix-switcher-pill-active');
                }

                button.connect('clicked', () => this._invoke('onSelectServer', snapshot.serverId));
                this._switcher.add_child(button);
            }
        }

        /**
         * @param {string} iconName
         * @param {string} accessibleName
         * @param {() => void} handler
         * @returns {St.Button}
         */
        _iconButton(iconName, accessibleName, handler) {
            const button = new St.Button({
                style_class: 'zappix-icon-button',
                child: new St.Icon({
                    icon_name: iconName,
                    style_class: 'zappix-icon-button-icon',
                }),
                can_focus: true,
                accessible_name: accessibleName,
                reactive: true,
            });
            button.connect('clicked', handler);
            return button;
        }

        /**
         * @param {string} name
         * @param {...unknown} args
         */
        _invoke(name, ...args) {
            const handler = this._callbacks[name];
            if (typeof handler === 'function') handler(...args);
        }
    },
);

/**
 * Pill content: server colour dot + label + optional problem count.
 *
 * @param {object} snapshot
 * @returns {St.BoxLayout}
 */
function buildPillContent(snapshot) {
    const box = new St.BoxLayout({
        style_class: 'zappix-switcher-pill-content',
        vertical: false,
    });

    const dot = new St.Widget({
        style_class: 'zappix-switcher-dot',
        y_align: Clutter.ActorAlign.CENTER,
    });
    dot.set_style(`background-color: ${snapshot.colour ?? '#7aa2f7'};`);
    box.add_child(dot);

    box.add_child(
        new St.Label({
            style_class: 'zappix-switcher-label',
            text: snapshot.label,
            y_align: Clutter.ActorAlign.CENTER,
        }),
    );

    const problems = snapshot.problems?.unacknowledged ?? 0;
    if (problems > 0) {
        box.add_child(
            new St.Label({
                style_class: 'zappix-switcher-badge',
                text: String(problems),
                y_align: Clutter.ActorAlign.CENTER,
            }),
        );
    }

    return box;
}

/**
 * Sort rank for severities when folding several servers into one header dot.
 *
 * @param {string} severity
 * @returns {number}
 */
function rank(severity) {
    switch (severity) {
        case SEVERITY.CRIT:
            return 3;
        case SEVERITY.WARN:
            return 2;
        case SEVERITY.UNKNOWN:
            return 1;
        default:
            return 0;
    }
}
