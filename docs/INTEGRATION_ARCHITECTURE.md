# Integration architecture

## What exists

| Mechanism | Defined by | Added from | Secrets |
|---|---|---|---|
| Monitoring source | `monitoring/catalog.ts` (kinds and templates, pure data) plus a provider per reading | UI, API, YAML | sealed in `monitoring_sources` |
| Service tile | `tile-kinds.ts` plus a parser in `tiles.ts` | UI, YAML | sealed in `ui_tiles` |
| Data source | `datasources/core/*` (one driver per engine) | UI, `.env` | sealed in the data store |
| Native module | Hand-written (Proxmox, Loki, CrowdSec, Nginx) | YAML only | environment |

A new tool that only needs "is it up" or "what alerts does it have" needs **no code**: add a template to `SOURCE_TEMPLATES` (a saved configuration of the custom HTTP source) and a test. That is how OPNsense gateways, the Loki ruler and the identity providers' health checks were added.

## The contract to converge on

Each integration declares, in data:

```
id, name, version, category
connection   fields (the form is generated from them)
auth         none | bearer | basic | header | query | (sealed fields)
capabilities DISCOVER | MONITOR | METRICS | LOGS | EVENTS | CONFIG_READ | CONFIG_WRITE | MANAGE | EXECUTE | NOTIFY
permissions  the lowest role per capability
verified     which documentation or live version it was checked against
```

Rules:

- A capability not declared is not offered in the UI and refused by the API.
- `CONFIG_WRITE`, `MANAGE` and `EXECUTE` are never granted by a default; an administrator turns each on per connection, and each call is audited and passes the four-eyes approval when that is configured.
- An integration's failure never reaches another: each provider is polled under its own timeout and failure count (this is true today for monitoring sources).
- Data from outside is translated to an internal shape (`Check`, `MonAlert` today) and keeps the source id and original key, so a row can be traced back.
- Missing, stale and unsupported are states, not zeros: a source that cannot be read is `stale`, a service with no monitor is `not monitored`.

## Capability matrix today

| Integration | MONITOR | METRICS | LOGS | EVENTS | CONFIG_READ | MANAGE |
|---|---|---|---|---|---|---|
| Proxmox VE | yes | yes | tasks | tasks | partly | power, snapshots, migrate, backup |
| Uptime Kuma | yes | response times | no | incidents derived | no | no |
| Grafana | alert state | via data source | no | alerts | dashboard list | no |
| Prometheus, Alertmanager | alerts | queries | no | alerts | no | no |
| Loki | ready, ruler alerts (template) | no | yes (page) | no | no | no |
| CrowdSec | via host snapshot | via Prometheus | alerts | decisions | no | no (read-only by design) |
| OPNsense | gateway status (template) | no | no | no | no | no |
| authentik, Keycloak, Authelia | health (templates) | no | no | no | OIDC discovery (Identity page) | no |
| Databases (7 engines) | ping | server stats | no | no | schema | by role, with guards |
| Docker, Portainer, Plex, arr apps and others | tile | no | no | no | no | no |

"Template" means the request and reading follow the tool's documentation and are tested against a mock, not a live installation.

## Adding a tool

1. Does it have a web address that answers JSON, a `/metrics` page, or only "is it up"? Add a template (data only) to `server/src/monitoring/catalog.ts`.
2. Add a mock-server test to `server/test/monitoring-templates.test.mjs` that checks the request that was sent and the reading.
3. State what the form's `verified` line was checked against, and say plainly if it was not run live.
4. If it needs login steps, token refresh or more than one request, it needs a provider (code), not a template. Beszel is the known example.
