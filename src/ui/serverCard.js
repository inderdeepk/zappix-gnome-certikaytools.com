// serverCard.js — the per-server panel inside the dropdown.
//
// Owns three things a bare list cannot express:
//   • a header that answers "is this server healthy?" in one glance;
//   • a host list that reconciles instead of rebuilding, so a 30-second poll
//     does not destroy hover state, scroll position or the tooltip under the
//     pointer;
//   • a degraded state that keeps the last good numbers on screen and explains
//     the failure in place of the data.
//
// Shape:
//
//   ● Production                      4 hosts · 2 problems   ↻
//   ┌───────────────────────────────────────────────────────────┐
//   │ web-01  10.0.0.4:10050                          ●         │
//   │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
//   │ │ CPU 42%  │ │ MEM 61%  │ │ DSK 78%  │ │ NET 1.2M │      │
//   │ └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
//   └───────────────────────────────────────────────────────────┘
//   ▲ disaster  Disk /var is 94% full
//   Updated 12s ago
//
// Shell-side module (St/Clutter).

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { StatusDot } from './widgets/statusDot.js';
import { MetricTile } from './widgets/metricTile.js';
import { SEVERITY, severityClass } from '../model/severity.js';
import { SERVER_STATUS, describeServer } from '../monitor/snapshotStore.js';
import { DENSITY_TOKENS } from '../shared/appearance.js';
import { formatClockTime, formatRelativeTime } from '../shared/format.js';
import { gettext as _, ngettext, format } from '../shared/i18n.js';

/** Tiles per row. Two reads well at every density and keeps cards narrow. */
const TILES_PER_ROW = 2;

/** Maximum number of problems listed before "and N more". */
const MAX_PROBLEM_ROWS = 3;

export const ServerCard = GObject.registerClass(
    {
        GTypeName: 'ZappixServerCard',
    },
    class ServerCard extends St.BoxLayout {
        /**
         * @param {object} params
         * @param {() => void} params.onRefresh
         * @param {() => void} params.onOpenFrontend
         * @param {number} [params.maxListHeight=420]
         */
        constructor(params = {}) {
            const { onRefresh, onOpenFrontend, maxListHeight, ...stParams } = params;

            super({
                style_class: 'zappix-card',
                vertical: true,
                x_expand: true,
                ...stParams,
            });

            this._onRefresh = onRefresh ?? (() => {});
            this._onOpenFrontend = onOpenFrontend ?? (() => {});
            this._maxListHeight = maxListHeight ?? 560;

            this._hostSections = new Map();
            this._density = 'comfortable';
            this._reduceMotion = false;
            this._now = Date.now() / 1000;

            this._buildHeader();
            this._buildScrollArea();
            this._buildProblems();
            this._buildFooter();
        }

        // ── construction ────────────────────────────────────────────────────

        _buildHeader() {
            this._header = new St.BoxLayout({
                style_class: 'zappix-card-head',
                vertical: false,
                x_expand: true,
            });
            this.add_child(this._header);

            this._dot = new StatusDot();
            this._header.add_child(this._dot);

            const titles = new St.BoxLayout({
                style_class: 'zappix-card-titles',
                vertical: true,
                x_expand: true,
            });
            this._header.add_child(titles);

            this._title = new St.Label({
                style_class: 'zappix-card-title',
                text: '',
            });
            titles.add_child(this._title);

            this._subtitle = new St.Label({
                style_class: 'zappix-card-subtitle',
                text: '',
            });
            titles.add_child(this._subtitle);

            this._refreshButton = new St.Button({
                style_class: 'zappix-icon-button',
                child: new St.Icon({
                    icon_name: 'view-refresh-symbolic',
                    style_class: 'zappix-icon-button-icon',
                }),
                can_focus: true,
                accessible_name: _('Refresh now'),
                reactive: true,
            });
            this._refreshButton.connect('clicked', () => this._onRefresh());
            this._header.add_child(this._refreshButton);
        }

        _buildScrollArea() {
            this._scroll = new St.ScrollView({
                style_class: 'zappix-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
                x_expand: true,
            });
            this.add_child(this._scroll);

            this._hostList = new St.BoxLayout({
                style_class: 'zappix-host-list',
                vertical: true,
                x_expand: true,
            });
            this._scroll.add_child(this._hostList);
        }

        _buildProblems() {
            this._problemsBox = new St.BoxLayout({
                style_class: 'zappix-problems',
                vertical: true,
                x_expand: true,
                visible: false,
            });
            this.add_child(this._problemsBox);
        }

        _buildFooter() {
            this._footer = new St.BoxLayout({
                style_class: 'zappix-card-footer',
                vertical: false,
                x_expand: true,
            });
            this.add_child(this._footer);

            this._updatedLabel = new St.Label({
                style_class: 'zappix-footer-label',
                text: '',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._footer.add_child(this._updatedLabel);

            this._openButton = new St.Button({
                style_class: 'zappix-link-button',
                child: new St.Label({
                    style_class: 'zappix-link-button-label',
                    text: _('Open Zabbix'),
                }),
                can_focus: true,
                reactive: true,
            });
            this._openButton.connect('clicked', () => this._onOpenFrontend());
            this._footer.add_child(this._openButton);
        }

        // ── update ──────────────────────────────────────────────────────────

        /**
         * Render a server snapshot.
         *
         * @param {object} snapshot
         * @param {object} [options]
         * @param {string} [options.density='comfortable']
         * @param {boolean} [options.reduceMotion=false]
         * @param {number} [options.nowSeconds]
         */
        update(snapshot, { density = 'comfortable', reduceMotion = false, nowSeconds } = {}) {
            this._density = density;
            this._reduceMotion = reduceMotion;
            this._now = nowSeconds ?? Date.now() / 1000;

            this._title.text = snapshot.label || _('Zabbix');
            this._subtitle.text = describeServer(snapshot, (singular, plural, count) =>
                ngettext(singular, plural, count),
            );

            this._applyHeaderState(snapshot);
            this._renderHosts(snapshot);
            this._renderProblems(snapshot);
            this._renderFooter(snapshot);
        }

        /**
         * @param {object} snapshot
         */
        _applyHeaderState(snapshot) {
            const severity =
                snapshot.status === SERVER_STATUS.ERROR
                    ? SEVERITY.CRIT
                    : (snapshot.worstSeverity ?? SEVERITY.OK);

            this._dot.setSeverity(severity);
            this._dot.setPulsing(snapshot.status === SERVER_STATUS.LOADING, this._reduceMotion);

            if (snapshot.status === SERVER_STATUS.ERROR) {
                this._subtitle.text = snapshot.error || _('Unreachable');
                this._subtitle.add_style_class_name('zappix-text-crit');
            } else {
                this._subtitle.remove_style_class_name('zappix-text-crit');
            }

            const busy = snapshot.status === SERVER_STATUS.LOADING;
            this._refreshButton.reactive = !busy;
            this._refreshButton.opacity = busy ? 120 : 255;
        }

        /**
         * @param {object} snapshot
         */
        _renderHosts(snapshot) {
            const visible = new Set();

            for (const host of snapshot.hosts ?? []) {
                visible.add(host.hostId);
                const section = this._hostSections.get(host.hostId);
                if (section) {
                    section.update(host, {
                        density: this._density,
                        reduceMotion: this._reduceMotion,
                    });
                } else {
                    const created = new HostSection(host, {
                        density: this._density,
                        reduceMotion: this._reduceMotion,
                    });
                    this._hostSections.set(host.hostId, created);
                    this._hostList.add_child(created);
                }
            }

            // Drop hosts the server no longer reports (removed, unmonitored, or
            // filtered out by a settings change).
            for (const [hostId, section] of [...this._hostSections]) {
                if (visible.has(hostId)) continue;
                section.destroy();
                this._hostSections.delete(hostId);
            }

            this._scroll.visible = visible.size > 0;
            this._applyScrollHeight();
        }

        /**
         * Cap the list height so a 20-host server cannot push the dropdown off
         * the screen. Recomputed on every update because card content height
         * changes with density and metric count.
         */
        _applyScrollHeight() {
            // The list may use whatever the popup can spare: the monitor, minus
            // the panel and the chrome around the list (header, card head,
            // problems, footer, padding). A flat 45 % of the monitor was not
            // enough for three rows of tiles on a short laptop screen and cut
            // the second row in half.
            const monitorHeight = Main.layoutManager?.primaryMonitor?.height ?? 1080;
            const panelHeight = Main.panel?.height ?? 32;
            // Header + card head + footer + popup padding. Deliberately tight:
            // this is what decides whether the last row of tiles is visible
            // without scrolling on a short screen.
            const chrome = 150;
            const limit = Math.max(
                180,
                Math.min(this._maxListHeight, monitorHeight - panelHeight - chrome),
            );

            // Measure the real content. The previous estimate assumed one row
            // of tiles per host (`hosts × sparkline + 74`), so with five metrics
            // — three rows — the view was given a third of the height it needed
            // and every tile was clipped just below its label.
            // Measure with a concrete width. `get_preferred_height(-1)` — the
            // documented "unconstrained" form — returns a sentinel (2^33) from
            // St in GNOME 46, which is why the old code trusted an estimate
            // instead and clipped every tile below its label.
            const width = this._scroll.width > 0 ? this._scroll.width : 0;
            const [, natural] = this._hostList.get_preferred_height(width);
            this._scroll.set_height(natural > 0 ? Math.min(natural, limit) : -1);
        }

        /**
         * @param {object} snapshot
         */
        _renderProblems(snapshot) {
            this._problemsBox.destroy_all_children();

            const problems = snapshot.problems?.items ?? [];
            if (problems.length === 0) {
                this._problemsBox.visible = false;
                return;
            }

            this._problemsBox.visible = true;

            for (const problem of problems.slice(0, MAX_PROBLEM_ROWS)) {
                const row = new St.BoxLayout({
                    style_class: 'zappix-problem-row',
                    vertical: false,
                    x_expand: true,
                });

                const pill = new St.Label({
                    style_class: `zappix-problem-pill ${severityClass(problem.severity)}`,
                    text: problem.acknowledged ? _('ACK') : _('NEW'),
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(pill);

                const name = new St.Label({
                    style_class: 'zappix-problem-name',
                    text: problem.name,
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(name);

                const time = new St.Label({
                    style_class: 'zappix-problem-time',
                    text: formatClockTime(problem.clock),
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(time);

                this._problemsBox.add_child(row);
            }

            const hidden = (snapshot.problems?.total ?? 0) - MAX_PROBLEM_ROWS;
            if (hidden > 0) {
                this._problemsBox.add_child(
                    new St.Label({
                        style_class: 'zappix-problem-more',
                        text: format(_('and {count} more'), { count: hidden }),
                    }),
                );
            }
        }

        /**
         * @param {object} snapshot
         */
        _renderFooter(snapshot) {
            if (snapshot.status === SERVER_STATUS.LOADING && !snapshot.fetchedAt) {
                this._updatedLabel.text = _('Connecting…');
                return;
            }

            if (!snapshot.fetchedAt) {
                this._updatedLabel.text = _('Never updated');
                return;
            }

            const relative = formatRelativeTime(snapshot.fetchedAt, this._now);
            const version = snapshot.version ? ` · Zabbix ${snapshot.version}` : '';
            this._updatedLabel.text = format(_('Updated {when}'), { when: relative }) + version;
        }
    },
);

/**
 * One host: a small identity row above its tile grid.
 *
 * Kept as its own class so the card can reconcile by host id instead of
 * rebuilding the grid on every poll.
 */
const HostSection = GObject.registerClass(
    {
        GTypeName: 'ZappixHostSection',
    },
    class HostSection extends St.BoxLayout {
        /**
         * @param {object} host normalised host snapshot
         * @param {object} options
         * @param {string} options.density
         * @param {boolean} options.reduceMotion
         */
        constructor(host, { density, reduceMotion }) {
            super({
                style_class: 'zappix-host',
                vertical: true,
                x_expand: true,
            });

            this._densityClass = density;

            const head = new St.BoxLayout({
                style_class: 'zappix-host-head',
                vertical: false,
                x_expand: true,
            });
            this.add_child(head);

            const identity = new St.BoxLayout({
                style_class: 'zappix-host-identity',
                vertical: false,
                x_expand: true,
            });
            head.add_child(identity);

            this._name = new St.Label({
                style_class: 'zappix-host-name',
                text: host.name,
                y_align: Clutter.ActorAlign.CENTER,
            });
            identity.add_child(this._name);

            this._endpoint = new St.Label({
                style_class: 'zappix-host-endpoint',
                text: host.endpoint,
                y_align: Clutter.ActorAlign.CENTER,
                visible: Boolean(host.endpoint),
            });
            identity.add_child(this._endpoint);

            this._dot = new StatusDot({ style_class: 'zappix-dot zappix-dot-small' });
            head.add_child(this._dot);

            this._tileRows = new St.BoxLayout({
                style_class: 'zappix-tile-rows',
                vertical: true,
                x_expand: true,
            });
            this.add_child(this._tileRows);

            /** @type {MetricTile[]} */
            this._tiles = [];

            this.update(host, { density, reduceMotion });
        }

        /**
         * @param {object} host
         * @param {object} options
         */
        update(host, { density, reduceMotion }) {
            this._name.text = host.name;
            this._endpoint.text = host.endpoint;
            this._endpoint.visible = Boolean(host.endpoint);

            // What the host dot means, most specific first. Staleness outranks
            // the interface flag because an active-only agent reports its
            // availability as Unknown even while data is flowing — the newest
            // reading is the only honest signal that collection still works.
            let severity = host.worstSeverity;
            let tooltip = '';

            if (host.maintenance) {
                severity = SEVERITY.MAINTENANCE;
                tooltip = _('In maintenance');
            } else if (host.availability === 'unavailable') {
                severity = SEVERITY.CRIT;
                tooltip = _('Agent unreachable');
            } else if (host.stale) {
                severity = SEVERITY.UNKNOWN;
                tooltip = _('No new data — the agent has stopped reporting');
            }

            this._dot.setSeverity(severity);
            this._dot.setTooltip(tooltip);

            const tokens = DENSITY_TOKENS[density] ?? DENSITY_TOKENS.comfortable;
            const metrics = host.metrics ?? [];

            const densityChanged = this._densityClass !== density;
            this._densityClass = density;

            this._ensureTileCount(metrics.length, tokens, densityChanged);
            metrics.forEach((metricView, index) => {
                this._tiles[index].update(metricView, {
                    reduceMotion,
                    height: tokens.sparklineHeight,
                });
            });
        }

        /**
         * Grow or shrink the tile list to match the enabled metric count.
         *
         * @param {number} count
         * @param {object} tokens density tokens
         * @param {boolean} [force=false] rebuild even when the count matches
         */
        _ensureTileCount(count, tokens, force = false) {
            if (force) {
                this._tileRows.destroy_all_children();
                this._tiles = [];
            }

            while (this._tiles.length > count) {
                const tile = this._tiles.pop();
                tile.destroy();
            }

            if (this._tiles.length === count) return;

            // Rebuild rows from scratch: tiles are cheap, and this only runs
            // when the user changes the metric selection.
            this._tileRows.destroy_all_children();
            this._tiles = [];

            let row = null;
            for (let index = 0; index < count; index++) {
                if (index % TILES_PER_ROW === 0) {
                    row = new St.BoxLayout({
                        style_class: 'zappix-tile-row',
                        vertical: false,
                        x_expand: true,
                    });
                    this._tileRows.add_child(row);
                }
                const tile = new MetricTile({
                    sparklineHeight: tokens.sparklineHeight,
                    style_class: `zappix-tile zappix-tile-${densityName(tokens)}`,
                });
                this._tiles.push(tile);
                row.add_child(tile);
            }

            // An odd tile count leaves the last row short; a spacer keeps the
            // remaining tiles at exactly half width instead of stretching.
            if (count % TILES_PER_ROW === 1 && row) {
                row.add_child(
                    new St.Widget({
                        style_class: 'zappix-tile-spacer',
                        x_expand: true,
                        x_align: Clutter.ActorAlign.FILL,
                    }),
                );
            }
        }
    },
);

/**
 * Density token → CSS modifier name.
 *
 * @param {object} tokens
 * @returns {string}
 */
function densityName(tokens) {
    if (tokens === DENSITY_TOKENS.compact) return 'compact';
    if (tokens === DENSITY_TOKENS.spacious) return 'spacious';
    return 'comfortable';
}
