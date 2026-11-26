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

export const kindSpec = (kind: string): SourceKind | undefined => SOURCE_KINDS.find((k) => k.kind === kind);
export const secretFields = (kind: string): string[] => kindSpec(kind)?.fields.filter((f) => f.type === 'secret').map((f) => f.name) ?? [];
