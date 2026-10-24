// zabbixEndpoints.test.js — URL normalisation and version gates.
//
// The URL cases are the ones users actually paste; each one here came out of
// the "what does the address bar show" question rather than from a spec. The
// version gates pin the two breaking API changes Zappix has to survive:
// Zabbix 6.4 introduced the Authorization header, and 7.2 removed the `auth`
// body property entirely.
import { assert, assertDeepEqual, assertEqual, assertThrows, runTests } from './testUtils.js';
import {
    buildFrontendUrl,
    normaliseBaseUrl,
    parseVersionParts,
    supportsBearerHeader,
    supportsLegacyAuthField,
    usesHostGroupsProperty,
    usesModernLoginField,
    versionAtLeast,
} from '../src/api/zabbixEndpoints.js';

await runTests([
    [
        'normaliseBaseUrl handles a bare origin',
        () => {
            const result = normaliseBaseUrl('https://monitor.example.com');
            assertEqual(result.apiUrl, 'https://monitor.example.com/api_jsonrpc.php');
            assertEqual(result.frontendUrl, 'https://monitor.example.com');
        },
    ],
    [
        'normaliseBaseUrl keeps a subdirectory',
        () => {
            const result = normaliseBaseUrl('https://example.com/zabbix/');
            assertEqual(result.apiUrl, 'https://example.com/zabbix/api_jsonrpc.php');
            assertEqual(result.path, '/zabbix');
        },
    ],
    [
        'normaliseBaseUrl strips a pasted api_jsonrpc.php',
        () => {
            const result = normaliseBaseUrl('https://example.com/zabbix/api_jsonrpc.php');
            assertEqual(result.apiUrl, 'https://example.com/zabbix/api_jsonrpc.php');
            assertEqual(result.frontendUrl, 'https://example.com/zabbix');
        },
    ],
    [
        'normaliseBaseUrl defaults a missing scheme to https',
        () => {
            const result = normaliseBaseUrl('monitor.example.com/zabbix');
            assertEqual(result.apiUrl, 'https://monitor.example.com/zabbix/api_jsonrpc.php');
        },
    ],
    [
        'normaliseBaseUrl preserves an explicit http scheme',
        () => {
            const result = normaliseBaseUrl('http://10.0.0.5');
            assertEqual(result.apiUrl, 'http://10.0.0.5/api_jsonrpc.php');
        },
    ],
    [
        'normaliseBaseUrl drops query and fragment',
        () => {
            const result = normaliseBaseUrl('https://example.com/zabbix?x=1#frag');
            assertEqual(result.apiUrl, 'https://example.com/zabbix/api_jsonrpc.php');
        },
    ],
    [
        'normaliseBaseUrl rejects an empty value',
        () => {
            assertThrows(() => normaliseBaseUrl('   '), 'empty');
        },
    ],
    [
        'normaliseBaseUrl rejects a non-http scheme',
        () => {
            assertThrows(() => normaliseBaseUrl('ftp://example.com'), 'http');
        },
    ],
    [
        'buildFrontendUrl returns the plain frontend by default',
        () => {
            assertEqual(
                buildFrontendUrl('https://example.com/zabbix'),
                'https://example.com/zabbix',
            );
        },
    ],
    [
        'buildFrontendUrl appends action and host id',
        () => {
            const url = buildFrontendUrl('https://example.com', {
                tab: 'host.dashboard.view',
                hostId: '10084',
            });
            assert(url.includes('action=host.dashboard.view'), 'action present');
            assert(url.includes('hostid=10084'), 'hostid present');
        },
    ],
    [
        'parseVersionParts extracts numeric components',
        () => {
            assertDeepEqual(parseVersionParts('7.0.3'), [7, 0, 3]);
            assertDeepEqual(parseVersionParts('6.4.10rc1'), [6, 4, 10]);
            assertDeepEqual(parseVersionParts('nonsense'), []);
        },
    ],
    [
        'versionAtLeast compares numerically, not lexically',
        () => {
            assertEqual(versionAtLeast('7.0.10', '7.0.9'), true);
            assertEqual(versionAtLeast('6.4.0', '7.0.0'), false);
            assertEqual(versionAtLeast('7.0', '7.0.0'), true);
        },
    ],
    [
        'supportsLegacyAuthField is true until 7.2',
        () => {
            assertEqual(supportsLegacyAuthField('6.0.0'), true);
            assertEqual(supportsLegacyAuthField('7.0.3'), true);
            assertEqual(supportsLegacyAuthField('7.2.0'), false);
            assertEqual(supportsLegacyAuthField('7.4.1'), false);
        },
    ],
    [
        'supportsLegacyAuthField assumes permissive when the version is unknown',
        () => {
            assertEqual(supportsLegacyAuthField(''), true);
        },
    ],
    [
        'supportsBearerHeader starts at 6.4',
        () => {
            assertEqual(supportsBearerHeader('6.0.0'), false);
            assertEqual(supportsBearerHeader('6.4.0'), true);
            assertEqual(supportsBearerHeader(''), true);
        },
    ],
    [
        'usesModernLoginField starts at 6.4',
        () => {
            assertEqual(usesModernLoginField('6.0.0'), false);
            assertEqual(usesModernLoginField('6.4.0'), true);
        },
    ],
    [
        'usesHostGroupsProperty starts at 7.0',
        () => {
            assertEqual(usesHostGroupsProperty('6.4.10'), false);
            assertEqual(usesHostGroupsProperty('7.0.0'), true);
            assertEqual(usesHostGroupsProperty(''), true);
        },
    ],
]);
