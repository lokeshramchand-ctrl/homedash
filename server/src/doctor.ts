// `homedash-config doctor`: tries every address the configuration points at and says, in plain words, what is wrong.
// The decisions live here as pure functions (tested); the command in homedash-config.ts only does the I/O.

export interface Target { id: string; label: string; url: string; /** also try this Proxmox call with the token */ pveToken?: { id: string; secret: string } }
export type Verdict = 'ok' | 'warn' | 'fail';
export interface Finding { id: string; label: string; verdict: Verdict; detail: string; fix?: string }

const first = (v: string | undefined) => (v ?? '').split(/[\s,]+/).filter(Boolean);

/** Every address worth probing, from the environment `homedash-config` would write. */
export function targetsFor(env: Record<string, string>): Target[] {
  const out: Target[] = [];
  const add = (id: string, label: string, url: string | undefined, extra: Partial<Target> = {}) => { if (url && /^https?:\/\//i.test(url)) out.push({ id, label, url, ...extra }); };
  first(env.PVE_URL).forEach((u, i) => add(`proxmox${i ? i + 1 : ''}`, `Proxmox${i ? ` (address ${i + 1})` : ''}`, u, env.PVE_TOKEN_ID && env.PVE_TOKEN_SECRET ? { pveToken: { id: env.PVE_TOKEN_ID, secret: env.PVE_TOKEN_SECRET } } : {}));
  add('grafana', 'Grafana', env.GRAFANA_URL);
  add('prometheus', 'Prometheus', env.PROMETHEUS_URL);
  add('kuma', 'Uptime Kuma', env.KUMA_URL);
  add('loki', 'Loki', env.LOKI_URL);
  add('ntfy', 'ntfy', env.NTFY_URL);
  add('gotify', 'Gotify', env.GOTIFY_URL);
  add('apprise', 'Apprise', env.APPRISE_URL);
  add('ai', 'Ask AI endpoint', env.AI_BASE_URL);
  add('llama', 'LLM server', env.LLAMA_URL);
  add('llama-agent', 'LLM agent', env.LLAMA_AGENT_URL);
  add('gpu', 'GPU agent', env.GPU_AGENT_URL);
  return out;
}

/** What an HTTP answer from a service means for a person setting it up. */
export function interpretHttp(label: string, status: number, authenticated = false): Omit<Finding, 'id' | 'label'> {
  if (status >= 200 && status < 300) return { verdict: 'ok', detail: authenticated ? 'answers and accepts the token' : 'answers' };
  if (status === 401 || status === 403) return authenticated
    ? { verdict: 'fail', detail: `answers, but refuses the credentials (HTTP ${status})`, fix: `Check the token id and secret for ${label}; recreate the token if unsure (tools/pve/create-token.sh).` }
    : { verdict: 'ok', detail: `answers (HTTP ${status}: it wants credentials, which is expected)` };
  if (status === 404) return { verdict: 'warn', detail: 'answers, but this path does not exist', fix: `Check the address for ${label}: is a path or port missing?` };
  if (status >= 500) return { verdict: 'warn', detail: `answers with a server error (HTTP ${status})`, fix: `${label} is running but unhealthy: look at its own logs.` };
  return { verdict: 'warn', detail: `answers HTTP ${status}` };
}

/** What a network failure means. `message` is the error's text (or its cause's). */
export function interpretNetworkError(label: string, message: string): { verdict: Verdict; detail: string; fix: string } {
  const m = message.toLowerCase();
  if (/enotfound|eai_again|getaddrinfo/.test(m)) return { verdict: 'fail', detail: 'the name does not resolve', fix: `Check the host name for ${label}, or use its IP address; the container needs working DNS.` };
  if (/econnrefused/.test(m)) return { verdict: 'fail', detail: 'connection refused', fix: `Nothing is listening there. Is ${label} running, and is the port right?` };
  if (/timeout|timed out|abort|ehostunreach|enetunreach/.test(m)) return { verdict: 'fail', detail: 'no answer (timed out or unreachable)', fix: `A firewall or the wrong address. From this container, can you ping the host and reach the port?` };
  if (/cert|self.signed|unable to verify|ssl|tls/.test(m)) return { verdict: 'fail', detail: 'the TLS certificate is not trusted', fix: `For a self-signed certificate set insecure_tls: true for ${label}, or give it a certificate your container trusts.` };
  return { verdict: 'fail', detail: message.slice(0, 120) || 'could not connect', fix: `Check the address for ${label}.` };
}

export interface Local { nodeVersion: string; secretsMode?: number; dbDirWritable: boolean; backupDir?: string; backupDirWritable?: boolean; distDir?: string; distExists?: boolean; portInUseByOther?: boolean }

/** Checks that need no network. */
export function localFindings(l: Local): Finding[] {
  const out: Finding[] = [];
  const [maj, min] = l.nodeVersion.replace(/^v/, '').split('.').map(Number);
  out.push(maj > 22 || (maj === 22 && min >= 13)
    ? { id: 'node', label: 'Node.js', verdict: 'ok', detail: `version ${l.nodeVersion}` }
    : { id: 'node', label: 'Node.js', verdict: 'fail', detail: `version ${l.nodeVersion} is too old`, fix: 'homedash needs Node 22.13 or newer (built-in SQLite). Run the installer again.' });
  if (l.secretsMode !== undefined) {
    out.push((l.secretsMode & 0o077) === 0
      ? { id: 'secrets', label: 'Secrets file', verdict: 'ok', detail: 'readable only by its owner' }
      : { id: 'secrets', label: 'Secrets file', verdict: 'warn', detail: `mode ${(l.secretsMode & 0o777).toString(8)}: other users can read it`, fix: 'chmod 600 /etc/homedash/secrets.env' });
  }
  out.push(l.dbDirWritable
    ? { id: 'db', label: 'Database folder', verdict: 'ok', detail: 'writable' }
    : { id: 'db', label: 'Database folder', verdict: 'fail', detail: 'not writable by this user', fix: 'Fix the owner of the data folder (the service user must own it), then restart.' });
  if (l.backupDir) {
    out.push(l.backupDirWritable
      ? { id: 'backup', label: 'Backup folder', verdict: 'ok', detail: `${l.backupDir} is writable` }
      : { id: 'backup', label: 'Backup folder', verdict: 'fail', detail: `${l.backupDir} is not writable`, fix: 'Create it and give the service user write access, or change server.backup_dir.' });
  }
  if (l.distDir) {
    out.push(l.distExists
      ? { id: 'ui', label: 'Web UI files', verdict: 'ok', detail: 'found' }
      : { id: 'ui', label: 'Web UI files', verdict: 'fail', detail: `${l.distDir} is missing`, fix: 'Build the UI (npm run build) or run the installer again.' });
  }
  return out;
}

export const exitCode = (f: Finding[]): number => (f.some((x) => x.verdict === 'fail') ? 1 : 0);
export const summary = (f: Finding[]) => ({ ok: f.filter((x) => x.verdict === 'ok').length, warn: f.filter((x) => x.verdict === 'warn').length, fail: f.filter((x) => x.verdict === 'fail').length });

/** A cluster with several addresses keeps working while one is down: a dead member is only a warning if another answers. */
export function softenFailover(f: Finding[]): Finding[] {
  const members = f.filter((x) => /^proxmox\d*$/.test(x.id));
  if (members.length < 2 || !members.some((x) => x.verdict === 'ok')) return f;
  return f.map((x) => (members.includes(x) && x.verdict === 'fail' ? { ...x, verdict: 'warn', detail: `${x.detail} (another address answers, so failover covers it)` } : x));
}
