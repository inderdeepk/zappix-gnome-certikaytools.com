// integration-test.js — exercise the real Zabbix client against a live server.
//
// The unit suites deliberately avoid the network: they prove the parsing and the
// maths, not that Zabbix accepts the requests we build. This script closes that
// gap. It runs the exact production path —
//
//   ZabbixClient → pollServer() → buildHostSnapshot()
//
// — against a real server and prints the resolved dashboard, so a schema change
// or a version difference shows up as a wrong number rather than as a blank tile
// three days later.
//
// It is not part of `make test` because it needs a reachable server. Run it by
// hand after changing anything in src/api or src/model:
//
//   gjs -m scripts/integration-test.js --url http://127.0.0.1:8082 \
//        --user Admin --password zabbix
//
//   gjs -m scripts/integration-test.js --url https://monitor.example.com \
//        --token <api-token> [--host-filter web] [--history-minutes 60]
//
// Exit code 0 means every stage answered; a non-zero exit names the stage that
// failed. Nothing is written anywhere.

import GLib from 'gi://GLib';
import System from 'system';

import { ZabbixClient } from '../src/api/zabbixClient.js';
import { pollServer, POLL_MODE } from '../src/monitor/serverPoller.js';
import { METRICS, resolveEnabledMetrics } from '../src/model/metricCatalog.js';
import { normaliseHost } from '../src/model/normalize.js';
import { formatMetricValue } from '../src/shared/format.js';

/** Parse `--key value` / `--key=value` pairs. */
function parseArgs(argv) {
    const options = {
        url: '',
        token: '',
        user: '',
        password: '',
        hostFilter: '',
        historyMinutes: 60,
        metrics: '',
        allowUntrustedTls: false,
        verbose: false,
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (!arg.startsWith('--')) continue;
        const name = arg.slice(2);
        const next = argv[index + 1];

        switch (name) {
            case 'url':
                options.url = next ?? '';
                index++;
                break;
            case 'token':
                options.token = next ?? '';
                index++;
                break;
            case 'user':
                options.user = next ?? '';
                index++;
                break;
            case 'password':
                options.password = next ?? '';
                index++;
                break;
            case 'host-filter':
                options.hostFilter = next ?? '';
                index++;
                break;
            case 'history-minutes':
                options.historyMinutes = Number(next ?? 60);
                index++;
                break;
            case 'metrics':
                options.metrics = next ?? '';
                index++;
                break;
            case 'insecure':
                options.allowUntrustedTls = true;
                break;
            case 'verbose':
                options.verbose = true;
                break;
            default:
                printerr(`Unknown option: ${arg}`);
                System.exit(2);
        }
    }

    if (!options.url) {
        printerr('Missing --url.');
        System.exit(2);
    }
    if (!options.token && !(options.user && options.password)) {
        printerr('Provide --token, or --user and --password.');
        System.exit(2);
    }

    return options;
}

/**
 * Fail with a readable message.
 *
 * @param {string} stage
 * @param {unknown} error
 */
function fail(stage, error) {
    printerr(`[FAIL] ${stage}: ${error?.message ?? error}`);
    System.exit(1);
}

/** @param {string} line */
function section(line) {
    print(`\n── ${line} ${'─'.repeat(Math.max(0, 60 - line.length))}`);
}

const options = parseArgs(ARGV);

const server = {
    id: 'integration',
    label: 'Integration',
    baseUrl: options.url,
    authMode: options.token ? 'token' : 'user',
    username: options.user,
    hostFilter: options.hostFilter,
    allowUntrustedTls: options.allowUntrustedTls,
    enabled: true,
    colour: '#7aa2f7',
    secretRef: 'integration',
};

const secret = options.token || options.password;
const metrics = options.metrics
    ? resolveEnabledMetrics(options.metrics.split(',').map((id) => id.trim()))
    : METRICS.filter((metric) => metric.defaultEnabled);

const client = new ZabbixClient({
    server,
    secret,
    timeoutSeconds: 15,
    allowUntrustedTls: options.allowUntrustedTls,
});

try {
    section('probe');
    const version = await client.probe().catch((error) => fail('apiinfo.version', error));
    print(`Zabbix ${version} at ${client.apiUrl}`);

    section('hosts');
    const hosts = await client
        .getHosts({ limit: 20, hostFilter: options.hostFilter })
        .catch((error) => fail('host.get', error));
    print(`${hosts.length} monitored host(s)`);
    for (const raw of hosts) {
        const host = normaliseHost(raw);
        if (!host) continue;
        print(`  • ${host.name} — ${host.endpoint || 'no interface'} (${host.availability})`);
    }

    if (hosts.length === 0) {
        section('result');
        print('No monitored hosts. Create one (or check the API token permissions).');
    } else {
        section('full poll');
        const started = GLib.get_monotonic_time();
        const payload = await pollServer({
            client,
            server,
            metrics,
            thresholds: { warn: 75, crit: 90 },
            maxHosts: 20,
            historyWindowMinutes: options.historyMinutes,
            mode: POLL_MODE.FULL,
        }).catch((error) => fail('pollServer', error));
        const elapsedMs = (GLib.get_monotonic_time() - started) / 1000;

        print(`${payload.hosts.length} host snapshot(s) in ${elapsedMs.toFixed(0)} ms`);

        for (const host of payload.hosts) {
            print(`\n  ${host.name}  [${host.worstSeverity}]`);
            for (const metric of host.metrics) {
                const value = metric.available ? formatMetricValue(metric.kind, metric.value) : '—';
                const series =
                    metric.series.length > 0 ? `${metric.series.length} pts` : 'no history';
                print(
                    `    ${metric.label.padEnd(10)} ${value.padStart(12)}  ` +
                        `${metric.severity.padEnd(8)} ${series.padEnd(11)} ${metric.sourceItemKey}`,
                );
            }
        }

        section('problems');
        print(`${payload.problems.total} open, ${payload.problems.unacknowledged} unacknowledged`);
        for (const problem of payload.problems.items) {
            print(`  ▲ ${problem.severity.padEnd(7)} ${problem.name}`);
        }
    }

    section('result');
    print('[OK] Every stage answered.');
} finally {
    client.destroy();
}
