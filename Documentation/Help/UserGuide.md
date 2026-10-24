# Zappix — user guide

Zappix puts your servers' utilization in the GNOME top panel. Hover the icon, get
a dashboard; move away, it disappears.

---

## First run

1. Install and enable the extension (`make install && make reload`, or your
   distro's package).
2. A ring with a pulse in it appears in the top panel. Hover it — the dropdown
   says **No servers yet**.
3. Click **Add a server**.

### Add a server

| Field | What to enter |
|---|---|
| **Label** | What you want to see in the panel, e.g. `Production`. Defaults to the hostname. |
| **Zabbix URL** | `https://monitor.example.com`, or `https://example.com/zabbix` if Zabbix lives in a subdirectory. Do not include `api_jsonrpc.php`. |
| **Method** | **API token** (recommended) or **Username and password**. |
| **API token** | From Zabbix: *Users → API tokens → Create API token*. It is shown once. |

Press **Test connection**. A working setup answers:

> Connected to Zabbix 7.0.32 — 4 host(s) visible.

If it fails, the message names the layer:

| Message | Meaning |
|---|---|
| `could not resolve …` | the hostname is wrong or DNS is unreachable |
| `TLS certificate was rejected` | self-signed certificate — enable the per-server switch, or fix the chain |
| `rejected the credentials (HTTP 401)` | the token is wrong or expired |
| `refused access (HTTP 403)` | the token's user lacks permission on any host group |
| `API endpoint was not found (HTTP 404)` | the URL is missing or has an extra path segment |
| `did not answer in time` | timeout — raise it on the Monitoring page if the link is slow |

### Getting a token from Zabbix

1. Sign in to the Zabbix frontend as an administrator.
2. **Users → API tokens → Create API token**.
3. Name it `zappix`, leave the expiry blank, choose the user.
4. Copy the token immediately — Zabbix never shows it again.

---

## Using the dropdown

| Action | Result |
|---|---|
| **Hover the icon** | the dropdown opens after ~0.2 s |
| **Move away** | it closes after ~0.4 s — enough time to cross the gap |
| **Click the icon** | opens and stays until you click elsewhere or press Escape |
| **⟳** in the card header | refresh this server now |
| **⟳** in the top row | refresh every server |
| **⚙** | open preferences |
| **Open Zabbix** | open this server's frontend in your browser |
| **Server pills** (top row) | switch which server the card shows; only appears with 2+ servers |

### Reading a tile

```
CPU              ▲       ← metric name, trend caret (up/down over the window)
87%                      ← current value, coloured by severity
▁▂▃▅▇▆▅▃▂▁▂▃▅▇          ← sparkline for the configured window
▬▬▬▬▬▬▬▬▬▬▬▬░░          ← utilization bar (percentage metrics only)
```

Hover a tile to see the Zabbix item it came from — the name and the exact item
key — which is what you need to find it in the frontend.

### Colours

| Colour | Meaning |
|---|---|
| grey | no data — the item is missing, disabled, or the agent is not reporting |
| green | below the warning threshold |
| amber | at or above **Warning at** |
| red | at or above **Critical at** |
| slate | the host is in a Zabbix maintenance window; data is shown, alarms are not |

Colours are identical in light and dark themes, and the panel and the card use
the same hues. A red tile and a red ring always mean the same thing. (On a light
top bar the panel uses deeper shades of the same green, amber and red so they
stay legible.)

### The problem list

Up to three open problems appear under the tiles, worst first: a `NEW` or `ACK`
tag, the problem name, and when it started. `and N more` tells you the list is
truncated — open Zabbix for the rest.

Problems never include recently resolved ones: a recovered incident disappears
rather than lingering as a false alarm.

---

## Preferences

### Servers

Add, edit, reorder or remove servers. Removing one also deletes its stored
token. The **Credential storage** row tells you where tokens live:

* **login keyring** — encrypted, unlocked with your session (preferred)
* **private file (mode 0600)** — used when libsecret is unavailable

Editing a server leaves the token field empty on purpose: empty means "keep the
existing token", so renaming a server never requires handling the credential
again.

**Save stays disabled until the form can actually be saved**, and the reason is
shown in a banner at the top of the dialog — a missing token, an unusable URL, or
half a Cloudflare Access pair. If storing the credential fails, the dialog stays
open with everything you typed still in it and says why, rather than closing and
discarding it.

The dialog also carries an optional **Cloudflare Access** pair. Fill both the
client id and the client secret when the Zabbix hostname is behind an Access
policy; without them the server answers with a login page instead of the API and
the card shows *Cloudflare Access is protecting this hostname*. The client
secret is stored in the keyring beside the API token, never in the list itself.

### Monitoring

| Setting | Default | Notes |
|---|---|---|
| Refresh interval | 30 s | the dropdown always refreshes on open, regardless |
| Request timeout | 10 s | raise it for a slow VPN or tunnel |
| Trend window | 60 min | how much history the sparkline draws |
| Hosts per server | 20 | caps how much a large installation can push at the card |
| Visible metrics | CPU, Memory, Disk, Network, Containers | also available: Swap, Load, Uptime, Processes |
| Warning at / Critical at | 75% / 90% | applies to percentage metrics only |
| New problems | on | notify when a problem appears that was not there before |
| Critical utilization | off | notify when a host crosses the critical threshold |
| Cooldown | 15 min | minimum gap between repeated alerts for the same item |
| Allow untrusted certificates | off | prefer the per-server switch |

### Appearance

| Setting | Default | Notes |
|---|---|---|
| Show a value next to the icon | on | the ring always shows the level; this adds the exact number |
| Panel value | CPU | or Memory, Disk, Open problems |
| Flag open problems on the icon | on | a dot on the ring in the worst problem's colour |
| Open on hover | on | turn off to require a click |
| Hover delay / Close delay | 220 / 360 ms | lower the first for snappier, raise the second if the menu closes too eagerly |
| Keep open until dismissed | off | ignores the hover close timer |
| Density | comfortable | compact fits more hosts; spacious is easier to read |
| Accent | Aurora | palette for highlights and trend fills; severity colours never change |
| Reduce motion | off | disables the connecting pulse and trend caret |
| Verbose logging | off | for bug reports: `journalctl -f -o cat /usr/bin/gnome-shell` |

---

## What the panel shows

The panel is one mark: a ring with a pulse inside it, and a number beside it.

```
 ◔ 42%      ring fills to the value, green / amber / red by your thresholds
 ◕ 81%      amber or red rings also tint the number
 ◔• 12%     dot on the rim: unacknowledged problems, in the worst one's colour
 ⊖ 31%      flatline, dimmed: server unreachable — last good value shown
 ○          empty ring, gently breathing: connecting for the first time
```

* **The ring** fills clockwise from twelve o'clock to the panel metric's
  percentage, coloured by the same thresholds as the tiles. With
  **Open problems** as the panel value, the ring is closed: green when nothing
  is open, amber or red with the count beside it.
* **The number** uses the panel's own font, like the clock and the battery, and
  only changes colour when the metric is amber or red. Turn it off and the ring
  alone still shows the level.
* **The dot on the rim** appears only while the active server has
  unacknowledged problems. It never recolours the metric: an idle CPU stays
  green even when a disk trigger fires.
* **The pulse** flattens into a line while the server is unreachable; the ring
  and number dim but keep the last good value.

The number comes from the **first host of the active server** — the first row in
the card. If you monitor several hosts and care about one in particular, use a
host filter on the server so it sorts first, or set the panel metric to
**Open problems**, which aggregates the whole server.

Screen readers announce the server, the metric and the open-problem count, e.g.
*"Zappix server monitor: Production · CPU 42% · 2 problem(s)"*.

---

## Notifications

Two kinds, both opt-in per type:

* **New problems** — a problem id that was not present on the previous poll.
  The first poll after starting is used as a baseline and announces nothing.
* **Critical utilization** — a metric crossing into red. Announced when it
  crosses, not while it stays there, and at most once per cooldown per metric.

Recovery is not announced. If you want a notification when an incident clears,
that is a Zabbix action (frontend → *Alerts → Actions*), not something the panel
should duplicate.

---

## Troubleshooting

**The icon is there but the dropdown is empty.**
No servers are enabled. Preferences → Servers: check the toggle, and check that
the label is not empty.

**Everything shows a dash.**
The server answers but the hosts have no matching items. Open the card's server
in Zabbix → *Hosts → host → Items* and confirm the template ("Linux by Zabbix
agent") is linked and its items report values. Items with `state: not supported`
carry the agent's error.

**It worked yesterday, now it says "Unreachable".**
The card keeps the last good numbers and shows the error under the title. Expand
the error — it names the layer (DNS, TLS, auth, HTTP status).

**The menu closes the moment it opens.**
Usually a very short *Close delay* combined with a narrow gap between icon and
menu on a scaled display. Raise the delay under Appearance.

**Values are stale.**
"Updated 12m ago" while the refresh interval is 30 s means polls are failing —
the timestamp only advances on success. The error line explains why.

**Nothing appears in the top panel at all.**
The extension failed to load. Run `journalctl -f -o cat /usr/bin/gnome-shell |
grep -i zappix` while enabling it; a schema or import error appears there.
