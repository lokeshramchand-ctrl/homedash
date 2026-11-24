// homedash.yaml -> server environment. One table drives both directions: `apply` renders .env from the YAML and
// `status` reports which integrations the resulting settings switch on. Unknown YAML keys are reported, not ignored.

export type Yaml = Record<string, any>;
export interface Mapped { env: Record<string, string>; problems: string[]; notes: string[] }

const get = (o: Yaml, path: string): unknown => path.split('.').reduce<unknown>((c, k) => (c && typeof c === 'object' ? (c as Yaml)[k] : undefined), o);
const isSet = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

/** Expands ${NAME} from the secrets file / process environment. Returns the text and any unknown names. */
export function expand(text: string, secrets: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, dflt?: string) => {
    const v = secrets[name] ?? process.env[name];
    if (v !== undefined && v !== '') return v;
    if (dflt !== undefined) return dflt;
    missing.push(name);
    return '';
  });
  return { text: out, missing };
}

const scalar = (v: unknown): string => (typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
const list = (sep: string) => (v: unknown) => (Array.isArray(v) ? v.map(String).join(sep) : String(v));
const json = (v: unknown) => JSON.stringify(v);

interface Row { path: string; env: string; fmt?: (v: unknown) => string }
const R = (path: string, env: string, fmt?: (v: unknown) => string): Row => ({ path, env, fmt });

// ---- the mapping ------------------------------------------------------------------------------
const ROWS: Row[] = [
  R('server.port', 'PORT'), R('server.host', 'HOST'), R('server.trust_proxy', 'TRUST_PROXY', (v) => (Array.isArray(v) ? v.join(',') : scalar(v))),
  R('server.secure_cookies', 'COOKIE_SECURE'), R('server.session_hours', 'SESSION_TTL_HOURS'), R('server.session_idle_minutes', 'SESSION_IDLE_MINUTES'),
  R('server.serve_dist', 'SERVE_DIST'), R('server.database', 'DB_PATH'), R('server.frame_src', 'FRAME_SRC', list(' ')),
  R('server.log_retention_days', 'EVENT_RETENTION_DAYS'), R('server.host_journal', 'JOURNAL_ENABLED'),

  R('proxmox.url', 'PVE_URL'), R('proxmox.node', 'PVE_NODE'), R('proxmox.token_id', 'PVE_TOKEN_ID'), R('proxmox.token_secret', 'PVE_TOKEN_SECRET'),
  R('proxmox.insecure_tls', 'PVE_INSECURE_TLS'), R('proxmox.allowed_vmids', 'ALLOWED_VMIDS', list(',')), R('proxmox.protected_vmids', 'PROTECTED_VMIDS', list(',')),
  R('proxmox.featured_vmid', 'FEATURED_VMID'), R('proxmox.conflicts', 'GUEST_CONFLICTS', json), R('proxmox.allow_host_power', 'HOST_POWER_ENABLED'),
  R('proxmox.backup_max_age_days', 'BACKUP_MAX_AGE_DAYS'), R('proxmox.snapshot_max_age_days', 'SNAPSHOT_MAX_AGE_DAYS'), R('proxmox.memory_reserve_mb', 'MEMORY_RESERVE_MB'),

  R('auth.mfa.required', 'MFA_REQUIRED'), R('auth.mfa.issuer', 'MFA_ISSUER'),
  R('auth.oidc.issuer', 'OIDC_ISSUER'), R('auth.oidc.client_id', 'OIDC_CLIENT_ID'), R('auth.oidc.client_secret', 'OIDC_CLIENT_SECRET'),
  R('auth.oidc.redirect_uri', 'OIDC_REDIRECT_URI'), R('auth.oidc.scopes', 'OIDC_SCOPES', list(' ')),
  R('auth.oidc.allowed_users', 'OIDC_ALLOWED_USERS', list(',')), R('auth.oidc.required_role', 'OIDC_REQUIRED_ROLE'),
  R('auth.oidc.roles_claim', 'OIDC_ROLES_CLAIM', list(',')), R('auth.oidc.admin_users', 'OIDC_ADMIN_USERS', list(',')),
  R('auth.oidc.default_role', 'OIDC_DEFAULT_ROLE'), R('auth.oidc.label', 'OIDC_LABEL'),

  R('grafana.url', 'GRAFANA_URL'), R('grafana.public_url', 'GRAFANA_PUBLIC_URL'), R('grafana.token', 'GRAFANA_TOKEN'), R('grafana.datasource_uid', 'GRAFANA_DS_UID'),
  R('prometheus.url', 'PROMETHEUS_URL'),
  R('kuma.url', 'KUMA_URL'), R('kuma.api_key', 'KUMA_API_KEY'), R('kuma.poll_ms', 'KUMA_POLL_MS'),
  R('loki.url', 'LOKI_URL'), R('loki.public_url', 'LOKI_PUBLIC_URL'),
  R('crowdsec.snapshot', 'CROWDSEC_SNAPSHOT'), R('crowdsec.central_name', 'CROWDSEC_CENTRAL_NAME'), R('crowdsec.host_name', 'CROWDSEC_HOST_NAME'),

  R('ntfy.url', 'NTFY_URL'), R('ntfy.public_url', 'NTFY_PUBLIC_URL'), R('ntfy.topic', 'NTFY_TOPIC'), R('ntfy.token', 'NTFY_TOKEN'), R('ntfy.click_url', 'NTFY_CLICK_URL'),
  R('ntfy.alert_cpu', 'ALERT_CPU'), R('ntfy.alert_mem', 'ALERT_MEM'), R('ntfy.alert_disk', 'ALERT_DISK'),
  R('gotify.url', 'GOTIFY_URL'), R('gotify.token', 'GOTIFY_TOKEN'),
  R('discord.webhook_url', 'DISCORD_WEBHOOK_URL'), R('discord.username', 'DISCORD_USERNAME'), R('slack.webhook_url', 'SLACK_WEBHOOK_URL'),
  R('telegram.bot_token', 'TELEGRAM_BOT_TOKEN'), R('telegram.chat_id', 'TELEGRAM_CHAT_ID'),
  R('email.host', 'SMTP_HOST'), R('email.port', 'SMTP_PORT'), R('email.secure', 'SMTP_SECURE'), R('email.starttls', 'SMTP_STARTTLS'),
  R('email.user', 'SMTP_USER'), R('email.password', 'SMTP_PASSWORD'), R('email.from', 'SMTP_FROM'), R('email.to', 'SMTP_TO', list(',')),
  R('email.insecure_tls', 'SMTP_INSECURE_TLS'),
  R('apprise.url', 'APPRISE_URL'), R('apprise.key', 'APPRISE_KEY'), R('apprise.urls', 'APPRISE_URLS', list(' ')), R('apprise.tag', 'APPRISE_TAG'),
  R('webhook.url', 'WEBHOOK_URL'), R('webhook.secret', 'WEBHOOK_SECRET'),
  R('pagerduty.routing_key', 'PAGERDUTY_ROUTING_KEY'), R('opsgenie.api_key', 'OPSGENIE_API_KEY'), R('opsgenie.region', 'OPSGENIE_REGION'),
  R('ai.base_url', 'AI_BASE_URL'), R('ai.api_key', 'AI_API_KEY'), R('ai.model', 'AI_MODEL'), R('ai.label', 'AI_LABEL'),

  R('llama.url', 'LLAMA_URL'), R('llama.api_key', 'LLAMA_API_KEY'), R('llama.agent_url', 'LLAMA_AGENT_URL'), R('llama.agent_token', 'LLAMA_AGENT_TOKEN'),
  R('llama.public_url', 'LLAMA_PUBLIC_URL'), R('llama.vmid', 'LLAMA_VMID'),
  R('gpu_watch.agent_url', 'GPU_AGENT_URL'), R('gpu_watch.agent_token', 'GPU_AGENT_TOKEN'), R('gpu_watch.vmid', 'GPU_WATCH_VMID'),
  R('gpu_watch.poll_ms', 'GPU_WATCH_POLL_MS'), R('gpu_watch.util_percent', 'GPU_WATCH_UTIL'), R('gpu_watch.minutes', 'GPU_WATCH_MINUTES'),
  R('gpu_watch.blind_minutes', 'GPU_WATCH_BLIND_MINUTES'), R('gpu_watch.allow_processes', 'GPU_WATCH_ALLOW', list(',')),

  R('data.sqlite_dirs', 'DATASOURCE_SQLITE_DIRS', list(',')), R('data.allowed_nets', 'DATASOURCE_ALLOWED_NETS', list(',')),

  R('access.teams', 'ACCESS_TEAMS', json), R('access.group_roles', 'ACCESS_GROUP_ROLES', json), R('access.group_teams', 'ACCESS_GROUP_TEAMS', json),
  R('access.approvals', 'ACCESS_APPROVALS', json), R('access.token_max_days', 'API_TOKEN_MAX_DAYS'), R('access.token_default_days', 'API_TOKEN_DEFAULT_DAYS'),
  R('scim.token', 'SCIM_TOKEN'),
  R('auth.passkeys.rp_id', 'WEBAUTHN_RP_ID'), R('auth.passkeys.origin', 'WEBAUTHN_ORIGIN'), R('auth.passkeys.rp_name', 'WEBAUTHN_RP_NAME'),
  R('nginx.manage', 'NGINX_MANAGE'), R('nginx.sites_dir', 'NGINX_SITES_DIR'), R('nginx.binary', 'NGINX_BIN'),
];

const DS_FIELDS: [string, string][] = [
  ['kind', 'KIND'], ['name', 'NAME'], ['host', 'HOST'], ['port', 'PORT'], ['database', 'DATABASE'], ['username', 'USERNAME'], ['password', 'PASSWORD'],
  ['uri', 'URI'], ['tls', 'TLS'], ['tls_insecure', 'TLS_INSECURE'], ['ca_file', 'CA_FILE'], ['file', 'FILE'], ['token', 'TOKEN'], ['readonly', 'READONLY'], ['color', 'COLOR'],
];
/** Actions access.approvals.actions may name (the server's own list is checked against this in the tests). */
export const APPROVAL_ACTIONS = ['host.shutdown', 'snapshot.rollback', 'snapshot.delete', 'guest.stop', 'vm.clone', 'nginx.delete', 'nginx.change'];
export const DS_KINDS = ['mongodb', 'redis', 'postgres', 'mysql', 'mssql', 'sqlite', 'milvus'];

/** Top-level keys that are valid; anything else is a likely typo. */
export const TOP_KEYS = ['server', 'proxmox', 'auth', 'grafana', 'prometheus', 'kuma', 'loki', 'crowdsec', 'access', 'scim', 'ntfy', 'gotify', 'discord', 'slack', 'telegram', 'email', 'apprise', 'webhook', 'pagerduty', 'opsgenie', 'ai', 'llama', 'gpu_watch', 'data', 'nginx', 'metrics', 'addons', 'env'];

/**
 * Secrets the tool creates itself and then keeps (generated.env), so re-applying never rotates them.
 * Returns the names that must exist for the given config.
 */
export function neededGenerated(y: Yaml): string[] {
  const out: string[] = [];
  if (y.metrics?.enabled !== false) out.push('METRICS_TOKEN');
  if (y.auth?.mfa?.enabled === true || y.auth?.mfa?.required === true) out.push('MFA_KEY');
  if (y.data?.enabled === true || (Array.isArray(y.data?.connections) && y.data.connections.length > 0)) out.push('DATASOURCE_KEY');
  return out;
}

export function toEnv(y: Yaml, secrets: Record<string, string>, generated: Record<string, string>): Mapped {
  const problems: string[] = [];
  const notes: string[] = [];
  const env: Record<string, string> = {};

  for (const k of Object.keys(y)) if (!TOP_KEYS.includes(k)) problems.push(`Unknown top-level key "${k}" (valid: ${TOP_KEYS.join(', ')})`);

  const put = (name: string, raw: string, where: string) => {
    const { text, missing } = expand(raw, secrets);
    for (const m of missing) problems.push(`${where}: \${${m}} is not defined in secrets.env or the environment`);
    if (/[\r\n]/.test(text)) problems.push(`${where}: value must be a single line (use a *_file option for certificates)`);
    env[name] = text;
  };

  for (const row of ROWS) {
    const v = get(y, row.path);
    if (!isSet(v)) continue;
    put(row.env, row.fmt ? row.fmt(v) : scalar(v), row.path);
  }

  // Derived settings
  if (y.server?.https === true) {
    env.COOKIE_SECURE ??= 'true';
    env.TRUST_PROXY ??= '127.0.0.1';
  } else if (y.server?.https === false) {
    env.COOKIE_SECURE ??= 'false';
  }
  if (y.nginx?.manage !== undefined) env.NGINX_MANAGE = scalar(y.nginx.manage);

  // Prometheus scrape endpoint and generated secrets
  for (const name of neededGenerated(y)) if (generated[name]) env[name] = generated[name];
  if (y.metrics?.enabled === false) delete env.METRICS_TOKEN;

  // Two-step sign-in needs its key; the Data manager needs its key
  if (env.MFA_REQUIRED === 'true' && !env.MFA_KEY) problems.push('auth.mfa.required is true but no MFA_KEY could be generated (set auth.mfa.enabled: true)');
  if (y.auth?.oidc && isSet(y.auth.oidc.issuer) && !(isSet(y.auth.oidc.allowed_users) || isSet(y.auth.oidc.required_role)))
    notes.push('auth.oidc is set but neither allowed_users nor required_role is: SSO stays disabled by the server');
  if (y.auth?.oidc?.default_role && !['viewer', 'operator', 'admin'].includes(String(y.auth.oidc.default_role))) problems.push('auth.oidc.default_role must be viewer, operator or admin');

  // Data connections: DS_<ID>_*
  const conns = Array.isArray(y.data?.connections) ? (y.data.connections as Yaml[]) : [];
  const seen = new Set<string>();
  conns.forEach((c, i) => {
    const where = `data.connections[${i}]`;
    const id = String(c?.id ?? c?.name ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!id) { problems.push(`${where}: "id" (letters, digits, underscore) is required`); return; }
    if (seen.has(id)) { problems.push(`${where}: duplicate id ${id}`); return; }
    seen.add(id);
    if (!DS_KINDS.includes(String(c.kind))) { problems.push(`${where}: kind must be one of ${DS_KINDS.join(', ')}`); return; }
    for (const [key, suffix] of DS_FIELDS) {
      const v = c[key];
      if (!isSet(v)) continue;
      put(`DS_${id}_${suffix}`, scalar(v), `${where}.${key}`);
    }
  });

  // Escape hatch for any variable the YAML does not model yet
  if (y.env && typeof y.env === 'object') {
    for (const [k, v] of Object.entries(y.env as Yaml)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(k)) { problems.push(`env.${k}: names must be UPPER_SNAKE_CASE`); continue; }
      if (isSet(v)) put(k, scalar(v), `env.${k}`);
    }
  }

  // Teams, group mapping, approvals, SCIM, passkeys
  const acc = (y.access ?? {}) as Yaml;
  const teams = (acc.teams && typeof acc.teams === 'object' ? acc.teams : {}) as Yaml;
  for (const [name, t] of Object.entries(teams)) {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) problems.push(`access.teams.${name}: team names use letters, digits, . _ - (max 40)`);
    const v = (t as Yaml)?.vmids, tg = (t as Yaml)?.tags;
    if (!isSet(v) && !isSet(tg)) problems.push(`access.teams.${name}: needs vmids and/or tags, otherwise the team can reach nothing`);
    for (const x of Array.isArray(v) ? v : isSet(v) ? [v] : []) if (!/^\d+(\s*-\s*\d+)?$/.test(String(x))) problems.push(`access.teams.${name}.vmids: "${x}" is not an id or a range like 100-120`);
  }
  for (const [g, list] of Object.entries((acc.group_teams ?? {}) as Yaml)) {
    for (const t of Array.isArray(list) ? list : [list]) if (!(t in teams)) problems.push(`access.group_teams.${g}: unknown team "${t}"`);
  }
  for (const r of Object.keys((acc.group_roles ?? {}) as Yaml)) if (!['viewer', 'operator', 'admin'].includes(r)) problems.push(`access.group_roles.${r}: roles are viewer, operator, admin`);
  const ap = (acc.approvals ?? {}) as Yaml;
  for (const a of Array.isArray(ap.actions) ? ap.actions : []) if (a !== '*' && !APPROVAL_ACTIONS.includes(String(a))) problems.push(`access.approvals.actions: unknown action "${a}" (valid: * or ${APPROVAL_ACTIONS.join(', ')})`);
  if (env.SCIM_TOKEN && env.SCIM_TOKEN.length < 24) problems.push('scim.token: use at least 24 characters (openssl rand -hex 24)');
  if (env.WEBAUTHN_RP_ID || env.WEBAUTHN_ORIGIN) {
    try {
      const o = new URL(env.WEBAUTHN_ORIGIN ?? '');
      if (o.protocol !== 'https:' && o.hostname !== 'localhost') problems.push('auth.passkeys.origin: must be https:// (passkeys do not work over plain http except on localhost)');
      if (!env.WEBAUTHN_RP_ID) problems.push('auth.passkeys: rp_id is missing');
      else if (o.hostname !== env.WEBAUTHN_RP_ID && !o.hostname.endsWith(`.${env.WEBAUTHN_RP_ID}`)) problems.push(`auth.passkeys: rp_id "${env.WEBAUTHN_RP_ID}" must be the origin's host or a parent domain of it`);
    } catch { problems.push('auth.passkeys: both rp_id and origin (https://host) are required'); }
  }

  // Required pairs
  const pair = (a: string, b: string, label: string) => {
    if (env[a] && !env[b]) problems.push(`${label}: ${a} is set but ${b} is missing`);
  };
  pair('PVE_URL', 'PVE_TOKEN_ID', 'proxmox'); pair('PVE_TOKEN_ID', 'PVE_TOKEN_SECRET', 'proxmox'); pair('GRAFANA_URL', 'GRAFANA_TOKEN', 'grafana'); pair('KUMA_URL', 'KUMA_API_KEY', 'kuma');
  pair('NTFY_URL', 'NTFY_TOPIC', 'ntfy'); pair('AI_BASE_URL', 'AI_MODEL', 'ai');
  pair('GOTIFY_URL', 'GOTIFY_TOKEN', 'gotify'); pair('GOTIFY_TOKEN', 'GOTIFY_URL', 'gotify');
  pair('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'telegram'); pair('TELEGRAM_CHAT_ID', 'TELEGRAM_BOT_TOKEN', 'telegram');
  pair('SMTP_HOST', 'SMTP_FROM', 'email'); pair('SMTP_HOST', 'SMTP_TO', 'email'); pair('SMTP_USER', 'SMTP_PASSWORD', 'email');
  if (env.APPRISE_URL && !env.APPRISE_KEY && !env.APPRISE_URLS) problems.push('apprise: APPRISE_URL is set but neither key nor urls is');
  if (env.DISCORD_WEBHOOK_URL && !/^https:\/\/([a-z]+\.)?discord(app)?\.com\/api\/webhooks\//.test(env.DISCORD_WEBHOOK_URL)) problems.push('DISCORD_WEBHOOK_URL: must be a https://discord.com/api/webhooks/... URL');
  if (env.SLACK_WEBHOOK_URL && !/^https:\/\/hooks\.slack(-gov)?\.com\//.test(env.SLACK_WEBHOOK_URL)) problems.push('SLACK_WEBHOOK_URL: must be a https://hooks.slack.com/... URL');
  if (env.PAGERDUTY_ROUTING_KEY && env.PAGERDUTY_ROUTING_KEY.length < 20) problems.push('pagerduty.routing_key: expected the 32-character Events API v2 integration key');
  if (env.OPSGENIE_REGION && !['us', 'eu'].includes(env.OPSGENIE_REGION.toLowerCase())) problems.push('opsgenie.region: use us or eu');
  if (env.SMTP_PORT && !/^\d{1,5}$/.test(env.SMTP_PORT)) problems.push('SMTP_PORT: must be a port number');
  for (const k of ['PVE_URL', 'GRAFANA_URL', 'KUMA_URL', 'LOKI_URL', 'PROMETHEUS_URL', 'NTFY_URL', 'AI_BASE_URL', 'GOTIFY_URL', 'APPRISE_URL', 'WEBHOOK_URL', 'LLAMA_URL', 'LLAMA_AGENT_URL', 'GPU_AGENT_URL']) {
    if (env[k] && !/^https?:\/\/[^\s/]+/.test(env[k])) problems.push(`${k}: "${env[k]}" is not an http(s) URL`);
  }
  return { env, problems, notes };
}

export interface FeatureRow { id: string; label: string; on: boolean; hint: string }

/** Mirrors the server's own `*Configured()` checks, so `status` agrees with GET /api/features. */
export function featureRows(env: Record<string, string>): FeatureRow[] {
  const has = (...k: string[]) => k.every((x) => !!env[x]);
  return [
    { id: 'proxmox', label: 'Proxmox guests and node', on: has('PVE_URL', 'PVE_NODE', 'PVE_TOKEN_ID', 'PVE_TOKEN_SECRET'), hint: 'proxmox.url, node, token_id, token_secret' },
    { id: 'grafana', label: 'Grafana embedding', on: has('GRAFANA_URL', 'GRAFANA_TOKEN'), hint: 'grafana.url, token' },
    { id: 'kuma', label: 'Uptime Kuma', on: has('KUMA_URL', 'KUMA_API_KEY'), hint: 'kuma.url, api_key' },
    { id: 'loki', label: 'Loki logs and analytics', on: has('LOKI_URL'), hint: 'loki.url' },
    { id: 'crowdsec', label: 'CrowdSec page', on: has('CROWDSEC_SNAPSHOT'), hint: 'crowdsec.snapshot' },
    { id: 'data', label: 'Data manager (databases)', on: (env.DATASOURCE_KEY ?? '').length >= 16, hint: 'data.enabled: true or data.connections' },
    { id: 'llama', label: 'LLM server (llama.cpp)', on: has('LLAMA_URL') || has('LLAMA_AGENT_URL'), hint: 'llama.url / agent_url' },
    { id: 'gpu', label: 'GPU mining guard', on: has('GPU_AGENT_URL'), hint: 'gpu_watch.agent_url' },
    { id: 'ntfy', label: 'Alerts: ntfy', on: has('NTFY_URL', 'NTFY_TOPIC'), hint: 'ntfy.url, topic' },
    { id: 'gotify', label: 'Alerts: Gotify', on: has('GOTIFY_URL', 'GOTIFY_TOKEN'), hint: 'gotify.url, token' },
    { id: 'discord', label: 'Alerts: Discord', on: has('DISCORD_WEBHOOK_URL'), hint: 'discord.webhook_url' },
    { id: 'slack', label: 'Alerts: Slack', on: has('SLACK_WEBHOOK_URL'), hint: 'slack.webhook_url' },
    { id: 'telegram', label: 'Alerts: Telegram', on: has('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'), hint: 'telegram.bot_token, chat_id' },
    { id: 'email', label: 'Alerts: e-mail (SMTP)', on: has('SMTP_HOST', 'SMTP_FROM', 'SMTP_TO'), hint: 'email.host, from, to' },
    { id: 'apprise', label: 'Alerts: Apprise', on: has('APPRISE_URL') && (has('APPRISE_KEY') || has('APPRISE_URLS')), hint: 'apprise.url + key or urls' },
    { id: 'webhook', label: 'Alerts: JSON webhook', on: has('WEBHOOK_URL'), hint: 'webhook.url' },
    { id: 'pagerduty', label: 'Incidents: PagerDuty', on: (env.PAGERDUTY_ROUTING_KEY ?? '').length >= 20, hint: 'pagerduty.routing_key' },
    { id: 'opsgenie', label: 'Incidents: Opsgenie', on: (env.OPSGENIE_API_KEY ?? '').length >= 16, hint: 'opsgenie.api_key' },
    { id: 'ai', label: 'Ask AI log helper', on: has('AI_BASE_URL', 'AI_MODEL'), hint: 'ai.base_url, model' },
    { id: 'sso', label: 'OIDC single sign-on', on: has('OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI') && (has('OIDC_ALLOWED_USERS') || has('OIDC_REQUIRED_ROLE')), hint: 'auth.oidc.* incl. allowed_users or required_role' },
    { id: 'teams', label: 'Teams (per-guest access)', on: !!env.ACCESS_TEAMS && env.ACCESS_TEAMS !== '{}', hint: 'access.teams' },
    { id: 'approvals', label: 'Four-eyes approvals', on: !!env.ACCESS_APPROVALS && /"actions":\[[^\]]/.test(env.ACCESS_APPROVALS), hint: 'access.approvals.actions' },
    { id: 'scim', label: 'SCIM provisioning', on: (env.SCIM_TOKEN ?? '').length >= 24, hint: 'scim.token' },
    { id: 'passkeys', label: 'Passkeys (WebAuthn)', on: has('WEBAUTHN_RP_ID', 'WEBAUTHN_ORIGIN'), hint: 'auth.passkeys.rp_id, origin' },
    { id: 'mfa', label: 'Two-step sign-in (TOTP)', on: (env.MFA_KEY ?? '').length >= 32, hint: 'auth.mfa.enabled: true' },
    { id: 'metrics', label: 'Prometheus /metrics endpoint', on: has('METRICS_TOKEN'), hint: 'metrics.enabled (default true)' },
    { id: 'nginx', label: 'nginx site manager', on: env.NGINX_MANAGE === 'true', hint: 'nginx.manage: true' },
  ];
}
