# Zabbix API reference (as used by Zappix)

Every Zabbix method this extension calls, with the exact parameters and the
fields it reads. Source research with citations:
[../Research-Reports/zabbix-api.md](../Research-Reports/zabbix-api.md).

Endpoint: `<frontend>/api_jsonrpc.php`, JSON-RPC 2.0 over POST.

---

## Authentication

### API token (recommended)

```
Authorization: Bearer <token>
Content-Type: application/json-rpc
```

Zabbix 6.4 introduced the header. Zappix always sends it.

### Version gates

| Zabbix | `auth` body field | Bearer header | `user.login` field |
|---|---|---|---|
| ≤ 6.2 | **only** mechanism | ignored | `user` |
| 6.4 – 7.0 | accepted (deprecated) | supported | `username` |
| 7.2 + | **removed** — sending it is a strict-validation error | only mechanism | `username` |

Implemented by `_authFieldValue()` in `src/api/zabbixClient.js`:

```js
if (version >= 7.2) return '';                       // never send it
if (!version || version >= 6.4) return sessionId;    // header does the work
return sessionId || apiToken;                        // 6.0–6.2 needs the field
```

### Username and password (alternative)

`user.login` → session token → used as `Bearer`, plus the `auth` field where the
server still accepts it. A session expired by the server is re-minted once per
request (`_withRetry`).

---

## `apiinfo.version`

Unauthenticated. Doubles as the reachability probe: if it answers, the URL is
right.

```json
{"jsonrpc":"2.0","method":"apiinfo.version","params":{},"id":1}
```

```json
{"jsonrpc":"2.0","result":"7.0.32","id":1}
```

**No credential may accompany it.** 7.4 enforces the "unauthenticated" part:

```json
{"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params.",
 "data":"The "apiinfo.version" method must be called without authorization header."},"id":1}
```

`ZabbixClient._post()` therefore suppresses the `Authorization` header for this
one call (Cloudflare Access headers, which are not Zabbix credentials, still
travel with it).

Cached for the client's lifetime (`ZabbixClient.probe()`).

---

## `host.get`

```json
{
  "output": ["hostid", "host", "name", "status",
             "maintenance_status", "maintenance_from"],
  "selectInterfaces": ["interfaceid", "ip", "dns", "port",
                       "type", "main", "available", "error"],
  "filter": {"status": 0},
  "sortfield": "name",
  "limit": 20,
  "selectHostGroups": ["groupid", "name"]
}
```

* `status: 0` = monitored. Unmonitored hosts have no live data.
* `selectHostGroups` (7.0+) / `selectGroups` (≤ 6.4) — see
  `usesHostGroupsProperty()`.
* `search: {name: <filter>}` + `searchByAny: true` only when a host filter is
  configured.

Fields read per host: `hostid`, `host`, `name`, `maintenance_status`,
`maintenance_from`, `interfaces[]`.

Interface `available`: `0` unknown, `1` available, `2` unavailable — the source
of the card's availability dot.

---

## `item.get`

```json
{
  "output": ["itemid", "hostid", "name", "key_", "value_type", "units",
             "lastvalue", "lastclock", "prevvalue", "prevclock", "state", "error"],
  "hostids": ["10683"],
  "filter": {"status": 0},
  "search": {"key_": ["system.cpu.util", "vm.memory.util", "vfs.fs.dependent.size[", "…"]},
  "searchByAny": true,
  "sortfield": "key_"
}
```

* One call covers every host and every enabled metric.
* `searchByAny` makes the term list an OR; without it Zabbix requires all terms.
* The field list is explicit. `output: "extend"` returns ~40 fields per item,
  which is an order of magnitude more data for none of the value.
* `state: "1"` means *not supported*: the item exists but never produces a
  value, so it must not shadow a working item.

`lastvalue` is the headline number. It is empty when the last value is older
than Zabbix's *Max history display period* (24 h default) — treated as "no data",
never as zero.

---

## `history.get`

```json
{
  "output": ["itemid", "clock", "value"],
  "history": 0,
  "itemids": ["50740", "…"],
  "time_from": 1792700000,
  "time_till": 1792703600,
  "sortfield": "clock",
  "sortorder": "ASC",
  "limit": 2000
}
```

`history` must equal the items' `value_type` or the result is **silently empty**:

| Code | Type | Used by |
|---|---|---|
| 0 | float | cpu, memory, disk, network, load |
| 3 | unsigned | uptime, process count |
| 1 / 2 / 4 | char / log / text | not requested |

`itemids` may mix items only within one value type, so `groupItemsByValueType()`
splits the set and the calls are batched. `limit` is a global row cap, not per
item; `ZabbixClient.getHistory()` sizes a per-item budget from the series count.

A history failure never fails the poll: the tiles already have their values, so
the sparkline degrades to "no curve".

---

## `problem.get`

```json
{
  "output": ["eventid", "objectid", "clock", "name", "severity",
             "acknowledged", "r_eventid"],
  "hostids": ["10683"],
  "sortfield": ["eventid"],
  "sortorder": "DESC",
  "limit": 50
}
```

`recent` is deliberately **not** sent — it includes recently resolved problems,
which would make a recovered incident look ongoing.

Severity mapping (0–5) → dashboard severity:

| Zabbix | Dashboard |
|---|---|
| 0 not classified | ok |
| 1 information | ok |
| 2 warning | warn |
| 3 average | warn |
| 4 high | crit |
| 5 disaster | crit |

---

## `user.login` / `user.logout`

```json
{"method":"user.login","params":{"username":"Admin","password":"…"},"id":1}
```

Parameter name is `username` on 6.4+, `user` on ≤ 6.2
(`usesModernLoginField()`). `user.logout` is best-effort at teardown: the server
expires sessions itself.

---

## Methods deliberately not used

| Method | Why not |
|---|---|
| `trigger.get` | `problem.get` already reflects trigger state after dependencies and maintenance |
| `trend.get` | only worthwhile for windows longer than the sparkline shows |
| `token.create` / `token.generate` | provisioning-only, and 7.0 does not return the secret |
| `hostinterface.get` | `host.get`'s `selectInterfaces` is the same data in the same round trip |

---

## Error shapes

API errors arrive with **HTTP 200**:

```json
{"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params.",
 "data":"Incorrect API \"item.get\" parameters: …"},"id":1}
```

`data` is the actionable sentence; `message` is a category. Zappix shows `data`
when present (see `toDisplayMessage`).

| Code | Meaning | Kind |
|---|---|---|
| −32700 | parse error | protocol |
| −32600 | invalid request | invalid |
| −32601 | method not found | notfound |
| −32602 | invalid params | invalid |
| −32500 | application error (also "session terminated") | server / auth |
| −32400 | not authorised | auth |

Auth failures are recognised by *text* as well as code, because an expired
session is reported as a generic −32500 application error.

A non-200 status is never an API error: something in front of the API answered.
`zabbixTransport.describeHttpStatus()` names the likely layer (401 token, 403
role, 404 path, 429 rate limit, 502/503/504 proxy).

---

## Version compatibility matrix

Verified against a live **Zabbix 7.0.32** and **7.4.16** (the latter on a stack
built to match the production DeliverEdge topology). The client is written for
6.0 → 7.4.

| Feature | Introduced | Removed |
|---|---|---|
| `Authorization: Bearer` | 6.4 | — |
| `auth` body property | 1.0 | 7.2 (7.4 rejects it as `unexpected parameter "auth"`) |
| Cloudflare Access service token | n/a | — |
| `username` in `user.login` | 6.4 | (replaced `user`) |
| `selectHostGroups` | 7.0 | (replaced `selectGroups` in 7.2) |
| `item.get` `lastvalue` | 3.0 | — |
| `searchByAny` | 3.4 | — |
| `problem.get` | 3.0 | — |
