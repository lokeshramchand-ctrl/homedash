# Monitoring: connect any tool

homedash shows problems from every monitoring tool you connect in one list (Overview and the **Alerts & sources** page), and sends them through the same alert channels, routes, silences and maintenance windows as everything else. A tool can be **read** by homedash, or can **tell** homedash.

Connect sources in the browser: **Alerts & sources → Connect a source** (administrators), or the **Connect** button on the Setup page. Nothing needs a restart. Saving a source needs a secret key on the server (`SECRETS_KEY`; `homedash-config apply` creates one).

If a source is set in `homedash.yaml` or the environment, that wins: it shows as "In config" and a UI source of the same kind is ignored.

## What each kind reads

| Kind | What homedash reads | What you give it |
|---|---|---|
| Uptime Kuma | Monitor status and response time from `/metrics` | Address and an API key (Kuma: Settings, API Keys) |
| Grafana | Alert rules that are firing or pending | Address and a **read-only** service account token. The exact permission needed is not documented; use the Test button |
| Prometheus | Alert rules and their active alerts, `GET /api/v1/rules?type=alert` | Address. Prometheus itself documents only basic authentication, so give a user name and password if you set one. A bearer token is for servers behind a reverse proxy |
| Alertmanager | Active alerts that are not silenced or inhibited, `GET /api/v2/alerts` | Address, same credentials note |
| Any JSON endpoint | A list in a JSON answer, turned into up/down checks | Address, where the list is, which fields hold the name and the status |
| Webhook | Whatever a tool sends | Nothing: homedash gives you an address and a secret |

Things that are **not verified**: Grafana Mimir and vmalert document the same Prometheus endpoints, but their answers were not tested here; Thanos Ruler's documentation does not mention them, so treat it as untested. Alert states other than `firing` and `pending` are ignored. Servers with a self-signed HTTPS certificate are not supported yet; use http or a trusted certificate.

### Any JSON endpoint

Say where the list is and which fields (inside each item) hold the name and the status. Paths use dots and `[n]` indexes, and `$` means "the whole answer":

```
Path to the list:   data.monitors
Name:               name
Status:             state
Status values:      ok=up, fail=down, warn=pending
```

Without a status map, common words are understood (`ok`, `up`, `online`, `healthy` are up; `down`, `error`, `failed`, `offline` are down; `warn`, `degraded` are pending). Anything else counts as unknown. The Test button refuses an empty list, which usually means a wrong path.

## Webhooks: any tool that can send a web request

Create a **Webhook** source. homedash shows an address and a secret **once**; if you lose the secret, use **New secret** (the old one stops working immediately).

Send the secret as a header:

```
Authorization: Bearer <secret>
```

Some tools cannot set a header. For those you can use `?token=<secret>` on the address instead. Web addresses end up in the logs of reverse proxies and of the sending tool, so prefer the header. homedash hides the token in its own log.

Three shapes are understood. The shape is detected from the content.

**Plain**, for scripts and cron jobs:

```bash
curl -X POST 'http://homedash.lan:3000/hooks/monitoring/src-xxxxxxxx' \
  -H 'Authorization: Bearer <secret>' -H 'Content-Type: application/json' \
  -d '{"name": "nightly-backup", "status": "down", "message": "exit code 2"}'
```

`status` is `up`, `down` or `pending` (also `ok`, `error`, `warning` and similar). It is a check by default. Add `"level": "critical"` (or `"kind": "alert"`) to make it an alert; an alert is cleared by sending the same name with `up` or `resolved`. A list of items is accepted too.

**Alertmanager** (`alertmanager.yml`):

```yaml
receivers:
  - name: homedash
    webhook_configs:
      - url: 'http://homedash.lan:3000/hooks/monitoring/src-xxxxxxxx'
        send_resolved: true
        http_config:
          authorization:
            credentials: '<secret>'
```

Each alert is read on its own status (`firing` or `resolved`), not the group's. Set `max_alerts` if a group can be large: homedash accepts requests up to 64 KB.

**Grafana**: add a Webhook contact point with the same address and an Authorization header (scheme `Bearer`, the secret as the credentials). Alerts are read from its `alerts` list; a body with only `state` and `title` works too.

Pushed items that nobody refreshes are forgotten after the source's time limit (default 7 days), so a tool that stops sending cannot leave a problem open forever. A checked item that is sent as `up` stays listed as up.

The webhook is the only part of homedash outside the login. It records state and nothing else: it never runs anything and never forwards what it receives. Wrong or missing secrets all get the same `401` answer, repeated failures from one address are rate limited, and each source is limited to 120 requests a minute. To keep it off the internet, restrict `/hooks/` to your LAN in the reverse proxy.

## What happens to problems

- A firing alert, or a down check from a source that raises its checks, becomes one alert through your channels (ntfy, Discord and the rest), once, and one recovery when it clears. Uptime Kuma keeps its own alert path, so a Kuma outage still sends exactly one alert.
- If a source stops answering, homedash keeps showing its last known problems, marks the source unreachable, and after two failed reads in a row sends one "unreachable" alert. A failed read is never treated as "everything recovered".
- Raise and recover lines are written to the event log (Logs, Events, source "monitor"), and so is each alert delivery.

## Permissions

Everyone signed in can read the list. Only administrators can connect, edit, test or remove sources, or issue a new webhook secret. Secrets are stored sealed, are never shown again, and are never written to the log or the audit trail.

## Connect anything

If a tool is not in the list, it can still be connected. Pick the line that matches what it has:

| The tool has | Use | What homedash does |
|---|---|---|
| A page or API that answers with JSON | **Custom HTTP source**, read as a list of checks or of alerts | Reads it on an interval |
| A `/metrics` page (Prometheus format) | **Custom HTTP source**, read as a Prometheus page | Turns series into up, warning and down |
| A website, a port or a certificate and nothing else | **Service checks** | Looks at the address itself |
| The ability to send a web request when something happens | **Webhook**, with a custom mapping for unusual JSON | Listens |

### Ready-made tools

These fill in the custom HTTP source for you; you give an address and a key. Each was checked against the tool's own documentation (`docs/research/monitoring-templates-formats.md`), and the form says which documentation. None was run against a live installation.

| Tool | What it shows | Notes |
|---|---|---|
| Healthchecks.io | Checks: up, late (warning), down; paused ones are ignored | A read-only API key is enough |
| Zabbix | Open problems with severity and start time | Zabbix 6.4 or newer (API token in a header) |
| Uptime Robot | Monitors: up, seems down (warning), down | API v2 only; v3 is not covered |
| Netdata | Raised alarms | Uses the classic alarms endpoint, which Netdata marks deprecated |
| Checkmk | Services that are not OK | Checkmk 2.3.0p31, 2.4 and 2.5; the endpoint is removed in 3.0 |
| OPNsense | Gateways: online, delayed or lossy, offline | Needs a user with only the gateway status privilege and an API key; field names follow the API reference and are not confirmed on a live firewall |
| Grafana Loki (alerting rules) | Firing alerts from the Loki ruler | Only when Loki runs its ruler; optional tenant header |
| Grafana Loki (is it up) | `/ready` answers ready | No key |
| authentik, Keycloak, Authelia (is it up) | Health endpoint answers | Keycloak: the management port. Use the Identity page to read the OIDC configuration |

### Custom HTTP source

You describe one request and how to read the answer.

- **Request:** address, GET or POST, and one way to sign in: nothing, a bearer token, user name and password, a key in a header, or a key in the address. A POST can have a body. In the address, headers and body, `{{secret}}` is replaced by the saved key; nothing else is substituted and nothing is evaluated. Header names are limited to letters, digits and dashes, line breaks are refused, and `Host`, `Content-Length`, `Cookie` and similar framing headers cannot be set. Redirects are not followed.
- **Self-signed HTTPS:** under Advanced, "Accept a self-signed certificate" applies to that source only.
- **A JSON list as checks:** where the list is (`data.items`, or `$`), which fields hold the name and the status, and what the status words mean (`ok=up, fail=down, warn=pending`; common words are understood). The list may also be an object keyed by name; its values are the items.
- **A JSON list as alerts:** each item is a problem. Give the name, and optionally a message, a severity with a map (`5=error, 3=warn`), a start time (seconds, milliseconds or an ISO date), a unique id, and "problem when status is" if the list also contains healthy items.
- **A Prometheus page:** the metric name, an optional label filter (`job=node`), which label names each check, and two comparisons: "up when" (default `== 1`) and "warning when" (checked if "up" does not hold). For a disk: up when `< 80`, warning when `< 95`, down otherwise.
- **Just answers:** up if the status code is good (default 200 to 399) and, optionally, the page contains some text. An unreachable server is a down check, not an error.

The Test button says what was read (`Read 2 items: nas:9100 is up, pi:9100 is down`) or why not, so a wrong path or metric name shows before anything is saved.

### Recipes for tools without a template

Fill these into the custom HTTP source and use Test. The field names come from each tool's documentation, but none of these was checked against a running installation.

- **Gatus:** `GET <address>/api/v1/endpoints/statuses?pageSize=1`, read as checks. List `$`, name `key`, status `results[0].success`, values `true=up, false=down`. The Gatus documentation does not say whether the newest result comes first; if Test shows stale states, this recipe does not fit your version.
- **Glances (API 4):** `GET <address>/api/4/alert`, read as alerts. List `$`, name `desc`, severity `state` with `critical=error, warning=warn`, start time `begin`, status `end` with "problem when" `-1` (an alert that has not ended). The documentation shows only an empty sample.
- **Any exporter with a `/metrics` page:** read as a Prometheus page, metric `up` (or the one you care about).
- **Beszel:** it needs a login token that expires, which a single saved request cannot refresh. Not covered yet.

### Webhook with a custom mapping

If a tool sends JSON that is not Alertmanager, Grafana or the plain shape, open **Advanced** when creating the webhook and describe it: the path to the list (or `$` for the body itself), the name, the status and what its words mean, and whether each item is a check or a problem. A payload that does not fit the mapping gets a plain `400` explaining what could not be read.

### Service checks

One line per check, `name | type | address`:

```
NAS         | tcp  | 192.168.1.5:445
Wiki        | http | http://wiki.lan
Certificate | tls  | wiki.lan
```

`http` is up for any status below 400; `tcp` is up when the port accepts a connection; `tls` reads the certificate and warns 14 days before it expires (an untrusted or self-signed certificate is still read; expiry is the question). Cloud-metadata and link-local addresses are refused; ordinary LAN addresses are the point and are allowed. Up to 50 lines per source.
