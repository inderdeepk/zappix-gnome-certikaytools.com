# Connecting Zappix to DeliverEdge

DeliverEdge already runs a monitoring plane. Zappix is a **client of it** — it
does not install, configure or upgrade anything on the server. This page is the
whole procedure: create a token, get past Cloudflare Access, and point the
extension at the host that has the data.

Everything below was verified against the as-built production deployment
(`https://monitoring.deliveredge.ca`) and against a locally built copy of the
same stack (Zabbix 7.4.16, PostgreSQL 17, `zabbix-agent2` with `pid: host`).

---

## 1. The endpoint

| | |
|---|---|
| Web UI / base URL | `https://monitoring.<domain>` — for example `https://monitoring.deliveredge.ca` |
| API endpoint Zappix calls | `https://monitoring.<domain>/api_jsonrpc.php` |
| Container behind it | `monitoring-web:8080`, published on the host as `127.0.0.1:${MONITORING_HOST_PORT:-8082}` for local use |

Enter the **base URL** in Zappix, not the API path: the extension derives
`/api_jsonrpc.php` from it, and accepts a subdirectory if you ever mount Zabbix
under one.

> Zabbix's PHP frontend derives every URL it emits from `SCRIPT_NAME`, which is
> why the monitoring plane is a hostname of its own and never a `/monitoring/`
> sub-path of the main site. Point Zappix at the hostname, and do not try to
> reach it through the DeliverEdge edge nginx.

## 2. Create a read-only API token

In the Zabbix UI: **Users → API tokens → Create API token**.

* **User** — a dedicated account with the built-in `Zabbix user` role (read-only
  on hosts and problems), not `Admin`. Zappix never writes.
* **Expires at** — leave long or never. An expiring token shows up in the panel
  as `The server rejected the credentials (HTTP 401)` the moment it lapses.
* Copy the token now: Zabbix 7.0 and 7.4 both return only `tokenids` from
  `token.create`, so the value is shown exactly once. `token.generate` needs a
  role permission the default `Zabbix user` role does not have.

Paste it into Zappix under **API token**.

One caveat on the role: a role with **API access disabled** authenticates but
fails every call. If the panel reports a permissions error while the same token
works in the UI, check *Administration → User roles → API access*. The stock
`Zabbix user` role has it enabled; a hand-made read-only role may not.

## 3. Get past Cloudflare Access

`monitoring.<domain>` is behind a Cloudflare Access policy, which means a
request that carries a **perfectly valid Zabbix token** is still answered with an
HTML login page. Zabbix reports nothing, because Zabbix never saw the request.

Zappix detects this specifically and says so:

> Cloudflare Access is protecting this hostname. Create a service token …

Create a service token: **Zero Trust → Access → Service auth → Create service
token**. Copy the **Client ID** and **Client Secret**. Then either add a policy
for the monitoring application with action **Service Auth** and that token as
its only include, or add it as an additional include to the existing
email policy.

In Zappix's server dialog, fill **Cloudflare Access → Client ID** and
**Client secret**. Both are required; a lone header is rejected by Access, so a
half-filled pair is treated as absent rather than sent.

The client ID is stored in the server list (it travels in a header beside the
secret, so it is not itself confidential); the client secret goes to the
keyring exactly like the API token, under `zappix-access:<server id>`.

**The alternative** — an Access **Bypass** policy scoped to `/api_jsonrpc.php`
— also works and needs no credentials, but it exposes the API endpoint to the
internet and relies on the Zabbix token alone. Use the service token unless you
have a reason not to.

## 4. Pick the right host

The production plane monitors exactly one host, created by
`scripts/monitoring-provision.py`:

| | |
|---|---|
| Host name | `deliveredge-prod` |
| Host group | `DeliverEdge` |
| Interface | `zabbix-agent2:10050` (passive checks resolved by container name, `useip=0`) |
| Templates | `Linux by Zabbix agent active`, `Docker by Zabbix agent 2` |
| Web scenario | `DeliverEdge readiness` → `{public}/health/` + `/ready/`, every minute, severity High |

A stock Zabbix install also ships a `Zabbix server` host. It sorts **before**
`deliveredge-prod` (uppercase `Z` is lower than lowercase `d` in ASCII) and
matches almost nothing in Zappix's catalog, so the panel would read a host full
of dashes. Two independent defences:

* `orderHosts()` sorts hosts that produced readings first, so the panel headline
  always comes from a host that is actually reporting.
* Set **Host filter** in the server dialog to `deliveredge`. It is a substring
  match on the host name and keeps the self-monitoring host out of the dropdown
  entirely — do this if the server has more than one monitored host.

## 5. What the tiles read

Each tile resolves the first item key in its candidate list that exists on the
host and has reported. Keys below are from the production host.

| Tile | Resolved key | Notes |
|---|---|---|
| CPU | `system.cpu.util` | from the Linux template; falls back to `system.cpu.utilization`, then load average |
| Memory | `vm.memory.util` | percentage |
| Disk | `vfs.fs.size[/hostfs,pused]` | see below |
| Network | `net.if.in["eth0"]` + `net.if.out["eth0"]` | summed; unsigned (`value_type: 3`) with `bps` units |
| Containers | `docker.containers.running` | from `Docker by Zabbix agent 2`; production read 21 running / 3 stopped / 24 total |

**Disk is the one that needs explaining.** The agent container mounts the VPS
root at `/hostfs`, so the filesystem discovery inside the container describes
the container, not the machine. DeliverEdge creates the host item
`vfs.fs.size[/hostfs,pused]` ("Host disk used (%)") by hand, with a `>85` warning
trigger. Zappix lists that key first, then the standard
`vfs.fs.dependent.size[/,pused]`, then `vfs.fs.size[/,pused]`, and only then any
other discovered mount — excluded `/etc/`, `/run/`, `/var/run`, `/dev/` and
`/sys/`, which are bind-mount single files inside the container and report 99 %
forever.

`vfs.fs.dependent.size` never populates on this deployment: `vfs.fs.get` is
unsupported in the agent container (`state = 1`), so the dependent item has no
data. The `/hostfs` item is why the Disk tile works at all.

## 6. Tune the polling

Under **Monitoring**:

* **Refresh interval** — a panel poll is three requests (hosts, items, problems).
  The production server handles a one-minute interval without noticing; do not go
  below 30 s, both for the Zabbix poller and because the `Zabbix server` process
  has its own history-sync work to do.
* **History** — the sparklines only start fetching when the dropdown is open, so
  leaving a long window costs nothing while it is closed.
* **Containers** — on by default because the Docker template is installed. Turn
  it off on hosts without an agent 2 Docker template; the tile degrades to an em
  dash rather than a misleading zero.

## 7. When something is wrong

| What the panel shows | What it means |
|---|---|
| `Cloudflare Access is protecting this hostname` | No service token, or the Access policy does not include it. Section 3. |
| `The server refused access (HTTP 403)` | The token exists but its user's role cannot read that object. |
| `The server rejected the credentials (HTTP 401)` | Token deleted, expired, or mistyped. |
| `The server returned a web page instead of an API response` | Something between you and Zabbix is intercepting — usually an SSO page or a wrong base URL. |
| `The API endpoint was not found (HTTP 404)` | Base URL points at the Zabbix UI's sub-path, or at the DeliverEdge edge instead of the monitoring hostname. |
| Every tile an em dash, host dot grey | Nothing has ever been collected for this host, or the host filter matches nothing. Check the host's **Latest data** in the Zabbix UI. |
| Tile an em dash on a host that works in the UI | That item has no reading. Zabbix answers `lastvalue: "0"` with `lastclock: "0"` for items that never collected; Zappix treats a zero clock as missing rather than as a real zero. |
| Amber/red dot, values a few minutes old | The agent stopped reporting; the card keeps the last good numbers and marks the host stale. |

Zappix retries transient failures with backoff and keeps the previous snapshot
on screen, so a tunnel restart does not blank the dropdown.

## 8. What Zappix will not do

* No writes of any kind: no host or item edits, no maintenance windows, no
  acknowledgements. It is a read-only client. Use the web UI for those.
* No SMTP or alerting. DeliverEdge already wires `Email - Resend API` to the
  administrators; Zappix only surfaces what is open.
* No traffic through the DeliverEdge edge nginx, and no changes to
  `docker-compose.monitoring.yml`.

## See also

* [UserGuide.md](UserGuide.md) — everyday use of the panel.
* [../Technical/API_REFERENCE.md](../Technical/API_REFERENCE.md) — the exact
  methods and parameters Zappix sends.
* [../Technical/SECURITY.md](../Technical/SECURITY.md) — credential storage and
  the threat model for both secrets.
