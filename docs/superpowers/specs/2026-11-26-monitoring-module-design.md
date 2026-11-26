# Monitoring module: any monitoring tool plugs in

Date: 2026-11-26. Status: draft for owner review. Next step after approval: implementation plan (writing-plans), one plan per phase.

## 1. Goal

homedash should be the one place to see "is anything wrong?" whatever tools a person already runs. Today Uptime Kuma and Grafana are wired in one by one, each read from static server config, so connecting one means editing YAML on the server (audit finding FUA-012) and a different tool means new code everywhere it is used.

Define what "monitoring" means once. Any tool that can say "this thing is up/down" or "this alert is firing" plugs in through a small provider, or through a universal webhook, without touching Overview, the alert pipeline or the timeline.

Success looks like:
- An admin connects Grafana, Prometheus/Alertmanager, Uptime Kuma, or any service that can send an HTTP POST, from the UI, and it shows up on Overview and in alerts within a minute, with no restart.
- A tool homedash has never heard of works through the webhook or the JSON poller.
- A source that cannot be reached is visibly "source down", never an empty "all clear".
- Existing YAML-configured installs behave exactly as before.

## 2. Non-goals

- Replacing Grafana, Prometheus or Kuma (no dashboards, no rule editing, no monitor management).
- Logs (Loki and similar) and notifications. The same provider pattern can serve them later; they are separate specs.
- Probing the network ourselves (homedash running its own HTTP/TCP checks). A possible later provider.
- Per-user access control inside a source (all admins see all sources; viewers see merged results, as they see Kuma today).

## 3. What exists today (verified in the repo)

- `server/src/kuma.ts`: reads Kuma `/metrics`, keeps a snapshot of `{key, name, url, type, status, ping}` and samples history; `GET /api/kuma/incidents` feeds Overview.
- `server/src/grafanaalerts.ts` (added in commit `edc21b6`): parses Grafana's rules route into firing/pending alerts; wired into `notify.ts` through `syncProblems`.
- `server/src/notify.ts`: `syncProblems(scope, category, problems, log)` raises one alert per new problem and one recovery when it clears; `alert()` applies routes, silences, maintenance windows and every channel.
- `server/src/config.ts`: `cfg` is a plain mutable object read at call time (`grafanaConfigured()`, `kumaConfigured()` read `cfg` on every call), so connection settings can be changed at runtime.
- `server/src/tilestore.ts` + `seal.ts`: UI-created tiles, secrets sealed with AES-256-GCM using `SECRETS_KEY` (or `DATASOURCE_KEY`/`MFA_KEY`); without a key the UI refuses to store secrets (`NO_SECRET_KEY`).
- `server/src/datasources/netguard.ts`: `assertDestinationAllowed` blocks link-local destinations; reused for any URL an admin enters.
- `server/src/auth.ts`: every route under `/api` needs a session or API token (`onRequest` hook). Routes outside `/api` (for example `/scim/v2`) authenticate themselves.
- `server/src/roles.ts`: `requiredRole` maps path prefixes to roles; reads default to viewer, writes to operator, with `ADMIN_PREFIXES` and `ADMIN_WRITE_PREFIXES` for admin-only areas.
- `server/src/prefs.ts`: per-user key/value store (8 KB per value, fixed key list). Too small and too rigid for usage counters, so Phase 3 gets its own table.
- Webhooks exist only outbound (a notification channel). There is no inbound receiver.

## 4. Architecture

### 4.1 Normalised model

```ts
type Status = 'up' | 'down' | 'pending' | 'maintenance' | 'unknown';
interface Check { key: string; source: string; name: string; status: Status; since: number | null; detail: string; url: string | null; ping?: number | null }
interface MonAlert { key: string; source: string; name: string; level: 'info' | 'warn' | 'error'; state: 'firing' | 'pending'; since: number | null; summary: string; instances: number; url: string | null }
interface SourceState { id: string; kind: string; name: string; ok: boolean; error: string | null; checkedAt: number; checks: number; alerts: number }
```

`key` is stable within a source so recoveries pair with their problem. The global key used in alerts is `mon|<sourceId>|<key>`.

### 4.2 Provider interface

```ts
interface Provider {
  kind: string;                         // 'kuma' | 'grafana' | 'prometheus' | 'jsonpoll' | 'webhook'
  label: string; hint: string;          // shown in the connect form
  fields: FieldSpec[];                  // url, token, topic-like extras; drives the form and validation
  poll?(src: SourceConfig): Promise<{ checks: Check[]; alerts: MonAlert[] }>;   // pull providers
  test(src: SourceConfig): Promise<{ ok: boolean; message: string; sample?: number }>;
}
```

Pull providers implement `poll`; the webhook provider has no `poll` and is fed by the receiver (4.5). Parsing is split into pure functions (as `parseGrafanaRules` is today) so it can be tested without the tool.

### 4.3 Registry and merge

New directory `server/src/monitoring/`:
- `types.ts`, `registry.ts` (provider lookup), `store.ts` (sources table, sealed secrets), `engine.ts` (polling, merge, cache), `routes.ts`.
- `providers/kuma.ts`, `providers/grafana.ts` (thin wrappers over the existing code, no behaviour change), `providers/prometheus.ts`, `providers/jsonpoll.ts`, `providers/webhook.ts`.

`engine.ts` polls each enabled pull source on its own interval (default 60 s, minimum 15 s) with a 10 s timeout, caches the last good result, and records `SourceState`. A failed poll sets `ok=false` with the error and keeps the previous checks flagged stale; it never turns into an empty result. Providers run independently so one slow source cannot delay the others.

`engine.ts` exposes `merged()` returning all checks, alerts and source states. Overview, the notifier watcher and the timeline read only this.

### 4.4 Runtime configuration

Connections are stored in the database, not YAML. Precedence: a source declared in YAML/env is read-only in the UI and labelled "managed in config" (the badge already exists); a UI-created source is used otherwise. For Kuma and Grafana, saving a source also applies its URL/token to `cfg` so the existing endpoints (`/api/grafana/*`, `/api/kuma/*`, Grafana embeds) keep working without a restart. If YAML and a UI source both exist for the same kind, YAML wins and the UI source is shown as shadowed.

Storing secrets needs a sealing key. With no key, the connect form says so and points at `homedash-config apply`, exactly as "Add service" does today.

### 4.5 Providers in this spec

| Kind | Reads | Notes |
|---|---|---|
| `kuma` | Kuma `/metrics` (existing code) | needs url + API key as today |
| `grafana` | Grafana alert rules route (existing code) | read-only service account token |
| `prometheus` | Prometheus-compatible `GET /api/v1/alerts` and `/api/v1/rules`; Alertmanager `GET /api/v2/alerts` | one provider covers Prometheus, VictoriaMetrics, Mimir, Thanos. Endpoints and fields must be re-verified against their official docs before Phase 2 coding. |
| `jsonpoll` | any HTTP JSON endpoint | admin maps three paths: list of items, name, status (with a value map such as `ok -> up`). Extends the "Any HTTP service" tile idea. |
| `webhook` | inbound POSTs | see below |

**Webhook receiver.** `POST /hooks/monitoring/:sourceId` (outside `/api`, so it does not use sessions). Accepted bodies:
1. Plain: `{ "name": "...", "status": "up|down|pending|firing|resolved|ok|error", "message": "...", "level": "info|warn|error", "url": "..." }`, or an array of these.
2. Alertmanager webhook v4 (`alerts[]` with `status`, `labels`, `annotations`, `startsAt`, `endsAt`). Grafana's webhook contact point sends a compatible payload. Both formats must be confirmed against official docs in Phase 2.
Unknown shapes get 400 with a message naming the fields expected. State is kept in a table so a `resolved` closes the matching alert; entries with no update expire after a per-source TTL (default 7 days) so a dead sender cannot leave a problem open forever.

### 4.6 Alert pipeline and timeline

The notifier's Grafana-specific watcher is replaced by one `watchMonitoring()` that feeds `merged()` into `syncProblems`, using scope `mon` and category `monitor`. Firing alerts and `down` checks become problems; recoveries close them as today. Source-down becomes its own problem ("Monitoring source <name> unreachable") so silence is never mistaken for health. Raise/recover lines are written to the persisted event log with source `monitor` (Kuma transitions already use it) and `grafana` is retired in favour of per-source names inside the message; the existing `alert` delivery lines stay.

## 5. API

| Route | Role | Purpose |
|---|---|---|
| `GET /api/monitoring` | viewer | merged checks, alerts, source states |
| `GET /api/monitoring/sources` | admin | sources, secrets reported only as present/absent |
| `POST /api/monitoring/sources` | admin | create (validates, tests, then saves) |
| `PUT/DELETE /api/monitoring/sources/:id` | admin | edit keeping secrets, remove |
| `POST /api/monitoring/sources/:id/test` | admin | test saved source |
| `POST /api/monitoring/sources/test` | admin | test unsaved form values |
| `GET /api/monitoring/catalog` | admin | provider kinds with their fields and hints |
| `POST /hooks/monitoring/:sourceId` | secret | inbound events |

`/api/monitoring/sources` is added to `ADMIN_PREFIXES` in `roles.ts` (reads and writes both admin). Existing `/api/kuma/*` and `/api/grafana/*` routes stay.

## 6. UI

- New **Monitoring** page: sources panel (state badge, last checked, error text, Connect / Test / Remove) and one merged list of checks and alerts, filterable by source and status. A "Connect a source" form is driven by the provider catalog. The webhook source shows its URL and a copy-ready `curl` example once, plus the secret (shown only at creation, then replaced by "Rotate secret").
- **Overview** reads `/api/monitoring` instead of Kuma incidents plus Grafana alerts. The "Not connected" states already there key off "no sources of this kind".
- **Setup** page rows for Grafana, Uptime Kuma and the new kinds get a **Connect** button opening the same form, and keep the YAML snippet for config-as-code users.
- Mobile app: the merged list as a read-only screen (the existing monitors/incidents screens read the merged endpoint).

## 7. Security

- Admin only to create, edit or delete sources; secrets sealed with the existing key; never returned by any API.
- Every URL an admin enters passes `assertDestinationAllowed`; poll requests have a size and time limit and never follow redirects to a different host.
- Webhook: per-source random secret (at least 32 bytes), sent as `Authorization: Bearer` or `?token=` (header preferred; query allowed because some tools cannot set headers, with a warning in the form that URLs end up in logs). Compared in constant time against a stored hash, not plaintext. Body limit stays at the server's 64 KB, per-source rate limit, wrong secrets get a uniform 401 with no detail. The receiver only records state; it never runs anything and never forwards data elsewhere.
- Everything a source sends (names, summaries, URLs) is untrusted text: length-capped, rendered as text, links restricted to http(s).
- Secrets and tokens are never written to the event log or alert text.

## 8. Backward compatibility

- Installs with Kuma/Grafana in YAML or env see identical behaviour; those become two "managed in config" sources.
- `/api/kuma/*`, `/api/grafana/*` and the Grafana/Kuma pages are unchanged.
- No migration of existing data; two new tables are created if missing.
- `/api/grafana/alerts` (commit `edc21b6`) stays, backed by the grafana provider.

## 9. Data

```sql
monitoring_sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL, secret TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1, interval_s INTEGER NOT NULL DEFAULT 60, created_at INTEGER NOT NULL, created_by TEXT);
monitoring_hook_state (source_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, level TEXT NOT NULL,
                       detail TEXT, url TEXT, since INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (source_id, key));
```
For a `webhook` source the `secret` column holds the SHA-256 hash of the receiver secret (the plain value is shown once at creation and cannot be recovered; "Rotate secret" issues a new one). For every other kind it holds the sealed credentials.
Rows in `monitoring_hook_state` older than the source's TTL are purged hourly by the existing purge timer.

## 10. Per-user popularity (Phase 3, separate plan)

- Table `user_usage (user TEXT, item TEXT, score REAL, last_at INTEGER, PRIMARY KEY (user, item))`. `item` is an id such as `page:monitoring`, `tile:<id>`, `source:<id>`; never a URL or content.
- Update on event: `score = score * 0.5^((now - last_at) / 30 days) + 1`. Read applies the same decay, so ranking is O(1) per item and needs no background job.
- `POST /api/usage` (viewer role, own user only, accepts only known item prefixes, rate-limited); `GET /api/usage/top`; `DELETE /api/usage` resets the caller's own data.
- Shown as a "Your most used" row on Overview and as ordering in the connect gallery (items the user already uses first, then a default order). New users see the default order.
- Data stays on the server, per user; admins cannot read other users' usage through the API.

## 11. Testing

- Pure parsers per provider with fixtures: Prometheus alerts and rules, Alertmanager v2, Alertmanager webhook, plain webhook, JSON poll mapping, Kuma and Grafana (existing tests kept).
- Engine: merge ordering, stale-on-failure, source-down becoming a problem, one failing source not blocking others, recovery pairing.
- Store: sealed round trip, secrets never in API output, YAML-managed shadowing.
- Webhook: wrong/missing secret (uniform 401), oversized body, rate limit, resolve closes alert, TTL expiry, malformed payload gives 400.
- Security: destination guard rejects link-local URLs; untrusted text is capped.
- Browser checks against mock Grafana, Prometheus, Kuma metrics and a `curl` webhook, as done for the Grafana and ntfy features; the first-user audit is rerun on the Monitoring page and Setup connect flow.
- All 150 existing server tests keep passing at every phase.

## 12. Phases

1. **Core.** Types, registry, engine (the database store moves to Phase 2: with YAML-only sources there is nothing to store); Kuma and Grafana providers wrapping existing code; `GET /api/monitoring`; Overview and notifier read the merged list; no UI to add sources yet (YAML sources only). Behaviour-preserving; the proof is the existing tests plus the new engine tests.
2. **Connect from the UI.** Sources API and Monitoring page; Prometheus/Alertmanager, JSON poll and webhook providers; Setup Connect buttons; runtime config for Kuma and Grafana. Closes FUA-012 for monitoring.
3. **Usage and "Your most used".** Section 10.
4. **More providers.** Zabbix, Netdata, Checkmk, Beszel, Healthchecks and others, chosen from researched popularity and verified against each tool's own docs, then the same pattern for Logs.

## 12a. Changes decided in the Phase 2 plan

- `prometheus` and `alertmanager` are separate provider kinds (different endpoints and auth).
- `monitoring_hook_state` gains a `type` column (`check` or `alert`).
- Prometheus documents only basic auth and client certificates for its own server; the bearer-token field is for servers behind a reverse proxy.
- Pushed webhook requests are logged with `?token=` masked.
- Formats verified from primary sources: `docs/research/monitoring-provider-formats.md`.

## 13. Risks and open questions

- **Unverified external formats.** Prometheus/Alertmanager endpoints and the Alertmanager/Grafana webhook payloads are from memory of their documentation and must be re-read from the official docs at the start of Phase 2. The Grafana rules route is an internal source route, not a documented contract (see `docs/research/one-stop-dashboard-gaps.md`).
- **Inbound endpoint exposure.** The webhook is the first network door that is not session-protected. Mitigations are in section 7; if homedash sits behind nginx, the endpoint can also be limited to the LAN there. Owner decision (2026-11-26): the query-string token form is allowed, with a warning in the connect form that URLs end up in logs; the header form is preferred and shown first.
- **State for pushed checks.** A "down" pushed once and never resolved stays until the TTL. Heartbeat-style "no news is bad news" is out of scope for this spec.
- **Merging identical problems from two sources** (Grafana and Alertmanager both firing the same rule) is not deduplicated; they appear once per source.
- **Loss of the `grafana` event source name.** Existing timeline filters for `grafana` would be replaced by `monitor`; no stored data depends on it yet (added one commit ago).
