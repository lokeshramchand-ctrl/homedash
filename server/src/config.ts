// All configuration comes from environment variables (see .env.example).
import { readFileSync } from 'node:fs';
import { TILE_KIND_IDS } from './tile-kinds.js';

const env = (k: string, d = ''): string => (process.env[k] ?? d).trim();
const bool = (k: string, d: boolean): boolean => {
  const v = env(k);
  return v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};
const ids = (k: string): number[] =>
  env(k).split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0);

function conflicts(): Record<number, number[]> {
  const raw = env('GUEST_CONFLICTS');
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, number[]>;
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [Number(k), v.map(Number)]));
  } catch {
    throw new Error('GUEST_CONFLICTS must be JSON like {"100":[101,106],"101":[100]}');
  }
}

/** TRUST_PROXY: false, true (loopback only), or a list of proxy addresses/CIDRs allowed to set X-Forwarded-For. */
function trustProxy(): boolean | string[] {
  const v = env('TRUST_PROXY', 'true');
  if (['0', 'false', 'no', 'off'].includes(v.toLowerCase())) return false;
  if (['1', 'true', 'yes', 'on'].includes(v.toLowerCase())) return ['127.0.0.1', '::1'];
  return v.split(/[\s,]+/).filter(Boolean);
}

const trim = (u: string) => u.replace(/\/+$/, '');
/** OIDC_<name>, falling back to the legacy KEYCLOAK_<name>. */
const oenv = (name: string): string => env(`OIDC_${name}`) || env(`KEYCLOAK_${name}`);

/** A Data manager connection declared in .env (DS_<ID>_KIND=...). Synced into the store on every start. */
export interface EnvDatasource {
  envId: string; name: string; kind: string; readOnly: boolean; color?: string;
  host?: string; port?: number; database?: string; username?: string; password?: string; uri?: string;
  tls?: boolean; tlsInsecure?: boolean; ca?: string; file?: string; token?: string;
}

// DS_<ID>_KIND marks a connection; every other DS_<ID>_* key is optional. <ID> is letters, digits and underscores.
function envDatasources(): EnvDatasource[] {
  const out: EnvDatasource[] = [];
  for (const k of Object.keys(process.env).sort()) {
    const m = /^DS_([A-Z0-9_]+?)_KIND$/.exec(k);
    if (!m) continue;
    const id = m[1];
    const v = (f: string) => env(`DS_${id}_${f}`) || undefined;
    const b = (f: string) => (v(f) === undefined ? undefined : bool(`DS_${id}_${f}`, false));
    const caFile = v('CA_FILE');
    let ca = v('CA');
    if (!ca && caFile) {
      // A bad entry must not stop the dashboard; it is skipped and named in the log.
      try { ca = readFileSync(caFile, 'utf8'); } catch { console.warn(`DS_${id}_CA_FILE: cannot read ${caFile}, connection skipped`); continue; }
    }
    const port = v('PORT');
    out.push({
      envId: id, name: v('NAME') ?? id.toLowerCase(), kind: env(k).toLowerCase(), readOnly: b('READONLY') ?? true, color: v('COLOR'),
      host: v('HOST'), port: port ? Number(port) : undefined, database: v('DATABASE'), username: v('USERNAME') ?? v('USER'),
      password: v('PASSWORD'), uri: v('URI'), tls: b('TLS'), tlsInsecure: b('TLS_INSECURE'), ca, file: v('FILE'), token: v('TOKEN'),
    });
  }
  return out;
}

/** "100-120", 205 or "300" -> [lo, hi]; anything else is ignored. */
function vmidRanges(v: unknown): [number, number][] {
  const out: [number, number][] = [];
  for (const x of Array.isArray(v) ? v : [v]) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(x).trim());
    if (!m) continue;
    const lo = Number(m[1]), hi = Number(m[2] ?? m[1]);
    if (lo > 0 && hi >= lo) out.push([lo, hi]);
  }
  return out;
}
function jsonEnv<T>(k: string, d: T): T {
  const raw = env(k);
  if (!raw) return d;
  try { return JSON.parse(raw) as T; } catch { throw new Error(`${k} must be valid JSON`); }
}
function accessConfig() {
  const teams: Record<string, { ranges: [number, number][]; tags: string[]; cluster?: string }> = {};
  for (const [name, t] of Object.entries(jsonEnv<Record<string, { vmids?: unknown; tags?: string[]; cluster?: string }>>('ACCESS_TEAMS', {}))) {
    teams[name] = { ranges: vmidRanges(t?.vmids ?? []), tags: (t?.tags ?? []).map(String), ...(t?.cluster ? { cluster: String(t.cluster) } : {}) };
  }
  const groupRoles = jsonEnv<Record<string, string[]>>('ACCESS_GROUP_ROLES', {});
  const gt = jsonEnv<Record<string, string[]>>('ACCESS_GROUP_TEAMS', {});
  const ap = jsonEnv<{ actions?: string[]; ttl_minutes?: number; allow_self?: boolean }>('ACCESS_APPROVALS', {});
  return {
    teams, groupRoles: { viewer: groupRoles.viewer ?? [], operator: groupRoles.operator ?? [], admin: groupRoles.admin ?? [] } as Record<'viewer' | 'operator' | 'admin', string[]>,
    groupTeams: gt,
    approvals: { actions: (ap.actions ?? []).map(String), ttlMinutes: Math.min(Math.max(Number(ap.ttl_minutes ?? 30), 1), 1440), allowSelf: ap.allow_self === true },
    scimToken: env('SCIM_TOKEN'),
    tokenMaxDays: Number(env('API_TOKEN_MAX_DAYS', '365')), tokenDefaultDays: Number(env('API_TOKEN_DEFAULT_DAYS', '90')),
    webauthn: { rpId: env('WEBAUTHN_RP_ID'), origin: trim(env('WEBAUTHN_ORIGIN')), rpName: env('WEBAUTHN_RP_NAME', 'homedash') },
  };
}

/** One Proxmox cluster, or one stand-alone node. */
export interface ClusterCfg {
  id: string; name: string;
  urls: string[]; // API addresses of cluster members, tried in order (failover)
  node: string; // preferred node for host-level pages
  tokenId: string; tokenSecret: string; insecureTls: boolean;
  allowedVmids: Set<number>; protectedVmids: Set<number>; featuredVmid: number; conflicts: Record<number, number[]>;
  hostPower: boolean;
}

const numList = (v: unknown): number[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []).map((x) => parseInt(String(x), 10)).filter((n) => Number.isInteger(n) && n > 0);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

function clusterConfigs(): ClusterCfg[] {
  const raw = env('PVE_CLUSTERS');
  const list: Record<string, unknown>[] = [];
  if (raw) {
    try { list.push(...(JSON.parse(raw) as Record<string, unknown>[])); } catch { throw new Error('PVE_CLUSTERS must be a JSON array'); }
  } else if (env('PVE_URL')) {
    // The single-cluster settings that were always here: one cluster called "default".
    list.push({
      id: 'default', name: env('PVE_CLUSTER_NAME', 'Proxmox'), urls: env('PVE_URL').split(/[\s,]+/), node: env('PVE_NODE'), token_id: env('PVE_TOKEN_ID'),
      token_secret: env('PVE_TOKEN_SECRET'), insecure_tls: bool('PVE_INSECURE_TLS', false), allowed_vmids: ids('ALLOWED_VMIDS'), protected_vmids: ids('PROTECTED_VMIDS'),
      featured_vmid: Number(env('FEATURED_VMID', '0')) || 0, conflicts: conflicts(), host_power: bool('HOST_POWER_ENABLED', false),
    });
  }
  // Nothing configured: keep one empty "default" cluster, so code that always has a current cluster (every request does)
  // still works and the answer is "Proxmox is not configured", not a failed request. It is not ready, so pveConfigured() stays false.
  if (list.length === 0) list.push({ id: 'default', name: 'Proxmox' });
  const seen = new Set<string>();
  return list.map((c, i) => {
    const name = String(c.name ?? c.id ?? `cluster-${i + 1}`).trim().slice(0, 40) || `cluster-${i + 1}`;
    let id = slug(String(c.id ?? name)) || `cluster-${i + 1}`;
    if (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const urls = (Array.isArray(c.urls) ? c.urls : String(c.urls ?? c.url ?? '').split(/[\s,]+/)).map((u) => trim(String(u))).filter(Boolean);
    const cf = (c.conflicts ?? {}) as Record<string, unknown>;
    return {
      id, name, urls, node: String(c.node ?? '').trim(), tokenId: String(c.token_id ?? '').trim(), tokenSecret: String(c.token_secret ?? '').trim(),
      insecureTls: c.insecure_tls === true || c.insecure_tls === 'true',
      allowedVmids: new Set(numList(c.allowed_vmids)), protectedVmids: new Set(numList(c.protected_vmids)), featuredVmid: Number(c.featured_vmid ?? 0) || 0,
      conflicts: Object.fromEntries(Object.entries(cf).map(([k, v]) => [Number(k), numList(v)])),
      hostPower: c.host_power === true || c.host_power === 'true',
    };
  });
}
/** A status tile (Services page): one read-only integration polled in the background. See tiles.ts. */
export interface TileCfg {
  id: string; kind: string; name: string;
  url: string; publicUrl: string; group: string; token: string; username: string; password: string; ups: string; insecureTls: boolean;
  pollSeconds: number; path: string; stats: { label: string; path: string }[];
}
function tileConfigs(): TileCfg[] {
  const raw = env('TILES');
  if (!raw) return [];
  let list: Record<string, unknown>[];
  try { list = JSON.parse(raw) as Record<string, unknown>[]; } catch { throw new Error('TILES must be a JSON array'); }
  const seen = new Set<string>();
  const out: TileCfg[] = [];
  list.forEach((t, i) => {
    const kind = String(t.kind ?? '').toLowerCase();
    const url = trim(String(t.url ?? ''));
    if (!TILE_KIND_IDS.includes(kind) || !/^(https?|tcp):\/\/[^\s/]+/.test(url)) { console.warn(`TILES[${i}]: needs a known kind and an http(s) url, skipped`); return; }
    const name = String(t.name ?? kind).trim().slice(0, 40) || kind;
    let id = slug(String(t.id ?? name)) || `tile-${i + 1}`;
    if (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    out.push({
      id, kind, name, url, publicUrl: trim(String(t.public_url ?? '')), group: String(t.group ?? '').trim().slice(0, 30),
      token: String(t.token ?? ''), username: String(t.username ?? ''), password: String(t.password ?? ''), ups: String(t.ups ?? ''), insecureTls: t.insecure_tls === true || t.insecure_tls === 'true',
      pollSeconds: Math.min(Math.max(Number(t.poll_seconds ?? 60) || 60, 15), 3600), path: String(t.path ?? '/'),
      stats: (Array.isArray(t.stats) ? (t.stats as Record<string, unknown>[]) : []).map((s) => ({ label: String(s?.label ?? '').slice(0, 30), path: String(s?.path ?? '') })).filter((s) => s.label && s.path),
    });
  });
  return out;
}

function statusPageConfig() {
  const j = jsonEnv<{ enabled?: boolean; title?: string; message?: string; tiles?: string[]; monitors?: string[] }>('STATUS_PAGE', {});
  const l = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return { enabled: j.enabled === true, title: String(j.title ?? 'Service status').slice(0, 80), message: String(j.message ?? '').slice(0, 300), tiles: l(j.tiles), monitors: l(j.monitors) };
}
const CL = clusterConfigs();

export const cfg = {
  port: Number(env('PORT', '3000')),
  host: env('HOST', '127.0.0.1'),
  trustProxy: trustProxy(),
  serveDist: env('SERVE_DIST'), // optional path to the built UI (dist/)

  dbPath: env('DB_PATH', './data/homedash.db'), // SQLite file; the directory is created on start

  sessionTtlHours: Number(env('SESSION_TTL_HOURS', '12')),
  // A session unused for this long is dropped even if its absolute lifetime has not ended.
  sessionIdleMinutes: Number(env('SESSION_IDLE_MINUTES', '120')),
  cookieSecure: bool('COOKIE_SECURE', true),

  // Proxmox clusters / nodes (see clusters.ts). The fields below mirror the first cluster for code that has no request context.
  clusters: CL,
  pveUrl: CL[0]?.urls[0] ?? '',
  pveNode: CL[0]?.node ?? '',
  pveTokenId: CL[0]?.tokenId ?? '', // user@realm!tokenname
  pveTokenSecret: CL[0]?.tokenSecret ?? '',
  pveInsecureTls: CL[0]?.insecureTls ?? false,
  allowedVmids: CL[0]?.allowedVmids ?? new Set<number>(), // empty = every guest
  protectedVmids: CL[0]?.protectedVmids ?? new Set<number>(),
  featuredVmid: CL[0]?.featuredVmid ?? 0, // optional guest shown as a large card on the Guests page
  conflicts: CL[0]?.conflicts ?? {},
  hostPowerEnabled: CL.some((c) => c.hostPower), // allow POST /api/host/shutdown (powers off a whole Proxmox node)

  nginxDir: env('NGINX_SITES_DIR', '/etc/nginx/sites-enabled'),
  nginxManage: bool('NGINX_MANAGE', false), // allow creating/editing/deleting sites from the UI (needs nginx in this container)
  nginxBin: env('NGINX_BIN', 'nginx'),

  grafanaUrl: trim(env('GRAFANA_URL')), // how the backend reaches Grafana
  grafanaPublicUrl: trim(env('GRAFANA_PUBLIC_URL') || env('GRAFANA_URL')), // what the browser opens/embeds
  grafanaToken: env('GRAFANA_TOKEN'),
  grafanaDsUid: env('GRAFANA_DS_UID'), // Prometheus datasource uid

  promUrl: trim(env('PROMETHEUS_URL')), // optional: query Prometheus directly (CrowdSec history, engine counters)

  // CrowdSec: the engine's state is a JSON snapshot written by the homedash-crowdsec-snapshot timer (infra/crowdsec).
  // Empty = the CrowdSec page is off.
  crowdsecSnapshot: env('CROWDSEC_SNAPSHOT'),
  crowdsec: {
    centralName: env('CROWDSEC_CENTRAL_NAME', 'crowdsec'), // Prometheus instance_name label of the central engine
    hostName: env('CROWDSEC_HOST_NAME', 'pve-host'), // machine / instance_name of the Proxmox host's own engine
  },

  // Loki (read-only): the Logs page queries it live, nothing is copied into SQLite. Empty = off.
  lokiUrl: trim(env('LOKI_URL')),
  lokiPublicUrl: trim(env('LOKI_PUBLIC_URL') || env('LOKI_URL')),

  kumaUrl: trim(env('KUMA_URL')),
  kumaApiKey: env('KUMA_API_KEY'),
  kumaPollMs: Number(env('KUMA_POLL_MS', '60000')),

  journalEnabled: bool('JOURNAL_ENABLED', true), // /api/logs/journal reads the host journal (dashboard user needs the systemd-journal group)
  eventRetentionDays: Number(env('EVENT_RETENTION_DAYS', '90')),

  // Sign-in with any OpenID Connect provider (Keycloak, Authentik, Authelia, Zitadel, Entra ID, Google, Okta, ...).
  // OIDC_* are the names to use; the older KEYCLOAK_* names still work as fallbacks.
  oidc: {
    issuer: trim(oenv('ISSUER')), // the provider's issuer URL, e.g. https://sso.example.com/realms/<realm>
    clientId: oenv('CLIENT_ID'),
    clientSecret: oenv('CLIENT_SECRET'), // empty = public client (PKCE only)
    redirectUri: oenv('REDIRECT_URI'), // https://<dashboard host>/api/auth/sso/callback
    scopes: oenv('SCOPES') || 'openid profile email',
    allowedUsers: oenv('ALLOWED_USERS').toLowerCase().split(/[\s,]+/).filter(Boolean), // preferred_username or email
    requiredRole: oenv('REQUIRED_ROLE'), // a role or group the user must have
    // Where roles/groups live in the ID token, dot path(s), comma separated. The defaults cover Keycloak
    // (realm_access.roles, resource_access.<client>.roles) plus the common `roles` and `groups` claims.
    rolesClaims: (oenv('ROLES_CLAIM') || 'realm_access.roles,resource_access.{client}.roles,roles,groups').split(',').map((x) => x.trim()).filter(Boolean),
    label: oenv('LABEL') || 'Single sign-on',
    // Role for SSO sign-ins: users listed in OIDC_ADMIN_USERS get admin, everyone else OIDC_DEFAULT_ROLE
    // (viewer | operator | admin). The default stays admin so enabling roles changes nothing until you set it.
    adminUsers: oenv('ADMIN_USERS').toLowerCase().split(/[\s,]+/).filter(Boolean),
    defaultRole: oenv('DEFAULT_ROLE') || 'admin',
  },

  ntfy: {
    url: trim(env('NTFY_URL')), // how the backend reaches ntfy, e.g. http://192.168.1.20
    publicUrl: trim(env('NTFY_PUBLIC_URL')), // what phones subscribe to
    topic: env('NTFY_TOPIC'),
    token: env('NTFY_TOKEN'), // optional access token
    clickUrl: env('NTFY_CLICK_URL'), // opened when the notification is tapped
    cpuLimit: Number(env('ALERT_CPU', '0.9')), memLimit: Number(env('ALERT_MEM', '0.92')), diskLimit: Number(env('ALERT_DISK', '0.9')),
  },

  // llama.cpp server on the Windows VM: status read directly from llama-server, start/stop/switch via
  // the control agent (scripts/windows/llama-agent.ps1). See llama.ts.
  llama: {
    agentUrl: trim(env('LLAMA_AGENT_URL')), // e.g. http://192.168.1.18:8090
    agentToken: env('LLAMA_AGENT_TOKEN'),
    url: trim(env('LLAMA_URL')), // llama-server itself, e.g. http://192.168.1.18:8081
    apiKey: env('LLAMA_API_KEY'), // only if llama-server runs with --api-key
    publicUrl: trim(env('LLAMA_PUBLIC_URL')), // shown as a link only
    vmid: Number(env('LLAMA_VMID', '0')),
  },

  // Mining guard: alert when the GPU stays busy while llama-server has no requests (see gpuwatch.ts).
  gpuWatch: {
    agentUrl: trim(env('GPU_AGENT_URL')), // the agent inside the Windows VM, e.g. http://192.168.1.18:9835
    agentToken: env('GPU_AGENT_TOKEN'),
    llamaUrl: trim(env('LLAMA_URL')), // llama-server, read via /slots only, e.g. http://192.168.1.18:8081
    llamaKey: env('LLAMA_API_KEY'), // only if llama-server runs with --api-key
    pollMs: Math.max(5_000, Number(env('GPU_WATCH_POLL_MS', '15000'))),
    utilPct: Number(env('GPU_WATCH_UTIL', '60')), // "high" GPU utilisation, percent
    minutes: Number(env('GPU_WATCH_MINUTES', '5')), // how long it must stay high and unexplained
    blindMinutes: Number(env('GPU_WATCH_BLIND_MINUTES', '10')), // agent silent this long while the VM runs = warn
    vmid: Number(env('GPU_WATCH_VMID', '0')),
    // Processes whose GPU use is expected (desktop, browser). llama-server is deliberately not here.
    allow: env('GPU_WATCH_ALLOW', 'dwm.exe,explorer.exe,chrome.exe,msedge.exe,firefox.exe,obs64.exe,steamwebhelper.exe,discord.exe,System')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },

  // More alert channels next to ntfy (see channels.ts). Each one is off until its settings are present.
  channels: {
    gotify: { url: trim(env('GOTIFY_URL')), token: env('GOTIFY_TOKEN') },
    discord: { webhookUrl: env('DISCORD_WEBHOOK_URL'), username: env('DISCORD_USERNAME') },
    slack: { webhookUrl: env('SLACK_WEBHOOK_URL') },
    telegram: { botToken: env('TELEGRAM_BOT_TOKEN'), chatId: env('TELEGRAM_CHAT_ID') },
    email: {
      host: env('SMTP_HOST'), port: Number(env('SMTP_PORT', '587')), secure: bool('SMTP_SECURE', false), starttls: bool('SMTP_STARTTLS', true),
      user: env('SMTP_USER'), password: env('SMTP_PASSWORD'), from: env('SMTP_FROM'),
      to: env('SMTP_TO').split(/[\s,;]+/).filter(Boolean), insecureTls: bool('SMTP_INSECURE_TLS', false),
    },
    apprise: { url: trim(env('APPRISE_URL')), key: env('APPRISE_KEY'), urls: env('APPRISE_URLS').split(/\s+/).filter(Boolean), tag: env('APPRISE_TAG') },
    webhook: { url: env('WEBHOOK_URL'), secret: env('WEBHOOK_SECRET') },
    // Incident tools: they open an incident when something breaks and close it when it recovers.
    pagerduty: { routingKey: env('PAGERDUTY_ROUTING_KEY'), url: trim(env('PAGERDUTY_URL', 'https://events.pagerduty.com')) },
    opsgenie: { apiKey: env('OPSGENIE_API_KEY'), url: trim(env('OPSGENIE_URL') || (env('OPSGENIE_REGION', 'us').toLowerCase() === 'eu' ? 'https://api.eu.opsgenie.com' : 'https://api.opsgenie.com')) },
  },

  ai: {
    baseUrl: trim(env('AI_BASE_URL')), // OpenAI-compatible base, e.g. http://192.168.1.x:11434/v1 (Ollama) or https://api.openai.com/v1
    apiKey: env('AI_API_KEY'), // empty for most local servers (Ollama/LM Studio)
    model: env('AI_MODEL'), // e.g. llama3.1, qwen2.5-coder, gpt-4o-mini
    label: env('AI_LABEL'), // display name, e.g. "Ollama · llama3.1"
  },

  backupMaxAgeDays: Number(env('BACKUP_MAX_AGE_DAYS', '8')), // a guest whose newest backup is older than this is flagged stale
  snapshotMaxAgeDays: Number(env('SNAPSHOT_MAX_AGE_DAYS', '30')),
  memoryReserveMb: Number(env('MEMORY_RESERVE_MB', '1024')), // kept free for the host when checking whether a guest fits
  metricsToken: env('METRICS_TOKEN'), // bearer token for GET /metrics (Prometheus/Grafana); empty = endpoint disabled

  // Data manager: connection secrets are AES-256-GCM encrypted with a key derived from DATASOURCE_KEY. Empty = off.
  datasourceKey: env('DATASOURCE_KEY'),
  sqliteDirs: env('DATASOURCE_SQLITE_DIRS').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean), // SQLite files may only live under these
  // Where user-created Data connections may point (CIDRs, comma separated). Empty = only loopback and link-local are refused.
  datasourceAllowedNets: env('DATASOURCE_ALLOWED_NETS').split(/[\s,]+/).filter(Boolean),
  envDatasources: envDatasources(), // connections declared as DS_<ID>_* in .env; locked in the UI, .env is the source of truth

  // Two-step sign-in (TOTP). MFA_KEY seals the secrets (32+ characters); MFA_REQUIRED forces enrolment before anything else is reachable.
  mfa: { key: env('MFA_KEY'), required: bool('MFA_REQUIRED', false), issuer: env('MFA_ISSUER', 'homedash') },

  // Access control beyond roles: teams, group mapping, SCIM, approvals, API tokens, passkeys. See access.ts.
  access: accessConfig(),

  tiles: tileConfigs(),

  // Public status page (/status, /status.json): off unless enabled. Lists only the tile ids / monitor names named here ("*" = all).
  statusPage: statusPageConfig(),

  // Audit trail export to a SIEM / log collector (see auditlog.ts). Rows are always hash-chained; these only add push targets.
  auditExport: {
    syslog: env('AUDIT_SYSLOG'), // udp://host:514 or tcp://host:514 (RFC 5424)
    webhookUrl: env('AUDIT_WEBHOOK_URL'), webhookSecret: env('AUDIT_WEBHOOK_SECRET'), // optional HMAC-SHA256 in X-Homedash-Signature
    format: env('AUDIT_FORMAT', 'json').toLowerCase() === 'cef' ? 'cef' as const : 'json' as const,
  },

  frameSrc: env('FRAME_SRC').split(/\s+/).filter(Boolean), // origins the UI may embed (Grafana, Kuma status page)
};

export const clusterReady = (c: ClusterCfg) => !!(c.urls.length && c.node && c.tokenId && c.tokenSecret);
export const pveConfigured = () => cfg.clusters.length > 0 && cfg.clusters.every(clusterReady);
export const grafanaConfigured = () => !!(cfg.grafanaUrl && cfg.grafanaToken);
export const oidcConfigured = () => !!(cfg.oidc.issuer && cfg.oidc.clientId && cfg.oidc.redirectUri);
export const kumaConfigured = () => !!(cfg.kumaUrl && cfg.kumaApiKey);
export const ntfyConfigured = () => !!(cfg.ntfy.url && cfg.ntfy.topic);
export const aiConfigured = () => !!(cfg.ai.baseUrl && cfg.ai.model);
export const lokiConfigured = () => !!cfg.lokiUrl;
export const crowdsecConfigured = () => !!cfg.crowdsecSnapshot;
export const dataConfigured = () => cfg.datasourceKey.length >= 16;
export const llamaConfigured = () => !!(cfg.llama.url || cfg.llama.agentUrl);
export const gpuWatchConfigured = () => !!cfg.gpuWatch.agentUrl;
export const mfaConfigured = () => cfg.mfa.key.length >= 32;
export const scimConfigured = () => cfg.access.scimToken.length >= 24;
export const passkeysConfigured = () => !!(cfg.access.webauthn.rpId && cfg.access.webauthn.origin);
