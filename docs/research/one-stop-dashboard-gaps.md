# One-stop dashboard: what is integrated, what is missing

Research date: 2026-11-26. Scope: Grafana, Loki, Uptime Kuma, ntfy, Proxmox VE, and how comparable dashboards integrate them.
Aim (from the owner): homedash is the single place that attaches Grafana, Loki, Uptime Kuma, ntfy and similar, so routine tasks never need those tools' own UIs.

Conventions in this file:
- **[V]** verified against a primary source (the URL or repo path is next to it).
- **[I]** my inference. Labelled so it is not mistaken for fact.
- **[U]** could not verify. Stated plainly.
- Source pages were read through a fetch tool that summarises pages; where a summary said a page was truncated or silent, that is noted rather than filled in.

---

## 1. What homedash already has (read from this repo)

| Service | Depth today | Evidence (repo files) |
|---|---|---|
| Grafana | **Read-only embed plus a PromQL proxy.** Lists dashboards (`/api/search`), lists panels of a dashboard, builds `d/` and `d-solo/` iframe URLs, and proxies `query_range` through Grafana's datasource proxy. Nothing is written to Grafana. No alert, annotation or contact-point calls. Needs `allow_embedding`. | `server/src/grafana.ts` (59 lines, read in full), `src/pages/Grafana.tsx` (iframes at lines 85, 96), `API_NOTES.md` "Cookies / hosting" |
| Grafana (reverse direction) | homedash exposes Prometheus `/metrics` (guests, host, nodes, storage, health score, errors) with a ready dashboard. | `server/src/metrics.ts`, `grafana/README.md`, `grafana/homedash-dashboard.json` |
| Prometheus | Instant queries used for tiles and cards. | `server/src/prom.ts` |
| Loki | **Native data, read-only.** Analytics (log levels, hosts, nginx status classes, p95 per vhost, silent sources), label browser, LogQL range query, histogram. No live tail, no ruler/alert rules, no `index/stats`/`volume`/`patterns`. | `server/src/loki.ts` (187 lines, read in full), `src/pages/LogAnalytics.tsx`, `src/pages/Logs.tsx`. A grep for `tail` found nothing in `loki.ts` or `Logs.tsx`. |
| Uptime Kuma | **Native data, read-only, derived from `/metrics`.** Scrapes `monitor_status` and `monitor_response_time` every `kumaPollMs`, stores samples in `kuma_samples` (31 days), computes uptime % and heartbeats itself, derives incidents. Optional iframe of a Kuma status page. Kuma state also feeds the public `/status` page and the alert pipeline. **No monitor create/edit/pause, no Kuma notification config, no maintenance windows in Kuma.** | `server/src/kuma.ts` (read in full), `src/pages/Kuma.tsx`, `API_NOTES.md` (backend deviations), `server/src/status.ts` |
| ntfy | **Write-only publisher plus a link out.** ntfy is one of 10 alert channels (publish via JSON to the root URL, Bearer token optional). The mobile Notifications screen shows a "Subscribe in ntfy" button that opens the topic URL in the ntfy app. homedash never subscribes, so ntfy messages from other sources are not visible in homedash. | `server/src/channels.ts` (ntfy adapter), `server/src/notify.ts` line 340 (`subscribeUrl`), `mobile/src/screens/Notifications.tsx` lines 27-46 |
| Alerting engine (homedash's own) | Categories, per-channel level filters, de-duplication (10 min), hourly cap (40), maintenance windows, routes by kind/severity/text/time, incident open/close for PagerDuty and Opsgenie, test button. History of sent alerts is **in memory, last 100 only** (`const sent: Sent[]`, trimmed at 100). Persistent events (`system_events`, with TTL `EVENT_RETENTION_DAYS`) exist separately and feed `/api/logs/events`. | `server/src/notify.ts`, `server/src/alertrules.ts`, `server/src/channels.ts`, `server/src/events.ts`, `server/src/db.ts` (table list), `API_NOTES.md` "Logs and Keycloak" |
| Proxmox backups | **Exists.** Protection page (per guest: ok/stale/never, not-in-any-job via `/cluster/backup-info/not-backed-up`, old snapshots, one-click snapshot), a Health check, Capacity forecast per storage, on-demand vzdump for QEMU, a PBS tile, failed-task alerts (`tasks?errors=1`). **Not present:** a view of the backup *jobs* (`/cluster/backup`), per-job last result, or PVE's own notification system. | `server/src/insights.ts` lines 116-215, `server/src/health.ts` lines 99-121, `server/src/qemu.ts` line 149, `server/src/notify.ts` line 204, `src/pages/Protection.tsx`, `src/pages/Capacity.tsx`. A grep for `cluster/backup` found only `backup-info/not-backed-up`; a grep for `cluster/notifications` found nothing. |
| Services tiles | 21 kinds (Docker, Portainer, Pi-hole, AdGuard, NPM, Traefik, Jellyfin, Plex, Sonarr, Radarr, Lidarr, Prowlarr, Immich, qBittorrent, Home Assistant, Nextcloud, PBS, NUT UPS, generic HTTP), add/test/discover in UI, public status page. No Grafana, Kuma, Loki or ntfy tile kind. | `server/src/tile-kinds.ts` lines 19-37 |
| Mobile | Screens: Overview, Guests, GuestDetail, Node, Tasks, Uptime, Sites, Notifications, Diagnostics, Gpu, More. API-token sign-in. **No push receiver in the app** (grep for `expo-notifications` and `push` in `mobile/package.json` and `mobile/src` found no code use). Push is delegated to the ntfy app. | `mobile/src/screens/`, `mobile/src/screens/More.tsx` line 45, `REPORT.md` ("Web Push ... ntfy, Gotify, Telegram and the other 6 channels already push to phones") |
| Already decided against | Web Push (needs push service and keys, untestable), editing `homedash.yaml` from the browser, built-in ACME. | `REPORT.md` section 3 and section 2 |
| Scheduled guest actions | Exist (`schedules` table). **Out of scope for this document.** | `server/src/db.ts` line 73 |

Reading of the repo: homedash is strong on Proxmox and on *reading* Kuma/Loki/Grafana. It is weak exactly where the aim bites: it cannot show or act on what Grafana alerts or Kuma configuration say, cannot show anything that arrives in ntfy, and its incident history is not a single persisted timeline.

---

## 2. What the services actually offer (primary sources)

### 2.1 Grafana

- **[V] Annotations API.** `GET /api/annotations`, `POST /api/annotations`, `DELETE /api/annotations/:id`, also `PUT`/`PATCH` and `GET /api/annotations/tags`. Create takes `text` (required), optional `dashboardUID`/`panelId` (omit both for an organisation annotation), `time`/`timeEnd` in epoch ms, `tags`. RBAC actions `annotations:read`, `annotations:create`, `annotations:delete`. Source: https://grafana.com/docs/grafana/latest/developers/http_api/annotations/ (the page also says `/api` routes are being deprecated in favour of `/apis` starting in Grafana 13).
- **[V] Alerting provisioning API** (rules, contact points, notification policies, mute timings: full CRUD). `GET/POST /api/v1/provisioning/alert-rules`, `.../contact-points`, `.../policies`, `.../mute-timings`. The page marks most of these deprecated in favour of `/apis/...`, and does not list the RBAC scopes needed. Source: https://grafana.com/docs/grafana/latest/developers/http_api/alerting_provisioning/ . A search result also reports a newer alert-rules API at `GET /apis/rules.alerting.grafana.app/v1beta1/namespaces/{namespace}/alertrules` for Grafana 13.3+ (https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/alert-rules/ , seen only as a search snippet, page not read).
- **[V] Read-only alert state.** The provisioning docs do **not** document firing alerts or rule state (I read both halves of the page). The routes exist in Grafana's source:
  - `GET /api/prometheus/grafana/api/v1/rules` and `GET /api/prometheus/grafana/api/v1/alerts` (https://raw.githubusercontent.com/grafana/grafana/main/pkg/services/ngalert/api/generated_base_api_prometheus.go)
  - `GET /api/alertmanager/{DatasourceUID}/api/v2/alerts`, `.../alerts/groups`, `GET/POST .../api/v2/silences`, `GET/DELETE .../api/v2/silence/{SilenceId}` (https://raw.githubusercontent.com/grafana/grafana/main/pkg/services/ngalert/api/generated_base_api_alertmanager.go)
  - These are source-code routes, not a documented stable contract. Homepage uses `alertmanager/grafana/api/v2/alerts` for its Grafana alert counts (https://raw.githubusercontent.com/gethomepage/homepage/main/src/widgets/grafana/widget.js). **[U]** The RBAC action names needed for these read routes were not verified.
- **[V]** Auth with a service-account Bearer token is what the provisioning examples use (same page); homedash already sends one.

### 2.2 Loki

All from https://grafana.com/docs/loki/latest/reference/loki-http-api/ **[V]**:
- Query: `/loki/api/v1/query` (metric queries only), `/query_range`, `/labels`, `/label/<name>/values`, `/series`.
- Volume and stats: `/index/stats`, `/index/volume`, `/index/volume_range` (on by default via `volume_enabled`).
- `/patterns` needs `pattern_ingester.enabled: true`.
- **Tail:** `GET /loki/api/v1/tail` is a **WebSocket**, params `query`, `delay_for` (0-5 s), `limit`, `start`; lookback is best-effort; responses carry `streams` and `dropped_entries`.
- **Ruler (Prometheus-compatible):** `GET /prometheus/api/v1/rules` (filters `type`, `file`, `rule_group`, `rule_name`) and `GET /prometheus/api/v1/alerts` (active alerts). `/loki/api/v1/rules` also exists but needs object storage for rules.
- Multi-tenancy via `X-Scope-OrgID`. "Loki does not handle authorization", so homedash's unauthenticated access (`loki.ts` sends only `Accept`) relies on network trust.

### 2.3 Uptime Kuma

- **[V] Prometheus `/metrics`**: basic auth by default, or an API key; "adding your first API key turns off basic auth for the endpoint permanently" (https://github.com/louislam/uptime-kuma/wiki/Prometheus-Integration). Metrics in `server/prometheus.js` on master: `monitor_status`, `monitor_response_time`, `monitor_response_time_seconds{window}`, `monitor_uptime_ratio{window}` (windows 1d, 30d, 365d), `monitor_cert_days_remaining`, `monitor_cert_is_valid`; labels include `monitor_id`, `monitor_name`, `monitor_type`, `monitor_url`, `monitor_hostname`, `monitor_port` plus tag labels (https://raw.githubusercontent.com/louislam/uptime-kuma/master/server/prometheus.js). **[U]** Master's `package.json` says `3.0.0-beta.3`, so these may not all exist in the stable release a user runs. **[I]** The comment in `kuma.ts` and `API_NOTES.md` that `/metrics` "exposes no monitor id" may be out of date for current releases; worth testing against a real Kuma.
- **[V] Status page JSON, public, cached**: `GET /api/status-page/:slug` (config, incidents, monitor list; 5 min cache), `GET /api/status-page/heartbeat/:slug` (last 100 heartbeats per public monitor plus 24 h uptime; 1 min cache), `.../incident-history`, `.../badge`, `/status/:slug/rss` (https://raw.githubusercontent.com/louislam/uptime-kuma/master/server/routers/status-page-router.js).
- **[V] Push monitors**: `ALL /api/push/:pushToken?status=up|down&msg=&ping=`; no auth beyond the token; explicit `status=down` skips retries; 404 for unknown or inactive monitors (https://raw.githubusercontent.com/louislam/uptime-kuma/master/server/routers/api-router.js). Badges `/api/badge/:id/{status,uptime,ping,avg-response,cert-exp,response}` need no auth but only work for public monitors.
- **[V, with caveat] REST for monitor lists**: the same file on master has an "OpenAPI router" with `GET /api/info` and `GET /api/monitors` behind `requireApiKey`, plus `/api/openapi.json` and `/api/docs`. This is master (3.0.0-beta.3); I found no release note or wiki page for it, and the wiki does not describe it. **[U]** Whether any stable release ships it, and whether it can write.
- **[V] Management is Socket.IO.** The official wiki's "Internal API" page says Kuma "primarily uses Socket.io for real-time communication after authentication" and offers REST for push, badges, metrics and public status page data (as reported by search; the page text I could fetch contained only a table of contents; https://github.com/louislam/uptime-kuma/wiki/Internal-API). Community wrappers (https://github.com/lucasheld/uptime-kuma-api and a v2 fork) are version-matched per Kuma release, which **[I]** implies the Socket.IO event set changes between versions. I found no first-party statement of stability and no first-party Socket.IO reference.
- **[V] Comparable products accept this limit**: Homepage says "Uptime Kuma doesn't have a full API yet, so the widget reads from a single status page" and needs the status-page slug (https://gethomepage.dev/widgets/services/uptime-kuma/).

### 2.4 ntfy

- **[V] Publish**: PUT/POST to `/<topic>` or JSON to the **root URL** (topic in body). Fields include `title`, `tags`, `priority` 1-5, `click`, `actions`, `attach`, `markdown`, `delay`, `email`, `sequence_id`. Up to three **actions**: `view`, `http` (method, headers, body, `clear`), `broadcast` (Android only), `copy`. Source: https://docs.ntfy.sh/publish/ . Same-sequence-ID re-publish replaces a pending delayed message (dead-man's-switch pattern, same page). homedash already publishes JSON to root and sets `click`; it sets no `actions`.
- **[V] Auth**: `Authorization: Bearer tk_...`, or Basic with empty user and the token as password, or user:password (https://docs.ntfy.sh/publish/ , offset 100000). Access tokens "grant users full access to the user account" (granular tokens not implemented), format `tk_` + 32 chars, up to 60 per user (https://docs.ntfy.sh/config/). Default access is open unless `auth-default-access: deny-all`.
- **[V] Subscribe**: `<topic>/json` (JSON stream), `/sse`, `/raw`, `/ws`; `since=` accepts duration, timestamp, message ID, `all`, `latest`; `poll=1` returns cache and closes (default `since=all`, 10 MB cap per topic replay, HTTP 429 code 42905 when bandwidth budget exceeded); filters on id, message, title, priority (OR), tags (AND); up to 150 comma-separated topics on one connection; Basic auth header or `auth=` query param. Source: https://docs.ntfy.sh/subscribe/api/ . Messages "may be cached for a couple of hours".
- **[V] Mobile push**: ntfy's Android app uses Firebase "only for the main host `ntfy.sh`, and only in the Google Play flavor"; F-Droid build uses instant delivery (a foreground service) (https://docs.ntfy.sh/subscribe/phone/). For a self-hosted server, Firebase "only works if you modify and build your own Android .apk" (https://docs.ntfy.sh/config/). For iOS with self-hosted ntfy, `upstream-base-url` forwards a poll request (message ID and topic hash only) to an upstream server, otherwise delivery "can take hours" (same config page). UnifiedPush needs anonymous write on topics prefixed `up*` for private servers.
- **[I] Consequence for homedash's own app**: a self-hosted, unmodified ntfy cannot give homedash's Expo app instant background push without either keeping the ntfy app (current design) or running a foreground service. In-app inbox via polling/stream while the app is open is feasible; reliable background push from homedash itself is not shown to be feasible by the sources. I did not read Expo's push documentation, so **[U]** what Expo's push service would require.

### 2.5 Proxmox VE

Paths below were read from the official API schema, https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js **[V]**:
- `GET /cluster/backup` "List vzdump backup schedule" (perm `Sys.Audit` on `/`); `POST /cluster/backup` creates a job (`Sys.Modify`). `GET /cluster/backup/{id}`, `/cluster/backup/{id}/included_volumes`. `GET /cluster/backup-info/not-backed-up` (already used).
- `GET /nodes/{node}/tasks` with params `errors`, `limit`, `since`, `until`, `source`, `start`, `statusfilter`, `typefilter`, `userfilter`, `vmid`; `GET /nodes/{node}/tasks/{upid}/status` and `/log`.
- `POST /nodes/{node}/vzdump` (needs `VM.Backup` and `Datastore.AllocateSpace`); `GET /nodes/{node}/storage/{storage}/content` (backups, notes).
- **Notifications API**: `/cluster/notifications/endpoints/{gotify,sendmail,smtp,webhook}[/{name}]`, `/targets`, `/targets/{name}/test` (POST, "Send a test notification"), `/matchers`, `/matcher-fields`, `/matcher-field-values`. Matcher/target writes need `Mapping.Modify` on `/mapping/notifications`.
- Docs: targets are sendmail, SMTP, Gotify and **webhook** ("HTTP requests to a configurable URL", Handlebars-templated URL, headers, body). Events: `vzdump` (info or error, job ID only for scheduled jobs), `fencing`, `replication`, `package-updates`, `multipath`, `system-mail` (https://pve.proxmox.com/pve-docs/chapter-notifications.html). Backup jobs: `notification-mode` default `auto`; `mailto` deprecated in favour of targets/matchers (https://pve.proxmox.com/pve-docs/chapter-vzdump.html). Protected backups are ignored by pruning (same page).
- **[I]** Because PVE can POST events to a webhook, homedash could expose one inbound endpoint and receive vzdump/fencing/replication results as they happen rather than inferring them from task lists. I did not verify the webhook body schema; the docs say it is templated by the user.
- **[U]** I found no power/energy metric in the PVE API schema by reading section names only; I did not search it exhaustively.

---

## 3. How comparable dashboards integrate these (table stakes)

| Product | What it does with these services | Source |
|---|---|---|
| Homepage | Kuma: status-page slug only, fields up/down/uptime/incident. Grafana: widget with dashboards, datasources, total alerts, triggered alerts (alert source `grafana` or `alertmanager`; v1 for Grafana <= 10.4, v2 after). Widgets exist for ntfy, Gotify, Proxmox, Proxmox Backup Server. No Loki widget. | https://gethomepage.dev/widgets/services/uptime-kuma/ , https://gethomepage.dev/widgets/services/grafana/ , https://gethomepage.dev/widgets/ |
| Homarr | Integration list includes Uptime Kuma, Prometheus, ntfy, Gotify, Beszel, Proxmox. Grafana, Loki and PBS not listed in what I read. | https://homarr.dev/docs/integrations/ |
| Dashy | Named widgets include Uptime Kuma, "Ntfy stream", "Prometheus Data", NetData history, HealthChecks. Grafana only via an Image widget. (Details truncated in what I could read.) | https://dashy.to/docs/widgets/ |
| Beszel | Not an aggregator: its own agent with alerts, history, container stats, S.M.A.R.T. alerts, several notification services, OAuth. | https://raw.githubusercontent.com/henrygd/beszel/main/readme.md |

**[I] Table stakes** are therefore: up/down summary from Kuma, a count of firing Grafana alerts, an ntfy "stream" view, and PBS/Proxmox status. homedash already exceeds this on Kuma history, Loki, PBS and Proxmox. It does **not** yet match the comparables on **Grafana alert counts** or the **ntfy stream**, which are the two cheapest gaps. None of the comparables manage Kuma monitors or Grafana alert rules, so "write/management" would go beyond what the market offers; that is a differentiator but also unprecedented effort.

---

## 4. Gap analysis: what a user still has to leave homedash for

Effort scale: S (about a day or less), M (several days), L (a week or more). Value is judged against "never open the tool for routine tasks".

### Grafana
| Task the user still does in Grafana | Why it matters | Candidate | Effort | Value |
|---|---|---|---|---|
| See which alerts are firing, and silence one | Grafana alerts are invisible in homedash; they never reach homedash's notification history or Overview | Poll `/api/prometheus/grafana/api/v1/rules` (state, labels, annotations) and show firing rules on Overview and in the incident timeline; optional silence via Alertmanager `silences` endpoint | S-M | High |
| See what happened when a graph changes | Annotations are how Grafana shows events on graphs | Write homedash events (guest stop, node offline, backup failure, maintenance window) as annotations (`POST /api/annotations`, tag `homedash`) so every dashboard shows them | S | Medium-high; unique to the "one pane" aim |
| Create/edit alert rules and contact points | Deep Grafana management | Provisioning API CRUD | L, and the API is flagged deprecated | Low (rules are usually set once; the owner already drives Grafana config from YAML) |

### Loki
| Task | Candidate | Effort | Value |
|---|---|---|---|
| Watch logs live while restarting something | Live tail through the WebSocket `/loki/api/v1/tail`, proxied by the server (delay_for, limit) | M (needs a streaming route and UI) | Medium; a routine debugging task |
| Know whether a log-based alert is firing | Read ruler `/prometheus/api/v1/alerts` (only if the user has a Loki ruler) | S | Low-medium, depends on the user running a ruler **[U]** |
| Jump from an alert/incident to the logs of that time and host | Deep link into the existing Logs page with a pre-filled LogQL and window | S | High (glue, not new API) |
| Spot cardinality/volume problems | `/index/volume` | S | Low |

### Uptime Kuma
| Task | Candidate | Effort | Value |
|---|---|---|---|
| Add, pause or edit a monitor; add a maintenance window | Only the Socket.IO interface is available in stable, and it is internal, so a dependency on it is fragile. Alternative: **native checks in homedash** (HTTP, TCP, certificate expiry, push heartbeat), building on the existing tile pollers, so Kuma becomes optional rather than driven | M-L | High for the aim, but see risk |
| Know a monitor's certificate expiry and real uptime ratios | Read `monitor_cert_days_remaining` and `monitor_uptime_ratio{window}` where present; or the status-page heartbeat JSON for Kuma's own heartbeats rather than homedash's sampling | S | Medium; version caveat **[U]** |
| Prove homedash itself is alive to an external checker | Call Kuma's push endpoint from homedash on a timer (dead-man's switch) | S | Medium |
| Kuma's incident message text | `/metrics` carries none; the status-page JSON includes incidents and heartbeats | S | Low-medium |

### ntfy
| Task | Candidate | Effort | Value |
|---|---|---|---|
| Read what arrived in ntfy (from other systems too) | In-app inbox: server subscribes (`/json` stream or `poll=1&since=<last id>`) and shows messages in web and mobile | S-M | High for mobile |
| Act on an alert from the notification | ntfy `view` action deep-linking into the incident page; `http` actions are possible but would carry a credential in the notification | S for `view` | Medium |
| Manage topics, users, tokens | `ntfy` CLI/server config, no documented REST account API in the config page I read **[U]** | n/a | Low |
| Background push for homedash's own mobile app | Not supported by sources for an unmodified self-hosted ntfy (see 2.4) | L, unclear | Unproven |

### Proxmox
| Task | Candidate | Effort | Value |
|---|---|---|---|
| See backup jobs, schedule, last result, next run | Add `GET /cluster/backup` plus the latest vzdump task per job to Protection; alert when a job's last run failed or is overdue | S-M | Medium; Protection already answers "is each guest covered" |
| Receive PVE events as they happen | One authenticated inbound webhook, add a PVE webhook target through `/cluster/notifications` (needs `Mapping.Modify`; read-only token cannot) | M | Medium-low |

---

## 5. The previously floated candidates, against the evidence

| Candidate | Verdict | Reasoning |
|---|---|---|
| Backup health | **Mostly exists.** Supported only as an increment. | Protection, Health check, Capacity, PBS tile and failed-task alerts are in the code. What is missing is the job schedule/last-result view (`/cluster/backup` is read-only safe and documented in the API schema). Do not rebuild it. |
| Mobile push | **Partly supported.** | The ntfy app is already the push path (README, REPORT). Sources show self-hosted ntfy cannot deliver Firebase push to a custom app without a custom build; an in-app ntfy inbox is cheap and verified. True native push is unproven. |
| Incident timeline | **Supported, and the strongest fit for the aim.** | The ingredients are already persisted separately: `system_events` (monitor transitions, guest status, host, auth) and `kuma_samples`; the notification history is in memory and lost on restart. Grafana alert state (S) and annotations (S) are the missing inputs. |
| Alert-to-action runbooks | **Supported in a limited form.** | The actions already exist (guest actions, scenes, approvals). ntfy `view`/`http` actions and the `click` field are documented. The risk is a credential inside an `http` action; use deep links and the existing approvals instead. Scheduled actions are out of scope here. |
| Cost/energy view | **Not supported by evidence.** | I found no primary-source evidence that Proxmox exposes power data, and no sign of demand from comparables. The only energy input in the repo is the NUT tile (UPS load). **[I]** A rough estimate from UPS load times a tariff is possible but is a guess at a need, not a documented gap. Defer. |

---

## 6. Ranked recommendations (value / effort)

1. **Grafana alert state in homedash (S-M, high).** Read `/api/prometheus/grafana/api/v1/rules`, show firing rules on Overview, feed them into the existing alert pipeline (so routes, maintenance windows and every channel apply), optionally silence. This removes the single biggest reason to open Grafana, and it is table stakes (Homepage ships alert counts).
2. **One persisted incident timeline (M, high).** Merge `system_events`, Kuma transitions, Grafana alerts, failed PVE tasks, and delivered notifications into one persisted, filterable, time-ordered view, each row linking to the Logs page at that time. Persist the notification history, which is currently capped at 100 in memory. Pair with writing homedash events to Grafana as annotations (S) so graphs show them too.
3. **ntfy inbox on web and mobile (S-M, high for mobile).** Subscribe to the configured topic (documented stream or poll), show messages in the app, add a `view` action with a deep link to alerts sent by homedash. Gives the mobile app something native without Firebase.
4. **Native uptime checks that make Kuma optional, plus Kuma richness (M-L).** The sources show Kuma cannot be managed through a stable, documented API, so building management on Socket.IO would be fragile. Do the cheap parts first (read cert days, uptime ratio windows and status-page heartbeat JSON; push heartbeat to Kuma) and decide separately whether to build homedash's own HTTP/TCP/cert checks. Verify the `/metrics` fields against the Kuma version actually in use first.
5. **Loki live tail and alert-to-logs jump (M).** WebSocket tail through the server, and a "show logs around this alert" deep link. The deep link is S and carries most of the value.

Smaller follow-ups: backup job and last-result view on Protection (S-M); inbound PVE webhook (M, low-medium); defer cost/energy.

---

## 7. Things I could not verify (read before acting)

- Grafana: RBAC actions required for `/api/prometheus/grafana/api/v1/rules` and the Alertmanager routes, and their stability across Grafana 13's `/api` to `/apis` migration. The routes come from Grafana's source and Homepage's use, not from a docs page.
- Kuma: whether `monitor_id`, `monitor_uptime_ratio` and `monitor_cert_*` exist in the version you run (master source is 3.0.0-beta.3); whether the master OpenAPI router (`/api/monitors`) is in any stable release or can write; any first-party stability statement for Socket.IO.
- ntfy: the Limitations (rate limit, message size) section of the publish page was past the part I could read; ntfy account/token REST API not found in the config page.
- Expo push requirements, PVE webhook payload shape, and any PVE power metrics were not researched.
- Homarr's Grafana/Loki/PBS support and Dashy's widget details: pages were truncated or incomplete in the fetch; absence in my notes is not proof of absence.
- Nothing here was tested against a live Grafana, Loki, Kuma, ntfy or Proxmox instance.
