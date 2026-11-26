# Monitoring templates: primary-source verification of ten tool formats

Date: 2026-11-26. Purpose: the generic "custom HTTP source" and its ready-made templates. This note does not repeat `monitoring-provider-formats.md` (Prometheus, Alertmanager, Grafana webhook, Healthchecks/Kuma push URLs).

Method and honesty rules
- Sources are official docs, official repos (raw files at the tag or branch named) and official OpenAPI/swagger files. No forum posts or blogs are used as evidence.
- Some doc pages were read through a fetch tool that summarises pages. Where a claim rests on such a summary, the page is named and the claim is limited to what the summary stated. Where I could read the raw source file myself (swagger, Markdown, Go, Python), I say "raw source".
- Every example JSON is labelled "adapted from the docs": field names and sample values come from the cited page, but formatting is rebuilt, not copied byte for byte.
- "Unverified" means no primary source found or readable. Nothing in the unverified lists should be coded as fact.

Summary of status (details per tool below)

| Tool | Status |
|---|---|
| 1. Zabbix | Partial. Auth, `problem.get`, host/interface availability fields verified. Exact version where Bearer became available is not pinned. |
| 2. Netdata | Partial. Endpoints, params, status values, bearer scheme verified from the official swagger. The v3 alerts response body fields are not defined there. Cloud API token not verified. |
| 3. Checkmk | Partial. Auth header, request shape, state values verified from official source. Big version caveat: the GET form is gone from 2.5 and the endpoint is removed in 3.0 (unreleased). |
| 4. Healthchecks.io | Fully verified (raw API doc source). |
| 5. Gatus | Verified (README and Go source). Result ordering and duration unit are inferences. |
| 6. Uptime Robot | v2 verified (legacy docs). v3 could not be verified. |
| 7. Beszel | Partial. PocketBase auth and list verified; `systems.status` values verified from Beszel source; Beszel docs do not describe the schema. |
| 8. Glances | Verified for the released API 4. Event objects only documented by field list, not by a non-empty sample. |
| 9. Prometheus text format | Fully verified (raw source of the official page). |
| 10. Auth forms | Summarised from the above. |

---

## 1. Zabbix (JSON-RPC)

### Verified: request and authentication

Source: https://www.zabbix.com/documentation/current/en/manual/api (the "current" docs are Zabbix 8.0, see host object page below)
- Send HTTP POST to `api_jsonrpc.php` in the frontend directory, for example `https://example.com/zabbix/api_jsonrpc.php`.
- `Content-Type` is one of `application/json-rpc`, `application/json`, `application/jsonrequest`.
- Body is JSON-RPC 2.0 with `jsonrpc`, `method`, `params`, `id`.
- Credentials: an API token (frontend Users > API tokens, or the Token API), or `user.login` with username and password, whose `result` is a token string.
- Current docs send the token as `Authorization: Bearer <token>`. The page says header names are case-insensitive and the header works in CORS requests. The summary of this page did not mention an `auth` body property.

Version evidence for the auth style (each from the page of that version, read through the fetch summariser)
- 6.0: https://www.zabbix.com/documentation/6.0/en/manual/api. Token goes in an `auth` property in the JSON body (`"auth": "<token>"`); the summary reported no Authorization header. It also reported that 6.0 mentions API tokens "created in Zabbix frontend or using the Token API" but gave no introduction version.
- 6.4: https://www.zabbix.com/documentation/6.4/en/manual/api. Both work: the `Authorization: Bearer <token>` header is the documented way, and the `auth` body property is accepted but "deprecated. It will be removed in the future releases."
- 7.0: https://www.zabbix.com/documentation/7.0/en/manual/api. Same two options, with the same deprecation note and no removal version. The page also says the header works in CORS requests since 7.0.7 and that header names are case-insensitive since 7.0.11.
- 7.2: https://www.zabbix.com/documentation/7.2/en/manual/api. The request object lists only `jsonrpc`, `method`, `params`, `id`; the `auth` property is not documented; token goes in the Authorization header.
- A cookie `zbx_session` is used only for JavaScript inside the Zabbix UI (current page above).
- Consequence for a template: `Authorization: Bearer <token>` is documented for 6.4, 7.0, 7.2 and the current 8.0 docs. For 6.0 the documented style is the `auth` body property. I did not read 5.x or 6.2 pages, so the exact release that introduced the header is unverified.

`user.login` (only needed if no API token). Source: https://www.zabbix.com/documentation/current/en/manual/api/reference/user/login
- Params `username` (required), `password` (required), optional `userData` flag. Without `userData` the result is the token string. The page mentions no rename from `user` to `username`; older versions may use `user` (unverified).

Token requirements. Source: https://www.zabbix.com/documentation/7.0/en/manual/web_interface/frontend_sections/users/api_tokens
- A token belongs to exactly one user and may have an expiry date and an enabled flag. "Requests authenticated with an API token are authorized according to the associated user's role and permissions."
- Users without Administration access can manage tokens only if "Manage API tokens" is allowed in their role.

Permissions of the method. Source: https://www.zabbix.com/documentation/7.0/en/manual/api/reference/problem/get
- "This method is available to users of any type. Permissions to call the method can be revoked in user role settings." The page does not state a host-level read-access rule for results (unverified, assume results are limited to what the token's user can see).

### Verified: `problem.get`

Sources: https://www.zabbix.com/documentation/current/en/manual/api/reference/problem/get and https://www.zabbix.com/documentation/current/en/manual/api/reference/problem/object
- Description: "This method is for retrieving unresolved problems" (7.0 page). Parameter `recent` (bool): true also returns problems resolved within `ok_period`, false returns only unresolved. The default of `recent` is not stated.
- Useful parameters: `severities` (int or array), `acknowledged` (bool, true = only acknowledged), `suppressed` (bool), `symptom`, `hostids`, `groupids`, `tags` with `evaltype`, `time_from`/`time_till`, `limit`, `sortfield` (only `eventid`), `sortorder`, `output` (use `extend` or an explicit list).
- Returned properties (problem object): `eventid`, `source`, `object`, `objectid`, `clock` (creation time, Unix timestamp), `ns`, `r_eventid` (recovery event id), `r_clock`, `r_ns`, `correlationid`, `userid`, `name` (the example response shows the problem text there), `acknowledged`, `severity`, `cause_eventid`, `suppressed`, `opdata`, `urls`.
- Enumerations from the object page: `severity` 0 not classified, 1 information, 2 warning, 3 average, 4 high, 5 disaster. `acknowledged` 0 not acknowledged, 1 acknowledged. `suppressed` 0 normal, 1 suppressed.
- In the documented response example every numeric field is a JSON string (`"severity": "3"`, `"clock": "1472457242"`, `"acknowledged": "1"`). A template should coerce.
- `selectAcknowledges` adds `acknowledges[]` (`acknowledgeid`, `userid`, `eventid`, `clock`, `message`, `action`, `old_severity`, `new_severity`, `suppress_until`, `taskid`, `maintenanceid`). `selectTags` adds `tags[]` with `tag`, `value`.
- The problem object has no host name. Getting the host needs a second call (for example `event.get` with `selectHosts`, or `trigger.get` with `selectHosts`). I did not read those pages, so that route is unverified.

Adapted from the docs (request and one response row, `problem.get` example; Bearer header form from the manual page):

```http
POST /zabbix/api_jsonrpc.php
Content-Type: application/json-rpc
Authorization: Bearer <api-token>
```
```json
{"jsonrpc": "2.0", "method": "problem.get",
 "params": {"output": "extend", "recent": false, "sortfield": ["eventid"], "sortorder": "DESC"},
 "id": 1}
```
```json
{"jsonrpc": "2.0",
 "result": [{"eventid": "1245463", "objectid": "15112", "clock": "1472457242", "r_eventid": "0",
             "name": "Zabbix agent on localhost is unreachable for 5 minutes",
             "acknowledged": "0", "severity": "3", "suppressed": "0"}],
 "id": 1}
```
(`r_eventid` "0" for an unresolved problem is my assumption of the usual value; the doc example shows a resolved one with `r_eventid` "1245468". Do not rely on the "0" literal.)

### Verified: host and interface availability

- Host object (current, 8.0): `status` 0 enabled (default), 1 disabled; `active_available` read-only: 0 unknown, 1 available, 2 not available. Source: https://www.zabbix.com/documentation/current/en/manual/api/reference/host/object
- Same in 7.0, where the page shows only `active_available` and `status` (no `available` on the host): https://www.zabbix.com/documentation/7.0/en/manual/api/reference/host/object
- 6.0 host object page: the summary reported neither `available` nor `active_available` in the table (https://www.zabbix.com/documentation/6.0/en/manual/api/reference/host/object). I cannot confirm whether a host-level `available` exists in 6.0 or earlier. Unverified.
- Host interface object (current): `available` 0 unknown (default), 1 available, 2 unavailable; `error` string, set when unavailable; `type` 1 agent, 2 SNMP, 3 IPMI, 4 JMX. Source: https://www.zabbix.com/documentation/current/en/manual/api/reference/hostinterface/object
- `host.get` supports `selectInterfaces` ("Return an interfaces property with host interfaces") and a `monitored_hosts` flag (7.0 page: https://www.zabbix.com/documentation/7.0/en/manual/api/reference/host/get). That the returned interface objects carry `available` follows from the interface object page; the host.get page itself did not list the fields.

### Unverified for Zabbix
- First Zabbix release that accepted the Bearer header; any 5.x/6.2 behaviour.
- Removal of the `auth` property (documented as deprecated in 6.4 and 7.0, absent from the 7.2 request description, no stated removal version).
- How to get host names for problems in one call.
- Whether `user.login` took `user` instead of `username` in old versions.

---

## 2. Netdata

### Verified: endpoints

Source for this whole section unless noted: the official swagger file, raw source https://raw.githubusercontent.com/netdata/netdata/master/src/web/api/netdata-swagger.yaml (master branch, so this is the development head; check against the release you target).

- `GET /api/v1/alarms`: marked `deprecated: true`. "Called without any parameters, the raised alarms in state WARNING or CRITICAL are returned. By passing `?all`, all the enabled alarms are returned." Params: `all` and `active` (both boolean, empty value allowed; `active` = only WARNING/CRITICAL).
- `GET /api/v1/alarms_values`: same params, deprecated, returns only `id`, `value`, `last_updated`, `status` per alarm.
- `GET /api/v2/alerts`: marked obsolete: "use /api/v3/alerts instead". Params `status` (e.g. CRITICAL, WARNING, CLEAR), `alert`, `scopeNodes`, `filterNodes`, `scopeContexts`, `filterContexts`, `options`, `after`, `before`, `timeout`, `cardinality`.
- `GET /api/v3/alerts` is the latest. Params: `alert` (simple pattern on alert name), `status` (comma-separated), `options` (comma or pipe separated: `summary`, `contexts`, `instances`, `values`, `configurations`), `timeout` (ms, min 1000), `cardinality` (min 1), plus the scope/filter/time params above. Description: "When not specified, typically returns only alerts in WARNING or CRITICAL state (this depends on options parameter)."
- Status values documented for v3 (description text, not a schema enum): `CRITICAL`, `WARNING`, `CLEAR`, `UNDEFINED`, `UNINITIALIZED`. Another description lists `REMOVED` as well.
- For `alarm_count` and `alarms_values` the schema enums are `REMOVED`, `UNDEFINED`, `UNINITIALIZED`, `CLEAR`, `RAISED`, `WARNING`, `CRITICAL` (and `UNKNOWN` for `alarms_values`).

### Verified: v1 `alarms` response schema (components/schemas/alarms)

- Top level: `hostname`, `latest_alarm_log_unique_id`, `status` (boolean), `now`, and `alarms`, an object whose keys look like `chart-name.alarm-name`.
- Per alarm: `id`, `name`, `chart`, `family`, `active` (false only if disabled in config), `disabled`, `silenced`, `exec`, `recipient`, `source`, `units`, `info`, `status` (a plain string; the schema does not enumerate it), `last_status_change`, `last_updated`, `next_update`, `update_every`, delay fields, `value_string`, `value` (number), `lookup_*`, `calc`, `warn`, `crit`, and more.
- The swagger gives no sample response for `/alarms`, so the example below is rebuilt from the schema, with illustrative values.

### v3 response body: unverified
- The swagger declares the 200 response of `/api/v3/alerts` and `/api/v2/alerts` only as `type: object` with a prose description. No field names for the alert list are defined. The only documented shape inside is the summary counter object (`jsonwrap2_alerts_count`): `nm` (alert name), `cl` (CLEAR count), `wr` (WARNING count), `cr` (CRITICAL count), `ot` (other count), each zero when absent. Do not write a template against the v3 alert list without capturing a real response.

### Verified: authentication and permissions
- Security scheme `bearerAuth` is `type: http`, `scheme: bearer`: `Authorization: Bearer <token>`.
- Alert endpoints are listed with `security: [{}, {bearerAuth: []}]`, described as "Public Data API - Bearer token optional, IP-based ACL restrictions apply. Default Access: Public (no authentication required). Bearer Protection: When enabled via /api/v3/bearer_protection, requires bearer token. IP Restrictions: Subject to `allow dashboard from` in netdata.conf."
- The token must be obtained through `/api/v3/bearer_get_token`, which the swagger describes as ACLK-only (needs Netdata Cloud access). Expired tokens return 401. The same description says Netdata Cloud enables bearer protection when an agent is claimed. So a claimed agent may not be readable anonymously; an unclaimed agent defaults to public.
- A static "Netdata Cloud API token" with its own header: not verified. The page I tried (learn.netdata.cloud api-tokens docs) returned 404 and I found no replacement. Unverified.

Adapted from the docs (field names from the `alarms` schema; values illustrative; not a captured response):

```json
{
  "hostname": "myhost",
  "status": true,
  "now": 1700000000,
  "alarms": {
    "system.cpu.10min_cpu_usage": {
      "id": 1, "name": "10min_cpu_usage", "chart": "system.cpu",
      "active": true, "disabled": false, "silenced": false,
      "status": "WARNING", "units": "%", "info": "average cpu utilization for the last 10 minutes",
      "last_status_change": 1699999000, "last_updated": 1699999990, "value": 82.1
    }
  }
}
```

---

## 3. Checkmk (REST API)

### Verified: authentication and URL
Source: https://docs.checkmk.com/latest/en/rest_api.html (read through the summariser)
- Header: `Authorization: Bearer USERNAME PASSWORD` (the doc's Python example: `f"Bearer {USERNAME} {PASSWORD}"`), where the credentials are those of an automation user (user name plus automation secret). "Both pieces of information must be included in the header of every request to the Checkmk server."
- Base URL: `{PROTO}://{HOST_NAME}/{SITE_NAME}/check_mk/api/{API_VERSION}`. The current page uses `v1` and says "Since Checkmk 2.5.0, the REST API in version v1 has been delivered together with the Checkmk software"; version `1.0` is the compatible predecessor available up to Checkmk 2.4.0.
- `Accept: application/json` is set in the doc examples.
- That page contains no example of listing services or hosts with a filter.

### Verified: listing services and hosts (from official source code at tag 2.4.0)
Source: raw files at https://raw.githubusercontent.com/Checkmk/checkmk/2.4.0/cmk/gui/openapi/endpoints/service/__init__.py and `.../endpoints/host/__init__.py`, `.../restful_objects/constructors.py`.
- Services: `POST /domain-types/service/collections/all` with a JSON body: `columns` (list; `host_name` and `description` are always included), `query` (filter expression, optional), `sites` (list of site ids, optional), `host_name` (optional). Example filter in the source: `{"op": "=", "left": "host_name", "right": "example.com"}`.
- The same path with GET (query string parameters) exists in 2.4.0 but is marked deprecated: "TODO: DEPRECATED(17512) - remove in 2.5".
- Hosts: `POST /domain-types/host/collections/all` (GET deprecated, 17003). The host `query` examples in the module docstring: all non-OK hosts `{'op': '!=', 'left': 'state', 'right': '0'}`; unreachable hosts `{'op': '=', 'left': 'state', 'right': '2'}`. The host row identifier column is `name`.
- Response (constructors source): a collection object `{"id": "service", "domainType": "service", "links": [...], "value": [...], "extensions": {}}`. Each `value` item is `{"domainType": "service", "id": "<host>:<description>", "title": "<description> on <host>", "links": [...], "members": {...}, "extensions": {<requested columns>: value}}`. Requested column values are in `extensions`.
- Column semantics (Livestatus table definition source, https://raw.githubusercontent.com/Checkmk/checkmk/2.4.0/cmk/utils/livestatus_helpers/tables/services.py and `hosts.py`): `state` is "The current state of the object, for hosts: 0/1/2 for UP/DOWN/UNREACH, for services: 0/1/2/3 for OK/WARN/CRIT/UNKNOWN". `last_hard_state` "Last hard state"; `plugin_output` "Output of the last check"; `acknowledged` "(0/1)"; `has_been_checked` "(0/1)"; `scheduled_downtime_depth` "The number of downtimes this object is currently in".
- Permissions (service endpoint source): any of `general.see_all`, `wato.see_all_folders` (and the two ignorable bi/mkeventd ones) is required; the code marks them as the permissions for the endpoint.

### Version caveats (primary sources)
- Werk 17512 (https://checkmk.com/werk/17512, read through the summariser): "Show all monitored services" and "Show the monitored services of a host" change from GET to POST; "The GET versions will continue to work until Checkmk version 2.5." Applies to 2.5.0b1, 2.4.0b4 and 2.3.0p31.
- Werk 19721 (https://checkmk.com/werk/19721): lists `/domain-types/service/collections/all`, `/domain-types/host/collections/all` and `/objects/host/{host_name}/collections/services` as removed in Checkmk 3.0.0b1, marked "Not yet released", dated Apr 10, 2026, "Incompatible". The page names no replacement, and the master branch no longer contains the host/service status endpoint modules (`cmk/gui/openapi/endpoints` listing). So a Checkmk template is safe for 2.3 to 2.5 only; 3.0 is unknown.
- Werk 11941 (https://checkmk.com/werk/11941): the `column` parameter handling on host/service endpoints was fixed in 2.1.0b1 and 2.0.0b7, so older versions behave differently.

### Unverified for Checkmk
- A Checkmk 2.5 `v1` specific confirmation of the POST body; I read the 2.4.0 source, not the 2.5 source.
- Whether the numeric `state` comes back as a JSON number (columns are typed `int` in the table definition, so a number is expected, but I saw no response sample).
- The 3.0 replacement endpoints.
- Authentication through other means (cookie, API key): not checked.

Adapted from the docs (body shape from the 2.4.0 source; response rebuilt from the constructors; values illustrative):

```json
POST /mysite/check_mk/api/1.0/domain-types/service/collections/all
Authorization: Bearer automation SECRET
{"columns": ["host_name", "description", "state", "plugin_output"],
 "query": {"op": "!=", "left": "state", "right": "0"}}
```
```json
{"id": "service", "domainType": "service",
 "value": [{"domainType": "service", "id": "web1:Disk /", "title": "Disk / on web1",
            "extensions": {"host_name": "web1", "description": "Disk /", "state": 2,
                           "plugin_output": "CRIT - 96% used"}}]}
```

---

## 4. Healthchecks.io (Management API v3)

All facts: raw API doc source https://raw.githubusercontent.com/healthchecks/healthchecks/master/templates/docs/api.md (rendered at https://healthchecks.io/docs/api/).

### Verified
- `GET SITE_ROOT/api/v3/checks/`. Hosted `SITE_ROOT` is `https://healthchecks.io` (rendered page). Self-hosted: the root of the install.
- Auth: `X-Api-Key: <your-api-key>` header. For POST requests with a JSON body the key may be given as an `api_key` field instead. Keys are project-specific ("There are no account-wide API keys"). Read-write and read-only keys exist; a read-only key works for list checks, get a single check, list status changes and list badges, and omits sensitive information. Per the rendered page the read-only response omits `uuid`, `ping_url`, `update_url`, `pause_url`, `resume_url`, `channels` and adds `unique_key`.
- Query parameters: `slug`, `tag` (repeatable).
- Response codes: 200, 401 (missing or invalid key).
- Rate limit: "Avoid making more than 100 API requests per minute", eventually HTTP 429.
- Response is an object `{"checks": [...]}`. Fields per check (example in the doc): `name`, `slug`, `tags` (space-separated string), `desc`, `grace` (seconds), `n_pings`, `status`, `started` (boolean), `last_ping` (ISO 8601 or null), `next_ping` (null possible), `manual_resume`, `methods`, `start_kw`, `success_kw`, `failure_kw`, `filter_*`, `badge_url`, `uuid`, `ping_url`, `update_url`, `pause_url`, `resume_url`, `channels`, and `timeout` (simple schedule) or `schedule` plus `tz` (cron schedule).
- The doc states the possible values of `status`: `new`, `up`, `grace`, `down`, `paused`.
- Not verified from the configuring-checks page (https://healthchecks.io/docs/configuring_checks/): it does not define the statuses. The definitions of what "grace" means as a state are therefore only the API doc's list; treat "grace" as late but not yet alerting (this reading is inferred from the Grace Time definition on that page: "the additional time to wait before sending an alert when a check is late").

Adapted from the docs:

```json
{"checks": [
  {"name": "Filesystem Backup", "slug": "filesystem-backup", "tags": "backup fs",
   "grace": 600, "n_pings": 1, "status": "up", "started": false,
   "last_ping": "2020-03-24T14:02:03+00:00", "next_ping": "2020-03-24T15:02:03+00:00",
   "timeout": 3600},
  {"name": "Database Backup", "slug": "database-backup", "status": "down",
   "last_ping": "2020-03-23T10:19:32+00:00", "next_ping": null,
   "schedule": "15 5 * * *", "tz": "UTC"}
]}
```

### Unverified
- Pagination: none documented for this endpoint (the doc shows no paging parameters).
- Whether `started: true` can co-occur with `status: "up"`: not stated.

---

## 5. Gatus

### Verified
Sources: README raw https://raw.githubusercontent.com/TwiN/gatus/master/README.md (section "API"), Go source https://raw.githubusercontent.com/TwiN/gatus/master/api/endpoint_status.go, `.../config/endpoint/status.go`, `.../config/endpoint/result.go`, `.../config/endpoint/event.go`, `.../api/util.go`.
- `GET /api/v1/endpoints/statuses` returns all endpoints. One endpoint: `/api/v1/endpoints/{group}_{endpoint}/statuses`. The README says: "Gatus provides a simple read-only API", gzip when `Accept-Encoding` contains gzip, `Content-Type: application/json`.
- Response is a JSON array (the handler marshals a slice of `endpoint.Status`). Each item (Go struct JSON tags): `name`, `group` (both omitted when empty), `key` (`<GROUP>_<NAME>`, with ` `, `/`, `_`, `,`, `.`, `#`, `+`, `&` replaced by `-` per README), `results` (array), `events` (array, optional).
- Each result: `status` (HTTP status code, optional), `hostname` (optional), `duration` (Go `time.Duration`, no custom marshaller seen), `errors` (array of strings, optional), `conditionResults` (optional), `success` (boolean), `timestamp`.
- Success versus failure is the boolean `success` of the result. There is no textual status. Events have `type` of `START`, `HEALTHY` or `UNHEALTHY` and `timestamp`.
- Paging: query parameters `page` (default 1) and `pageSize` (default 50; for page 1 it is capped to the configured maximum number of results). These apply to the `results` list inside each endpoint (the handler calls `WithResults(page, pageSize)`), so `?pageSize=1` limits each endpoint to a single result.
- Auth on the server side: optional `security.basic` (username, bcrypt-base64 password) or `security.oidc` (README "Basic Authentication", "OIDC"). Basic auth is therefore the form a template needs. The README says the external-endpoint push uses `Authorization: Bearer <token>` on `POST /api/v1/endpoints/{key}/external?success=...` (that is a push, not a read).

Adapted from the docs (field names from the Go structs; values illustrative):

```json
[{"name": "blog-home", "group": "core", "key": "core_blog-home",
  "results": [{"status": 200, "hostname": "example.org", "duration": 123456789,
               "conditionResults": [{"condition": "[STATUS] == 200", "success": true}],
               "success": true, "timestamp": "2026-11-26T09:00:00Z"}],
  "events": [{"type": "HEALTHY", "timestamp": "2026-11-20T08:00:00Z"}]}]
```
(The `conditionResults` item keys `condition` and `success` were not read; unverified, drop them if you fixture this.)

### Unverified
- Ordering of `results` (oldest or newest first) is not stated in what I read. A template should take the entry with the greatest `timestamp`.
- `duration` unit: inferred as nanoseconds from the Go type; no doc sentence read.
- `conditionResults` item keys.

---

## 6. Uptime Robot

### Verified: API v2 (legacy docs)
Source: https://uptimerobot.com/api/legacy/ (page text read from the raw HTML).
- `POST https://api.uptimerobot.com/v2/getMonitors`, form body `application/x-www-form-urlencoded`, for example `api_key=...&format=json`. The `api_key` can also be a URL query parameter, "only allowed for getMonitors endpoint". Formats: JSON or XML (`format` parameter).
- Parameters: `api_key` (required), `monitors` (ids joined by `-`), `types`, `statuses` (for example `statuses=2-9`), `search`, `logs`, `response_times`, `custom_uptime_ratios`, `all_time_uptime_ratio`, `offset` (default 0) and `limit` (default and maximum 50) for paging.
- Response: `{"stat": "ok", "pagination": {"offset", "limit", "total"}, "monitors": [...]}`. Monitor fields: `id`, `friendly_name`, `url`, `type`, `interval`, `status`, `create_datetime`, and more.
- `monitor>status`: 0 paused, 1 not checked yet, 2 up, 8 seems down, 9 down. All five confirmed, exact wording "0 - paused 1 - not checked yet 2 - up 8 - seems down 9 - down".
- Failure responses use `stat` other than `ok` (the legacy page examples show only `"stat": "ok"`; the failure object shape was not read, unverified).
- Rate limits: free plan 10 requests per minute; pro plan monitor limit x 2 per minute, max 5000; HTTP 429 with `X-RateLimit-*` and `Retry-After` headers.
- Key types: account-wide, monitor-specific, read-only (https://uptimerobot.com/api/ and https://uptimerobot.com/api/v3/ pages). Permissions: a read-only key is enough for getMonitors in principle; the page said CORS headers are sent only for `get*` endpoints with monitor-specific and read-only keys. I read no sentence saying a read-only key may call getMonitors, so that is unverified.

### v3: not verified
- https://uptimerobot.com/api/ presents v3 as the main API and calls the v2 docs "legacy". https://uptimerobot.com/api/v3/ did not give a base URL, header, list-monitors endpoint or status values in what I could read (it mentions HTTP Basic access authentication and JSON data, which does not match a clean v3 reference). Nothing about v3 is safe to code. No deprecation date for v2 was found.

Adapted from the docs:

```json
{"stat": "ok", "pagination": {"offset": 0, "limit": 50, "total": 2},
 "monitors": [{"id": 777749809, "friendly_name": "Google", "url": "http://www.google.com",
               "type": 1, "interval": 900, "status": 2, "create_datetime": 1462565497}]}
```

---

## 7. Beszel (PocketBase)

### Verified: PocketBase API
Sources: https://pocketbase.io/docs/api-records/ and https://pocketbase.io/docs/authentication/ (both read through the summariser).
- Login: `POST /api/collections/{collection}/auth-with-password` with JSON `identity` and `password` (optional `identityField`). Response includes `token` and `record`. For Beszel regular users the collection is `users` (https://beszel.dev/guide/rest-api: `pb.collection('users').authWithPassword(email, password)`).
- List: `GET /api/collections/{collection}/records` with `page` (default 1), `perPage` (default 30), `sort`, `filter`, `fields`, `skipTotal`. Response keys: `page`, `perPage`, `totalItems`, `totalPages`, `items`.
- Auth header: the PocketBase pages show `Authorization:YOUR_AUTH_TOKEN` (the token alone, with no `Bearer` prefix in the docs). I did not verify whether the server also accepts a `Bearer ` prefix. Unverified.
- Token lifetime is not stated. Superuser "impersonate" tokens are non-renewable, with optional custom duration, and the docs recommend them only for server-to-server use (authentication page).

### Verified: Beszel
- Beszel's own docs page https://beszel.dev/guide/rest-api says the API is PocketBase's, that the returned structure "may change in minor releases", and uses the `systems` collection with `status` in filters (example `status = "up"`). It does not define the schema.
- Status values: Go source, raw https://raw.githubusercontent.com/henrygd/beszel/main/internal/hub/systems/system_manager.go, constants `up`, `down`, `paused`, `pending` (comments: "System is online and responding", "System is offline or not responding", "System monitoring is paused", "System is waiting on initial connection result"). New records start as `pending`.
- `systems` fields seen in source (https://raw.githubusercontent.com/henrygd/beszel/main/internal/hub/systems/system.go): `name`, `host`, `status`, `info` (set by the hub). Port field exists in the struct (not checked).
- Access rules (https://raw.githubusercontent.com/henrygd/beszel/main/internal/hub/collections.go): list/view of `systems` requires an authenticated user whose id is in the system's `users` relation, unless the env var `SHARE_ALL_SYSTEMS` is `true`, in which case any authenticated user can read. So a read-only dashboard account must be added to the systems' users, or the hub must set `SHARE_ALL_SYSTEMS`.

### Unverified
- Full list of `systems` fields in a response (no sample in docs).
- Static API keys for Beszel itself: none found. The homedash template must log in with email and password and refresh the token.

Adapted from the docs (PocketBase list shape; item fields from the Beszel source; values illustrative):

```json
{"page": 1, "perPage": 30, "totalItems": 2, "totalPages": 1,
 "items": [{"id": "abc123", "name": "nas", "host": "192.168.1.10", "status": "up"},
           {"id": "def456", "name": "pi", "host": "192.168.1.11", "status": "down"}]}
```

---

## 8. Glances

### Verified (released API 4)
Source: https://raw.githubusercontent.com/nicolargo/glances/master/docs/api/restful.rst (rendered: https://glances.readthedocs.io/en/latest/api/restful.html). The latest GitHub release at the time of checking was v4.5.9 (https://api.github.com/repos/nicolargo/glances/releases/latest).
- Root URL: `http://localhost:61208/api/4` (default port 61208; optional `url_prefix` from the `[outputs]` section, which then appears before `api/4`).
- `GET /api/4/alert` returns a list. The doc's only sample is an empty list `[]`. Field descriptions: `begin` (timestamp), `end` (timestamp, or -1 if ongoing), `state` (`WARNING|CRITICAL`), `type` (`CPU|LOAD|MEM`), `max`, `avg`, `min`, `sum` (floats), `count` (int), `top` (list: top 3 processes), `desc`, `sort`, `global_msg` (strings).
- `POST /api/4/events/clear/all` and `.../clear/warning` clear the list.
- `GET /api/4/status`: API status check, HTTP 200 when OK (per rendered page).
- Auth: open by default. `--password` enables HTTP Basic and JWT Bearer. Token: `POST /api/4/token` with JSON `{"username": ..., "password": ...}` returns `{"access_token": ..., "token_type": "bearer", "expires_in": 3600}`; use `Authorization: Bearer <token>`. JWT needs the `python-jose` library. Basic auth with the same credentials is the simpler form.
- Development branch (unreleased, API 5): raw https://raw.githubusercontent.com/nicolargo/glances/develop/docs/api/restful.rst says root `/api/5`, every route except `/status`, `/healthz` and `/api/5/token` needs credentials when a password is set. A template should be written for `/api/4` and make the version part of the configuration.

### Unverified
- A non-empty sample of an alert object (types of `begin`/`end` beyond "timestamp").
- That the alert list is limited to CPU, LOAD and MEM events: the doc field description says `type` is `CPU|LOAD|MEM`, but alerts for other plugins (for example disks) may use other values; the doc lists only those three.
- Glances' "ongoing" detection: `end` equal to -1 only; there is no documented separate active flag.

Adapted from the docs (field names from the field list; the doc sample is an empty list, so this row is illustrative):

```json
[{"begin": 1700000000, "end": -1, "state": "CRITICAL", "type": "MEM",
  "max": 97.1, "avg": 95.3, "min": 91.0, "sum": 953.0, "count": 10,
  "top": ["java", "postgres", "node"], "desc": "MEM", "sort": "memory_percent", "global_msg": "High memory consumption"}]
```

---

## 9. Prometheus text exposition format (0.0.4 and current text format)

Source (raw Markdown of the official page, which I read myself): https://raw.githubusercontent.com/prometheus/docs/main/docs/instrumenting/exposition_formats.md (rendered: https://prometheus.io/docs/instrumenting/exposition_formats/). All below is verified.

Lines and whitespace
- Line oriented, separated by `\n`. "The last line must end with a line feed character." Empty lines are ignored.
- Tokens can be separated by any number of blanks and/or tabs, "and must be separated by at least one if they would otherwise merge with the previous token". Leading and trailing whitespace is ignored.

Comments
- A line with `#` as the first non-whitespace character is a comment, ignored unless the first token after `#` is `HELP` or `TYPE`.
- `# HELP <metric_name> <docstring>`: docstring is any UTF-8 text; backslash and line feed in it are escaped as `\\` and `\n`. One HELP per metric name.
- `# TYPE <metric_name> <type>` with type one of `counter`, `gauge`, `histogram`, `summary`, `untyped`. One TYPE per metric name, must appear before the first sample of that metric. No TYPE line means `untyped`.

Sample line grammar (EBNF from the page)

```
metric_name_or_labels value [ timestamp ]
metric_name_or_labels = metric_name [ "{" labels "}" ] | "{" quoted_metric_name [ "," labels ] "}"
metric_name = identifier
quoted_metric_name = `"` escaped_string `"`
labels = [ label_pairs ]
label_pairs = label_pair { "," label_pair } [ "," ]
label_pair = label_name "=" `"` escaped_string `"`
label_name = identifier | `"` escaped_string `"`
```

- `identifier` carries the usual Prometheus name restrictions. Names that do not fit those must use the quoted syntaxes (the UTF-8 name form), for example `{"my.dotted.metric", "error.message"="Not Found"}` from the page's example. When the metric name is quoted it sits inside the braces.
- A trailing comma after the last label pair is allowed by the grammar (`[ "," ]`).
- Label values: any UTF-8 sequence; backslash, double quote and line feed are escaped as `\\`, `\"`, `\n`. Example from the page: `msdos_file_access_time_seconds{path="C:\\DIR\\FILE.TXT",error="Cannot find file:\n\"FILE.TXT\""} 1.458255915e9`.
- `value` is a float "as required by Go's ParseFloat()". `NaN`, `+Inf`, `-Inf` are valid. Example from the page: `something_weird{problem="division by zero"} +Inf -3982045`. ParseFloat also accepts forms like `1.7560473e+07` (the page example shows `1.7560473e+07`); other ParseFloat spellings (for example hex floats, `Infinity`) are a Go behaviour not spelled out on the page (unverified).
- `timestamp` is an optional `int64`, milliseconds since the Unix epoch, as Go ParseInt accepts. The page example has a negative timestamp (`-3982045`).
- Each metric name plus label set must be unique, or ingestion is undefined. All lines for a metric form one group, HELP and TYPE first; sorting is preferred but not required.
- Histogram: `x_bucket{le="..."}`, `x_sum`, `x_count`; a `le="+Inf"` bucket is required and equals `x_count`. Summary: `x{quantile="..."}`, `x_sum`, `x_count`.

Content type (same page)
- Prometheus text: `text/plain; version=0.0.4`, missing version falls back to the latest text format. OpenMetrics text: `application/openmetrics-text; version=1.0.0`. Since Prometheus 3.0 scrape targets must return a valid Content-Type.
- OpenMetrics is a separate format with its own section on that page; I did not verify its grammar. A parser meant only for the classic text format should treat OpenMetrics-only syntax as unverified (for example `# EOF`, `_total`/`_created` handling, exemplars after `#`).

Parser notes that follow directly from the grammar
- A `#` inside a label value or after a value is not a comment (comments are only recognised as the first non-whitespace character of a line). Exemplars (`# {...}`) are OpenMetrics, not part of the 0.0.4 grammar on that page.
- A sample without braces and a sample with empty braces `name{} 1` are both covered (`labels = [ label_pairs ]`).
- Unquoted `identifier` restriction details (character sets) are described as "usual Prometheus expression language restrictions" and not spelled out on this page. For a tolerant parser use `[a-zA-Z_:][a-zA-Z0-9_:]*` for metric names and `[a-zA-Z_][a-zA-Z0-9_]*` for label names (the commonly known legacy sets, not quoted from this page; mark as assumption).

---

## 10. Authentication forms by tool (verified entries only)

| Tool | Form | Source of the claim |
|---|---|---|
| Zabbix | `Authorization: Bearer <token>` (6.4 and later docs; `auth` body property in 6.0 and deprecated in 6.4/7.0); JSON-RPC over POST | Section 1 pages |
| Netdata | `Authorization: Bearer <token>` only when bearer protection is on; otherwise public (IP ACL). Token from an ACLK-only endpoint | swagger `bearerAuth` |
| Checkmk | `Authorization: Bearer <username> <password>` (automation user and secret) | https://docs.checkmk.com/latest/en/rest_api.html |
| Healthchecks.io | custom header `X-Api-Key: <key>` (or `api_key` in a POST JSON body) | https://healthchecks.io/docs/api/ raw source |
| Gatus | server side Basic (`security.basic`) or OIDC; nothing for token. (The external push endpoint takes Bearer, not relevant for reading.) | README |
| Uptime Robot v2 | `api_key` form field in a POST body (and as a query parameter for `getMonitors` only) | legacy docs |
| Beszel/PocketBase | login first (`identity`, `password`), then `Authorization: <token>` without a documented `Bearer` prefix | PocketBase docs |
| Glances | none by default; Basic when `--password` is set; or JWT `Authorization: Bearer <access_token>` from `/api/4/token` | restful.rst |
| Prometheus text format | not applicable (the scrape endpoint's own auth is out of scope; see the earlier note for Prometheus itself) | n/a |

Query-parameter secrets: Uptime Robot's `getMonitors` is the only tool in this list where a documented query-string key is supported (`?api_key=...`). The other documents describe headers or a body field.

Practical consequence for the custom HTTP source: the generic auth options needed to cover these tools are (a) Bearer token, (b) Basic, (c) arbitrary header name with a secret value, (d) a secret placed in a form or JSON body or in the query string, (e) Checkmk's two-part Bearer value, which is just a free-form `Authorization` value, and (f) a login step that exchanges credentials for a token (PocketBase, Zabbix `user.login`, Glances JWT). Option (f) is not needed if the template asks for a static token where one exists (Zabbix, Glances Basic).

---

## Unverified items collected in one list

- Zabbix: first release with the Bearer header; removal of `auth`; host names with problems in one call; host-level `available` in 6.0 and earlier; `user.login` parameter name in old versions.
- Netdata: response field names of `/api/v3/alerts` and `/api/v2/alerts`; Netdata Cloud personal API token form; a captured sample of `/api/v1/alarms`.
- Checkmk: 2.5 source confirmation of the POST body; JSON type of `state` in a captured response; 3.0 replacement endpoints; non-Bearer auth.
- Healthchecks.io: pagination (none documented).
- Gatus: result ordering, duration unit, `conditionResults` item keys.
- Uptime Robot: everything about API v3; the failure response shape; read-only key use with `getMonitors`.
- Beszel: complete `systems` field list; whether `Bearer ` prefix is accepted by PocketBase.
- Glances: non-empty alert sample; alert types beyond CPU, LOAD, MEM; the API 5 development branch is unreleased.
- Prometheus text format: Go ParseFloat spellings beyond the page; unquoted identifier character sets (not on the page); OpenMetrics grammar.
