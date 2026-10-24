# Zabbix API — research reference

> Captured while designing Zappix. This is the source document behind the item
> keys in `src/model/metricCatalog.js` and the version gates in
> `src/api/zabbixEndpoints.js`. Claims are cited against official Zabbix
> documentation; sections marked ⚠ are explicitly uncertain and should be
> re-verified before relying on them.

# Zabbix API Technical Reference for a GNOME Shell System‑Utilization Dashboard

**Scope**: This is a research reference for a GJS/GNOME Shell extension using **libsoup 3.0** to talk directly to a self‑hosted Zabbix server's JSON‑RPC API — no PHP frontend involved. All claims are cited against official Zabbix documentation (version‑pinned where version behavior differs), the `zabbix/zabbix` and `zabbix/zabbix-docker` GitHub repositories, and Zabbix's own API changelogs. Where I could not find a primary source, or where official sources conflict with the user's assumptions, that is called out explicitly rather than guessed. A **🚩** marks a correction to a premise in the original research request; a **⚠** marks genuine uncertainty.

---

## 1. Zabbix API fundamentals

### 1.1 JSON‑RPC 2.0 endpoint and envelope

Zabbix's API is JSON‑RPC 2.0 over HTTP POST to a single endpoint, `api_jsonrpc.php`, served by the same web frontend process (PHP‑FPM/Apache mod_php) that serves the HTML UI. There is no separate API server process. ([zabbix.com/documentation/current/en/manual/api](https://www.zabbix.com/documentation/current/en/manual/api))

Request envelope (per Zabbix's documented convention, a superset‑compatible JSON‑RPC 2.0 shape):

```json
{
    "jsonrpc": "2.0",
    "method": "host.get",
    "params": {
        "output": ["hostid", "host"],
        "filter": { "host": ["Zabbix server"] }
    },
    "id": 1
}
```

- `jsonrpc`: always the literal string `"2.0"`.
- `method`: `"<object>.<action>"`, e.g. `host.get`, `item.get`, `user.login`.
- `params`: an object (or empty array `[]` for parameterless methods like `apiinfo.version`).
- `id`: client-chosen request identifier, echoed back unchanged — useful for matching concurrent async requests in a GJS `Soup.Session` that may have several in flight.

Successful response:

```json
{
    "jsonrpc": "2.0",
    "result": [ { "hostid": "10084", "host": "Zabbix server" } ],
    "id": 1
}
```

Error response — note `error` and `result` are mutually exclusive:

```json
{
    "jsonrpc": "2.0",
    "error": {
        "code": -32602,
        "message": "Invalid params.",
        "data": "No groups for host \"Linux server\"."
    },
    "id": 7
}
```

This exact error example (`-32602` / `"No groups for host..."`) is taken verbatim from the official API intro page. ([zabbix.com/documentation/current/en/manual/api](https://www.zabbix.com/documentation/current/en/manual/api))

**HTTP headers required on every request:**

```
Content-Type: application/json-rpc
```

Zabbix's own `api_jsonrpc.php` source accepts three equivalent content types — confirmed by reading the actual handler (unchanged between the `release/7.0` branch and current `master`):

```php
$allowed_content = [
    'application/json-rpc' => 'json-rpc',
    'application/json' => 'json-rpc',
    'application/jsonrequest' => 'json-rpc'
];
```
`zabbix/zabbix:ui/api_jsonrpc.php:28-32` (verified on both `master` and `release/7.0`). Any other `Content-Type` → immediate `HTTP/1.0 412 Precondition Failed` with an empty body (`ui/api_jsonrpc.php:39-41`) — a GJS client that forgets this header will get a 412, not a JSON‑RPC error object, which is worth special‑casing in error handling.

### 1.2 Authentication: `auth` property vs. `Authorization` header — precise version timeline

This is the area where the original request's framing needed the most correction, and where version‑exact behavior matters most for a client that should work against "whatever LTS the user happens to run." I fetched the **archived, version‑pinned** docs for 6.0, 6.4, 7.0, and 7.2, plus the official **API changelogs** (`/api/changes`), which turned out to be the authoritative, dated source for every transition below.

#### The three methods, as currently documented

As of current docs (resolves to Zabbix 7.4 — confirmed below), exactly two authorization methods are documented for API clients, plus one frontend‑internal method:

1. **By `Authorization` HTTP header** (recommended, works for both session tokens and API tokens)
2. **By Zabbix cookie** (frontend‑internal session cookie; not relevant to an external API client)
3. ~~By `auth` property~~ — **removed**, see below.

([zabbix.com/documentation/current/en/manual/api](https://www.zabbix.com/documentation/current/en/manual/api))

Header form (exact text from current docs):

```
Authorization: Bearer <token>
```

#### Exact version timeline (primary-sourced)

| Version | `auth` top-level JSON property | `Authorization` header | Notes |
|---|---|---|---|
| ≤ 6.2 and earlier | **Only** method | Not supported | `auth` is a **sibling of `method`/`params`/`id`** in the request body, *not* nested inside `params`. Example from the 6.0 docs: `"auth": "0424bd59b807674191e7d77572075f33"`. |
| **6.4** | Still works, **newly marked deprecated** | **Introduced** | Official changelog: *"Authorization method changed from `auth` parameter to `Authorization` header."* and *"Deprecated parameter `auth`."* (ticket ZBXNEXT‑8051). Docs added explicit text: *"Note that the `auth` property is deprecated. It will be removed in the future releases."* |
| **7.0** | Still works, still deprecated | Supported | Both documented in parallel; 7.0 LTS retains `auth` for the whole LTS lifecycle. CORS support for the header and case‑insensitive header matching were **backported** at specific 7.0 patch releases (see below). |
| **7.2** | **Removed** | Only method (+cookie) | Official changelog, "Backward incompatible changes → API": *"Removed support for deprecated property `auth`."* (ticket ZBXNEXT‑9452). Sending `"auth": "..."` as a top-level property on 7.2+ now fails with a strict‑validation error (`unexpected parameter "auth"`). |
| 7.4 / current | n/a (gone) | Only method (+cookie) | CORS/case-insensitivity text appears as unconditional baseline behavior, no version qualifier. |

Sources: [6.0 docs](https://www.zabbix.com/documentation/6.0/en/manual/api) · [6.4 docs](https://www.zabbix.com/documentation/6.4/en/manual/api) · [6.4 API changelog](https://www.zabbix.com/documentation/6.4/en/manual/api/changes) (§ "Other changes and bug fixes → API") · [7.0 docs](https://www.zabbix.com/documentation/7.0/en/manual/api) · [7.2 docs](https://www.zabbix.com/documentation/7.2/en/manual/api) · [7.2 API changelog](https://www.zabbix.com/documentation/7.2/en/manual/api/changes) (§ "Backward incompatible changes → API", citing [ZBXNEXT‑9452](https://support.zabbix.com/browse/ZBXNEXT-9452)) · [current docs](https://www.zabbix.com/documentation/current/en/manual/api).

This matches Zabbix's own, explicitly stated general deprecation policy (found on the current `/manual/api` page, § "API versions"):

> "Zabbix guarantees feature backward compatibility inside a major version. When making backward incompatible changes between major releases, Zabbix usually leaves the old features as deprecated in the next release, and only removes them in the release after that."

— i.e. deprecate-one-cycle-then-remove is the house rule, and `auth` followed it almost exactly (deprecated at 6.4, survived 7.0 deprecated, removed at 7.2 — two cycles, slightly more lenient than the minimum stated).

#### CORS and case‑insensitive header matching — patch-level precision

Both 7.0 and 7.2 docs state CORS and header‑casing fixes landed at **different patch numbers per branch** (these are backports, not simultaneous):

- **7.0 branch**: *"Since Zabbix 7.0.7, the Authorization header is supported in cross-origin requests (CORS). Since Zabbix 7.0.11, Zabbix API accepts headers in a case-insensitive way."*
- **7.2 branch**: *"Since Zabbix 7.2.1, the Authorization header is supported in cross-origin requests (CORS). Since Zabbix 7.2.5, Zabbix API accepts headers in a case-insensitive way."*

**Practical implication for a GJS client**: this patch-level nuance is irrelevant for CORS specifically (see §3.4 — CORS is wide open at the server level regardless, and doesn't apply to non-browser HTTP clients like libsoup anyway), but the **case-insensitive header matching** patch level matters if you're troubleshooting against an older 7.0.0–7.0.6 or 7.2.0 server and your HTTP layer happens to normalize header casing unusually — send the header as literally `Authorization` to be safe on every version.

#### Recommendation for new code

**Always use the `Authorization: Bearer <token>` header**, regardless of which Zabbix version you target (6.0 is the oldest version in the request's scope, and the header method has existed since 6.4; since the extension presumably targets "a reasonably current self-hosted Zabbix," there's no reason to implement the legacy `auth`-property fallback at all unless you specifically need to support Zabbix ≤ 6.2).

#### `user.login` (session token) request/response

```json
{
    "jsonrpc": "2.0",
    "method": "user.login",
    "params": {
        "username": "Admin",
        "password": "zabbix"
    },
    "id": 1
}
```
```json
{
    "jsonrpc": "2.0",
    "result": "6bea2cae2e5a2bf3f3d6a2ab2f31c",
    "id": 1
}
```
`result` is an opaque session token string; use it as the Bearer token on subsequent calls. Note: in **6.0 and earlier**, the login param was historically named `user` (not `username`); `user` was removed as a deprecated parameter of `user.login` at Zabbix 6.4 (ticket ZBXNEXT‑8085, per the [6.4 changelog](https://www.zabbix.com/documentation/6.4/en/manual/api/changes)) — use `username` for anything 6.4+.

`user.login` is one of the few methods **callable without any prior authentication** (self-evidently — you need it to *get* a token).

#### `user.logout`

```json
{ "jsonrpc": "2.0", "method": "user.logout", "params": [], "id": 1 }
```
(with the `Authorization` header set to the token being invalidated). Returns `"result": true` on success. Invalidates the session token server-side; the next call with that token returns the "session terminated" error. There is no equivalent "revoke" call for a pre-created API token via `user.logout` — use `token.delete` instead (§ below) or let it expire/`token.update` with `status: 1` to disable it.

#### API tokens — `token.create` / `token.generate`

For a long-lived desktop extension, a **pre-created API token** (Administration → API tokens in the UI, or via the API) is generally nicer than a session obtained through `user.login`, because:
- It doesn't require storing the account password in the extension's settings.
- It can be scoped to a specific user with a restricted role.
- It can have an explicit expiry (or none).
- It survives Zabbix frontend restarts/cache reloads, whereas session tokens from `user.login` behave like a login session.

Two-step creation:

```json
{
    "jsonrpc": "2.0",
    "method": "token.create",
    "params": {
        "name": "gnome-dashboard",
        "userid": "1",
        "expires_at": "0"
    },
    "id": 1
}
```
→ returns `{"result": {"tokenids": ["12"]}}` (creates the *token object/metadata*, not yet a usable secret).

```json
{
    "jsonrpc": "2.0",
    "method": "token.generate",
    "params": ["12"],
    "id": 2
}
```
→ returns the actual bearer string, shown **only once**:
```json
{ "result": [ { "tokenid": "12", "token": "052e...redacted...c9a1" } ] }
```

`token` object fields (from [`token/object`](https://www.zabbix.com/documentation/current/en/manual/api/reference/token/object)): `tokenid` (read-only), `name` (required on create), `description`, `userid` (default: current user, constant after create), `lastaccess` (read-only, `"0"` if never used), `status` (0=enabled default / 1=disabled), `expires_at` (`"0"` = never expires), `created_at` (read-only), `creator_userid` (read-only).

#### Version-by-version "how is the token sent" summary

| Version | Session token from `user.login` | Pre-created API token |
|---|---|---|
| 6.0 | `"auth": "<token>"` top-level property | `"auth": "<token>"` top-level property (same mechanism — tokens and session strings are interchangeable at the transport level) |
| 6.4 – 7.0 | `Authorization: Bearer <token>` (preferred) or deprecated `auth` property (still works) | same — both forms accepted |
| 7.2+ | `Authorization: Bearer <token>` **only** | `Authorization: Bearer <token>` **only** |

### 1.3 Version detection: `apiinfo.version`

```json
{ "jsonrpc": "2.0", "method": "apiinfo.version", "params": [], "id": 1 }
```
```json
{ "jsonrpc": "2.0", "result": "7.4.0", "id": 1 }
```

Key properties, confirmed directly from the method's reference page ([apiinfo.version](https://www.zabbix.com/documentation/current/en/manual/api/reference/apiinfo/version)):
- **Callable without authentication** — no `Authorization` header needed. This makes it the ideal first call for a GJS extension's "detect server + capability-gate features" bootstrap step, before you even have credentials configured.
- *"Starting from Zabbix 2.0.4 the version of the API matches the version of Zabbix."* — i.e. you get a real product version string (`"7.4.0"`), not a separate "API version number."
- The returned string's source is `CAPIInfo::version()` in `ui/include/classes/api/services/CAPIInfo.php`.

🚩 **On the `X-Zabbix-API-Version` HTTP response header**: I could **not confirm this header exists**. I searched the live `api_jsonrpc.php` request-handling path (`ui/api_jsonrpc.php` and `ui/include/classes/core/CJsonRpc.php`) on both the `release/7.0` branch and current `master`, and the only HTTP headers the API ever sets are the CORS headers and `Content-Type: application/json` (plus, on bleeding-edge `master`, some unrelated experimental `X-HPKE-*`/`X-Recipient-ID` headers tied to an in-development encrypted-transport feature, and `Bearer`/`DPoP` auth-header *type* constants — none of this is an API-version header). I could not find any mention of `X-Zabbix-API-Version` anywhere in the official API documentation either. **My best assessment is that this header does not exist** and the request's premise about it should be treated as a misconception — possibly confusion with a different product, or with the fact that the HTML *frontend* (not the JSON-RPC API) does expose its version in a meta-tag/footer. **Use `apiinfo.version` exclusively for version detection** — it's simple, unauthenticated, documented, and empirically verified via source.

### 1.4 Error shapes and common codes

Standard JSON-RPC 2.0 error object: `{"code": <int>, "message": <string>, "data": <string|null>}`. Zabbix's `message` is a short constant category string; `data` carries the specific, human-readable detail (and is the field you actually want to show/log).

Codes Zabbix's own docs explicitly demonstrate or reference in context:

| Code | `message` | Meaning / when seen |
|---|---|---|
| `-32700` | Parse error | Malformed JSON body |
| `-32600` | Invalid Request | Missing `jsonrpc`/`method`, structurally wrong envelope |
| `-32601` | Method not found | Typo'd method name, or method exists but not exposed to current API/role |
| `-32602` | Invalid params | Bad filter/parameter — directly confirmed by the official doc's own example: `"data": "No groups for host \"Linux server\"."` |
| `-32603` | Internal error | Server-side exception |
| `-32500` | Application error | ⚠ **Not found in the primary `/manual/api` documentation** in any version I checked. This code is widely reported in community posts/forums/StackOverflow for authentication failures (bad/expired token, insufficient permissions) and is almost certainly real in practice, but I am flagging it as **not officially documented** rather than asserting it with false confidence. Treat any `-325xx`-range code defensively (log `data` and fail gracefully) rather than hardcoding exact behavior. |

A practical, robust client-side rule: don't branch application logic on `error.code` beyond "auth failed vs. everything else" (detectable by re-attempting login/logout and observing whether subsequent authenticated calls succeed) — always surface `error.data` to the user/log, since that's where the actually-useful diagnostic text lives.

### 1.5 Performance characteristics / rate-limiting

There is **no dedicated official "API performance best practices" page** — this guidance is synthesized from documented parameter semantics plus one explicit quote from the main API page:

> *"For performance reasons it is always recommended to list the object properties you want to retrieve."* — i.e., **always pass an explicit `output` array**; never rely on the default (which for many methods is `"extend"`, returning every property including heavy ones like `item.parameters`, `host.inventory`, etc.) ([zabbix.com/documentation/current/en/manual/api](https://www.zabbix.com/documentation/current/en/manual/api)).

Concrete guidance for a dashboard polling loop, derived from parameter semantics documented on each method's reference page:

1. **Batch, don't loop per-host.** `item.get` (and `host.get`) accept **array** `hostids`/`itemids`/`filter` values — fetch all hosts' items in one call (`"hostids": ["10084","10085","10086"]`) rather than one request per host. Zabbix's own UI does this for its own dashboard widgets.
2. **Use `filter` (exact match) over `search` (substring/LIKE) wherever possible** — `filter` is indexed-equality and cheap; `search` does a `LIKE '%...%'` and is comparatively expensive at scale, especially on `history`/`item` tables. Reserve `search` for user-facing "find a host by typed name fragment" UI, not for the dashboard's steady-state polling.
3. **Never poll `history.get` without `time_from`/`limit`.** Without bounds, `history.get` will attempt to return the **entire retention window** for the matched items — on a long-running production item this can be hundreds of thousands of rows. Always pair it with `sortfield: clock, sortorder: DESC, limit: N` (see §2.5).
4. **Use `trend.get` instead of `history.get` for any range beyond roughly an hour** — trends are pre-aggregated (1 row/hour/item) so a 7-day chart is ~168 rows instead of potentially millions of raw history rows (see §2.6).
5. **Prefer `lastvalue`/`prevvalue` via `item.get`** over a dedicated `history.get` call when you only need "what's the current reading" — this is a single cheap in-row read rather than a second query against the (much larger) history tables (see §2.8 for the important caveat about this).
6. **Poll on a sane interval that matches your items' `delay`.** Querying `lastvalue` every second for an item whose own agent-side `delay` is `1m` just repeats the same value 59 times — align your GLib timeout to roughly the item's own update interval (which you can read from `item.get`'s `delay` field) rather than hardcoding an arbitrary fast poll.
7. There is a server-side `LoginAttempts`/pause mechanism (5 failed login attempts → 30 second lockout, documented in §4.3) but this applies to the frontend login form; API error responses on bad auth should still be handled gracefully (back off, don't hot-loop retry `user.login` on every failure).

---

## 2. API calls for a system-utilization dashboard

### 2.1 `host.get`

Minimal "list monitored hosts" request:

```json
{
    "jsonrpc": "2.0",
    "method": "host.get",
    "params": {
        "output": ["hostid", "host", "name", "status"],
        "selectInterfaces": ["interfaceid", "ip", "dns", "useip", "port", "type", "main"],
        "selectHostGroups": ["groupid", "name"],
        "filter": { "status": 0 }
    },
    "id": 1
}
```

Key parameters relevant to a dashboard:

- **`selectInterfaces`** — embeds each host's interface objects (IP/DNS/port/type) inline, avoiding a separate `hostinterface.get` round-trip when you just need "what address is this host's agent on."
- **`selectHostGroups`** — embeds the host's group memberships.
- 🚩 **`selectGroups` vs `selectHostGroups`**: `selectGroups` was the **original** parameter name for this; it still works through Zabbix 7.0, but was **formally removed in 7.2** per the official changelog: *"`host.get`: Removed support for deprecated parameter `selectGroups`."* (ticket ZBXNEXT‑9452, [7.2 API changelog](https://www.zabbix.com/documentation/7.2/en/manual/api/changes)). **Use `selectHostGroups`** for any new code — it has been available in parallel for a long time and is the only one guaranteed to keep working on 7.2+.
- **`filter`** — exact-match filtering, e.g. `{"host": ["server1","server2"]}` (matches the technical, non-visible `host` field) or `{"status": 0}` (monitored hosts only).
- **`search`** — substring/LIKE matching, e.g. `{"name": "web"}`; combine with `"searchWildcardsEnabled": true` to allow `*` wildcards.
- **`monitored_by`** — filter by monitoring source: `0` = server, `1` = proxy, `2` = proxy group (this parameter exists because a host can be monitored directly by `zabbix-server` or routed through a `zabbix-proxy`; relevant if your self-hosted setup ever adds a proxy).
- **`status`** — 0 = monitored (enabled), 1 = unmonitored (disabled). This is purely an **administrative on/off toggle for whether the host is being checked at all** — it is **not** a live connectivity/availability indicator. A host can have `status: 0` (monitoring enabled) while its agent is completely unreachable; you must check `hostinterface.available`/`error` for that (§2.9, §5).

Response shape (abbreviated):

```json
{
    "jsonrpc": "2.0",
    "result": [
        {
            "hostid": "10084",
            "host": "Zabbix server",
            "name": "Zabbix server",
            "status": "0",
            "interfaces": [
                { "interfaceid": "1", "ip": "127.0.0.1", "dns": "", "useip": "1", "port": "10050", "type": "1", "main": "1" }
            ],
            "hostgroups": [ { "groupid": "2", "name": "Linux servers" } ]
        }
    ],
    "id": 1
}
```

(Source for field semantics: [`host/object`](https://www.zabbix.com/documentation/current/en/manual/api/reference/host/object), [`host.get`](https://www.zabbix.com/documentation/current/en/manual/api/reference/host/get).)

### 2.2 `hostgroup.get`

```json
{
    "jsonrpc": "2.0",
    "method": "hostgroup.get",
    "params": {
        "output": ["groupid", "name"],
        "real_hosts": true
    },
    "id": 1
}
```
Use this to populate a "filter by group" picker in the dashboard UI. Note: `monitored_hosts`/`real_hosts` **filter parameters on `hostgroup.get` itself** were deprecated and then **removed at 7.2** per the same ZBXNEXT‑9452 cleanup — if targeting 7.2+, fetch all groups and filter client-side, or use `hostgroup.get` with a `host.get`-driven group-ID set instead.

### 2.3 `hostinterface.get`

```json
{
    "jsonrpc": "2.0",
    "method": "hostinterface.get",
    "params": {
        "output": "extend",
        "hostids": ["10084"]
    },
    "id": 1
}
```

`hostinterface` object fields relevant to a "is monitoring actually working" indicator ([`hostinterface/object`](https://www.zabbix.com/documentation/current/en/manual/api/reference/hostinterface/object)):

- `type`: 1=Agent, 2=SNMP, 3=IPMI, 4=JMX.
- `main`: whether this is the default interface of its type on the host (only one interface per type can be `main` on a given host).
- `available` (**read-only**): 0=unknown, 1=available, 2=unavailable — this is the actual live connectivity flag.
- `error` (**read-only**): last connectivity error text (e.g., "Connection refused by host").
- `errors_from` / `disable_until` (**read-only**): timestamps supporting Zabbix's internal backoff logic for unreachable interfaces.

This is the correct place to build a dashboard's "host offline" badge — poll `available`/`error` here (or via `host.get` + `selectInterfaces`), **not** `host.status`.

### 2.4 `item.get` — the Linux by Zabbix agent template's real item keys

I verified this section directly against the **official template source YAML** in `zabbix/zabbix` (`templates/os/linux/template_os_linux.yaml`), comparing the `release/7.0` and `release/7.4` branches (keys are byte-for-byte identical between them, only line offsets differ — confirmed via diff, so this table applies to 7.0 LTS through 7.4 without caveats). This matters because **several of the key names assumed in the original brief do not exist** — here is the corrected, exact reference.

#### Finding items on a host generically

```json
{
    "jsonrpc": "2.0",
    "method": "item.get",
    "params": {
        "output": ["itemid", "name", "key_", "value_type", "units", "lastvalue", "lastclock", "status", "state"],
        "hostids": ["10084"],
        "search": { "key_": "system.cpu" },
        "sortfield": "name"
    },
    "id": 1
}
```
`search` on `key_` with a prefix like `"system.cpu"` or `"vfs.fs"` is the practical, version-proof way to discover what a given host actually has — **don't hardcode guessed keys**, especially for the LLD-driven ones below, since their key strings embed runtime-discovered names you cannot predict in advance (interface names, mount points).

#### 🚩 Corrections to the originally-assumed key names

| Assumed in brief | **Reality (confirmed in template YAML)** |
|---|---|
| `system.cpu.utilization` (with `[idle]`/`[user]`/`[system]` params) | **No such key exists.** The real prefix is **`system.cpu.util`** (no "-ization"). `system.cpu.util` *with no brackets* is a separate, specific **dependent item** (see below); the per-mode breakdowns use `system.cpu.util[,<mode>]`. |
| `vm.memory.utilization` | **No such key.** Real key is **`vm.memory.util`** (no "-ization"). |
| `system.cpu.load[percpu,avg1]` | Template actually ships **`system.cpu.load[all,avg1]`** (mode parameter is literally `all`, not `percpu` — see flagged discrepancy below). |
| `vfs.fs.size[/,pfree]` / `vfs.fs.size[/,pused]` | **Not what the template creates.** `vfs.fs.size[<mountpoint>,<mode>]` is a real, generic Zabbix-agent key you *can* manually create an item against (see `/manual/config/items/itemtypes/zabbix_agent`), but the **stock template never creates such a static item**. Instead it runs **low-level discovery** (LLD) and creates **dependent items** keyed `vfs.fs.dependent.size[{#FSNAME},pused]` etc., where `{#FSNAME}` is replaced at discovery time with the actual discovered mount point (e.g. `/`, `/home`). You cannot guess this key — discover it via `item.get` with `search: {"key_": "vfs.fs.dependent"}`. |
| `net.if.in[if,bytes]` / `net.if.out[if,bytes]` | Close, but not exact. `bytes` is the **default/implicit mode** when the second parameter is omitted on the generic agent key — the template's shipped item key is literally **`net.if.in["{#IFNAME}"]`** (LLD-driven, no explicit `bytes` token), where `{#IFNAME}` becomes the real interface name (e.g. `eth0`) at discovery time. |

#### Dependent items — CPU and memory "utilization" are computed, not raw-polled

Both headline utilization metrics are **Dependent items** (`type: DEPENDENT`), meaning the server/proxy computes them from a separately-polled raw item via a small JavaScript preprocessing step — they are **not themselves sent by the agent**:

**CPU utilization** (`templates/os/linux/template_os_linux.yaml`, confirmed identical on `release/7.0` and `release/7.4`):
```yaml
- name: 'CPU utilization'
  type: DEPENDENT
  key: system.cpu.util
  value_type: FLOAT
  units: '%'
  preprocessing:
    - type: JAVASCRIPT
      parameters: ['return (100 - value)']
  master_item:
    key: 'system.cpu.util[,idle]'
```
i.e. **CPU utilization % = 100 − `system.cpu.util[,idle]`**.

**Memory utilization**:
```yaml
- name: 'Memory utilization'
  type: DEPENDENT
  key: vm.memory.util
  value_type: FLOAT
  units: '%'
  description: 'The percentage of used memory is calculated as `100-pavailable`.'
  preprocessing:
    - type: JAVASCRIPT
      parameters: ['return (100-value);']
  master_item:
    key: 'vm.memory.size[pavailable]'
```
i.e. **Memory utilization % = 100 − `vm.memory.size[pavailable]`**.

Practically: when you `item.get` these keys, you get the already-computed percentage directly (preprocessing happens before storage, so `history.get`/`lastvalue` both return the post-computation value) — you do **not** need to replicate the `100 - x` math client-side. The dependent-item detail matters mainly for understanding *why* `system.cpu.util[,idle]` must also exist/be enabled on the host for `system.cpu.util` to have any data, and for explaining gaps if someone has disabled the idle/pavailable sub-item.

#### Full item-key reference table (Linux by Zabbix agent, 7.0–7.4)

| Metric | Key | Type | `value_type` | Units | Notes |
|---|---|---|---|---|---|
| CPU utilization (overall) | `system.cpu.util` | Dependent (`100 - idle`) | FLOAT (0) | `%` | Headline metric |
| CPU idle | `system.cpu.util[,idle]` | Agent | FLOAT (0) | `%` | Master item for the above |
| CPU user/system/nice/iowait/steal/interrupt/softirq/guest/guest_nice | `system.cpu.util[,<mode>]` | Agent | FLOAT (0) | `%` | 8 more per-mode breakdowns, all plain (non-dependent) FLOAT items |
| Load average 1/5/15 min | `system.cpu.load[all,avg1\|avg5\|avg15]` | Agent | FLOAT (0) | *(none)* | ⚠ see discrepancy note below |
| CPU core count | `system.cpu.num` | Agent | *(omitted → likely UNSIGNED, see note)* | *(none)* | `DISCARD_UNCHANGED_HEARTBEAT 1d` preprocessing (only re-stored if changed, else heartbeat daily) |
| Memory utilization (overall) | `vm.memory.util` | Dependent (`100 - pavailable`) | FLOAT (0) | `%` | Headline metric |
| Memory available | `vm.memory.size[available]` | Agent | *(omitted)* | `B` | "free + buffers + cache" on Linux |
| Memory available % | `vm.memory.size[pavailable]` | Agent | FLOAT (0) | `%` | Master item for `vm.memory.util` |
| Memory total | `vm.memory.size[total]` | Agent | *(omitted)* | `B` | |
| Swap free | `system.swap.size[,free]` | Agent | *(omitted)* | `B` | |
| Swap free % | `system.swap.size[,pfree]` | Agent | FLOAT (0) | `%` | Matches brief's original guess exactly |
| Swap total | `system.swap.size[,total]` | Agent | *(omitted)* | `B` | |
| Filesystem space (per discovered mount) | `vfs.fs.dependent.size[{#FSNAME},free\|total\|used\|pused]` | Dependent (JSONPATH from `vfs.fs.dependent[{#FSNAME},data]`) | FLOAT for `pused`; *(omitted, bytes)* for free/total/used | `%` or `B` | LLD-driven — discover real `{#FSNAME}` values first |
| Filesystem inodes free % | `vfs.fs.dependent.inode[{#FSNAME},pfree]` | Dependent | *(omitted)* | *(none)* | LLD-driven |
| Network in (rate) | `net.if.in["{#IFNAME}"]` | Agent, with `CHANGE_PER_SECOND` + `MULTIPLIER 8` preprocessing | *(omitted)* | `bps` (**bits**/sec) | ⚠ Stored value is an already rate-converted, already bytes→bits-multiplied **bits-per-second float**, not a raw monotonic byte counter — see note below |
| Network out (rate) | `net.if.out["{#IFNAME}"]` | Agent, same preprocessing | *(omitted)* | `bps` | Same caveat |
| Network in/out errors, dropped | `net.if.in["{#IFNAME}",errors\|dropped]`, `net.if.out["{#IFNAME}",errors\|dropped]` | Agent, `CHANGE_PER_SECOND` | *(omitted)* | *(none, rate/sec)* | LLD-driven |
| System uptime | `system.uptime` | Agent | *(omitted)* | `uptime` (special formatting unit) | `trends: 0` — **trend storage explicitly disabled** for this item in the template; only `history.get` will ever return data for it |
| Process count (total) | `proc.num` | Agent | *(omitted)* | *(none)* | No brackets in the shipped item (bare key) |
| Process count (running) | `proc.num[,,run]` | Agent | *(omitted)* | *(none)* | Generic key is `proc.num[<name>,<user>,<state>]`; template only sets the 3rd positional param |
| Boot time | `system.boottime` | Agent | *(omitted)* | `unixtime` | `delay: 15m`, `DISCARD_UNCHANGED_HEARTBEAT 1h` |
| Logged-in users | `system.users.num` | Agent | *(omitted)* | *(none)* | |

Sources: `zabbix/zabbix:templates/os/linux/template_os_linux.yaml` (`release/7.0` and `release/7.4` branches; item blocks for CPU at lines ~145–320, memory/swap/uptime at ~424–605, network LLD at ~624–725, filesystem LLD at ~1154–1340 in the 7.4 copy).

⚠ **Flagged discrepancies, stated honestly rather than resolved by guessing:**

1. **`system.cpu.load[all,avg1]` vs. its own description.** The item's mode parameter is literally `all` (matching the generic Zabbix-agent key's "average load of all processors, unmodified" semantic — the classic Unix load-average number), yet the template's own shipped `description:` field for this exact item reads: *"Calculated as the system CPU load divided by the number of CPU cores."* That description reads like the behavior of the *other* documented mode, `percpu`. This is Zabbix's own template text, reproduced here verbatim because it is internally inconsistent — I cannot resolve from static inspection alone whether the value is actually core-normalized at runtime or whether the description is simply copy-pasted incorrectly from the `percpu` variant. **If your dashboard needs to assert "load average per core," verify empirically** against a host with a known core count (compare the live value to `system.cpu.num` and to `uptime`'s reported load average) rather than trusting either the key or the description alone.
2. **Network traffic items store a derived rate, not a raw counter.** Because of the `CHANGE_PER_SECOND` + `MULTIPLIER(8)` preprocessing chain, `history.get`/`lastvalue` for `net.if.in["eth0"]` returns an already-computed **bits-per-second** float — this is convenient for a sparkline/gauge (no client-side math needed) but means you cannot recover the raw cumulative byte counter from this item; if you need that, you'd have to create your own plain (non-template) item against the generic `net.if.in[<if>,bytes]` agent key.
3. **Exact `value_type` for items that omit it in the YAML.** Across the whole template, 29 items explicitly declare `value_type: FLOAT`, 7 declare `CHAR`, 3 declare `TEXT`, and **zero** explicitly declare `UNSIGNED` — strongly suggesting the template-export tool's convention is to omit the field when it equals `UNSIGNED` (3), the apparent default for byte-counts/plain-counters in this template (memory/swap bytes, uptime seconds, proc/user counts, network error/dropped counters). However, the API's own `item/object` reference states `value_type` is **"required for create operations"** with no stated default — meaning this is an export-tool/YAML-schema convention, not a documented API-level default, and I was unable to find an official page stating the YAML schema's default explicitly. **Do not hardcode this assumption** — the robust approach (and the one that also solves gotcha §5.1) is to always read the live `value_type` from `item.get` for the specific host/item you're querying, rather than assuming it from the template source.

#### Example: querying CPU/memory/uptime for a host

```json
{
    "jsonrpc": "2.0",
    "method": "item.get",
    "params": {
        "output": ["itemid", "name", "key_", "value_type", "units", "lastvalue", "lastclock"],
        "hostids": ["10084"],
        "filter": {
            "key_": ["system.cpu.util", "vm.memory.util", "system.uptime", "system.cpu.load[all,avg1]"]
        }
    },
    "id": 1
}
```

### 2.5 `history.get`

`value_type` **enum** (confirmed via [`item/object`](https://www.zabbix.com/documentation/current/en/manual/api/reference/item/object), which now documents a **sixth** value beyond the brief's assumed 0–4 range):

| Code | Meaning |
|---|---|
| 0 | numeric float |
| 1 | character |
| 2 | log |
| 3 | numeric unsigned |
| 4 | text |
| **5** | **binary** ⚠ exact introduction version not independently re-confirmed this session; it exists in current docs and is used for things like browser-monitoring screenshot data. Treat as "exists on reasonably current Zabbix, version of introduction uncertain" rather than asserting a specific release. |

**Critical rule**: `history.get`'s `history` parameter **must match the queried item's actual `value_type`**, or you get an **empty result set with no error** (see §5 gotcha). You must `item.get` first (or already know the item) to find out which `history` value to pass.

```json
{
    "jsonrpc": "2.0",
    "method": "history.get",
    "params": {
        "output": "extend",
        "history": 0,
        "itemids": ["23296"],
        "sortfield": "clock",
        "sortorder": "DESC",
        "limit": 1
    },
    "id": 1
}
```

Parameters:
- `history`: the value-type code (0/1/2/3/4/[5]) — required, no default, must match the item.
- `itemids`: array, can batch multiple items of the **same** `value_type` in one call (items of different `value_type`s live in different physical history tables, so you cannot mix a float item and a text item in the same `history.get` call even though you can mix multiple items that share the same `value_type`).
- `time_from` / `time_till`: Unix timestamps (seconds). Omitting both and relying only on `limit`+`sortorder: DESC` is the normal way to fetch recent data without needing to compute a "now" timestamp client-side.
- `sortfield: "clock"`, `sortorder: "DESC"`, `limit: N`: the standard "give me the last N values" idiom.

**Getting the latest single value efficiently**: two equally valid approaches —
1. `history.get` with `sortorder: DESC, limit: 1` (as above) — always correct, always current, costs one history-table row scan per item.
2. `item.get`'s `lastvalue`/`lastclock` output fields (§2.8) — potentially cheaper (no history-table hit) but has an important display-window caveat (see §2.8) that `history.get` does not share.

**Sparkline (short time series) for the last hour:**

```json
{
    "jsonrpc": "2.0",
    "method": "history.get",
    "params": {
        "output": "extend",
        "history": 0,
        "itemids": ["23296"],
        "time_from": 1700000000,
        "sortfield": "clock",
        "sortorder": "ASC"
    },
    "id": 1
}
```
`time_from` here would be computed client-side as `now_unix - 3600` (GJS: `GLib.DateTime.new_now_utc().to_unix() - 3600`) — Zabbix's API does **not** accept relative time expressions like `"now-1h"` as a JSON-RPC parameter value (that syntax is a **frontend URL/graph-time-range convention**, e.g. for dashboard `?from=now-1h&to=now` query strings — not something `history.get`'s `time_from` parameter itself parses). Compute an absolute Unix timestamp in the client.

Response item shape (for `history: 0`, i.e. float):
```json
{ "result": [ { "itemid": "23296", "clock": "1700000042", "value": "12.3456", "ns": "123000000" } ] }
```
`clock` = Unix **seconds**; `ns` = nanosecond remainder within that second (for sub-second ordering of same-clock values). Both are always UTC — Zabbix stores and transmits epoch seconds regardless of the server/frontend's configured display timezone (`PHP_TZ` in the Docker image only affects the *rendered* frontend, never the API's raw numbers — see §5 timezone gotcha).

### 2.6 `trend.get`

For any chart range beyond roughly an hour, use pre-aggregated hourly trend records instead of raw history:

```json
{
    "jsonrpc": "2.0",
    "method": "trend.get",
    "params": {
        "output": "extend",
        "itemids": ["23296"],
        "time_from": 1699900000,
        "time_till": 1700000000
    },
    "id": 1
}
```
Each row represents one hour and includes `clock`, `num` (sample count that hour), `value_min`, `value_avg`, `value_max` — useful for a "24h CPU trend" sparkline rendered as a min/avg/max band rather than a raw line. Trends are only stored for items whose `trends` storage period is non-zero — recall `system.uptime` in the template explicitly sets `trends: 0`, so `trend.get` will return **nothing** for uptime regardless of range; you must fall back to `history.get` (bounded by the item's `history` retention, default 31 days per `item/object`) for that specific item.

### 2.7 `problem.get` / `trigger.get` — alert counts

```json
{
    "jsonrpc": "2.0",
    "method": "problem.get",
    "params": {
        "output": "extend",
        "hostids": ["10084"],
        "recent": false,
        "sortfield": ["eventid"],
        "sortorder": "DESC"
    },
    "id": 1
}
```
`problem.get` returns **currently open** problems (i.e., unresolved alerts) — the natural source for a dashboard's "N active alerts" badge/count. Pair with `severity` (array of minimum severity filter) to show only Warning+ or Average+ problems if you want to avoid badge noise from Informational-level triggers.

```json
{
    "jsonrpc": "2.0",
    "method": "trigger.get",
    "params": {
        "output": ["triggerid", "description", "priority", "value"],
        "hostids": ["10084"],
        "filter": { "value": 1 },
        "selectHosts": ["hostid", "name"],
        "expandDescription": true
    },
    "id": 1
}
```
`trigger.get` with `filter: {"value": 1}` returns triggers currently in **Problem** state (as opposed to `problem.get`'s event-oriented view) — useful if you want trigger-level metadata (severity, expression) rather than event-log-style entries. 🚩 Note: `selectGroups` on `trigger.get` was also removed at 7.2 (same ZBXNEXT‑9452 cleanup) — use `selectHosts`/group IDs from `host.get` instead if you need grouping context.

### 2.8 `lastvalue` / `prevvalue` on `item.get`

**Confirmed**: `item.get` output can include `lastvalue`, `prevvalue`, `lastclock`, and `lastns` as read-only fields directly on the item object — no separate call needed ([`item/object`](https://www.zabbix.com/documentation/current/en/manual/api/reference/item/object)):

```json
{
    "jsonrpc": "2.0",
    "method": "item.get",
    "params": {
        "output": ["itemid", "name", "key_", "lastvalue", "lastclock", "prevvalue"],
        "hostids": ["10084"],
        "filter": { "key_": "system.cpu.util" }
    },
    "id": 1
}
```
```json
{ "result": [ { "itemid": "23296", "name": "CPU utilization", "key_": "system.cpu.util", "lastvalue": "3.2451", "lastclock": "1700000042", "prevvalue": "2.9871" } ] }
```

⚠ **Important caveat, directly from the official field documentation**: *"By default, only values that fall within the last 24 hours are displayed. You can extend this time period by changing the value of Max history display period parameter in Administration → General."* This means: **a host that has been offline/unmonitored for more than 24 hours (by default) will return an empty string for `lastvalue`/`lastclock`/`prevvalue` even though older historical data may still exist and remain fully retrievable via `history.get`.** For a dashboard that needs to reliably distinguish "no data ever" from "stale data," don't rely on `lastvalue` emptiness alone — cross-check `hostinterface.available`/`error` (§2.3) and, if needed, fall back to an explicit `history.get` with no `time_from` bound and `limit: 1`.

### 2.9 Multiple interfaces / multiple agents per host, and how `item.get` is scoped

- A single Zabbix **host** object can have several **interfaces** (one or more each of Agent/SNMP/IPMI/JMX type), each with its own `main` flag per type. `item.get` output includes `hostid` ("ID of the host or template the item belongs to") and `interfaceid` ("ID of the item's host interface") — so **items are scoped to a host, and each item is further pinned to one specific interface** of the appropriate type for its item `type` (e.g., a "Zabbix agent" type item requires an Agent-type interface; an SNMP item requires an SNMP-type interface).
- Practically, for a system-utilization dashboard that only cares about agent-collected OS metrics, this nuance rarely matters — you query by `hostids` and the standard agent-type item keys, and Zabbix resolves which interface each item polls internally. It becomes relevant only if a host has **multiple Agent interfaces** (unusual, but legal — e.g. monitoring two separate agent instances per host) or mixed types (agent + SNMP on the same host for different subsystems) and you need to disambiguate which interface a given `item.get` row actually belongs to — `selectInterfaces` on `host.get` plus matching `interfaceid` is the way to do that cross-reference.
- There is no "pick the active agent" concept at the `item.get` level beyond this — each item simply belongs to exactly one interface, set at item-creation/template-linking time.

---

## 3. Frontend / UI options

### 3.1 Server-side components of a Zabbix deployment

A self-hosted Zabbix install is a small set of discrete processes/services, not a monolith:

| Component | Role |
|---|---|
| **`zabbix-server`** | The core polling/processing daemon — collects data from agents/proxies/SNMP, evaluates triggers, runs the JSON-RPC backend logic (invoked indirectly via the web frontend's PHP). |
| **`zabbix-agent` / `zabbix-agent2`** | Runs on each monitored host; exposes the agent check keys (`system.cpu.util`, etc.) that `zabbix-server` polls (passive) or that the agent itself pushes (active). Agent2 is the newer Go-based rewrite with plugin support; both are still offered as separate official images. |
| **`zabbix-web` (PHP-FPM + nginx, or Apache+mod_php variant)** | The HTML frontend *and* the `api_jsonrpc.php` endpoint your GJS extension will hit — both are served by this same component. |
| **MySQL or PostgreSQL** | The backing relational database (configuration + history + trends, unless an external TimescaleDB/Elasticsearch history backend is configured). |
| **`zabbix-proxy`** (optional) | A lightweight relay for monitoring remote network segments; not needed for a single self-hosted box, relevant only if the setup grows. |
| **`zabbix-java-gateway`** (optional) | Only needed if JMX monitoring is in use; irrelevant to a Linux-agent-only dashboard. |
| **`zabbix-snmptraps`** (optional) | Only needed for receiving unsolicited SNMP traps. |

Source: official Docker image table at [`/manual/installation/containers`](https://www.zabbix.com/documentation/current/en/manual/installation/containers), cross-referenced with `zabbix/zabbix-docker`'s `compose_zabbix_components.yaml` service list. **Your extension only ever needs to reach the web component's `api_jsonrpc.php` path** — it never talks to `zabbix-server`, the database, or agents directly.

### 3.2 🚩 "Zabbix 7.0 has a new frontend" — not substantiated

I read the full "Frontend" section of the official [What's new in Zabbix 7.0](https://www.zabbix.com/documentation/7.0/en/manual/introduction/whatsnew700) changelog page. It lists only **incremental** UI changes: multi-factor authentication support, US-style time format option, simplified host/template cloning, icon-to-font-icon conversion, modal (popup) forms for several config screens, collapsible advanced-configuration sections, an improved top-triggers context menu, increased field character limits, item/preprocessing test output truncation for huge payloads, host-dashboard tabs, audit log additions, a latest-data page filter tweak, a bumped minimum required PHP version, and some renamed UI elements. **This is not a ground-up rewrite or a new rendering framework** — the frontend remains the same server-rendered PHP application architecture across 6.0 → 7.4. If you encountered a claim that 7.0 shipped "a new frontend," it most likely overstates what was, in reality, a normal cycle of UI polish. (I did not find any Zabbix release note using language like "new frontend architecture" or "rewritten frontend" for 7.0.)

### 3.3 Embedding / linking a dashboard view from an external app

Zabbix's web UI supports a **kiosk mode** and has a **`dashboard.get`** API method, but there is no formal "embed as iframe" product feature beyond what these two provide:

- **Kiosk mode**: append `?kiosk=1` to most frontend page URLs (dashboards, individual graphs/screens) to hide the main menu/header chrome, leaving just the content — originally meant for wall-mounted displays, but equally usable inside an `<iframe>` or a GJS `WebKit.WebView` if your extension wants to show a live rendered Zabbix view rather than build its own widgets. Documented under the web interface's page-parameter conventions ([`/manual/web_interface/page_parameters`](https://www.zabbix.com/documentation/current/en/manual/web_interface/page_parameters)).
- **Dashboard URL**: `https://<zabbix-host>/zabbix.php?action=dashboard.view&dashboardid=<id>` is the normal frontend URL to open/link a specific dashboard by ID (combine with `&kiosk=1` for a chrome-free embed).
- **`dashboard.get` API method** — for *metadata/configuration retrieval*, not image/graph rendering:
```json
{
    "jsonrpc": "2.0",
    "method": "dashboard.get",
    "params": {
        "output": ["dashboardid", "name"],
        "selectPages": "extend"
    },
    "id": 1
}
```
This returns the dashboard's **structure** (widget layout, widget types, field configuration) as JSON — it does **not** return a rendered image or chart data; you'd still need separate `item.get`/`history.get`/`trend.get` calls (or the graph-image HTTP endpoints below) to get actual plottable values. ([`dashboard.get`](https://www.zabbix.com/documentation/current/en/manual/api/reference/dashboard/get))
- There is also a classic (pre-dashboard, "legacy graphs") PNG-rendering endpoint, `chart.php`/`chart2.php` on the frontend, that returns a rendered graph image directly given item IDs and a time range — this is a **frontend HTTP endpoint**, not a JSON-RPC API method, and would need session-cookie or URL-based auth rather than the JSON-RPC token mechanism. Given your extension is building its *own* native GJS/Clutter widgets rather than displaying Zabbix's own rendered charts, the JSON-RPC `history.get`/`trend.get` data path (§2.5–2.6) is almost certainly the better integration point than trying to reuse Zabbix's own image-rendering endpoints.

For a native GNOME Shell dashboard, the realistic architecture is: **pull raw numeric data via JSON-RPC and render your own sparklines/gauges in St/Clutter**, rather than embedding Zabbix's own rendered UI — kiosk-mode URLs are more useful as an optional "open full dashboard in browser" link-out action than as an embedding mechanism, since GNOME Shell extensions don't have a convenient sandboxed web-rendering surface anyway.

### 3.4 CORS

I checked this directly in the **live server source**, not just documentation prose, by reading `ui/api_jsonrpc.php` on both the `release/7.0` branch and current `master`:

```php
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type,Authorization');
header('Access-Control-Allow-Methods: POST,OPTIONS');
header('Access-Control-Max-Age: 1000');
```
`zabbix/zabbix:ui/api_jsonrpc.php:17-20` (identical on both branches checked).

**Confirmed: `api_jsonrpc.php` sends a wide-open CORS policy (`Access-Control-Allow-Origin: *`) unconditionally, on every response, for every version checked.** This matches the documented (version-qualified, patch-specific) claims about CORS support for the `Authorization` header discussed in §1.2 — the header-level allowance has been in place consistently since at least the 7.0 branch's early patch releases.

**This is irrelevant to your GJS/libsoup client anyway** — CORS is a **browser-enforced** restriction on `fetch`/`XMLHttpRequest`-style requests originating from web page JavaScript; it is not enforced by, or relevant to, a native application making HTTP requests via libsoup. A GNOME Shell extension talking to `api_jsonrpc.php` via `Soup.Session`/`Soup.Message` will never hit a CORS restriction regardless of what headers the server sends, because there is no browser same-origin policy in play. The wide-open server-side CORS policy is good news only for a hypothetical browser-based companion web UI, not something your extension needs to think about at all.

---

## 4. Self-hosting Zabbix via Docker / docker compose

### 4.1 Official images and canonical compose service set

Per the official [`/manual/installation/containers`](https://www.zabbix.com/documentation/current/en/manual/installation/containers) page and the `zabbix/zabbix-docker` repository's `compose_zabbix_components.yaml`:

| Image | Purpose |
|---|---|
| `zabbix/zabbix-server-mysql` (or `-pgsql`) | Core server daemon |
| `zabbix/zabbix-web-nginx-mysql` (or `-apache-mysql`, `-nginx-pgsql`, `-apache-pgsql`) | Frontend + `api_jsonrpc.php` |
| `zabbix/zabbix-agent` / `zabbix/zabbix-agent2` | Agent (classic C vs. newer Go) |
| `zabbix/zabbix-java-gateway` | Optional, JMX only |
| `zabbix/zabbix-snmptraps` | Optional, SNMP trap receiver |
| `zabbix/zabbix-web-service` | Optional, headless report/PDF rendering service used by the frontend |
| `mysql:8.0` / `postgres:<version>` | Database (official upstream images, not Zabbix-branded) |

Image tag format (from the containers doc): `<major>.<minor>-<base-os>-latest` (e.g. `7.0-ubuntu-latest`, `7.4-alpine-latest`) or pinned patch tags like `7.0.<patch>-ubuntu-<build>`. Official branches/tags exist at minimum for **7.0 (LTS)**, **7.2**, and **7.4** (the "current" docs track, confirming `apiinfo.version` returning `"7.4.0"` as the current latest at time of this research) — 6.0 and 6.4 images also remain published for existing deployments but are not the ones a new self-hosted setup should pick today.

Canonical minimal compose setup (per the containers doc's own instructions): clone `zabbix/zabbix-docker`, `git checkout <branch, e.g. 7.4>`, then `docker compose -f docker-compose_v3_<db>_<webserver>_<os>.yaml up -d` (the repo ships several pre-composed variants; `compose_zabbix_components.yaml` plus `compose_databases.yaml` are **fragments** meant to be combined via `docker compose -f ... -f ...`, not run standalone — check the repo's `README.md` for the exact top-level compose filename matching your chosen DB/webserver/OS combination).

Resource limits set by the project's own compose fragments (`zabbix/zabbix-docker:compose_zabbix_components.yaml`) — these are the **maintainers' own dev/demo defaults**, not a sizing recommendation:

| Service | CPU limit | Mem limit | CPU reservation | Mem reservation |
|---|---|---|---|---|
| server | 0.70 | 1 GiB | 0.5 | 512 MiB |
| proxy | 0.70 | 512 MiB | 0.3 | 256 MiB |
| web-apache | 0.70 | 512 MiB | 0.5 | 256 MiB |
| web-nginx | 0.70 | 512 MiB | 0.5 | 256 MiB |
| agent / agent2 | 0.2 | 128 MiB | 0.1 | 64 MiB |
| java-gateway | 0.5 | 512 MiB | 0.25 | 256 MiB |
| snmptraps | 0.5 | 256 MiB | 0.25 | 128 MiB |
| web-service | 0.5 | 512 MiB | 0.25 | 256 MiB |
| mysql-server / postgres-server | *(none set)* | *(none set)* | — | — |

Confirmed via `zabbix/zabbix-docker:compose_databases.yaml` that the database containers carry **no explicit resource caps** in the stock compose files — they'll use whatever Docker/the host allows by default.

### 4.2 Resource footprint — two very different numbers, both real

Don't confuse the table above (Docker compose dev-default caps, meant for a small/demo deployment) with Zabbix's own **production hardware-sizing guidance** from [`/manual/installation/requirements`](https://www.zabbix.com/documentation/current/en/manual/installation/requirements), "Examples of hardware configuration" (sizing is expressed per "metric," defined as roughly 1 item + 1 trigger + 1 graph):

| Tier | Monitored metrics (NVPS-ish scale) | vCPU | RAM |
|---|---|---|---|
| Small | ~1,000 | 2 | 8 GiB |
| Medium | ~10,000 | 4 | 16 GiB |
| Large | ~100,000 | 8–16 | 32 GiB |
| Very Large | ~1,000,000 | 32 | 96 GiB |

(Exact tier boundaries per the official table — a home-lab "monitor my one PC's CPU/mem/disk/net" setup with a handful of hosts and the stock Linux template is nowhere near even the "Small" tier; the compose-file defaults above are the realistic, relevant numbers for this use case, not the production sizing table.)

### 4.3 Default credentials and first login

Confirmed from [`/manual/quickstart/login`](https://www.zabbix.com/documentation/current/en/manual/quickstart/login): default web/API login is **`Admin` / `zabbix`** (capital A, case-sensitive). Changing the password on first login is **recommended by the UI, but not technically enforced** — you can continue using the default credentials indefinitely unless you change them yourself. Zabbix does enforce a basic **brute-force protection**: after 5 failed login attempts, the frontend imposes a ~30 second pause before allowing another attempt. This applies to frontend-form login; whether it also throttles `user.login` JSON-RPC calls identically was not independently re-verified this session but is the reasonable expectation given both paths route through the same authentication backend.

### 4.4 Non-interactive provisioning (template import, host creation, API tokens)

There is no single official one-shot "provision everything" CLI — the realistic options, from most to least "official":

1. **The API itself** is the most "official" non-interactive provisioning mechanism: `configuration.import` (template import from XML/YAML), `host.create`, `hostgroup.create`, `template.massadd` (link a template to a host), and `token.create`/`token.generate` (§1.2) can all be scripted directly against `api_jsonrpc.php` with a shell script or your extension's own first-run setup flow. This requires only `curl`/any HTTP client and needs no extra tooling.
2. **`zabbix_server -R config_cache_reload`** (and other `-R`/`--runtime-control` options) lets you force the server to pick up configuration changes immediately rather than waiting for its normal cache-reload interval — documented as a subsection of [`/manual/concepts/server#runtime-control`](https://www.zabbix.com/documentation/current/en/manual/concepts/server): *"Reload configuration cache. Ignored if cache is being currently loaded."* This is a server-process control flag, not itself a provisioning tool — useful after bulk API-driven changes if you want them to take effect without waiting.
3. **`zabbix-cli`** (`unioslo/zabbix-cli`, University of Oslo) — a convenient wrapper that does support scripted host/template/user provisioning from the command line. ⚠ **This is a community project, not an official Zabbix SIA tool** — worth using, but should not be described as "the official CLI."
4. **XML/YAML template import format**: the same `zabbix_export:` YAML structure examined in §2.4 (or the equivalent XML) is importable via `configuration.import` (API) or the frontend's Data collection → Templates → Import button — this is the correct mechanism for "import a template non-interactively," as opposed to any `ZBX_`-prefixed environment variable (there is no `ZBX_*`-env-var-based template-import mechanism in the Docker images — those env vars configure the **daemon/frontend config files**, not content import; see next point).

The actual `ZBX_*` environment variables (from `zabbix/zabbix-docker:env_vars/.env_srv` and `.env_agent`) configure the **daemon config files**, confirmed with an explicit example from the official containers doc: *`ZBX_STARTPOLLERS` maps to the `StartPollers` directive in `zabbix_server.conf`.* Other real variables captured directly from the repo's env files: `ZBX_SERVER_HOST`, `ZBX_ACTIVESERVERS`, `ZBX_HOSTNAME` (agent side); `ZBX_CACHESIZE`, `ZBX_STARTPOLLERS`, `ZBX_JAVAGATEWAY`, `ZBX_ENABLE_SNMP_TRAPS`, `ZBX_HISTORYSTORAGEURL` (optional Elasticsearch history backend), `ZBX_VAULT` (HashiCorp Vault secrets integration), `ZBX_MAXCONCURRENTCHECKSPERPOLLER` (server side, 7.0.0+). None of these provision *content* (hosts/templates/tokens) — only daemon behavior.

### 4.5 Can the containerized agent monitor the Docker host itself?

Inspecting `zabbix/zabbix-docker:compose_zabbix_components.yaml` directly: the `agent`/`agent2` service blocks set `pid: "host"` and `privileged: true`, but **do not** set `network_mode: host` and **do not** bind-mount `/proc`, `/sys`, or `/` from the host. This means the stock compose file's containerized agent primarily has **the container's own network/filesystem namespace view** (with some process visibility granted via the shared host PID namespace), **not** a fully accurate picture of the true Docker host's CPU/memory/disk/network state. ⚠ The following host-monitoring guidance is **community best practice gathered via web search, not an official Zabbix documentation citation** — flagged accordingly:

- For accurate host-level network-interface stats, add `network_mode: host` (or `--network=host`) to the agent container.
- Mount `/var/run/docker.sock` only if you also want to monitor the Docker engine/containers themselves (a different template, not covered here).
- Point the agent at the server via `Server=`/`ServerActive=` (passive/active respectively) and set `Hostname=` to the name the server-side host object is configured with — mapped in Docker as `ZBX_SERVER_HOST`/`ZBX_ACTIVESERVERS`/`ZBX_HOSTNAME`.
- **The simplest, most accurate option for a single-PC self-hosted dev setup**: install `zabbix-agent2` **natively on the host OS** (not containerized at all) and point it at the Dockerized server's exposed `10051/tcp` port. This sidesteps every container-namespace-visibility caveat entirely and is almost certainly the right choice if the goal is "accurately monitor the actual physical machine the GNOME Shell extension runs on."

---

## 5. Practical gotchas

1. **`value_type` mismatch → silent empty result, not an error.** `history.get`'s `history` parameter must exactly match the target item's actual `value_type` (0/1/2/3/4/[5]); a mismatch returns `"result": []` with no error object at all — this is probably the single most common "why is my dashboard showing nothing" bug. Always `item.get` the item first (it returns `value_type` directly) rather than assuming a type from the key name.
2. **Clock/timezone handling.** `clock` (on `history.get`/`trend.get` rows) and `lastclock` (on `item.get`) are always **Unix epoch seconds in UTC**, completely independent of the Zabbix frontend's configured display timezone (`PHP_TZ` in the Docker images only affects how the *HTML UI* renders dates — never the API's numeric fields). Your GJS client can safely treat these as plain UTC timestamps and localize for display using GLib's own timezone APIs; no Zabbix-side timezone conversion is ever needed or possible.
3. **No relative "now" syntax in the API.** `time_from`/`time_till` are plain absolute Unix-second integers — the `now-1h`-style relative syntax exists only in frontend URLs/dashboard time-range widgets, not as something the JSON-RPC parameters themselves parse. Compute `now - N` client-side.
4. **Disabled vs. unsupported items.** `item.status` (0=enabled/1=disabled) is a **user-controlled toggle** — an admin turned the check off. `item.state` (0=normal/1=not supported) is a **server-detected runtime condition** — the agent/server tried to collect the value and failed (bad key syntax, permission error, etc.), with diagnostic text in `item.error`. Check both fields if a metric that should exist is returning no fresh data: a `status: 1` item will never update (expected/intentional); a `status: 0, state: 1` item is actively broken and `error` will usually say why.
5. **Detecting "monitoring not working" at the host level.** `host.status` is **only** an enabled/disabled toggle for the host's monitoring, **not** a live connectivity indicator — a fully offline host still reports `status: 0` if an admin hasn't explicitly disabled it. The actual connectivity signal lives on the **interface**: `hostinterface.available` (0=unknown/1=available/2=unavailable) plus `error`/`errors_from`/`disable_until`, retrievable via `hostinterface.get` or `host.get` with `selectInterfaces`.
6. **`lastvalue`'s 24-hour display-window caveat** (§2.8) — a stale/offline host can show an **empty** `lastvalue` even when older history still exists and is retrievable via an explicit `history.get` call; don't conflate "`lastvalue` empty" with "no data ever."
7. **LLD-generated keys cannot be hardcoded.** Filesystem (`vfs.fs.dependent.size[{#FSNAME},...]`) and network-interface (`net.if.in["{#IFNAME}"]`) item keys embed runtime-discovered names that differ per host (mount points, interface names) — always discover the real keys via `item.get` + `search`/`filter` on `key_`, never assume a fixed string like `vfs.fs.dependent.size[/,pused]` will exist on every host.
8. **`trends: 0` items exist in the stock template** (e.g. `system.uptime`) — `trend.get` will silently return nothing for these regardless of time range; only `history.get`, bounded by the item's own `history` retention (31 days default per `item/object`), has any data for them.
9. **Deprecated parameter removal is version-gated, not gradual.** `auth` (top-level auth property), `selectGroups` (on `host.get`/`trigger.get`/`graph.get`/etc.), `monitored_hosts`/`real_hosts` (on `hostgroup.get`), and several others were all **hard-removed at Zabbix 7.2** in one coordinated cleanup (ZBXNEXT‑9452) — a client built and tested against 7.0 can break outright on 7.2 if it uses any of these; always prefer the current non-deprecated parameter name (`selectHostGroups`, `Authorization` header) even when targeting older versions, since the modern names have generally been available in parallel for a long time already.

---

## Appendix: copy-paste request library

```jsonc
// 1. Unauthenticated version probe
{"jsonrpc":"2.0","method":"apiinfo.version","params":[],"id":1}

// 2. Login (session token) — or use a pre-created API token instead and skip this
{"jsonrpc":"2.0","method":"user.login","params":{"username":"Admin","password":"zabbix"},"id":1}

// 3. Create + generate a long-lived API token (do this once, store the secret, never re-call generate)
{"jsonrpc":"2.0","method":"token.create","params":{"name":"gnome-dashboard","userid":"1","expires_at":"0"},"id":1}
{"jsonrpc":"2.0","method":"token.generate","params":["12"],"id":2}

// 4. List monitored hosts with interfaces + groups
{"jsonrpc":"2.0","method":"host.get","params":{
  "output":["hostid","host","name","status"],
  "selectInterfaces":["interfaceid","ip","dns","useip","port","type","main","available","error"],
  "selectHostGroups":["groupid","name"],
  "filter":{"status":0}
},"id":1}

// 5. Discover the real CPU/memory/filesystem/network item keys on a host
{"jsonrpc":"2.0","method":"item.get","params":{
  "output":["itemid","name","key_","value_type","units","lastvalue","lastclock","status","state","error"],
  "hostids":["10084"],
  "search":{"key_":"system.cpu"}
},"id":1}

// 6. Latest CPU/mem/uptime values via item.get (fast path, mind the 24h window caveat)
{"jsonrpc":"2.0","method":"item.get","params":{
  "output":["itemid","name","key_","lastvalue","lastclock"],
  "hostids":["10084"],
  "filter":{"key_":["system.cpu.util","vm.memory.util","system.uptime"]}
},"id":1}

// 7. Guaranteed-fresh latest value via history.get (robust path)
{"jsonrpc":"2.0","method":"history.get","params":{
  "output":"extend","history":0,"itemids":["23296"],
  "sortfield":"clock","sortorder":"DESC","limit":1
},"id":1}

// 8. Sparkline: last hour of raw history (compute time_from = now - 3600 client-side)
{"jsonrpc":"2.0","method":"history.get","params":{
  "output":"extend","history":0,"itemids":["23296"],
  "time_from":1700000000,"sortfield":"clock","sortorder":"ASC"
},"id":1}

// 9. 24h trend band (min/avg/max per hour) for a longer chart
{"jsonrpc":"2.0","method":"trend.get","params":{
  "output":"extend","itemids":["23296"],
  "time_from":1699913600,"time_till":1700000000
},"id":1}

// 10. Active problem/alert count for a host
{"jsonrpc":"2.0","method":"problem.get","params":{
  "output":"extend","hostids":["10084"],"recent":false
},"id":1}

// 11. Dashboard structure (for an "open full dashboard" link-out, not chart data)
{"jsonrpc":"2.0","method":"dashboard.get","params":{
  "output":["dashboardid","name"],"selectPages":"extend"
},"id":1}

// 12. Logout (session tokens only; API tokens don't need this)
{"jsonrpc":"2.0","method":"user.logout","params":[],"id":1}
```

All calls after #1–#3 require the header `Authorization: Bearer <token>` and `Content-Type: application/json-rpc` (or `application/json`) on every request, against **`https://<your-zabbix-host>/api_jsonrpc.php`** (exact path/port depends on how your web container is exposed — the official Docker images typically serve on `:8080`/`:8443` by default, adjustable via the web container's own port mapping).

---

## Primary sources cited

- API fundamentals / auth / errors: [`/manual/api`](https://www.zabbix.com/documentation/current/en/manual/api) (current), plus version-pinned [6.0](https://www.zabbix.com/documentation/6.0/en/manual/api), [6.4](https://www.zabbix.com/documentation/6.4/en/manual/api), [7.0](https://www.zabbix.com/documentation/7.0/en/manual/api), [7.2](https://www.zabbix.com/documentation/7.2/en/manual/api)
- API changelogs: [6.4 changes](https://www.zabbix.com/documentation/6.4/en/manual/api/changes), [7.0 changes](https://www.zabbix.com/documentation/7.0/en/manual/api/changes), [7.2 changes](https://www.zabbix.com/documentation/7.2/en/manual/api/changes)
- Method/object references: [`apiinfo.version`](https://www.zabbix.com/documentation/current/en/manual/api/reference/apiinfo/version), [`host/object`](https://www.zabbix.com/documentation/current/en/manual/api/reference/host/object), [`hostinterface/object`](https://www.zabbix.com/documentation/current/en/manual/api/reference/hostinterface/object), [`item/object`](https://www.zabbix.com/documentation/current/en/manual/api/reference/item/object), [`token/object`](https://www.zabbix.com/documentation/current/en/manual/api/reference/token/object), [`dashboard.get`](https://www.zabbix.com/documentation/current/en/manual/api/reference/dashboard/get)
- Server source (CORS, content-type handling, auth header types): `zabbix/zabbix:ui/api_jsonrpc.php`, `ui/include/classes/core/CJsonRpc.php` (branches `master`, `release/7.0`)
- Template internals: `zabbix/zabbix:templates/os/linux/template_os_linux.yaml` (branches `release/7.0`, `release/7.4`)
- Docker/self-hosting: [`/manual/installation/containers`](https://www.zabbix.com/documentation/current/en/manual/installation/containers), [`/manual/installation/requirements`](https://www.zabbix.com/documentation/current/en/manual/installation/requirements), [`/manual/quickstart/login`](https://www.zabbix.com/documentation/current/en/manual/quickstart/login), [`/manual/concepts/server`](https://www.zabbix.com/documentation/current/en/manual/concepts/server), `zabbix/zabbix-docker:compose_zabbix_components.yaml`, `compose_databases.yaml`, `env_vars/.env_agent`, `env_vars/.env_srv`
- Frontend history: [`/manual/introduction/whatsnew700`](https://www.zabbix.com/documentation/7.0/en/manual/introduction/whatsnew700)
- Secondary/community (explicitly flagged inline where used): `-32500` error code folklore, Docker-agent-host-networking best practices, `zabbix-cli` (`unioslo/zabbix-cli`) project status.