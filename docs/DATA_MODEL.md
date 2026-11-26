# Data model

The server has 30 SQLite tables (`server/src/db.ts` `SCHEMA`). Existing groups: users and sessions, API tokens, passkeys, SCIM groups, audit (hash-chained), system events, notification routes and silences, scenes and schedules, tiles, monitoring sources and webhook state, per-user prefs and usage, Kuma samples, GPU samples.

## Added: service registry

```
registry_services(id PK, name, description, category, url, host, port, deployment, resource,
                  monitor, owner, criticality, tags JSON, meta JSON, created_at, updated_at, created_by)
registry_deps(service_id → registry_services, depends_on → registry_services, note, PK(service_id, depends_on))
```

- `monitor` is `"<monitoring source id>|<check key>"`: the link to the external check, kept as the source's own identifier so it can be traced. It is a reference, not a copy; health is read live from the merged monitoring list.
- `resource` is free text ("guest 101", a node name) until Proxmox inventory is a first-class entity.
- Deleting a service deletes its edges (`ON DELETE CASCADE`).
- Names are unique ignoring case. Loops and self-dependency are refused when an edge is added.

### Health of a service (`Health`)

`up`, `down`, `pending`, `maintenance` come from the linked check. Otherwise: `unmonitored` (no link), `unknown` (source or check no longer exists), `stale` (source cannot be read; the last known state is in the detail). There is no state that means healthy without a check saying so.

## Existing normalised shapes

`Check {key, name, status, since, detail, url}` and `MonAlert {key, name, level, state, since, summary, instances, url}` in `monitoring/types.ts`, merged with the source id. Everything shown on Overview and every alert is built from these.

## Not yet modelled

Incident, ConfigurationSnapshot, NetworkDevice, DatabaseInstance inventory (the data manager has connections, not an inventory with metrics history), Dashboard and DashboardWidget (layouts are per-user key-value prefs). Each needs its own design; none is stubbed.
