// All configuration comes from environment variables (see .env.example).
import { readFileSync } from 'node:fs';

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

  pveUrl: trim(env('PVE_URL')),
  pveNode: env('PVE_NODE'),
  pveTokenId: env('PVE_TOKEN_ID'), // user@realm!tokenname
  pveTokenSecret: env('PVE_TOKEN_SECRET'),
  pveInsecureTls: bool('PVE_INSECURE_TLS', false),
  allowedVmids: new Set(ids('ALLOWED_VMIDS')), // empty = every guest on the node
  protectedVmids: new Set(ids('PROTECTED_VMIDS')),
  featuredVmid: Number(env('FEATURED_VMID', '0')) || 0, // optional guest shown as a large card on the Guests page
  conflicts: conflicts(),
  hostPowerEnabled: bool('HOST_POWER_ENABLED', false), // allow POST /api/host/shutdown (powers off the whole Proxmox node)

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

  frameSrc: env('FRAME_SRC').split(/\s+/).filter(Boolean), // origins the UI may embed (Grafana, Kuma status page)
};

export const pveConfigured = () => !!(cfg.pveUrl && cfg.pveNode && cfg.pveTokenId && cfg.pveTokenSecret);
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
