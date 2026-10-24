// serverStore.test.js — the server list document.
//
// The list is the one structure a user can corrupt by hand from dconf-editor, so
// parsing is written to repair rather than throw. These cases cover every shape
// the document has taken: the versioned object, the bare array, invalid entries,
// duplicate ids, and a truncated JSON string.
import { assert, assertDeepEqual, assertEqual, runTests } from './testUtils.js';
import {
    AUTH_MODE,
    enabledServers,
    MAX_SERVERS,
    makeServerId,
    moveServer,
    parseServers,
    patchServer,
    removeServer,
    resolveActiveServer,
    sanitiseServer,
    serialiseServers,
    SERVER_COLOURS,
    STORE_VERSION,
    upsertServer,
} from '../src/shared/serverStore.js';

/** Deterministic id generator for tests. */
function sequenceRandom(values) {
    let index = 0;
    return () => values[index++ % values.length];
}

await runTests([
    [
        'makeServerId produces a lowercase alphanumeric id',
        () => {
            const id = makeServerId({ random: () => 0.5 });
            assert(/^srv[a-z0-9]{4}$/.test(id), `unexpected id ${id}`);
        },
    ],
    [
        'makeServerId avoids a collision',
        () => {
            const first = makeServerId({ random: () => 0.25 });
            const second = makeServerId({
                existing: [first],
                random: sequenceRandom([0.25, 0.75]),
            });
            assert(first !== second, 'ids must differ');
        },
    ],
    [
        'sanitiseServer fills sensible defaults',
        () => {
            const server = sanitiseServer({ baseUrl: 'monitor.example.com' }, { index: 0 });
            assertEqual(server.baseUrl, 'https://monitor.example.com');
            assertEqual(server.label, 'monitor.example.com');
            assertEqual(server.authMode, AUTH_MODE.TOKEN);
            assertEqual(server.enabled, true);
            assertEqual(server.apiPath, '/api_jsonrpc.php');
            assertEqual(server.secretRef, `zappix:${server.id}`);
            assertEqual(server.colour, SERVER_COLOURS[0]);
        },
    ],
    [
        'sanitiseServer normalises the stored URL',
        () => {
            const server = sanitiseServer({
                baseUrl: 'https://example.com/zabbix/api_jsonrpc.php',
            });
            assertEqual(server.baseUrl, 'https://example.com/zabbix');
        },
    ],
    [
        'sanitiseServer rejects an unusable URL',
        () => {
            assertEqual(sanitiseServer({ baseUrl: 'ftp://example.com' }), null);
            assertEqual(sanitiseServer({}), null);
            assertEqual(sanitiseServer(null), null);
        },
    ],
    [
        'sanitiseServer keeps a user-mode username and drops it otherwise',
        () => {
            const userMode = sanitiseServer({
                baseUrl: 'https://a.example',
                authMode: 'user',
                username: '  Admin  ',
            });
            assertEqual(userMode.authMode, AUTH_MODE.USER);
            assertEqual(userMode.username, 'Admin');

            const tokenMode = sanitiseServer({
                baseUrl: 'https://a.example',
                authMode: 'token',
                username: 'Admin',
            });
            assertEqual(tokenMode.username, '');
        },
    ],
    [
        'sanitiseServer truncates an over-long label',
        () => {
            const server = sanitiseServer({
                baseUrl: 'https://a.example',
                label: 'x'.repeat(200),
            });
            assertEqual(server.label.length, 60);
        },
    ],
    [
        'sanitiseServer rejects a malformed colour',
        () => {
            const server = sanitiseServer(
                { baseUrl: 'https://a.example', colour: 'red' },
                { index: 2 },
            );
            assertEqual(server.colour, SERVER_COLOURS[2]);
        },
    ],
    [
        'sanitiseServer preserves an explicit secretRef',
        () => {
            const server = sanitiseServer({
                id: 'srv0001',
                baseUrl: 'https://a.example',
                secretRef: 'custom:ref',
            });
            assertEqual(server.secretRef, 'custom:ref');
        },
    ],
    [
        'parseServers reads the versioned document',
        () => {
            const json = JSON.stringify({
                version: STORE_VERSION,
                servers: [{ id: 'srv0001', baseUrl: 'https://a.example' }],
            });
            const { servers, recovered } = parseServers(json);
            assertEqual(servers.length, 1);
            assertEqual(recovered, false);
        },
    ],
    [
        'parseServers still accepts the legacy bare array',
        () => {
            const json = JSON.stringify([{ id: 'srv0001', baseUrl: 'https://a.example' }]);
            assertEqual(parseServers(json).servers.length, 1);
        },
    ],
    [
        'parseServers reports invalid JSON without throwing',
        () => {
            const result = parseServers('{"servers": [');
            assertDeepEqual(result.servers, []);
            assert(result.error.includes('not valid JSON'), 'error explains the problem');
        },
    ],
    [
        'parseServers reports an unknown shape',
        () => {
            const result = parseServers('{"nope": true}');
            assertDeepEqual(result.servers, []);
            assert(result.error.includes('unknown shape'), 'error explains the problem');
        },
    ],
    [
        'parseServers drops unusable entries and marks the document repaired',
        () => {
            const json = JSON.stringify({
                version: STORE_VERSION,
                servers: [
                    { id: 'srv0001', baseUrl: 'https://a.example' },
                    { id: 'srv0002', baseUrl: 'not a url with spaces' },
                ],
            });
            const result = parseServers(json);
            assertEqual(result.servers.length, 1);
            assertEqual(result.recovered, true);
        },
    ],
    [
        'parseServers re-keys a duplicate id instead of dropping the server',
        () => {
            const json = JSON.stringify({
                version: STORE_VERSION,
                servers: [
                    { id: 'srv0001', baseUrl: 'https://a.example' },
                    { id: 'srv0001', baseUrl: 'https://b.example' },
                ],
            });
            const { servers, recovered } = parseServers(json, () => 0.9);
            assertEqual(servers.length, 2);
            assert(servers[0].id !== servers[1].id, 'ids must be unique');
            assertEqual(recovered, true);
        },
    ],
    [
        'parseServers caps the list at MAX_SERVERS',
        () => {
            const servers = Array.from({ length: MAX_SERVERS + 3 }, (_, index) => ({
                id: `srv${String(index).padStart(4, '0')}`,
                baseUrl: `https://host${index}.example`,
            }));
            const { servers: parsed, recovered } = parseServers(JSON.stringify({ servers }));
            assertEqual(parsed.length, MAX_SERVERS);
            assertEqual(recovered, true);
        },
    ],
    [
        'parseServers treats an empty string as an empty list',
        () => {
            assertDeepEqual(parseServers('').servers, []);
        },
    ],
    [
        'serialiseServers round-trips through parseServers',
        () => {
            const server = sanitiseServer({ id: 'srv0001', baseUrl: 'https://a.example' });
            const json = serialiseServers([server]);
            const { servers } = parseServers(json);
            assertDeepEqual(servers[0], server);
        },
    ],
    [
        'upsertServer appends a new server',
        () => {
            const list = upsertServer([], { id: 'a' });
            assertEqual(list.length, 1);
        },
    ],
    [
        'upsertServer replaces in place and preserves order',
        () => {
            const list = upsertServer(
                [
                    { id: 'a', label: 'A' },
                    { id: 'b', label: 'B' },
                ],
                { id: 'a', label: 'A2' },
            );
            assertDeepEqual(
                list.map((entry) => entry.label),
                ['A2', 'B'],
            );
        },
    ],
    [
        'upsertServer refuses to exceed MAX_SERVERS',
        () => {
            const full = Array.from({ length: MAX_SERVERS }, (_, index) => ({ id: `s${index}` }));
            assertEqual(upsertServer(full, { id: 'new' }).length, MAX_SERVERS);
        },
    ],
    [
        'removeServer removes only the matching id',
        () => {
            const list = removeServer([{ id: 'a' }, { id: 'b' }], 'a');
            assertDeepEqual(
                list.map((entry) => entry.id),
                ['b'],
            );
        },
    ],
    [
        'moveServer swaps neighbours',
        () => {
            const list = moveServer([{ id: 'a' }, { id: 'b' }], 'b', -1);
            assertDeepEqual(
                list.map((entry) => entry.id),
                ['b', 'a'],
            );
        },
    ],
    [
        'moveServer is a no-op at the edges',
        () => {
            const list = [{ id: 'a' }, { id: 'b' }];
            assertDeepEqual(
                moveServer(list, 'a', -1).map((entry) => entry.id),
                ['a', 'b'],
            );
            assertDeepEqual(
                moveServer(list, 'b', 1).map((entry) => entry.id),
                ['a', 'b'],
            );
        },
    ],
    [
        'enabledServers filters disabled entries',
        () => {
            const list = [
                { id: 'a', enabled: true },
                { id: 'b', enabled: false },
            ];
            assertDeepEqual(
                enabledServers(list).map((entry) => entry.id),
                ['a'],
            );
        },
    ],
    [
        'resolveActiveServer honours the selected id',
        () => {
            const list = [
                { id: 'a', enabled: true },
                { id: 'b', enabled: true },
            ];
            assertEqual(resolveActiveServer(list, 'b').id, 'b');
        },
    ],
    [
        'resolveActiveServer falls back to the first enabled server',
        () => {
            const list = [
                { id: 'a', enabled: false },
                { id: 'b', enabled: true },
            ];
            assertEqual(resolveActiveServer(list, 'missing').id, 'b');
            assertEqual(resolveActiveServer([], 'x'), null);
        },
    ],
    [
        'patchServer applies a change through validation',
        () => {
            const list = [sanitiseServer({ id: 'srv0001', baseUrl: 'https://a.example' })];
            const patched = patchServer(list, 'srv0001', { label: 'Production' });
            assertEqual(patched[0].label, 'Production');
        },
    ],
    [
        'sanitiseServer defaults the Cloudflare Access fields',
        () => {
            const server = sanitiseServer({ baseUrl: 'https://mon.example.com' });
            assertEqual(server.accessClientId, '');
            assertEqual(server.accessSecretRef, `zappix-access:${server.id}`);
        },
    ],
    [
        'sanitiseServer keeps an Access client id and trims it',
        () => {
            const server = sanitiseServer({
                baseUrl: 'https://mon.example.com',
                accessClientId: '  1234abcd.access  ',
            });
            assertEqual(server.accessClientId, '1234abcd.access');
        },
    ],
    [
        'sanitiseServer derives the Access secret reference from a generated id',
        () => {
            const server = sanitiseServer(
                { baseUrl: 'https://a.example.com' },
                { existing: ['srv0000'], random: () => 0 },
            );
            assert(server.id !== 'srv0000', 'a used id must not be reused');
            assertEqual(server.accessSecretRef, `zappix-access:${server.id}`);
        },
    ],
    [
        'parseServers re-keys a duplicate id and both keyring references',
        () => {
            // Two entries claiming one id would share a keyring slot, so
            // rotating one token would silently break the other.
            const json = JSON.stringify({
                version: 1,
                servers: [
                    { id: 'aaaa', baseUrl: 'https://a.example.com', accessClientId: 'one.access' },
                    { id: 'aaaa', baseUrl: 'https://b.example.com', accessClientId: 'two.access' },
                ],
            });

            const { servers, recovered } = parseServers(json, () => 0.5);
            assertEqual(recovered, true);
            assertEqual(servers.length, 2);
            assert(servers[1].id !== 'aaaa', 'the later entry must be re-keyed');
            assertEqual(servers[1].secretRef, `zappix:${servers[1].id}`);
            assertEqual(servers[1].accessSecretRef, `zappix-access:${servers[1].id}`);
            assertEqual(servers[1].accessClientId, 'two.access');
        },
    ],
    [
        'sanitiseServer preserves an explicit Access secret reference',
        () => {
            const server = sanitiseServer({
                baseUrl: 'https://mon.example.com',
                accessSecretRef: 'custom:access',
            });
            assertEqual(server.accessSecretRef, 'custom:access');
        },
    ],
]);
