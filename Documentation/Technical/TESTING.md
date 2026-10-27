# Testing

## What runs where

| Command | Needs | Covers |
|---|---|---|
| `make test` | `gjs` (+ Node for parallelism) | 389 unit assertions across 17 suites |
| `make check` | `gjs`, Node, optional display | parse, CSS balance, import smoke, prefs UI smoke |
| `make lint` | `npm install` | ESLint correctness rules |
| `gjs -m scripts/integration-test.js …` | a live Zabbix | the real request/response path |

## The unit suites

They run under plain `gjs` — not Node, not a browser — because several modules
touch `GLib` for timers without needing the shell. `tests/testUtils.js`
provides four assertions and a runner that understands async cases and prints a
summary line that `scripts/run-tests.mjs` parses.

| Suite | Pins |
|---|---|
| `zabbixRpc.test.js` | envelope shape, batch id correlation, error taxonomy, retryability |
| `zabbixEndpoints.test.js` | URL variants users paste, version gates (6.4 header, 7.2 `auth` removal) |
| `zabbixMethods.test.js` | exact parameters and field lists for every method |
| `zabbixResponse.test.js` | Cloudflare Access and WAF shapes, HTML-instead-of-JSON, proxy status text |
| `metricCatalog.test.js` | unique ids, valid kinds, threshold applicability, preference fallbacks |
| `normalize.test.js` | item matching, transforms, aggregation, trend series, snapshot assembly (77 cases) |
| `series.test.js` | downsampling preserves extremes, 0 → peak percentage axis, timestamp placement, hover hit-testing, trend totals |
| `severity.test.js` | threshold sanitising, "missing is never green", worst-of folding |
| `format.test.js` | the exact strings on screen, em-dash fallbacks, unit scaling |
| `appearance.test.js` | accent palettes, density tokens, light-panel colours |
| `serverStore.test.js` | corrupt JSON, duplicate ids, legacy array form, list caps |
| `secrets.test.js` | credential file parsing, keyring/file fallbacks |
| `hover.test.js` | the open/close timing policy |
| `backoff.test.js` | exponential ladder, ceiling, jitter band |
| `snapshotStore.test.js` | failure preserves last-good data, ordering, panel summary |
| `notificationPolicy.test.js` | priming, new problems, cooldown, escalation |
| `i18n.test.js` | identity before init, injection after, placeholder substitution |

### Properties the tests exist to protect

These are the bugs that a monitoring tool can ship for months without anyone
noticing, so they are asserted directly rather than left to review:

1. **A missing value is never green.** `classifyPercent(null)` is `unknown`, and
   `formatPercent('')` is `—`, not `0%`.
2. **The critical colour is always reachable.** `sanitiseThresholds(90, 90)`
   still yields `warn < crit`.
3. **A spike survives downsampling.** `downsample()` of 200 points keeps the
   global min and max.
4. **A failed poll keeps the last good numbers.** `failureSnapshot()` preserves
   `hosts` and `fetchedAt` while recording the error.
5. **Near-miss item keys are rejected.** `system.cpu.util[,user]` must not be
   mistaken for `system.cpu.util`; `net.if.in["lo"]` must not be summed;
   `vfs.fs.dependent.size[/,used]` (bytes) must not be read as a percentage.
6. **The first poll does not announce everything.** `NotificationPolicy` primes
   its baseline silently.

### Writing a suite

```js
import { assertEqual, runTests } from './testUtils.js';
import { classifyPercent } from '../src/model/severity.js';

await runTests([
    ['a name that reads as a sentence', () => {
        assertEqual(classifyPercent(90, { warn: 75, crit: 90 }), 'crit');
    }],
]);
```

The runner tolerates `async` cases and exits non-zero when any fail. Keep suites
focused on one module; `scripts/run-tests.mjs` runs them in parallel processes
and reports the slowest.

## The import smoke test

`scripts/import-smoke.js` imports every `src/` module that does not need a
shell-only typelib. This catches what `node --check` cannot:

* a named import that does not exist on the target module;
* a circular import that resolves to `undefined`;
* a `gi://` typelib that is not installed.

`SHELL_ONLY` lists the modules that legitimately need `St`/`Clutter`/`Soup`.
Adding a `gi://` import to a module that is not on that list is a *design*
change — it means the module moved from the pure core to the shell side, and the
list should be updated deliberately.

`scripts/prefs-smoke.js` goes further for the preferences window: it builds all
three pages against a real `Gio.Settings` and quits. An unknown property on an
Adw widget or a missing schema key fails here instead of producing a blank
window.

## The live integration test

The unit tests prove parsing; they cannot prove that Zabbix accepts the requests
we build. `scripts/integration-test.js` closes that gap:

```bash
gjs -m scripts/integration-test.js \
    --url https://monitor.example.com/zabbix \
    --token "$ZBX_TOKEN" \
    --history-minutes 60
```

It runs the production path (`ZabbixClient → pollServer → buildHostSnapshot`)
and prints:

```
  prod-web-01  [crit]
    CPU                 87%  warn     35 pts      system.cpu.util
    Memory              45%  ok       34 pts      vm.memory.util
    Disk                94%  crit     34 pts      vfs.fs.dependent.size[/var,pused]
    Network        2.5 Mb/s  ok       34 pts      net.if.in["eth0"]
```

The `key_` column is the point: it shows *which* item the catalog matched. An
unexpected key means the template differs from what the catalog expects, and a
blank one means nothing matched.

Run it after touching anything in `src/api/` or `src/model/`, and against each
Zabbix major version you intend to support.

## Testing against a real DeliverEdge-shaped stack

The extension ships no server, so the only meaningful live test is against a
Zabbix that looks like the production one: agent 2 in a container with
`pid: host` and the VPS root mounted at `/hostfs`, PostgreSQL behind it, Zabbix
7.4.

```bash
# 1. bring up a throwaway stack (see Documentation/Help/DeliverEdge.md for the
#    production topology to mirror), then mint an API token in the UI
# 2. run the full production path
gjs -m scripts/integration-test.js --url http://127.0.0.1:8092 --token <token>
```

It prints the resolved `key_` behind every tile, which is the fastest way to
prove the catalog still matches reality — a renamed template item shows up as a
different key or as an em dash, not as a plausible wrong number.

Two details worth checking by hand on any new Zabbix version, because both have
produced silent wrongness:

* An item that has **never collected** answers `lastvalue: "0"` with
  `lastclock: "0"`. It must render as an em dash, not as a green `0%`.
* `apiinfo.version` is unauthenticated and 7.4 **rejects** a request that
  carries an `Authorization` header, so the probe must go out bare.

## Not covered (deliberately)

* **Actor rendering.** Snapshotting widgets would need a compositor and would
  assert on layout pixels, which change with the user's theme and font scale.
  Geometry is tested via `model/series.js` instead; the visual result was
  verified by hand in a nested shell.
* **Real keyring round-trips.** libsecret needs an unlocked session; the store's
  JSON fallback and path logic are what the tests pin.
* **Notification delivery.** The *decision* is tested; `MessageTray` is not.
