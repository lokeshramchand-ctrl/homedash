# Monitoring provider formats: primary-source verification

Date: 2026-11-26. Purpose: Phase 2 of the monitoring module (spec section 4.2 and 4.5). Every claim below carries the page that owns it. The source files fetched from GitHub `main` describe the current development head, so a released version may differ; where that matters it is flagged.

Method note: pages were read through a fetch tool that summarises pages, so JSON examples are rebuilt from the field names and sample values the pages give. They are labelled "adapted" and are not byte-for-byte copies.

---

## 1. Prometheus HTTP API

### Verified

Source for everything in this subsection unless noted: https://prometheus.io/docs/prometheus/latest/querying/api/

`GET /api/v1/alerts`
- Takes no documented parameters.
- Response is `{"status":"success","data":{"alerts":[ ... ]}}`.
- Each alert has `activeAt` (RFC3339 string), `annotations` (object), `labels` (object), `state` (the doc example shows `firing`), `value` (a string, example `1e+00`).
- The page warns that `/alerts` is fairly new and lacks the stability guarantees of API v1.

`GET /api/v1/rules`
- Query parameters: `type` (`alert` or `record`; omitted or empty means no filter), `rule_name[]`, `rule_group[]`, `file[]`, `exclude_alerts` (bool), `match[]`, `group_limit`, `group_next_token` (needs `group_limit`).
- The request filter values (`alert`, `record`) differ from the response `type` values (`alerting`, `recording`).
- Response is `data.groups[]`. Each group has `name`, `file`, `interval`, `limit`, `rules[]`.
- An alerting rule has `type: "alerting"`, `name`, `query`, `duration`, `labels`, `annotations`, `health`, and `alerts[]` (the same objects as `/api/v1/alerts`).
- A recording rule has `type: "recording"`, `name`, `query`, `health`.
- When `group_limit` truncates the result, the response includes `groupNextToken`.
- The same stability warning applies to `/rules`.

Authentication Prometheus offers for its own server (source: https://prometheus.io/docs/prometheus/latest/configuration/https/)
- Loaded with `--web.config.file`.
- `basic_auth_users` (username to bcrypt hash).
- TLS client certificates through `tls_server_config` (`client_auth_type`, `client_ca_file`, `client_allowed_sans`).
- The page documents no bearer-token option for the server. Bearer tokens only appear in the common deployment of a reverse proxy, which is outside Prometheus docs.

Compatible servers (only what their own docs say)
- Grafana Mimir: the ruler endpoint `GET <prometheus-http-prefix>/api/v1/rules` is described as a "Prometheus-compatible rules endpoint to list alerting and recording rules"; it supports `type`, `file`, `rule_group`, `rule_name`, `exclude_alerts`, `group_limit`, `group_next_token`. `GET <prefix>/api/v1/alerts` is described as a Prometheus-compatible endpoint listing all active alerts. Default prefix is `/prometheus`. Endpoints need the `X-Scope-OrgID` header unless multi-tenancy is disabled (`-auth.multitenancy-enabled`). Source: https://grafana.com/docs/mimir/latest/references/http-api/
- VictoriaMetrics vmalert: documents `/api/v1/rules` ("returns a list of all loaded groups and rules"; supports `datasource_type`, `search`, `group_limit`, `page_num`, plus "additional filtering" linked to the Prometheus docs) and `/api/v1/alerts` ("returns a list of all active alerts"; supports `datasource_type`, `rule_group[]`, `file[]`, `match[]`). The docs do not use the word compatible for these endpoints; the "aims to be compatible" wording is about rule syntax. vmalert has no documented `type` filter; it uses `datasource_type`. Source: https://docs.victoriametrics.com/victoriametrics/vmalert/
- vmalert's own server auth: `-httpAuth.username` and `-httpAuth.password` (Basic Auth, disabled when username is empty). No inbound bearer-token option is documented; bearer-token flags there are for outbound connections. Same URL as above.
- Thanos Ruler: its docs page does not mention `/api/v1/rules` or `/api/v1/alerts`. Source checked: https://thanos.io/tip/components/rule.md/

### Adapted example: `GET /api/v1/rules` (field names and sample values from the Prometheus page)

```json
{
  "status": "success",
  "data": {
    "groups": [
      {
        "name": "example",
        "file": "/rules.yaml",
        "interval": 60,
        "rules": [
          {
            "type": "alerting",
            "name": "my-alert",
            "query": "up == 0",
            "duration": 600,
            "labels": {"severity": "page"},
            "annotations": {"summary": "instance down"},
            "health": "ok",
            "alerts": [
              {
                "labels": {"alertname": "my-alert"},
                "annotations": {},
                "state": "firing",
                "activeAt": "2018-07-04T20:27:12.60602144+02:00",
                "value": "1e+00"
              }
            ]
          }
        ]
      }
    ]
  }
}
```

---

## 2. Alertmanager

### Verified: `GET /api/v2/alerts`

Source: https://raw.githubusercontent.com/prometheus/alertmanager/main/api/v2/openapi.yaml

Query parameters (all optional):
- `active` (bool, default true), `silenced` (bool, default true), `inhibited` (bool, default true), `unprocessed` (bool, default true).
- `filter` (repeatable matcher string such as `alertname="MyAlert"`).
- `receiver` (regex string).
- `receiver_matchers` (repeatable matcher string).

Response is an array of `gettableAlert`:
- Required: `receivers` (array of `{name}`), `fingerprint`, `startsAt`, `updatedAt`, `endsAt` (date-time), `annotations`, `status`, `labels`.
- Optional: `generatorURL`.
- `status` is `{state, silencedBy[], inhibitedBy[], mutedBy[]}`, where `state` is one of `unprocessed`, `active`, `suppressed`.
- `labels` and `annotations` are string-to-string maps.
- Errors: 400 and 500 return a plain string.

### Verified: webhook body Alertmanager POSTs

Sources: https://prometheus.io/docs/alerting/latest/configuration/ (section `webhook_config`), https://raw.githubusercontent.com/prometheus/alertmanager/main/notify/webhook/webhook.go, https://raw.githubusercontent.com/prometheus/alertmanager/main/template/template.go

- Top-level keys: `version` (the string `"4"`), `groupKey`, `truncatedAlerts` (count dropped by `max_alerts`), `status` (`resolved` or `firing`), `receiver`, `groupLabels`, `commonLabels`, `commonAnnotations`, `externalURL`.
- Each `alerts[]` item: `status`, `labels`, `annotations`, `startsAt` (RFC3339), `endsAt`, `generatorURL`, `fingerprint`.
- The configuration docs page also lists `notification_reason`. The template source on `main` additionally has `routeLabels` in the struct and JSON tags (`json:"routeLabels"`, `json:"notification_reason"`). These two are newer than the long-standing v4 shape. Treat them as optional and ignore them.
- The webhook source sets `Version` to `"4"` and embeds the template `Data`, so its fields appear at the top level. It sends the body with `notify.PostJSON`; the fetch tool could not show that function, so "POST with a JSON body" is documented by the config page ("HTTP POST requests") but the content type is not confirmed from the code I read.
- A custom body can replace this when the receiver sets `payload`; the default is the shape above.
- Webhook receiver settings: `url` or `url_file` (mutually exclusive), `send_resolved` (default true), `max_alerts` (default 0 = all), `timeout`.
- `status` of the group can be `firing` while some `alerts[]` items are `resolved`. This is a consequence of grouping; code should read each item's own `status`. (The docs define a per-alert `status` field with `<resolved|firing>`.)

### Verified: sending a bearer token or header

Source: https://prometheus.io/docs/alerting/latest/configuration/ (section `http_config`)
- `authorization`: `type` (default `Bearer`), `credentials` or `credentials_file` (mutually exclusive). This produces `Authorization: Bearer <token>`.
- `basic_auth`: `username`, `password` or `password_file`. Mutually exclusive with `authorization`.
- `http_headers`: custom headers, each with `values`, `secrets`, or `files`. Headers Prometheus sets itself cannot be overwritten.

### Query-string token

Not documented as a feature. The page only says `url` is where POSTs go. The webhook source passes `url` (after templating) straight to the HTTP client and adds no parameters, so a query string embedded in the configured URL would be sent as written. That is an inference from the source, not a documented guarantee. Also, `url` is typed `<secret>` in the config docs, which suggests Alertmanager hides it in its config output.

### Adapted example: Alertmanager webhook v4 (field names from the docs; values illustrative)

```json
{
  "version": "4",
  "groupKey": "{}:{alertname=\"HighMemory\"}",
  "truncatedAlerts": 0,
  "status": "firing",
  "receiver": "homedash",
  "groupLabels": {"alertname": "HighMemory"},
  "commonLabels": {"alertname": "HighMemory", "severity": "warning"},
  "commonAnnotations": {"summary": "memory high"},
  "externalURL": "http://alertmanager.example:9093",
  "alerts": [
    {
      "status": "firing",
      "labels": {"alertname": "HighMemory", "instance": "host1"},
      "annotations": {"summary": "memory high"},
      "startsAt": "2026-11-26T09:51:03.157Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "generatorURL": "http://prometheus.example:9090/graph?g0.expr=...",
      "fingerprint": "c6eadffa33fcdf37"
    }
  ]
}
```

---

## 3. Grafana webhook contact point

### Verified

Sources: https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/ and https://raw.githubusercontent.com/grafana/alerting/main/receivers/webhook/v1/webhook.go

Payload
- It contains the Alertmanager-style keys: `receiver`, `status` (`firing` or `resolved`), `alerts`, `groupLabels`, `commonLabels`, `commonAnnotations`, `externalURL`, `groupKey`, `truncatedAlerts`.
- Differences and extras at the top level: `version` is the string `"1"` (source: `Version` set to `"1"`), not `"4"`. Extra keys: `orgId`, `title`, `message`, `state` (`alerting` when firing, otherwise `ok`).
- Each `alerts[]` item has `status`, `labels`, `annotations`, `startsAt`, `endsAt`, `generatorURL`, `fingerprint`, plus extra `silenceURL`, `dashboardURL`, `panelURL`, `values` (numeric results), and `imageURL` (listed in the reference table, absent from the docs example).
- The Grafana page does not say its payload is based on Alertmanager's. "Compatible" here means the shared key names above, which I verified by comparing both pages. Alertmanager is not named as the origin.
- Custom payload templates can replace the default body (the doc says Title and Message are then ignored).

Authentication options on the contact point
- Basic auth username and password (cannot be combined with the Authorization header).
- Authorization header: scheme (default `Bearer`) and credentials. The source builds `Authorization: <scheme> <credentials>` only when both are set.
- Extra headers (can override `Content-Type`).
- HMAC-SHA256 signature header (default name `X-Grafana-Alerting-Signature`) with optional timestamp header.
- OAuth2 client credentials (takes precedence over basic auth and Authorization header).
- TLS CA/client certificates.
- HTTP method is `POST` or `PUT`.
- The URL is stored and shown in plain text, so the docs advise against putting secrets in it. A query-string token in the URL therefore works mechanically but the docs discourage it; prefer the Authorization header.

### Adapted example: Grafana webhook (values from the docs example, shortened)

```json
{
  "receiver": "My Super Webhook",
  "status": "firing",
  "orgId": 1,
  "alerts": [
    {
      "status": "firing",
      "labels": {"alertname": "High memory usage", "team": "blue", "zone": "us-1"},
      "annotations": {"description": "The system has high memory usage", "summary": "This alert was triggered for zone us-1"},
      "startsAt": "2021-10-12T09:51:03.157076+02:00",
      "endsAt": "0001-01-01T00:00:00Z",
      "generatorURL": "https://play.grafana.org/alerting/1afz29v7z/edit",
      "fingerprint": "c6eadffa33fcdf37",
      "silenceURL": "https://play.grafana.org/alerting/silence/new?alertmanager=grafana",
      "dashboardURL": "",
      "panelURL": "",
      "values": {"B": 44.23943737541908, "C": 1}
    }
  ],
  "groupLabels": {},
  "commonLabels": {"alertname": "High memory usage"},
  "commonAnnotations": {},
  "externalURL": "https://play.grafana.org/",
  "version": "1",
  "groupKey": "{}:{}",
  "truncatedAlerts": 0,
  "title": "[FIRING:1] High memory usage",
  "state": "alerting",
  "message": "**Firing** ..."
}
```

---

## 4. Push (heartbeat) monitors

### Healthchecks.io (source: https://healthchecks.io/docs/http_api/)
Pings go to `https://hc-ping.com/<uuid>` or, with project ping keys, `https://hc-ping.com/<ping-key>/<slug>`. Suffixes: none (success), `/start`, `/fail`, `/log`, `/<exit-status>` (0 success, 1 to 255 failure). Methods HEAD, GET and POST are accepted. Optional query parameters: `rid=<uuid>` (matches a start with its completion) and `create=1` (slug form only, auto-creates the check). The UUID acts as the secret, so the secret sits in the URL path.

### Uptime Kuma push monitor (source: server/routers/api-router.js, https://raw.githubusercontent.com/louislam/uptime-kuma/master/server/routers/api-router.js)
The route is `router.all("/api/push/:pushToken", ...)`, so any HTTP method works. Query parameters: `status` (default `up`; any value other than `up` counts as down, and only an explicit `down` skips retries), `msg` (default `OK`), `ping` (milliseconds, float, optional). Success returns `{ok: true}`; unknown or inactive token returns HTTP 404 `{ok:false, msg}`. Example: `/api/push/<token>?status=up&msg=OK&ping=`. I could not load the Kuma wiki page that describes the push monitor, so the example string is composed from the code, not copied from docs.

---

## 5. Not verified from a primary source

- Prometheus alert `state` values other than `firing` (`pending`, `inactive`) and rule `health` values (`ok`, `err`, `unknown`): the API page example only shows `firing` and `ok`. Treat the full enumerations as unverified; handle unknown strings defensively. Also `lastError`, `evaluationTime`, `keepFiringFor` were not on the fetched page.
- Whether `value` is always a string: only the example (`"1e+00"`) shows it.
- Mimir response body shape: docs say "Prometheus-compatible" but the page was not shown to define the JSON fields; assume the Prometheus shape only with a defensive parser.
- VictoriaMetrics: the response shape of `/api/v1/alerts` and `/api/v1/rules` is not shown to match Prometheus beyond the filter names; the docs do not claim compatibility for these endpoints. vmselect (as opposed to vmalert) was not checked at all.
- Thanos Ruler: no documentation of `/api/v1/rules` or `/api/v1/alerts` found on its component page. Do not claim compatibility. The Thanos Query API pages were not checked.
- Thanos Ruler inbound auth (`--http.config`) is described as experimental and the details guide was not read.
- Alertmanager's own inbound auth (its web config) was not fetched; I did not verify whether `GET /api/v2/alerts` can be protected with basic auth through `--web.config.file`.
- Alertmanager `notification_reason` and `routeLabels` presence in released versions (only seen in docs "latest" and `main`).
- Alertmanager `PostJSON` content type and method from source (documented only as "HTTP POST").
- A documented, supported query-string token for Alertmanager webhooks (none found; see section 2).
- Grafana `version` value `"1"` was read from `main`; older Grafana releases may differ. Grafana's legacy alerting webhook (pre-unified alerting) payload was not checked.
- The Uptime Kuma wiki push page and the Healthchecks.io page for `hc-ping.com` on self-hosted instances (host differs per install).
- Full Grafana docs example JSON text was paraphrased by the fetch tool; the adapted example above is rebuilt from fields and sample values, so check exact value formatting before using it as a test fixture.
