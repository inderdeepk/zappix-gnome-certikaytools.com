// zabbixClient.js — per-server orchestration: auth, batching, retries, caching.
//
// One client instance owns exactly one server configuration. That boundary is
// deliberate: it means a server's session token, TLS policy and version cache
// can never leak into another server's requests, and destroying a card in
// preferences destroys everything it was holding.
//
// The public surface is task-shaped (`getHosts`, `getItems`, `getHistory`)
// rather than RPC-shaped (`request('host.get', …)`) so callers do not have to
// remember which fields each method needs or which value types may be batched
// together. `request` stays available for the preferences window's "test
// connection" probe.
//
// Shell-side module (uses Gio for cancellation); the pure wire-format work it
// delegates to `zabbixRpc` is unit-tested separately.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    buildBatch,
    buildHeaders,
    buildRequest,
    encodeRequest,
    ERROR_KIND,
    parseBatchResponse,
    parseResponse,
    RPC_ERROR,
    ZabbixError,
} from './zabbixRpc.js';
import {
    apiInfoVersion,
    groupItemsByValueType,
    historyGet,
    hostGet,
    itemGet,
    problemGet,
    userLogin,
    userLogout,
} from './zabbixMethods.js';
import { normaliseBaseUrl, usesModernLoginField, versionAtLeast } from './zabbixEndpoints.js';
import { ZabbixTransport } from './zabbixTransport.js';
import { debug, warn } from '../shared/log.js';

/** How many times a transient failure is retried before surfacing it. */
const MAX_RETRIES = 2;

/** Backoff between retries, in milliseconds. */
const RETRY_BACKOFF_MS = [250, 900];

/**
 * Client for one Zabbix server.
 */
export class ZabbixClient {
    /**
     * @param {object} options
     * @param {object} options.server sanitised server definition
     * @param {string} [options.secret] API token, or password in user mode
     * @param {string} [options.accessSecret] Cloudflare Access client secret
     * @param {number} [options.timeoutSeconds=10]
     * @param {number} [options.historyPoints=40] sparkline resolution
     * @param {ZabbixTransport} [options.transport] injectable for tests
     */
    constructor({
        server,
        secret = '',
        accessSecret = '',
        timeoutSeconds = 10,
        historyPoints = 40,
        transport,
    }) {
        this._server = server;
        this._secret = secret;
        this._accessSecret = accessSecret;
        // Set when a server rejects the deprecated `auth` body property even
        // though its version suggested it would accept it.
        this._suppressAuthField = false;
        this._historyPoints = Math.max(8, Math.floor(historyPoints));

        let endpoints;
        try {
            endpoints = normaliseBaseUrl(server.baseUrl);
        } catch (error) {
            throw new ZabbixError(error.message, { kind: ERROR_KIND.INVALID });
        }

        this._apiUrl = endpoints.apiUrl;
        this._frontendUrl = endpoints.frontendUrl;

        this._allowUntrustedTls = Boolean(server.allowUntrustedTls);
        this._transport =
            transport ??
            new ZabbixTransport({
                timeoutSeconds,
                allowUntrustedTls: this._allowUntrustedTls,
            });
        this._transport.timeoutSeconds = timeoutSeconds;

        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;

        /** @type {string} '' until `probe()` succeeds */
        this._version = '';
        /** @type {string} session token, user mode only */
        this._sessionId = '';

        this._nextId = 1;
    }

    /** @returns {string} */
    get apiUrl() {
        return this._apiUrl;
    }

    /** @returns {string} */
    get frontendUrl() {
        return this._frontendUrl;
    }

    /** @returns {string} `apiinfo.version` result, '' when unknown */
    get version() {
        return this._version;
    }

    /** @returns {string} */
    get serverId() {
        return this._server.id;
    }

    /**
     * Update the credential without rebuilding the client.
     *
     * @param {string} secret
     */
    set secret(secret) {
        if (secret === this._secret) return;
        this._secret = secret;
        // A new credential invalidates any session token minted with the old
        // one, and the version-independent auth style may change with it.
        this._sessionId = '';
    }

    /**
     * Update the Cloudflare Access client secret.
     *
     * @param {string} accessSecret
     */
    set accessSecret(accessSecret) {
        this._accessSecret = accessSecret;
    }

    /**
     * Apply a TLS policy change, dropping pooled connections.
     *
     * @param {boolean} allow
     */
    setAllowUntrustedTls(allow) {
        if (this._transport.allowUntrustedTls === Boolean(allow)) return;
        this._transport.abort();
        this._transport.allowUntrustedTls = allow;
        this._allowUntrustedTls = Boolean(allow);
    }

    /**
     * Detect the server version.
     *
     * `apiinfo.version` needs no authentication, so this doubles as a
     * reachability probe: if it answers, the URL is right and something is
     * listening, regardless of whether the token is valid.
     *
     * @returns {Promise<string>}
     */
    async probe() {
        const result = await this._sendRaw(apiInfoVersion(), { authenticated: false });
        this._version = String(result ?? '');
        debug(`server ${this._server.id} reports Zabbix ${this._version}`);
        return this._version;
    }

    /**
     * Verify the configuration end to end. Used by the preferences "Test"
     * button, so it returns a result object instead of throwing.
     *
     * @returns {Promise<{ok: boolean, version: string, hosts: number, error: string, kind: string}>}
     */
    async testConnection() {
        try {
            const version = await this.probe();
            const hostCall = hostGet({ limit: 1, version });
            const hosts = await this._sendRaw(hostCall);
            return {
                ok: true,
                version,
                hosts: Array.isArray(hosts) ? hosts.length : 0,
                error: '',
                kind: '',
            };
        } catch (error) {
            return {
                ok: false,
                version: this._version,
                hosts: 0,
                error: error instanceof Error ? error.message : String(error),
                kind: error instanceof ZabbixError ? error.kind : ERROR_KIND.SERVER,
            };
        }
    }

    /**
     * `host.get` — monitored hosts.
     *
     * @param {object} [options]
     * @param {number} [options.limit=20]
     * @param {string} [options.hostFilter='']
     * @returns {Promise<object[]>}
     */
    async getHosts({ limit = 20, hostFilter = '' } = {}) {
        const call = hostGet({ limit, hostFilter, version: this._version });
        const result = await this._sendRaw(call);
        return Array.isArray(result) ? result : [];
    }

    /**
     * `item.get` — resolve catalog metrics for a set of hosts.
     *
     * @param {object} options
     * @param {string[]} options.hostIds
     * @param {object[]} options.metrics catalog entries
     * @returns {Promise<object[]>}
     */
    async getItems({ hostIds, metrics }) {
        if (!hostIds || hostIds.length === 0) return [];
        const call = itemGet({ hostIds, metrics });
        const result = await this._sendRaw(call);
        return Array.isArray(result) ? result : [];
    }

    /**
     * `history.get` — sparkline series.
     *
     * Item ids are grouped by value type because Zabbix rejects a query that
     * mixes types; groups are then fetched in one batch so a card costs a
     * single round trip regardless of how many metrics it shows.
     *
     * @param {object} options
     * @param {Array<{itemid: string, value_type: string|number}>} options.items
     * @param {number} options.windowMinutes
     * @param {number} [options.nowSeconds]
     * @param {number} [options.maxRows=4000]
     * @returns {Promise<Array<{itemid: string, clock: string, value: string}>>}
     */
    async getHistory({ items, windowMinutes, nowSeconds = Date.now() / 1000, maxRows = 4000 }) {
        if (!items || items.length === 0) return [];

        const groups = groupItemsByValueType(items);
        if (groups.size === 0) return [];

        const timeTill = Math.floor(nowSeconds);
        const timeFrom = timeTill - Math.max(60, Math.floor(windowMinutes * 60));

        // Rows are capped globally; size the per-item budget from the number of
        // series so one busy metric cannot starve the others.
        const perMetricRows = Math.max(30, Math.floor(maxRows / Math.max(1, items.length)));

        const calls = [];
        for (const [valueType, itemIds] of groups) {
            calls.push(
                historyGet({
                    itemIds,
                    valueType,
                    timeFrom,
                    timeTill,
                    limit: Math.min(maxRows, perMetricRows * itemIds.length),
                }),
            );
        }

        const entries = await this.batch(calls);
        const rows = [];
        for (const entry of entries) {
            if (!entry.ok) {
                // A history failure must not blank the card: the headline
                // values already came from item.get.
                warn(`history query failed for ${this._server.id}`, entry.error?.message);
                continue;
            }
            if (Array.isArray(entry.result)) rows.push(...entry.result);
        }
        return rows;
    }

    /**
     * `problem.get` — open problems.
     *
     * @param {object} options
     * @param {string[]} options.hostIds
     * @param {number} [options.limit=50]
     * @returns {Promise<object[]>}
     */
    async getProblems({ hostIds, limit = 50 }) {
        if (!hostIds || hostIds.length === 0) return [];
        const call = problemGet({ hostIds, limit });
        const result = await this._sendRaw(call);
        return Array.isArray(result) ? result : [];
    }

    /**
     * Send a batch of method calls in one HTTP round trip.
     *
     * @param {Array<{method: string, params?: object}>} calls
     * @returns {Promise<Array<{ok: boolean, result?: any, error?: ZabbixError}>>}
     */
    async batch(calls) {
        if (!calls || calls.length === 0) return [];

        await this._ensureAuthenticated();

        const { payload, ids, methods } = buildBatch(calls, {
            sessionId: this._authFieldValue(),
            startId: this._takeIds(calls.length),
        });

        const text = await this._post(encodeRequest(payload));
        return parseBatchResponse(text, ids, methods);
    }

    /**
     * Send one method call.
     *
     * @param {string} method
     * @param {object} [params]
     * @returns {Promise<any>}
     */
    async request(method, params = {}) {
        return this._sendRaw({ method, params });
    }

    /**
     * Release every resource held by this client.
     */
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;

        if (this._sessionId) {
            // Best effort: the server expires sessions on its own, and a logout
            // failure must never block teardown.
            const call = userLogout();
            const sessionId = this._sessionId;
            this._sessionId = '';
            this._sendRaw(call, { sessionIdOverride: sessionId }).catch(() => {});
        }

        this._transport.abort();
        try {
            this._cancellable.cancel();
        } catch {
            // Already cancelled.
        }
    }

    // ── internals ───────────────────────────────────────────────────────────

    /**
     * Send one method call with auth, retries and cancellation.
     *
     * @param {{method: string, params: object}} call
     * @param {object} [options]
     * @param {boolean} [options.authenticated=true]
     * @param {string} [options.sessionIdOverride]
     * @returns {Promise<any>}
     */
    async _sendRaw(call, { authenticated = true, sessionIdOverride = '' } = {}) {
        if (this._destroyed) {
            throw new ZabbixError('The client has been shut down.', { kind: ERROR_KIND.NETWORK });
        }

        if (authenticated) await this._ensureAuthenticated();

        const sessionId = sessionIdOverride || this._authFieldValue();

        return this._withRetry(
            async () => {
                const envelope = buildRequest({
                    method: call.method,
                    params: call.params ?? {},
                    id: this._takeIds(1),
                    sessionId,
                });
                const text = await this._post(encodeRequest(envelope), {
                    suppressAuth: !authenticated,
                });
                return parseResponse(text, call.method);
            },
            call.method,
            authenticated,
        );
    }

    /**
     * Execute `operation`, retrying transient failures and one credential
     * refresh.
     *
     * @param {() => Promise<any>} operation
     * @param {string} method
     * @param {boolean} authenticated
     * @returns {Promise<any>}
     */
    async _withRetry(operation, method, authenticated) {
        let lastError = null;
        let authRetried = false;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;

                if (
                    error instanceof ZabbixError &&
                    error.kind === ERROR_KIND.AUTH &&
                    authenticated
                ) {
                    if (authRetried || this._server.authMode !== 'user') throw error;
                    // Session tokens expire; a password-mode server can mint a
                    // new one. Token-mode servers cannot recover here.
                    authRetried = true;
                    this._sessionId = '';
                    await this._ensureAuthenticated();
                    continue;
                }

                if (
                    error instanceof ZabbixError &&
                    error.kind === ERROR_KIND.INVALID &&
                    !this._suppressAuthField &&
                    /unexpected parameter ["']?auth/i.test(`${error.message} ${error.detail}`)
                ) {
                    // The server is stricter than its reported version implied.
                    // Drop the deprecated property and try once more.
                    this._suppressAuthField = true;
                    debug(
                        `${method}: server rejected the auth property; retrying with header only`,
                    );
                    continue;
                }

                const retryable = error instanceof ZabbixError && error.retryable;
                if (!retryable || attempt === MAX_RETRIES) throw error;

                const delay = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
                debug(`${method} failed (${error.message}); retrying in ${delay}ms`);
                await sleep(delay);
            }
        }

        throw lastError ?? new ZabbixError('Request failed.', { kind: ERROR_KIND.SERVER });
    }

    /**
     * Ensure a usable credential exists.
     *
     * Token mode needs nothing beyond the stored token; user mode needs a
     * session token, minted once and reused until it expires.
     *
     * @returns {Promise<void>}
     */
    async _ensureAuthenticated() {
        if (this._server.authMode !== 'user') {
            if (!this._secret) {
                throw new ZabbixError('No API token is stored for this server.', {
                    kind: ERROR_KIND.AUTH,
                });
            }
            return;
        }

        if (this._sessionId) return;

        const call = userLogin({
            username: this._server.username,
            password: this._secret,
            legacy: !usesModernLoginField(this._version),
        });

        const envelope = buildRequest({
            method: call.method,
            params: call.params,
            id: this._takeIds(1),
        });

        const text = await this._post(encodeRequest(envelope));
        const sessionId = parseResponse(text, call.method);

        if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new ZabbixError('Zabbix returned no session token.', {
                kind: ERROR_KIND.AUTH,
            });
        }

        this._sessionId = sessionId;
        debug(`server ${this._server.id} authenticated (session)`);
    }

    /**
     * Value for the deprecated top-level `auth` property, or '' to omit it.
     *
     * Three eras to satisfy:
     *   ≤ 6.2 — `auth` is the only mechanism, so a token-mode server must send
     *           its API token there (the header is ignored).
     *   6.4–7.0 — the property still works; sending the session token keeps
     *           servers with unusual header handling working.
     *   7.2+ — the property was removed and its presence is a strict-validation
     *           error, so it must never be sent.
     *
     * @returns {string}
     */
    _authFieldValue() {
        if (this._suppressAuthField) return '';

        const version = this._version;
        if (version && versionAtLeast(version, '7.2')) return '';
        if (!version || versionAtLeast(version, '6.4')) return this._sessionId;
        return this._sessionId || (this._server.authMode === 'user' ? '' : this._secret);
    }

    /**
     * One HTTP POST with the current headers.
     *
     * @param {string} body
     * @returns {Promise<string>}
     */
    async _post(body, { suppressAuth = false } = {}) {
        // `apiinfo.version` is defined as unauthenticated and 7.4 enforces it:
        // "The apiinfo.version method must be called without authorization
        // header." Cloudflare Access headers are not Zabbix credentials, so
        // they still travel with the probe.
        const headers = buildHeaders({
            apiToken:
                suppressAuth || this._server.authMode === 'user' ? '' : String(this._secret ?? ''),
            sessionId: suppressAuth ? '' : this._sessionId,
            accessClientId: this._server.accessClientId,
            accessClientSecret: this._accessSecret,
        });

        const response = await this._transport.post({
            url: this._apiUrl,
            body,
            headers,
            cancellable: this._cancellable,
        });

        return response.text;
    }

    /**
     * Allocate `count` request ids.
     *
     * @param {number} count
     * @returns {number}
     */
    _takeIds(count) {
        const first = this._nextId;
        this._nextId += Math.max(1, count);
        // Wrap well below the 2^31 limit; ids only need to be unique within a
        // batch, and wrapping avoids unbounded growth in a long-lived session.
        if (this._nextId > 1_000_000) this._nextId = 1;
        return first;
    }
}

/**
 * Sleep without blocking the shell's main loop.
 *
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function sleep(milliseconds) {
    return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.floor(milliseconds)), () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/** Re-exported so prefs can branch on the same codes without importing two modules. */
export { ERROR_KIND, RPC_ERROR };
