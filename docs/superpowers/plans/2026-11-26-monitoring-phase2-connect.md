# Monitoring module, Phase 2: connect sources from the UI

Spec: `docs/superpowers/specs/2026-11-26-monitoring-module-design.md` (section 12, Phase 2). Phase 1 is done (`docs/superpowers/plans/2026-11-26-monitoring-phase1-core.md`).
Verified formats: `docs/research/monitoring-provider-formats.md` (primary sources; read it before Tasks 3 and 4).

Goal: an admin can connect Grafana, Uptime Kuma, Prometheus, Alertmanager, a JSON endpoint, or any tool that can POST a webhook, from the browser, and it appears on Overview and in alerts within a minute, with no restart and no YAML. This closes audit finding FUA-012 for monitoring.

## Decisions taken while planning (differences from the spec text)

1. **Two Prometheus-family kinds, not one.** `prometheus` reads `GET /api/v1/rules?type=alert` (rules with their `alerts[]`); `alertmanager` reads `GET /api/v2/alerts?active=true&silenced=false&inhibited=false`. They have different shapes and different auth, so one form field set per kind is clearer. The form says "Prometheus-compatible: Grafana Mimir's ruler and vmalert document the same endpoints; Thanos Ruler's docs do not, so it is untested".
2. **Prometheus auth.** Prometheus documents only basic auth and client certificates for its own server (no bearer token). The form offers username/password; a bearer-token field exists for servers behind a reverse proxy and is labelled that way. Client certificates are out of scope.
3. **Unknown alert states are tolerated.** Only `firing` is confirmed from the docs for the Prometheus alert `state`. Parsers keep `firing` and `pending` and ignore anything else (including `inactive`) instead of failing.
4. **Webhook auth.** Accept `Authorization: Bearer <secret>` (Alertmanager `http_config.authorization` and Grafana's Authorization header are documented to send it) and, as approved by the owner, `?token=<secret>`. The query form for Alertmanager is an inference from its source (the configured URL is sent as written); Grafana stores the webhook URL in plain text and advises against secrets in it. The form shows the header form first and warns about the query form.
5. **Webhook table gets a `type` column** (`check` or `alert`), which the spec's table lacked, so a plain `{name,status}` check and an Alertmanager alert can share the table.
6. **Request-log redaction is required.** Fastify's default request log includes the URL; a `?token=` would land in the logs. Task 4 adds a serializer that masks it.
7. **Pull sources poll on their own interval** (default 60 s, minimum 15 s). The Phase 1 10-second loop stays as the notifier tick; each source is only re-read when its interval has elapsed.

## Files

Create:
- `server/src/monitoring/store.ts`: sources and hook-state tables, sealing, secret hashing
- `server/src/monitoring/catalog.ts`: provider kinds, their form fields and hints (pure data, like `tile-kinds.ts`)
- `server/src/monitoring/providers/prometheus.ts`, `alertmanager.ts`, `jsonpoll.ts`, `webhook.ts`
- `server/src/monitoring/hook.ts`: the inbound receiver and its limiter
- `server/src/monitoring/admin.ts`: sources API
- `server/test/monitoring-store.test.mjs`, `monitoring-parsers.test.mjs`, `monitoring-hook.test.mjs`, `monitoring-admin.test.mjs`
- `src/pages/Monitoring.tsx`, `src/components/SourceForm.tsx`
- `docs/MONITORING.md`: user guide with Alertmanager and Grafana configuration snippets and `curl` examples

Modify:
- `server/src/db.ts`: two tables in `SCHEMA`; hourly purge of expired hook state
- `server/src/monitoring/types.ts`, `engine.ts`, `sources.ts`: instances from the database, per-source interval, `SourceState` gains `managed: 'config' | 'ui'` and `enabled`
- `server/src/kuma.ts`: make `startKuma` idempotent and callable after boot
- `server/src/roles.ts`: `/api/monitoring/sources` is admin for reads and writes
- `server/src/index.ts`: register the receiver and admin routes; request-log serializer
- `src/App.tsx` (nav entry), `src/api.ts`, `src/types.ts`, `src/pages/Setup.tsx` (Connect buttons), `src/pages/Overview.tsx` (links to `#/monitoring`)
- `mobile/src`: read-only Monitoring screen
- `CHANGELOG.md`

## Task 1: storage

`server/src/db.ts` SCHEMA additions:

```sql
CREATE TABLE IF NOT EXISTS monitoring_sources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL, secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, interval_s INTEGER NOT NULL DEFAULT 60, ttl_hours INTEGER NOT NULL DEFAULT 168,
  created_at INTEGER NOT NULL, created_by TEXT);
CREATE TABLE IF NOT EXISTS monitoring_hook_state (
  source_id TEXT NOT NULL, key TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, level TEXT NOT NULL,
  detail TEXT, url TEXT, since INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (source_id, key));
CREATE INDEX IF NOT EXISTS hook_state_seen ON monitoring_hook_state (last_seen);
```

`store.ts` (modelled on `tilestore.ts`): `createSource`, `updateSource` (keeps a secret the form left blank), `deleteSource` (also deletes its hook state), `listSources` (never returns secrets, only `hasSecret`), `loadSources` (opens sealed secrets, skips rows that cannot be opened with a warning), `newSourceId()` (`src-` plus 4 random bytes hex). Reuses `sealKey()`, `seal`, `unseal`; without a key it throws `NO_SECRET_KEY` as the tile store does. For a `webhook` source the `secret` column holds the **SHA-256 hex of the receiver secret**, not a sealed value; `generateHookSecret()` returns 32 random bytes as base64url, shown once.
Hook state helpers: `upsertHookState`, `deleteHookState`, `readHookState(sourceId, ttlHours)` (filters expired rows at read time), `purgeHookState(now)` called from the existing hourly timer in `db.ts`.

Tests (`monitoring-store.test.mjs`, temp DB, `SECRETS_KEY` set): sealed round trip; the secret column never contains the plain token; `listSources` output has no secret fields; an edit with a blank token keeps the old one; a wrong key skips the row without throwing; webhook secret is stored as a hash that matches `sha256(secret)`; deleting a source deletes its hook state; `readHookState` honours the TTL; no key gives `NO_SECRET_KEY`.
Commit: `feat(monitoring): sources and hook-state storage`.

## Task 2: catalog, runtime config, per-source interval

`catalog.ts`: pure data, one entry per kind with `kind`, `label`, `hint`, and `fields` (`{name, label, type: 'url'|'text'|'secret'|'number'|'map', required, hint}`): 
- `kuma`: url, api_key (hint: Uptime Kuma metrics need an API key).
- `grafana`: url, token (hint: a read-only service account; needs permission to read alert rules, exact role unverified), public_url, datasource_uid.
- `prometheus`: url, username, password, bearer_token ("only if a reverse proxy in front asks for one").
- `alertmanager`: url, username, password, bearer_token.
- `jsonpoll`: url, token (sent as a bearer token), items_path, name_path, status_path, status_map (`ok=up, fail=down`), detail_path.
- `webhook`: ttl_hours, plus the generated secret.

Engine changes: `Instance` gains `intervalS`; `createEngine` only calls `poll` again when `now - lastPolledAt >= intervalS*1000` (tests drive a fake clock); `SourceState` gains `managed: 'config' | 'ui'`, `enabled`. `sources.ts` returns implicit config sources plus `loadSources()` mapped through `makeProvider(kind, config, secret)`.

**Shadowing:** if a `kuma` or `grafana` UI source exists while YAML/env also configures that kind, the UI source is listed as `shadowed` and not polled (YAML wins).
**Runtime config for kuma and grafana:** saving or enabling such a source (when YAML does not set it) assigns `cfg.kumaUrl/kumaApiKey` or `cfg.grafanaUrl/grafanaToken/grafanaPublicUrl/grafanaDsUid`; deleting or disabling restores the empty values. `kuma.ts` `startKuma(app)` becomes idempotent (guards a started flag) and is called after a Kuma source is saved so the scraper starts without a restart. SSRF: every URL passes `assertDestinationAllowed` exactly as `buildTile` does.

Tests: interval gating with a fake clock; shadowing; runtime config applied and removed; `startKuma` idempotent.
Commit: `feat(monitoring): catalog, per-source interval, runtime config for Kuma and Grafana`.

## Task 3: pull providers (parsers first)

Pure parsers, tested with fixtures adapted from the verified note (every fixture marked "adapted from the official docs, not captured from a live server"):

- `prometheus.ts`: `parsePromRules(body)` over `data.groups[].rules[]` where `type === 'alerting'`; per rule, alerts with `state` `firing` or `pending` only; `name`, `labels.severity` (`critical|error|page|high` is error, else warn), `annotations.summary` or `description`, `activeAt` for `since`, instance count, key `<file>/<group>/<name>`. `health` is not used to decide state. Unknown states ignored. Provider `poll` does `GET {url}/api/v1/rules?type=alert` with basic auth or bearer, timeout 10 s, no cross-host redirects.
- `alertmanager.ts`: `parseAmAlerts(body)` over the v2 array: keep `status.state === 'active'`, key `fingerprint`, name `labels.alertname`, `startsAt`, summary from annotations, level from `labels.severity`, url `generatorURL` only if http(s). Query `?active=true&silenced=false&inhibited=false`.
- `jsonpoll.ts`: `mapJson(body, mapping)` using a small path syntax (`a.b[0].c`, array root with `$`). Items become checks; status via `status_map` with unknown values mapped to `unknown`. Rejects mappings that yield zero items with a clear message in `test()` so a wrong path is caught before saving.
- `test()` for each kind makes the real request and returns `{ok, message, count}` (for example "Read 12 rules, 2 firing").

Tests (`monitoring-parsers.test.mjs`): the adapted Prometheus example gives one firing alert with the right fields; `pending` kept, `inactive`, a made-up state, and recording rules ignored; truncated or junk bodies give an empty list without throwing; Alertmanager suppressed alerts dropped, `generatorURL: "javascript:..."` becomes null; JSON path edge cases (missing path, wrong type, huge array capped at 500 items); no secret or token appears in any error message.
Commit: `feat(monitoring): Prometheus, Alertmanager and JSON providers`.

## Task 4: inbound webhook

`hook.ts`: `POST /hooks/monitoring/:sourceId`, outside `/api` (no session, no CSRF hook, no global limiter), so everything is enforced here.

Auth: read `Authorization: Bearer`, else `?token=`. Compute `sha256(token)` and compare to the stored hash with `timingSafeEqual`. Unknown source id, disabled source, wrong or missing token all return the same `401 {"error":"Unauthorized"}` after the same work (hash a dummy when the id is unknown) so ids cannot be probed.

Limits: fixed-window limiter in the module, 120 requests per minute per source and 30 failed attempts per minute per IP (separate maps, swept every minute like `ratelimit.ts`), 429 with `Retry-After`. Global `bodyLimit` (64 KB) stays; a larger Alertmanager group returns 413 and the guide says to set `max_alerts`.

Payloads (detected by shape, never by trusting a claimed type):
1. **Alertmanager v4:** `alerts[]` with per-alert `status` (`firing|resolved`), `labels`, `annotations`, `startsAt`, `generatorURL`, `fingerprint`. Read each item's own `status`, never the group's.
2. **Grafana:** same keys, `version: "1"`, per-alert `status`; also accept top-level `state` (`alerting|ok`) and `title` when `alerts` is empty.
3. **Plain:** `{name, status, message?, level?, url?}` or an array of those. `status` `up|ok|resolved` is a check `up`; `down|error|firing|alerting` is a check `down` (type `check`) or, if `level` or `kind:"alert"` is given, an alert; `pending|warn` pending.
Key = fingerprint, else `sha256(sorted labels)`, else the name. `firing` upserts (keeping the original `since`), `resolved` or `up` deletes the alert row and writes a timeline line. Names, summaries and URLs are length-capped (200/500/500), URLs restricted to http(s). Unknown shapes get `400` listing the three accepted shapes. Response `200 {"accepted": n}`.

Logging: in `index.ts` set `logger.serializers.req` to the default plus a `url` with `([?&]token=)[^&]*` replaced by `$1***`. Test it by asserting a captured log line never contains the secret.

Tests (`monitoring-hook.test.mjs`, real server booted like `access.test.mjs`, one source created through the store): no/wrong/bearer/query token behaviours and uniform 401 body and status for unknown id; limiter returns 429; each payload shape creates the expected state, a resolved item removes it, a repeat of a firing item does not reset `since`; group status `firing` with one `resolved` item is handled per item; oversized body is 413; malformed JSON is 400; long and hostile strings are capped; the secret never appears in the server log.
Commit: `feat(monitoring): inbound webhook receiver`.

## Task 5: webhook provider and sources API

`providers/webhook.ts`: `poll()` reads `readHookState`, maps rows to checks and alerts, never throws (push sources are "ok" until deleted); `SourceState.checkedAt` is the newest `last_seen` (0 when nothing has arrived yet, which the UI shows as "waiting for the first event").

`admin.ts` (all admin, `ADMIN_PREFIXES` gets `/api/monitoring/sources`; `GET /api/monitoring` stays viewer):
- `GET /api/monitoring/catalog`, `GET /api/monitoring/sources`
- `POST /api/monitoring/sources/test` (unsaved values), `POST /api/monitoring/sources/:id/test`
- `POST /api/monitoring/sources` validates, runs `test()`, refuses to save a failing source unless `force:true`, saves, applies runtime config, triggers one immediate poll
- `PUT /api/monitoring/sources/:id`, `DELETE /api/monitoring/sources/:id`, `POST /api/monitoring/sources/:id/rotate` (webhook only, returns the new secret once)
- the webhook create response includes `{ id, url, secret }` once; later reads return only the URL pattern and a masked hint.
Every write goes to the existing audit log with the source name and kind, never the secret.

Tests (`monitoring-admin.test.mjs`, in-process or booted server): non-admins get 403 on every sources route and viewers can still read `/api/monitoring`; the secret is returned exactly once and never by list/get; a link-local URL is rejected; a failing test blocks the save unless forced; delete removes state; audit entries contain no secret; the API reference test (`openapi`) lists the new routes with the right role.
Commit: `feat(monitoring): webhook provider and sources API`.

## Task 6: web UI

- `Monitoring.tsx` (nav entry "Monitoring" under MONITORING; visible to everyone, sources panel only for admins): the merged checks and alerts with filters by source and status, source cards (state badge, last checked, error, stale marker, Test, Edit, Remove), "Connect a source".
- `SourceForm.tsx`, modelled on `ServiceForm.tsx`: pick a kind from `/api/monitoring/catalog`, fields from the catalog, a Test button showing the real result, Save. The webhook step shows the URL, the bearer-header snippet first, the query-string URL with the log warning, a ready `curl`, and an Alertmanager `webhook_configs` snippet; the secret is shown once with a copy button and a "Rotate" action afterwards.
- `Setup.tsx`: the Grafana, Uptime Kuma and alerts rows get a **Connect** button opening the same form (YAML snippet stays below for config-as-code); a source managed in config shows the existing badge instead of a button.
- `Overview.tsx`: attention items link to `#/monitoring` instead of `#/setup`.
- When no sealing key exists the form explains it and points at `homedash-config apply`.
- Mobile: a read-only Monitoring screen using `api.monitoring`.
Checks: `npx tsc --noEmit` for web and mobile; the repo's axe accessibility test extended with the new page if the harness allows.
Commit: `feat(monitoring): Monitoring page and connect form`.

## Task 7: docs, verification, changelog

1. `docs/MONITORING.md`: what a source is, each kind with its fields and token advice (Prometheus basic auth only, Grafana read-only service account, Alertmanager `http_config.authorization`), the webhook shapes with copy-paste `curl`, Alertmanager and Grafana configuration snippets, and the log warning about the query-string token including reverse-proxy logs.
2. Server tests: all existing 166 plus the new ones, three consecutive runs; keep full output if the unexplained one-off failure from earlier ever appears.
3. Browser end-to-end on a scratch instance with mocks (extend `qa/first-users/mocks2.mjs`): connect Grafana, Kuma and Prometheus from the form, post an Alertmanager payload with `curl` using the header and the query token, post a plain check, resolve it, watch Overview and ntfy deliveries, delete a source, confirm nothing sensitive in the server log. Save evidence under `qa/first-users/evidence/`.
4. Re-run the first-user audit (impatient and breaker personas) on the Setup Connect flow and the Monitoring page; record the results in `qa/first-users/`.
5. `CHANGELOG.md`, spec updated for the decisions above, `npm run build`, mobile type check.
Commit: `docs(monitoring): user guide and changelog`.

## Out of scope

Usage counters and "Your most used" (Phase 3). More providers such as Zabbix, Netdata, Checkmk and Beszel, and Logs (Phase 4). Client-certificate auth to Prometheus. Heartbeat-style "no news is bad news" for webhook checks. Deduplicating the same problem reported by two sources.

## Risks

- **Open endpoint.** The webhook is the first route not behind a session. Mitigations: hashed secret, constant-time compare, uniform 401, two limiters, size limit, no execution, log redaction. Reverse proxies can also restrict `/hooks/` to the LAN; the guide says how.
- **Query-string token in logs.** Redacted in homedash's own log but not in a reverse proxy's or the sender's logs; the form says so.
- **Unverified formats.** Alertmanager's content type, Mimir and vmalert response shapes and non-`firing` states are not confirmed; parsers tolerate unknown values and the guide labels these as untested.
- **Runtime config mutation.** Writing to `cfg` at runtime touches shared state; every assignment goes through one function with tests, and YAML values are never overwritten.
- **Secret key absent.** UI sources need `SECRETS_KEY`; the form must say so instead of failing late.
