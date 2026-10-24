// poller.js — the monitoring engine that drives every server.
//
// Responsibilities, and nothing else:
//   • own one ZabbixClient per configured server (and tear them down);
//   • drive the per-server refresh timer with exponential backoff;
//   • hold the latest snapshot per server;
//   • tell the UI once whenever state changes.
//
// It is intentionally not a widget and not a UI observer: the indicator calls
// `getSnapshots()` and redraws, which keeps paint order out of the polling
// layer and makes "open the menu" a data request rather than a rendering
// side-effect.
//
// Shell-side module (Gio/GLib timers).

import GLib from 'gi://GLib';

import { ZabbixClient } from '../api/zabbixClient.js';
import { POLL_MODE, pollServer } from './serverPoller.js';
import {
    failureSnapshot,
    initialSnapshot,
    SERVER_STATUS,
    successSnapshot,
} from './snapshotStore.js';
import { nextDelaySeconds } from './backoff.js';
import { enabledServers } from '../shared/serverStore.js';
import { debug, error, info, warn } from '../shared/log.js';

/** Guard: one in-flight poll per server, and one pending timer per server. */
export class MonitorService {
    /**
     * @param {object} options
     * @param {import('../shared/settings.js').ZappixSettings} options.settings
     * @param {import('../shared/secrets.js').SecretStore} options.secrets
     * @param {(reason: string) => void} options.onChange
     */
    constructor({ settings, secrets, onChange }) {
        this._settings = settings;
        this._secrets = secrets;
        this._onChange = onChange;

        /** @type {Map<string, object>} */
        this._snapshots = new Map();
        /** @type {Map<string, ZabbixClient>} */
        this._clients = new Map();
        /** @type {Map<string, number>} */
        this._timers = new Map();
        /** @type {Set<string>} */
        this._inFlight = new Set();
        /** @type {Map<string, number>} */
        this._failures = new Map();

        this._destroyed = false;
        /** Full polling is enabled while a human can see the sparklines. */
        this._wantFullDepth = false;
    }

    /** @returns {object[]} snapshots in configured server order */
    getSnapshots() {
        const byServer = new Map(this._snapshots);
        return enabledServers(this._settings.servers)
            .map((server) => byServer.get(server.id))
            .filter(Boolean);
    }

    /**
     * @param {string} serverId
     * @returns {object|null}
     */
    getSnapshot(serverId) {
        return this._snapshots.get(serverId) ?? null;
    }

    /** @returns {boolean} */
    get isRunning() {
        return !this._destroyed;
    }

    /**
     * Rebuild clients from settings and start polling.
     *
     * Idempotent: calling it again reconciles (adding, removing, re-keying
     * servers) instead of duplicating timers.
     *
     * @returns {Promise<void>}
     */
    async start() {
        if (this._destroyed) return;
        await this.reconfigure();

        // Reconfiguring only builds clients; something has to make the first
        // request. Saving a server took care of that through the settings
        // handler, so a session that *starts* with servers already configured —
        // every login, every shell restart — polled nothing at all and left the
        // panel on "Connecting…" until the menu was opened by hand.
        await this.refresh();
    }

    /**
     * Reconcile clients and snapshots with the current settings.
     *
     * @returns {Promise<void>}
     */
    async reconfigure() {
        if (this._destroyed) return;

        const servers = enabledServers(this._settings.servers);
        const wanted = new Set(servers.map((server) => server.id));

        // Remove clients for servers that disappeared or were disabled.
        for (const [serverId, client] of [...this._clients]) {
            if (wanted.has(serverId)) continue;
            this._clearTimer(serverId);
            client.destroy();
            this._clients.delete(serverId);
            this._snapshots.delete(serverId);
            this._failures.delete(serverId);
        }

        // Seed snapshots so the UI can render "loading" immediately rather than
        // an empty gap while the first poll is in flight.
        for (const server of servers) {
            if (!this._snapshots.has(server.id)) {
                this._snapshots.set(server.id, initialSnapshot(server));
            } else {
                const snapshot = this._snapshots.get(server.id);
                this._snapshots.set(server.id, {
                    ...snapshot,
                    label: server.label,
                    colour: server.colour,
                    baseUrl: server.baseUrl,
                });
            }
        }

        await Promise.all(servers.map((server) => this._ensureClient(server)));

        this._onChange('reconfigure');
    }

    /**
     * Create or update the client for one server.
     *
     * @param {object} server
     * @returns {Promise<void>}
     */
    async _ensureClient(server) {
        let secret = '';
        let accessSecret = '';
        try {
            secret = await this._secrets.lookup(server.secretRef);
            // Only looked up when the server actually uses Cloudflare Access,
            // so the common case stays one keyring round trip.
            if (server.accessClientId) {
                accessSecret = await this._secrets.lookup(server.accessSecretRef);
            }
        } catch (lookupError) {
            warn(`cannot read credential for ${server.id}`, lookupError?.message);
        }

        const existing = this._clients.get(server.id);

        if (existing) {
            existing.secret = secret;
            existing.accessSecret = accessSecret;
            existing.setAllowUntrustedTls(server.allowUntrustedTls || this._settings.insecureTls);
            return;
        }

        if (!secret) {
            this._snapshots.set(server.id, {
                ...initialSnapshot(server),
                status: SERVER_STATUS.UNCONFIGURED,
                error: 'No API token stored. Open Preferences to add one.',
            });
            return;
        }

        if (server.accessClientId && !accessSecret) {
            // Half a service token is worse than none: Cloudflare answers with
            // an HTML login page, which surfaces as "the server did not return
            // JSON" three layers away from the actual cause.
            this._snapshots.set(server.id, {
                ...initialSnapshot(server),
                status: SERVER_STATUS.UNCONFIGURED,
                error: 'Cloudflare Access client id is set but its secret is missing. Edit the server and paste the client secret.',
            });
            return;
        }

        try {
            const client = new ZabbixClient({
                server: {
                    ...server,
                    allowUntrustedTls: server.allowUntrustedTls || this._settings.insecureTls,
                },
                secret,
                accessSecret,
                timeoutSeconds: this._settings.timeoutSeconds,
            });
            this._clients.set(server.id, client);
        } catch (creationError) {
            this._snapshots.set(server.id, {
                ...initialSnapshot(server),
                status: SERVER_STATUS.ERROR,
                error: creationError?.message ?? String(creationError),
            });
            error(`cannot create client for ${server.id}`, creationError);
        }
    }

    /**
     * Refresh one server, or all of them, right now.
     *
     * Used by the menu-open path, the manual refresh button and the preferences
     * "test" flow. Never overlaps an in-flight poll of the same server.
     *
     * @param {object} [options]
     * @param {string} [options.serverId]
     * @param {string} [options.mode]
     * @returns {Promise<void>}
     */
    async refresh({ serverId = '', mode = '' } = {}) {
        if (this._destroyed) return;

        const depth = mode || (this._wantFullDepth ? POLL_MODE.FULL : POLL_MODE.PANEL);
        const servers = enabledServers(this._settings.servers).filter(
            (server) => !serverId || server.id === serverId,
        );

        await Promise.all(
            servers.map((server) => this._pollOnce(server, depth, { reschedule: true })),
        );
    }

    /**
     * Turn sparkline fetching on or off.
     *
     * The dropdown calls this on open/close. Switching to full depth triggers
     * an immediate full refresh so the curves are there on the first paint.
     *
     * @param {boolean} full
     */
    setFullDepth(full) {
        const next = Boolean(full);
        if (next === this._wantFullDepth) return;
        this._wantFullDepth = next;
        if (next) this.refresh({ mode: POLL_MODE.FULL }).catch(() => {});
    }

    /**
     * Stop every timer and release every client.
     */
    stop() {
        if (this._destroyed) return;
        this._destroyed = true;

        for (const serverId of [...this._timers.keys()]) this._clearTimer(serverId);
        for (const client of this._clients.values()) client.destroy();
        this._clients.clear();
        this._inFlight.clear();
        this._snapshots.clear();
        this._failures.clear();
        debug('monitor stopped');
    }

    // ── internals ───────────────────────────────────────────────────────────

    /**
     * Perform one poll, update the snapshot, then schedule the next attempt.
     *
     * @param {object} server
     * @param {string} mode
     * @param {object} [options]
     * @param {boolean} [options.reschedule=false]
     * @returns {Promise<void>}
     */
    async _pollOnce(server, mode, { reschedule = false } = {}) {
        const client = this._clients.get(server.id);
        if (!client) return;
        if (this._inFlight.has(server.id)) return;

        this._inFlight.add(server.id);

        try {
            const payload = await pollServer({
                client,
                server,
                metrics: this._settings.enabledMetrics,
                thresholds: this._settings.thresholds,
                maxHosts: this._settings.maxHostsPerServer,
                historyWindowMinutes: this._settings.historyWindowMinutes,
                mode,
            });

            const snapshot = successSnapshot({
                server,
                hosts: payload.hosts,
                problems: payload.problems,
                version: payload.version,
                fetchedAt: Date.now() / 1000,
            });

            this._snapshots.set(server.id, snapshot);
            this._failures.set(server.id, 0);
            this._onChange('poll-ok');
        } catch (pollError) {
            const previous = this._snapshots.get(server.id) ?? initialSnapshot(server);
            const failures = (this._failures.get(server.id) ?? 0) + 1;
            this._failures.set(server.id, failures);

            this._snapshots.set(
                server.id,
                failureSnapshot(previous, {
                    message: pollError?.message ?? String(pollError),
                    kind: pollError?.kind ?? '',
                    fetchedAt: Date.now() / 1000,
                }),
            );

            debug(`poll failed for ${server.id} (${failures})`, pollError?.message);
            this._onChange('poll-error');
        } finally {
            this._inFlight.delete(server.id);
            if (reschedule && !this._destroyed) {
                const delay = nextDelaySeconds({
                    baseSeconds: this._settings.pollIntervalSeconds,
                    consecutiveFailures: this._failures.get(server.id) ?? 0,
                });
                this._schedule(server.id, delay);
            }
        }
    }

    /**
     * (Re)arm the timer for one server.
     *
     * @param {string} serverId
     * @param {number} delaySeconds
     */
    _schedule(serverId, delaySeconds) {
        this._clearTimer(serverId);

        const sourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.round(delaySeconds)) * 1000,
            () => {
                this._timers.delete(serverId);
                const server = enabledServers(this._settings.servers).find(
                    (entry) => entry.id === serverId,
                );
                if (server && !this._destroyed) {
                    const mode = this._wantFullDepth ? POLL_MODE.FULL : POLL_MODE.PANEL;
                    this._pollOnce(server, mode, { reschedule: true }).catch(() => {});
                }
                return GLib.SOURCE_REMOVE;
            },
        );

        this._timers.set(serverId, sourceId);
    }

    /**
     * @param {string} serverId
     */
    _clearTimer(serverId) {
        const sourceId = this._timers.get(serverId);
        if (!sourceId) return;
        try {
            GLib.source_remove(sourceId);
        } catch {
            // Already fired or removed.
        }
        this._timers.delete(serverId);
    }

    /**
     * Log a one-line summary of the current state. Used by `make logs` checks
     * and the journal on enable.
     */
    logSummary() {
        const snapshots = this.getSnapshots();
        info(
            `monitoring ${snapshots.length} server(s)`,
            snapshots.map((snapshot) => `${snapshot.label}=${snapshot.status}`).join(', '),
        );
    }
}
