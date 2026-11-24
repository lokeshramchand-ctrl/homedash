import { Agent } from 'undici';
import { currentCluster } from './clusters.js';
import type { Cluster } from './clusters.js';
import { pveConfigured } from './config.js';
import { HttpError, notConfigured } from './errors.js';

// One TLS agent per cluster (a lab often has self-signed certificates on some clusters and not on others).
const agents = new Map<string, Agent | undefined>();
const agentFor = (c: Cluster) => {
  if (!agents.has(c.id)) agents.set(c.id, c.insecureTls ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined);
  return agents.get(c.id);
};

// Which of a cluster's addresses answered last: the next call starts there, so a dead member costs one timeout, not one per call.
const preferred = new Map<string, number>();
const FAILOVER_TIMEOUT_MS = 6_000;

async function attempt(c: Cluster, base: string, method: string, path: string, form: Record<string, string> | undefined, timeout: number): Promise<Response> {
  return fetch(`${base}/api2/json${path}`, {
    method,
    headers: { Authorization: `PVEAPIToken=${c.tokenId}=${c.tokenSecret}` },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(timeout),
    // @ts-expect-error undici dispatcher is not in the DOM fetch typings
    dispatcher: agentFor(c),
  });
}

export async function pve<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, form?: Record<string, string>): Promise<T> {
  if (!pveConfigured()) throw notConfigured('Proxmox');
  const c = currentCluster();
  const start = preferred.get(c.id) ?? 0;
  let res: Response | undefined;
  let lastErr = '';
  // Only a network failure moves on to the next member; an HTTP answer (even an error) is the cluster's real answer.
  for (let i = 0; i < c.urls.length; i++) {
    const idx = (start + i) % c.urls.length;
    try {
      res = await attempt(c, c.urls[idx], method, path, form, c.urls.length > 1 ? FAILOVER_TIMEOUT_MS : 15_000);
      if (idx !== start) preferred.set(c.id, idx);
      break;
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  if (!res) throw new HttpError(502, 'PVE_UNREACHABLE', `Cannot reach Proxmox${c.urls.length > 1 ? ` (tried ${c.urls.length} addresses)` : ''}: ${lastErr}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(502, 'PVE_ERROR', `Proxmox ${res.status}: ${text.slice(0, 200) || res.statusText}`);
  }
  return ((await res.json()) as { data: T }).data;
}

/** The address that last answered for a cluster (shown on the Nodes page). */
export const activeUrl = (c: Cluster) => c.urls[(preferred.get(c.id) ?? 0) % c.urls.length];
