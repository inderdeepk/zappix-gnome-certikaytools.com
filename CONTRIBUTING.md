# Contributing

## Before you start

```bash
npm install     # once: eslint, prettier, espree
make            # schema + parse + css + import + prefs smoke
make test       # 273 unit tests
```

Both must pass before a change is finished. `make lint` and `make format-check`
are also expected to be clean.

## The one architectural rule

**Pure modules must not import `gi://`.**

The pure core (`src/model/`, `src/shared/`, `src/api/zabbixRpc.js`,
`src/api/zabbixEndpoints.js`, `src/api/zabbixMethods.js`,
`src/monitor/backoff.js`, `src/monitor/snapshotStore.js`,
`src/monitor/notificationPolicy.js`, `src/ui/hover.js`) is what `make test`
exercises under plain `gjs`. Adding a `gi://` import there moves the module to
the shell side and takes it out of the test suite.

`scripts/import-smoke.js` enforces the boundary: a new `gi://` import in a pure
module fails `make check` immediately.

Shell-only modules are listed explicitly in that script. Changing that list is a
design decision, not a formality.

## Where things go

| You are… | Change |
|---|---|
| adding a metric | `src/model/metricCatalog.js` + a case in `tests/normalize.test.js` |
| adding a Zabbix call | `src/api/zabbixMethods.js` + `zabbixClient.js` + a case in `tests/zabbixMethods.test.js` |
| adding a preference | schema XML, a clamped accessor in `shared/settings.js`, a row in `src/ui/prefs/` |
| changing a visual | `stylesheet.css` for St, `shared/appearance.js` for Cairo |
| changing poll behaviour | `src/monitor/poller.js` (timers) or `serverPoller.js` (query shape) |
| touching credentials | `src/shared/secrets.js` — read SECURITY.md first |

## Conventions

* Prettier owns formatting: 4 spaces, single quotes, semicolons, 100 columns.
* ESLint is correctness-only. Style is not linted.
* Comments explain **why**, not what. If a comment restates the code, delete it.
* Every timer, signal connection and cancellable is stored on the instance and
  released in `destroy()` / `disable()`.
* Never log a credential. Route anything journal-bound through `shared/log.js`,
  which redacts.
* A missing value is `null`, never `0`. Rendering an unknown as a healthy zero is
  the bug this project exists to avoid.

## Commit messages

```
<type>(<scope>): <summary>

<why, if it is not obvious from the diff>
```

`type` ∈ feat, fix, refactor, test, docs, build, chore. `scope` is the module
(`model`, `api`, `ui`, `prefs`, `docs`).

## Pull requests

1. One concern per PR.
2. Tests for anything in the pure core.
3. If you touched `src/api/` or `src/model/`, run the live integration test
   against a real Zabbix (`Documentation/Technical/TESTING.md`) and paste the
   metric table into the PR.
4. If you touched anything that builds request headers or resolves item keys,
   say which Zabbix version you verified against — 6.4, 7.0 and 7.4 differ.
