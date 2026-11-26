// What an administrator can still switch on, and the checklist of things worth doing on a new install.
// Pure (no config import) so the shipped snippets are validated by the same code the installer runs (see test/setup.test.mjs).

export interface Integration {
  id: string;
  name: string;
  what: string;
  /** Key of /api/features that says this is on. */
  feature: string;
  /** Navigation id of the page it adds, if any. */
  page?: string;
  /** YAML to add to /etc/homedash/homedash.yaml. Secrets are ${NAME} references. */
  snippet: string;
  /** Names of the ${NAME} secrets the snippet refers to, to put in /etc/homedash/secrets.env. */
  secrets: string[];
}

export const INTEGRATIONS: Integration[] = [
  { id: 'kuma', name: 'Uptime Kuma', what: 'Monitors, heartbeats and incidents on the Uptime page and the Overview.', feature: 'kuma', page: 'kuma', secrets: ['KUMA_API_KEY'],
    snippet: 'kuma:\n  url: http://192.168.1.15:3001\n  api_key: ${KUMA_API_KEY}\n' },
  { id: 'grafana', name: 'Grafana', what: 'Browse and embed your dashboards, and explore metrics.', feature: 'grafana', page: 'grafana', secrets: ['GRAFANA_TOKEN'],
    snippet: 'grafana:\n  url: http://192.168.1.14:3000\n  token: ${GRAFANA_TOKEN}      # read-only service account\n  datasource_uid: prometheus\n' },
  { id: 'loki', name: 'Loki logs', what: 'Search logs and see analytics on the Logs page.', feature: 'loki', page: 'logs', secrets: [],
    snippet: 'loki:\n  url: http://192.168.1.16:3100\n' },
  { id: 'crowdsec', name: 'CrowdSec', what: 'See attackers detected and blocked on your network.', feature: 'crowdsec', page: 'crowdsec', secrets: [],
    snippet: 'crowdsec:\n  snapshot: /var/lib/homedash/crowdsec/state.json\n' },
  { id: 'alerts', name: 'Alerts (ntfy)', what: 'A push message when something goes down and again when it recovers. Discord, Slack, Telegram, e-mail and more work the same way.', feature: 'alerts', page: 'notifications', secrets: ['NTFY_TOKEN'],
    snippet: 'ntfy:\n  url: http://192.168.1.20\n  topic: homedash-change-me      # keep it unguessable\n  token: ${NTFY_TOKEN}\n' },
  { id: 'mfa', name: 'Two-step sign-in', what: 'Authenticator-app codes with recovery codes for every account.', feature: 'mfa', secrets: [],
    snippet: 'auth:\n  mfa:\n    enabled: true\n' },
  { id: 'data', name: 'Database manager', what: 'Browse and query MongoDB, Redis, PostgreSQL, MySQL, SQL Server, SQLite and Milvus.', feature: 'data', page: 'data', secrets: [],
    snippet: 'data:\n  enabled: true\n' },
  { id: 'llama', name: 'LLM server', what: 'Start, stop and watch a llama.cpp server running in a VM.', feature: 'llama', page: 'llama', secrets: ['LLAMA_AGENT_TOKEN'],
    snippet: 'llama:\n  url: http://192.168.1.18:8081\n  agent_url: http://192.168.1.18:8090\n  agent_token: ${LLAMA_AGENT_TOKEN}\n  vmid: 100\n' },
  { id: 'ai', name: 'Ask AI', what: 'Explain a log line with any OpenAI-compatible model, for example Ollama.', feature: 'ai', secrets: [],
    snippet: 'ai:\n  base_url: http://192.168.1.30:11434/v1\n  model: llama3.1\n' },
  { id: 'metrics', name: 'Prometheus metrics', what: 'A /metrics endpoint for Prometheus, with a ready-made Grafana dashboard.', feature: 'metrics', secrets: [],
    snippet: 'metrics:\n  enabled: true\n' },
  { id: 'nginx', name: 'Nginx manager', what: 'Create and edit reverse-proxy sites from a form; every change is tested and rolled back on failure.', feature: 'nginxManage', page: 'nginx', secrets: [],
    snippet: 'nginx:\n  manage: true\n' },
];

export type CheckStatus = 'ok' | 'todo' | 'warn';
export interface Check { id: string; title: string; status: CheckStatus; detail: string; fix?: string; page?: string }

export interface SetupFlags {
  proxmox: boolean;
  /** null = not tried (not configured) */
  proxmoxReachable: boolean | null;
  secureConnection: boolean;
  mfa: boolean;
  alerts: boolean;
  selfBackup: boolean;
  secretsKey: boolean;
  /** administrators that can sign in, to warn when the only one is a shared "admin" */
  admins: number;
}

/** The things a new install should have, in the order worth doing them. */
export function buildChecks(f: SetupFlags): Check[] {
  const out: Check[] = [];
  out.push(!f.proxmox
    ? { id: 'proxmox', title: 'Connect to Proxmox', status: 'todo', detail: 'homedash does not know your Proxmox host yet.', fix: 'Create a token with tools/pve/create-token.sh, then add proxmox: url, node, token_id and token_secret to homedash.yaml.' }
    : f.proxmoxReachable === false
      ? { id: 'proxmox', title: 'Connect to Proxmox', status: 'warn', detail: 'The Proxmox API did not answer just now.', fix: 'Check the address, the token and that the container can reach the host (port 8006).' }
      : { id: 'proxmox', title: 'Connect to Proxmox', status: 'ok', detail: 'The Proxmox API answers.' });
  out.push(f.secureConnection
    ? { id: 'https', title: 'Use HTTPS', status: 'ok', detail: 'Sessions travel over an encrypted connection.' }
    : { id: 'https', title: 'Use HTTPS', status: 'warn', detail: 'Sign-in currently travels in clear text, which is fine on a closed LAN and not beyond it.', fix: 'Add server.tls.self_signed: true (or server.tls.cert_file and key_file for your own certificate), or put homedash behind an HTTPS reverse proxy and set server.https: true.' });
  out.push(f.mfa
    ? { id: 'mfa', title: 'Two-step sign-in', status: 'ok', detail: 'Accounts are protected by a second factor.' }
    : { id: 'mfa', title: 'Two-step sign-in', status: 'todo', detail: 'Anyone with a password gets in. Add a code from an authenticator app.', fix: 'Add auth.mfa.enabled: true and apply.' });
  out.push(f.alerts
    ? { id: 'alerts', title: 'Get alerts', status: 'ok', detail: 'At least one alert channel is set up.', page: 'notifications' }
    : { id: 'alerts', title: 'Get alerts', status: 'todo', detail: 'Nothing will tell you when a guest or service goes down.', fix: 'Set up one channel (ntfy is the quickest) and press Test on the Notifications page.', page: 'notifications' });
  out.push(f.selfBackup
    ? { id: 'backup', title: "Back up homedash's own data", status: 'ok', detail: 'A copy of users, tokens and settings is written on a schedule.' }
    : { id: 'backup', title: "Back up homedash's own data", status: 'todo', detail: 'Users, API tokens, scenes and the audit trail live in one file with no copy.', fix: 'Add server.backup_dir: /var/backups/homedash and apply.' });
  out.push(f.secretsKey
    ? { id: 'secrets', title: 'Store service passwords safely', status: 'ok', detail: 'API keys entered in the Services page are encrypted at rest.', page: 'tiles' }
    : { id: 'secrets', title: 'Store service passwords safely', status: 'warn', detail: 'Without an encryption key the Services page cannot save API keys.', fix: 'Run homedash-config apply once: it generates the key.', page: 'tiles' });
  if (f.admins <= 1) out.push({ id: 'second-admin', title: 'A second administrator', status: 'todo', detail: 'If the only administrator is locked out, recovery needs the console.', fix: 'Create another administrator with npm run create-user -- <name> admin, or use single sign-on.', page: 'access' });
  return out;
}

export const progress = (checks: Check[]) => ({ done: checks.filter((c) => c.status === 'ok').length, total: checks.length });
