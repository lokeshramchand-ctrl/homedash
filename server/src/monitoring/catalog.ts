// The kinds of monitoring source a person can connect, and what each one needs. Pure data (no imports), like tile-kinds.ts:
// the connect form, the API validation and the docs all read it.
export type FieldType = 'url' | 'text' | 'secret' | 'number';
export interface FieldSpec { name: string; label: string; type: FieldType; required?: boolean; hint?: string }
export interface SourceKind {
  kind: string; label: string; summary: string; hint: string;
  /** pull = homedash reads the tool on an interval; push = the tool sends events to homedash */
  mode: 'pull' | 'push';
  fields: FieldSpec[];
}

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
    ],
  },
  {
    kind: 'jsonpoll', label: 'Any JSON endpoint', mode: 'pull', summary: 'Turn a JSON list into up/down checks.',
    hint: 'Point at a URL that returns JSON, then say where the list is and which fields hold the name and the status. Paths look like data.items or items[0].state; use $ for a list at the top.',
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
    kind: 'webhook', label: 'Webhook (any tool)', mode: 'push', summary: 'Anything that can send an HTTP POST: Alertmanager, Grafana, scripts.',
    hint: 'homedash gives you a URL and a secret. Alertmanager and Grafana webhook payloads are understood, and so is a simple {"name":"backup","status":"down"}.',
    fields: [],
  },
];

export const kindSpec = (kind: string): SourceKind | undefined => SOURCE_KINDS.find((k) => k.kind === kind);
export const secretFields = (kind: string): string[] => kindSpec(kind)?.fields.filter((f) => f.type === 'secret').map((f) => f.name) ?? [];
