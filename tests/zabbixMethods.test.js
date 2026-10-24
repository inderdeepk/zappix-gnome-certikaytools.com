// zabbixMethods.test.js — the exact request parameters sent to Zabbix.
//
// Every assertion here is a wire contract: a field renamed by mistake would not
// fail to compile, it would silently return an unfiltered (and therefore huge)
// result set or an empty one. The field lists are also a performance contract —
// `item.get` without an explicit output returns ~40 fields per item.
import { assert, assertDeepEqual, assertEqual, runTests } from './testUtils.js';
import {
    apiInfoVersion,
    groupItemsByValueType,
    historyGet,
    hostGet,
    HISTORY_VALUE_TYPE,
    itemGet,
    problemGet,
    userLogin,
    userLogout,
} from '../src/api/zabbixMethods.js';
import { METRICS } from '../src/model/metricCatalog.js';

await runTests([
    [
        'apiInfoVersion takes no parameters',
        () => {
            const call = apiInfoVersion();
            assertEqual(call.method, 'apiinfo.version');
            assertDeepEqual(call.params, {});
        },
    ],
    [
        'userLogin uses the modern username field by default',
        () => {
            const call = userLogin({ username: 'Admin', password: 'secret' });
            assertEqual(call.params.username, 'Admin');
            assert(!('user' in call.params), 'legacy field must be absent');
        },
    ],
    [
        'userLogin uses the legacy user field when asked',
        () => {
            const call = userLogin({ username: 'Admin', password: 'secret', legacy: true });
            assertEqual(call.params.user, 'Admin');
            assert(!('username' in call.params), 'modern field must be absent');
        },
    ],
    [
        'userLogout needs no parameters',
        () => {
            assertEqual(userLogout().method, 'user.logout');
        },
    ],
    [
        'hostGet only asks for monitored hosts',
        () => {
            const call = hostGet({ limit: 5 });
            assertEqual(call.method, 'host.get');
            assertEqual(call.params.filter.status, 0);
            assertEqual(call.params.limit, 5);
        },
    ],
    [
        'hostGet requests interfaces and sorts by name',
        () => {
            const call = hostGet();
            assert(Array.isArray(call.params.selectInterfaces), 'interfaces selected');
            assert(call.params.selectInterfaces.includes('available'), 'availability requested');
            assertEqual(call.params.sortfield, 'name');
        },
    ],
    [
        'hostGet uses selectHostGroups on 7.0+',
        () => {
            const call = hostGet({ version: '7.0.3' });
            assert(Array.isArray(call.params.selectHostGroups), 'host groups requested');
            assert(!('selectGroups' in call.params), 'legacy property absent');
        },
    ],
    [
        'hostGet uses selectGroups below 7.0',
        () => {
            const call = hostGet({ version: '6.4.10' });
            assert(Array.isArray(call.params.selectGroups), 'legacy groups requested');
            assert(!('selectHostGroups' in call.params), 'modern property absent');
        },
    ],
    [
        'hostGet adds a search only when a filter is set',
        () => {
            assert(!('search' in hostGet().params), 'no filter means no search');
            const filtered = hostGet({ hostFilter: 'web' });
            assertEqual(filtered.params.search.name, 'web');
            assertEqual(filtered.params.searchByAny, true);
        },
    ],
    [
        'itemGet searches every catalog term with searchByAny',
        () => {
            const call = itemGet({ hostIds: ['1', '2'], metrics: METRICS });
            assertEqual(call.method, 'item.get');
            assertDeepEqual(call.params.hostids, ['1', '2']);
            assert(call.params.search.key_.length > 1, 'multiple search terms');
            assertEqual(call.params.searchByAny, true);
            assertEqual(call.params.filter.status, 0);
        },
    ],
    [
        'itemGet asks for the items that populate tile detail lines',
        () => {
            const call = itemGet({ hostIds: ['1'], metrics: METRICS });
            assert(call.params.search.key_.includes('vm.memory.size[total]'), 'memory total');
            assert(call.params.search.key_.includes('system.cpu.num'), 'cpu core count');
            assert(
                call.params.search.key_.includes('docker.containers.stopped'),
                'stopped containers',
            );
        },
    ],
    [
        'itemGet requests a bounded field list',
        () => {
            const call = itemGet({ hostIds: ['1'], metrics: METRICS });
            assert(call.params.output.includes('lastvalue'), 'headline value requested');
            assert(call.params.output.includes('key_'), 'key requested');
            assert(!call.params.output.includes('description'), 'unused fields omitted');
            assert(call.params.output.length < 15, 'output stays narrow');
        },
    ],
    [
        'historyGet sorts ascending and bounds the range',
        () => {
            const call = historyGet({
                itemIds: ['1'],
                valueType: HISTORY_VALUE_TYPE.FLOAT,
                timeFrom: 1000,
                timeTill: 2000,
                limit: 50,
            });
            assertEqual(call.params.history, 0);
            assertEqual(call.params.sortorder, 'ASC');
            assertEqual(call.params.time_from, 1000);
            assertEqual(call.params.limit, 50);
            assertDeepEqual(call.params.output, ['itemid', 'clock', 'value']);
        },
    ],
    [
        'historyGet floors fractional timestamps',
        () => {
            const call = historyGet({
                itemIds: ['1'],
                valueType: 0,
                timeFrom: 1000.7,
                timeTill: 2000.2,
            });
            assertEqual(call.params.time_from, 1000);
            assertEqual(call.params.time_till, 2000);
        },
    ],
    [
        'problemGet does not ask for recent (resolved) problems',
        () => {
            const call = problemGet({ hostIds: ['1'] });
            assertEqual(call.method, 'problem.get');
            assertEqual(call.params.hostids[0], '1');
            assert(!('recent' in call.params), 'recent would include resolved problems');
        },
    ],
    [
        'problemGet can filter to unacknowledged problems',
        () => {
            assertEqual(
                problemGet({ hostIds: ['1'], unacknowledgedOnly: true }).params.acknowledged,
                false,
            );
            assert(!('acknowledged' in problemGet({ hostIds: ['1'] }).params), 'unset by default');
        },
    ],
    [
        'groupItemsByValueType separates float from unsigned',
        () => {
            const groups = groupItemsByValueType([
                { itemid: '1', value_type: '0' },
                { itemid: '2', value_type: '3' },
                { itemid: '3', value_type: '0' },
            ]);
            assertDeepEqual(groups.get(0), ['1', '3']);
            assertDeepEqual(groups.get(3), ['2']);
        },
    ],
    [
        'groupItemsByValueType ignores unparseable value types',
        () => {
            const groups = groupItemsByValueType([{ itemid: '1', value_type: '' }]);
            assertEqual(groups.size, 0);
        },
    ],
]);
