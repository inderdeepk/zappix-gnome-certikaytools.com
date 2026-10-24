# Development

## Prerequisites

| Tool | Needed for | Install |
|---|---|---|
| GNOME Shell 45–48 | running the extension | your distro |
| `glib-compile-schemas` | the schema (`glib-2.0` / `libglib2.0-bin`) | `apt install libglib2.0-bin` |
| `gjs` | tests and the import smoke test | `apt install gjs` |
| Node.js 18+ | lint, format, the test runner | `apt install nodejs npm` |
| `gir1.2-secret-1` | keyring storage (optional) | `apt install gir1.2-secret-1` |
| Docker + compose | the Zabbix stack and the integration test | `apt install docker.io docker-compose-v2` |

```bash
npm install          # once — eslint, prettier, espree
make                 # compile schema + every static check
```

## The loop

```bash
make                 # schema + parse + css + import + prefs smoke
make test            # unit tests (plain gjs, no shell)
make install         # copy into ~/.local/share/gnome-shell/extensions
make reload          # disable + enable in the running shell
make logs            # follow [Zappix] lines from the journal
```

On Wayland, `make reload` cannot reload the shell's own code — log out and back
in. Use a nested session for iteration without touching your session:

```bash
make nested          # gnome-shell --nested --wayland in its own dbus session
```

Enable debug logs while working on the network layer:

```bash
GSETTINGS_SCHEMA_DIR=schemas \
  gsettings set org.gnome.shell.extensions.zappix debug-logging true
```

(`GSETTINGS_SCHEMA_DIR` is required because the schema lives in the extension
directory rather than being installed system-wide.)

## Adding a metric

One file, `src/model/metricCatalog.js`. Nothing in the UI changes.

```js
Object.freeze({
    id: 'inodes',
    label: 'Inodes',
    unitLabel: 'used',
    kind: VALUE_KIND.PERCENT,        // percent | rate | load | duration | count
    aggregate: AGGREGATE.MAX,        // MAX | SUM | FIRST
    higherIsWorse: true,             // ← thresholds apply only when true
    sparkline: true,
    defaultEnabled: false,
    candidates: Object.freeze([
        Object.freeze({
            search: 'vfs.fs.dependent.inode[',
            includeKeys: Object.freeze([',pfree]']),
            preferredKey: 'vfs.fs.dependent.inode[/,pfree]',
            transform: TRANSFORM.INVERT,
        }),
    ]),
}),
```

Then:

1. **Find the real key.** Never guess. Query a live server:
   ```bash
   gjs -m scripts/integration-test.js --url … --token … --verbose
   ```
   or in the frontend: *Data collection → Hosts → host → Items*, and copy the
   key verbatim (they embed discovered names like `[/var]` or `["eth0"]`).
2. **Pick the transform.** If the item reports `units: '%'` use `autoPercent`;
   if it reports *free* percentage use `invert`; if it is already a rate (the
   stock network items are, because of `CHANGE_PER_SECOND` preprocessing) use
   `identity`.
3. **Decide the aggregate.** `MAX` for "the fullest filesystem matters", `SUM`
   for "total throughput", `FIRST` for a single-valued item.
4. **Add a test** in `tests/normalize.test.js` with a realistic `item.get` row,
   including the near-miss keys the catalog must reject.
5. `make test && make` — the catalog test asserts unique ids and valid kinds.

If the metric needs a new formatting rule, add it to `shared/format.js` and to
the `VALUE_KIND` switch in `formatMetricValue`; `model/series.js`'s
`axisForKind` decides the sparkline axis.

## Adding a Zabbix method

`src/api/zabbixMethods.js` holds the parameters; `zabbixClient.js` calls it.

```js
export function triggerGet({ hostIds }) {
    return {
        method: 'trigger.get',
        params: { output: ['triggerid', 'description'], hostids: [...hostIds], filter: { value: 1 } },
    };
}
```

Rules that keep a poll cheap:

* list `output` fields explicitly — never `'extend'`;
* scope by `hostids` whenever the method accepts it;
* add it to a batch (`client.batch([...])`) rather than awaiting it separately
  when it is independent of the other calls.

## Adding a preference

1. Add the key to `schemas/org.gnome.shell.extensions.zappix.gschema.xml` with a
   `<summary>` and a `<description>`; both appear in `dconf-editor` and in the
   extension's own documentation.
2. Expose it through `src/shared/settings.js` as a **typed, clamped accessor** —
   never read a raw key from a widget:
   ```js
   get pollIntervalSeconds() {
       return clampInt(this._get('poll-interval-seconds'), POLL_INTERVAL_MIN, POLL_INTERVAL_MAX, 30);
   }
   ```
3. Add a row in `src/ui/prefs/` (`switchRow` / `spinRow` / `comboRow`).
4. If the shell must react, add the key to `RECONFIGURE_KEYS` or `RENDER_KEYS`
   in `extension.js`.
5. `make` — the prefs smoke test builds every page and fails on an unknown key.

## Loading changed code

`make reload` runs `gnome-extensions disable/enable`, which re-runs `enable()` but
**does not reload the JavaScript**. GNOME 45+ keeps the module graph cached for
the life of the shell session, so after editing anything the panel keeps running
the old file — verified by changing a log string, reloading, and watching the old
string come back.

* **X11** — `Alt+F2`, type `r`, Enter.
* **Wayland** — log out and back in (a nested session, `make nested`, reloads
  cleanly every time).

`make restart` prints this reminder. Symptom of forgetting: a bug you just fixed
keeps appearing in `make logs`.

## Reading the logs

Two processes produce output, and they go to different places:

```bash
# the extension inside the shell — poll results, warnings, errors
make logs                  # journalctl -f -o cat /usr/bin/gnome-shell | grep -i zappix
make logs-all              # everything, unfiltered

# the preferences window, where server add/edit/delete actually runs
make prefs                 # same as gnome-extensions prefs <uuid>, but attached
```

If `make logs` prints `Insufficient watch descriptors available. Reverting to
-n.` and then nothing, the journal has more files than inotify can watch. Either
read it without following (`journalctl -o cat /usr/bin/gnome-shell | grep -i
zappix`), or raise the limit:

```bash
sudo sysctl -w fs.inotify.max_user_watches=524288
echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/99-inotify.conf
```

The preferences window is a separate GJS process. When it is opened from the
dropdown's gear button its `warn()`/`error()` output has no terminal and is
lost; launch it from a shell as above whenever you are debugging a save,
a keyring problem, or the connection test. `debug-logging` in the panel
settings only affects the shell process.

## Working on the network layer

```bash
# 1. any real Zabbix on loopback — the version you are targeting.
#    Mirror the production topology (agent 2 in a container, /hostfs mount)
#    when working on disk or container metrics; see
#    Documentation/Help/DeliverEdge.md for what that stack looks like.

# 2. the full client path, with real data
gjs -m scripts/integration-test.js \
    --url http://127.0.0.1:8082 --user Admin --password zabbix --history-minutes 60
```

The integration script runs `probe → getHosts → getItems → getHistory →
getProblems → pollServer` and prints every resolved metric with its source item
key. A wrong key shows up as `—` with an empty `sourceItemKey`.

To get non-zero values without installing an agent, push synthetic history with
`zabbix_sender` (trapper items accept any key):

```bash
docker exec <zabbix-server-container> zabbix_sender \
  -z 127.0.0.1 -p 10051 -s prod-web-01 -k 'system.cpu.util' -o 87.5
```

`zabbix_sender` refuses multiple `-k` flags; use `-i file --with-timestamps`
with `host key timestamp value` lines for bulk data.

## Code conventions

* 4 spaces, single quotes, semicolons, 100 columns — enforced by Prettier.
* ESLint is correctness-only (`no-unused-vars`, `eqeqeq`, `no-redeclare`…).
  Style is not linted.
* **Pure modules must not import `gi://`.** `make check` enforces it.
* Comments explain *why*. A comment that restates the code is a bug.
* Every timer, signal connection and cancellable is stored on the instance and
  released in `destroy()`/`disable()`.
* Never log a credential. `shared/log.js`'s `redact()` scrubs `Bearer`,
  `"auth":` and `?token=` patterns from anything that reaches the journal.

## Debugging

| Symptom | Where to look |
|---|---|
| Extension listed as "Error" | `journalctl -f -o cat /usr/bin/gnome-shell \| grep -i zappix` |
| Tiles show `—` | *Items* view in Zabbix: `state: not supported` carries the agent error |
| Values look wrong | run the integration test; it prints the resolved `key_` per metric |
| Preferences window blank | `GJS_DEBUG_OUTPUT=stderr gnome-extensions prefs <uuid>` |
| Menu closes instantly | `open-on-hover` + the 120 ms monitor; check `pointerInButton` geometry |
| CSS ignored | `make check` (delimiter balance); St silently drops unknown properties |

## Release

```bash
make test && make lint && make
make langs                       # compile po/*.po if any
make package                     # <uuid>.zip at the repo root
```

`make package` runs `compile-schemas` first, so the zip always contains a
matching `gschemas.compiled`.
