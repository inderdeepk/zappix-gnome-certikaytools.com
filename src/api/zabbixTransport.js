// zabbixTransport.js — the only module that performs network I/O.
//
// Everything above it speaks in "send this JSON-RPC payload, give me the body
// and the status". Keeping the Soup details here means the client logic can be
// reasoned about (and unit-tested) without a socket, and that the two escape
// hatches GNOME users need — a self-signed certificate and a slow VPN — are
// implemented exactly once.
//
// Shell-side module: imports Soup 3.0 through GJS, excluded from the plain-gjs
// import smoke test.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import { ZabbixError, ERROR_KIND } from './zabbixRpc.js';
import {
    ACCESS_MESSAGE,
    ACCESS_REJECTED_MESSAGE,
    describeAccessAnswer,
    describeHttpStatus,
    looksLikeAccessChallenge,
    looksLikeHtml,
    looksLikeJson,
} from './zabbixResponse.js';
import { debug } from '../shared/log.js';

/** Sent so a Zabbix administrator can attribute traffic to this extension. */
const USER_AGENT = 'Zappix/1.0 (GNOME Shell)';

/**
 * First value of a response header, or ''.
 *
 * @param {Soup.Message} message
 * @param {string} name
 * @returns {string}
 */
function firstHeader(message, name) {
    try {
        return message.response_headers.get_one(name) ?? '';
    } catch {
        return '';
    }
}

/**
 * Thin async wrapper around a Soup session.
 *
 * One instance per server is created by the client and destroyed with it, so
 * connection pools never outlive the server configuration they belong to — a
 * repointed server cannot inherit the previous TLS state.
 */
export class ZabbixTransport {
    /**
     * @param {object} options
     * @param {number} [options.timeoutSeconds=10]
     * @param {boolean} [options.allowUntrustedTls=false]
     */
    constructor({ timeoutSeconds = 10, allowUntrustedTls = false } = {}) {
        // libsoup 3 negotiates HTTP/1.1 or HTTP/2 automatically and exposes no
        // switch to force one; a poll is a handful of small JSON requests, so
        // either is fine.
        this._session = new Soup.Session({
            user_agent: USER_AGENT,
            timeout: Math.max(1, Math.floor(timeoutSeconds)),
        });

        this._allowUntrustedTls = Boolean(allowUntrustedTls);
        this._acceptCertificateId = 0;

        if (this._allowUntrustedTls) {
            // libsoup 3 exposes the TLS decision as a signal. Returning true
            // accepts the certificate for *this* session only; the global
            // certificate database is never modified.
            this._acceptCertificateId = this._session.connect('accept-certificate', () => true);
        }
    }

    /** @returns {boolean} */
    get allowUntrustedTls() {
        return this._allowUntrustedTls;
    }

    /**
     * Per-request timeout, in seconds. Applied to the whole session, which is
     * what libsoup offers; a poll is a handful of short requests, so a single
     * value is the right granularity.
     *
     * @returns {number}
     */
    get timeoutSeconds() {
        return this._session.timeout;
    }

    /**
     * @param {number} seconds
     */
    set timeoutSeconds(seconds) {
        const next = Math.max(1, Math.floor(Number(seconds) || 10));
        if (next === this._session.timeout) return;
        this._session.timeout = next;
    }

    /**
     * Toggle certificate tolerance without rebuilding the session.
     *
     * @param {boolean} allow
     */
    set allowUntrustedTls(allow) {
        const next = Boolean(allow);
        if (next === this._allowUntrustedTls) return;

        if (next) {
            this._acceptCertificateId = this._session.connect('accept-certificate', () => true);
        } else if (this._acceptCertificateId) {
            this._session.disconnect(this._acceptCertificateId);
            this._acceptCertificateId = 0;
        }
        this._allowUntrustedTls = next;
    }

    /**
     * POST a JSON body and return the raw response.
     *
     * HTTP error statuses are returned, not thrown: Zabbix answers API-level
     * errors with 200, so a 4xx/5xx always means something in front of the API
     * (proxy, tunnel, WAF) answered instead, and the caller needs the body to
     * explain that.
     *
     * @param {object} options
     * @param {string} options.url
     * @param {string} options.body
     * @param {Record<string,string>} options.headers
     * @param {Gio.Cancellable} [options.cancellable]
     * @returns {Promise<{status:number, text:string}>}
     * @throws {ZabbixError} with kind NETWORK on transport failure
     */
    async post({ url, body, headers, cancellable = null }) {
        const message = Soup.Message.new('POST', url);
        if (!message) {
            throw new ZabbixError('The server URL could not be parsed.', {
                kind: ERROR_KIND.INVALID,
            });
        }

        for (const [name, value] of Object.entries(headers ?? {})) {
            message.request_headers.append(name, value);
        }
        message.request_headers.append('Accept', 'application/json-rpc');

        const payload = new TextEncoder().encode(body);
        message.set_request_body_from_bytes('application/json-rpc', new GLib.Bytes(payload));

        debug(`POST ${url}`);

        let bytes;
        try {
            bytes = await this._sessionSendAndRead(message, cancellable);
        } catch (error) {
            throw toTransportError(error, url);
        }

        const status = message.status_code;
        const text = bytes ? new TextDecoder().decode(bytes.toArray()) : '';
        const location = firstHeader(message, 'location');
        const cfMitigated = firstHeader(message, 'cf-mitigated');
        const sentToken = Boolean(headers?.['CF-Access-Client-Id']);

        // An identity check is not an outage, and its status code is whatever
        // the proxy felt like sending. Detect it before anything else so the
        // user is told to configure a service token instead of hunting for a
        // Zabbix fault that does not exist.
        if (
            looksLikeAccessChallenge({ status, text, location, cfMitigated }) ||
            cfMitigated.toLowerCase() === 'challenge'
        ) {
            // A token that was sent and still refused means the policy does not
            // include it; "create a token" would be wrong advice by now.
            const message =
                (sentToken ? ACCESS_REJECTED_MESSAGE : ACCESS_MESSAGE) +
                describeAccessAnswer({ status, location, cfMitigated });

            debug(`Cloudflare challenge (HTTP ${status}) from ${url}, token sent: ${sentToken}`);
            throw new ZabbixError(message, {
                kind: ERROR_KIND.HTTP,
                code: status,
                detail: `${location} ${text.slice(0, 300)}`.trim(),
            });
        }

        if (status !== Soup.Status.OK) {
            debug(`HTTP ${status} from ${url}: ${text.slice(0, 200)}`);

            // Cloudflare also refuses with a bare 401/403 and no redirect when
            // an Access app is "deny" rather than "redirect", or when a WAF
            // rule fires. Every response through the edge carries cf-ray, and
            // the origin always answers JSON, so a non-JSON 401/403 with a ray
            // id is the edge talking — not a bad Zabbix token.
            const cfRay = firstHeader(message, 'cf-ray');
            if (cfRay && (status === 401 || status === 403) && !looksLikeJson(text)) {
                const message =
                    (sentToken ? ACCESS_REJECTED_MESSAGE : ACCESS_MESSAGE) +
                    describeAccessAnswer({ status, location, cfMitigated });
                debug(`edge refused the request (cf-ray ${cfRay})`);
                throw new ZabbixError(message, {
                    kind: ERROR_KIND.HTTP,
                    code: status,
                    detail: `cf-ray: ${cfRay}${location ? ` location: ${location}` : ''}`,
                });
            }

            throw new ZabbixError(describeHttpStatus(status, text, { location }), {
                kind: ERROR_KIND.HTTP,
                code: status,
                detail: text.slice(0, 400),
            });
        }

        // Zabbix answers /api_jsonrpc.php with JSON even when it is unhappy.
        // HTML at this point means an intermediary replaced the response, and
        // a JSON parse error would send the user looking in the wrong place.
        if (looksLikeHtml(text)) {
            debug(`HTML instead of JSON from ${url}`);
            throw new ZabbixError(
                'The server returned a web page instead of an API response. ' +
                    'An SSO login, a reverse-proxy error page or a wrong base URL ' +
                    'is intercepting the request.',
                { kind: ERROR_KIND.HTTP, code: status, detail: text.slice(0, 400) },
            );
        }

        return { status, text };
    }

    /**
     * Promisify `send_and_read_async`.
     *
     * @param {Soup.Message} message
     * @param {Gio.Cancellable|null} cancellable
     * @returns {Promise<GLib.Bytes|null>}
     */
    _sessionSendAndRead(message, cancellable) {
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (session, result) => {
                    try {
                        resolve(session.send_and_read_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                },
            );
        });
    }

    /**
     * Drop pooled connections.
     *
     * Called when a server's TLS policy changes so the next request performs a
     * fresh handshake against the new policy.
     */
    abort() {
        try {
            this._session.abort();
        } catch {
            // Session already torn down.
        }
    }
}

/**
 * Map a GJS/Soup failure onto the client's error taxonomy.
 *
 * @param {unknown} error
 * @param {string} url
 * @returns {ZabbixError}
 */
function toTransportError(error, url) {
    const messages = collectMessages(error);
    const joined = messages.join(' ').toLowerCase();

    if (joined.includes('cancel') || joined.includes('operation was cancelled')) {
        return new ZabbixError('Request cancelled.', {
            kind: ERROR_KIND.NETWORK,
            code: 0,
            retryable: false,
        });
    }

    if (
        joined.includes('certificate') ||
        joined.includes('tls') ||
        joined.includes('ssl') ||
        joined.includes('handshake')
    ) {
        return new ZabbixError(
            'The TLS certificate was rejected. Fix the server certificate, or allow untrusted certificates for this server.',
            { kind: ERROR_KIND.NETWORK, detail: messages.join(' ') },
        );
    }

    if (joined.includes('name or service not known') || joined.includes('resolve')) {
        return new ZabbixError(`Could not resolve ${url}.`, {
            kind: ERROR_KIND.NETWORK,
            detail: messages.join(' '),
        });
    }

    if (joined.includes('connection refused') || joined.includes('network is unreachable')) {
        return new ZabbixError('The Zabbix server refused the connection.', {
            kind: ERROR_KIND.NETWORK,
            detail: messages.join(' '),
        });
    }

    if (joined.includes('timed out') || joined.includes('timeout')) {
        return new ZabbixError('The Zabbix server did not answer in time.', {
            kind: ERROR_KIND.NETWORK,
            detail: messages.join(' '),
        });
    }

    return new ZabbixError('Could not reach the Zabbix server.', {
        kind: ERROR_KIND.NETWORK,
        detail: messages.join(' ') || String(error),
    });
}

/** GLib.Error nests a domain and a message; both matter when classifying. */
function collectMessages(error) {
    if (!error) return [];
    if (error instanceof Error) return [error.message];
    const message = typeof error.message === 'string' ? error.message : '';
    return [message].filter(Boolean);
}

/**
 * Is this error worth retrying with backoff?
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryableTransportError(error) {
    return error instanceof ZabbixError && error.retryable;
}
