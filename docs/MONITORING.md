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
