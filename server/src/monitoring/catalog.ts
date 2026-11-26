// The kinds of monitoring source a person can connect, and what each one needs. Pure data (no imports), like tile-kinds.ts:
// the connect form, the API validation and the docs all read it.
export type FieldType = 'url' | 'text' | 'secret' | 'number' | 'bool' | 'select' | 'textarea';
export interface FieldSpec {
  name: string; label: string; type: FieldType; required?: boolean; hint?: string;
  /** for a select: the choices; the first is the default */
  options?: { value: string; label: string }[];
  /** shown (and read) only while another field has one of these values */
  showWhen?: { field: string; in: string[] };
  /** tucked into an "Advanced" section of the form */
  advanced?: boolean;
}
export interface SourceKind {
  kind: string; label: string; summary: string; hint: string;
  /** pull = homedash reads the tool on an interval; push = the tool sends events to homedash */
  mode: 'pull' | 'push';
  fields: FieldSpec[];
}

/** Whether a field applies, given the values chosen so far. Used by the form and by the server's validation. */
export const fieldVisible = (f: FieldSpec, values: Record<string, string>, kind?: SourceKind): boolean => {
  if (!f.showWhen) return true;
  const dep = kind?.fields.find((x) => x.name === f.showWhen!.field);
  const v = values[f.showWhen.field] || dep?.options?.[0]?.value || '';
  return f.showWhen.in.includes(v);
};

const TLS_FIELD: FieldSpec = { name: 'insecure_tls', label: 'Accept a self-signed certificate', type: 'bool', advanced: true, hint: 'Only for this source. Turn it on when the server uses HTTPS with its own certificate.' };
const LIST = ['json_checks', 'json_alerts'];

export const SOURCE_KINDS: SourceKind[] = [
  {
    kind: 'kuma', label: 'Uptime Kuma', mode: 'pull', summary: 'Monitor status and response times.',
    hint: 'Uptime Kuma exposes /metrics behind an API key (Settings, API Keys).',
    fields: [
      { name: 'url', label: 'Address', type: 'url', required: true, hint: 'For example http://192.168.1.15:3001' },
      { name: 'api_key', label: 'API key', type: 'secret', required: true },
    ],
  },
  {
    kind: 'grafana', label: 'Grafana', mode: 'pull', summary: 'Firing alert rules, plus embedded dashboards.',
    hint: 'Create a read-only service account and give its token. It must be allowed to read alert rules; the exact role is not documented, so use the Test button.',
    fields: [
      { name: 'url', label: 'Address', type: 'url', required: true, hint: 'How homedash reaches Grafana, for example http://192.168.1.14:3000' },
      { name: 'token', label: 'Service account token', type: 'secret', required: true },
      { name: 'public_url', label: 'Public address', type: 'url', hint: 'Used for links and embeds when it differs from the address above.' },
      { name: 'datasource_uid', label: 'Prometheus data source UID', type: 'text', hint: 'Only for the CPU, memory and network graphs on Overview.' },
    ],
  },
  {
    kind: 'prometheus', label: 'Prometheus (or compatible)', mode: 'pull', summary: 'Firing and pending alert rules.',
    hint: 'Reads /api/v1/rules. Prometheus itself documents only basic authentication; a bearer token is for servers behind a reverse proxy. Grafana Mimir documents the same endpoint; vmalert documents it too; Thanos Ruler does not, so it is untested.',
    fields: [
      { name: 'url', label: 'Address', type: 'url', required: true, hint: 'For example http://192.168.1.12:9090' },
      { name: 'username', label: 'User name (basic auth)', type: 'text' },
      { name: 'password', label: 'Password (basic auth)', type: 'secret' },
      { name: 'bearer_token', label: 'Bearer token (reverse proxy)', type: 'secret' },
      TLS_FIELD,
    ],
  },
  {
    kind: 'alertmanager', label: 'Alertmanager', mode: 'pull', summary: 'Active alerts, not silenced or inhibited.',
    hint: 'Reads /api/v2/alerts. Alertmanager has no built-in login; use basic auth or a bearer token only if a reverse proxy in front asks for one.',
    fields: [
      { name: 'url', label: 'Address', type: 'url', required: true, hint: 'For example http://192.168.1.12:9093' },
      { name: 'username', label: 'User name (basic auth)', type: 'text' },
      { name: 'password', label: 'Password (basic auth)', type: 'secret' },
      { name: 'bearer_token', label: 'Bearer token (reverse proxy)', type: 'secret' },
      TLS_FIELD,
    ],
  },
  {
    kind: 'jsonpoll', label: 'Any JSON endpoint', mode: 'pull', summary: 'Turn a JSON list into up/down checks.',
    hint: 'Point at a URL that returns JSON, then say where the list is and which fields hold the name and the status. Paths look like data.items or items[0].state; use $ for a list at the top. For more options (other sign-in styles, POST, alerts, /metrics pages) use Custom HTTP source.',
    fields: [
      { name: 'url', label: 'Address', type: 'url', required: true },
      { name: 'token', label: 'Bearer token', type: 'secret' },
      { name: 'items_path', label: 'Path to the list', type: 'text', required: true, hint: 'For example data.monitors, or $ for a top-level list' },
      { name: 'name_path', label: 'Path to the name (inside each item)', type: 'text', required: true },
      { name: 'status_path', label: 'Path to the status (inside each item)', type: 'text', required: true },
      { name: 'status_map', label: 'Status values', type: 'text', hint: 'For example ok=up, fail=down, warn=pending. Anything else counts as unknown.' },
      { name: 'detail_path', label: 'Path to a message (optional)', type: 'text' },
    ],
  },
  {
    kind: 'http', label: 'Custom HTTP source', mode: 'pull', summary: 'Any tool with a web address: JSON, a /metrics page, or just "is it reachable".',
    hint: 'Describe one request and how to read the answer. If a tool is not in this list, this is how you connect it.',
    fields: [
      { name: 'url', label: 'Address', type: 'url', required: true },
      { name: 'method', label: 'Method', type: 'select', options: [{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }] },
      { name: 'auth', label: 'Sign in with', type: 'select', options: [{ value: 'none', label: 'Nothing' }, { value: 'bearer', label: 'Bearer token' }, { value: 'basic', label: 'User name and password' }, { value: 'header', label: 'A key in a header' }, { value: 'query', label: 'A key in the address' }] },
      { name: 'username', label: 'User name', type: 'text', showWhen: { field: 'auth', in: ['basic'] } },
      { name: 'header_name', label: 'Header name', type: 'text', showWhen: { field: 'auth', in: ['header'] }, hint: 'For example X-Api-Key' },
      { name: 'query_name', label: 'Query parameter name', type: 'text', showWhen: { field: 'auth', in: ['query'] }, hint: 'For example api_key' },
      { name: 'secret', label: 'Key, token or password', type: 'secret', hint: 'Also available as {{secret}} in the address, extra headers and body.' },
      { name: 'body', label: 'Request body', type: 'textarea', showWhen: { field: 'method', in: ['POST'] }, hint: 'Sent as JSON unless you set a Content-Type header.' },
      { name: 'extra_headers', label: 'Extra headers', type: 'textarea', advanced: true, hint: 'One per line: Name: value' },
      TLS_FIELD,
      { name: 'parse', label: 'Read the answer as', type: 'select', options: [{ value: 'json_checks', label: 'A JSON list of things to check (up or down)' }, { value: 'json_alerts', label: 'A JSON list of problems (alerts)' }, { value: 'prometheus', label: 'A Prometheus /metrics page' }, { value: 'status', label: 'Just check that it answers' }] },
      { name: 'items_path', label: 'Path to the list', type: 'text', required: true, showWhen: { field: 'parse', in: LIST }, hint: 'For example data.items, or $ for a list at the top' },
      { name: 'name_path', label: 'Name (inside each item)', type: 'text', required: true, showWhen: { field: 'parse', in: LIST } },
      { name: 'status_path', label: 'Status (inside each item)', type: 'text', showWhen: { field: 'parse', in: LIST }, hint: 'Needed for checks. For problems it is only used with "Problem when status is".' },
      { name: 'status_map', label: 'Status values', type: 'text', showWhen: { field: 'parse', in: ['json_checks'] }, hint: 'For example ok=up, fail=down, warn=pending. Common words are understood.' },
      { name: 'detail_path', label: 'Message (inside each item)', type: 'text', showWhen: { field: 'parse', in: ['json_checks'] } },
      { name: 'summary_path', label: 'Message (inside each item)', type: 'text', showWhen: { field: 'parse', in: ['json_alerts'] } },
      { name: 'level_path', label: 'Severity (inside each item)', type: 'text', showWhen: { field: 'parse', in: ['json_alerts'] } },
      { name: 'level_map', label: 'Severity values', type: 'text', showWhen: { field: 'parse', in: ['json_alerts'] }, hint: 'For example 5=error, 4=error, 3=warn, critical=error' },
      { name: 'since_path', label: 'Start time (inside each item)', type: 'text', showWhen: { field: 'parse', in: ['json_alerts'] }, hint: 'Seconds, milliseconds or an ISO date' },
      { name: 'alert_values', label: 'Problem when status is', type: 'text', showWhen: { field: 'parse', in: ['json_alerts'] }, hint: 'Optional, for example problem, firing. Leave empty if every item is a problem.' },
      { name: 'key_path', label: 'Unique id (inside each item)', type: 'text', showWhen: { field: 'parse', in: ['json_alerts'] }, hint: 'Optional. Lets a problem be recognised when it comes back in the next read.' },
      { name: 'metric', label: 'Metric name', type: 'text', required: true, showWhen: { field: 'parse', in: ['prometheus'] }, hint: 'For example up, or node_filesystem_avail_bytes' },
      { name: 'label_filter', label: 'Only series with', type: 'text', showWhen: { field: 'parse', in: ['prometheus'] }, hint: 'For example job=node, env=prod' },
      { name: 'name_label', label: 'Name each check by label', type: 'text', showWhen: { field: 'parse', in: ['prometheus'] }, hint: 'For example instance' },
      { name: 'up_when', label: 'Up when the value is', type: 'text', showWhen: { field: 'parse', in: ['prometheus'] }, hint: 'A comparison such as == 1 (the default) or < 80' },
      { name: 'warn_when', label: 'Warning when the value is', type: 'text', showWhen: { field: 'parse', in: ['prometheus'] }, hint: 'Optional, checked when "up" does not hold, for example < 95' },
      { name: 'ok_codes', label: 'Good status codes', type: 'text', showWhen: { field: 'parse', in: ['status'] }, hint: 'For example 200-399 (the default) or 200, 401' },
      { name: 'must_contain', label: 'The answer must contain', type: 'text', showWhen: { field: 'parse', in: ['status'] }, hint: 'Optional text that proves the page is the right one' },
    ],
  },
  {
    kind: 'probe', label: 'Service checks (ports, websites, certificates)', mode: 'pull', summary: 'homedash looks at addresses itself. No tool needed.',
    hint: 'One check per line: name | type | address. Types: http (a web address), tcp (host:port) or tls (host or host:port; warns 14 days before the certificate expires).',
    fields: [
      { name: 'targets', label: 'Checks', type: 'textarea', required: true, hint: 'For example: NAS | tcp | 192.168.1.5:445, then Wiki | http | http://wiki.lan, then Certificate | tls | wiki.lan, one per line' },
    ],
  },
  {
    kind: 'webhook', label: 'Webhook (any tool)', mode: 'push', summary: 'Anything that can send an HTTP POST: Alertmanager, Grafana, scripts.',
    hint: 'homedash gives you an address and a secret. Alertmanager and Grafana payloads and a simple {"name":"backup","status":"down"} are understood; for any other JSON, describe it under Advanced.',
    fields: [
      { name: 'items_path', label: 'Path to the list (other JSON only)', type: 'text', advanced: true, hint: 'Leave all of these empty for Alertmanager, Grafana and the plain shape. Fill them in to read any other JSON a tool sends. Use $ for the whole body.' },
      { name: 'name_path', label: 'Name (inside each item)', type: 'text', advanced: true },
      { name: 'as', label: 'Treat each item as', type: 'select', advanced: true, options: [{ value: 'check', label: 'A check (up or down)' }, { value: 'alert', label: 'A problem (alert)' }] },
      { name: 'status_path', label: 'Status (inside each item)', type: 'text', advanced: true },
      { name: 'status_map', label: 'Status values', type: 'text', advanced: true, showWhen: { field: 'as', in: ['check'] }, hint: 'For example good=up, bad=down' },
      { name: 'alert_values', label: 'Problem when status is', type: 'text', advanced: true, showWhen: { field: 'as', in: ['alert'] }, hint: 'Any other status clears the problem. Leave empty if every item is a problem.' },
      { name: 'key_path', label: 'Unique id (inside each item)', type: 'text', advanced: true },
      { name: 'detail_path', label: 'Message (inside each item)', type: 'text', advanced: true },
      { name: 'level_path', label: 'Severity (inside each item)', type: 'text', advanced: true, showWhen: { field: 'as', in: ['alert'] } },
      { name: 'level_map', label: 'Severity values', type: 'text', advanced: true, showWhen: { field: 'as', in: ['alert'] } },
    ],
  },
];

/**
 * A ready-made configuration of the custom HTTP source for one well-known tool. `ask` is what the person is asked for; `fixed`
 * is filled in for them and cannot be changed in the form. Adding a tool means adding an entry here, not writing code.
 * Only tools whose request and answer were checked against their own documentation are listed (docs/research/monitoring-templates-formats.md).
 */
export interface SourceTemplate {
  id: string; label: string; summary: string; hint: string;
  /** which documentation the request and the reading of the answer were checked against */
  verified: string;
  ask: FieldSpec[];
  fixed: Record<string, string>;
  /** the person gives the tool's base address; this is appended (once) */
  urlSuffix?: string;
  /** the tool has one fixed address, so the person is not asked */
  fixedUrl?: string;
}

const ADDRESS = (hint: string): FieldSpec => ({ name: 'url', label: 'Address', type: 'url', required: true, hint });

export const SOURCE_TEMPLATES: SourceTemplate[] = [
  {
    id: 'healthchecks', label: 'Healthchecks.io', summary: 'Which cron jobs and backups reported in on time.',
    hint: 'Create a read-only API key in the project settings. Checks that are late (grace) show as a warning, down checks as down, paused ones are ignored.',
    verified: 'Healthchecks.io API v3 documentation (Management API, list checks)',
    ask: [ADDRESS('https://healthchecks.io, or the address of your own install'), { name: 'secret', label: 'Read-only API key', type: 'secret', required: true }],
    urlSuffix: '/api/v3/checks/',
    fixed: { method: 'GET', auth: 'header', header_name: 'X-Api-Key', parse: 'json_checks', items_path: 'checks', name_path: 'name', status_path: 'status', status_map: 'up=up, down=down, grace=pending, paused=maintenance, new=unknown' },
  },
  {
    id: 'zabbix', label: 'Zabbix', summary: 'Problems that are open right now.',
    hint: 'For Zabbix 6.4 and newer (the API token goes in a header there). Create an API token under Users, API tokens, for a user who can see the hosts you care about.',
    verified: 'Zabbix manual 6.4 to 8.0: API, problem.get',
    ask: [ADDRESS('The Zabbix web interface, for example http://192.168.1.30/zabbix'), { name: 'secret', label: 'API token', type: 'secret', required: true }],
    urlSuffix: '/api_jsonrpc.php',
    fixed: {
      method: 'POST', auth: 'bearer', extra_headers: 'Content-Type: application/json-rpc',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'problem.get', params: { output: 'extend', recent: false, sortfield: ['eventid'], sortorder: 'DESC' }, id: 1 }),
      parse: 'json_alerts', items_path: 'result', name_path: 'name', level_path: 'severity', level_map: '5=error, 4=error, 3=warn, 2=warn, 1=info, 0=info', since_path: 'clock', key_path: 'eventid',
    },
  },
  {
    id: 'uptimerobot', label: 'Uptime Robot', summary: 'Your Uptime Robot monitors (API v2).',
    hint: 'Uses the v2 API with a read-only key from your account. The newer v3 API is not covered. The free plan allows ten requests a minute; homedash reads once a minute.',
    verified: 'Uptime Robot API v2 documentation (getMonitors)',
    ask: [{ name: 'secret', label: 'Read-only API key', type: 'secret', required: true }],
    fixedUrl: 'https://api.uptimerobot.com/v2/getMonitors',
    fixed: {
      method: 'POST', auth: 'none', extra_headers: 'Content-Type: application/x-www-form-urlencoded', body: 'api_key={{secret}}&format=json&limit=50',
      parse: 'json_checks', items_path: 'monitors', name_path: 'friendly_name', status_path: 'status', status_map: '2=up, 9=down, 8=pending, 0=maintenance, 1=unknown',
    },
  },
  {
    id: 'netdata', label: 'Netdata', summary: 'Alarms that are raised on a Netdata agent.',
    hint: 'Uses the classic alarms endpoint, which Netdata marks as deprecated but still serves. An unclaimed agent needs no token; if bearer protection is on, choose Bearer token and paste one.',
    verified: 'Netdata agent API (swagger), /api/v1/alarms',
    ask: [ADDRESS('For example http://192.168.1.40:19999'), { name: 'auth', label: 'Sign in with', type: 'select', options: [{ value: 'none', label: 'Nothing' }, { value: 'bearer', label: 'Bearer token' }] }, { name: 'secret', label: 'Bearer token', type: 'secret', showWhen: { field: 'auth', in: ['bearer'] } }],
    urlSuffix: '/api/v1/alarms',
    fixed: { method: 'GET', parse: 'json_alerts', items_path: 'alarms', name_path: 'name', status_path: 'status', alert_values: 'warning, critical', level_path: 'status', level_map: 'critical=error, warning=warn', summary_path: 'info', since_path: 'last_status_change', key_path: 'id' },
  },
  {
    id: 'checkmk', label: 'Checkmk', summary: 'Services that are not OK.',
    hint: 'For Checkmk 2.3.0p31, 2.4 and 2.5. Use an automation user and type the user name, a space, then its secret (for example: automation MYSECRET). Checkmk 3.0 will remove this endpoint.',
    verified: 'Checkmk 2.4.0 REST API source (services endpoint) and its documentation',
    ask: [ADDRESS('The address including the site name, for example http://192.168.1.50/mysite'), { name: 'secret', label: 'Automation user and secret', type: 'secret', required: true, hint: 'user name, a space, then the secret' }],
    urlSuffix: '/check_mk/api/1.0/domain-types/service/collections/all',
    fixed: {
      method: 'POST', auth: 'bearer',
      body: JSON.stringify({ columns: ['host_name', 'description', 'state', 'plugin_output'], query: { op: '!=', left: 'state', right: '0' } }),
      parse: 'json_alerts', items_path: 'value', name_path: 'title', level_path: 'extensions.state', level_map: '2=error, 3=warn, 1=warn', summary_path: 'extensions.plugin_output', key_path: 'id',
    },
  },
  {
    id: 'opnsense', label: 'OPNsense', summary: 'Gateways: online, delayed or lossy, offline.',
    hint: 'In OPNsense create a user with only the "Routes: Gateway status" privilege and generate an API key for it (System, Access, Users). Give the key as the user name and the secret as the password. Use "Accept a self-signed certificate" under Advanced on the firewall if its web page uses its own certificate.',
    verified: 'OPNsense API reference (routes/gateway/status). The field names come from the reference and are not confirmed on a live firewall; use Test',
    ask: [ADDRESS('The firewall web address, for example https://192.168.1.1'), { name: 'username', label: 'API key', type: 'text', required: true }, { name: 'secret', label: 'API secret', type: 'secret', required: true }, { name: 'insecure_tls', label: 'Accept a self-signed certificate', type: 'bool' }],
    urlSuffix: '/api/routes/gateway/status',
    fixed: { method: 'GET', auth: 'basic', parse: 'json_checks', items_path: 'items', name_path: 'name', status_path: 'status_translated', status_map: 'online=up, offline=down, packetloss=pending, latency=pending, latency and packetloss=pending, pending=unknown', detail_path: 'delay' },
  },
  {
    id: 'loki-alerts', label: 'Grafana Loki (alerting rules)', summary: 'Log-based alerts that are firing in the Loki ruler.',
    hint: 'Only useful when Loki runs its ruler. Loki has no login of its own; if a proxy in front of it needs a tenant, add the X-Scope-OrgID header under Extra headers. The ruler answers in the same shape as Prometheus.',
    verified: 'Grafana Loki HTTP API reference (Ruler: GET /prometheus/api/v1/alerts)',
    ask: [ADDRESS('For example http://192.168.1.13:3100'), { name: 'extra_headers', label: 'Extra headers', type: 'textarea', hint: 'One per line, for example X-Scope-OrgID: tenant1' }],
    urlSuffix: '/prometheus/api/v1/alerts',
    fixed: { method: 'GET', auth: 'none', parse: 'json_alerts', items_path: 'data.alerts', name_path: 'labels.alertname', status_path: 'state', alert_values: 'firing', level_path: 'labels.severity', level_map: 'critical=error, error=error, warning=warn', summary_path: 'annotations.summary', since_path: 'activeAt' },
  },
  {
    id: 'loki-ready', label: 'Grafana Loki (is it up)', summary: 'Whether Loki reports itself ready.',
    hint: 'Reads /ready, which answers "ready" when Loki can take logs. Needs no key.',
    verified: 'Grafana Loki HTTP API reference (GET /ready)',
    ask: [ADDRESS('For example http://192.168.1.13:3100')],
    urlSuffix: '/ready',
    fixed: { method: 'GET', auth: 'none', parse: 'status', ok_codes: '200', must_contain: 'ready' },
  },
  {
    id: 'authentik', label: 'authentik (is it up)', summary: 'Whether the authentik server answers its health check.',
    hint: 'Reads the readiness page, which needs no key and answers with an empty success. It confirms the identity provider can sign people in; use Identity to read its OIDC configuration.',
    verified: 'authentik documentation, monitoring (the /-/health/ready/ endpoint)',
    ask: [ADDRESS('For example https://auth.example.lan'), { name: 'insecure_tls', label: 'Accept a self-signed certificate', type: 'bool' }],
    urlSuffix: '/-/health/ready/',
    fixed: { method: 'GET', auth: 'none', parse: 'status', ok_codes: '200-299' },
  },
  {
    id: 'keycloak', label: 'Keycloak (is it up)', summary: 'Whether Keycloak reports itself ready.',
    hint: 'Keycloak serves /health/ready on its management port (9000 by default in current versions) once health is enabled. Give that address, not the sign-in address.',
    verified: 'Keycloak documentation, health checks (/health/ready on the management interface)',
    ask: [ADDRESS('For example http://192.168.1.16:9000'), { name: 'insecure_tls', label: 'Accept a self-signed certificate', type: 'bool' }],
    urlSuffix: '/health/ready',
    fixed: { method: 'GET', auth: 'none', parse: 'status', ok_codes: '200' },
  },
  {
    id: 'authelia', label: 'Authelia (is it up)', summary: 'Whether Authelia answers its health check.',
    hint: 'Reads /api/health, which needs no key.',
    verified: 'Authelia documentation, health check endpoint (/api/health)',
    ask: [ADDRESS('For example https://auth.example.lan'), { name: 'insecure_tls', label: 'Accept a self-signed certificate', type: 'bool' }],
    urlSuffix: '/api/health',
    fixed: { method: 'GET', auth: 'none', parse: 'status', ok_codes: '200' },
  },
];

export const templateSpec =(id: string): SourceTemplate | undefined => SOURCE_TEMPLATES.find((t) => t.id === id);

/** Pure: a form body for a template to a body for the custom HTTP source. What the template fixes cannot be overridden. */
export function applyTemplate(t: SourceTemplate, body: Record<string, unknown>): Record<string, unknown> {
  if (t.fixedUrl) return { ...body, ...t.fixed, url: t.fixedUrl, template: t.id };
  const given = String(body.url ?? '').trim().replace(/\/+$/, '');
  if (!given) return { ...body, ...t.fixed, url: '', template: t.id };
  // The suffix is added once: editing a saved source gives back the full address, which must not get it a second time.
  const suffix = t.urlSuffix ?? '';
  const core = suffix.replace(/\/+$/, '');
  const url = !suffix ? given : given.endsWith(core) ? given + (suffix.endsWith('/') ? '/' : '') : given + suffix;
  return { ...body, ...t.fixed, url, template: t.id };
}

export const kindSpec = (kind: string): SourceKind | undefined => SOURCE_KINDS.find((k) => k.kind === kind);
export const secretFields = (kind: string): string[] => kindSpec(kind)?.fields.filter((f) => f.type === 'secret').map((f) => f.name) ?? [];
