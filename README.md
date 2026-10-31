# Zappix — server monitor for the GNOME top panel

A panel icon that opens a live system-utilization dashboard for every Zabbix
server you configure. Hover it and the dropdown appears: CPU, memory, disk, swap
and network per host, with 24-hour trend curves you can hover for an exact
reading, a problem list, and severity colours that mean the same thing
everywhere in the extension.

It talks to the Zabbix JSON-RPC API directly — no PHP frontend required, no
agent on your desktop, nothing to install on the server beyond Zabbix itself.

```
┌──────────────────────────────────────────────────────┐
│ ● Production           4 hosts · 2 problems   ⟳  ⚙   │
│ ┌────────────────────┐ ┌────────────────────┐        │
│ │ CPU           ▲    │ │ Memory             │        │
│ │ 87%                │ │ 45%                │        │
│ │ 8 cores · load 0.42│ │ 3.6/8 GB           │        │
│ │ ▁▂▃▅▇▆▅▃▂▁▂▃▅▇     │ │ ▂▃▄▅▄▃▂▃▄▅▄▃       │        │
│ └────────────────────┘ └────────────────────┘        │
│ ┌────────────────────┐ ┌────────────────────┐        │
│ │ Disk         ▲     │ │ Network            │        │
│ │ 94%                │ │ 2.5 Mb/s           │        │
│ │ 30/32 GB · /var    │ │ ↓ 2.1 · ↑ 0.4 Mb/s │        │
│ │ ▂▂▃▃▄▄▅▅▆▆▇▇       │ │ 14.2 TB this month │        │
│ └────────────────────┘ └────────────────────┘        │
│ ▲ high  Disk /var is 94% full              14:02     │
│ Updated 12s ago · Zabbix 7.0.32        Open Zabbix   │
└──────────────────────────────────────────────────────┘
```

## Why it is built this way

**A poll costs one round trip per category.** Live values come from `item.get`'s
`lastvalue` field, not from `history.get`. History and trends are fetched only
while the dropdown is open — the panel-only poll never pays for the curves.

**Missing data is never green.** A value that could not be read renders as an em
dash and classifies as *unknown*. An agent that stopped reporting must not look
like an idle machine.

**A failed poll keeps the last good numbers.** During an incident the card shows
what the server looked like immediately before it went unreachable, plus the
error, in place of an empty box.

**The item keys are the ones Zabbix actually ships.** Stock templates use
`system.cpu.util`, `vm.memory.util` and LLD-dependent keys such as
`vfs.fs.dependent.size[/var,pused]`. `src/model/metricCatalog.js` encodes each
metric's real keys plus its fallbacks, so a template revision that renames an
item degrades to the next candidate instead of to a blank tile.

## Layout

```
extension.js          entry point: build settings + monitor + indicator, tear down in reverse
prefs.js              preferences window (Servers, Monitoring, Appearance)
stylesheet.css        shell-side theme (dark + light)
src/
  api/                JSON-RPC codec, URL/version helpers, Soup transport, per-server client
  model/              metric catalog, response normalisation, series maths, severity
  monitor/            poll orchestration, backoff, snapshots, notification policy
  shared/             settings, server store, secrets, formatting, i18n, logging
  ui/                 panel indicator, hover controller, dashboard, cards, widgets, prefs pages
tests/                unit tests, plain gjs, no shell or network required
Documentation/        architecture, API reference, development, testing, security, user guide
```

The split is deliberate: everything under `api/` (except the transport),
`model/`, `monitor/backoff.js`, `monitor/snapshotStore.js`,
`monitor/notificationPolicy.js` and `shared/` is pure JavaScript with no GI
imports, which is why the tests run under `gjs` with no compositor.

## Install

```bash
make                    # compile schema + parse/css/import/prefs checks
make test               # unit tests
make install            # copy into ~/.local/share/gnome-shell/extensions
make reload             # or: log out and back in on Wayland
make logs               # follow the extension's journal lines
```

Requires GNOME Shell 45–48, `glib-compile-schemas`, and Node.js for the lint and
test tooling (not required at runtime). `gir1.2-secret-1` is optional: without
it, tokens fall back to a `0600` file and the preferences window says so.

## Configure

1. Open the dropdown → the empty state's **Add a server** button (or
   `make settings`).
2. Enter the Zabbix URL (`https://monitor.example.com` or
   `https://example.com/zabbix` — the API path is derived).
3. Choose **API token** and paste a token from *Users → API tokens*, or choose
   username/password.
4. Press **Test connection**: it reports the Zabbix version and host count, or
   the exact failure.

Then pick which metrics appear under **Monitoring**, and what the panel shows
under **Appearance**.

## Server-side setup

Zappix is a **read-only client**: it ships no server and installs nothing on the
VPS.

* **Already have Zabbix** — create a read-only API token (*Users → API tokens*)
  and paste it in. If the hostname sits behind Cloudflare Access, also add a
  service token; the extension detects that case and says so.
* **DeliverEdge VPS** — the platform already runs its own monitoring plane at
  `monitoring.<domain>` (Zabbix 7.4, PostgreSQL, Cloudflare Tunnel). Follow
  [`Documentation/Help/DeliverEdge.md`](Documentation/Help/DeliverEdge.md) to
  connect to it: token, Access service token, host filter, and the item keys the
  tiles read — including why the Disk tile uses the `/hostfs` item.

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](Documentation/Technical/ARCHITECTURE.md) | module responsibilities, data flow, the decisions behind them |
| [API_REFERENCE.md](Documentation/Technical/API_REFERENCE.md) | every Zabbix method called, with parameters and response shapes |
| [DEVELOPMENT.md](Documentation/Technical/DEVELOPMENT.md) | workflow, adding a metric, adding a provider, debugging |
| [TESTING.md](Documentation/Technical/TESTING.md) | what is tested and why, plus the live integration test |
| [SECURITY.md](Documentation/Technical/SECURITY.md) | credential storage, TLS, threat model |
| [UserGuide.md](Documentation/Help/UserGuide.md) | end-user walkthrough |
| [DeliverEdge.md](Documentation/Help/DeliverEdge.md) | connecting to the DeliverEdge monitoring plane |
| [Research-Reports/zabbix-api.md](Documentation/Research-Reports/zabbix-api.md) | the cited API research this design is based on |

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
