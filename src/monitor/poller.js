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
    credentialWaitSnapshot,
    failureSnapshot,
    initialSnapshot,
    SERVER_STATUS,
    successSnapshot,
} from './snapshotStore.js';
import { nextDelaySeconds } from './backoff.js';
import { enabledServers } from '../shared/serverStore.js';
import { debug, error, info } from '../shared/log.js';

/**
 * Do not read the credential twice in one refresh burst.
 *
 * Startup reconciles (reads credentials) and then polls; without this guard a
 * server whose keyring lookup just failed would pay the 15 s keyring timeout a
 * second time before the poller's own retry loop took over.
 */
const CREDENTIAL_RECHECK_MS = 5000;

/**
 * Retry pacing while a server has no usable credential. Deliberately faster
 * than the poll interval: a locked keyring usually unlocks within seconds of
 * login, and the panel should recover on its own rather than sit on
 * "Not configured" until the next shell restart.
 */
const CREDENTIAL_RETRY_BASE_SECONDS = 15;
const CREDENTIAL_RETRY_CEILING_SECONDS = 120;

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
        /** @type {Map<string, Promise<void>>} in-flight credential/client builds */
        this._ensurePromises = new Map();
        /** @type {Map<string, number>} last credential read, in ms since epoch */
        this._credentialCheckedAt = new Map();

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
            this._ensurePromises.delete(serverId);
            this._credentialCheckedAt.delete(serverId);
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
     * Create or update the client for one server, de-duplicating concurrent
     * calls.
     *
     * `reconfigure()` and an in-flight poll can ask for the same server at the
     * same time; without this the credential would be read twice and two
     * clients could race into `_clients`.
     *
     * @param {object} server
     * @returns {Promise<void>}
     */
    _ensureClient(server) {
        const pending = this._ensurePromises.get(server.id);
        if (pending) return pending;

        let promise;
        promise = this._buildClient(server).finally(() => {
            if (this._ensurePromises.get(server.id) === promise) {
                this._ensurePromises.delete(server.id);
            }
        });
        this._ensurePromises.set(server.id, promise);
        return promise;
    }

    /**
     * Read credentials and create or update the client for one server.
     *
     * A credential read that fails because the keyring is unavailable is *not*
     * treated as "no token": the server keeps its existing client (if any), or
     * is left in the connecting state so the next poll retries. Only a lookup
     * that positively reports "nothing stored" produces UNCONFIGURED.
     *
     * @param {object} server
     * @returns {Promise<void>}
     */
    async _buildClient(server) {
        this._credentialCheckedAt.set(server.id, Date.now());

        let secret = '';
        let accessSecret = '';
        let unavailable = null;
        try {
            secret = await this._secrets.lookup(server.secretRef);
            // Only looked up when the server actually uses Cloudflare Access,
            // so the common case stays one keyring round trip.
            if (server.accessClientId) {
                accessSecret = await this._secrets.lookup(server.accessSecretRef);
            }
        } catch (lookupError) {
            unavailable = lookupError;
        }

        const existing = this._clients.get(server.id);

        if (existing) {
            if (unavailable) {
                // Hold on to the credential the client already authenticated
                // with; wiping it over a transient keyring failure would turn
                // a working server into an authentication error.
                debug(`keeping cached credential for ${server.id}: ${unavailable.message}`);
                return;
            }
            existing.secret = secret;
            existing.accessSecret = accessSecret;
            existing.setAllowUntrustedTls(server.allowUntrustedTls || this._settings.insecureTls);
            return;
        }

        if (unavailable) {
            this._snapshots.set(
                server.id,
                credentialWaitSnapshot(
                    this._snapshots.get(server.id) ?? initialSnapshot(server),
                    'Waiting for the login keyring…',
                ),
            );
            debug(`credential unavailable for ${server.id}: ${unavailable.message}`);
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
        if (next) this.refresh({ mode: POLL_MODE.FULL }).catch(() => { });
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
        this._ensurePromises.clear();
        this._credentialCheckedAt.clear();
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
        if (this._inFlight.has(server.id)) return;

        this._inFlight.add(server.id);

        // Set when this attempt could not build a client; the `finally` block
        // then uses the credential retry cadence instead of the poll interval.
        let credentialRetryDelay = null;

        try {
            let client = this._clients.get(server.id);

            // A server whose credential could not be read at startup (locked
            // keyring, login race, timed-out prompt) has no client at all. The
            // old code returned here forever, so "Not configured" survived
            // until the shell restarted. Re-running the lookup on every poll is
            // what makes the panel recover on its own.
            if (!client && !this._credentialRecentlyChecked(server.id)) {
                await this._ensureClient(server);
                client = this._clients.get(server.id);
            }

            if (!client) {
                this._failures.set(server.id, (this._failures.get(server.id) ?? 0) + 1);
                credentialRetryDelay = nextDelaySeconds({
                    baseSeconds: CREDENTIAL_RETRY_BASE_SECONDS,
                    consecutiveFailures: this._failures.get(server.id) ?? 1,
                    ceilingSeconds: CREDENTIAL_RETRY_CEILING_SECONDS,
                    jitterRatio: 0,
                });
                this._onChange('credential-wait');
                return;
            }

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
                const delay =
                    credentialRetryDelay ??
                    nextDelaySeconds({
                        baseSeconds: this._settings.pollIntervalSeconds,
                        consecutiveFailures: this._failures.get(server.id) ?? 0,
                    });
                this._schedule(server.id, delay);
            }
        }
    }

    /**
     * Has the credential been read so recently that another attempt would just
     * repeat the same failure? Guards the startup reconcile + first poll burst.
     *
     * @param {string} serverId
     * @returns {boolean}
     */
    _credentialRecentlyChecked(serverId) {
        const checkedAt = this._credentialCheckedAt.get(serverId);
        return Boolean(checkedAt) && Date.now() - checkedAt < CREDENTIAL_RECHECK_MS;
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
                    this._pollOnce(server, mode, { reschedule: true }).catch(() => { });
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
