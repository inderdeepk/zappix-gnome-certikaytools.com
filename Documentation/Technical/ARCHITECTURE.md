# Architecture

Zappix is a GNOME 45+ shell extension that renders a live Zabbix dashboard in a
panel dropdown. This document explains the module boundaries, the data flow
through one poll, and — where a choice was not obvious — why that option was
taken over the alternative.

---

## 1. The two halves

A GNOME extension has no process boundary to put a backend behind, so the split
here is a *dependency* boundary rather than a network one.

### Pure core — no `gi://` imports

Everything that can be a pure function is one, because that is what makes it
testable without a compositor, a shell, or a server:

| Module | Responsibility |
|---|---|
| `api/zabbixRpc.js` | request envelope, headers (Bearer + Cloudflare Access), batch correlation, error taxonomy |
| `api/zabbixResponse.js` | is this answer an Access challenge, an HTML page, or a proxy status? |
| `api/zabbixEndpoints.js` | URL parsing/normalisation, version comparison |
| `api/zabbixMethods.js` | parameters for each API method, field lists |
| `model/metricCatalog.js` | what is measured, how it is found and aggregated |
| `model/normalize.js` | payload → view models, item matching, transforms |
| `model/series.js` | downsampling, geometry, statistics |
| `model/severity.js` | thresholds, problem severity mapping, "worst of" |
| `monitor/backoff.js` | retry pacing |
| `monitor/snapshotStore.js` | panel/dropdown shared state |
| `monitor/notificationPolicy.js` | when to interrupt the user |
| `ui/hover.js` | open-on-hover decision rules |
| `shared/format.js`, `shared/serverStore.js`, `shared/i18n.js`, `shared/appearance.js`, `shared/log.js` | formatting, server list validation, translation bridge, palette, logging |

`make test` runs these under plain `gjs`. No test needs a running shell.

### Shell-side — talks to GObject

| Module | Responsibility | Why it cannot be pure |
|---|---|---|
| `api/zabbixTransport.js` | HTTP via libsoup 3; classifies the answer using `zabbixResponse.js` | needs `Soup.Session` |
| `api/zabbixClient.js` | auth, batching, retries, cancellation | needs `Gio.Cancellable`, `GLib` timers |
| `monitor/poller.js` | per-server timers, client lifecycle | needs `GLib.timeout_add` |
| `monitor/serverPoller.js` | one poll assembled from the client | imports the client |
| `shared/settings.js` | typed, clamped GSettings access | needs `Gio.Settings` |
| `shared/secrets.js` | keyring + file fallback | needs `Gio`, dynamic `Secret` |
| `shared/brand.js` | locates the bundled Zabbix mark for the shell and prefs | needs `Gio`, `GLib` |
| `ui/indicator.js` | panel button, hover timers, menu lifecycle | needs `PanelMenu` |
| `ui/dashboard.js`, `ui/serverCard.js`, `ui/widgets/*` | actors and Cairo drawing | needs `St`, `Clutter` |
| `ui/prefs/*` | preference pages and the server dialog | needs `Adw`, `Gtk` |

The boundary is enforced by `scripts/import-smoke.js`, which imports every
non-shell module under plain `gjs`. A new `gi://` import in a pure module fails
`make check` immediately.

---

## 2. Data flow of one poll

```
MonitorService._pollOnce(server, mode)
  └─ pollServer({client, server, metrics, thresholds, mode})
       ├─ client.probe()                 apiinfo.version   (once per session)
       ├─ client.getHosts()              host.get
       ├─ client.getItems()              item.get          (all hosts, all metrics, one call)
       ├─ client.getProblems()           problem.get       ┐ parallel with getItems
       └─ mode === full
            ├─ client.getTrends()        trend.get         (24 h curve, ≥3 h window)
            ├─ client.getHistory()       history.get       (short windows, trend-less items)
            └─ client.getTrends()        trend.get         (calendar-month network total)
       └─ buildHostSnapshot() per host   → metrics[], severity, series
  └─ successSnapshot() / failureSnapshot()
  └─ onChange() → Indicator.update() → Dashboard.update()
```

### Why `item.get` carries the live value

`item.get` can return `lastvalue`, `lastclock`, `prevvalue` per item. Using it
means the headline numbers cost **one** call for every host and metric
simultaneously, instead of one `history.get` per item. Two consequences worth
knowing:

* `lastvalue` is empty when the item has not produced a value within Zabbix's
  *Max history display period* (24 h by default). The tile then shows an em
  dash and classifies as unknown — which is the correct reading, because a value
  that old is not a live measurement.
* The curve still needs history. That is why polling has two depths: `panel`
  (no history) and `full` (curves), switched by the dropdown opening. Windows
  of three hours or more come from `trend.get`, because raw history is kept for
  about an hour; shorter windows use `history.get`, and items with trend
  storage disabled fall back to it individually.

### Why the curve is scaled to its own peak

Percentage tiles plot the window's hourly peaks on a 0 → peak axis, so the top
edge of the strip *is* the highest reading of the window. The alternative — a
pinned 0–100 axis — rendered a 28-pixel strip as a straight line at 20 %
utilization. A genuinely flat series keeps a centred band so an idle host never
draws a line pinned to the top edge. The hover readout reports the nearest real
sample, never an interpolated value, and the newest `lastvalue` is appended to a
trend curve so it reaches "now" instead of stopping at the top of the hour.

### Why history is grouped by value type

`history.get` requires a `history` parameter matching the item's `value_type`,
and silently returns an empty set when it does not match. Items are therefore
grouped by `value_type` and fetched in one batch; a float metric and an unsigned
metric cannot share a query. `groupItemsByValueType()` in `zabbixMethods.js`
owns that rule.

### Why a zero clock means "no value"

`item.get` returns `lastvalue: "0"` for an item that has **never collected** —
not an empty string. Verified on both 7.0.32 and 7.4.16. The distinguishing
signal is `lastclock: "0"`, and `resolveMetric()` uses the clock alone to decide
whether a reading exists: a real zero (`docker.containers.stopped` on a busy
host, an idle interface) has a non-zero clock and is displayed as `0`.

Getting this wrong is the worst failure mode this panel has. A freshly added
host, an agent that has never started, or the stock `Zabbix server` host would
otherwise show five confident green `0 %` tiles while nothing was being
measured at all.

### Why hosts are ordered by what they can say

`orderHosts()` sorts hosts that produced readings first, then by name. A stock
install ships a `Zabbix server` host whose items match nothing in the catalog,
and its capital `Z` sorts before every lowercase hostname, so the panel headline
would be read from the one host with nothing to report. Ordering is a
correctness rule, not a cosmetic one.

### Why a host can be marked stale

An agent-2 host that only runs active checks reports its passive interface
availability as *Unknown* forever, so interface state cannot answer "is this
host still reporting?". `serverPoller` therefore timestamps each snapshot with
the newest `lastclock` among its metrics (`collectedAt`) and marks it `stale`
once that is older than `staleAfterSeconds` (default 300 s, floor 120 s). The
card shows a grey dot and keeps the last good numbers.

### Why the panel and the dropdown share one object

`MonitorService` holds `Map<serverId, snapshot>`. `panelSummary()` derives
everything the panel gauge draws — the arc fill, its colour, the label, the
problem badge and the offline state — from the same snapshot the card renders.
There is no path by which the number next to the icon can disagree with the
tile it came from. Problems travel as a separate `badge` rather than
recolouring the metric, so a red panel always means the metric itself is red.

---

## 3. Metric resolution

`metricCatalog.js` describes each metric as an ordered list of *candidates*:

```js
{
  id: 'cpu',
  aggregate: 'max',
  candidates: [
    { search: 'system.cpu.util', preferredKey: 'system.cpu.util',
      excludeKeys: [','], transform: 'autoPercent' },
    { search: 'system.cpu.util[,idle]', transform: 'invert' },
    { search: 'system.cpu.load[', includeKeys: ['avg1'],
      transform: 'identity', fallbackKind: 'load' },
  ],
}
```

Resolution (`normalize.selectItemsForMetric`) walks the candidates in order and
stops at the first that matches anything — except for metrics marked
`combineAllCandidates` (network), which union every candidate so inbound and
outbound are both counted.

Within a candidate, matches are ranked: exact `preferredKey` → key *starts with*
the search term → key merely *contains* it. The last tier exists because
templates embed discovered names (mount points, interface names, `"{#FSNAME}"`)
that cannot be predicted, but an unrelated item must never outrank a real one.

`includeKeys` / `excludeKeys` are how the catalog distinguishes near-identical
keys: `vfs.fs.dependent.size[/,pused]` from its `,used` byte-count sibling, and
`net.if.in["eth0"]` from `net.if.in["eth0",errors]` and from loopback.

### Transforms

| Transform | Used for | Behaviour |
|---|---|---|
| `identity` | load, uptime, process count, network rate | as-is |
| `autoPercent` | cpu, memory, disk | trust `units: '%'`; a unitless value in 0..1 is a fraction |
| `invert` | `[,idle]`, `[,pfree]`, `[pavailable]` | `100 − value` |
| `fraction` | reserved | `value × 100` |

The `units` field is what makes `autoPercent` safe: Zabbix tells us whether the
number is already a percentage, so no guessing is needed for the common case.

---

## 4. UI composition

`PanelMenu.Button`
└── `PanelGauge`: Cairo ring (level · severity · pulse/flatline · problem badge) + value label
└── `menu.box` (`.zappix-menu-content`)
    └── `Dashboard`
        ├── header: dot, title, refresh-all, settings
        ├── switcher: one pill per server (only when > 1)
        ├── `ServerCard`
        │   ├── card header: dot, label, "4 hosts · 2 problems", refresh
        │   ├── `St.ScrollView` → `HostSection` per host
        │   │   └── `MetricTile` × N, two per row
        │   ├── problems list (max 3 rows + "and N more")
        │   └── footer: "Updated 12s ago · Zabbix 7.0.32" + "Open Zabbix"
        └── empty state (no servers)

`ServerCard` and `HostSection` **reconcile** rather than rebuild: a poll updates
existing tiles in place. Rebuilding would destroy hover state and scroll
position every 30 seconds, which is exactly the kind of jank that makes a
monitoring tool annoying to use.

### Drawing

Sparklines, the panel gauge and the hover readout are `St.DrawingArea` + Cairo
(`model/series.js` supplies the maths); the readout text is a normal `St.Label`
laid over the curve with translations, so it never participates in the tile's
layout. Two constraints shaped this:

* **No CSS variables** in St, so the palette lives in `shared/appearance.js` and
  is mirrored by class names in `stylesheet.css`. Severity colours are identical
  in both paths because both read the same table.
* **No offscreen-framebuffer-heavy effects** on large surfaces. Radii and
  shadows are confined to small, fixed actors; the scrolling host list has
  neither.

### Hover

`PanelMenu.Button` opens on click. Hover is implemented in `ui/hover.js`
(pure decision rules) plus timers in `ui/indicator.js`:

```
enter  → schedule open after hover-open-delay-ms
open   → start a 120 ms monitor
tick   → pointer outside button AND menu for hover-close-delay-ms → close
```

The monitor only runs while the menu is open, and it is only *armed* when the
menu was opened with the pointer already inside — so a keyboard or programmatic
open is not immediately closed by a policy it never opted into.

---

## 5. Lifecycle and teardown

`enable()` builds four collaborators and hands the indicator to the panel:

```
setDebugEnabled ← ZappixSettings ← Extension.getSettings()
SecretStore
MonitorService(settings, secrets, onChange)
ZappixIndicator(settings, monitor, callbacks)
Main.panel.addToStatusArea(uuid, indicator)
monitor.start()            ← not awaited
```

`disable()` reverses it in dependency order, because a poll landing mid-teardown
would call into a destroyed actor:

1. cancel the pending reconfigure timer;
2. disconnect every settings handler;
3. `monitor.stop()` → clears timers, destroys Soup sessions, cancels cancellables;
4. destroy the notification source;
5. `indicator.destroy()` → clears hover/clock timers, disconnects menu signals.

Everything that registers a timer or signal stores its id on the instance.
There is no module-level mutable state except the logging switch and the i18n
function pointers, both of which are process-wide by design.

---

## 6. Deliberate non-goals

* **No Zabbix frontend embedding.** The extension reads the API; linking out is
  a button, not an iframe.
* **No `trigger.get`.** The problem list comes from `problem.get`, which already
  reflects trigger state after dependencies and maintenance.
* **No local metrics.** This monitors servers, not the desktop. Other
  extensions do that better.
* **No historical charts beyond the sparkline window.** A 32-pixel curve is not
  a graph; deep analysis belongs in the Zabbix frontend, one click away.
* **No background service.** The shell process is the runtime; a helper daemon
  would add a socket, a supervisor and a second place for state to diverge.
