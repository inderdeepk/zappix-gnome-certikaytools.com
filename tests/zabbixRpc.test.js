// zabbixRpc.test.js — wire-format tests for the JSON-RPC codec.
//
// These pin the exact request envelope and the exact error classification,
// because both are things a Zabbix upgrade can change and neither is visible in
// the UI until it breaks. Every case here corresponds to a real failure mode
// found in the Zabbix documentation (auth field removal in 7.2, batch ordering,
// HTTP 200 carrying API errors).
import { assert, assertDeepEqual, assertEqual, assertThrows, runTests } from './testUtils.js';
import {
    buildBatch,
    buildHeaders,
    buildRequest,
    classifyRpcError,
    encodeRequest,
    ERROR_KIND,
    parseBatchResponse,
    parseResponse,
    partitionBatch,
    RPC_ERROR,
    toDisplayMessage,
    ZabbixError,
} from '../src/api/zabbixRpc.js';

await runTests([
    [
        'buildRequest produces a JSON-RPC 2.0 envelope',
        () => {
            const request = buildRequest({ method: 'host.get', params: { limit: 5 }, id: 1 });
            assertDeepEqual(request, {
                jsonrpc: '2.0',
                method: 'host.get',
                params: { limit: 5 },
                id: 1,
            });
        },
    ],
    [
        'buildRequest always includes params even when empty',
        () => {
            const request = buildRequest({ method: 'apiinfo.version', id: 7 });
            assertDeepEqual(request.params, {});
        },
    ],
    [
        'buildRequest omits auth when no session token is given',
        () => {
            const request = buildRequest({ method: 'host.get', id: 1 });
            assert(!('auth' in request), 'auth must not be present');
        },
    ],
    [
        'buildRequest includes the legacy auth field for session tokens',
        () => {
            const request = buildRequest({ method: 'host.get', id: 1, sessionId: 'abc' });
            assertEqual(request.auth, 'abc');
        },
    ],
    [
        'buildRequest rejects an empty method',
        () => {
            assertThrows(() => buildRequest({ method: '', id: 1 }), 'method');
        },
    ],
    [
        'buildRequest rejects a missing id',
        () => {
            assertThrows(() => buildRequest({ method: 'host.get' }), 'id');
        },
    ],
    [
        'encodeRequest serialises a batch as an array',
        () => {
            const text = encodeRequest([
                buildRequest({ method: 'a', id: 1 }),
                buildRequest({ method: 'b', id: 2 }),
            ]);
            assert(text.startsWith('['), 'batch must serialise to an array');
            assertEqual(JSON.parse(text).length, 2);
        },
    ],
    [
        'buildHeaders sets the Bearer token for API tokens',
        () => {
            const headers = buildHeaders({ apiToken: 'tok_123' });
            assertEqual(headers.Authorization, 'Bearer tok_123');
            assertEqual(headers['Content-Type'], 'application/json-rpc');
        },
    ],
    [
        'buildHeaders prefers the API token over a session token',
        () => {
            const headers = buildHeaders({ apiToken: 'tok', sessionId: 'sess' });
            assertEqual(headers.Authorization, 'Bearer tok');
        },
    ],
    [
        'buildHeaders falls back to the session token',
        () => {
            const headers = buildHeaders({ sessionId: 'sess' });
            assertEqual(headers.Authorization, 'Bearer sess');
        },
    ],
    [
        'buildHeaders omits Authorization when there is no credential',
        () => {
            const headers = buildHeaders({});
            assert(!('Authorization' in headers), 'no credential means no header');
        },
    ],
    [
        'parseResponse returns the result payload',
        () => {
            const text = JSON.stringify({ jsonrpc: '2.0', result: [{ hostid: '1' }], id: 1 });
            assertDeepEqual(parseResponse(text), [{ hostid: '1' }]);
        },
    ],
    [
        'parseResponse surfaces an API error as ZabbixError',
        () => {
            const text = JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32602, message: 'Invalid params.', data: 'Bad field "foo".' },
                id: 1,
            });
            try {
                parseResponse(text, 'host.get');
                throw new Error('should have thrown');
            } catch (error) {
                assert(error instanceof ZabbixError, 'expected ZabbixError');
                assertEqual(error.kind, ERROR_KIND.INVALID);
                assertEqual(error.method, 'host.get');
                assert(error.message.includes('Bad field'), 'detail wins as the display message');
            }
        },
    ],
    [
        'parseResponse rejects a non-JSON body',
        () => {
            assertThrows(() => parseResponse('<html>502</html>'), 'did not return JSON');
        },
    ],
    [
        'parseResponse rejects a response with no result',
        () => {
            assertThrows(() => parseResponse('{"jsonrpc":"2.0","id":1}'), 'no result');
        },
    ],
    [
        'classifyRpcError detects an expired session by message',
        () => {
            const classified = classifyRpcError({
                code: RPC_ERROR.APPLICATION,
                message: 'Application error.',
                data: 'Session terminated, re-login, please.',
            });
            assertEqual(classified.kind, ERROR_KIND.AUTH);
        },
    ],
    [
        'classifyRpcError separates permission failures from auth failures',
        () => {
            const classified = classifyRpcError({
                code: RPC_ERROR.APPLICATION,
                message: 'Application error.',
                data: 'No permissions to call "host.get".',
            });
            assertEqual(classified.kind, ERROR_KIND.PERMISSION);
        },
    ],
    [
        'classifyRpcError maps method-not-found',
        () => {
            const classified = classifyRpcError({
                code: RPC_ERROR.METHOD_NOT_FOUND,
                message: 'Method not found.',
            });
            assertEqual(classified.kind, ERROR_KIND.NOTFOUND);
        },
    ],
    [
        'classifyRpcError defaults unknown errors to server',
        () => {
            const classified = classifyRpcError({ code: -1, message: 'Something odd.' });
            assertEqual(classified.kind, ERROR_KIND.SERVER);
        },
    ],
    [
        'toDisplayMessage collapses whitespace and truncates',
        () => {
            const long = `line one\n   line two ${'x'.repeat(400)}`;
            const message = toDisplayMessage({
                kind: ERROR_KIND.SERVER,
                message: '',
                detail: long,
            });
            assert(!message.includes('\n'), 'must be one line');
            assert(message.length <= 240, 'must be bounded for a tooltip');
        },
    ],
    [
        'toDisplayMessage falls back to a generic sentence',
        () => {
            const message = toDisplayMessage({ kind: ERROR_KIND.AUTH, message: '', detail: '' });
            assertEqual(message, 'Authentication failed.');
        },
    ],
    [
        'buildBatch numbers requests sequentially',
        () => {
            const { payload, ids, methods } = buildBatch([{ method: 'a' }, { method: 'b' }], {
                startId: 10,
            });
            assertDeepEqual(ids, [10, 11]);
            assertDeepEqual(methods, ['a', 'b']);
            assertEqual(payload[0].id, 10);
            assertEqual(payload[1].id, 11);
        },
    ],
    [
        'parseBatchResponse correlates by id, not by position',
        () => {
            // Zabbix may omit entries; a positional parser would silently shift
            // results into the wrong slot.
            const text = JSON.stringify([
                { jsonrpc: '2.0', result: 'second', id: 2 },
                { jsonrpc: '2.0', result: 'first', id: 1 },
            ]);
            const entries = parseBatchResponse(text, [1, 2], ['a', 'b']);
            assertEqual(entries[0].result, 'first');
            assertEqual(entries[1].result, 'second');
        },
    ],
    [
        'parseBatchResponse reports a missing entry as an error',
        () => {
            const text = JSON.stringify([{ jsonrpc: '2.0', result: 'only', id: 1 }]);
            const entries = parseBatchResponse(text, [1, 2], ['a', 'b']);
            assertEqual(entries[0].ok, true);
            assertEqual(entries[1].ok, false);
            assertEqual(entries[1].error.kind, ERROR_KIND.PROTOCOL);
        },
    ],
    [
        'parseBatchResponse isolates a single failing call',
        () => {
            const text = JSON.stringify([
                { jsonrpc: '2.0', result: [], id: 1 },
                {
                    jsonrpc: '2.0',
                    error: { code: RPC_ERROR.INVALID_PARAMS, message: 'Invalid params.' },
                    id: 2,
                },
            ]);
            const entries = parseBatchResponse(text, [1, 2], ['host.get', 'item.get']);
            assertEqual(entries[0].ok, true);
            assertEqual(entries[1].ok, false);
            assertEqual(entries[1].error.method, 'item.get');
        },
    ],
    [
        'parseBatchResponse accepts a single object for a one-call batch',
        () => {
            const text = JSON.stringify({ jsonrpc: '2.0', result: 42, id: 1 });
            const entries = parseBatchResponse(text, [1], ['x']);
            assertEqual(entries[0].result, 42);
        },
    ],
    [
        'partitionBatch splits results from errors',
        () => {
            const { results, errors } = partitionBatch([
                { ok: true, result: 1 },
                { ok: false, error: new ZabbixError('x') },
                { ok: true, result: 2 },
            ]);
            assertDeepEqual(results, [1, 2]);
            assertEqual(errors.length, 1);
        },
    ],
    [
        'ZabbixError marks transport failures retryable and auth failures not',
        () => {
            assertEqual(new ZabbixError('net', { kind: ERROR_KIND.NETWORK }).retryable, true);
            assertEqual(new ZabbixError('auth', { kind: ERROR_KIND.AUTH }).retryable, false);
            assertEqual(
                new ZabbixError('net', { kind: ERROR_KIND.NETWORK, retryable: false }).retryable,
                false,
            );
        },
    ],
    [
        'buildHeaders adds both Cloudflare Access headers when a token is set',
        () => {
            const headers = buildHeaders({
                apiToken: 'tok',
                accessClientId: 'id.access',
                accessClientSecret: 'sekret',
            });

            assertEqual(headers['CF-Access-Client-Id'], 'id.access');
            assertEqual(headers['CF-Access-Client-Secret'], 'sekret');
        },
    ],
    [
        'buildHeaders omits Access headers when only half the token is known',
        () => {
            // Access rejects a lone header, so sending one only replaces a
            // readable error with an opaque login page.
            const idOnly = buildHeaders({ accessClientId: 'id.access' });
            assertEqual(idOnly['CF-Access-Client-Id'], undefined);
            assertEqual(idOnly['CF-Access-Client-Secret'], undefined);

            const secretOnly = buildHeaders({ accessClientSecret: 'sekret' });
            assertEqual(secretOnly['CF-Access-Client-Id'], undefined);
            assertEqual(secretOnly['CF-Access-Client-Secret'], undefined);
        },
    ],
    [
        'buildHeaders sends no Access headers for a plain Zabbix server',
        () => {
            const headers = buildHeaders({ apiToken: 'tok' });
            assertEqual(headers['CF-Access-Client-Id'], undefined);
            assertEqual(Object.keys(headers).length, 2, Object.keys(headers).join(', '));
        },
    ],
]);
