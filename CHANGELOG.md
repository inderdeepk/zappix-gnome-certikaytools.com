# Changelog

All notable changes to Zappix are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Tiles for percentage metrics now carry the absolute figure underneath:
  Memory reads `63 %` with `5 GB of 8 GB`, Disk derives the total from the same
  mount (`vfs.fs.size[/hostfs,pused]` → `vfs.fs.size[/hostfs,total]`). A host
  that reports no total simply has no second line.

- Panel indicator with a hover-opened dropdown (click-to-pin supported).
- Per-server cards with CPU, memory, disk and network tiles, sparklines and
  utilization meters; optional swap, load, uptime and process metrics.
- Open-problem list with Zabbix severity mapping and `NEW`/`ACK` tags.
- Multi-server support with a switcher, per-server accent colours and automatic
  ordering (alarms first, unreachable last).
- Preferences: server list with add/edit/remove and a live **Test connection**,
  polling and threshold controls, metric selection, panel and theme options.
- API-token and username/password authentication, with Zabbix version detection
  so the right auth mechanism is used on 6.0 → 7.4.
- Credential storage in the login keyring via libsecret, with a `0600` file
  fallback and a visible indication of which is in use.
- Exponential backoff after repeated poll failures; last-good values are kept on
  screen while a server is unreachable.
- Optional desktop notifications for new problems and critical utilization, with
  a cooldown.
- Light and dark themes, reduced-motion support, and three layout densities.
- Cloudflare Access support: an optional service-token pair per server, sent as
  `CF-Access-Client-Id` / `CF-Access-Client-Secret`, with a dedicated error when
  a login page is answered instead of the API.
- `Documentation/Help/DeliverEdge.md`: connecting the extension to the
  DeliverEdge monitoring plane (`monitoring.<domain>`, host `deliveredge-prod`).
- Container metric (`docker.containers.running`), on by default for hosts built
  from the Docker agent 2 template.
- 339 unit tests, an import smoke test, a preferences UI smoke test, and a live
  integration test against a real Zabbix server.

### Changed

- **The panel indicator is one mark instead of three.** The status dot, the
  monitor icon and the bold value were three separate actors (~73 px for `6%`);
  they are now a single 16 px ring gauge with the value beside it (~41 px, about
  40 % narrower). The ring fills to the panel metric and takes its severity
  colour, the Zappix pulse sits inside it and flatlines while the server is
  unreachable, and unacknowledged problems appear as a dot notched into the rim.
  The value now uses the panel's own font and weight (like the clock and the
  battery), with tabular figures so the panel no longer shifts as it changes,
  and is only tinted when amber or red. On a light top bar the gauge switches to
  deeper shades that stay at ≥ 4:1 contrast.
- **Open problems no longer repaint the panel metric.** A critical problem used
  to turn an idle `6%` red, which read as "CPU critical". The metric keeps its
  own colour; problems get the rim badge (now also for warning-level problems,
  which previously showed nothing). *Flag open problems on the icon* replaces
  *Tint the icon for open problems*.
- The panel's description (server, metric, problem count) moved from a tooltip
  that St never displayed to the button's accessible name, where screen readers
  announce it.
- `icons/zappix-symbolic.svg` is redrawn as the new ring-and-pulse mark.
- Removed `deploy/deliveredge/`. DeliverEdge already ships a monitoring plane
  (`docker-compose.monitoring.yml`, PostgreSQL, Zabbix 7.4, `MONITORING_*`
  environment, Cloudflare Tunnel to `monitoring-web:8080`); shipping a second,
  conflicting stack (MySQL, `deliveredge-zabbix`, `ZABBIX_*`, edge-nginx routes)
  would have fought the platform it was meant to serve. Setting the extension up
  against it is now a documented procedure instead.

### Fixed

- **The connecting pulse never stopped.** `StatusDot` stored the return value
  of `actor.ease()`, which is `undefined`, so `_stopPulse()` was a no-op: the
  panel dot stayed dimmed mid-animation forever, and the endless transition
  kept the shell's `begin_work()`/unredirect hold alive for the whole session.
  The pulse is now tracked explicitly and stopped with `remove_transition()`.
- With **Open problems** as the panel value, a server that had never answered
  showed an "all clear" green state, because its empty problem list was read as
  zero problems. Nothing is drawn until the first successful poll.
- **The dropdown clipped every tile below its label.** `_applyScrollHeight()`
  estimated the content as `hosts × (sparkline + 74)`, which assumes a single
  row of tiles per host. With five metrics — three rows — the scroll view was
  given a third of the height it needed, so CPU and Memory showed only their
  labels and the popup ended there. The height is now measured from the content
  (`get_preferred_height`), which adapts to the metric count and density: a host
  with five tiles wants 356 px and gets it. The popup's height budget is now
  `monitor − panel − chrome` instead of a flat 45 % of the monitor, so three rows
  fit on a short laptop screen.
- **Every poll failed with `this.repaint is not a function`.** Two Cairo widgets
  still called `repaint()`, removed from St long before GNOME 45 — the sparkline
  through a method that shadowed the real `queue_repaint()`, and the meter
  directly. The card could not render at all, and the exception surfaced as a
  poll failure. Both now use `queue_repaint()`.
- **A shell that started with servers already saved polled nothing.** Only
  `reconfigure()` ran at enable, which builds clients but makes no request — the
  triggering refresh came from the settings handler, so after every login the
  panel sat on "Connecting…" until the menu was opened by hand. `start()` now
  polls once.
- New `scripts/check-api.mjs` (part of `make check`) rejects calls to shell APIs
  removed in GNOME 45/46. The widget layer is excluded from the unit suites and
  the import smoke test, so `repaint()` compiled, imported and passed every gate
  while breaking every render.
- **Saving a server hung forever on "Saving…".** `storeKeyring()` passed a
  `service: 'zabbix'` attribute that the keyring schema never declared. libsecret
  rejects such a call with a GLib warning and never invokes the callback, so the
  promise never settled and the save never completed — on every machine. The
  attribute is gone; a store now takes ~25 ms and lands in the login keyring.
- Keyring calls are bounded: a 2 s D-Bus probe decides whether libsecret is used
  at all, and a 15 s ceiling backstops an unanswered unlock prompt, so the
  private-file fallback always wins over hanging.
- `SecretStore` cached "resolved" instead of the loading promise, so a lookup
  arriving while the D-Bus probe was in flight saw a null module and silently
  downgraded to the file backend for the rest of the process.
- **Saving a server could fail without a word.** Validation refusals were
  written to the subtitle of the bottom-most group in the dialog — below the
  fold — while the row still read "Not tested" and the Save button stayed
  enabled, so pressing Save appeared to do nothing. The reason is now a banner
  at the top of the dialog, Save is disabled until the form can be saved, and
  the editor only closes once the definition *and* the credential are written:
  a keyring or settings failure keeps the dialog open with the input intact and
  reports what went wrong.
- An API token pasted with a trailing newline was sent verbatim in the
  `Authorization` header, which Zabbix answers with a bare 401; the server dialog
  now trims the token and both Access fields.
- The summed network sparkline merged `net.if.in` and `net.if.out` on exact
  timestamp equality. Their clocks differ by seconds, so the curve alternated
  between the two interfaces instead of adding them; samples within half a
  sampling interval now count as one cycle.
- A fresh install showed four tiles, not five: the schema default omitted
  `containers` although the catalog marks it default-enabled.
- A host that has never collected data rendered as a green `0%`: Zabbix answers
  `lastvalue: "0"` *and* `lastclock: "0"` for such items, and the clock is now
  what decides whether a reading exists.
- The probe sent the API token with `apiinfo.version`, which Zabbix 7.4 rejects
  outright ("must be called without authorization header").
- Hosts were shown in ASCII order, so the stock `Zabbix server` host outranked
  the real one and the panel headline read a host with no catalog items.
- The Disk tile now prefers the `/hostfs` item a containerised agent exposes,
  instead of whichever discovered mount happened to be fullest.
- Network tiles read unsigned (`value_type: 3`) items; the previous float-only
  filter dropped them.

### Notes

- Verified end to end against Zabbix 7.0.32 and 7.4.16, including a stack built
  to match the production DeliverEdge topology.
- GJS 1.80 does not expose the WHATWG `URL` constructor; `zabbixEndpoints.js`
  carries a minimal parser instead.
