// zabbixRpc.js — Zabbix JSON-RPC 2.0 wire format, in pure JavaScript.
//
// This module owns everything about the *shape* of a Zabbix API conversation:
// building the request envelope, serialising it, and turning a response body
// into either a value or a typed error. It performs no I/O, imports no GI
// modules, and is therefore exercised directly by the unit tests under plain
// `gjs` — the same split the transport layer relies on to stay thin.
//
// Zabbix speaks JSON-RPC 2.0 with a couple of deviations that matter here:
//   • Requests carry an `id` that the caller correlates with the response; the
//     server echoes it back verbatim.
//   • A batch request is a JSON *array* of envelopes. Zabbix answers a batch
//     with an array in the same order, which is what makes a single round trip
//     able to fetch hosts, items and history for a whole server.
//   • Errors are always returned with HTTP 200. A non-2xx status is a proxy or
//     TLS failure, not an API error, so the two are classified differently.
//   • Authentication is either a session token from `user.login` carried in the
//     deprecated `auth` body field, or an API token carried in an
//     `Authorization: Bearer …` header. Zabbix 7.0+ rejects `auth` for API
//     tokens, so the header is the portable choice and the default here.

/** Protocol-level error codes that Zabbix reuses from JSON-RPC. */
export const RPC_ERROR = Object.freeze({
    PARSE: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL: -32603,
    APPLICATION: -32500,
    // Zabbix's own "not authorised / session terminated" family.
    UNAUTHORISED: -32400,
});

/**
 * Error taxonomy. Callers branch on `kind` rather than on numeric codes so
 * that a Zabbix version bump cannot silently change UI behaviour.
 *
 *   auth        — credentials rejected, or the session/token expired
 *   permission  — authenticated but not allowed (RBAC, read-only token)
 *   invalid     — the request we built was wrong (a bug, or a version gap)
 *   notfound    — method missing (server too old) or object removed
 *   network     — transport failed before an API answer arrived
 *   http        — a proxy/gateway/tunnel answered instead of the API
 *   protocol    — the body was not a JSON-RPC response
 *   server      — any other server-side failure
 */
export const ERROR_KIND = Object.freeze({
    AUTH: 'auth',
    PERMISSION: 'permission',
    INVALID: 'invalid',
    NOTFOUND: 'notfound',
    NETWORK: 'network',
    HTTP: 'http',
    PROTOCOL: 'protocol',
    SERVER: 'server',
});

/** Typed failure raised by every layer of the Zabbix client. */
export class ZabbixError extends Error {
    /**
     * @param {string} message human-readable, already safe to show in the UI
     * @param {object} [options]
     * @param {string} [options.kind] one of ERROR_KIND
     * @param {number|null} [options.code] JSON-RPC / HTTP status code
     * @param {string} [options.detail] server-supplied `error.data`
     * @param {string} [options.method] API method that failed
     * @param {boolean} [options.retryable] safe to retry without user action
     */
    constructor(
        message,
        { kind = ERROR_KIND.SERVER, code = null, detail = '', method = '', retryable } = {},
    ) {
        super(message);
        this.name = 'ZabbixError';
        this.kind = kind;
        this.code = code;
        this.detail = detail;
        this.method = method;
        this.retryable = retryable ?? isRetryableKind(kind);
    }
}

/** Transport hiccups and 5xx answers are worth retrying; auth/4xx are not. */
function isRetryableKind(kind) {
    return kind === ERROR_KIND.NETWORK || kind === ERROR_KIND.HTTP;
}

/**
 * Map a Zabbix error payload onto the taxonomy.
 *
 * Both `code` and the human text are inspected: older Zabbix servers answer
 * "Session terminated, re-login, please." with the generic -32500 application
 * code, so code alone is not enough to recognise an expired session.
 *
 * @param {{code?: number, message?: string, data?: string}} error
 * @returns {{kind: string, message: string, code: number|null, detail: string}}
 */
export function classifyRpcError(error) {
    const code = typeof error?.code === 'number' ? error.code : null;
    const message = typeof error?.message === 'string' ? error.message : '';
    const detail = typeof error?.data === 'string' ? error.data : '';
    const haystack = `${message} ${detail}`.toLowerCase();

    if (code === RPC_ERROR.UNAUTHORISED) {
        return { kind: ERROR_KIND.AUTH, message, code, detail };
    }

    if (
        haystack.includes('not authorised') ||
        haystack.includes('not authorized') ||
        haystack.includes('session terminated') ||
        haystack.includes('re-login') ||
        haystack.includes('login name or password is incorrect') ||
        haystack.includes('invalid token') ||
        haystack.includes('token is expired') ||
        haystack.includes('permission denied') ||
        haystack.includes('no permissions')
    ) {
        // A permission failure is authenticated-but-forbidden: retrying or
        // re-authenticating will not help, so it gets its own kind.
        const kind =
            haystack.includes('permission') || haystack.includes('no permissions')
                ? ERROR_KIND.PERMISSION
                : ERROR_KIND.AUTH;
        return { kind, message, code, detail };
    }

    if (code === RPC_ERROR.METHOD_NOT_FOUND) {
        return { kind: ERROR_KIND.NOTFOUND, message, code, detail };
    }

    if (code === RPC_ERROR.INVALID_PARAMS || code === RPC_ERROR.INVALID_REQUEST) {
        return { kind: ERROR_KIND.INVALID, message, code, detail };
    }

    if (haystack.includes('not found') || haystack.includes('does not exist')) {
        return { kind: ERROR_KIND.NOTFOUND, message, code, detail };
    }

    return { kind: ERROR_KIND.SERVER, message, code, detail };
}

/**
 * Build one JSON-RPC envelope.
 *
 * `params` is always sent, even when empty: Zabbix rejects a request that
 * omits it for most `*.get` methods.
 *
 * @param {object} options
 * @param {string} options.method Zabbix API method, e.g. 'host.get'
 * @param {object} [options.params] method parameters
 * @param {number|string} options.id correlation id, unique within a batch
 * @param {string} [options.sessionId] session token (sent as `auth`)
 * @returns {object} plain object ready for JSON.stringify
 */
export function buildRequest({ method, params = {}, id, sessionId = '' }) {
    if (typeof method !== 'string' || method.length === 0) {
        throw new TypeError('buildRequest: method must be a non-empty string');
    }
    if (id === undefined || id === null || id === '') {
        throw new TypeError('buildRequest: id is required');
    }

    const envelope = {
        jsonrpc: '2.0',
        method,
        params,
        id,
    };

    if (sessionId) {
        envelope.auth = sessionId;
    }

    return envelope;
}

/**
 * Serialise one request or an array of requests.
 *
 * @param {object|object[]} payload
 * @returns {string}
 */
export function encodeRequest(payload) {
    if (payload === null || typeof payload !== 'object') {
        throw new TypeError('encodeRequest: payload must be an object or array');
    }
    return JSON.stringify(payload);
}

/**
 * Headers for a Zabbix API call.
 *
 * The Bearer header is used for API tokens on every supported version, and
 * additionally for session tokens so that a server which removed the `auth`
 * body field (7.2+) keeps working. Callers that need the legacy body field
 * pass `sessionId` to `buildRequest` as well; sending both is harmless.
 *
 * `CF-Access-*` is not Zabbix at all: it authenticates the *request* to a
 * Cloudflare Access–protected hostname before Zabbix ever sees it. A Zabbix
 * instance published behind Access (the DeliverEdge pattern: a dedicated
 * `monitoring.<domain>` hostname with an email allow-list) answers a plain
 * client with an HTML login redirect instead of JSON. Service tokens are the
 * supported way for a non-browser client to get through.
 *
 * @param {object} options
 * @param {string} [options.apiToken] API token (Bearer)
 * @param {string} [options.sessionId] session token from user.login
 * @param {string} [options.accessClientId] Cloudflare Access service token id
 * @param {string} [options.accessClientSecret] Cloudflare Access client secret
 * @returns {Record<string,string>}
 */
export function buildHeaders({
    apiToken = '',
    sessionId = '',
    accessClientId = '',
    accessClientSecret = '',
} = {}) {
    const headers = {
        'Content-Type': 'application/json-rpc',
    };

    const bearer = apiToken || sessionId;
    if (bearer) {
        headers.Authorization = `Bearer ${bearer}`;
    }

    // Both halves are required by Access; sending one is rejected, so a
    // half-configured pair is treated as absent rather than as an error the
    // server can only report as an opaque HTML page.
    if (accessClientId && accessClientSecret) {
        headers['CF-Access-Client-Id'] = accessClientId;
        headers['CF-Access-Client-Secret'] = accessClientSecret;
    }

    return headers;
}

/**
 * Parse a single JSON-RPC response body.
 *
 * @param {string} text raw response body
 * @param {string} [method] method that produced it, for error attribution
 * @returns {any} the `result` payload
 * @throws {ZabbixError} on transport-independent protocol or API errors
 */
export function parseResponse(text, method = '') {
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new ZabbixError(
            'The server did not return JSON. Check that the URL points at the Zabbix API endpoint.',
            { kind: ERROR_KIND.PROTOCOL, method },
        );
    }
    return parseEnvelope(payload, method);
}

/**
 * Parse one already-decoded JSON-RPC envelope.
 *
 * Split out from `parseResponse` so the batch parser can reuse it without
 * re-stringifying, and so tests can feed plain objects.
 *
 * @param {any} payload decoded envelope
 * @param {string} [method]
 * @returns {any} `result`
 */
export function parseEnvelope(payload, method = '') {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ZabbixError('Unexpected response shape from the Zabbix API.', {
            kind: ERROR_KIND.PROTOCOL,
            method,
        });
    }

    if (payload.error) {
        const classified = classifyRpcError(payload.error);
        throw new ZabbixError(toDisplayMessage(classified), {
            kind: classified.kind,
            code: classified.code,
            detail: classified.detail,
            method,
        });
    }

    if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
        throw new ZabbixError('Zabbix returned a response with no result.', {
            kind: ERROR_KIND.PROTOCOL,
            method,
        });
    }

    return payload.result;
}

/**
 * Turn a classified error into a message that is safe to render.
 *
 * Zabbix's `message` is a terse category ("Application error.") while `data`
 * holds the actionable sentence, so the detail wins when both exist. The
 * result is trimmed and collapsed to one line: it lands in a tooltip.
 *
 * @param {{kind: string, message: string, detail: string}} classified
 * @returns {string}
 */
export function toDisplayMessage({ kind, message, detail }) {
    const preferred = detail || message;

    if (preferred) {
        const oneLine = preferred.replace(/\s+/g, ' ').trim();
        return oneLine.length > 240 ? `${oneLine.slice(0, 237)}…` : oneLine;
    }

    switch (kind) {
        case ERROR_KIND.AUTH:
            return 'Authentication failed.';
        case ERROR_KIND.PERMISSION:
            return 'This account is not allowed to read monitoring data.';
        case ERROR_KIND.NOTFOUND:
            return 'The requested Zabbix object does not exist.';
        case ERROR_KIND.INVALID:
            return 'Zabbix rejected the request parameters.';
        default:
            return 'The Zabbix server returned an error.';
    }
}

/**
 * Parse a batch response, correlating entries by `id`.
 *
 * Zabbix answers a batch as an array, and may omit entries for requests that
 * were rejected at the envelope level. Missing ids are surfaced as individual
 * errors rather than shifting results into the wrong slot, which is the bug
 * this function exists to prevent.
 *
 * @param {string} text raw response body
 * @param {number[]} ids ids in the order they were sent
 * @param {string[]} methods methods in the order they were sent
 * @returns {Array<{id:number, ok:boolean, result?:any, error?:ZabbixError}>}
 */
export function parseBatchResponse(text, ids, methods = []) {
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new ZabbixError(
            'The server did not return JSON. Check that the URL points at the Zabbix API endpoint.',
            { kind: ERROR_KIND.PROTOCOL },
        );
    }

    const envelopes = Array.isArray(payload) ? payload : [payload];
    const byId = new Map();

    for (const envelope of envelopes) {
        if (envelope && typeof envelope === 'object' && envelope.id !== undefined) {
            byId.set(normaliseId(envelope.id), envelope);
        }
    }

    return ids.map((id, index) => {
        const method = methods[index] ?? '';
        const envelope = byId.get(normaliseId(id));

        if (!envelope) {
            return {
                id,
                ok: false,
                error: new ZabbixError('Zabbix did not answer this request in the batch.', {
                    kind: ERROR_KIND.PROTOCOL,
                    method,
                }),
            };
        }

        try {
            return { id, ok: true, result: parseEnvelope(envelope, method) };
        } catch (error) {
            return {
                id,
                ok: false,
                error:
                    error instanceof ZabbixError
                        ? error
                        : new ZabbixError(String(error?.message ?? error), {
                              kind: ERROR_KIND.PROTOCOL,
                              method,
                          }),
            };
        }
    });
}

/** Zabbix echoes ids verbatim; numbers and numeric strings must not collide. */
function normaliseId(id) {
    return String(id);
}

/**
 * Build a batch payload and keep the id/method bookkeeping together so the
 * caller can pass the result straight to `parseBatchResponse`.
 *
 * @param {Array<{method: string, params?: object}>} calls
 * @param {object} [options]
 * @param {string} [options.sessionId]
 * @param {number} [options.startId=1]
 * @returns {{payload: object[], ids: number[], methods: string[]}}
 */
export function buildBatch(calls, { sessionId = '', startId = 1 } = {}) {
    const ids = [];
    const methods = [];
    const payload = calls.map((call, index) => {
        const id = startId + index;
        ids.push(id);
        methods.push(call.method);
        return buildRequest({
            method: call.method,
            params: call.params ?? {},
            id,
            sessionId,
        });
    });
    return { payload, ids, methods };
}

/**
 * Collect the successful entries of a batch, mapping failures by method so a
 * partially degraded dashboard can still render.
 *
 * @param {Array<{ok:boolean, result?:any, error?:ZabbixError}>} entries
 * @returns {{results: any[], errors: ZabbixError[]}}
 */
export function partitionBatch(entries) {
    const results = [];
    const errors = [];
    for (const entry of entries) {
        if (entry.ok) results.push(entry.result);
        else if (entry.error) errors.push(entry.error);
    }
    return { results, errors };
}
