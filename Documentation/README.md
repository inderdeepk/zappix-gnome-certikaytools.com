# Documentation

| Directory | Contents |
|---|---|
| [Technical/](Technical/) | for people changing the code |
| [Help/](Help/) | for people using the extension |
| [Research-Reports/](Research-Reports/) | the cited research the design is based on |

## Technical

* **[ARCHITECTURE.md](Technical/ARCHITECTURE.md)** — module boundaries, the
  data flow of one poll, and why each non-obvious choice was made.
* **[API_REFERENCE.md](Technical/API_REFERENCE.md)** — every Zabbix method
  called, with parameters, response fields and the version gates.
* **[DEVELOPMENT.md](Technical/DEVELOPMENT.md)** — the build loop, how to add a
  metric or a preference, debugging.
* **[TESTING.md](Technical/TESTING.md)** — what is tested, the properties the
  tests protect, and the live integration test.
* **[SECURITY.md](Technical/SECURITY.md)** — credential storage, transport,
  logging, threat model, hardening checklist.

## Help

* **[UserGuide.md](Help/UserGuide.md)** — first run, reading the tiles, every
  preference, troubleshooting.
* **[DeliverEdge.md](Help/DeliverEdge.md)** — connecting to the DeliverEdge
  monitoring plane: API token, Cloudflare Access service token, host filter, and
  the item keys each tile reads.

## Research

* **[Research-Reports/zabbix-api.md](Research-Reports/zabbix-api.md)** — the
  Zabbix API research report: auth timelines, real template item keys,
  `lastvalue` caveats, Docker deployment, and the primitives of a
  utilization dashboard. Claims are cited; uncertain sections are marked.
