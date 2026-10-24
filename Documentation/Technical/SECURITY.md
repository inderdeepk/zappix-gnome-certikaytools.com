# Security

Zappix holds a credential that can read the health of production infrastructure.
This document states what that credential is, where it lives, what the extension
does with it, and what it deliberately does not do.

---

## 1. Credential storage

| Backend | When | Protection |
|---|---|---|
| **Secret Service** (GNOME Keyring via libsecret) | whenever `gir1.2-secret-1` is installed | encrypted at rest, unlocked with the login session |
| **Private file** `~/.local/share/zappix/credentials.json` | fallback when libsecret is unavailable | `0600` file in a `0700` directory, plain JSON |

`SecretStore` tries the keyring first, lazily importing `gi://Secret` so that a
missing typelib cannot break extension load. The preferences window's *Servers*
page reports which backend is in use, so the weaker mode is visible rather than
silent.

### Why the token is never in GSettings

`org.gnome.shell.extensions.zappix` holds the server **definitions** — label,
URL, auth mode, username, colour. It never holds a secret, because:

* dconf is plain text and world-readable;
* users paste their settings into bug reports;
* some backup tools capture `~/.config/dconf`.

The definition carries a `secretRef` (`zappix:<serverId>`) which *names* the
keyring entry. Deleting a server removes both the definition and the entry, so
an orphaned token cannot outlive the server it belongs to.

### Two secrets per server

A server can hold two independent credentials, and they live in separate
keyring entries so rotating one cannot corrupt the other:

| Entry | Holds | Also stored in the definition |
|---|---|---|
| `zappix:<serverId>` | the Zabbix API token (or password in login mode) | — |
| `zappix-access:<serverId>` | the Cloudflare Access service token's client secret | the matching **client id**, which travels as a header beside the secret and is not confidential |

The Access pair is optional and all-or-nothing: `buildHeaders()` emits
`CF-Access-Client-Id` and `CF-Access-Client-Secret` only when both halves are
present, because Access rejects a lone header and the resulting HTML login page
is far harder to diagnose than a plain "no credentials" error.

### Session tokens

In username/password mode the password is stored the same way, and the
server-issued session token lives only in memory for the client's lifetime. A
`user.logout` is attempted at teardown; failure is ignored because Zabbix
expires sessions on its own.

---

## 2. Transport

* HTTPS by default: a URL without a scheme is upgraded to `https://`.
* Certificate verification is on unless the user explicitly enables **Allow
  untrusted certificates** — globally on the *Monitoring* page, or per server in
  the server editor. The per-server switch exists so one self-signed box does
  not force a global downgrade.
* When enabled, `ZabbixTransport` connects to libsoup's `accept-certificate`
  signal for **that session only**. The system certificate database is never
  modified.
* The API token travels in an `Authorization` header, never in a URL, so it does
  not reach proxy access logs or shell history.

### Cloudflare Access in front of the API

The DeliverEdge monitoring plane is published on its own hostname and gated by a
Cloudflare Access policy. Two consequences worth stating plainly:

* A request with a valid Zabbix token is still answered with an HTML login page
  when the Access check fails. `zabbixResponse.js` recognises the redirect, the
  `cf-mitigated` header and the login document itself, and reports "Cloudflare
  Access is protecting this hostname" rather than a JSON parse failure. HTML at
  any other point is reported as an intermediary replacing the response.
* The recommended credential is a **scoped service token** rather than an Access
  bypass on `/api_jsonrpc.php`. A bypass exposes the endpoint to the whole
  internet and reduces the defence to the Zabbix token alone; a service token
  can be revoked on its own and is scoped to the one application.

The extension never follows the login redirect, never embeds a browser, and
never sends the Access secret to any host other than the one that requested it —
headers are built per server, per request, from that server's own definition.

---

## 3. What the extension sends

| Method | Read/write | Sent when |
|---|---|---|
| `apiinfo.version` | read, unauthenticated | once per client |
| `host.get` | read | every poll |
| `item.get` | read | every poll |
| `history.get` | read | dropdown open only |
| `problem.get` | read | every poll |
| `user.login` / `user.logout` | session | username/password mode only |

No method that writes configuration is ever called. A read-only Zabbix role is
therefore sufficient; [`../Help/DeliverEdge.md`](../Help/DeliverEdge.md) explains
how to mint such a token.

---

## 4. Logging

`shared/log.js` is the only path to the journal. It:

* routes verbose output through a single `debug-logging` switch (off by default);
* always emits warnings and errors;
* passes every argument through `redact()`, which scrubs `Bearer <token>`,
  `"auth":"…"` and `?token=` / `?password=` patterns.

This matters because the journal is readable by any user in the `systemd-journal`
group and survives in `journalctl --since` for months.

---

## 5. Rendering untrusted text

Host names, item names and problem descriptions come from the Zabbix server and
are rendered as `St.Label` text. St labels do not interpret markup, so a host
named `<b>foo</b>` renders literally. Nothing is ever evaluated, and no remote
string reaches a `Log`, `Eval` or `Gio.Subprocess` call.

URLs opened by the **Open Zabbix** button are rebuilt from the stored base URL by
`buildFrontendUrl()`, not taken from a server response, so a compromised Zabbix
instance cannot redirect the user's browser elsewhere.

---

## 6. Threat model

### In scope

| Threat | Mitigation |
|---|---|
| Another local user reading the token | keyring, or `0600` file in a `0700` dir |
| Token captured from the journal | `redact()` on every log path |
| Token leaking through dconf backups | tokens are never in GSettings |
| MITM on a plaintext connection | HTTPS default, explicit opt-out only |
| Malicious Zabbix response | treated as data; no eval, no URL following |
| Token usable after a server is deleted | `secretRef` removed with the definition |
| Extension crash taking down the shell | every `enable()` path is wrapped; timers and signals released in `disable()` |

### Out of scope

* **A compromised desktop session.** Malware running as the user can read the
  unlocked keyring. Nothing an extension can do changes that.
* **A compromised Zabbix server.** It can return arbitrary monitoring data,
  including text designed to look like an alert. That is inherent to reading
  remote data.
* **DeliverEdge platform security.** The stack inherits the platform's TLS,
  tunnel and backup posture; see that repository's documentation.

---

## 7. Hardening checklist for a deployment

1. Change the Zabbix `Admin` password before exposing the frontend.
2. Create a **read-only** role and use its API token, not the admin's.
3. Leave `ZABBIX_HOST` unset unless you need the frontend publicly; reach it
   over an SSH tunnel instead.
4. Keep `Allow untrusted certificates` off. If a server needs it, use the
   per-server switch and fix the certificate chain when you can.
5. Turn on Cloudflare Access for `/zabbix/` if the domain is public — the API is
   token-authenticated but there is no reason to serve it to the whole internet.
6. Keep `debug-logging` off outside troubleshooting.
7. Confirm the credential backend shows **keyring** in *Servers → Credential
   storage*; if it shows the file fallback, install `gir1.2-secret-1`.

---

## 8. Reporting

This is a personal project; open an issue in the repository. Please do not paste
API tokens, host names or URLs from a private network into an issue.
